const { average } = require('./utils');

function buildProfitAnalysis(vintedListing, soldListings, config) {
  if (soldListings.length < 1) {
    return null;
  }

  // Use item PRICE only (not totalPrice which includes the previous buyer's shipping)
  // The resale value is what buyers pay for the card itself
  const soldPrices = soldListings.map((listing) => listing.price);
  const averageSoldPrice = average(soldPrices);
  const ebayFee = averageSoldPrice * 0.13;
  const paymentFee = averageSoldPrice * 0.03;
  const acquisitionCost =
    (vintedListing.buyerPrice || vintedListing.listedPrice) + config.vintedShippingEstimate;
  const outboundShipping = config.ebayOutboundShippingEstimate;

  const totalCost = acquisitionCost;
  const estimatedNetSale = averageSoldPrice - ebayFee - paymentFee - outboundShipping;
  const profit = estimatedNetSale - totalCost;
  const profitPercent = totalCost > 0 ? (profit / totalCost) * 100 : 0;

  return {
    averageSoldPrice,
    averageBuyerPaid: averageSoldPrice, // Keep field for dashboard compat, but use card price only
    soldPrices,
    soldTotals: soldPrices,
    totalCost,
    estimatedNetSale,
    profit,
    profitPercent
  };
}

/**
 * Détermine si une analyse de profit constitue une opportunité.
 *
 * @param {object} analysis - Résultat de buildProfitAnalysis
 * @param {object} config - Config globale (seuils par défaut)
 * @param {object} [search] - Objet search depuis config.js (optionnel)
 *   search.minProfitEur et search.minProfitPercent surchargent les seuils globaux.
 *   Utile pour des seuils différents par catégorie (ex: sneakers = 15€/25%).
 */
function isOpportunity(analysis, config, search) {
  const minEur = (search && search.minProfitEur != null) ? search.minProfitEur : config.minProfitEur;
  const minPct = (search && search.minProfitPercent != null) ? search.minProfitPercent : config.minProfitPercent;
  return (
    analysis &&
    analysis.profit >= minEur &&
    analysis.profitPercent >= minPct
  );
}

module.exports = {
  buildProfitAnalysis,
  isOpportunity
};
