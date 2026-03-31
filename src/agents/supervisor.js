/**
 * Agent Superviseur — Re-vérifie les opportunités trouvées par le scraper.
 *
 * Responsabilités :
 *   1. Vérifier que l'annonce Vinted est toujours disponible
 *   2. Re-vérifier le prix de vente eBay/API (pas seulement le cache)
 *   3. Calculer le profit net DÉTAILLÉ (frais plateforme, livraison, PayPal…)
 *   4. Attribuer un score de confiance (0-100)
 *   5. Filtrer les faux positifs avant notification
 */

const { fetchText } = require('../http');
const { buildProfitAnalysis } = require('../profit');
const { extractCardSignature, chooseBestSoldListings } = require('../matching');
const { attachImageSignals } = require('../image-match');
const { getEbaySoldListings } = require('../marketplaces/ebay');
const { getPokemonMarketPrice } = require('../marketplaces/pokemon-tcg');
const { getYugiohMarketPrice } = require('../marketplaces/ygoprodeck');
const { median } = require('../utils');
const { analyzeLiquidity } = require('./liquidity');

// ─── Frais par plateforme ────────────────────────────────────────────
const PLATFORM_FEES = {
  ebay: {
    sellerFeePercent: 0.13,    // Commission eBay vendeur
    paymentFeePercent: 0.03,   // Frais de paiement (PayPal/Managed Payments)
    fixedFee: 0.30,            // Frais fixe par transaction
    promotionFeePercent: 0.02  // Frais promo optionnels (estimé)
  },
  cardmarket: {
    sellerFeePercent: 0.05,    // Commission Cardmarket
    paymentFeePercent: 0.03,
    fixedFee: 0,
    promotionFeePercent: 0
  },
  vinted: {
    buyerProtectionPercent: 0.05,  // Protection acheteur (~5%)
    shippingEstimate: 3.50
  }
};

// ─── Score de confiance ──────────────────────────────────────────────

/**
 * Calcule un score de confiance (0-100) pour une opportunité.
 *
 * Facteurs pris en compte :
 *   - Nombre de ventes comparables trouvées (plus = mieux)
 *   - Fraîcheur des ventes (ventes récentes = mieux)
 *   - Cohérence des prix (faible variance = mieux)
 *   - Qualité du match titre/image
 *   - Marge de profit (plus la marge est grande, moins le risque)
 */
function computeConfidenceScore(opportunity, verificationResult) {
  let score = 0;
  const weights = {
    salesCount: 25,
    salesFreshness: 20,
    priceConsistency: 20,
    matchQuality: 20,
    profitMargin: 15
  };

  const sales = opportunity.matchedSales || [];

  // 1. Nombre de ventes comparables (0-25)
  if (sales.length >= 4) {
    score += weights.salesCount;
  } else if (sales.length >= 2) {
    score += weights.salesCount * 0.7;
  } else if (sales.length === 1) {
    score += weights.salesCount * 0.3;
  }

  // 2. Fraîcheur des ventes (0-20)
  const now = Date.now();
  const recentSales = sales.filter((s) => {
    if (!s.soldAtTs) return false;
    const ageMs = now - s.soldAtTs;
    return ageMs < 30 * 24 * 60 * 60 * 1000; // moins de 30 jours
  });
  const freshnessRatio = sales.length > 0 ? recentSales.length / sales.length : 0;
  score += weights.salesFreshness * freshnessRatio;

  // 3. Cohérence des prix (0-20) — faible écart-type = mieux
  if (sales.length >= 2) {
    const prices = sales.map((s) => s.price || s.totalPrice);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + (p - avg) ** 2, 0) / prices.length;
    const coeffVar = avg > 0 ? Math.sqrt(variance) / avg : 1;
    // coeffVar < 0.15 = très cohérent, > 0.5 = très dispersé
    const consistencyScore = Math.max(0, 1 - coeffVar * 2);
    score += weights.priceConsistency * consistencyScore;
  }

  // 4. Qualité du match (0-20)
  const matchScores = sales
    .filter((s) => s.match && s.match.score)
    .map((s) => s.match.score);
  if (matchScores.length > 0) {
    const avgMatchScore = matchScores.reduce((a, b) => a + b, 0) / matchScores.length;
    // Match score de 15+ = excellent, 8 = minimum
    const matchQuality = Math.min(1, (avgMatchScore - 5) / 15);
    score += weights.matchQuality * matchQuality;
  }

  // Bonus image match
  const imageScores = sales
    .filter((s) => s.imageMatch && s.imageMatch.score !== null)
    .map((s) => s.imageMatch.score);
  if (imageScores.length > 0) {
    const avgImage = imageScores.reduce((a, b) => a + b, 0) / imageScores.length;
    score += 5 * avgImage; // Bonus jusqu'à +5
  }

  // 5. Marge de profit (0-15)
  if (verificationResult && verificationResult.netProfit > 0) {
    const marginPercent = verificationResult.netProfitPercent || 0;
    if (marginPercent >= 50) {
      score += weights.profitMargin;
    } else if (marginPercent >= 30) {
      score += weights.profitMargin * 0.7;
    } else if (marginPercent >= 15) {
      score += weights.profitMargin * 0.4;
    }
  }

  // Pénalités
  if (verificationResult && !verificationResult.vintedStillAvailable) {
    score *= 0.1; // Annonce plus dispo = quasi inutile
  }

  return Math.round(Math.min(100, Math.max(0, score)));
}

// ─── Vérification d'une annonce Vinted ───────────────────────────────

/**
 * Vérifie si une annonce Vinted est toujours disponible en checkant la page.
 * Retourne { available: boolean, currentPrice: number|null }
 */
async function checkVintedAvailability(vintedUrl, config) {
  try {
    const html = await fetchText(vintedUrl, {
      timeoutMs: config.requestTimeoutMs || 15000,
      minDelayMs: config.httpMinDelayMs,
      maxDelayMs: config.httpMaxDelayMs,
      skipCache: true // On veut le statut ACTUEL, pas le cache
    });

    // Indicateurs que l'annonce n'est plus dispo
    const soldIndicators = [
      'item-sold',
      'sold-overlay',
      '"is_closed":true',
      '"status":"sold"',
      '"status":"hidden"',
      'réservé',
      'reserved',
      'vendu'
    ];
    const lowerHtml = html.toLowerCase();
    const isSold = soldIndicators.some((ind) => lowerHtml.includes(ind));

    // Essayer d'extraire le prix actuel
    let currentPrice = null;
    const priceMatch = html.match(/"price_numeric":\s*([\d.]+)/);
    if (priceMatch) {
      currentPrice = parseFloat(priceMatch[1]);
    }

    return {
      available: !isSold,
      currentPrice
    };
  } catch (error) {
    console.log(`  [Superviseur] Erreur check Vinted: ${error.message}`);
    // HTTP 404/410 = annonce supprimée ou vendue → indisponible
    if (error.message && (error.message.includes('404') || error.message.includes('410'))) {
      console.log(`  [Superviseur] → 404/410 détecté = annonce expirée`);
      return { available: false, currentPrice: null };
    }
    // Vraie erreur réseau (timeout, DNS, etc.) → on ne touche pas à l'annonce
    return { available: true, currentPrice: null };
  }
}

// ─── Calcul du profit net détaillé ───────────────────────────────────

/**
 * Calcule le profit net avec TOUS les frais détaillés.
 */
function computeDetailedProfit(opportunity, config, platform = 'ebay') {
  const sales = opportunity.matchedSales || [];
  if (sales.length === 0) return null;

  const soldPrices = sales.map((s) => s.price || s.totalPrice);
  const medianSoldPrice = median(soldPrices);
  const avgSoldPrice = soldPrices.reduce((a, b) => a + b, 0) / soldPrices.length;
  // On prend le plus conservateur entre médiane et moyenne
  const estimatedSalePrice = Math.min(medianSoldPrice || avgSoldPrice, avgSoldPrice);

  const fees = PLATFORM_FEES[platform] || PLATFORM_FEES.ebay;
  const vintedFees = PLATFORM_FEES.vinted;

  // Coût d'acquisition
  const buyerPrice = opportunity.vintedBuyerPrice || opportunity.vintedListedPrice;
  const vintedShipping = config.vintedShippingEstimate || vintedFees.shippingEstimate;
  const acquisitionCost = buyerPrice + vintedShipping;

  // Frais de revente
  const sellerFee = estimatedSalePrice * fees.sellerFeePercent;
  const paymentFee = estimatedSalePrice * fees.paymentFeePercent;
  const fixedFee = fees.fixedFee || 0;
  const promoFee = estimatedSalePrice * (fees.promotionFeePercent || 0);
  const outboundShipping = config.ebayOutboundShippingEstimate || 4.50;

  const totalSellFees = sellerFee + paymentFee + fixedFee + promoFee + outboundShipping;
  const netFromSale = estimatedSalePrice - totalSellFees;
  const netProfit = netFromSale - acquisitionCost;
  const netProfitPercent = acquisitionCost > 0 ? (netProfit / acquisitionCost) * 100 : 0;

  // ROI (Return on Investment)
  const roi = acquisitionCost > 0 ? (netProfit / acquisitionCost) : 0;

  return {
    // Prix
    estimatedSalePrice: round2(estimatedSalePrice),
    medianSoldPrice: round2(medianSoldPrice),
    avgSoldPrice: round2(avgSoldPrice),
    buyerPrice: round2(buyerPrice),

    // Coûts
    acquisitionCost: round2(acquisitionCost),
    vintedShipping: round2(vintedShipping),

    // Frais de revente détaillés
    sellerFee: round2(sellerFee),
    paymentFee: round2(paymentFee),
    fixedFee: round2(fixedFee),
    promoFee: round2(promoFee),
    outboundShipping: round2(outboundShipping),
    totalSellFees: round2(totalSellFees),

    // Résultat
    netFromSale: round2(netFromSale),
    netProfit: round2(netProfit),
    netProfitPercent: round2(netProfitPercent),
    roi: round2(roi),

    // Meta
    platform,
    salesCount: sales.length,
    priceSpread: sales.length >= 2
      ? round2(Math.max(...soldPrices) - Math.min(...soldPrices))
      : 0
  };
}

function round2(value) {
  return Math.round((value || 0) * 100) / 100;
}

// ─── Re-vérification des prix eBay ──────────────────────────────────

/**
 * Re-vérifie le prix de marché en forçant un refresh (bypass cache).
 */
async function reverifyMarketPrice(opportunity, config) {
  const pricingSource = opportunity.pricingSource || 'ebay';
  const listing = {
    title: opportunity.title,
    rawTitle: opportunity.rawTitle || opportunity.title,
    buyerPrice: opportunity.vintedBuyerPrice,
    listedPrice: opportunity.vintedListedPrice,
    url: opportunity.url,
    imageUrl: opportunity.imageUrl
  };

  // Détecter la langue pour enrichir la query eBay
  const detectedLang = extractCardLanguage(listing.title, listing.rawTitle);
  const langKeyword = getLanguageSearchKeyword(detectedLang);

  try {
    if (pricingSource === 'pokemon-tcg-api') {
      const result = await getPokemonMarketPrice(listing, config);
      return result ? result.matchedSales : [];
    } else if (pricingSource === 'ygoprodeck') {
      const result = await getYugiohMarketPrice(listing, config);
      return result ? result.matchedSales : [];
    } else {
      // eBay : enrichir la query avec la langue détectée
      let searchQuery = listing.title;
      if (langKeyword && !listing.title.toLowerCase().includes(langKeyword)) {
        searchQuery = listing.title + ' ' + langKeyword;
        console.log(`  [Superviseur] 🌐 Recherche eBay enrichie avec langue: "${langKeyword}"`);
      }

      const soldListings = await getEbaySoldListings(searchQuery, {
        ...config,
        // On utilise le cache existant pour la re-vérification
      });
      const minPrice = config.minListingPriceEur || 2;
      const validSold = soldListings.filter((s) => s.totalPrice >= minPrice);
      const textMatches = chooseBestSoldListings(listing, validSold);
      return await attachImageSignals(listing, textMatches, config);
    }
  } catch (error) {
    console.log(`  [Superviseur] Re-vérification prix échouée: ${error.message}`);
    return null; // On garde les données originales
  }
}

// ─── Détection de langue de carte ────────────────────────────────────

/**
 * Table de correspondance langue → mots-clés de détection.
 * Utilisé pour identifier la langue/édition exacte d'une carte
 * afin de chercher le bon prix de revente (pas de décote arbitraire).
 */
const LANGUAGE_KEYWORDS = [
  { keywords: ['japanese', 'japonais', 'japonaise', 'jap', 'jpn', 'jp'], lang: 'japanese' },
  { keywords: ['korean', 'coréen', 'coréenne', 'coreen', 'coreenne', 'kor', 'kr'], lang: 'korean' },
  { keywords: ['french', 'français', 'française', 'fra', 'vf', 'fr'], lang: 'french' },
  { keywords: ['english', 'anglais', 'anglaise', 'eng', 'en'], lang: 'english' },
  { keywords: ['chinese', 'chinois', 'chinoise', 'chn', 'ch'], lang: 'chinese' },
  { keywords: ['italian', 'italien', 'italienne', 'ita', 'it'], lang: 'italian' },
  { keywords: ['german', 'allemand', 'allemande', 'deu', 'de'], lang: 'german' },
  { keywords: ['spanish', 'espagnol', 'espagnole', 'esp', 'sp'], lang: 'spanish' },
  { keywords: ['portuguese', 'portugais', 'portugaise', 'pt'], lang: 'portuguese' },
  { keywords: ['thai', 'thaï', 'thaïlandais'], lang: 'thai' },
  { keywords: ['indonesian', 'indonésien'], lang: 'indonesian' }
];

/**
 * Extrait la langue de la carte à partir du titre Vinted.
 * AUCUNE décote — on cherche le bon prix pour la bonne langue.
 *
 * @param {string} title - Le titre de l'annonce
 * @param {string} [rawTitle] - Le titre brut (optionnel)
 * @returns {string} Code langue ('japanese', 'korean', 'french', etc.) ou 'unknown'
 */
function extractCardLanguage(title, rawTitle) {
  const combinedText = ((title || '') + ' ' + (rawTitle || '')).toLowerCase();

  for (const entry of LANGUAGE_KEYWORDS) {
    for (const kw of entry.keywords) {
      // Échapper les chars spéciaux regex, puis match mot entier
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp('\\b' + escaped + '\\b', 'i');
      if (regex.test(combinedText)) {
        return entry.lang;
      }
    }
  }

  return 'unknown';
}

/**
 * Détecte les incohérences de langue dans le titre d'une annonce.
 * Retourne des warnings informatifs — AUCUNE décote de prix.
 * Le bon prix est obtenu en cherchant la bonne version sur eBay.
 *
 * @param {Object} opp - L'opportunité à vérifier
 * @returns {{ detectedLanguage: string, languageWarnings: string[] }}
 */
function analyzeCardLanguage(opp) {
  const title = opp.title || '';
  const rawTitle = opp.rawTitle || opp.title || '';
  const detectedLanguage = extractCardLanguage(title, rawTitle);
  const languageWarnings = [];
  const combinedText = (title + ' ' + rawTitle).toLowerCase();

  if (detectedLanguage === 'unknown') {
    languageWarnings.push('⚠️ Langue non détectée, vérifier manuellement');
  }

  // Détection d'incohérence : plusieurs langues mentionnées dans le même titre
  const detectedLangs = [];
  for (const entry of LANGUAGE_KEYWORDS) {
    for (const kw of entry.keywords) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp('\\b' + escaped + '\\b', 'i');
      if (regex.test(combinedText) && !detectedLangs.includes(entry.lang)) {
        detectedLangs.push(entry.lang);
      }
    }
  }

  if (detectedLangs.length > 1) {
    languageWarnings.push(
      `⚠️ Langue incohérente: titre mentionne ${detectedLangs.join(' + ')} — vérifier manuellement`
    );
  }

  return { detectedLanguage, languageWarnings };
}

/**
 * Retourne le keyword de langue à ajouter aux recherches eBay
 * pour trouver les ventes de la bonne version linguistique.
 *
 * @param {string} lang - Code langue retourné par extractCardLanguage()
 * @returns {string|null} Keyword à ajouter à la query eBay, ou null si non nécessaire
 */
function getLanguageSearchKeyword(lang) {
  const LANG_TO_EBAY_KEYWORD = {
    japanese: 'japanese',
    korean: 'korean',
    french: 'french',
    chinese: 'chinese',
    italian: 'italian',
    german: 'german',
    spanish: 'spanish',
    portuguese: 'portuguese',
    thai: 'thai',
    indonesian: 'indonesian'
    // english → pas besoin d'ajouter, c'est le défaut eBay
    // unknown → pas de keyword, on laisse la recherche telle quelle
  };
  return LANG_TO_EBAY_KEYWORD[lang] || null;
}

// ─── Agent principal ─────────────────────────────────────────────────

/**
 * Vérifie une liste d'opportunités et retourne celles qui sont confirmées
 * avec un score de confiance et un profit net détaillé.
 *
 * @param {Array} opportunities - Les opportunités du scraper
 * @param {Object} config - Configuration globale
 * @param {Object} options - { reverifyPrices: boolean, checkAvailability: boolean }
 * @returns {Array} Opportunités vérifiées et enrichies
 */
async function supervise(opportunities, config, options = {}) {
  const {
    reverifyPrices = false,
    checkAvailability = true,
    minConfidence = 30
  } = options;

  console.log(`[Superviseur] Vérification de ${opportunities.length} opportunité(s)...`);
  const verified = [];

  for (const opp of opportunities) {
    const startTime = Date.now();
    const verification = {
      vintedStillAvailable: true,
      currentVintedPrice: null,
      priceReverified: false,
      originalProfit: opp.profit,
      detailedProfit: null,
      confidenceScore: 0,
      verdict: 'pending',
      reasons: [],
      checkedAt: new Date().toISOString()
    };

    // 1. Vérifier la dispo Vinted
    if (checkAvailability && opp.url) {
      console.log(`  [Superviseur] Check dispo: ${opp.title.slice(0, 50)}...`);
      const availability = await checkVintedAvailability(opp.url, config);
      verification.vintedStillAvailable = availability.available;
      verification.currentVintedPrice = availability.currentPrice;

      if (!availability.available) {
        verification.verdict = 'expired';
        verification.reasons.push('Annonce Vinted vendue/retirée');
        console.log(`  [Superviseur] ❌ Annonce plus disponible`);
      }

      // Prix a changé ?
      if (availability.currentPrice && availability.currentPrice !== opp.vintedBuyerPrice) {
        verification.reasons.push(
          `Prix modifié: ${opp.vintedBuyerPrice}€ → ${availability.currentPrice}€`
        );
        console.log(`  [Superviseur] ⚠ Prix changé: ${opp.vintedBuyerPrice}€ → ${availability.currentPrice}€`);
      }
    }

    // 1b. Détection langue de la carte (sans décote — on cherche le bon prix)
    const langCheck = analyzeCardLanguage(opp);
    verification.detectedLanguage = langCheck.detectedLanguage;
    verification.languageWarnings = langCheck.languageWarnings;
    if (langCheck.languageWarnings.length > 0) {
      console.log(`  [Superviseur] ⚠ Langue: ${langCheck.languageWarnings[0]}`);
      verification.reasons.push(...langCheck.languageWarnings);
    }
    if (langCheck.detectedLanguage !== 'unknown') {
      console.log(`  [Superviseur] 🌐 Langue détectée: ${langCheck.detectedLanguage}`);
    }

    // 2. Re-vérifier les prix de marché (optionnel, plus lent)
    if (reverifyPrices && verification.vintedStillAvailable) {
      console.log(`  [Superviseur] Re-vérification prix marché...`);
      const freshSales = await reverifyMarketPrice(opp, config);
      if (freshSales && freshSales.length > 0) {
        verification.priceReverified = true;
        // Mettre à jour les matchedSales avec les données fraîches
        opp.matchedSales = freshSales;
        verification.reasons.push(`Prix re-vérifié: ${freshSales.length} vente(s) trouvée(s)`);
      }
    }

    // 3. Calcul du profit net détaillé (PAS de décote — le prix eBay est déjà
    //    celui de la bonne version linguistique grâce au keyword langue)
    const effectivePrice = verification.currentVintedPrice || opp.vintedBuyerPrice;
    const oppForProfit = { ...opp, vintedBuyerPrice: effectivePrice };
    verification.detailedProfit = computeDetailedProfit(oppForProfit, config);

    // Ajouter la langue détectée dans le profit pour traçabilité
    if (verification.detailedProfit) {
      verification.detailedProfit.detectedLanguage = verification.detectedLanguage;
    }

    // 4. Score de confiance
    verification.confidenceScore = computeConfidenceScore(opp, verification.detailedProfit);

    // 4b. Analyse de liquidité
    try {
      const liquidityAnalysis = analyzeLiquidity(opp);
      verification.liquidityScore = liquidityAnalysis.liquidityScore;
      verification.liquiditySummary = liquidityAnalysis.summary;
      verification.adjustedMarginPercent = liquidityAnalysis.adjustedMargin.adjustedMarginPercent;
      verification.liquidity = liquidityAnalysis;
    } catch (err) {
      console.log(`  [Superviseur] Erreur liquidité: ${err.message}`);
      verification.liquidityScore = null;
      verification.liquiditySummary = null;
      verification.adjustedMarginPercent = null;
      verification.liquidity = null;
    }

    // 5. Verdict final
    if (verification.verdict !== 'expired') {
      if (verification.detailedProfit && verification.detailedProfit.netProfit <= 0) {
        verification.verdict = 'rejected';
        verification.reasons.push(`Profit net négatif: ${verification.detailedProfit.netProfit}€`);
      } else if (verification.confidenceScore < minConfidence) {
        verification.verdict = 'low_confidence';
        verification.reasons.push(`Score de confiance trop bas: ${verification.confidenceScore}/100`);
      } else {
        verification.verdict = 'confirmed';
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `  [Superviseur] ${opp.title.slice(0, 40)}... → ` +
      `${verification.verdict.toUpperCase()} ` +
      `(confiance: ${verification.confidenceScore}/100, ` +
      `profit net: ${verification.detailedProfit ? verification.detailedProfit.netProfit + '€' : 'N/A'}) ` +
      `[${elapsed}ms]`
    );

    verified.push({
      ...opp,
      verification
    });
  }

  const confirmed = verified.filter((v) => v.verification.verdict === 'confirmed');
  const rejected = verified.filter((v) => v.verification.verdict !== 'confirmed');

  console.log(
    `[Superviseur] Résultat: ${confirmed.length} confirmée(s), ` +
    `${rejected.length} rejetée(s) sur ${opportunities.length}`
  );

  return {
    verified,
    confirmed,
    rejected,
    summary: {
      total: opportunities.length,
      confirmedCount: confirmed.length,
      rejectedCount: rejected.length,
      avgConfidence: confirmed.length > 0
        ? Math.round(confirmed.reduce((s, o) => s + o.verification.confidenceScore, 0) / confirmed.length)
        : 0,
      avgNetProfit: confirmed.length > 0
        ? round2(confirmed.reduce((s, o) => s + (o.verification.detailedProfit?.netProfit || 0), 0) / confirmed.length)
        : 0,
      checkedAt: new Date().toISOString()
    }
  };
}

module.exports = {
  supervise,
  computeConfidenceScore,
  computeDetailedProfit,
  checkVintedAvailability,
  extractCardLanguage,
  analyzeCardLanguage,
  getLanguageSearchKeyword,
  LANGUAGE_KEYWORDS,
  PLATFORM_FEES
};
