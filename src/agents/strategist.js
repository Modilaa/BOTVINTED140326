/**
 * Agent Strategist — Gestion du portefeuille et strategie d'investissement par palier.
 *
 * Responsabilites :
 *   1. Tracker capital, achats en cours, ventes realisees, ROI
 *   2. Definir des paliers de croissance avec regles d'investissement
 *   3. Evaluer chaque opportunite par rapport au palier actuel
 *   4. Generer des recommandations contextuelles et scores de priorite
 *   5. Alertes Telegram : rapport hebdo, changement de palier, opportunites
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { sendTelegramMessage } = require('../notifier');
const { analyzeLiquidity } = require('./liquidity');

// ─── Chemins ────────────────────────────────────────────────────────

const PORTFOLIO_PATH = path.join(config.outputDir, 'portfolio.json');

// ─── Paliers de strategie ───────────────────────────────────────────

const TIERS = [
  {
    id: 1,
    name: 'Demarrage prudent',
    minCapital: 0,
    maxCapital: 1000,
    maxPerPurchase: 20,
    targetFlipsPerWeek: { min: 10, max: 15 },
    targetMarginPercent: 50,
    reinvestPercent: 80,
    allowedCategories: ['tcg'],
    description: 'Focus cartes TCG, petits achats, volume eleve'
  },
  {
    id: 2,
    name: 'Diversification',
    minCapital: 1000,
    maxCapital: 2500,
    maxPerPurchase: 50,
    targetFlipsPerWeek: { min: 15, max: 20 },
    targetMarginPercent: 40,
    reinvestPercent: 70,
    allowedCategories: ['tcg', 'sneakers', 'lego'],
    description: 'Ajouter sneakers et LEGO, acheter des lots'
  },
  {
    id: 3,
    name: 'Montee en gamme',
    minCapital: 2500,
    maxCapital: 5000,
    maxPerPurchase: 150,
    targetFlipsPerWeek: { min: 10, max: 15 },
    targetMarginPercent: 35,
    reinvestPercent: 60,
    allowedCategories: ['tcg', 'sneakers', 'lego', 'tech', 'montres', 'vetements'],
    description: 'Tech, montres vintage, vetements de marque, outils pro'
  },
  {
    id: 4,
    name: 'Scale',
    minCapital: 5000,
    maxCapital: Infinity,
    maxPerPurchase: 500,
    targetFlipsPerWeek: { min: 15, max: 30 },
    targetMarginPercent: 30,
    reinvestPercent: 50,
    allowedCategories: ['tcg', 'sneakers', 'lego', 'tech', 'montres', 'vetements', 'premium'],
    description: 'Produits premium, sealed boxes, automatisation, auto-entrepreneur'
  }
];

// ─── Persistence ────────────────────────────────────────────────────

function loadPortfolio() {
  try {
    if (fs.existsSync(PORTFOLIO_PATH)) {
      const raw = fs.readFileSync(PORTFOLIO_PATH, 'utf8');
      if (raw && raw.trim()) return JSON.parse(raw);
    }
  } catch (err) {
    console.error(`[Strategist] Erreur lecture portfolio: ${err.message}`);
  }
  return createDefaultPortfolio();
}

function savePortfolio(portfolio) {
  const dir = path.dirname(PORTFOLIO_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  portfolio.updatedAt = new Date().toISOString();
  fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(portfolio, null, 2), 'utf8');
}

function createDefaultPortfolio() {
  return {
    initialCapital: 500,
    currentCapital: 500,
    totalInvested: 0,
    totalRevenue: 0,
    totalProfit: 0,
    totalFees: 0,
    purchases: [],
    sales: [],
    tierHistory: [
      { tier: 1, reachedAt: new Date().toISOString(), capital: 500 }
    ],
    weeklyReports: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// ─── Calculs du portefeuille ────────────────────────────────────────

/**
 * Retourne le palier actuel base sur le capital total (capital + valeur en cours).
 */
function getCurrentTier(portfolio) {
  const totalValue = getTotalPortfolioValue(portfolio);
  // On cherche le palier le plus eleve dont on depasse le minimum
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (totalValue >= TIERS[i].minCapital) {
      return TIERS[i];
    }
  }
  return TIERS[0];
}

/**
 * Valeur totale = capital disponible + valeur d'achat des articles en stock.
 */
function getTotalPortfolioValue(portfolio) {
  const pendingValue = getPendingPurchasesValue(portfolio);
  return portfolio.currentCapital + pendingValue;
}

/**
 * Valeur des achats en cours (non encore vendus).
 */
function getPendingPurchasesValue(portfolio) {
  const pendingPurchases = portfolio.purchases.filter((p) => p.status === 'in_stock');
  return pendingPurchases.reduce((sum, p) => sum + p.totalCost, 0);
}

/**
 * Solde disponible = capital liquide (ce qu'on peut depenser).
 */
function getAvailableBalance(portfolio) {
  return portfolio.currentCapital;
}

/**
 * ROI global en pourcentage.
 */
function getROI(portfolio) {
  if (portfolio.initialCapital <= 0) return 0;
  const totalValue = getTotalPortfolioValue(portfolio);
  return round2(((totalValue - portfolio.initialCapital) / portfolio.initialCapital) * 100);
}

/**
 * ROI de la semaine en cours.
 */
function getWeeklyROI(portfolio) {
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekSales = portfolio.sales.filter((s) => new Date(s.soldAt).getTime() > oneWeekAgo);
  const weekProfit = weekSales.reduce((sum, s) => sum + s.netProfit, 0);
  const weekInvestment = portfolio.purchases
    .filter((p) => new Date(p.purchasedAt).getTime() > oneWeekAgo)
    .reduce((sum, p) => sum + p.totalCost, 0);
  if (weekInvestment <= 0) return { profit: round2(weekProfit), roi: 0, salesCount: weekSales.length };
  return {
    profit: round2(weekProfit),
    roi: round2((weekProfit / weekInvestment) * 100),
    salesCount: weekSales.length
  };
}

/**
 * Progression vers le palier suivant (en %).
 */
function getProgressToNextTier(portfolio) {
  const currentTier = getCurrentTier(portfolio);
  const totalValue = getTotalPortfolioValue(portfolio);

  if (currentTier.id >= TIERS.length) {
    return { currentTier: currentTier.id, progress: 100, remaining: 0, nextTierCapital: null };
  }

  const nextTier = TIERS.find((t) => t.id === currentTier.id + 1);
  if (!nextTier) {
    return { currentTier: currentTier.id, progress: 100, remaining: 0, nextTierCapital: null };
  }

  const range = nextTier.minCapital - currentTier.minCapital;
  const position = totalValue - currentTier.minCapital;
  const progress = range > 0 ? Math.min(100, round2((position / range) * 100)) : 100;
  const remaining = Math.max(0, round2(nextTier.minCapital - totalValue));

  return {
    currentTier: currentTier.id,
    currentTierName: currentTier.name,
    progress,
    remaining,
    nextTierCapital: nextTier.minCapital,
    nextTierName: nextTier.name
  };
}

// ─── Enregistrement d'achats et ventes ──────────────────────────────

/**
 * Enregistre un achat dans le portefeuille.
 */
function recordPurchase(portfolio, purchase) {
  const {
    productName,
    purchasePrice,
    shippingCost = 0,
    platform = 'vinted',
    category = 'tcg',
    estimatedSalePrice = null,
    url = null,
    imageUrl = null,
    notes = ''
  } = purchase;

  const totalCost = round2(purchasePrice + shippingCost);

  if (totalCost > portfolio.currentCapital) {
    return { success: false, error: 'Capital insuffisant', available: portfolio.currentCapital, needed: totalCost };
  }

  const tier = getCurrentTier(portfolio);
  if (purchasePrice > tier.maxPerPurchase) {
    return {
      success: false,
      error: `Depasse le budget max par achat pour le palier ${tier.id} (${tier.name})`,
      maxAllowed: tier.maxPerPurchase,
      requested: purchasePrice
    };
  }

  const id = `PUR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const entry = {
    id,
    productName,
    purchasePrice: round2(purchasePrice),
    shippingCost: round2(shippingCost),
    totalCost,
    platform,
    category,
    estimatedSalePrice: estimatedSalePrice ? round2(estimatedSalePrice) : null,
    estimatedProfit: estimatedSalePrice ? round2(estimatedSalePrice - totalCost) : null,
    url,
    imageUrl,
    notes,
    status: 'in_stock',
    purchasedAt: new Date().toISOString()
  };

  portfolio.purchases.push(entry);
  portfolio.currentCapital = round2(portfolio.currentCapital - totalCost);
  portfolio.totalInvested = round2(portfolio.totalInvested + totalCost);

  // Verifier changement de palier
  const newTier = getCurrentTier(portfolio);
  const lastTierEntry = portfolio.tierHistory[portfolio.tierHistory.length - 1];
  if (newTier.id !== lastTierEntry.tier) {
    portfolio.tierHistory.push({
      tier: newTier.id,
      reachedAt: new Date().toISOString(),
      capital: getTotalPortfolioValue(portfolio)
    });
  }

  savePortfolio(portfolio);
  return { success: true, purchase: entry, newBalance: portfolio.currentCapital };
}

/**
 * Enregistre une vente dans le portefeuille.
 */
function recordSale(portfolio, sale) {
  const {
    purchaseId,
    salePrice,
    salePlatform = 'ebay',
    platformFees = null,
    shippingCost = 0,
    notes = ''
  } = sale;

  // Trouver l'achat correspondant
  const purchaseIndex = portfolio.purchases.findIndex((p) => p.id === purchaseId && p.status === 'in_stock');
  if (purchaseIndex === -1) {
    return { success: false, error: 'Achat non trouve ou deja vendu' };
  }

  const purchase = portfolio.purchases[purchaseIndex];

  // Calculer les frais de plateforme si non fournis
  let fees = platformFees;
  if (fees === null) {
    const feeConfig = {
      ebay: 0.13 + 0.03 + 0.02,   // 18% total (commission + paiement + promo)
      vinted: 0.05,
      cardmarket: 0.05 + 0.03,
      leboncoin: 0
    };
    const feeRate = feeConfig[salePlatform] || 0.13;
    fees = round2(salePrice * feeRate + (salePlatform === 'ebay' ? 0.30 : 0));
  }

  const totalFees = round2(fees + shippingCost);
  const netRevenue = round2(salePrice - totalFees);
  const netProfit = round2(netRevenue - purchase.totalCost);
  const profitPercent = purchase.totalCost > 0 ? round2((netProfit / purchase.totalCost) * 100) : 0;

  const id = `SALE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const entry = {
    id,
    purchaseId,
    productName: purchase.productName,
    purchasePrice: purchase.totalCost,
    salePrice: round2(salePrice),
    salePlatform,
    platformFees: round2(fees),
    shippingCost: round2(shippingCost),
    totalFees,
    netRevenue,
    netProfit,
    profitPercent,
    holdDays: Math.floor((Date.now() - new Date(purchase.purchasedAt).getTime()) / (24 * 60 * 60 * 1000)),
    notes,
    soldAt: new Date().toISOString()
  };

  // Mettre a jour l'achat
  portfolio.purchases[purchaseIndex].status = 'sold';
  portfolio.purchases[purchaseIndex].saleId = id;
  portfolio.purchases[purchaseIndex].soldAt = entry.soldAt;

  // Ajouter la vente
  portfolio.sales.push(entry);

  // Mettre a jour le capital
  portfolio.currentCapital = round2(portfolio.currentCapital + netRevenue);
  portfolio.totalRevenue = round2(portfolio.totalRevenue + netRevenue);
  portfolio.totalProfit = round2(portfolio.totalProfit + netProfit);
  portfolio.totalFees = round2(portfolio.totalFees + totalFees);

  // Verifier changement de palier
  const previousTier = portfolio.tierHistory[portfolio.tierHistory.length - 1].tier;
  const newTier = getCurrentTier(portfolio);
  if (newTier.id !== previousTier) {
    portfolio.tierHistory.push({
      tier: newTier.id,
      reachedAt: new Date().toISOString(),
      capital: getTotalPortfolioValue(portfolio)
    });
  }

  savePortfolio(portfolio);
  return { success: true, sale: entry, newBalance: portfolio.currentCapital, tierChanged: newTier.id !== previousTier, newTier: newTier.id };
}

// ─── Recommandations contextuelles ──────────────────────────────────

/**
 * Categorise un produit depuis le nom de la recherche config.
 */
function categorizeProduct(searchName) {
  const lower = (searchName || '').toLowerCase();
  if (lower.includes('pokemon') || lower.includes('yu-gi-oh') || lower.includes('yugioh') ||
      lower.includes('one piece') || lower.includes('topps') || lower.includes('panini') ||
      lower.includes('tcg') || lower.includes('card')) {
    return 'tcg';
  }
  if (lower.includes('sneaker') || lower.includes('jordan') || lower.includes('nike') || lower.includes('yeezy')) {
    return 'sneakers';
  }
  if (lower.includes('lego')) return 'lego';
  if (lower.includes('tech') || lower.includes('iphone') || lower.includes('samsung') || lower.includes('console')) {
    return 'tech';
  }
  if (lower.includes('montre') || lower.includes('watch')) return 'montres';
  if (lower.includes('vetement') || lower.includes('marque') || lower.includes('supreme') || lower.includes('nike')) {
    return 'vetements';
  }
  return 'tcg'; // Par defaut = TCG (le focus du bot)
}

/**
 * Evalue une opportunite par rapport au palier actuel.
 * Retourne un objet avec score de priorite, recommandation, et raison.
 */
function evaluateOpportunity(portfolio, opportunity) {
  const tier = getCurrentTier(portfolio);
  const available = getAvailableBalance(portfolio);

  const buyerPrice = opportunity.vintedBuyerPrice || opportunity.vintedListedPrice || 0;
  const estimatedSale = opportunity.profit ? opportunity.profit.averageSoldPrice : 0;
  const estimatedProfit = opportunity.profit ? opportunity.profit.profit : 0;
  const profitPercent = opportunity.profit ? opportunity.profit.profitPercent : 0;
  const category = categorizeProduct(opportunity.search || '');

  // Analyse de liquidité (utilise les données pré-calculées si dispo, sinon calcule)
  let liquidityData = opportunity.liquidity || null;
  if (!liquidityData) {
    try {
      liquidityData = analyzeLiquidity(opportunity);
    } catch { liquidityData = null; }
  }

  const adjustedMarginPercent = liquidityData
    ? liquidityData.adjustedMargin.adjustedMarginPercent
    : profitPercent;
  const liquidityScore = liquidityData ? liquidityData.liquidityScore : null;

  const result = {
    opportunityTitle: (opportunity.title || '').slice(0, 60),
    buyerPrice: round2(buyerPrice),
    estimatedSalePrice: round2(estimatedSale),
    estimatedProfit: round2(estimatedProfit),
    profitPercent: round2(profitPercent),
    adjustedMarginPercent: round2(adjustedMarginPercent),
    liquidityScore,
    category,
    tier: tier.id,
    tierName: tier.name,
    score: 0,
    verdict: 'skip',
    reasons: [],
    recommendation: ''
  };

  // Check budget
  if (buyerPrice > available) {
    result.verdict = 'skip';
    result.reasons.push(`Capital insuffisant: ${round2(available)}EUR dispo vs ${round2(buyerPrice)}EUR necessaire`);
    result.recommendation = `Pas assez de capital. Il te manque ${round2(buyerPrice - available)}EUR.`;
    return result;
  }

  // Check max par achat pour le palier
  if (buyerPrice > tier.maxPerPurchase) {
    result.verdict = 'skip';
    result.reasons.push(`Depasse le max par achat du palier ${tier.id}: ${tier.maxPerPurchase}EUR`);
    result.recommendation = `Ce produit a ${round2(buyerPrice)}EUR depasse ton budget max par achat (${tier.maxPerPurchase}EUR) pour le palier "${tier.name}". Attends de monter de palier.`;
    return result;
  }

  // Check categorie autorisee
  if (!tier.allowedCategories.includes(category)) {
    result.verdict = 'attendre';
    result.reasons.push(`Categorie "${category}" non autorisee au palier ${tier.id}`);
    result.recommendation = `La categorie "${category}" n'est pas encore dans ta strategie au palier "${tier.name}". Focus sur: ${tier.allowedCategories.join(', ')}.`;
    result.score = 10;
    return result;
  }

  // Scoring (utilise la marge ajustée par la liquidité)
  let score = 0;
  const effectiveMargin = adjustedMarginPercent;

  // Marge ajustée (0-40 points) — prend en compte la liquidité
  if (effectiveMargin >= 80) score += 40;
  else if (effectiveMargin >= tier.targetMarginPercent) score += 30;
  else if (effectiveMargin >= 15) score += 15;
  else score += 5;

  // Bonus liquidité (0-10 points)
  if (liquidityScore !== null) {
    if (liquidityScore >= 80) score += 10;
    else if (liquidityScore >= 60) score += 7;
    else if (liquidityScore >= 40) score += 3;
    else score -= 5; // Pénalité faible liquidité
  }

  // Prix d'achat adapte au palier (0-20 points)
  const priceRatio = buyerPrice / tier.maxPerPurchase;
  if (priceRatio <= 0.3) score += 20;       // Petit achat = moins de risque
  else if (priceRatio <= 0.6) score += 15;
  else if (priceRatio <= 0.8) score += 10;
  else score += 5;

  // Profit absolu (0-20 points)
  if (estimatedProfit >= 20) score += 20;
  else if (estimatedProfit >= 10) score += 15;
  else if (estimatedProfit >= 5) score += 10;
  else score += 5;

  // Bonus categorie favorisee (0-10 points)
  if (tier.id === 1 && category === 'tcg') score += 10;
  if (tier.id === 2 && (category === 'sneakers' || category === 'lego')) score += 10;
  if (tier.id >= 3 && (category === 'tech' || category === 'montres')) score += 10;

  // Penalite si ca prend trop du capital dispo
  const capitalRisk = buyerPrice / available;
  if (capitalRisk > 0.5) score -= 10;
  if (capitalRisk > 0.8) score -= 15;

  result.score = Math.max(0, Math.min(100, score));

  // Verdict (basé sur marge ajustée)
  const liqInfo = liquidityScore !== null ? ` | Liquidité: ${liquidityScore}/100` : '';
  if (result.score >= 70) {
    result.verdict = 'acheter';
    result.recommendation = `Excellente opportunite ! ${(opportunity.title || '').slice(0, 40)} a ${round2(buyerPrice)}EUR → ${round2(estimatedSale)}EUR = +${round2(estimatedProfit)}EUR (marge ajustee: ${round2(adjustedMarginPercent)}%)${liqInfo}`;
  } else if (result.score >= 45) {
    result.verdict = 'interessant';
    result.recommendation = `Opportunite correcte. ${round2(buyerPrice)}EUR -> ~${round2(estimatedSale)}EUR (marge ajustee: ${round2(adjustedMarginPercent)}%). Compatible palier "${tier.name}"${liqInfo}`;
  } else if (result.score >= 25) {
    result.verdict = 'prudence';
    result.recommendation = `Marge ajustee faible (${round2(adjustedMarginPercent)}%) ou liquidite insuffisante. A considerer seulement si rien de mieux.${liqInfo}`;
  } else {
    result.verdict = 'skip';
    result.recommendation = `Pas assez rentable apres ajustement liquidite (${round2(adjustedMarginPercent)}%). Focus sur des opportunites a marge ajustee >15%.${liqInfo}`;
  }

  return result;
}

/**
 * Evalue un lot d'opportunites et les trie par score de priorite.
 */
function evaluateOpportunities(portfolio, opportunities) {
  const evaluations = opportunities.map((opp) => evaluateOpportunity(portfolio, opp));
  evaluations.sort((a, b) => b.score - a.score);
  return evaluations;
}

// ─── Rapports et alertes Telegram ───────────────────────────────────

/**
 * Genere le rapport hebdomadaire.
 */
function generateWeeklyReport(portfolio) {
  const tier = getCurrentTier(portfolio);
  const progress = getProgressToNextTier(portfolio);
  const weeklyStats = getWeeklyROI(portfolio);
  const totalValue = getTotalPortfolioValue(portfolio);
  const roi = getROI(portfolio);
  const pendingCount = portfolio.purchases.filter((p) => p.status === 'in_stock').length;
  const pendingValue = getPendingPurchasesValue(portfolio);

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalPortfolioValue: round2(totalValue),
      currentCapital: round2(portfolio.currentCapital),
      pendingStock: { count: pendingCount, value: round2(pendingValue) },
      globalROI: roi,
      tier: { id: tier.id, name: tier.name },
      progressToNextTier: progress
    },
    weekly: weeklyStats,
    totals: {
      invested: portfolio.totalInvested,
      revenue: portfolio.totalRevenue,
      profit: portfolio.totalProfit,
      fees: portfolio.totalFees,
      totalPurchases: portfolio.purchases.length,
      totalSales: portfolio.sales.length
    }
  };

  // Sauvegarder dans l'historique
  portfolio.weeklyReports.push(report);
  // Garder les 52 derniers rapports (1 an)
  if (portfolio.weeklyReports.length > 52) {
    portfolio.weeklyReports = portfolio.weeklyReports.slice(-52);
  }
  savePortfolio(portfolio);

  return report;
}

/**
 * Construit le message Telegram du rapport hebdo.
 */
function buildWeeklyReportMessage(report) {
  const s = report.summary;
  const w = report.weekly;
  const p = report.summary.progressToNextTier;

  const lines = [
    '=== RAPPORT HEBDO PORTEFEUILLE ===',
    '',
    `Capital total: ${s.totalPortfolioValue} EUR`,
    `  Liquide: ${s.currentCapital} EUR`,
    `  En stock: ${s.pendingStock.count} articles (${s.pendingStock.value} EUR)`,
    '',
    `ROI global: ${s.globalROI}%`,
    `Palier actuel: ${s.tier.id} - ${s.tier.name}`,
    '',
    '--- Cette semaine ---',
    `Ventes: ${w.salesCount}`,
    `Profit: ${w.profit} EUR`,
    `ROI semaine: ${w.roi}%`,
    ''
  ];

  if (p.nextTierCapital) {
    lines.push(`Progression palier ${p.currentTier} -> ${p.currentTier + 1}: ${p.progress}%`);
    lines.push(`Il reste ${p.remaining} EUR pour atteindre "${p.nextTierName}"`);
  } else {
    lines.push('Palier maximum atteint !');
  }

  lines.push('');
  lines.push(`Totaux: ${report.totals.totalPurchases} achats, ${report.totals.totalSales} ventes`);
  lines.push(`Profit cumule: ${report.totals.profit} EUR`);

  return lines.join('\n');
}

/**
 * Construit un message d'alerte changement de palier.
 */
function buildTierChangeMessage(portfolio, newTierId) {
  const tier = TIERS.find((t) => t.id === newTierId);
  if (!tier) return null;

  const totalValue = getTotalPortfolioValue(portfolio);

  const lines = [
    '=== CHANGEMENT DE PALIER ===',
    '',
    `Nouveau palier: ${tier.id} - ${tier.name}`,
    `Capital total: ${round2(totalValue)} EUR`,
    '',
    `Nouvelles regles:`,
    `  Max par achat: ${tier.maxPerPurchase} EUR`,
    `  Objectif flips/semaine: ${tier.targetFlipsPerWeek.min}-${tier.targetFlipsPerWeek.max}`,
    `  Marge cible: ${tier.targetMarginPercent}%+`,
    `  Categories: ${tier.allowedCategories.join(', ')}`,
    '',
    tier.description
  ];

  return lines.join('\n');
}

/**
 * Construit un message pour une opportunite recommandee.
 */
function buildOpportunityAlertMessage(evaluation) {
  if (evaluation.verdict === 'skip') return null;

  const emoji = {
    acheter: 'ACHETER',
    interessant: 'INTERESSANT',
    prudence: 'PRUDENCE',
    attendre: 'ATTENDRE'
  };

  const lines = [
    `=== OPPORTUNITE: ${emoji[evaluation.verdict] || evaluation.verdict.toUpperCase()} ===`,
    '',
    evaluation.opportunityTitle,
    `Achat: ${evaluation.buyerPrice} EUR`,
    `Revente estimee: ${evaluation.estimatedSalePrice} EUR`,
    `Profit estime: ${evaluation.estimatedProfit} EUR (${evaluation.profitPercent}%)`,
    `Score: ${evaluation.score}/100`,
    `Palier: ${evaluation.tierName}`,
    '',
    evaluation.recommendation
  ];

  return lines.join('\n');
}

// ─── Envoi des alertes Telegram ─────────────────────────────────────

/**
 * Envoie le rapport hebdomadaire par Telegram.
 */
async function sendWeeklyReport(portfolio) {
  const report = generateWeeklyReport(portfolio);
  const message = buildWeeklyReportMessage(report);

  if (config.telegram.token && config.telegram.chatId) {
    try {
      await sendTelegramMessage(config.telegram, message);
      console.log('[Strategist] Rapport hebdo envoye par Telegram');
    } catch (err) {
      console.error(`[Strategist] Erreur envoi rapport: ${err.message}`);
    }
  }

  return report;
}

/**
 * Envoie une alerte de changement de palier.
 */
async function sendTierChangeAlert(portfolio, newTierId) {
  const message = buildTierChangeMessage(portfolio, newTierId);
  if (!message) return;

  if (config.telegram.token && config.telegram.chatId) {
    try {
      await sendTelegramMessage(config.telegram, message);
      console.log(`[Strategist] Alerte changement palier ${newTierId} envoyee`);
    } catch (err) {
      console.error(`[Strategist] Erreur alerte palier: ${err.message}`);
    }
  }
}

/**
 * Envoie une alerte pour les top opportunites du scan.
 */
async function sendTopOpportunitiesAlert(evaluations) {
  const top = evaluations.filter((e) => e.verdict === 'acheter' || e.verdict === 'interessant').slice(0, 3);
  if (top.length === 0) return;

  const lines = [
    `=== ${top.length} OPPORTUNITE(S) POUR TON PALIER ===`,
    ''
  ];

  for (const [i, ev] of top.entries()) {
    lines.push(`${i + 1}. [${ev.verdict.toUpperCase()}] ${ev.opportunityTitle}`);
    lines.push(`   ${ev.buyerPrice} EUR -> ${ev.estimatedSalePrice} EUR (+${ev.estimatedProfit} EUR, ${ev.profitPercent}%)`);
    lines.push(`   Score: ${ev.score}/100`);
    lines.push('');
  }

  const message = lines.join('\n').trim();

  if (config.telegram.token && config.telegram.chatId) {
    try {
      await sendTelegramMessage(config.telegram, message);
      console.log(`[Strategist] Alerte top opportunites envoyee (${top.length})`);
    } catch (err) {
      console.error(`[Strategist] Erreur alerte opportunites: ${err.message}`);
    }
  }
}

// ─── Endpoint donnees portefeuille (pour le dashboard) ──────────────

/**
 * Retourne les donnees completes du portefeuille pour l'API dashboard.
 */
function getPortfolioData() {
  const portfolio = loadPortfolio();
  const tier = getCurrentTier(portfolio);
  const progress = getProgressToNextTier(portfolio);
  const weeklyStats = getWeeklyROI(portfolio);
  const totalValue = getTotalPortfolioValue(portfolio);
  const pendingPurchases = portfolio.purchases.filter((p) => p.status === 'in_stock');

  return {
    // Resume
    totalPortfolioValue: round2(totalValue),
    currentCapital: round2(portfolio.currentCapital),
    availableBalance: round2(getAvailableBalance(portfolio)),
    globalROI: getROI(portfolio),

    // Palier
    tier: {
      id: tier.id,
      name: tier.name,
      maxPerPurchase: tier.maxPerPurchase,
      targetMarginPercent: tier.targetMarginPercent,
      targetFlipsPerWeek: tier.targetFlipsPerWeek,
      allowedCategories: tier.allowedCategories,
      description: tier.description
    },
    progress,

    // Semaine
    weekly: weeklyStats,

    // Stock en cours
    pendingStock: {
      count: pendingPurchases.length,
      value: round2(getPendingPurchasesValue(portfolio)),
      items: pendingPurchases.slice(-20).reverse()
    },

    // Historique recent
    recentSales: portfolio.sales.slice(-10).reverse(),
    recentPurchases: portfolio.purchases.slice(-10).reverse(),

    // Totaux
    totals: {
      invested: portfolio.totalInvested,
      revenue: portfolio.totalRevenue,
      profit: portfolio.totalProfit,
      fees: portfolio.totalFees,
      purchaseCount: portfolio.purchases.length,
      saleCount: portfolio.sales.length
    },

    // Historique paliers
    tierHistory: portfolio.tierHistory,

    // Config paliers (reference)
    allTiers: TIERS.map((t) => ({
      id: t.id,
      name: t.name,
      minCapital: t.minCapital,
      maxCapital: t.maxCapital === Infinity ? null : t.maxCapital,
      maxPerPurchase: t.maxPerPurchase,
      description: t.description
    }))
  };
}

// ─── Agent principal (integration pipeline) ─────────────────────────

/**
 * Lance l'agent strategiste dans le pipeline.
 * Evalue les opportunites confirmees et envoie les alertes.
 *
 * @param {Array} opportunities - Opportunites (confirmees par le superviseur de preference)
 * @param {Object} opts - { sendTelegram: boolean }
 * @returns {Object} Resultat avec evaluations et rapport
 */
async function strategize(opportunities, opts = {}) {
  const { sendTelegram = true } = opts;

  console.log(`[Strategist] Evaluation de ${opportunities.length} opportunite(s)...`);

  const portfolio = loadPortfolio();
  const tier = getCurrentTier(portfolio);
  const totalValue = getTotalPortfolioValue(portfolio);

  console.log(`[Strategist] Palier actuel: ${tier.id} - ${tier.name} (capital: ${round2(totalValue)} EUR)`);
  console.log(`[Strategist] Solde disponible: ${round2(getAvailableBalance(portfolio))} EUR`);

  // Evaluer toutes les opportunites
  const evaluations = evaluateOpportunities(portfolio, opportunities);

  const summary = {
    total: evaluations.length,
    acheter: evaluations.filter((e) => e.verdict === 'acheter').length,
    interessant: evaluations.filter((e) => e.verdict === 'interessant').length,
    prudence: evaluations.filter((e) => e.verdict === 'prudence').length,
    skip: evaluations.filter((e) => e.verdict === 'skip').length,
    tier: tier.id,
    tierName: tier.name,
    portfolioValue: round2(totalValue),
    availableBalance: round2(getAvailableBalance(portfolio))
  };

  console.log(`[Strategist] Resultats: ${summary.acheter} a acheter, ${summary.interessant} interessant(s), ${summary.prudence} prudence, ${summary.skip} skip`);

  // Alertes Telegram
  if (sendTelegram) {
    await sendTopOpportunitiesAlert(evaluations);

    // Rapport hebdo si c'est le bon moment (dimanche ou lundi, ou premier run)
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 = dimanche, 1 = lundi
    const lastReport = portfolio.weeklyReports[portfolio.weeklyReports.length - 1];
    const lastReportAge = lastReport ? Date.now() - new Date(lastReport.generatedAt).getTime() : Infinity;

    if (dayOfWeek <= 1 && lastReportAge > 24 * 60 * 60 * 1000) {
      await sendWeeklyReport(portfolio);
    }
  }

  return {
    evaluations,
    summary,
    portfolio: {
      totalValue: round2(totalValue),
      currentCapital: round2(portfolio.currentCapital),
      tier: { id: tier.id, name: tier.name },
      progress: getProgressToNextTier(portfolio)
    }
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function round2(value) {
  return Math.round((value || 0) * 100) / 100;
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  // Agent principal
  strategize,

  // Gestion portefeuille
  loadPortfolio,
  savePortfolio,
  recordPurchase,
  recordSale,
  getPortfolioData,

  // Calculs
  getCurrentTier,
  getTotalPortfolioValue,
  getAvailableBalance,
  getROI,
  getWeeklyROI,
  getProgressToNextTier,

  // Evaluation
  evaluateOpportunity,
  evaluateOpportunities,
  categorizeProduct,

  // Rapports
  generateWeeklyReport,
  sendWeeklyReport,
  sendTierChangeAlert,
  sendTopOpportunitiesAlert,

  // Messages
  buildWeeklyReportMessage,
  buildTierChangeMessage,
  buildOpportunityAlertMessage,

  // Constantes
  TIERS,
  PORTFOLIO_PATH
};
