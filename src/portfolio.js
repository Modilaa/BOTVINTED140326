/**
 * Portfolio Tracking — Suivi des cartes achetées par Justin.
 * Stocke dans output/portfolio-items.json (format simple, indépendant du système agent).
 */

const fs = require('fs');
const path = require('path');

const PORTFOLIO_PATH = path.join(__dirname, '..', 'output', 'portfolio-items.json');

function loadPortfolio() {
  try {
    if (fs.existsSync(PORTFOLIO_PATH)) {
      const raw = fs.readFileSync(PORTFOLIO_PATH, 'utf8');
      if (raw.trim()) return JSON.parse(raw);
    }
  } catch { /* ignore */ }
  return [];
}

function savePortfolio(data) {
  fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Adds an opportunity to the portfolio (marks it as bought).
 * @param {object} opportunity - Opportunity object from history
 * @returns {object} The new or existing portfolio entry
 */
function addToPortfolio(opportunity) {
  const portfolio = loadPortfolio();

  const vintedId = opportunity.id
    || opportunity.itemKey
    || (opportunity.url || '').match(/\/items\/(\d+)/)?.[1]
    || `opp-${Date.now()}`;

  const existing = portfolio.find((p) => p.vintedId === String(vintedId));
  if (existing) return existing;

  const entry = {
    id: `port_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    vintedId: String(vintedId),
    title: opportunity.title || '',
    category: opportunity.search || '',
    boughtAt: opportunity.vintedPrice || 0,
    boughtDate: new Date().toISOString().slice(0, 10),
    currentMarketPrice: opportunity.estimatedSalePrice || 0,
    lastPriceUpdate: new Date().toISOString().slice(0, 10),
    status: 'in_stock',
    soldAt: null,
    soldDate: null,
    profit: null,
    notes: ''
  };

  portfolio.push(entry);
  savePortfolio(portfolio);
  return entry;
}

/**
 * Marks a portfolio item as sold and calculates real profit.
 * @param {string} id - Portfolio entry ID (port_xxx)
 * @param {number} soldPrice - Actual sale price in EUR
 * @returns {object|null} Updated entry or null if not found
 */
function markAsSold(id, soldPrice) {
  const portfolio = loadPortfolio();
  const item = portfolio.find((p) => p.id === id);
  if (!item) return null;

  item.status = 'sold';
  item.soldAt = soldPrice;
  item.soldDate = new Date().toISOString().slice(0, 10);
  item.profit = Math.round((soldPrice - item.boughtAt) * 100) / 100;

  savePortfolio(portfolio);
  return item;
}

/**
 * Updates current market prices from price-database for all in_stock items.
 * @returns {Array} Updated in_stock items
 */
function updateMarketPrices() {
  let priceDb;
  try { priceDb = require('./price-database'); } catch { return []; }

  const portfolio = loadPortfolio();
  const today = new Date().toISOString().slice(0, 10);
  let changed = false;

  for (const item of portfolio) {
    if (item.status !== 'in_stock') continue;
    try {
      const entry = priceDb.lookupPrice(item.title, item.category);
      if (entry && entry.price > 0) {
        item.currentMarketPrice = entry.price;
        item.lastPriceUpdate = today;
        changed = true;
      }
    } catch { /* ignore */ }
  }

  if (changed) savePortfolio(portfolio);
  return portfolio.filter((p) => p.status === 'in_stock');
}

/**
 * Returns aggregated portfolio statistics.
 * @returns {object} Stats object
 */
function getPortfolioStats() {
  const portfolio = loadPortfolio();
  const inStock = portfolio.filter((p) => p.status === 'in_stock');
  const sold = portfolio.filter((p) => p.status === 'sold');

  const totalInvested = inStock.reduce((sum, p) => sum + (p.boughtAt || 0), 0);
  const totalCurrentValue = inStock.reduce((sum, p) => sum + (p.currentMarketPrice || 0), 0);
  const unrealizedProfit = Math.round((totalCurrentValue - totalInvested) * 100) / 100;
  const realizedProfit = sold.reduce((sum, p) => sum + (p.profit || 0), 0);

  const soldWithProfit = sold.filter((p) => p.boughtAt > 0 && p.profit != null);
  const avgROI = soldWithProfit.length > 0
    ? soldWithProfit.reduce((sum, p) => sum + ((p.profit / p.boughtAt) * 100), 0) / soldWithProfit.length
    : null;

  return {
    totalInvested: Math.round(totalInvested * 100) / 100,
    totalCurrentValue: Math.round(totalCurrentValue * 100) / 100,
    unrealizedProfit,
    realizedProfit: Math.round(realizedProfit * 100) / 100,
    itemCount: inStock.length,
    soldCount: sold.length,
    avgROI: avgROI !== null ? Math.round(avgROI * 10) / 10 : null
  };
}

module.exports = { addToPortfolio, markAsSold, updateMarketPrices, getPortfolioStats, loadPortfolio };
