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
const { discover, appendDiscoveryFindings } = require('./discovery');
const { diagnose } = require('./diagnostic');
const { strategize } = require('./strategist');
const { assessLiquidity } = require('./liquidity');
const { buildTelegramMessage, sendTelegramMessage } = require('../notifier');

// ─── Chemins fichiers sprint ──────────────────────────────────────────────────

const SPRINT_CONTRACT_PATH   = path.join(config.outputDir, 'sprint-contract.json');
const EVALUATOR_FEEDBACK_PATH = path.join(config.outputDir, 'evaluator-feedback.json');

// ─── Sprint Contract — Patterns 1 & 3 ────────────────────────────────────────

/**
 * Analyse feedback-log.json (feedbacks Justin) et evaluator-feedback.json
 * (rejets Évaluateur) pour calculer les ajustements du prochain sprint.
 *
 * Pattern 3 : si > 70% rejets sur même raison dans une catégorie → ajuster
 */
function computeSprintAdjustments(cfg) {
  const outputDir = (cfg || config).outputDir;

  // Lire feedback-log.json (feedbacks utilisateur)
  let userFeedbacks = [];
  try {
    const fbPath = path.join(outputDir, 'feedback-log.json');
    if (fs.existsSync(fbPath)) {
      const raw = JSON.parse(fs.readFileSync(fbPath, 'utf8'));
      userFeedbacks = Array.isArray(raw) ? raw : [];
    }
  } catch { /* ignore */ }

  // Lire evaluator-feedback.json (rejets récents de l'Évaluateur)
  let evaluatorFeedbacks = [];
  try {
    if (fs.existsSync(EVALUATOR_FEEDBACK_PATH)) {
      const raw = JSON.parse(fs.readFileSync(EVALUATOR_FEEDBACK_PATH, 'utf8'));
      evaluatorFeedbacks = Array.isArray(raw.feedbacks) ? raw.feedbacks : [];
    }
  } catch { /* ignore */ }

  // Critères de base (valeurs par défaut)
  const criteria = {
    minMatchScore: 4,
    requiredFields: ['ebayMatchImageUrl'],
    legoRequiresSetNumber: true,
    cardsRequireVariantMatch: true,
    minProfitLego: 50,
    minProfitOther: 15,
    maxAcceptableVisionErrorRate: 0.5
  };

  const queryAdjustments = [];

  // ─── Analyser les feedbacks utilisateur par catégorie ─────────────────────
  const rejectsByCategory = {};
  for (const fb of userFeedbacks) {
    const isReject = fb.action === 'reject' || fb.status === 'rejected' || fb.decision === 'reject';
    if (!isReject) continue;
    const cat = (fb.category || fb.search || 'unknown').toLowerCase();
    if (!rejectsByCategory[cat]) rejectsByCategory[cat] = { total: 0, reasons: {} };
    rejectsByCategory[cat].total++;
    const reason = (fb.reason || fb.rejectionReason || '').toLowerCase();
    if (reason) {
      rejectsByCategory[cat].reasons[reason] = (rejectsByCategory[cat].reasons[reason] || 0) + 1;
    }
  }

  // Pattern 3 : si > 70% de rejets pour même raison → ajuster le contrat
  for (const [cat, stats] of Object.entries(rejectsByCategory)) {
    if (stats.total < 3) continue;
    for (const [reason, count] of Object.entries(stats.reasons)) {
      const rate = count / stats.total;
      if (rate <= 0.7) continue;

      if (reason.includes('variant') || reason.includes('rarete') || reason.includes('rareté')) {
        criteria.cardsRequireVariantMatch = true;
        if (!queryAdjustments.find(a => a.type === 'add_rarity_tokens' && a.category === cat)) {
          queryAdjustments.push({
            type: 'add_rarity_tokens',
            category: cat,
            reason: `${Math.round(rate * 100)}% rejets "variant_mismatch" → tokens rareté requis`,
            addedAt: new Date().toISOString()
          });
        }
      }

      if (reason.includes('prix') || reason.includes('price') || reason.includes('unreliable')) {
        if (!queryAdjustments.find(a => a.type === 'require_min_observations' && a.category === cat)) {
          queryAdjustments.push({
            type: 'require_min_observations',
            category: cat,
            minObservations: 2,
            reason: `${Math.round(rate * 100)}% rejets "prix_non_fiable" → min 2 observations exigées`,
            addedAt: new Date().toISOString()
          });
        }
      }
    }
  }

  // ─── Analyser les rejets Évaluateur récents (< 48h) ───────────────────────
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const recentFeedbacks = evaluatorFeedbacks.filter(f => {
    try { return new Date(f.timestamp) > cutoff48h; } catch { return false; }
  });

  const legoSetRejections = recentFeedbacks.filter(f =>
    f.suggestion === 'query_should_include_set_number'
  ).length;

  if (legoSetRejections >= 2) {
    criteria.legoRequiresSetNumber = true;
    if (!queryAdjustments.find(a => a.type === 'force_set_number_search')) {
      queryAdjustments.push({
        type: 'force_set_number_search',
        category: 'lego',
        reason: `${legoSetRejections} rejets récents "numéro de set différent" → recherche par numéro de set forcée`,
        addedAt: new Date().toISOString()
      });
    }
  }

  const cardVariantRejections = recentFeedbacks.filter(f =>
    f.reason === 'variant_mismatch' && (f.category || '').toUpperCase() !== 'LEGO'
  ).length;

  if (cardVariantRejections >= 2) {
    criteria.cardsRequireVariantMatch = true;
    if (!queryAdjustments.find(a => a.type === 'add_variant_tokens')) {
      queryAdjustments.push({
        type: 'add_variant_tokens',
        reason: `${cardVariantRejections} rejets récents "variant_mismatch" sur cartes → tokens variante requis`,
        addedAt: new Date().toISOString()
      });
    }
  }

  return { criteria, queryAdjustments };
}

/**
 * Écrit output/sprint-contract.json avant chaque cycle Scanner→Évaluateur.
 *
 * Pattern 1 : Contrat de sprint (Orchestrateur → Scanner + Évaluateur)
 * Pattern 3 : Ajustements basés sur les feedbacks utilisateur
 *
 * @returns {Object} Le contrat écrit
 */
async function writeSprintContract(cfg) {
  const outputDir = (cfg || config).outputDir;

  const now  = new Date();
  const pad  = n => String(n).padStart(2, '0');
  const sprintId = `sprint-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

  const { criteria, queryAdjustments } = computeSprintAdjustments(cfg);

  const contract = {
    sprintId,
    generatedAt: now.toISOString(),
    criteria,
    queryAdjustments
  };

  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(outputDir, 'sprint-contract.json'),
    JSON.stringify(contract, null, 2)
  );

  console.log(`[Orchestrateur] Sprint contract: ${sprintId} (${queryAdjustments.length} ajustement(s) query)`);
  return contract;
}

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

// ─── Filesystem Context — decisions.md ───────────────────────────────

/**
 * Appende un résumé des décisions du pipeline dans output/agents/orchestrator/decisions.md
 */
async function appendOrchestratorDecision(result) {
  const decisionsPath = path.join(config.outputDir, 'agents', 'orchestrator', 'decisions.md');
  try {
    await fs.promises.mkdir(path.dirname(decisionsPath), { recursive: true });

    const now = new Date();
    const dateStr = now.toISOString().replace('T', ' ').slice(0, 19);
    const lines = [`\n## Pipeline ${dateStr}`, ''];

    // Scan résumé
    const sr = result.scanResult || {};
    lines.push(`- **Scan :** ${sr.scannedCount || 0} annonces, ${sr.opportunityCount || 0} opportunités brutes`);

    // Superviseur
    if (result.supervisor) {
      const sv = result.supervisor.summary || {};
      lines.push(`- **Superviseur :** ${sv.confirmed || result.supervisor.confirmed.length} confirmées / ${sv.total || 0} (confiance moy ${sv.avgConfidence || 0}/100)`);
    }

    // Agents status
    const agentLines = (result.pipeline.agents || []).map((a) => {
      if (a.status === 'success') return `  - ${a.name}: ✅ (${a.durationMs}ms)`;
      if (a.status === 'error')   return `  - ${a.name}: ❌ ${a.error}`;
      return `  - ${a.name}: ⏭ skipped`;
    });
    if (agentLines.length > 0) {
      lines.push('- **Agents :**');
      lines.push(...agentLines);
    }

    // Durée totale
    lines.push(`- **Durée totale :** ${result.pipeline.totalDurationMs}ms`);
    lines.push(`- **Telegram :** ${result.telegram.sent ? 'envoyé ✅' : 'non envoyé'}`);
    lines.push('');

    await fs.promises.appendFile(decisionsPath, lines.join('\n'));
  } catch (err) {
    console.error(`[Orchestrateur] Erreur écriture decisions.md: ${err.message}`);
  }
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
      await appendDiscoveryFindings(result.discovery, config);

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

  // Écrire un résumé de la décision dans output/agents/orchestrator/decisions.md
  await appendOrchestratorDecision(result);

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

// ─── Health Check — Analyse et décisions automatiques ────────────────────────

/**
 * Lit les fichiers health du Scanner et de l'Évaluateur, détecte les problèmes,
 * et écrit des décisions correctrices dans output/orchestrator-decisions.json.
 *
 * Les décisions sont lues par l'Évaluateur à chaque run pour adapter son comportement.
 *
 * Patterns détectés :
 *   1. vision_errors_high       → disable_vision (2h)
 *   2. all_rejected_good_matches → lower_confidence_threshold (4h)
 *   3. scanner_no_matches       → purge_seen_cache (one-shot)
 */
async function runHealthCheck(cfg) {
  const outputDir       = (cfg || config).outputDir;
  const decisionsPath   = path.join(outputDir, 'orchestrator-decisions.json');
  const healthCheckAt   = new Date().toISOString();

  console.log('\n[Orchestrateur] === Health Check ===');

  // ─── Lecture des fichiers santé ─────────────────────────────────────────
  function readHealth(fileName) {
    try {
      const p = path.join(outputDir, fileName);
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* ignore */ }
    return null;
  }

  const scannerHealth   = readHealth('scanner-health.json');
  const evaluatorHealth = readHealth('evaluator-health.json');

  if (!scannerHealth && !evaluatorHealth) {
    console.log('[Orchestrateur] Pas encore de données health — skip.');
    return null;
  }

  // ─── Lecture des décisions existantes ──────────────────────────────────
  let existingDecisions = [];
  try {
    if (fs.existsSync(decisionsPath)) {
      existingDecisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
    }
  } catch { existingDecisions = []; }

  const now = new Date();

  function hasActive(action) {
    return existingDecisions.some(d =>
      d.action === action && d.active && (!d.expiresAt || new Date(d.expiresAt) > now)
    );
  }

  function expireAction(action) {
    for (const d of existingDecisions) {
      if (d.action === action && d.active) {
        d.active     = false;
        d.expiredAt  = now.toISOString();
      }
    }
  }

  const newDecisions = [];

  // ─── Pattern 1 : Vision error rate > 50% ────────────────────────────────
  if (
    evaluatorHealth &&
    evaluatorHealth.visionRuns >= 3 &&
    evaluatorHealth.visionErrorRate > 0.5
  ) {
    if (!hasActive('disable_vision')) {
      const dec = {
        id:        `dec-${Date.now()}-vision`,
        timestamp: healthCheckAt,
        pattern:   'vision_errors_high',
        action:    'disable_vision',
        reason:    `Vision error rate ${(evaluatorHealth.visionErrorRate * 100).toFixed(0)}% > 50% (${evaluatorHealth.visionErrors}/${evaluatorHealth.visionRuns} erreurs)`,
        active:    true,
        expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString()
      };
      newDecisions.push(dec);
      console.log(`[Orchestrateur] 🔧 DÉCISION: ${dec.reason} → vision désactivée 2h`);
    }
  } else {
    // Error rate revenu normal → expirer la décision
    expireAction('disable_vision');
  }

  // ─── Pattern 2 : Scanner trouve des matchs mais Évaluateur rejette tout ──
  if (scannerHealth && evaluatorHealth && evaluatorHealth.evaluated >= 5) {
    const rejectRate = evaluatorHealth.evaluated > 0
      ? evaluatorHealth.rejected / evaluatorHealth.evaluated
      : 0;
    const matchRate = scannerHealth.itemsScanned > 0
      ? scannerHealth.matchesFound / scannerHealth.itemsScanned
      : 0;

    if (matchRate > 0.1 && rejectRate > 0.95) {
      if (!hasActive('lower_confidence_threshold')) {
        const dec = {
          id:        `dec-${Date.now()}-conf`,
          timestamp: healthCheckAt,
          pattern:   'all_rejected_good_matches',
          action:    'lower_confidence_threshold',
          threshold: 40,
          reason:    `${(rejectRate * 100).toFixed(0)}% rejetés malgré ${(matchRate * 100).toFixed(0)}% match rate (confiance avg ${evaluatorHealth.avgConfidence}/100) → seuil abaissé à 40`,
          active:    true,
          expiresAt: new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString()
        };
        newDecisions.push(dec);
        console.log(`[Orchestrateur] 🔧 DÉCISION: ${dec.reason}`);
      }
    } else {
      expireAction('lower_confidence_threshold');
    }
  }

  // ─── Pattern 3 : Scanner ne trouve rien du tout ──────────────────────────
  if (
    scannerHealth &&
    scannerHealth.matchesFound === 0 &&
    scannerHealth.itemsScanned > 10
  ) {
    if (!hasActive('purge_seen_cache')) {
      console.log('[Orchestrateur] 🔧 DÉCISION: 0 match trouvé → purge cache seen-listings');

      // Purge effective du cache
      try {
        const seenListingsModule = require('../seen-listings');
        if (typeof seenListingsModule.pruneOld === 'function') {
          seenListingsModule.pruneOld(0); // maxAgeHours=0 → tout supprimer
        }
      } catch (err) {
        console.error(`[Orchestrateur] Erreur purge seen-listings: ${err.message}`);
      }

      const dec = {
        id:        `dec-${Date.now()}-cache`,
        timestamp: healthCheckAt,
        pattern:   'scanner_no_matches',
        action:    'purge_seen_cache',
        reason:    `0 match sur ${scannerHealth.itemsScanned} items → cache seen-listings purgé`,
        active:    false, // One-shot: déjà exécuté
        appliedAt: now.toISOString()
      };
      newDecisions.push(dec);
    }
  }

  // ─── Résumé ──────────────────────────────────────────────────────────────
  const scannerSummary = scannerHealth
    ? `Scanner: ${scannerHealth.itemsScanned} items, ${scannerHealth.matchesFound} matchs`
    : 'Scanner: n/a';

  const evaluatorSummary = evaluatorHealth
    ? `Évaluateur: ${evaluatorHealth.evaluated} évalués, ${evaluatorHealth.accepted} OK, ${evaluatorHealth.rejected} rejetés, vision ${(evaluatorHealth.visionErrorRate * 100).toFixed(0)}% erreurs, confiance moy ${evaluatorHealth.avgConfidence}/100`
    : 'Évaluateur: n/a';

  console.log(`[Orchestrateur] ${scannerSummary}`);
  console.log(`[Orchestrateur] ${evaluatorSummary}`);

  if (newDecisions.length === 0) {
    console.log('[Orchestrateur] ✅ Tout va bien, aucune intervention nécessaire.');
  }

  // ─── Sauvegarde des décisions ────────────────────────────────────────────
  // Garder les décisions actives + les 24 dernières heures d'historique
  const cutoff      = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const keepOld     = existingDecisions.filter(d =>
    d.active || new Date(d.appliedAt || d.timestamp || 0) > cutoff
  );
  const allDecisions = [...keepOld, ...newDecisions];

  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.writeFile(decisionsPath, JSON.stringify(allDecisions, null, 2));

  const activeCount = allDecisions.filter(d => d.active).length;
  if (activeCount > 0) {
    console.log(`[Orchestrateur] ${activeCount} décision(s) active(s).`);
  }

  console.log('[Orchestrateur] === Health Check terminé ===\n');

  return {
    checkedAt:     healthCheckAt,
    scannerHealth,
    evaluatorHealth,
    newDecisions,
    activeDecisions: allDecisions.filter(d => d.active)
  };
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
  runHealthCheck,
  writeSprintContract,
  buildEnrichedTelegramMessage,
  saveAgentResult,
  loadAgentResult
};
