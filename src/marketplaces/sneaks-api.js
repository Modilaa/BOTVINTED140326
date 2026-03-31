/**
 * Sneaks API — Prix de revente de sneakers via StockX, GOAT, FlightClub.
 *
 * Package NPM : sneaks-api  (npm install sneaks-api)
 * Usage       : const SneaksAPI = require('sneaks-api')
 * Données     : lowestResellPrice par plateforme (StockX, GOAT, FlightClub…)
 * Timeout     : 5s max pour ne pas ralentir le scan
 */

const SEARCH_TIMEOUT_MS = 5000;

// Chargement conditionnel : ne plante pas si le package n'est pas installé
let SneaksAPI = null;
try {
  SneaksAPI = require('sneaks-api');
} catch {
  // Avertissement différé dans getSneakersMarketPrice
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extrait les termes de recherche pertinents pour une sneaker.
 * "Nike Dunk Low Panda taille 42 neuf" → "Nike Dunk Low Panda"
 */
function extractSneakerSearchTerms(vintedTitle) {
  if (!vintedTitle) return null;

  const cleaned = vintedTitle
    .replace(/\b(taille|pointure|neuf|occasion|bon\s+état|like\s+new|deadstock|ds|vnds|used|worn|size|\d{2}(\.\d)?|eu|us|uk)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = cleaned.split(' ').filter(t => t.length > 1).slice(0, 5);
  return tokens.length > 0 ? tokens.join(' ') : null;
}

/**
 * Wraps the callback-based getProducts call with a timeout.
 */
function searchWithTimeout(query) {
  return new Promise((resolve, reject) => {
    const sneaks = new SneaksAPI();
    const timer = setTimeout(() => {
      reject(new Error(`Timeout sneaks-api après ${SEARCH_TIMEOUT_MS}ms`));
    }, SEARCH_TIMEOUT_MS);

    sneaks.getProducts(query, 5, (err, products) => {
      clearTimeout(timer);
      if (err) return reject(err);
      resolve(products || []);
    });
  });
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Prix marché pour un listing Vinted de sneaker.
 * Format de sortie compatible avec price-router.js.
 *
 * @param {object} listing - { title, buyerPrice, imageUrl, url }
 * @param {object} config  - Config globale
 * @returns {object|null}  - { matchedSales, pricingSource, bestMatch, marketPrice, confidence }
 */
async function getSneakersMarketPrice(listing, config) {
  console.log('    [SNEAKS] API désactivée (StockX incompatible)');
  return null;

  if (!SneaksAPI) {
    console.log('    [SNEAKS] sneaks-api non installé — exécuter : npm install sneaks-api');
    return null;
  }

  const query = extractSneakerSearchTerms(listing.title);
  if (!query) return null;

  console.log(`    [SNEAKS] Recherche: "${query}"`);

  let products;
  try {
    products = await searchWithTimeout(query);
  } catch (err) {
    console.log(`    [SNEAKS] Erreur: ${err.message}`);
    return null;
  }

  if (!products || products.length === 0) {
    console.log(`    [SNEAKS] Aucun résultat pour "${query}"`);
    return null;
  }

  const product = products[0];
  const resellPrices = product.lowestResellPrice || {};
  const usdRate = config.usdToEurRate || 0.865;

  // Plateformes supportées (prix en USD)
  const PLATFORMS = ['stockX', 'goat', 'flightClub', 'stadiumGoods', 'klekt'];
  const matchedSales = [];

  for (const platform of PLATFORMS) {
    const priceUsd = resellPrices[platform];
    if (priceUsd && priceUsd > 0) {
      const priceEur = parseFloat((priceUsd * usdRate).toFixed(2));
      matchedSales.push({
        title: `${product.shoeName} [${platform}]`,
        price: priceEur,
        totalPrice: priceEur,
        url: product.url || '',
        sourceUrl: product.url || '',
        source: 'sneaks-api',
        marketplace: platform
      });
    }
  }

  if (matchedSales.length === 0) {
    console.log(`    [SNEAKS] Pas de prix de revente pour "${product.shoeName}"`);
    return null;
  }

  // Médiane des prix disponibles
  const sortedPrices = matchedSales.map(s => s.price).sort((a, b) => a - b);
  const mid = Math.floor(sortedPrices.length / 2);
  const marketPrice = sortedPrices.length % 2 === 0
    ? (sortedPrices[mid - 1] + sortedPrices[mid]) / 2
    : sortedPrices[mid];

  console.log(`    [SNEAKS] Prix trouvé: ${marketPrice.toFixed(2)}€ pour "${product.shoeName}" (${matchedSales.length} plateformes)`);

  return {
    matchedSales,
    pricingSource: 'sneaks-api',
    bestMatch: product.shoeName || query,
    marketPrice: parseFloat(marketPrice.toFixed(2)),
    confidence: matchedSales.length >= 3 ? 'high' : matchedSales.length >= 2 ? 'medium' : 'low'
  };
}

module.exports = { getSneakersMarketPrice };
