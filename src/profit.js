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

function isOpportunity(analysis, config) {
  return (
    analysis &&
    analysis.profit >= config.minProfitEur &&
    analysis.profitPercent >= config.minProfitPercent
  );
}

module.exports = {
  buildProfitAnalysis,
  isOpportunity
};
