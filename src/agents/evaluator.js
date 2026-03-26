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
 *   - GPT Vision échoue (429/timeout) → item reste "candidate" (retry prochain scan)
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
const messageBus                              = require('../message-bus');

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

// ─── Sprint Contract ──────────────────────────────────────────────────────────

/**
 * Lit output/sprint-contract.json écrit par l'Orchestrateur.
 * @returns {Object|null}
 */
function loadSprintContract(outputDir) {
  try {
    const p = path.join(outputDir, 'sprint-contract.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* ignore */ }
  return null;
}

// ─── Feedback Évaluateur — Pattern 2 ─────────────────────────────────────────

/**
 * Ajoute une entrée dans output/evaluator-feedback.json.
 * Appelé pour chaque rejet afin de donner un feedback ACTIONNABLE au Scanner.
 *
 * Pattern 2 : Feedback spécifique Évaluateur → Scanner
 */
function writeEvaluatorFeedback(outputDir, entry) {
  const feedbackPath = path.join(outputDir, 'evaluator-feedback.json');

  let existing = { feedbacks: [], updatedAt: null };
  try {
    if (fs.existsSync(feedbackPath)) {
      const raw = JSON.parse(fs.readFileSync(feedbackPath, 'utf8'));
      existing = raw;
      if (!Array.isArray(existing.feedbacks)) existing.feedbacks = [];
    }
  } catch { existing = { feedbacks: [] }; }

  existing.feedbacks.unshift(entry);
  if (existing.feedbacks.length > 200) existing.feedbacks = existing.feedbacks.slice(0, 200);
  existing.updatedAt = new Date().toISOString();

  try {
    fs.writeFileSync(feedbackPath, JSON.stringify(existing, null, 2));
  } catch { /* non-bloquant */ }
}

/**
 * Détermine la suggestion actionnable pour le Scanner en fonction de la raison de rejet.
 */
function getSuggestion(failedKey, isLego) {
  if (failedKey === 'legoSetNumber')   return 'query_should_include_set_number';
  if (failedKey === 'noVariantMismatch') return 'query_should_add_variant_tokens';
  if (failedKey === 'priceReliable')   return 'require_more_observations';
  return null;
}

// ─── Évaluation par critères (Pattern 5 — Seuils durs) ────────────────────────

/**
 * Évalue chaque critère individuellement avec un seuil dur.
 * Si UN SEUL critère échoue → rejet avec raison précise.
 *
 * Pattern 5 : Seuils durs par critère
 *
 * @returns {{ checks: Array, failedCriteria: Array, passed: boolean }}
 */
function evaluateCriteria(row, sprintContract, minConfidence, minProfEur, minProfPct, minLiq) {
  const ct       = (sprintContract && sprintContract.criteria) || {};
  const category = (row.category || row.search || '').toUpperCase();
  const isLego   = category.includes('LEGO');

  const profitSeuil      = isLego ? (ct.minProfitLego || 50) : (ct.minProfitOther || 15);
  const itemProfit       = row.profit ? row.profit.profit : 0;
  const itemMargin       = row.profit ? row.profit.profitPercent : 0;
  const priceObs         = (row.priceDetails && row.priceDetails.observations) ||
                           (row.matchedSales ? row.matchedSales.length : 0);
  const isPriceFromApi   = ['pokemon-tcg', 'ygoprodeck', 'rebrickable', 'pokemon-tcg-api'].includes(row.pricingSource);
  const liqScore         = (row.liquidity && typeof row.liquidity === 'object') ? row.liquidity.score : 0;

  const checks = [
    {
      key:       'profitMinCategory',
      label:     `Profit minimum ${isLego ? 'LEGO' : 'catégorie'}`,
      passed:    itemProfit >= profitSeuil,
      value:     itemProfit,
      threshold: profitSeuil,
      reason:    'profit_below_category_min',
      suggestion: null
    },
    {
      key:       'profitEur',
      label:     'Profit EUR',
      passed:    !!row.profit && itemProfit >= minProfEur,
      value:     itemProfit,
      threshold: minProfEur,
      reason:    'profit_insufficient',
      suggestion: null
    },
    {
      key:       'profitPct',
      label:     'Marge %',
      passed:    !!row.profit && itemMargin >= minProfPct,
      value:     itemMargin,
      threshold: minProfPct,
      reason:    'margin_insufficient',
      suggestion: null
    },
    {
      key:       'priceReliable',
      label:     'Prix fiable',
      passed:    isPriceFromApi || priceObs >= 2,
      value:     priceObs,
      threshold: 2,
      reason:    'price_unreliable',
      suggestion: 'require_more_observations'
    },
    {
      key:       'confidence',
      label:     'Confiance',
      passed:    row.confidence >= minConfidence,
      value:     row.confidence,
      threshold: minConfidence,
      reason:    'confidence_too_low',
      suggestion: null
    },
    {
      key:       'liquidity',
      label:     'Liquidité',
      passed:    liqScore >= minLiq,
      value:     liqScore,
      threshold: minLiq,
      reason:    'liquidity_insufficient',
      suggestion: null
    }
  ];

  // Variante correcte (si sprint contract exige)
  if (ct.cardsRequireVariantMatch && !isLego) {
    checks.push({
      key:       'noVariantMismatch',
      label:     'Variante correcte',
      passed:    !row.variantMismatch,
      value:     !row.variantMismatch,
      threshold: true,
      reason:    'variant_mismatch',
      suggestion: 'query_should_add_variant_tokens'
    });
  }

  // Numéro de set LEGO (si sprint contract exige)
  if (ct.legoRequiresSetNumber && isLego) {
    const setNumInVinted = /\b\d{4,6}\b/.test(row.title || '');
    const ebayTitle      = (row.matchedSales && row.matchedSales[0] && row.matchedSales[0].title) || '';
    const setNumInEbay   = /\b\d{4,6}\b/.test(ebayTitle);
    // Bloquant seulement si Vinted a un numéro mais eBay a un numéro différent
    const hasConflict = setNumInVinted && setNumInEbay && (() => {
      const vintedNums = (row.title || '').match(/\b\d{4,6}\b/g) || [];
      const ebayNums   = ebayTitle.match(/\b\d{4,6}\b/g) || [];
      return !vintedNums.some(n => ebayNums.includes(n));
    })();
    checks.push({
      key:       'legoSetNumber',
      label:     'Numéro set LEGO',
      passed:    !hasConflict,
      value:     !hasConflict,
      threshold: true,
      reason:    'lego_set_number_mismatch',
      suggestion: 'query_should_include_set_number'
    });
  }

  const failedCriteria = checks.filter(c => !c.passed);
  return { checks, failedCriteria, passed: failedCriteria.length === 0 };
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

// ─── Dispatching parallèle Vision GPT ────────────────────────────────────────

/**
 * Exécute des items en batches avec une concurrence limitée.
 * @param {Array}    items       — Éléments à traiter
 * @param {Function} fn         — Fonction async appelée sur chaque item
 * @param {number}   concurrency — Nombre max de traitements simultanés
 * @returns {Array} Résultats de Promise.allSettled
 */
async function processInBatches(items, fn, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Pre-pass Vision GPT en parallèle (max 3 simultanés).
 * Mute les rows directement : row.visionVerified, row.visionResult, etc.
 * Le budget est réservé de façon synchrone avant chaque appel async pour éviter
 * les dépassements dans les batches.
 *
 * @returns {{ visionErrors, visionRuns, visionBudgetSkips }}
 */
async function runVisionPass(candidates, budget, visionDisabledByOrch, outputDir, dailyBudget) {
  const VISION_CONCURRENCY = 3;
  let visionErrors      = 0;
  let visionRuns        = 0;
  let visionBudgetSkips = 0;

  const eligible = candidates.filter(row =>
    !visionDisabledByOrch &&
    row.imageUrl           &&
    row.ebayMatchImageUrl   &&
    row.matchedSales && row.matchedSales.length > 0 &&
    process.env.OPENAI_API_KEY
  );

  if (eligible.length === 0) {
    return { visionErrors, visionRuns, visionBudgetSkips };
  }

  const visionStart = Date.now();

  async function processVision(row) {
    // Vérification budget synchrone avant l'appel async
    const budgetCheck = shouldSkipVisionBudget(row, budget);

    if (budgetCheck.skip) {
      visionBudgetSkips++;
      row.visionSkippedBudget = true;
      row.visionSkipReason    = budgetCheck.reason;
      const profit = row.profit ? row.profit.profit.toFixed(2) : '0.00';
      if (budgetCheck.reason === 'profit_too_low') {
        console.log(`[Evaluator] Vision skip (profit ${profit}€ < ${config.visionMinProfitForCheck}€): "${row.title.slice(0, 50)}"`);
      } else {
        console.log(`[Evaluator] Vision skip (budget ${budget.estimatedCostCents}/${dailyBudget}¢): "${row.title.slice(0, 50)}"`);
      }
      return;
    }

    // Réserver le slot budget synchroniquement AVANT l'await
    // (évite dépassement dans les batches parallèles)
    visionRuns++;
    budget.callsToday++;
    budget.estimatedCostCents += (config.visionCostPerCallCents || 3);

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
      saveVisionBudget(outputDir, budget);

    } catch (visionErr) {
      // Rembourser le slot si l'appel échoue
      budget.callsToday--;
      budget.estimatedCostCents -= (config.visionCostPerCallCents || 3);
      visionRuns--;
      visionErrors++;
      // Ne pas bloquer l'item — il restera "candidate" pour retry au prochain scan
      console.log(`[Evaluator] Vision erreur: ${visionErr.message} → candidate (retry prochain scan)`);
      row.visionError = visionErr.message;
    }
  }

  await processInBatches(eligible, processVision, VISION_CONCURRENCY);

  const visionMs = Date.now() - visionStart;
  console.log(`[Evaluator] [vision] ${eligible.length} vérification(s) en ${visionMs}ms (parallèle x${VISION_CONCURRENCY})`);

  return { visionErrors, visionRuns, visionBudgetSkips };
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

  // ─── Sprint Contract (Pattern 1) ──────────────────────────────────────────
  const sprintContract = loadSprintContract(outputDir);
  if (sprintContract) {
    console.log(`[Evaluator] Sprint contract: ${sprintContract.sprintId} (${(sprintContract.queryAdjustments || []).length} ajustements)`);
  }

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
  const confidenceScores = [];

  // ─── Pre-pass Vision GPT en parallèle ─────────────────────────────────────
  const { visionErrors, visionRuns, visionBudgetSkips } = await runVisionPass(
    candidates, budget, visionDisabledByOrch, outputDir, dailyBudget
  );

  for (const row of candidates) {
    try {
      // Vision déjà traitée par le pre-pass — log si skip pour raison technique
      if (!visionDisabledByOrch && row.imageUrl && !row.ebayMatchImageUrl) {
        console.log(`[Evaluator] ⏭ Vision impossible: "${row.title.slice(0, 50)}" — pas d'image eBay → candidate`);
      }

      // ─── Scoring ────────────────────────────────────────────────────────────
      // computeConfidence lit row.visionVerified, row.visionResult ET row.visionSkippedBudget
      // (scoring.js utilise des seuils pHash assouplis si visionSkippedBudget = true)
      row.confidence = computeConfidence(row);
      row.liquidity  = computeLiquidity(row);
      confidenceScores.push(row.confidence);

      // ─── Seuils par search config ─────────────────────────────────────────
      const search     = config.searches ? config.searches.find(s => s.name === row.search) : null;
      const minProfEur = Math.max(5,  search && search.minProfitEur     != null ? search.minProfitEur     : config.minProfitEur);
      const minProfPct = Math.max(20, search && search.minProfitPercent != null ? search.minProfitPercent : config.minProfitPercent);
      const src        = row.pricingSource || 'unknown';
      const minLiq     = src === 'local-database' ? 25 : 40;

      // ─── Pattern 5 : Seuils durs par critère ─────────────────────────────
      const { checks, failedCriteria, passed } = evaluateCriteria(
        row, sprintContract, minConfidence, minProfEur, minProfPct, minLiq
      );

      // Stocker le détail des critères sur la row (pour le dashboard)
      row.criteriaChecks = checks.map(c => ({
        key:      c.key,
        label:    c.label,
        passed:   c.passed,
        value:    typeof c.value === 'number' ? parseFloat(c.value.toFixed(2)) : c.value,
        threshold: c.threshold
      }));

      if (!passed) {
        const reasons = failedCriteria.map(c => {
          if (typeof c.value === 'number') {
            return `${c.label}: ${c.value.toFixed ? c.value.toFixed(2) : c.value} < ${c.threshold}`;
          }
          return `${c.label} non satisfait`;
        });

        console.log(`  [rejeté] ${row.title.slice(0, 50)}: ${reasons.join(', ')}`);
        row.rejectionReasons = reasons;
        rejected.push(row);

        // ─── Pattern 2 : Feedback actionnable pour le Scanner ────────────
        for (const fc of failedCriteria) {
          if (!fc.suggestion) continue;
          const ebayTitle = (row.matchedSales && row.matchedSales[0] && row.matchedSales[0].title) || '';
          writeEvaluatorFeedback(outputDir, {
            timestamp:   new Date().toISOString(),
            itemKey:     row.id || row.url || row.title,
            category:    (row.category || row.search || '').toUpperCase(),
            reason:      fc.reason,
            detail:      `"${(row.title || '').slice(0, 60)}" matché avec "${ebayTitle.slice(0, 60)}" — ${fc.label}`,
            suggestion:  fc.suggestion,
            vintedTitle: row.title || '',
            ebayTitle:   ebayTitle
          });
        }

        if (row.id) {
          seenListings.markAsSeen(row.id, row.search, row.title, 'no-match',
            row.profit ? row.profit.profit : null);
        }
      } else {
        // ─── GARDIEN FINAL : Vision GPT obligatoire ──────────────────────────
        if (row.visionSameCard === true) {
          // ✅ Vision a confirmé → l'item est actif et visible
          row.status = 'active';
          opportunities.push(row);
          console.log(`  [actif ✅] ${row.title} -> ${row.profit.profit.toFixed(2)} EUR (confiance ${row.confidence}/100, Vision OK)`);

          // Feedback positif pour la boucle d'auto-amélioration Scanner
          const ebayTitleAcc   = (row.matchedSales && row.matchedSales[0] && row.matchedSales[0].title) || '';
          const visionRptAcc   = (row.visionResult && row.visionResult.report) || null;
          writeEvaluatorFeedback(outputDir, {
            timestamp:            new Date().toISOString(),
            itemKey:              row.id || row.url || row.title,
            category:             (row.category || row.search || '').toUpperCase(),
            reason:               'vision_accepted',
            detail:               `"${(row.title || '').slice(0, 60)}" vs "${ebayTitleAcc.slice(0, 60)}" — CONFIRMÉ`,
            suggestion:           (visionRptAcc && visionRptAcc.suggestion) || null,
            vintedTitle:          row.title || '',
            ebayTitle:            ebayTitleAcc,
            vintedObservation:    (visionRptAcc && visionRptAcc.vintedObservation)    || null,
            referenceObservation: (visionRptAcc && visionRptAcc.referenceObservation) || null,
            differences:          (visionRptAcc && visionRptAcc.differences)          || [],
            imageUrls:            { vinted: row.imageUrl || null, ebay: row.ebayMatchImageUrl || null }
          });

          sendOpportunityAlert(row).catch(() => {});

          if (row.id) {
            seenListings.markAsSeen(row.id, row.search, row.title, 'opportunity',
              row.profit ? row.profit.profit : null);
          }

        } else if (row.visionSameCard === false) {
          // ❌ Vision a rejeté → traité comme un rejet définitif
          row.status = 'vision_rejected';
          const visionSummary = (row.visionResult && row.visionResult.summary) || 'produits différents';
          console.log(`  [rejeté Vision ❌] ${row.title.slice(0, 50)}: ${visionSummary}`);

          // Feedback détaillé pour la boucle d'auto-amélioration Scanner
          const ebayTitleVr   = (row.matchedSales && row.matchedSales[0] && row.matchedSales[0].title) || '';
          const visionRptVr   = (row.visionResult && row.visionResult.report) || null;
          writeEvaluatorFeedback(outputDir, {
            timestamp:            new Date().toISOString(),
            itemKey:              row.id || row.url || row.title,
            category:             (row.category || row.search || '').toUpperCase(),
            reason:               'vision_rejected',
            detail:               `"${(row.title || '').slice(0, 60)}" vs "${ebayTitleVr.slice(0, 60)}" — ${visionSummary}`,
            suggestion:           (visionRptVr && visionRptVr.suggestion) || 'review_images_and_matching',
            vintedTitle:          row.title || '',
            ebayTitle:            ebayTitleVr,
            vintedObservation:    (visionRptVr && visionRptVr.vintedObservation)    || null,
            referenceObservation: (visionRptVr && visionRptVr.referenceObservation) || null,
            differences:          (visionRptVr && visionRptVr.differences)          || [],
            imageUrls:            { vinted: row.imageUrl || null, ebay: row.ebayMatchImageUrl || null }
          });

          rejected.push(row);
          if (row.id) {
            seenListings.markAsSeen(row.id, row.search, row.title, 'no-match',
              row.profit ? row.profit.profit : null);
          }

        } else {
          // ⏳ Vision n'a pas tourné (pas d'image eBay, budget dépassé, erreur API)
          // → l'item reste "candidate" et sera re-vérifié au prochain scan
          const noVisionReason = row.visionError
            ? `erreur API (${row.visionError.slice(0, 40)})`
            : row.visionSkippedBudget
              ? `budget dépassé (${row.visionSkipReason})`
              : 'pas d\'image eBay';
          console.log(`  [candidat ⏳] ${row.title.slice(0, 50)}: Vision non exécutée (${noVisionReason}) → retry prochain scan`);
          row.status = 'candidate';
          pendingReview.push(row);
          // Ne PAS marquer comme "seen" → sera retentée au prochain scan
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

  console.log(`[Evaluator] Terminé: ${opportunities.length} actifs ✅ / ${pendingReview.length} candidats ⏳ / ${rejected.length} rejetés ❌ sur ${candidates.length} évalués (${durationMs}ms)`);
  console.log(`[Evaluator] Vision: ${visionRuns} appels, ${visionErrors} erreurs, ${visionBudgetSkips} skips budget — coût: ${budget.estimatedCostCents}¢/${dailyBudget}¢`);

  // ─── Message Bus : transmettre les opportunités validées au Notifier ───────
  if (opportunities.length > 0) {
    messageBus.publish('evaluator', 'notifier', 'opportunities', {
      evaluatedAt:  new Date().toISOString(),
      count:        opportunities.length,
      opportunities
    });
  }

  return { opportunities, pendingReview, rejected, allEvaluated, health };
}

module.exports = { run, getActiveDecisions, loadVisionBudget };
