/**
 * Agent Liquidité — Évalue la facilité de vente de chaque opportunité d'arbitrage.
 *
 * Responsabilités :
 *   1. Analyser le volume de ventes eBay (30j et 7j)
 *   2. Estimer la vitesse de vente (temps moyen entre ventes)
 *   3. Mesurer la stabilité des prix (écart-type, tendance, CV)
 *   4. Calculer un score de liquidité pondéré (0-100)
 *   5. Ajuster la marge effective (marge brute × liquidité)
 *   6. Estimer le capital lockup (coût d'opportunité)
 *
 * Principe clé : un objet à 50% de marge qui met 3 mois à se vendre
 * est MOINS intéressant qu'un objet à 30% qui se vend en 2 jours.
 */

const config = require('../config');

// ─── Constantes ────────────────────────────────────────────────────

const LOOKBACK_DAYS = Number(process.env.LIQUIDITY_LOOKBACK_DAYS) || 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Seuils de classification vitesse
const SPEED_TIERS = [
  { label: 'flash',     emoji: '⚡', maxDays: 2,   color: '#00d2a0' },
  { label: 'rapide',    emoji: '🟢', maxDays: 7,   color: '#4cd137' },
  { label: 'normal',    emoji: '🟠', maxDays: 14,  color: '#ffa94d' },
  { label: 'lent',      emoji: '🔴', maxDays: 30,  color: '#ff6b6b' },
  { label: 'très lent', emoji: '⛔', maxDays: Infinity, color: '#636e72' }
];

// Poids du score de liquidité
const WEIGHTS = {
  volume: 0.40,
  speed: 0.35,
  stability: 0.25
};

// ─── Helpers ───────────────────────────────────────────────────────

function round2(value) {
  return Math.round((value || 0) * 100) / 100;
}

/**
 * Parse une date de vente depuis les formats eBay variés.
 * Gère : ISO string, timestamp numérique, "dd Mmm yyyy", etc.
 */
function parseSoldDate(sale) {
  // Priorité au timestamp pré-calculé
  if (sale.soldAtTs && typeof sale.soldAtTs === 'number') {
    return sale.soldAtTs;
  }

  if (sale.soldAt) {
    const d = new Date(sale.soldAt);
    if (!isNaN(d.getTime())) return d.getTime();
  }

  // Fallback : date de fin d'enchère eBay
  if (sale.endDate) {
    const d = new Date(sale.endDate);
    if (!isNaN(d.getTime())) return d.getTime();
  }

  return null;
}

/**
 * Extrait le prix d'une vente eBay (gère les différents champs).
 */
function getSalePrice(sale) {
  return sale.totalPrice || sale.price || sale.soldPrice || 0;
}

// ─── A) ANALYSE DE VOLUME ──────────────────────────────────────────

/**
 * Analyse le volume de ventes sur différentes fenêtres temporelles.
 *
 * @param {Array} sales - matchedSales de l'opportunité
 * @param {number} now - timestamp actuel
 * @returns {Object} Métriques de volume
 */
function analyzeVolume(sales, now) {
  const salesWithDates = sales
    .map((s) => ({ ...s, _ts: parseSoldDate(s) }))
    .filter((s) => s._ts !== null);

  // Ventes dans les 30 derniers jours
  const cutoff30d = now - (LOOKBACK_DAYS * MS_PER_DAY);
  const sales30d = salesWithDates.filter((s) => s._ts >= cutoff30d);

  // Ventes dans les 7 derniers jours
  const cutoff7d = now - (7 * MS_PER_DAY);
  const sales7d = salesWithDates.filter((s) => s._ts >= cutoff7d);

  // Nombre total de listings actifs (estimé via les données dispo)
  // On n'a pas directement cette info, mais on utilise le ratio ventes/total
  const totalSalesKnown = sales.length;
  const datedSalesCount = salesWithDates.length;

  // Tendance récente : ratio ventes 7j par rapport à 30j
  // Si on a 4 ventes sur 7j et 8 sur 30j → ratio 0.5 (50% des ventes en 7j = très actif)
  const recentTrendRatio = sales30d.length > 0
    ? sales7d.length / sales30d.length
    : 0;

  // Score de volume normalisé (0-100)
  // 0 ventes = 0, 1-2 = faible, 3-5 = moyen, 6-10 = bon, 10+ = excellent
  let volumeScore;
  if (sales30d.length >= 10) volumeScore = 100;
  else if (sales30d.length >= 6) volumeScore = 75 + (sales30d.length - 6) * 6.25;
  else if (sales30d.length >= 3) volumeScore = 40 + (sales30d.length - 3) * 11.67;
  else if (sales30d.length >= 1) volumeScore = 10 + (sales30d.length - 1) * 15;
  else volumeScore = 0;

  // Bonus tendance récente : si beaucoup de ventes récentes → demande en hausse
  if (recentTrendRatio > 0.4 && sales7d.length >= 2) {
    volumeScore = Math.min(100, volumeScore + 10);
  }

  return {
    totalSales: totalSalesKnown,
    datedSales: datedSalesCount,
    sales30d: sales30d.length,
    sales7d: sales7d.length,
    recentTrendRatio: round2(recentTrendRatio),
    trendLabel: recentTrendRatio > 0.4 ? 'en hausse' : (recentTrendRatio > 0.2 ? 'stable' : 'en baisse'),
    volumeScore: round2(Math.min(100, Math.max(0, volumeScore)))
  };
}

// ─── B) VITESSE DE VENTE ESTIMÉE ───────────────────────────────────

/**
 * Estime la vitesse de vente basée sur l'écart entre les ventes récentes.
 *
 * @param {Array} sales - matchedSales de l'opportunité
 * @param {number} now - timestamp actuel
 * @returns {Object} Métriques de vitesse
 */
function analyzeSpeed(sales, now) {
  const salesWithDates = sales
    .map((s) => ({ ...s, _ts: parseSoldDate(s) }))
    .filter((s) => s._ts !== null)
    .sort((a, b) => b._ts - a._ts); // Plus récent en premier

  // Limiter aux ventes des LOOKBACK_DAYS derniers jours
  const cutoff = now - (LOOKBACK_DAYS * MS_PER_DAY);
  const recentSales = salesWithDates.filter((s) => s._ts >= cutoff);

  if (recentSales.length === 0) {
    return {
      estimatedDaysToSell: 60,
      avgDaysBetweenSales: null,
      medianDaysBetweenSales: null,
      speedTier: SPEED_TIERS[4], // très lent
      speedScore: 0,
      sampleSize: 0
    };
  }

  if (recentSales.length === 1) {
    // Une seule vente : on estime le temps depuis cette vente
    const daysSinceLastSale = (now - recentSales[0]._ts) / MS_PER_DAY;
    const estimatedDays = Math.max(3, daysSinceLastSale * 1.5); // Estimation pessimiste

    return {
      estimatedDaysToSell: round2(estimatedDays),
      avgDaysBetweenSales: null,
      medianDaysBetweenSales: null,
      speedTier: classifySpeed(estimatedDays),
      speedScore: round2(computeSpeedScore(estimatedDays)),
      sampleSize: 1
    };
  }

  // Calculer les intervalles entre ventes consécutives
  const intervals = [];
  for (let i = 0; i < recentSales.length - 1; i++) {
    const daysDiff = (recentSales[i]._ts - recentSales[i + 1]._ts) / MS_PER_DAY;
    if (daysDiff > 0) {
      intervals.push(daysDiff);
    }
  }

  if (intervals.length === 0) {
    // Toutes vendues le même jour → très rapide
    return {
      estimatedDaysToSell: 1,
      avgDaysBetweenSales: 0,
      medianDaysBetweenSales: 0,
      speedTier: SPEED_TIERS[0], // flash
      speedScore: 100,
      sampleSize: recentSales.length
    };
  }

  // Moyenne et médiane des intervalles
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const sorted = [...intervals].sort((a, b) => a - b);
  const medianIdx = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[medianIdx - 1] + sorted[medianIdx]) / 2
    : sorted[medianIdx];

  // On utilise la médiane comme estimation (plus robuste que la moyenne)
  const estimatedDays = Math.max(0.5, median);

  return {
    estimatedDaysToSell: round2(estimatedDays),
    avgDaysBetweenSales: round2(avg),
    medianDaysBetweenSales: round2(median),
    speedTier: classifySpeed(estimatedDays),
    speedScore: round2(computeSpeedScore(estimatedDays)),
    sampleSize: recentSales.length
  };
}

/**
 * Classifie la vitesse en tier.
 */
function classifySpeed(days) {
  for (const tier of SPEED_TIERS) {
    if (days <= tier.maxDays) return tier;
  }
  return SPEED_TIERS[SPEED_TIERS.length - 1];
}

/**
 * Score de vitesse (0-100).
 * flash (<2j) = 100, rapide (2-7j) = 70-100, normal (7-14j) = 35-70,
 * lent (14-30j) = 10-35, très lent (30+j) = 0-10
 */
function computeSpeedScore(days) {
  if (days <= 0.5) return 100;
  if (days <= 2) return 85 + (2 - days) * 10; // 85-100
  if (days <= 7) return 55 + ((7 - days) / 5) * 30; // 55-85
  if (days <= 14) return 25 + ((14 - days) / 7) * 30; // 25-55
  if (days <= 30) return 5 + ((30 - days) / 16) * 20; // 5-25
  if (days <= 60) return (60 - days) / 30 * 5; // 0-5
  return 0;
}

// ─── C) STABILITÉ DES PRIX ─────────────────────────────────────────

/**
 * Analyse la stabilité et la tendance des prix de vente.
 *
 * @param {Array} sales - matchedSales de l'opportunité
 * @param {number} now - timestamp actuel
 * @returns {Object} Métriques de stabilité
 */
function analyzeStability(sales, now) {
  const salesWithPrices = sales
    .map((s) => ({
      price: getSalePrice(s),
      ts: parseSoldDate(s)
    }))
    .filter((s) => s.price > 0);

  if (salesWithPrices.length < 2) {
    return {
      mean: salesWithPrices.length === 1 ? round2(salesWithPrices[0].price) : 0,
      stdDev: 0,
      coefficientOfVariation: 0,
      cvLabel: 'inconnu',
      trend: 'inconnu',
      trendPercent: 0,
      priceRange: { min: 0, max: 0 },
      stabilityScore: salesWithPrices.length === 1 ? 50 : 0,
      sampleSize: salesWithPrices.length
    };
  }

  const prices = salesWithPrices.map((s) => s.price);

  // Moyenne
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;

  // Écart-type
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
  const stdDev = Math.sqrt(variance);

  // Coefficient de variation
  const cv = mean > 0 ? (stdDev / mean) * 100 : 0;
  let cvLabel;
  if (cv < 10) cvLabel = 'très stable';
  else if (cv < 25) cvLabel = 'modéré';
  else cvLabel = 'volatile';

  // Tendance des prix (régression linéaire simple sur les dates)
  let trend = 'stable';
  let trendPercent = 0;

  const datedPrices = salesWithPrices
    .filter((s) => s.ts !== null)
    .sort((a, b) => a.ts - b.ts); // Du plus ancien au plus récent

  if (datedPrices.length >= 3) {
    // Diviser en deux moitiés : ancienne et récente
    const mid = Math.floor(datedPrices.length / 2);
    const oldHalf = datedPrices.slice(0, mid).map((s) => s.price);
    const newHalf = datedPrices.slice(mid).map((s) => s.price);

    const avgOld = oldHalf.reduce((a, b) => a + b, 0) / oldHalf.length;
    const avgNew = newHalf.reduce((a, b) => a + b, 0) / newHalf.length;

    if (avgOld > 0) {
      trendPercent = round2(((avgNew - avgOld) / avgOld) * 100);
      if (trendPercent > 5) trend = 'en hausse';
      else if (trendPercent < -5) trend = 'en baisse';
      else trend = 'stable';
    }
  }

  // Score de stabilité (0-100)
  // CV < 10% = 100, 10-15% = 80, 15-25% = 50, 25-40% = 25, > 40% = 5
  let stabilityScore;
  if (cv <= 10) stabilityScore = 90 + (10 - cv);
  else if (cv <= 15) stabilityScore = 70 + ((15 - cv) / 5) * 20;
  else if (cv <= 25) stabilityScore = 40 + ((25 - cv) / 10) * 30;
  else if (cv <= 40) stabilityScore = 10 + ((40 - cv) / 15) * 30;
  else stabilityScore = Math.max(0, 10 - (cv - 40) / 5);

  // Bonus/malus selon tendance
  if (trend === 'en hausse') stabilityScore = Math.min(100, stabilityScore + 10);
  if (trend === 'en baisse') stabilityScore = Math.max(0, stabilityScore - 15);

  return {
    mean: round2(mean),
    stdDev: round2(stdDev),
    coefficientOfVariation: round2(cv),
    cvLabel,
    trend,
    trendPercent,
    priceRange: {
      min: round2(Math.min(...prices)),
      max: round2(Math.max(...prices))
    },
    stabilityScore: round2(Math.min(100, Math.max(0, stabilityScore))),
    sampleSize: prices.length
  };
}

// ─── D) SCORE DE LIQUIDITÉ (0-100) ─────────────────────────────────

/**
 * Calcule le score de liquidité global pondéré.
 *
 * @param {Object} volume - Résultat de analyzeVolume()
 * @param {Object} speed - Résultat de analyzeSpeed()
 * @param {Object} stability - Résultat de analyzeStability()
 * @returns {number} Score 0-100
 */
function computeLiquidityScore(volume, speed, stability) {
  const score =
    (volume.volumeScore * WEIGHTS.volume) +
    (speed.speedScore * WEIGHTS.speed) +
    (stability.stabilityScore * WEIGHTS.stability);

  return round2(Math.min(100, Math.max(0, score)));
}

/**
 * Classifie le score de liquidité en label.
 */
function classifyLiquidityScore(score) {
  if (score >= 80) return { label: 'Excellent', color: '#00d2a0' };
  if (score >= 60) return { label: 'Bon', color: '#4cd137' };
  if (score >= 40) return { label: 'Moyen', color: '#ffa94d' };
  if (score >= 20) return { label: 'Faible', color: '#ff6b6b' };
  return { label: 'Très faible', color: '#636e72' };
}

// ─── E) MARGE EFFECTIVE AJUSTÉE ────────────────────────────────────

/**
 * Calcule la marge ajustée par la liquidité.
 *
 * Principe : marge ajustée = marge brute × (score liquidité / 100)
 * Un objet à 60% de marge mais score 30 → marge ajustée 18%
 * Un objet à 25% de marge mais score 90 → marge ajustée 22.5%
 *
 * @param {number} grossMarginPercent - Marge brute en %
 * @param {number} liquidityScore - Score de liquidité 0-100
 * @returns {Object} Détails de la marge ajustée
 */
function computeAdjustedMargin(grossMarginPercent, liquidityScore) {
  const adjustedMarginPercent = round2(grossMarginPercent * (liquidityScore / 100));
  const adjustmentFactor = round2(liquidityScore / 100);

  return {
    grossMarginPercent: round2(grossMarginPercent),
    liquidityScore,
    adjustmentFactor,
    adjustedMarginPercent,
    verdict: adjustedMarginPercent >= 25 ? 'excellent'
      : adjustedMarginPercent >= 15 ? 'bon'
      : adjustedMarginPercent >= 8 ? 'moyen'
      : 'risqué'
  };
}

// ─── F) CAPITAL LOCKUP ─────────────────────────────────────────────

/**
 * Estime le coût d'opportunité du capital bloqué.
 *
 * @param {number} acquisitionCost - Prix d'achat total
 * @param {number} estimatedDaysToSell - Nombre de jours estimé
 * @param {number} liquidityScore - Score de liquidité
 * @returns {Object} Analyse du capital lockup
 */
function computeCapitalLockup(acquisitionCost, estimatedDaysToSell, liquidityScore) {
  // Coût d'opportunité : on suppose qu'on pourrait faire tourner le capital
  // X fois par mois avec des objets plus liquides
  // Taux d'opportunité annualisé : ~100% (objectif d'un bon flippeur)
  const dailyOpportunityCost = acquisitionCost * (1 / 365); // ~0.27% par jour
  const lockupCost = round2(dailyOpportunityCost * estimatedDaysToSell);

  // Nombre de rotations possibles par mois avec cet argent
  const rotationsPerMonth = estimatedDaysToSell > 0
    ? round2(30 / estimatedDaysToSell)
    : 30;

  // Risque de lockup
  let riskLevel;
  if (estimatedDaysToSell <= 3) riskLevel = 'minimal';
  else if (estimatedDaysToSell <= 7) riskLevel = 'faible';
  else if (estimatedDaysToSell <= 14) riskLevel = 'modéré';
  else if (estimatedDaysToSell <= 30) riskLevel = 'élevé';
  else riskLevel = 'très élevé';

  return {
    acquisitionCost: round2(acquisitionCost),
    estimatedDaysToSell: round2(estimatedDaysToSell),
    lockupCost,
    rotationsPerMonth,
    riskLevel,
    // Score de lockup (0-100, 100 = aucun lockup problématique)
    lockupScore: round2(Math.max(0, Math.min(100, 100 - (estimatedDaysToSell * 2.5))))
  };
}

// ─── AGENT PRINCIPAL ───────────────────────────────────────────────

/**
 * Analyse la liquidité d'une seule opportunité.
 *
 * @param {Object} opportunity - L'opportunité avec matchedSales
 * @returns {Object} Analyse complète de liquidité
 */
function analyzeLiquidity(opportunity) {
  const now = Date.now();
  const sales = opportunity.matchedSales || [];

  // A) Volume
  const volume = analyzeVolume(sales, now);

  // B) Vitesse
  const speed = analyzeSpeed(sales, now);

  // C) Stabilité
  const stability = analyzeStability(sales, now);

  // D) Score global
  const liquidityScore = computeLiquidityScore(volume, speed, stability);
  const classification = classifyLiquidityScore(liquidityScore);

  // E) Marge ajustée
  const grossMargin = opportunity.profit
    ? (opportunity.profit.profitPercent || 0)
    : 0;
  const adjustedMargin = computeAdjustedMargin(grossMargin, liquidityScore);

  // F) Capital lockup
  const acquisitionCost = opportunity.vintedBuyerPrice
    || opportunity.vintedListedPrice
    || 0;
  const capitalLockup = computeCapitalLockup(
    acquisitionCost,
    speed.estimatedDaysToSell,
    liquidityScore
  );

  return {
    // Score principal
    liquidityScore,
    classification,

    // Composantes détaillées
    volume,
    speed,
    stability,

    // Marge ajustée
    adjustedMargin,

    // Capital lockup
    capitalLockup,

    // Résumé pour affichage rapide
    summary: {
      score: liquidityScore,
      label: classification.label,
      color: classification.color,
      speedLabel: speed.speedTier.label,
      speedEmoji: speed.speedTier.emoji,
      estimatedDays: speed.estimatedDaysToSell,
      adjustedMarginPercent: adjustedMargin.adjustedMarginPercent,
      volumeTrend: volume.trendLabel,
      priceTrend: stability.trend
    },

    // Métadonnées
    analyzedAt: new Date().toISOString(),
    salesAnalyzed: sales.length
  };
}

/**
 * Analyse un lot d'opportunités et les enrichit avec les données de liquidité.
 * Trie par marge ajustée décroissante (la vraie métrique de décision).
 *
 * @param {Array} opportunities - Liste d'opportunités
 * @param {Object} opts - Options
 * @returns {Object} Résultat complet avec opportunités enrichies
 */
async function assessLiquidity(opportunities, opts = {}) {
  const startTime = Date.now();

  console.log(`[Liquidité] Analyse de ${opportunities.length} opportunité(s)...`);

  const results = [];

  for (const opp of opportunities) {
    try {
      const analysis = analyzeLiquidity(opp);

      results.push({
        ...opp,
        liquidity: analysis
      });

      const s = analysis.summary;
      console.log(
        `  [Liquidité] ${(opp.title || '').slice(0, 45)}... → ` +
        `${s.speedEmoji} ${s.speedLabel} (${s.estimatedDays}j) | ` +
        `Score: ${s.score}/100 | ` +
        `Marge ajustée: ${s.adjustedMarginPercent}%`
      );
    } catch (error) {
      console.error(`  [Liquidité] Erreur sur "${(opp.title || '').slice(0, 40)}": ${error.message}`);
      // On garde l'opportunité sans analyse de liquidité
      results.push({
        ...opp,
        liquidity: {
          liquidityScore: 0,
          classification: classifyLiquidityScore(0),
          error: error.message,
          summary: {
            score: 0,
            label: 'Erreur',
            color: '#636e72',
            speedLabel: 'inconnu',
            speedEmoji: '❓',
            estimatedDays: 99,
            adjustedMarginPercent: 0,
            volumeTrend: 'inconnu',
            priceTrend: 'inconnu'
          },
          analyzedAt: new Date().toISOString(),
          salesAnalyzed: 0
        }
      });
    }
  }

  // Trier par marge ajustée (la vraie métrique)
  results.sort((a, b) => {
    const marginA = a.liquidity.summary.adjustedMarginPercent || 0;
    const marginB = b.liquidity.summary.adjustedMarginPercent || 0;
    return marginB - marginA;
  });

  // Statistiques globales
  const scores = results.map((r) => r.liquidity.liquidityScore);
  const avgScore = scores.length > 0
    ? round2(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  const speedDistribution = {
    flash: results.filter((r) => r.liquidity.summary.speedLabel === 'flash').length,
    rapide: results.filter((r) => r.liquidity.summary.speedLabel === 'rapide').length,
    normal: results.filter((r) => r.liquidity.summary.speedLabel === 'normal').length,
    lent: results.filter((r) => r.liquidity.summary.speedLabel === 'lent').length,
    tresLent: results.filter((r) => r.liquidity.summary.speedLabel === 'très lent').length
  };

  const adjustedMargins = results.map((r) => r.liquidity.summary.adjustedMarginPercent || 0);
  const avgAdjustedMargin = adjustedMargins.length > 0
    ? round2(adjustedMargins.reduce((a, b) => a + b, 0) / adjustedMargins.length)
    : 0;

  const elapsed = Date.now() - startTime;

  const summary = {
    total: results.length,
    avgLiquidityScore: avgScore,
    avgAdjustedMargin,
    speedDistribution,
    highLiquidity: results.filter((r) => r.liquidity.liquidityScore >= 70).length,
    mediumLiquidity: results.filter((r) => r.liquidity.liquidityScore >= 40 && r.liquidity.liquidityScore < 70).length,
    lowLiquidity: results.filter((r) => r.liquidity.liquidityScore < 40).length,
    durationMs: elapsed
  };

  console.log(
    `[Liquidité] Terminé en ${elapsed}ms — ` +
    `Score moyen: ${avgScore}/100 | ` +
    `Marge ajustée moy: ${avgAdjustedMargin}% | ` +
    `⚡${speedDistribution.flash} 🟢${speedDistribution.rapide} 🟠${speedDistribution.normal} 🔴${speedDistribution.lent} ⛔${speedDistribution.tresLent}`
  );

  return {
    opportunities: results,
    summary,
    analyzedAt: new Date().toISOString()
  };
}

// ─── Helpers pour intégration Telegram ──────────────────────────────

/**
 * Construit un résumé de liquidité pour le message Telegram.
 */
function buildLiquidityTelegramSnippet(liquidityData) {
  if (!liquidityData || !liquidityData.summary) return '';

  const s = liquidityData.summary;
  return `${s.speedEmoji} Liquidité: ${s.speedLabel} (score ${s.score}/100) | Marge ajustée: ${s.adjustedMarginPercent}%`;
}

/**
 * Construit le message Telegram du rapport de liquidité complet.
 */
function buildLiquidityReportMessage(result) {
  const s = result.summary;
  const lines = [
    '=== RAPPORT LIQUIDITÉ ===',
    '',
    `Opportunités analysées: ${s.total}`,
    `Score liquidité moyen: ${s.avgLiquidityScore}/100`,
    `Marge ajustée moyenne: ${s.avgAdjustedMargin}%`,
    '',
    '--- Répartition vitesse ---',
    `  ⚡ Flash (<2j): ${s.speedDistribution.flash}`,
    `  🟢 Rapide (2-7j): ${s.speedDistribution.rapide}`,
    `  🟠 Normal (7-14j): ${s.speedDistribution.normal}`,
    `  🔴 Lent (14-30j): ${s.speedDistribution.lent}`,
    `  ⛔ Très lent (30+j): ${s.speedDistribution.tresLent}`,
    '',
    `Haute liquidité (70+): ${s.highLiquidity}`,
    `Liquidité moyenne (40-69): ${s.mediumLiquidity}`,
    `Faible liquidité (<40): ${s.lowLiquidity}`,
    ''
  ];

  // Top 3 meilleures opportunités par marge ajustée
  const top = result.opportunities
    .filter((o) => o.liquidity.liquidityScore > 0)
    .slice(0, 3);

  if (top.length > 0) {
    lines.push('--- TOP PAR MARGE AJUSTÉE ---');
    for (const [i, opp] of top.entries()) {
      const l = opp.liquidity.summary;
      lines.push(`${i + 1}. ${(opp.title || '').slice(0, 50)}`);
      lines.push(`   ${l.speedEmoji} ${l.speedLabel} (~${l.estimatedDays}j) | Score: ${l.score}/100`);
      lines.push(`   Marge brute: ${l.adjustedMarginPercent > 0 ? round2(opp.profit?.profitPercent || 0) : 0}% → Ajustée: ${l.adjustedMarginPercent}%`);
      lines.push('');
    }
  }

  lines.push(`Analyse: ${new Date().toLocaleTimeString('fr-FR')}`);
  return lines.join('\n').trim();
}

// ─── Exports ───────────────────────────────────────────────────────

module.exports = {
  // Agent principal
  assessLiquidity,
  analyzeLiquidity,

  // Composantes d'analyse
  analyzeVolume,
  analyzeSpeed,
  analyzeStability,

  // Calculs
  computeLiquidityScore,
  computeAdjustedMargin,
  computeCapitalLockup,
  classifyLiquidityScore,
  classifySpeed,
  computeSpeedScore,

  // Telegram
  buildLiquidityTelegramSnippet,
  buildLiquidityReportMessage,

  // Constantes
  SPEED_TIERS,
  WEIGHTS,
  LOOKBACK_DAYS
};
