/**
 * Scores de Confiance & Liquidité — calculés en temps réel au scan.
 *
 * Confiance (0-100) : à quel point on est sûr que l'opportunité est réelle.
 *   1. Qualité du matching texte (match.score) — 40 pts max
 *   2. Nombre de résultats eBay bruts (resultCount) — 25 pts max
 *   3. Cohérence des prix (coefficient de variation) — 20 pts max
 *   4. Source de prix (API officielle vs scraping) — 15 pts max
 *
 * Liquidité (0-100) : à quelle vitesse l'objet se vendra.
 *   A. Volume de ventes matchées (soldCount)        — 35%
 *   B. Vitesse de vente (intervalles entre soldAt)  — 30%
 *   C. Stabilité des prix (coefficient de variation)— 20%
 *   D. Turnover des annonces (seen-listings expired)— 15%
 */

// ─── Helpers ────────────────────────────────────────────────────────

function medianOf(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Coefficient de variation (écart-type / moyenne).
 * Mesure la dispersion relative des prix (0 = très stable, 1+ = très volatile).
 * Retourne null si moins de 2 prix.
 */
function coefficientOfVariation(prices) {
  if (!prices || prices.length < 2) return null;
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  if (mean === 0) return null;
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
  return Math.sqrt(variance) / mean;
}

// ─── Score de Confiance (0-100) ─────────────────────────────────────

/**
 * Calcule le score de confiance — système simplifié 3 niveaux.
 *
 * Tier 1 : Qualité du matching texte (0-40)
 * Tier 2 : Fiabilité de la source (0-20)
 * Tier 3 : Vérification vision GPT-4o mini (0-40) — le facteur décisif
 *
 * Score final typique :
 *   Vision confirmée  : 80-100 → ACHAT
 *   Source fiable, pas de vision : 50-60 → borderline
 *   Match faible / source non fiable : 30-40 → rejet
 *   GPT dit carte différente : 0 → rejet immédiat
 *
 * @param {object} opp - Objet opportunité avec matchedSales, pricingSource, visionVerified, visionResult
 * @returns {number} Score 0-100
 */
function computeConfidence(opp) {
  const src = opp.pricingSource || 'unknown';
  const matchedSales = opp.matchedSales || [];

  // === TIER 1 : Qualité du matching texte (0-40) ===
  // Bonus si la source est eBay réel (ventes confirmées, pas estimation)
  const isEbaySource = ['ebay-browse-api', 'ebay-html', 'apify-ebay', 'ebay'].includes(src);

  let textScore = 0;
  if (matchedSales.length > 0) {
    const bestMatch = matchedSales.reduce((best, s) => {
      const sc = (s.match && typeof s.match.score === 'number') ? s.match.score : 0;
      const bsc = (best.match && typeof best.match.score === 'number') ? best.match.score : 0;
      return sc > bsc ? s : best;
    }, matchedSales[0]);
    const ms = (bestMatch.match && typeof bestMatch.match.score === 'number') ? bestMatch.match.score : 0;

    if (ms >= 12)                          textScore = 40; // Excellent match
    else if (ms >= 8 && isEbaySource)      textScore = 40; // Bon match + ventes eBay confirmées
    else if (ms >= 8)                      textScore = 30; // Bon match (source non-eBay)
    else if (ms >= 4 && isEbaySource)      textScore = 25; // Match correct + ventes eBay réelles
    else if (ms >= 4)                      textScore = 20; // Match correct seul
    else                                   textScore = 10; // Match faible
  } else if (src === 'local-database' || src === 'pokemon-tcg-api' || src === 'ygoprodeck') {
    // API niche ou base locale — matching texte déjà fait lors de l'indexation
    textScore = 30;
  }

  // === TIER 2 : Fiabilité de la source (0-20) ===
  let sourceScore = 0;
  switch (src) {
    case 'pokemon-tcg-api':
    case 'ygoprodeck':
      sourceScore = 20; // APIs dédiées — très fiables
      break;
    case 'local-database': {
      const sc = opp.scanCount || 0;
      sourceScore = sc >= 10 ? 20 : sc >= 5 ? 15 : sc >= 3 ? 10 : 5;
      break;
    }
    case 'ebay-browse-api':
      sourceScore = matchedSales.length >= 3 ? 20 : 10; // 3+ ventes = source fiable
      break;
    case 'ebay-html':
    case 'ebay':
      sourceScore = matchedSales.length >= 3 ? 15 : 8; // scraping eBay — légèrement moins fiable
      break;
    case 'apify-ebay':
      sourceScore = matchedSales.length >= 3 ? 15 : 10;
      break;
    case 'rebrickable':
      sourceScore = 10; // API produit dédiée LEGO — données structurées fiables
      break;
    default:
      sourceScore = 5;
  }

  // === TIER 3 : Vérification Vision (0-40) ===
  // GPT-4o mini confirme = gros bonus. GPT dit non = rejet immédiat.
  let visionScore = 0;
  if (opp.visionVerified && opp.visionResult) {
    if (opp.visionResult.sameCard === true) {
      visionScore = 40; // GPT confirme — c'est la bonne carte
    } else if (opp.visionResult.sameCard === false) {
      return 0; // GPT dit carte différente — rejet immédiat
    }
  } else {
    // Pas de vision GPT — utilise le hash local comme substitut
    const salesWithImage = matchedSales.filter(s => s.imageMatch && s.imageMatch.score !== null);
    if (salesWithImage.length > 0) {
      const bestImg = Math.max(...salesWithImage.map(s => s.imageMatch.score));
      if (bestImg >= 0.85)      visionScore = 25; // Hash local très confiant
      else if (bestImg >= 0.75) visionScore = 15; // Hash local assez confiant
      // else visionScore = 0 — hash faible
    } else if (src === 'local-database') {
      visionScore = 15; // DB locale pré-vérifiée — bénéfice du doute
    }
    // Pas d'image du tout + pas local-db → visionScore = 0
  }

  // === SCORE FINAL ===
  let total = Math.min(100, textScore + sourceScore + visionScore);

  // === PÉNALITÉS ===
  // Règles apprises via feedback
  try {
    const { applyLearnedRules } = require('./feedback-learner');
    const bestEbayTitle = matchedSales.length > 0 ? (matchedSales[0].title || '') : '';
    const penalty = applyLearnedRules(opp.title || '', bestEbayTitle);
    if (penalty < 0) total = Math.max(0, total + penalty);
  } catch(e) {}

  // Vendeur suspect → plafond à 40
  const sellerScore = opp.sellerScore;
  if (sellerScore && typeof sellerScore === 'object' && sellerScore.score < 20) {
    total = Math.min(total, 40);
  }

  // Hard gate : GPT Vision doit confirmer pour atteindre le seuil d'opportunité (≥ 50)
  // Sans confirmation GPT, l'item reste sous le seuil actif — évite tout faux positif
  if (!(opp.visionVerified && opp.visionResult && opp.visionResult.sameCard === true)) {
    total = Math.min(total, 49);
  }

  return total;
}

// ─── Score de Liquidité (0-100) ─────────────────────────────────────

// Lazy-load seen-listings for turnover factor (same in-memory cache as main process)
let _seenListings = null;
function getSeenListings() {
  if (!_seenListings) {
    try { _seenListings = require('./seen-listings'); } catch { _seenListings = null; }
  }
  return _seenListings;
}

// Lazy-load price-database for recording history
let _priceDb = null;
function getPriceDb() {
  if (!_priceDb) {
    try { _priceDb = require('./price-database'); } catch { _priceDb = null; }
  }
  return _priceDb;
}

/**
 * Parse une date de vente depuis les formats eBay variés.
 */
function parseSoldDate(sale) {
  if (sale.soldAtTs && typeof sale.soldAtTs === 'number') return sale.soldAtTs;
  if (sale.soldAt) {
    const d = new Date(sale.soldAt);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  if (sale.endDate) {
    const d = new Date(sale.endDate);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return null;
}

const LIQUIDITY_CLASSIFICATION = [
  { label: 'flash',     minScore: 80, color: '#00d2a0', emoji: '⚡' },
  { label: 'rapide',    minScore: 60, color: '#4cd137', emoji: '🟢' },
  { label: 'normal',    minScore: 40, color: '#ffa94d', emoji: '🟠' },
  { label: 'lent',      minScore: 20, color: '#ff6b6b', emoji: '🔴' },
  { label: 'très lent', minScore: 0,  color: '#636e72', emoji: '⛔' },
];

function classifyLiquidity(score) {
  for (const tier of LIQUIDITY_CLASSIFICATION) {
    if (score >= tier.minScore) return tier;
  }
  return LIQUIDITY_CLASSIFICATION[LIQUIDITY_CLASSIFICATION.length - 1];
}

/**
 * Calcule le score de liquidité unifié basé sur 4 facteurs pondérés.
 *
 * @param {object} opp - Objet opportunité avec matchedSales, search, title
 * @returns {{ score, classification, summary, details }} Score 0-100 + métadonnées
 */
function computeLiquidity(opp) {
  const matchedSales = opp.matchedSales || [];

  // ── A) Volume (35%) ─────────────────────────────────────────────────
  const soldCount = matchedSales.length;
  let volumePoints;
  if (soldCount === 0)       volumePoints = 0;
  else if (soldCount <= 2)   volumePoints = 15;
  else if (soldCount <= 5)   volumePoints = 30;
  else if (soldCount <= 10)  volumePoints = 60;
  else if (soldCount <= 20)  volumePoints = 80;
  else                       volumePoints = 100;

  // ── B) Speed (30%) ─────────────────────────────────────────────────
  // Calcule l'intervalle moyen entre ventes depuis les dates soldAt
  const salesWithDates = matchedSales
    .map((s) => ({ _ts: parseSoldDate(s) }))
    .filter((s) => s._ts !== null)
    .sort((a, b) => b._ts - a._ts);

  let speedPoints = 50; // fallback: pas de dates
  let avgDaysBetweenSales = null;

  if (salesWithDates.length >= 2) {
    const intervals = [];
    const msPerDay = 24 * 60 * 60 * 1000;
    for (let i = 0; i < salesWithDates.length - 1; i++) {
      const diff = (salesWithDates[i]._ts - salesWithDates[i + 1]._ts) / msPerDay;
      if (diff >= 0) intervals.push(diff);
    }
    if (intervals.length > 0) {
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      avgDaysBetweenSales = Math.round(avg * 10) / 10;
      if (avg < 1)       speedPoints = 100; // flash
      else if (avg < 3)  speedPoints = 80;  // rapide
      else if (avg < 7)  speedPoints = 60;  // normal
      else if (avg < 14) speedPoints = 40;  // lent
      else               speedPoints = 20;  // très lent
    } else {
      speedPoints = 100; // Toutes vendues le même jour
    }
  }

  // ── C) Stabilité des prix (20%) ─────────────────────────────────────
  const prices = matchedSales
    .map((s) => s.price || s.totalPrice)
    .filter((p) => typeof p === 'number' && p > 0);

  let stabilityPoints = 50; // fallback: données insuffisantes
  if (prices.length >= 2) {
    const cv = coefficientOfVariation(prices);
    if (cv === null)      stabilityPoints = 50;
    else if (cv < 0.1)   stabilityPoints = 100;
    else if (cv < 0.2)   stabilityPoints = 80;
    else if (cv < 0.3)   stabilityPoints = 60;
    else if (cv < 0.5)   stabilityPoints = 40;
    else                 stabilityPoints = 20;
  }

  // ── D) Turnover des annonces (15%) ───────────────────────────────────
  // Ratio d'annonces "expired" pour cette catégorie dans seen-listings
  let turnoverPoints = 50; // fallback: pas encore de données
  try {
    const sl = getSeenListings();
    if (sl && sl.getCategoryStats) {
      const stats = sl.getCategoryStats(opp.search || '');
      if (stats && stats.total >= 3 && stats.expiredRatio !== null) {
        const r = stats.expiredRatio;
        if (r >= 0.7)      turnoverPoints = 100;
        else if (r >= 0.5) turnoverPoints = 80;
        else if (r >= 0.3) turnoverPoints = 60;
        else if (r >= 0.1) turnoverPoints = 40;
        else               turnoverPoints = 20;
      }
    }
  } catch { /* ignore — turnover reste au fallback */ }

  // ── Score final ──────────────────────────────────────────────────────
  const score = Math.round(
    Math.min(100, Math.max(0,
      volumePoints    * 0.35 +
      speedPoints     * 0.30 +
      stabilityPoints * 0.20 +
      turnoverPoints  * 0.15
    ))
  );

  const tier = classifyLiquidity(score);

  const result = {
    score,
    classification: tier.label,
    summary: {
      score,
      label: tier.label,
      speedLabel: tier.label,
      speedEmoji: tier.emoji,
      color: tier.color,
      soldCount,
      avgDaysBetweenSales
    },
    details: {
      volume: volumePoints,
      speed: speedPoints,
      stability: stabilityPoints,
      turnover: turnoverPoints
    }
  };

  // Enregistre l'historique de liquidité dans price-database
  try {
    const db = getPriceDb();
    if (db && db.recordLiquidity && opp.title && opp.search) {
      db.recordLiquidity(opp.title, opp.search, result);
    }
  } catch { /* ignore — pas bloquant */ }

  return result;
}

// ─── Compatibilité (ancienne API — catégorie uniquement) ─────────────

// Gardé pour compatibilité externe si appelé directement
const CATEGORY_LIQUIDITY = [
  { keywords: ['pokemon'],                          score: 30 },
  { keywords: ['sneakers'],                         score: 28 },
  { keywords: ['tech'],                             score: 27 },
  { keywords: ['yu-gi-oh', 'yugioh'],               score: 25 },
  { keywords: ['topps chrome', 'chrome football'],  score: 25 },
  { keywords: ['lego'],                             score: 22 },
  { keywords: ['topps f1', 'f1'],                   score: 20 },
  { keywords: ['one piece'],                        score: 20 },
  { keywords: ['panini', 'football'],               score: 18 },
  { keywords: ['vetement', 'vintage', 'vêtement'],  score: 15 },
  { keywords: ['console', 'retro'],                 score: 15 },
  { keywords: ['vinyle', 'vinyl'],                  score: 10 },
];

function getCategoryLiquidityScore(searchName) {
  const lower = (searchName || '').toLowerCase();
  for (const cat of CATEGORY_LIQUIDITY) {
    if (cat.keywords.some((kw) => lower.includes(kw))) return cat.score;
  }
  return 15;
}

module.exports = {
  computeConfidence,
  computeLiquidity,
  getCategoryLiquidityScore,
  // conservé pour compatibilité — non utilisé en interne
  jaccardSimilarity: function jaccardSimilarity(titleA, titleB) {
    const tokenize = (s) =>
      (s || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u00C0-\u017E]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2);
    const setA = new Set(tokenize(titleA));
    const setB = new Set(tokenize(titleB));
    if (setA.size === 0 && setB.size === 0) return 0;
    let intersection = 0;
    for (const w of setA) { if (setB.has(w)) intersection++; }
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
  }
};
