/**
 * Discogs API — Prix de vinyles via l'API officielle Discogs.
 *
 * Rate limit : 60 req/min (sans token), 240/min (avec DISCOGS_TOKEN)
 * User-Agent obligatoire, token optionnel pour quota supérieur.
 * Timeout max : 5s par requête pour ne pas ralentir le scan.
 */

const { request } = require('undici');

const DISCOGS_BASE = 'https://api.discogs.com';
const TIMEOUT_MS = 5000;

// ─── Cache ────────────────────────────────────────────────────────────────────

const discogsCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function getCached(key) {
  const entry = discogsCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
  return undefined;
}

function setCache(key, data) {
  if (discogsCache.size >= 300) discogsCache.clear();
  discogsCache.set(key, { ts: Date.now(), data });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildHeaders() {
  const token = process.env.DISCOGS_TOKEN;
  const headers = {
    'User-Agent': 'BOTVintedCodex/1.0 +https://github.com/botvintedcodex',
    'Accept': 'application/json'
  };
  if (token) headers['Authorization'] = `Discogs token=${token}`;
  return headers;
}

/**
 * Extrait les termes de recherche pour un vinyle.
 * "Pink Floyd The Wall LP 33 tours collector" → "Pink Floyd The Wall"
 */
function extractVinylSearchTerms(vintedTitle) {
  if (!vintedTitle) return null;

  const cleaned = vintedTitle
    .replace(/\b(vinyle?s?|vinyl|disque|album|lp|ep|33\s*tours?|45\s*tours?|single|pressage|edition|limitee?|rare|collector|gatefold|sleeve|pochette|nm|vg\+?|mint|neuf|occasion)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = cleaned.split(' ').filter(t => t.length > 2).slice(0, 6);
  return tokens.length > 0 ? tokens.join(' ') : vintedTitle.trim().split(' ').slice(0, 4).join(' ');
}

function toEur(priceObj, usdToEurRate) {
  if (!priceObj || !priceObj.value || priceObj.value <= 0) return 0;
  if (priceObj.currency === 'EUR') return priceObj.value;
  if (priceObj.currency === 'GBP') return priceObj.value * 1.15;
  return priceObj.value * (usdToEurRate || 0.865); // USD par défaut
}

// ─── Discogs API calls ────────────────────────────────────────────────────────

async function searchDiscogsRelease(query) {
  const cacheKey = `search:${query.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${DISCOGS_BASE}/database/search?q=${encodeURIComponent(query)}&type=release&per_page=5`;

  try {
    const { statusCode, body } = await request(url, {
      method: 'GET',
      headers: buildHeaders(),
      bodyTimeout: TIMEOUT_MS,
      headersTimeout: TIMEOUT_MS
    });

    if (statusCode === 429) {
      console.log('    [DISCOGS] Rate limit atteint');
      return null;
    }
    if (statusCode !== 200) {
      console.log(`    [DISCOGS] HTTP ${statusCode} pour "${query}"`);
      setCache(cacheKey, null);
      return null;
    }

    const data = JSON.parse(await body.text());
    const result = (data.results && data.results.length > 0) ? data.results[0] : null;
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.log(`    [DISCOGS] Erreur recherche: ${err.message}`);
    return null;
  }
}

async function getDiscogsMarketStats(releaseId) {
  const cacheKey = `stats:${releaseId}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${DISCOGS_BASE}/marketplace/stats/${releaseId}?curr_abbr=EUR`;

  try {
    const { statusCode, body } = await request(url, {
      method: 'GET',
      headers: buildHeaders(),
      bodyTimeout: TIMEOUT_MS,
      headersTimeout: TIMEOUT_MS
    });

    if (statusCode !== 200) {
      setCache(cacheKey, null);
      return null;
    }

    const data = JSON.parse(await body.text());
    setCache(cacheKey, data);
    return data;
  } catch (err) {
    console.log(`    [DISCOGS] Erreur stats: ${err.message}`);
    return null;
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Prix Discogs pour un listing Vinted de vinyle.
 * Format de sortie compatible avec price-router.js.
 *
 * @param {object} listing - { title, buyerPrice, imageUrl, url }
 * @param {object} config - Config globale
 * @returns {object|null} - { matchedSales, pricingSource, bestMatch, marketPrice, confidence }
 */
async function getDiscogsMarketPrice(listing, config) {
  const query = extractVinylSearchTerms(listing.title);
  if (!query) return null;

  console.log(`    [DISCOGS] Recherche: "${query}"`);

  const release = await searchDiscogsRelease(query);
  if (!release) {
    console.log(`    [DISCOGS] Aucun résultat pour "${query}"`);
    return null;
  }

  const releaseTitle = release.title || query;
  console.log(`    [DISCOGS] Trouvé: "${releaseTitle}" (id: ${release.id})`);

  const stats = await getDiscogsMarketStats(release.id);
  if (!stats) {
    console.log(`    [DISCOGS] Pas de stats marketplace pour "${releaseTitle}"`);
    return null;
  }

  const usdRate = config.usdToEurRate || 0.865;
  const prices = [];

  const lowestEur = toEur(stats.lowest_price, usdRate);
  if (lowestEur > 0) prices.push({ label: 'lowest', eur: lowestEur });

  const medianEur = toEur(stats.median_price, usdRate);
  if (medianEur > 0) prices.push({ label: 'median', eur: medianEur });

  const recentEur = toEur(stats.most_recent_price, usdRate);
  if (recentEur > 0) prices.push({ label: 'recent', eur: recentEur });

  if (prices.length === 0) {
    console.log(`    [DISCOGS] Pas de prix disponibles pour "${releaseTitle}"`);
    return null;
  }

  const medianEntry = prices.find(p => p.label === 'median');
  const marketPrice = medianEntry
    ? medianEntry.eur
    : prices.reduce((sum, p) => sum + p.eur, 0) / prices.length;

  const discogsUrl = `https://www.discogs.com/release/${release.id}`;

  const matchedSales = prices.map(p => ({
    title: `${releaseTitle} [${p.label}]`,
    price: parseFloat(p.eur.toFixed(2)),
    totalPrice: parseFloat(p.eur.toFixed(2)),
    url: discogsUrl,
    sourceUrl: discogsUrl,
    source: 'discogs',
    marketplace: 'discogs'
  }));

  const forSale = stats.num_for_sale || 0;
  console.log(`    [DISCOGS] Prix trouvé: ${marketPrice.toFixed(2)}€ pour "${releaseTitle}" (${forSale} en vente)`);

  return {
    matchedSales,
    pricingSource: 'discogs',
    bestMatch: releaseTitle,
    marketPrice: parseFloat(marketPrice.toFixed(2)),
    confidence: prices.length >= 2 ? 'medium' : 'low'
  };
}

module.exports = { getDiscogsMarketPrice };
