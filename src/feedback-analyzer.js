/**
 * Feedback Analyzer — Analyse les feedbacks accumulés, identifie les patterns,
 * applique des ajustements conservateurs et génère un rapport Telegram.
 *
 * Sources analysées :
 *   - output/feedback-log.json      (décisions accept/reject avec raisons)
 *   - output/opportunities-history.json  (historique complet des opportunités)
 *
 * Sorties :
 *   - output/auto-adjustments.json       (état courant des overrides actifs)
 *   - output/auto-adjustments-log.json   (historique immuable des ajustements)
 *   - output/last-analysis-report.json   (dernier rapport généré)
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const FEEDBACK_LOG_PATH    = path.join(OUTPUT_DIR, 'feedback-log.json');
const HISTORY_PATH         = path.join(OUTPUT_DIR, 'opportunities-history.json');
const ADJUSTMENTS_PATH     = path.join(OUTPUT_DIR, 'auto-adjustments.json');
const ADJUSTMENTS_LOG_PATH = path.join(OUTPUT_DIR, 'auto-adjustments-log.json');
const REPORT_PATH          = path.join(OUTPUT_DIR, 'last-analysis-report.json');
const GPT_ANALYSIS_PATH    = path.join(OUTPUT_DIR, 'gpt-analysis.json');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Seuils conservateurs
const MIN_DECISIONS_FOR_DISABLE = 20;   // Au moins 20 décisions avant de désactiver
const MIN_DECISIONS_FOR_ADJUST  = 5;    // Au moins 5 pour ajuster les params
const DISABLE_THRESHOLD_PERCENT = 5;    // <= 5% acceptation → catégorie problématique
const PROBLEMATIC_THRESHOLD     = 10;   // <= 10% → flaguer comme problème

// ─── Helpers fichiers ──────────────────────────────────────────────────────────

function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (raw && raw.trim()) return JSON.parse(raw);
    }
  } catch { /* ignore */ }
  return null;
}

function writeJsonSafe(filePath, data) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function loadFeedbackLog() {
  const data = readJsonSafe(FEEDBACK_LOG_PATH);
  if (!data) return [];
  return Array.isArray(data) ? data : [];
}

function loadHistory() {
  const data = readJsonSafe(HISTORY_PATH);
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.opportunities)) return data.opportunities;
  return [];
}

function loadAdjustments() {
  return readJsonSafe(ADJUSTMENTS_PATH) || {
    disabledCategories: [],
    minObservations: null,  // null = pas de surcharge (défaut: 1 dans scoring)
    variantWeightBoost: 0,
    appliedAt: null
  };
}

function loadAdjustmentsLog() {
  return readJsonSafe(ADJUSTMENTS_LOG_PATH) || [];
}

// ─── Classification des raisons de rejet ──────────────────────────────────────

const REJECT_PATTERNS = [
  {
    key: 'different_variant',
    labels: ['different variant', 'variante différente', 'variante differente', 'variant different', 'wrong variant', 'mauvaise variante', 'variant', 'edition differente', 'édition différente'],
    display: 'Variante différente'
  },
  {
    key: 'different_product',
    labels: ['different product', 'produit différent', 'produit different', 'wrong product', 'mauvais produit', 'not the same', 'pas le même', 'wrong card', 'mauvaise carte'],
    display: 'Produit complètement différent'
  },
  {
    key: 'price_unreliable',
    labels: ['price unreliable', 'prix non vérifiable', 'prix non verifiable', 'prix douteux', 'unreliable price', 'prix incorrect', 'wrong price', 'mauvais prix'],
    display: 'Prix non vérifiable'
  },
  {
    key: 'condition_mismatch',
    labels: ['condition', 'état', 'etat', 'damaged', 'abîmé', 'graded', 'PSA', 'BGS', 'CGC'],
    display: 'Condition non comparable'
  },
  {
    key: 'too_expensive',
    labels: ['trop cher', 'too expensive', 'profit trop faible', 'marge insuffisante', 'no profit'],
    display: 'Profit insuffisant'
  }
];

function classifyReason(reason) {
  if (!reason) return 'other';
  const lower = String(reason).toLowerCase();
  for (const p of REJECT_PATTERNS) {
    if (p.labels.some(l => lower.includes(l))) return p.key;
  }
  return 'other';
}

function getRejectionLabel(key) {
  const found = REJECT_PATTERNS.find(p => p.key === key);
  return found ? found.display : 'Autre raison';
}

// ─── Analyse principale ────────────────────────────────────────────────────────

function analyzePatterns() {
  const feedbackLog = loadFeedbackLog();
  const history     = loadHistory();

  // Indexer history par ID pour lookup rapide
  const historyById = new Map();
  for (const h of history) {
    if (h.id) historyById.set(h.id, h);
  }

  // Enrichir chaque entrée feedback avec la catégorie (search) depuis history
  const enrichedFeedback = feedbackLog.map(entry => {
    const opp = historyById.get(entry.id);
    return {
      ...entry,
      search: (opp && opp.search) || entry.search || null
    };
  });

  // ── A) Taux de succès par catégorie ──────────────────────────────────────
  // On analyse aussi l'historique directement (status accepted/rejected)
  const catStats = new Map();

  // Depuis feedback-log (décisions manuelles/GPT)
  for (const e of enrichedFeedback) {
    const cat = e.search || 'unknown';
    if (!catStats.has(cat)) catStats.set(cat, { accepted: 0, rejected: 0, reasons: [] });
    const s = catStats.get(cat);
    if (e.decision === 'accepted') s.accepted++;
    else if (e.decision === 'rejected') {
      s.rejected++;
      if (e.reason) s.reasons.push(classifyReason(e.reason));
    }
  }

  // Compléter avec history (status accepted/rejected non encore dans feedback-log)
  for (const h of history) {
    if (h.status !== 'accepted' && h.status !== 'rejected') continue;
    const cat = h.search || 'unknown';
    // Chercher si déjà dans feedback-log pour cet ID
    const alreadyCounted = enrichedFeedback.some(e => e.id === h.id);
    if (!alreadyCounted) {
      if (!catStats.has(cat)) catStats.set(cat, { accepted: 0, rejected: 0, reasons: [] });
      const s = catStats.get(cat);
      if (h.status === 'accepted') s.accepted++;
      else s.rejected++;
    }
  }

  const categoryAnalysis = [];
  for (const [cat, s] of catStats.entries()) {
    const total = s.accepted + s.rejected;
    if (total === 0) continue;
    const acceptRate = Math.round((s.accepted / total) * 100);
    const problematic = total >= 5 && acceptRate <= PROBLEMATIC_THRESHOLD;
    const disableCandidate = total >= MIN_DECISIONS_FOR_DISABLE && acceptRate <= DISABLE_THRESHOLD_PERCENT;
    categoryAnalysis.push({ cat, accepted: s.accepted, rejected: s.rejected, total, acceptRate, problematic, disableCandidate, reasons: s.reasons });
  }
  categoryAnalysis.sort((a, b) => b.acceptRate - a.acceptRate);

  // ── B) Raisons de rejet les plus fréquentes ──────────────────────────────
  const allReasons = [];
  for (const e of enrichedFeedback) {
    if (e.decision === 'rejected' && e.reason) allReasons.push(classifyReason(e.reason));
  }
  // Ajouter raisons GPT (depuis visionResult dans history)
  for (const h of history) {
    if (h.status === 'rejected' || (h.visionSameCard === false)) {
      allReasons.push('different_variant');
    }
  }

  const reasonCounts = {};
  for (const r of allReasons) {
    reasonCounts[r] = (reasonCounts[r] || 0) + 1;
  }
  const totalRejections = allReasons.length;
  const topReasons = Object.entries(reasonCounts)
    .map(([key, count]) => ({
      key,
      label: getRejectionLabel(key),
      count,
      percent: totalRejections > 0 ? Math.round((count / totalRejections) * 100) : 0
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // ── Stats globales ────────────────────────────────────────────────────────
  const totalFeedback = enrichedFeedback.length;
  const totalAccepted = enrichedFeedback.filter(e => e.decision === 'accepted').length;
  const totalRejected = enrichedFeedback.filter(e => e.decision === 'rejected').length;
  const globalAcceptRate = totalFeedback > 0 ? Math.round((totalAccepted / totalFeedback) * 100) : 0;

  // Analyse 7 derniers jours
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentFeedback = enrichedFeedback.filter(e => e.timestamp && new Date(e.timestamp).getTime() >= sevenDaysAgo);
  const recentTotal    = recentFeedback.length;
  const recentAccepted = recentFeedback.filter(e => e.decision === 'accepted').length;

  return {
    totalFeedback,
    totalAccepted,
    totalRejected,
    globalAcceptRate,
    recentTotal,
    recentAccepted,
    categoryAnalysis,
    topReasons,
    reasonCounts,
    totalRejections
  };
}

// ─── Ajustements automatiques (conservateurs) ────────────────────────────────

function computeAdjustments(analysis) {
  const currentAdjustments = loadAdjustments();
  const adjustmentsToApply = [];

  // 1. Désactiver les catégories à 0% sur 20+ décisions
  const toDisable = analysis.categoryAnalysis.filter(c => c.disableCandidate);
  const alreadyDisabled = new Set(currentAdjustments.disabledCategories || []);
  const newlyDisabled = [];

  for (const cat of toDisable) {
    if (!alreadyDisabled.has(cat.cat)) {
      newlyDisabled.push(cat.cat);
      adjustmentsToApply.push({
        type: 'disable_category',
        category: cat.cat,
        reason: `${cat.acceptRate}% acceptation sur ${cat.total} décisions (seuil: ${DISABLE_THRESHOLD_PERCENT}%)`,
        reversible: true
      });
    }
  }

  // 2. Augmenter le seuil min d'observations si rejets "prix non vérifiable" dominants
  const priceReliabilityRejections = analysis.reasonCounts['price_unreliable'] || 0;
  const currentMinObs = currentAdjustments.minObservations || 1;
  if (analysis.totalRejections >= MIN_DECISIONS_FOR_ADJUST &&
      priceReliabilityRejections / Math.max(1, analysis.totalRejections) > 0.3 &&
      currentMinObs < 3) {
    const newMinObs = Math.min(currentMinObs + 1, 3); // Max 3, conservateur
    adjustmentsToApply.push({
      type: 'increase_min_observations',
      from: currentMinObs,
      to: newMinObs,
      reason: `${analysis.reasonCounts['price_unreliable']}/${analysis.totalRejections} rejets pour prix non vérifiable (>${30}%)`,
      reversible: true
    });
  }

  // 3. Boost poids matching variante si rejets "variante différente" dominants
  const variantRejections = analysis.reasonCounts['different_variant'] || 0;
  const currentVarBoost = currentAdjustments.variantWeightBoost || 0;
  if (analysis.totalRejections >= MIN_DECISIONS_FOR_ADJUST &&
      variantRejections / Math.max(1, analysis.totalRejections) > 0.4 &&
      currentVarBoost < 20) {
    const newBoost = Math.min(currentVarBoost + 10, 20); // Max +20 pts, par palier de 10
    adjustmentsToApply.push({
      type: 'boost_variant_weight',
      from: currentVarBoost,
      to: newBoost,
      reason: `${variantRejections}/${analysis.totalRejections} rejets pour variante différente (>${40}%)`,
      reversible: true
    });
  }

  return { adjustmentsToApply, newlyDisabled };
}

// ─── Application des ajustements ──────────────────────────────────────────────

function applyAdjustments(adjustmentsToApply, newlyDisabled, analysis) {
  if (adjustmentsToApply.length === 0) return { applied: [], adjustments: loadAdjustments() };

  const currentAdjustments = loadAdjustments();
  const appliedLog = [];

  for (const adj of adjustmentsToApply) {
    if (adj.type === 'disable_category') {
      if (!currentAdjustments.disabledCategories) currentAdjustments.disabledCategories = [];
      if (!currentAdjustments.disabledCategories.includes(adj.category)) {
        currentAdjustments.disabledCategories.push(adj.category);
        appliedLog.push(adj);
        console.log(`[feedback-analyzer] 🚫 Catégorie désactivée: ${adj.category} (${adj.reason})`);
      }
    } else if (adj.type === 'increase_min_observations') {
      currentAdjustments.minObservations = adj.to;
      appliedLog.push(adj);
      console.log(`[feedback-analyzer] 📊 Min observations: ${adj.from} → ${adj.to} (${adj.reason})`);
    } else if (adj.type === 'boost_variant_weight') {
      currentAdjustments.variantWeightBoost = adj.to;
      appliedLog.push(adj);
      console.log(`[feedback-analyzer] 🎯 Boost variante: +${adj.from} → +${adj.to} pts (${adj.reason})`);
    }
  }

  currentAdjustments.appliedAt = new Date().toISOString();
  writeJsonSafe(ADJUSTMENTS_PATH, currentAdjustments);

  // Ajouter à l'historique
  if (appliedLog.length > 0) {
    const log = loadAdjustmentsLog();
    log.push({
      appliedAt: new Date().toISOString(),
      adjustments: appliedLog,
      analysisSnapshot: {
        totalFeedback: analysis.totalFeedback,
        globalAcceptRate: analysis.globalAcceptRate
      }
    });
    // Garder 100 entrées max
    writeJsonSafe(ADJUSTMENTS_LOG_PATH, log.length > 100 ? log.slice(-100) : log);
  }

  return { applied: appliedLog, adjustments: currentAdjustments };
}

// ─── Génération du rapport texte ──────────────────────────────────────────────

function generateReport(analysis, applied, adjustments, date) {
  const dateStr = date ? new Date(date).toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : new Date().toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const lines = [];

  lines.push(`📊 RAPPORT AUTO-AMÉLIORATION — ${dateStr}`);
  lines.push('');

  // Stats globales
  lines.push('📈 Stats globales :');
  if (analysis.recentTotal > 0) {
    lines.push(`- ${analysis.recentTotal} opportunités analysées (7 jours)`);
    lines.push(`- ${analysis.recentAccepted} acceptées (${analysis.recentTotal > 0 ? Math.round(analysis.recentAccepted / analysis.recentTotal * 100) : 0}%), ${analysis.recentTotal - analysis.recentAccepted} rejetées`);
  } else {
    lines.push(`- ${analysis.totalFeedback} décisions au total`);
    lines.push(`- ${analysis.totalAccepted} acceptées (${analysis.globalAcceptRate}%), ${analysis.totalRejected} rejetées`);
  }
  lines.push('');

  // Meilleures catégories
  const goodCats = analysis.categoryAnalysis.filter(c => c.total >= 2 && c.acceptRate > PROBLEMATIC_THRESHOLD);
  if (goodCats.length > 0) {
    lines.push('🏆 Meilleures catégories :');
    for (const c of goodCats.slice(0, 3)) {
      lines.push(`- ${c.cat} : ${c.accepted}/${c.total} acceptées (${c.acceptRate}%)`);
    }
    lines.push('');
  }

  // Catégories problématiques
  const problemCats = analysis.categoryAnalysis.filter(c => c.problematic);
  if (problemCats.length > 0) {
    lines.push('⚠️ Catégories problématiques :');
    for (const c of problemCats) {
      const disabled = (adjustments.disabledCategories || []).includes(c.cat);
      const suffix = disabled ? ' → DÉSACTIVÉE' : (c.disableCandidate ? ' → CANDIDATE DÉSACTIVATION' : '');
      lines.push(`- ${c.cat} : ${c.accepted}/${c.total} acceptées (${c.acceptRate}%)${suffix}`);
    }
    lines.push('');
  }

  // Top raisons de rejet
  if (analysis.topReasons.length > 0) {
    lines.push('🔍 Top raisons de rejet :');
    analysis.topReasons.slice(0, 3).forEach((r, i) => {
      lines.push(`${i + 1}. ${r.label} (${r.percent}%)`);
    });
    lines.push('');
  }

  // Ajustements appliqués
  if (applied.length > 0) {
    lines.push('🔧 Ajustements appliqués :');
    for (const adj of applied) {
      if (adj.type === 'disable_category') {
        lines.push(`- ${adj.category} désactivé (${adj.reason})`);
      } else if (adj.type === 'increase_min_observations') {
        lines.push(`- Seuil min observations augmenté de ${adj.from} → ${adj.to}`);
      } else if (adj.type === 'boost_variant_weight') {
        lines.push(`- Poids matching variante +${adj.to} points`);
      }
    }
    lines.push('');
  } else {
    lines.push('✅ Aucun ajustement nécessaire');
    lines.push('');
  }

  // Catégories actuellement désactivées
  const disabled = adjustments.disabledCategories || [];
  if (disabled.length > 0) {
    lines.push(`🚫 Catégories désactivées (${disabled.length}) : ${disabled.join(', ')}`);
    lines.push('');
  }

  // Suggestions
  const suggestions = buildSuggestions(analysis, adjustments);
  if (suggestions.length > 0) {
    lines.push('💡 Suggestions :');
    for (const s of suggestions) lines.push(`- ${s}`);
  }

  return lines.join('\n').trim();
}

function buildSuggestions(analysis, adjustments) {
  const suggestions = [];

  // Suggestion si variant different dominant
  if (analysis.reasonCounts['different_variant'] > 0) {
    const pct = Math.round((analysis.reasonCounts['different_variant'] / Math.max(1, analysis.totalRejections)) * 100);
    if (pct > 30) {
      suggestions.push(`${pct}% de rejets pour variante — affiner les queries eBay avec numéro de set/carte`);
    }
  }

  // Suggestion si prix non fiable
  if (analysis.reasonCounts['price_unreliable'] > 0) {
    const pct = Math.round((analysis.reasonCounts['price_unreliable'] / Math.max(1, analysis.totalRejections)) * 100);
    if (pct > 20) {
      suggestions.push(`${pct}% de rejets pour prix — ajouter des sources de prix complémentaires`);
    }
  }

  // Suggestion si catégories désactivées
  if ((adjustments.disabledCategories || []).length > 0) {
    suggestions.push(`Catégories désactivées réactivables dans output/auto-adjustments.json`);
  }

  // Suggestion si taux global très faible
  if (analysis.globalAcceptRate < 10 && analysis.totalFeedback >= 10) {
    suggestions.push(`Taux global ${analysis.globalAcceptRate}% — réviser les seuils de confiance minimum`);
  }

  return suggestions;
}

// ─── Analyse GPT-4o-mini ──────────────────────────────────────────────────────

async function callGptAnalysis(analysis, enrichedFeedback, historyById) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[feedback-analyzer] OPENAI_API_KEY manquante, analyse GPT ignorée');
    return null;
  }

  let OpenAI;
  try { OpenAI = require('openai'); } catch {
    console.warn('[feedback-analyzer] Module openai non disponible');
    return null;
  }

  const client = new OpenAI({ apiKey });

  // 20 derniers rejets avec détails
  const rejects = enrichedFeedback
    .filter(e => e.decision === 'rejected')
    .slice(-20)
    .map(e => {
      const opp = historyById.get(e.id);
      return {
        titre: (opp && opp.title) || '?',
        catégorie: e.search || '?',
        raison: e.reason || '?',
        source: (opp && opp.source) || '?',
        prix: (opp && opp.price) != null ? `${opp.price}€` : '?',
        date: e.timestamp ? new Date(e.timestamp).toLocaleDateString('fr-BE') : '?'
      };
    });

  // 10 dernières acceptations
  const accepts = enrichedFeedback
    .filter(e => e.decision === 'accepted')
    .slice(-10)
    .map(e => {
      const opp = historyById.get(e.id);
      return {
        titre: (opp && opp.title) || '?',
        catégorie: e.search || '?',
        source: (opp && opp.source) || '?',
        prix: (opp && opp.price) != null ? `${opp.price}€` : '?'
      };
    });

  // Stats catégories
  const catStats = analysis.categoryAnalysis.map(c => ({
    catégorie: c.cat,
    acceptées: c.accepted,
    rejetées: c.rejected,
    tauxAccept: `${c.acceptRate}%`,
    problématique: c.problematic
  }));

  // Paramètres actuels
  const adj = loadAdjustments();
  const currentParams = {
    categoriesDésactivées: adj.disabledCategories || [],
    minObservations: adj.minObservations || 1,
    boostVariante: adj.variantWeightBoost || 0,
    seuilConfiance: 50,
    scoring: 'Tier1(matching 0-40) + Tier2(source 0-20) + Tier3(GPT vision 0-40)'
  };

  const prompt = `Tu es un expert en arbitrage e-commerce (Vinted→eBay, cartes TCG, LEGO, sport cards).

Analyse ces feedbacks de notre bot de détection d'opportunités.

[20 DERNIERS REJETS]
${JSON.stringify(rejects, null, 2)}

[10 DERNIÈRES ACCEPTATIONS]
${JSON.stringify(accepts, null, 2)}

[STATS PAR CATÉGORIE]
${JSON.stringify(catStats, null, 2)}

[PARAMÈTRES ACTUELS DU SCORING]
${JSON.stringify(currentParams, null, 2)}

Réponds UNIQUEMENT avec du JSON valide (pas de markdown, pas de backticks), avec cette structure exacte :
{
  "healthScore": <entier 0-10>,
  "analysis": "<texte en français, 200-350 mots, concret et actionnable : patterns de rejet, catégories à ajuster, suggestions matching>",
  "topPatterns": ["<pattern rejet 1>", "<pattern rejet 2>", "<pattern rejet 3>"],
  "prioritiesThisWeek": ["<action 1>", "<action 2>", "<action 3>"],
  "actions": []
}

Pour le champ "actions", inclus UNIQUEMENT les ajustements dont tu es sûr à plus de 80%, parmi :
- { "type": "disable_category", "category": "<nom exact>", "reason": "<raison courte>" }
- { "type": "enable_category", "category": "<nom exact>", "reason": "<raison courte>" }
- { "type": "increase_min_observations", "value": <2 ou 3>, "reason": "<raison courte>" }
- { "type": "boost_variant_weight", "value": <10 ou 20>, "reason": "<raison courte>" }

Si pas assez de données pour une action, laisse "actions" vide.`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 1200,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = (response.choices?.[0]?.message?.content || '').trim();
    let parsed;
    try {
      const cleaned = raw.replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { analysis: raw, healthScore: null, actions: [], topPatterns: [], prioritiesThisWeek: [] };
    }

    const result = { ...parsed, generatedAt: new Date().toISOString(), model: 'gpt-4o-mini' };
    writeJsonSafe(GPT_ANALYSIS_PATH, result);
    console.log('[feedback-analyzer] ✅ Analyse GPT sauvegardée (score santé: ' + result.healthScore + '/10)');
    return result;
  } catch (err) {
    console.error(`[feedback-analyzer] Erreur GPT: ${err.message}`);
    return null;
  }
}

// ─── Application des actions suggérées par GPT ────────────────────────────────

function applyGptActions(actions, analysis) {
  if (!Array.isArray(actions) || actions.length === 0) return;

  const currentAdjustments = loadAdjustments();
  const appliedLog = [];
  let changed = false;

  for (const action of actions) {
    try {
      if (action.type === 'disable_category' && action.category) {
        if (!currentAdjustments.disabledCategories) currentAdjustments.disabledCategories = [];
        if (!currentAdjustments.disabledCategories.includes(action.category)) {
          currentAdjustments.disabledCategories.push(action.category);
          appliedLog.push({ ...action, source: 'gpt', appliedAt: new Date().toISOString() });
          changed = true;
          console.log(`[feedback-analyzer] 🤖 GPT désactive: ${action.category} — ${action.reason}`);
        }
      } else if (action.type === 'enable_category' && action.category) {
        if (currentAdjustments.disabledCategories) {
          const idx = currentAdjustments.disabledCategories.indexOf(action.category);
          if (idx !== -1) {
            currentAdjustments.disabledCategories.splice(idx, 1);
            appliedLog.push({ ...action, source: 'gpt', appliedAt: new Date().toISOString() });
            changed = true;
            console.log(`[feedback-analyzer] 🤖 GPT réactive: ${action.category} — ${action.reason}`);
          }
        }
      } else if (action.type === 'increase_min_observations' && action.value) {
        const newVal = Math.min(Math.max(1, Number(action.value)), 5);
        if (newVal !== (currentAdjustments.minObservations || 1)) {
          currentAdjustments.minObservations = newVal;
          appliedLog.push({ ...action, source: 'gpt', appliedAt: new Date().toISOString() });
          changed = true;
          console.log(`[feedback-analyzer] 🤖 GPT minObservations → ${newVal}`);
        }
      } else if (action.type === 'boost_variant_weight' && action.value !== undefined) {
        const newVal = Math.min(Math.max(0, Number(action.value)), 30);
        if (newVal !== (currentAdjustments.variantWeightBoost || 0)) {
          currentAdjustments.variantWeightBoost = newVal;
          appliedLog.push({ ...action, source: 'gpt', appliedAt: new Date().toISOString() });
          changed = true;
          console.log(`[feedback-analyzer] 🤖 GPT variantBoost → ${newVal}`);
        }
      }
    } catch (e) {
      console.warn(`[feedback-analyzer] GPT action ignorée (${action.type}): ${e.message}`);
    }
  }

  if (changed) {
    currentAdjustments.appliedAt = new Date().toISOString();
    writeJsonSafe(ADJUSTMENTS_PATH, currentAdjustments);
    const log = loadAdjustmentsLog();
    log.push({
      appliedAt: new Date().toISOString(),
      source: 'gpt',
      adjustments: appliedLog,
      analysisSnapshot: { totalFeedback: analysis.totalFeedback, globalAcceptRate: analysis.globalAcceptRate }
    });
    writeJsonSafe(ADJUSTMENTS_LOG_PATH, log.length > 100 ? log.slice(-100) : log);
  }
}

// ─── Envoi Telegram ──────────────────────────────────────────────────────────

async function sendReportToTelegram(reportText) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: reportText,
        disable_web_page_preview: true
      })
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`[feedback-analyzer] Telegram error ${response.status}: ${body}`);
    }
  } catch (err) {
    console.error(`[feedback-analyzer] Telegram error: ${err.message}`);
  }
}

// ─── Point d'entrée principal ─────────────────────────────────────────────────

async function runAnalysis({ sendTelegram = true, forceGpt = false } = {}) {
  console.log('[feedback-analyzer] Démarrage de l\'analyse...');

  try {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // 1. Analyser les patterns
    const analysis = analyzePatterns();
    console.log(`[feedback-analyzer] ${analysis.totalFeedback} feedbacks analysés, ${analysis.categoryAnalysis.length} catégories`);

    // 2. Calculer les ajustements statistiques
    const { adjustmentsToApply, newlyDisabled } = computeAdjustments(analysis);

    // 3. Appliquer les ajustements statistiques
    const { applied, adjustments } = applyAdjustments(adjustmentsToApply, newlyDisabled, analysis);

    // 4. Analyse GPT (1x/jour ou si forcée)
    let gptAnalysis = readJsonSafe(GPT_ANALYSIS_PATH);
    const lastGptAt = gptAnalysis && gptAnalysis.generatedAt ? new Date(gptAnalysis.generatedAt).getTime() : 0;
    const shouldRunGpt = forceGpt || (Date.now() - lastGptAt > ONE_DAY_MS);

    if (shouldRunGpt && analysis.totalFeedback >= 3) {
      console.log('[feedback-analyzer] Lancement analyse GPT...');
      const feedbackLog = loadFeedbackLog();
      const history = loadHistory();
      const historyById = new Map();
      for (const h of history) { if (h.id) historyById.set(h.id, h); }
      const enrichedFeedback = feedbackLog.map(entry => {
        const opp = historyById.get(entry.id);
        return { ...entry, search: (opp && opp.search) || entry.search || null };
      });
      gptAnalysis = await callGptAnalysis(analysis, enrichedFeedback, historyById);
      // Appliquer les actions suggérées par GPT
      if (gptAnalysis && gptAnalysis.actions && gptAnalysis.actions.length > 0) {
        applyGptActions(gptAnalysis.actions, analysis);
      }
    } else if (!shouldRunGpt) {
      console.log('[feedback-analyzer] Analyse GPT récente, réutilisation du cache');
    }

    // 5. Générer le rapport texte
    const reportText = generateReport(analysis, applied, adjustments, new Date().toISOString());
    const reportData = {
      generatedAt: new Date().toISOString(),
      reportText,
      analysis,
      applied,
      adjustments,
      gptAnalysis: gptAnalysis || null,
      gptAnalysisDate: gptAnalysis && gptAnalysis.generatedAt ? gptAnalysis.generatedAt : null
    };

    writeJsonSafe(REPORT_PATH, reportData);
    console.log('[feedback-analyzer] Rapport sauvegardé');

    // 6. Envoyer sur Telegram si des changements ou si planifié
    const hasChanges = applied.length > 0;
    const hasSignificantInsights = analysis.totalFeedback >= 5;

    if (sendTelegram && (hasChanges || hasSignificantInsights)) {
      let telegramText = reportText;
      if (gptAnalysis && gptAnalysis.healthScore != null) {
        telegramText += `\n\n🤖 Score de santé GPT : ${gptAnalysis.healthScore}/10`;
      }
      await sendReportToTelegram(telegramText);
      console.log('[feedback-analyzer] Rapport envoyé sur Telegram');
    }

    return reportData;
  } catch (err) {
    console.error(`[feedback-analyzer] Erreur: ${err.message}`);
    throw err;
  }
}

// ─── Getters pour server.js / index.js ───────────────────────────────────────

/**
 * Retourne les catégories désactivées par l'analyseur.
 * Utilisé par index.js pour filtrer les searches avant chaque scan.
 * @returns {string[]} Liste des noms de catégories désactivées
 */
function getDisabledCategories() {
  const adj = loadAdjustments();
  return adj.disabledCategories || [];
}

/**
 * Retourne les paramètres de scoring ajustés.
 * @returns {{ minObservations: number, variantWeightBoost: number }}
 */
function getAdjustedParams() {
  const adj = loadAdjustments();
  return {
    minObservations:    adj.minObservations    || 1,
    variantWeightBoost: adj.variantWeightBoost || 0
  };
}

/**
 * Retourne le dernier rapport généré.
 */
function getLastReport() {
  return readJsonSafe(REPORT_PATH);
}

/**
 * Retourne l'historique des ajustements.
 */
function getAdjustmentsLog() {
  return loadAdjustmentsLog();
}

/**
 * Retourne la dernière analyse GPT.
 */
function getGptAnalysis() {
  return readJsonSafe(GPT_ANALYSIS_PATH);
}

module.exports = {
  runAnalysis,
  getDisabledCategories,
  getAdjustedParams,
  getLastReport,
  getAdjustmentsLog,
  getGptAnalysis
};
