/**
 * Reverse Scanner: eBay → Vinted
 *
 * Trouve des articles pas chers sur eBay (Buy It Now) et vérifie si
 * ils peuvent être revendus à profit sur Vinted.
 *
 * LÉGER : max 1 appel eBay Browse API par catégorie.
 * Utilise les listings Vinted déjà scannés comme référence de prix.
 *
 * Frais (Belgique) :
 *   Achat eBay  : prix eBay + ~4€ livraison entrante
 *   Vente Vinted : prix Vinted × (1 - 0.05) — 5% frais vendeur
 *   Profit       : net_vinted - coût_total
 */

const { getOAuthToken } = require('../marketplaces/ebay-api');

// ─── Browse API helper (direct, bypass proxy) ────────────────────────────────

function getDirectDispatcher() {
  try {
    const { Agent } = require('undici');
    return new Agent({ connect: { timeout: 15000 } });
  } catch {
    return undefined;
  }
}

/**
 * Recherche des articles eBay bon marché (BIN) via Browse API.
 * Retourne au max `limit` items triés par prix croissant.
 */
async function searchCheapEbayBin(query, token, config, options = {}) {
  const maxPrice = options.maxPrice || 30;
  const categoryId = options.categoryId !== undefined ? options.categoryId : '261328';
  const limit = options.limit || 8;

  const baseUrl = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
  const url = new URL(baseUrl);
  url.searchParams.set('q', query);
  if (categoryId) url.searchParams.set('category_ids', String(categoryId));
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('sort', 'price'); // prix croissant
  url.searchParams.set('filter', `price:[2..${Math.ceil(maxPrice)}],priceCurrency:EUR,buyingOptions:{FIXED_PRICE}`);

  const fetchOpts = {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_FR',
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(20000)
  };

  const dispatcher = getDirectDispatcher();
  if (dispatcher) fetchOpts.dispatcher = dispatcher;

  try {
    const response = await fetch(url.toString(), fetchOpts);
    if (response.status === 429) {
      console.log('    [ReverseScanner] eBay rate limit, skip');
      return [];
    }
    if (!response.ok) return [];
    const data = await response.json();
    return data.itemSummaries || [];
  } catch {
    return [];
  }
}

// ─── Prix EUR depuis un item Browse API ─────────────────────────────────────

function itemPriceEur(item, config) {
  const priceMoney = item.price || {};
  const amount = parseFloat(priceMoney.value || 0);
  const currency = priceMoney.currency || 'EUR';
  if (!amount || amount <= 0) return null;
  if (currency === 'EUR') return amount;
  if (currency === 'GBP') return amount * (config.gbpToEurRate || 1.153);
  return amount * (config.usdToEurRate || 0.865);
}

// ─── Scanner principal ───────────────────────────────────────────────────────

/**
 * Lance le scan eBay→Vinted.
 *
 * @param {object} cfg           - Config globale
 * @param {Array}  existingVinted - Listings Vinted déjà scannés (du scan principal)
 * @returns {Array} Opportunités avec route: 'ebay→vinted'
 */
async function runReverseScanner(cfg, existingVinted) {
  const opportunities = [];

  if (!cfg.ebayAppId || !cfg.ebayClientSecret) {
    console.log('  [ReverseScanner] eBay Browse API non configurée — skip');
    return opportunities;
  }

  let token;
  try {
    token = await getOAuthToken(cfg);
  } catch (err) {
    console.error(`  [ReverseScanner] Auth eBay impossible: ${err.message}`);
    return opportunities;
  }

  // Regroupe les listings Vinted par search.name
  const vintedBySearch = new Map();
  for (const listing of (existingVinted || [])) {
    if (!listing.search || (listing.platform && listing.platform !== 'vinted')) continue;
    if (!vintedBySearch.has(listing.search)) vintedBySearch.set(listing.search, []);
    vintedBySearch.get(listing.search).push(listing);
  }

  const vintedFees = 0.05;
  const inboundShipping = 4; // livraison eBay → Justin

  for (const search of cfg.searches) {
    const vintedListings = vintedBySearch.get(search.name) || [];
    if (vintedListings.length < 3) continue;

    // Prix médian Vinted pour cette catégorie (= référence de revente)
    const prices = vintedListings
      .map(l => l.vintedBuyerPrice || l.vintedListedPrice)
      .filter(p => p > 0)
      .sort((a, b) => a - b);

    if (prices.length < 3) continue;
    const medianVinted = prices[Math.floor(prices.length / 2)];

    const minProfit = search.minProfitEur != null ? search.minProfitEur : (cfg.minProfitEur || 5);
    const minPct = search.minProfitPercent != null ? search.minProfitPercent : (cfg.minProfitPercent || 20);

    // Prix eBay max pour être rentable :
    // netSale = medianVinted * (1 - vintedFees)
    // profit  = netSale - (ebayPrice + inboundShipping) >= minProfit
    // => ebayPrice <= netSale - inboundShipping - minProfit
    const netSaleRef = medianVinted * (1 - vintedFees);
    const maxEbayPrice = netSaleRef - inboundShipping - minProfit;

    if (maxEbayPrice < 2) continue;

    const query = (search.vintedQueries || [])[0] || search.name;
    // null = pas de restriction catégorie pour non-TCG ; '261328' = Trading Cards
    const categoryId = search.isNonTcg ? null : '261328';

    console.log(`  [ReverseScanner] ${search.name}: eBay < ${maxEbayPrice.toFixed(0)}€ (Vinted médian: ${medianVinted.toFixed(0)}€)`);

    const ebayItems = await searchCheapEbayBin(query, token, cfg, { maxPrice: maxEbayPrice, categoryId });

    for (const item of ebayItems) {
      const ebayPrice = itemPriceEur(item, cfg);
      if (!ebayPrice || ebayPrice < 2) continue;

      const acquisitionCost = ebayPrice + inboundShipping;
      const netSale = medianVinted * (1 - vintedFees);
      const profit = netSale - acquisitionCost;
      const profitPercent = (profit / acquisitionCost) * 100;

      if (profit < minProfit || profitPercent < minPct) continue;

      const itemUrl = item.itemWebUrl || item.itemHref || '';
      const imageUrl = (item.image && item.image.imageUrl) || '';
      const title = String(item.title || '')
        .replace(/^new listing\s*/i, '')
        .replace(/^nouvelle annonce\s*/i, '')
        .trim();

      // Les listings Vinted servent de référence de prix (sourceUrls)
      const sourceUrls = vintedListings.slice(0, 3).map(l => ({
        platform: 'vinted',
        url: l.url,
        title: l.title,
        price: l.vintedBuyerPrice || l.vintedListedPrice
      }));

      opportunities.push({
        search: search.name,
        route: 'ebay→vinted',
        title,
        vintedListedPrice: ebayPrice,
        vintedBuyerPrice: ebayPrice,
        sourceQuery: query,
        url: itemUrl,
        imageUrl,
        rawTitle: title,
        platform: 'ebay',
        pricingSource: 'vinted-market',
        detectedLanguage: null,
        matchedSales: vintedListings.slice(0, 5).map(l => ({
          title: l.title,
          price: l.vintedBuyerPrice || l.vintedListedPrice,
          url: l.url,
          soldAt: new Date().toISOString()
        })),
        sourceUrls,
        profit: {
          averageSoldPrice: medianVinted,
          averageBuyerPaid: medianVinted,
          soldPrices: prices.slice(0, 8),
          soldTotals: prices.slice(0, 8),
          totalCost: acquisitionCost,
          estimatedNetSale: netSale,
          profit,
          profitPercent
        }
      });
    }

    // Pause légère entre catégories pour respecter le rate limit eBay
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`  [ReverseScanner] ${opportunities.length} opportunité(s) eBay→Vinted détectée(s)`);
  return opportunities;
}

module.exports = { runReverseScanner };
