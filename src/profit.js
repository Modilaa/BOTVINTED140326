const { average } = require('./utils');

function buildProfitAnalysis(vintedListing, soldListings, config) {
  if (soldListings.length < 1) {
    return null;
  }

  const soldPrices = soldListings.map((listing) => listing.price);
  const soldTotals = soldListings.map((listing) => listing.totalPrice || listing.price);
  const averageSoldPrice = average(soldPrices);
  const averageBuyerPaid = average(soldTotals);
  const ebayFee = averageBuyerPaid * 0.13;
  const paymentFee = averageBuyerPaid * 0.03;
  const acquisitionCost =
    (vintedListing.buyerPrice || vintedListing.listedPrice) + config.vintedShippingEstimate;
  const outboundShipping = config.ebayOutboundShippingEstimate;

  const totalCost = acquisitionCost;
  const estimatedNetSale = averageBuyerPaid - ebayFee - paymentFee - outboundShipping;
  const profit = estimatedNetSale - totalCost;
  const profitPercent = totalCost > 0 ? (profit / totalCost) * 100 : 0;

  return {
    averageSoldPrice,
    averageBuyerPaid,
    soldPrices,
    soldTotals,
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
