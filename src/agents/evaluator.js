/**
 * Agent Évaluateur — Lit les candidats bruts du Scanner, applique le scoring
 * complet (texte + vision GPT + liquidité), et prend la décision finale.
 *
 * Entrée  : output/scanner-results.json  (ou tableau passé en mémoire)
 * Sortie  :
 *   output/evaluated-opportunities.json  — résultats complets
 *   output/evaluator-health.json         — métriques de santé
 *   output/vision-budget.json            — compteur de dépenses Vision du jour
 *
 * Budget Vision GPT :
 *   - VISION_DAILY_BUDGET_CENTS (défaut: 100 = 1$/jour)
 *   - VISION_MIN_PROFIT_FOR_CHECK (défaut: 10€ — ne pas vérifier les petits profits)
 *   - Coût estimé: ~3 cents/appel (2 images detail:auto)
 *   - Si budget dépassé OU profit trop bas → skip Vision, pHash seul, badge "⚠ Non vérifié GPT"
 *   - Un skip budgétaire N'est PAS une erreur Vision (l'Orchestrateur ne le compte pas)
 *
 * Autres règles :
 *   - GPT Vision échoue (429/timeout) → item marqué "pending_manual_review"
 *   - Décision Orchestrateur "disable_vision" → Vision complètement skippée
 *   - Décision Orchestrateur "lower_confidence_threshold" → seuil abaissé
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const config = require('../config');

const { computeConfidence, computeLiquidity } = require('../scoring');
const { compareCardImages }                   = require('../vision-verify');
const { sendOpportunityAlert }                = require('../notifier');
const seenListings                            = require('../seen-listings');

// ─── Helpers budget Vision ────────────────────────────────────────────────────

/**
 * Charge le fichier vision-budget.json.
 * Reset automatique si le jour a changé.
 */
function loadVisionBudget(outputDir) {
  const filePath = path.join(outputDir, 'vision-budget.json');
  const today    = new Date().toISOString().slice(0, 10);

  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.date === today) return data;
      // Nouveau jour → reset
    }
  } catch { /* ignore */ }

  return { date: today, callsToday: 0, estimatedCostCents: 0 };
}

/**
 * Sauvegarde le budget en mémoire sur disque.
 */
function saveVisionBudget(outputDir, budget) {
  try {
    fs.writeFileSync(
      path.join(outputDir, 'vision-budget.json'),
      JSON.stringify(budget, null, 2)
    );
  } catch { /* non-bloquant */ }
}

/**
 * Décide si on doit skipper Vision pour raison économique.
 *
 * @returns {{ skip: boolean, reason: string|null }}
 *   reason: 'profit_too_low' | 'budget_exceeded' | null
 */
function shouldSkipVisionBudget(row, budget) {
  const dailyBudget = config.visionDailyBudgetCents   || 100;
  const minProfit   = config.visionMinProfitForCheck   || 10;
  const costPerCall = config.visionCostPerCallCents    || 3;

  const estimatedProfit = (row.profit && typeof row.profit.profit === 'number')
    ? row.profit.profit
    : 0;

  if (estimatedProfit < minProfit) {
    return { skip: true, reason: 'profit_too_low' };
  }

  if (budget.estimatedCostCents + costPerCall > dailyBudget) {
    return { skip: true, reason: 'budget_exceeded' };
  }

  return { skip: false, reason: null };
}

// ─── Décisions actives de l'Orchestrateur ────────────────────────────────────

function getActiveDecisions(outputDir) {
  try {
    const filePath = path.join(outputDir, 'orchestrator-decisions.json');
    if (!fs.existsSync(filePath)) return [];
    const decisions = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const now = new Date();
    return decisions.filter(d => d.active && (!d.expiresAt || new Date(d.expiresAt) > now));
  } catch {
    return [];
  }
}

// ─── Agent principal ──────────────────────────────────────────────────────────

/**
 * Évalue tous les candidats bruts du Scanner.
 *
 * @param {Array|null} candidates — Candidats en mémoire (null = lire depuis le disque)
 * @returns {{ opportunities, pendingReview, rejected, allEvaluated, health }}
 */
async function run(candidates = null) {
  const runStarted = Date.now();
  const outputDir  = config.outputDir;

  // ─── Chargement des candidats ─────────────────────────────────────────────
  if (!candidates) {
    try {
      const raw  = fs.readFileSync(path.join(outputDir, 'scanner-results.json'), 'utf8');
      const data = JSON.parse(raw);
      candidates = data.candidates || [];
    } catch (err) {
      console.log(`[Evaluator] scanner-results.json absent ou illisible: ${err.message}`);
      candidates = [];
    }
  }

  // ─── Budget Vision du jour ─────────────────────────────────────────────────
  const budget = loadVisionBudget(outputDir);
  const dailyBudget = config.visionDailyBudgetCents || 100;

  // ─── Décisions de l'Orchestrateur ────────────────────────────────────────
  const activeDecisions      = getActiveDecisions(outputDir);
  const visionDisabledByOrch = activeDecisions.some(d => d.action === 'disable_vision');
  const confidenceOverride   = activeDecisions.find(d => d.action === 'lower_confidence_threshold');
  const minConfidenceDefault = 50;
  const minConfidence        = confidenceOverride ? (confidenceOverride.threshold || 40) : minConfidenceDefault;

  console.log(`\n[Evaluator] Évaluation de ${candidates.length} candidat(s)...`);
  console.log(`[Evaluator] Budget Vision: ${budget.estimatedCostCents}/${dailyBudget} cents (${budget.callsToday} appels aujourd'hui)`);
  if (visionDisabledByOrch) console.log('[Evaluator] ⚠ Vision GPT désactivée par l\'Orchestrateur');
  if (confidenceOverride)   console.log(`[Evaluator] ⚠ Seuil confiance abaissé à ${minConfidence} (Orchestrateur)`);

  const opportunities    = [];
  const pendingReview    = [];
  const rejected         = [];
  const allEvaluated     = [];
  let visionErrors       = 0;
  let visionRuns         = 0;
  let visionBudgetSkips  = 0; // skips économiques — pas des erreurs
  const confidenceScores = [];

  for (const row of candidates) {
    try {
      // ─── Vision GPT-4o mini ────────────────────────────────────────────────
      const visionPossible =
        !visionDisabledByOrch &&
        row.imageUrl          &&
        row.ebayMatchImageUrl  &&
        row.matchedSales && row.matchedSales.length > 0 &&
        process.env.OPENAI_API_KEY;

      if (visionPossible) {
        // Vérification budget avant l'appel
        const budgetCheck = shouldSkipVisionBudget(row, budget);

        if (budgetCheck.skip) {
          // ─── Skip économique ──────────────────────────────────────────────
          visionBudgetSkips++;
          row.visionSkippedBudget = true;
          row.visionSkipReason    = budgetCheck.reason;

          const profit = row.profit ? row.profit.profit.toFixed(2) : '0.00';
          if (budgetCheck.reason === 'profit_too_low') {
            console.log(`[Evaluator] 💰 Vision skip (profit ${profit}€ < ${config.visionMinProfitForCheck}€): "${row.title.slice(0, 50)}"`);
          } else {
            console.log(`[Evaluator] 💰 Vision skip (budget ${budget.estimatedCostCents}/${dailyBudget}¢): "${row.title.slice(0, 50)}"`);
          }

        } else {
          // ─── Appel GPT Vision ─────────────────────────────────────────────
          visionRuns++;
          try {
            console.log(`[Evaluator] Vision: "${row.title.slice(0, 50)}"`);
            const visionResult = await compareCardImages(row.imageUrl, row.ebayMatchImageUrl);

            if (visionResult) {
              row.visionVerified = true;
              row.visionResult   = visionResult;
              row.visionSameCard = visionResult.sameCard;

              if (visionResult.sameCard === false) {
                console.log(`[Evaluator] ❌ Vision REJET: "${row.title.slice(0, 50)}" — ${visionResult.summary}`);
              } else {
                console.log(`[Evaluator] ✅ Vision OK: "${row.title.slice(0, 50)}" (${visionResult.confidence}%)`);
              }
            }

            // Comptabiliser le coût uniquement si l'appel a abouti
            budget.callsToday++;
            budget.estimatedCostCents += (config.visionCostPerCallCents || 3);
            saveVisionBudget(outputDir, budget);

          } catch (visionErr) {
            visionErrors++;
            console.log(`[Evaluator] Vision erreur: ${visionErr.message} → pending_manual_review`);
            row.visionError = visionErr.message;
            row.status      = 'pending_manual_review';
          }
        }

      } else if (!visionPossible && !visionDisabledByOrch && !row.ebayMatchImageUrl) {
        console.log(`[Evaluator] ⏭ Vision skip: "${row.title.slice(0, 50)}" — pas d'image eBay`);
      }

      // ─── Scoring ────────────────────────────────────────────────────────────
      // computeConfidence lit row.visionVerified, row.visionResult ET row.visionSkippedBudget
      // (scoring.js utilise des seuils pHash assouplis si visionSkippedBudget = true)
      row.confidence = computeConfidence(row);
      row.liquidity  = computeLiquidity(row);
      confidenceScores.push(row.confidence);

      // ─── Décision opportunité ─────────────────────────────────────────────
      if (row.status === 'pending_manual_review') {
        pendingReview.push(row);
        allEvaluated.push(row);
        continue;
      }

      const search     = config.searches ? config.searches.find(s => s.name === row.search) : null;
      const minProfEur = Math.max(5,  search && search.minProfitEur     != null ? search.minProfitEur     : config.minProfitEur);
      const minProfPct = Math.max(20, search && search.minProfitPercent != null ? search.minProfitPercent : config.minProfitPercent);
      const liqScore   = (row.liquidity && typeof row.liquidity === 'object') ? row.liquidity.score : 0;
      const src        = row.pricingSource || 'unknown';
      const minLiq     = src === 'local-database' ? 25 : 40;

      const failsProfit     = !row.profit || row.profit.profit        < minProfEur;
      const failsMargin     = !row.profit || row.profit.profitPercent < minProfPct;
      const failsConfidence = row.confidence < minConfidence;
      const failsLiquidity  = liqScore < minLiq;

      if (failsProfit || failsMargin || failsConfidence || failsLiquidity) {
        const reasons = [];
        if (failsProfit)     reasons.push(`profit ${row.profit ? row.profit.profit.toFixed(2) : '0.00'}€ < ${minProfEur}€`);
        if (failsMargin)     reasons.push(`marge ${row.profit ? row.profit.profitPercent.toFixed(1) : '0.0'}% < ${minProfPct}%`);
        if (failsConfidence) reasons.push(`confiance ${row.confidence}/100 < ${minConfidence}`);
        if (failsLiquidity)  reasons.push(`liquidité ${liqScore}/100 < ${minLiq}`);

        console.log(`  [rejeté] ${row.title.slice(0, 50)}: ${reasons.join(', ')}`);
        row.rejectionReasons = reasons;
        rejected.push(row);

        if (row.id) {
          seenListings.markAsSeen(row.id, row.search, row.title, 'no-match',
            row.profit ? row.profit.profit : null);
        }
      } else {
        opportunities.push(row);
        console.log(`  [opportunité] ${row.title} -> ${row.profit.profit.toFixed(2)} EUR (confiance ${row.confidence}/100${row.visionSkippedBudget ? ' ⚠ non vérifié GPT' : ''})`);
        sendOpportunityAlert(row).catch(() => {});

        if (row.id) {
          seenListings.markAsSeen(row.id, row.search, row.title, 'opportunity',
            row.profit ? row.profit.profit : null);
        }
      }

      allEvaluated.push(row);

    } catch (err) {
      console.error(`[Evaluator] Erreur sur "${(row.title || '').slice(0, 50)}": ${err.message}`);
    }
  }

  // ─── Métriques santé ─────────────────────────────────────────────────────
  const durationMs    = Date.now() - runStarted;
  const avgConfidence = confidenceScores.length > 0
    ? Math.round(confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length)
    : 0;

  const health = {
    lastRunAt:           new Date().toISOString(),
    evaluated:           candidates.length,
    accepted:            opportunities.length,
    rejected:            rejected.length,
    pendingReview:       pendingReview.length,
    visionErrors,
    visionRuns,
    // Note: visionBudgetSkips n'est PAS inclus dans visionErrorRate
    // pour ne pas déclencher disable_vision dans l'Orchestrateur
    visionBudgetSkips,
    visionErrorRate: visionRuns > 0 ? Math.round((visionErrors / visionRuns) * 100) / 100 : 0,
    avgConfidence,
    budgetUsedCents:     budget.estimatedCostCents,
    budgetLimitCents:    dailyBudget,
    durationMs
  };

  // ─── Sauvegardes ─────────────────────────────────────────────────────────
  await fs.promises.mkdir(outputDir, { recursive: true });

  await fs.promises.writeFile(
    path.join(outputDir, 'evaluated-opportunities.json'),
    JSON.stringify({ evaluatedAt: new Date().toISOString(), opportunities, pendingReview, rejected, allEvaluated }, null, 2)
  );

  await fs.promises.writeFile(
    path.join(outputDir, 'evaluator-health.json'),
    JSON.stringify(health, null, 2)
  );

  console.log(`[Evaluator] Terminé: ${opportunities.length} opportunités / ${candidates.length} évalués (${durationMs}ms)`);
  console.log(`[Evaluator] Vision: ${visionRuns} appels, ${visionErrors} erreurs, ${visionBudgetSkips} skips budget — coût: ${budget.estimatedCostCents}¢/${dailyBudget}¢`);

  return { opportunities, pendingReview, rejected, allEvaluated, health };
}

module.exports = { run, getActiveDecisions, loadVisionBudget };
