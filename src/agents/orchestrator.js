/**
 * Orchestrateur — Coordonne les 3 agents (Scraper, Superviseur, Discovery).
 *
 * Pipeline :
 *   1. Agent Scraper (existant) → scan Vinted + comparaison eBay/API
 *   2. Agent Superviseur → vérifie les opportunités, calcule profit net, score confiance
 *   3. Agent Discovery → analyse les tendances, suggère de nouvelles niches
 *   4. Notification Telegram avec les résultats enrichis
 *
 * L'orchestrateur gère aussi :
 *   - La persistance des résultats (JSON)
 *   - Les logs structurés
 *   - Le timing entre les agents
 *   - La gestion d'erreurs (un agent qui crash ne bloque pas les autres)
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { supervise } = require('./supervisor');
const { discover } = require('./discovery');
const { diagnose } = require('./diagnostic');
const { strategize } = require('./strategist');
const { assessLiquidity } = require('./liquidity');
const { buildTelegramMessage, sendTelegramMessage } = require('../notifier');

// ─── Résultats persistants ───────────────────────────────────────────

const RESULTS_DIR = path.join(config.outputDir, 'agents');

async function ensureResultsDir() {
  await fs.promises.mkdir(RESULTS_DIR, { recursive: true });
}

async function saveAgentResult(agentName, result) {
  await ensureResultsDir();
  const filePath = path.join(RESULTS_DIR, `${agentName}-latest.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(result, null, 2));
  return filePath;
}

async function loadAgentResult(agentName) {
  const filePath = path.join(RESULTS_DIR, `${agentName}-latest.json`);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Messages Telegram enrichis ──────────────────────────────────────

/**
 * Construit un message Telegram enrichi avec les données du Superviseur.
 */
function buildEnrichedTelegramMessage(supervisorResult, discoveryResult) {
  const lines = [];
  const confirmed = supervisorResult.confirmed || [];
  const summary = supervisorResult.summary || {};

  // Header
  lines.push('=== RAPPORT MULTI-AGENTS ===');
  lines.push('');

  // Superviseur
  if (confirmed.length > 0) {
    lines.push(`OPPORTUNITES CONFIRMEES: ${confirmed.length}/${summary.total}`);
    lines.push(`Confiance moyenne: ${summary.avgConfidence}/100`);
    lines.push(`Profit net moyen: ${summary.avgNetProfit} EUR`);
    lines.push('');

    for (const [index, opp] of confirmed.slice(0, 5).entries()) {
      const v = opp.verification;
      const dp = v.detailedProfit;

      lines.push(`${index + 1}. ${opp.title.slice(0, 55)}`);
      lines.push(`   Vinted: ${opp.vintedBuyerPrice} EUR`);

      if (dp) {
        lines.push(`   Revente estimee: ${dp.estimatedSalePrice} EUR`);
        lines.push(`   Profit NET: ${dp.netProfit} EUR (${dp.netProfitPercent}%)`);
        lines.push(`   Frais: ${dp.totalSellFees} EUR (${dp.platform})`);
      }

      lines.push(`   Confiance: ${v.confidenceScore}/100`);

      // Liquidité
      if (v.liquiditySummary) {
        const ls = v.liquiditySummary;
        lines.push(`   ${ls.speedEmoji} Liquidité: ${ls.speedLabel} (score ${ls.score}/100) | Marge ajustée: ${ls.adjustedMarginPercent}%`);
      }

      if (v.reasons.length > 0) {
        lines.push(`   Notes: ${v.reasons.join(' | ')}`);
      }

      lines.push(`   ${opp.url}`);

      // Liens eBay sources (les 3 premières ventes qui servent de base au prix)
      const ebayLinks = (opp.matchedSales || [])
        .filter((sale) => sale.url)
        .slice(0, 3);
      for (const sale of ebayLinks) {
        lines.push(`   📎 Source eBay: ${sale.url}`);
      }

      lines.push('');
    }
  } else {
    lines.push('Aucune opportunite confirmee par le Superviseur.');
    lines.push(`(${summary.total} testee(s), ${summary.rejectedCount} rejetee(s))`);
    lines.push('');
  }

  // Opportunités rejetées (résumé)
  const rejected = supervisorResult.rejected || [];
  if (rejected.length > 0) {
    lines.push(`--- REJETEES: ${rejected.length} ---`);
    for (const rej of rejected.slice(0, 3)) {
      const reason = rej.verification.reasons[0] || rej.verification.verdict;
      lines.push(`  x ${rej.title.slice(0, 40)}... (${reason})`);
    }
    lines.push('');
  }

  // Discovery (résumé)
  if (discoveryResult && discoveryResult.suggestions) {
    const highPrio = discoveryResult.suggestions.filter((s) => s.priority === 'high');
    if (highPrio.length > 0) {
      lines.push('--- DISCOVERY: SUGGESTIONS ---');
      for (const sug of highPrio.slice(0, 3)) {
        lines.push(`  > [${sug.type}] ${sug.reason}`);
        if (sug.suggestedQueries && sug.suggestedQueries.length > 0) {
          lines.push(`    Queries: ${sug.suggestedQueries.slice(0, 2).join(', ')}`);
        }
      }
      lines.push('');
    }
  }

  lines.push(`Scan: ${new Date().toLocaleTimeString('fr-FR')}`);

  return lines.join('\n').trim();
}

// ─── Pipeline principal ──────────────────────────────────────────────

/**
 * Lance le pipeline complet des 3 agents.
 *
 * @param {Object} scanResult - Résultat du scan (de index.js runOnce)
 * @param {Object} options
 *   - runSupervisor {boolean} - Lancer le superviseur (défaut: true)
 *   - runDiscovery {boolean} - Lancer la discovery (défaut: true)
 *   - runDiagnostic {boolean} - Lancer le diagnostic (défaut: false)
 *   - reverifyPrices {boolean} - Re-vérifier les prix (plus lent, défaut: false)
 *   - checkAvailability {boolean} - Checker dispo Vinted (défaut: true)
 *   - minConfidence {number} - Score minimum pour confirmer (défaut: 30)
 *   - sendTelegram {boolean} - Envoyer notification Telegram (défaut: true)
 * @returns {Object} Résultat complet du pipeline
 */
async function runPipeline(scanResult, options = {}) {
  const {
    runSupervisor = true,
    runDiscovery = true,
    runDiagnostic = false,
    runLiquidity = true,
    reverifyPrices = false,
    checkAvailability = true,
    minConfidence = 30,
    sendTelegram = true
  } = options;

  const pipelineStart = Date.now();
  console.log('\n========================================');
  console.log('  ORCHESTRATEUR — Pipeline multi-agents');
  console.log('========================================\n');

  const result = {
    scanResult: {
      scannedCount: scanResult.scannedCount,
      opportunityCount: scanResult.opportunities.length,
      underpricedCount: (scanResult.underpricedAlerts || []).length
    },
    supervisor: null,
    liquidity: null,
    discovery: null,
    diagnostic: null,
    strategist: null,
    telegram: { sent: false },
    pipeline: {
      startedAt: new Date().toISOString(),
      agents: []
    }
  };

  // ─── Agent Superviseur ───────────────────────────────────────────
  if (runSupervisor && scanResult.opportunities.length > 0) {
    const agentStart = Date.now();
    console.log('[Orchestrateur] Lancement Agent Superviseur...');

    try {
      result.supervisor = await supervise(scanResult.opportunities, config, {
        reverifyPrices,
        checkAvailability,
        minConfidence
      });

      await saveAgentResult('supervisor', result.supervisor);

      result.pipeline.agents.push({
        name: 'supervisor',
        status: 'success',
        durationMs: Date.now() - agentStart,
        results: {
          confirmed: result.supervisor.confirmed.length,
          rejected: result.supervisor.rejected.length,
          avgConfidence: result.supervisor.summary.avgConfidence
        }
      });

      console.log(`[Orchestrateur] Superviseur terminé en ${Date.now() - agentStart}ms`);
    } catch (error) {
      console.error(`[Orchestrateur] ERREUR Superviseur: ${error.message}`);
      result.pipeline.agents.push({
        name: 'supervisor',
        status: 'error',
        error: error.message,
        durationMs: Date.now() - agentStart
      });
    }
  } else if (scanResult.opportunities.length === 0) {
    console.log('[Orchestrateur] Pas d\'opportunités à vérifier, Superviseur skip.');
    result.pipeline.agents.push({
      name: 'supervisor',
      status: 'skipped',
      reason: 'no_opportunities'
    });
  }

  // ─── Agent Liquidité ─────────────────────────────────────────────
  if (runLiquidity) {
    const agentStart = Date.now();
    console.log('[Orchestrateur] Lancement Agent Liquidité...');

    try {
      // On analyse les opportunités confirmées par le superviseur, ou les brutes
      const oppsForLiquidity = result.supervisor
        ? result.supervisor.confirmed
        : scanResult.opportunities || [];

      if (oppsForLiquidity.length > 0) {
        result.liquidity = await assessLiquidity(oppsForLiquidity);

        // Enrichir les opportunités confirmées avec les données de liquidité
        if (result.supervisor && result.liquidity) {
          for (const enrichedOpp of result.liquidity.opportunities) {
            const match = result.supervisor.confirmed.find((c) => c.url === enrichedOpp.url);
            if (match) {
              match.liquidity = enrichedOpp.liquidity;
              // Ajouter aussi dans verification pour accès facile
              if (match.verification) {
                match.verification.liquidityScore = enrichedOpp.liquidity.liquidityScore;
                match.verification.liquiditySummary = enrichedOpp.liquidity.summary;
                match.verification.adjustedMarginPercent = enrichedOpp.liquidity.adjustedMargin.adjustedMarginPercent;
              }
            }
          }
        }

        await saveAgentResult('liquidity', result.liquidity);

        result.pipeline.agents.push({
          name: 'liquidity',
          status: 'success',
          durationMs: Date.now() - agentStart,
          results: result.liquidity.summary
        });
      } else {
        result.pipeline.agents.push({
          name: 'liquidity',
          status: 'skipped',
          reason: 'no_opportunities'
        });
      }

      console.log(`[Orchestrateur] Liquidité terminé en ${Date.now() - agentStart}ms`);
    } catch (error) {
      console.error(`[Orchestrateur] ERREUR Liquidité: ${error.message}`);
      result.pipeline.agents.push({
        name: 'liquidity',
        status: 'error',
        error: error.message,
        durationMs: Date.now() - agentStart
      });
    }
  }

  // ─── Agent Discovery ─────────────────────────────────────────────
  if (runDiscovery) {
    const agentStart = Date.now();
    console.log('[Orchestrateur] Lancement Agent Discovery...');

    try {
      result.discovery = await discover(config);

      await saveAgentResult('discovery', result.discovery);

      result.pipeline.agents.push({
        name: 'discovery',
        status: 'success',
        durationMs: Date.now() - agentStart,
        results: result.discovery.summary
      });

      console.log(`[Orchestrateur] Discovery terminé en ${Date.now() - agentStart}ms`);
    } catch (error) {
      console.error(`[Orchestrateur] ERREUR Discovery: ${error.message}`);
      result.pipeline.agents.push({
        name: 'discovery',
        status: 'error',
        error: error.message,
        durationMs: Date.now() - agentStart
      });
    }
  }

  // ─── Agent Diagnostic ───────────────────────────────────────────
  if (runDiagnostic) {
    const agentStart = Date.now();
    console.log('[Orchestrateur] Lancement Agent Diagnostic...');

    try {
      result.diagnostic = await diagnose(config, {
        deepDiagnose: true,
        checkPlatforms: true,
        sendTelegram: false // Le diagnostic envoie son propre message séparément
      });

      await saveAgentResult('diagnostic', result.diagnostic);

      result.pipeline.agents.push({
        name: 'diagnostic',
        status: 'success',
        durationMs: Date.now() - agentStart,
        results: result.diagnostic.summary
      });

      console.log(`[Orchestrateur] Diagnostic terminé en ${Date.now() - agentStart}ms`);
    } catch (error) {
      console.error(`[Orchestrateur] ERREUR Diagnostic: ${error.message}`);
      result.pipeline.agents.push({
        name: 'diagnostic',
        status: 'error',
        error: error.message,
        durationMs: Date.now() - agentStart
      });
    }
  }

  // ─── Agent Strategist (Portefeuille) ────────────────────────────
  {
    const agentStart = Date.now();
    console.log('[Orchestrateur] Lancement Agent Strategist...');

    try {
      // On evalue les opportunites confirmees par le superviseur, ou les brutes
      const oppsToEvaluate = result.supervisor
        ? result.supervisor.confirmed
        : scanResult.opportunities || [];

      result.strategist = await strategize(oppsToEvaluate, { sendTelegram });

      await saveAgentResult('strategist', result.strategist);

      result.pipeline.agents.push({
        name: 'strategist',
        status: 'success',
        durationMs: Date.now() - agentStart,
        results: result.strategist.summary
      });

      console.log(`[Orchestrateur] Strategist termine en ${Date.now() - agentStart}ms`);
    } catch (error) {
      console.error(`[Orchestrateur] ERREUR Strategist: ${error.message}`);
      result.pipeline.agents.push({
        name: 'strategist',
        status: 'error',
        error: error.message,
        durationMs: Date.now() - agentStart
      });
    }
  }

  // ─── Notifications Telegram ──────────────────────────────────────
  if (sendTelegram && config.telegram.token && config.telegram.chatId) {
    try {
      let message;

      if (result.supervisor && result.supervisor.confirmed.length > 0) {
        // Message enrichi avec les données superviseur
        message = buildEnrichedTelegramMessage(result.supervisor, result.discovery);
      } else if (scanResult.opportunities.length > 0 || (scanResult.underpricedAlerts || []).length > 0) {
        // Fallback: message classique du scraper si pas d'opportunité confirmée
        // mais qu'il y avait quand même des opportunités brutes
        message = buildTelegramMessage(scanResult);
        message = `[Non verifie]\n${message}`;
      }

      if (message) {
        await sendTelegramMessage(config.telegram, message);
        result.telegram.sent = true;
        console.log('[Orchestrateur] Notification Telegram envoyée.');
      }

      // Envoyer aussi un résumé Discovery si suggestions haute priorité
      if (result.discovery) {
        const highPrio = result.discovery.suggestions.filter((s) => s.priority === 'high');
        if (highPrio.length > 0) {
          const discoveryMsg = [
            '--- DISCOVERY ALERT ---',
            `${highPrio.length} suggestion(s) haute priorite:`,
            ...highPrio.slice(0, 3).map((s) => `> ${s.reason}`),
            '',
            'Voir output/agents/discovery-latest.json pour details'
          ].join('\n');
          await sendTelegramMessage(config.telegram, discoveryMsg);
        }
      }
    } catch (error) {
      console.error(`[Orchestrateur] Erreur Telegram: ${error.message}`);
      result.telegram.error = error.message;
    }
  }

  // ─── Résumé final ────────────────────────────────────────────────
  result.pipeline.finishedAt = new Date().toISOString();
  result.pipeline.totalDurationMs = Date.now() - pipelineStart;

  // Sauvegarder le résultat complet du pipeline
  await saveAgentResult('pipeline', result);

  console.log('\n========================================');
  console.log('  PIPELINE TERMINE');
  console.log(`  Durée: ${result.pipeline.totalDurationMs}ms`);
  console.log(`  Scan: ${result.scanResult.scannedCount} annonces`);
  if (result.supervisor) {
    console.log(`  Superviseur: ${result.supervisor.confirmed.length} confirmée(s) / ${result.supervisor.summary.total}`);
  }
  if (result.liquidity) {
    const ls = result.liquidity.summary;
    console.log(`  Liquidité: score moyen ${ls.avgLiquidityScore}/100, marge ajustée moy ${ls.avgAdjustedMargin}%`);
  }
  if (result.discovery) {
    console.log(`  Discovery: ${result.discovery.summary.totalSuggestions} suggestion(s)`);
  }
  if (result.diagnostic) {
    const ds = result.diagnostic.summary;
    console.log(`  Diagnostic: ${ds.healthyNiches} OK, ${ds.warningNiches} attention, ${ds.criticalNiches} critique, ${ds.deadNiches} mortes`);
  }
  if (result.strategist) {
    const st = result.strategist.summary;
    console.log(`  Strategist: ${st.acheter} a acheter, ${st.interessant} interessant(s) | Palier ${st.tier} (${st.tierName}) | Capital: ${st.portfolioValue} EUR`);
  }
  console.log('========================================\n');

  return result;
}

// ─── Mode standalone ─────────────────────────────────────────────────

/**
 * Lancer le pipeline sans le scraper (sur les résultats existants).
 * Utile pour tester le superviseur/discovery indépendamment.
 */
async function runStandalone(options = {}) {
  const scanDataPath = path.join(config.outputDir, 'latest-scan.json');

  let scanResult;
  try {
    scanResult = JSON.parse(fs.readFileSync(scanDataPath, 'utf8'));
  } catch (error) {
    console.error(`Impossible de lire ${scanDataPath}: ${error.message}`);
    console.error('Lancez d\'abord un scan avec: npm start');
    process.exitCode = 1;
    return null;
  }

  return await runPipeline(scanResult, options);
}

module.exports = {
  runPipeline,
  runStandalone,
  buildEnrichedTelegramMessage,
  saveAgentResult,
  loadAgentResult
};
