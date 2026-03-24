/**
 * Price Router — Routeur intelligent de prix multi-sources.
 *
 * Détermine automatiquement quelle API utiliser selon le type de carte,
 * avec cascade de fallbacks. Transparent pour le reste du pipeline.
 *
 * Chaîne de priorité (corrigée 2026-03-21):
 *   Pokémon  : PokemonTCG.io → TCGdex → eBay Browse API → Apify
 *   Yu-Gi-Oh : YGOPRODeck → eBay Browse API → Apify
 *   LEGO     : Rebrickable + eBay Browse API → Apify
 *   Autres   : eBay Browse API → Apify
 *
 * Format de sortie unifié: { matchedSales, pricingSource, bestMatch, marketPrice, confidence }
 */

const priceDatabase = require('./price-database');
const { checkAndAlert } = require('./api-monitor');
const { getYugiohMarketPrice } = require('./marketplaces/ygoprodeck');
const { getPokemonPriceViaTcgApi } = require('./marketplaces/pokemontcg-api');
const { getPokemonMarketPrice } = require('./marketplaces/pokemon-tcg');
const { getEbaySoldListingsViaApi } = require('./marketplaces/ebay-api');
const { getEbaySoldListings } = require('./marketplaces/ebay');
const { getApifyEbaySoldPrices } = require('./marketplaces/apify-ebay');
const { getCardmarketMarketPrice } = require('./marketplaces/cardmarket');
const { getDiscogsMarketPrice } = require('./marketplaces/discogs-api');
const { getSneakersMarketPrice } = require('./marketplaces/sneaks-api');
const { getLegoMarketPrice } = require('./marketplaces/lego-api');
const { chooseBestSoldListings } = require('./matching');
const { attachImageSignals } = require('./image-match');

// ─── In-Memory Result Cache ─────────────────────────────────────────────────

const priceCache = new Map();
const PRICE_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 heures
const MAX_PRICE_CACHE_SIZE = 500;

function clearPriceCache() { priceCache.clear(); }

function getCacheKey(listing) {
  // Si un titre enrichi est disponible, l'utiliser comme clé (meilleure précision)
  const title = listing.enrichedTitle || listing.title;
  return title.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 120);
}

function getCachedPrice(listing) {
  const key = getCacheKey(listing);
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.ts < PRICE_CACHE_TTL_MS) {
    return cached.result;
  }
  return null;
}

function setCachedPrice(listing, result) {
  if (priceCache.size >= MAX_PRICE_CACHE_SIZE) priceCache.clear();
  priceCache.set(getCacheKey(listing), { ts: Date.now(), result });
}

// ─── Shared: Build result from eBay sold listings ───────────────────────────

/**
 * Process eBay sold listings through matching + image signals + median price.
 * Shared by both Browse API and HTML scraping paths.
 */
async function buildEbayResult(soldListings, listing, config, source, search) {
  const resultCount = soldListings.length; // nombre brut avant filtrage
  const minPrice = config.minListingPriceEur || 2;
  const validSoldListings = soldListings.filter((s) => s.totalPrice >= minPrice);
  const textMatches = chooseBestSoldListings(listing, validSoldListings, search);

  if (textMatches.length === 0) return null;

  let matchedSales;
  try {
    matchedSales = await attachImageSignals(listing, textMatches, config);
  } catch {
    matchedSales = textMatches; // Continue without image signals
  }

  if (matchedSales.length === 0) {
    console.log(`    ${textMatches.length} match(es) texte rejeté(s) par image.`);
    return null;
  }

  const prices = matchedSales.map(s => s.price).filter(p => p > 0).sort((a, b) => a - b);
  if (prices.length === 0) return null;

  const medianIdx = Math.floor(prices.length / 2);
  const marketPrice = prices.length % 2 === 0
    ? (prices[medianIdx - 1] + prices[medianIdx]) / 2
    : prices[medianIdx];

  return {
    matchedSales,
    resultCount,
    pricingSource: source,
    bestMatch: matchedSales[0].title,
    marketPrice,
    confidence: matchedSales.length >= 3 ? 'high' : matchedSales.length >= 2 ? 'medium' : 'low'
  };
}

// ─── PRIORITÉ 1: eBay Browse API (officiel, pas de blocage) ─────────────────

/**
 * search (optionnel): objet search depuis config.js
 *   → transmis à getEbaySoldListingsViaApi pour sélectionner la bonne
 *     catégorie eBay et le bon builder de queries (TCG vs non-TCG)
 */
async function tryEbayBrowseApi(listing, config, search) {
  if (!config.ebayAppId || !config.ebayClientSecret) {
    console.log('    eBay Browse API: credentials manquantes (EBAY_APP_ID / EBAY_CLIENT_SECRET)');
    return null;
  }

  // Utiliser le titre enrichi (description Vinted) si disponible
  // → query eBay plus précise (chrome/base/RC/tirage) → moins de faux matches
  const effectiveTitle = listing.enrichedTitle || listing.title;
  if (listing.enrichedTitle) {
    console.log(`    eBay Browse API: titre enrichi "${listing.enrichedTitle.slice(0, 55)}"`);
  }

  try {
    const soldListings = await getEbaySoldListingsViaApi(effectiveTitle, config, search);
    if (!soldListings || soldListings.length === 0) {
      console.log('    eBay Browse API: 0 résultat');
      return null;
    }
    console.log(`    eBay Browse API: ${soldListings.length} résultat(s) bruts`);
    // Matching avec titre enrichi pour rejeter les faux positifs
    const matchingListing = listing.enrichedTitle
      ? { ...listing, title: listing.enrichedTitle }
      : listing;
    return buildEbayResult(soldListings, matchingListing, config, 'ebay-browse-api', search);
  } catch (err) {
    console.log(`    eBay Browse API erreur: ${err.message}`);
  }
  return null;
}

// ─── PRIORITÉ 2b: Apify eBay Sold Listings (fallback Browse API) ─────────────

/**
 * Tente Apify eBay Sold Listings scraper comme fallback.
 * Utilisé quand Browse API retourne 0 résultat ou erreur.
 */
async function tryApifyEbay(listing, config, search) {
  if (!process.env.APIFY_API_TOKEN) return null;

  const query = listing.enrichedTitle || listing.title;
  try {
    const apifyResult = await getApifyEbaySoldPrices(query, config);
    if (!apifyResult || apifyResult.soldListings.length === 0) return null;

    // Convertir au format attendu par buildEbayResult
    return buildEbayResult(apifyResult.soldListings, listing, config, 'apify-ebay', search);
  } catch (err) {
    console.log(`    [APIFY] Erreur dans tryApifyEbay: ${err.message}`);
  }
  return null;
}

// ─── PRIORITÉ 3: Cardmarket (souvent bloqué sur VPS) ────────────────────────

const cardmarketEnabled = process.env.CARDMARKET_ENABLED !== 'false';

async function tryCardmarketPrice(listing, config) {
  if (!cardmarketEnabled) return null;
  try {
    const result = await getCardmarketMarketPrice(listing, config);
    if (result && result.matchedSales.length > 0) {
      console.log(`    Cardmarket: ${result.bestMatch} → ${result.marketPrice.toFixed(2)}€ (${result.confidence})`);
      return result;
    }
  } catch (err) {
    console.log(`    Cardmarket erreur: ${err.message}`);
  }
  return null;
}

// ─── DERNIER: eBay HTML scraping (via Decodo Scraping API si activée) ────────

async function tryEbayHtmlScraping(listing, config, search) {
  const scrapingApiEnabled = ['1', 'true', 'yes', 'on'].includes((process.env.DECODO_SCRAPING_API || '').toLowerCase());
  if (!scrapingApiEnabled) {
    console.log('    eBay HTML scraping: désactivé (DECODO_SCRAPING_API non activé)');
    return null;
  }

  try {
    const soldListings = await getEbaySoldListings(listing.enrichedTitle || listing.title, config);
    if (!soldListings || soldListings.length === 0) {
      console.log('    eBay HTML scraping: 0 résultat');
      return null;
    }
    console.log(`    eBay HTML scraping: ${soldListings.length} résultat(s) bruts`);
    return buildEbayResult(soldListings, listing, config, 'ebay-html', search);
  } catch (err) {
    console.log(`    eBay HTML scraping erreur: ${err.message}`);
  }
  return null;
}

// ─── Route Definitions ──────────────────────────────────────────────────────

/**
 * Price route for Yu-Gi-Oh cards.
 * YGOPRODeck → eBay Browse API → Apify
 */
async function routeYugioh(listing, config) {
  // 1. YGOPRODeck API (dédié, gratuit, prix Cardmarket/TCGPlayer directs)
  try {
    const result = await getYugiohMarketPrice(listing, config);
    if (result && result.matchedSales.length > 0) {
      console.log(`    YGOPRODeck: ${result.bestMatch} → ${result.marketPrice.toFixed(2)}€ (${result.confidence})`);
      checkAndAlert('ygoprodeck', false, '');
      return result;
    }
  } catch (err) {
    console.log(`    YGOPRODeck erreur: ${err.message}`);
    checkAndAlert('ygoprodeck', true, `YGOPRODeck erreur: ${err.message}`);
  }

  // 2. eBay Browse API (fallback)
  const ebayApiResult = await tryEbayBrowseApi(listing, config);
  if (ebayApiResult) return ebayApiResult;

  // 3. Apify (dernier recours)
  const apifyResult = await tryApifyEbay(listing, config, null);
  if (apifyResult) return apifyResult;

  return null;
}

/**
 * Price route for Pokémon cards.
 * PokemonTCG.io → TCGdex+eBay → eBay Browse API → Apify
 */
async function routePokemon(listing, config) {
  // 1. PokemonTCG.io API (dédié, 20K req/jour avec clé API)
  try {
    const result = await getPokemonPriceViaTcgApi(listing, config);
    if (result && result.matchedSales.length > 0) {
      console.log(`    PokemonTCG.io: ${result.bestMatch} → ${result.marketPrice.toFixed(2)}€ (${result.confidence})`);
      checkAndAlert('pokemontcg', false, '');
      return result;
    }
  } catch (err) {
    console.log(`    PokemonTCG.io erreur: ${err.message}`);
    checkAndAlert('pokemontcg', true, `PokemonTCG.io erreur: ${err.message}`);
  }

  // 2. TCGdex + eBay sold (prix Cardmarket via TCGdex)
  try {
    const result = await getPokemonMarketPrice(listing, config);
    if (result && result.matchedSales.length > 0) {
      console.log(`    TCGdex+eBay: ${result.bestMatch} → ${result.marketPrice.toFixed(2)}€ (${result.confidence})`);
      return result;
    }
  } catch (err) {
    console.log(`    TCGdex+eBay erreur: ${err.message}`);
  }

  // 3. eBay Browse API (fallback)
  const ebayApiResult = await tryEbayBrowseApi(listing, config);
  if (ebayApiResult) return ebayApiResult;

  // 4. Apify (dernier recours)
  const apifyResult = await tryApifyEbay(listing, config, null);
  if (apifyResult) return apifyResult;

  return null;
}

/**
 * Price route for eBay-dependent products (Topps, Panini, One Piece, Sneakers, LEGO…)
 * eBay Browse API → Apify
 *
 * search (optionnel): objet search depuis config.js, transmis au Browse API
 *   pour sélectionner la catégorie et le builder de queries approprié.
 */
async function routeEbay(listing, config, search) {
  // 1. eBay Browse API (officiel, gratuit, pas de blocage)
  const ebayApiResult = await tryEbayBrowseApi(listing, config, search);
  if (ebayApiResult) return ebayApiResult;

  // 2. Apify eBay Sold Listings (fallback)
  const apifyResult = await tryApifyEbay(listing, config, search);
  if (apifyResult) return apifyResult;

  return null;
}

// ─── Route: Discogs (Vinyles) ────────────────────────────────────────────────

/**
 * Price route for vinyl records.
 * Discogs API → eBay Browse API → eBay HTML
 */
async function routeDiscogs(listing, config, search) {
  // 1. Discogs API (gratuit, prices lowest/median/recent)
  try {
    const result = await getDiscogsMarketPrice(listing, config);
    if (result && result.matchedSales.length > 0) return result;
  } catch (err) {
    console.log(`    [DISCOGS] Erreur: ${err.message}`);
  }

  // 2. eBay Browse API fallback
  const ebayResult = await tryEbayBrowseApi(listing, config, search);
  if (ebayResult) return ebayResult;

  // 3. Dernier recours: eBay HTML
  return tryEbayHtmlScraping(listing, config, search);
}

// ─── Route: Sneaks API (Sneakers) ────────────────────────────────────────────

/**
 * Price route for sneakers.
 * Sneaks API (StockX/GOAT/FlightClub) → eBay Browse API → eBay HTML
 */
async function routeSneaks(listing, config, search) {
  // 1. Sneaks API (prix de revente StockX, GOAT, FlightClub)
  try {
    const result = await getSneakersMarketPrice(listing, config);
    if (result && result.matchedSales.length > 0) return result;
  } catch (err) {
    console.log(`    [SNEAKS] Erreur: ${err.message}`);
  }

  // 2. eBay Browse API fallback
  const ebayResult = await tryEbayBrowseApi(listing, config, search);
  if (ebayResult) return ebayResult;

  // 3. Dernier recours: eBay HTML
  return tryEbayHtmlScraping(listing, config, search);
}

// ─── Route: Rebrickable (LEGO) ───────────────────────────────────────────────

/**
 * Price route for LEGO sets.
 * Rebrickable (identifie le set → enrichit la query) → eBay Browse API → eBay HTML → estimation
 */
async function routeLego(listing, config, search) {
  let enrichedListing = listing;
  let legoFallback = null;

  // 1. Rebrickable : identifier le set + construire une query eBay précise
  try {
    const legoResult = await getLegoMarketPrice(listing, config);
    if (legoResult) {
      legoFallback = legoResult; // garde l'estimation comme fallback de dernier recours
      if (legoResult.enrichedQuery) {
        enrichedListing = { ...listing, enrichedTitle: legoResult.enrichedQuery };
        console.log(`    [LEGO] Query enrichie: "${legoResult.enrichedQuery}"`);
      }
    }
  } catch (err) {
    console.log(`    [LEGO] Rebrickable erreur: ${err.message}`);
  }

  // 2. eBay Browse API avec le titre enrichi (numéro de set officiel)
  const ebayResult = await tryEbayBrowseApi(enrichedListing, config, search);
  if (ebayResult) return ebayResult;

  // 3. Apify (fallback)
  const apifyResult = await tryApifyEbay(enrichedListing, config, search);
  if (apifyResult) return apifyResult;

  // 4. Estimation Rebrickable comme ultime fallback (confidence: low)
  if (legoFallback && legoFallback.marketPrice > 0) {
    console.log('    [LEGO] Fallback: estimation Rebrickable (prix approximatif)');
    return legoFallback;
  }

  return null;
}

// ─── Main Router ────────────────────────────────────────────────────────────

/**
 * Get the best price for a Vinted listing.
 * Automatically selects the pricing source based on search type.
 *
 * @param {object} listing - Vinted listing { title, buyerPrice, imageUrl, url, ... }
 * @param {string} pricingSource - From config: 'ygoprodeck', 'pokemon-tcg-api', 'ebay'
 * @param {object} config - Global config
 * @param {object} [search] - Objet search depuis config.js (optionnel)
 *   Transmis au Browse API pour adapter la catégorie et les queries.
 * @returns {object|null} - { matchedSales, pricingSource, bestMatch, marketPrice, confidence }
 */
// ─── pricingSource → DB category ─────────────────────────────────────────

function dbCategory(pricingSource) {
  switch (pricingSource) {
    case 'pokemon-tcg-api': return 'pokemon';
    case 'ygoprodeck':      return 'yugioh';
    case 'rebrickable':     return 'lego';
    case 'discogs':         return 'discogs';
    case 'sneaks-api':      return 'sneakers';
    default:                return pricingSource || 'misc';
  }
}

async function getPrice(listing, pricingSource, config, search) {
  // Check in-memory cache first
  const cached = getCachedPrice(listing);
  if (cached) {
    return cached;
  }

  const category = dbCategory(pricingSource);

  // ── Check local price database ──────────────────────────────────────────
  const dbResult = priceDatabase.lookupPrice(listing.title, category);
  if (dbResult && dbResult.confidence === 'high' && dbResult.scanCount >= 3) {
    console.log(`  [price-db] Cache local: "${listing.title.slice(0, 50)}" → ${dbResult.price}€ (${dbResult.scanCount} scans, ${dbResult.ageDays}j)`);
    const localSale = {
      title: dbResult.ebayListingTitle || listing.title,
      price: dbResult.price,
      url: dbResult.ebayUrl || '',
      imageUrl: dbResult.ebayImageUrl || '',
      source: 'local-database',
      marketplace: dbResult.ebayUrl ? 'ebay' : 'local-database'
    };
    const localResult = {
      matchedSales: [localSale],
      pricingSource: 'local-database',
      bestMatch: localSale.title,
      marketPrice: dbResult.price,
      confidence: 'high',
      scanCount: dbResult.scanCount,
      dbListings: dbResult.listings || [],
      sourceUrls: []
    };
    // Build sourceUrls from stored eBay listings
    localResult.sourceUrls = buildSourceUrls(localResult);
    // If still empty but we have a URL from the DB, add it manually
    if (localResult.sourceUrls.length === 0 && dbResult.ebayUrl) {
      localResult.sourceUrls = [{
        url: dbResult.ebayUrl,
        title: dbResult.ebayListingTitle || listing.title,
        price: dbResult.price,
        platform: 'ebay'
      }];
    }
    setCachedPrice(listing, localResult);
    return localResult;
  }

  let result = null;

  switch (pricingSource) {
    case 'ygoprodeck':
      result = await routeYugioh(listing, config);
      break;

    case 'pokemon-tcg-api':
      result = await routePokemon(listing, config);
      break;

    case 'discogs':
      result = await routeDiscogs(listing, config, search);
      break;

    case 'sneaks-api':
      result = await routeSneaks(listing, config, search);
      break;

    case 'rebrickable':
      result = await routeLego(listing, config, search);
      break;

    case 'ebay':
    default:
      result = await routeEbay(listing, config, search);
      break;
  }

  // ── Record price in local database ──────────────────────────────────────
  if (result && result.marketPrice > 0) {
    // Pass the first matched eBay listing data for traceability
    const firstSale = result.matchedSales && result.matchedSales[0];
    const listingData = (firstSale && firstSale.url) ? {
      url: firstSale.url,
      listingTitle: firstSale.title || '',
      imageUrl: firstSale.imageUrl || ''
    } : null;
    priceDatabase.recordPrice(
      listing.title,
      category,
      result.marketPrice,
      result.pricingSource || pricingSource,
      listingData
    );
  }

  // Attach sourceUrls to the result
  if (result) {
    result.sourceUrls = buildSourceUrls(result);
  }

  // Cache the result (even nulls to avoid re-fetching)
  setCachedPrice(listing, result);

  return result;
}

// ─── Build sourceUrls from pricing result ──────────────────────────────────

/**
 * Extract source URLs from a pricing result.
 * Returns an array of { url, title, price, platform }.
 */
function buildSourceUrls(result) {
  if (!result || !result.matchedSales) return [];

  const urls = [];
  const seen = new Set();

  for (const sale of result.matchedSales) {
    // 1. Primary sourceUrl (pokemontcg.io page, ygoprodeck page, cardmarket page)
    if (sale.sourceUrl && !seen.has(sale.sourceUrl)) {
      seen.add(sale.sourceUrl);
      let platform = result.pricingSource || sale.marketplace || 'unknown';
      if (platform === 'pokemontcg-api') platform = 'pokemontcg';
      if (platform === 'ygoprodeck-set') platform = 'ygoprodeck';
      urls.push({
        url: sale.sourceUrl,
        title: sale.title || '',
        price: sale.price || sale.totalPrice || 0,
        platform: platform
      });
    }

    // 2. TCGPlayer URL (for Pokemon cards via PokemonTCG.io)
    if (sale.tcgplayerUrl && !seen.has(sale.tcgplayerUrl)) {
      seen.add(sale.tcgplayerUrl);
      urls.push({
        url: sale.tcgplayerUrl,
        title: sale.title || '',
        price: sale.price || sale.totalPrice || 0,
        platform: 'tcgplayer'
      });
    }

    // 3. Cardmarket URL (for YGO cards via YGOPRODeck)
    if (sale.cardmarketUrl && !seen.has(sale.cardmarketUrl)) {
      seen.add(sale.cardmarketUrl);
      urls.push({
        url: sale.cardmarketUrl,
        title: sale.title || '',
        price: sale.price || sale.totalPrice || 0,
        platform: 'cardmarket'
      });
    }

    // 4. eBay URL (for eBay-sourced results or local-database with stored eBay URL)
    if (sale.url && ((sale.marketplace || '').includes('ebay') || sale.source === 'local-database') && !seen.has(sale.url)) {
      seen.add(sale.url);
      urls.push({
        url: sale.url,
        title: sale.title || '',
        price: sale.totalPrice || sale.price || 0,
        platform: 'ebay'
      });
    }

    // 5. Cardmarket URL from direct cardmarket source
    if (sale.source === 'cardmarket' && sale.url && !seen.has(sale.url)) {
      seen.add(sale.url);
      urls.push({
        url: sale.url,
        title: sale.title || '',
        price: sale.price || sale.totalPrice || 0,
        platform: 'cardmarket'
      });
    }
  }

  return urls;
}

module.exports = {
  getPrice,
  clearPriceCache,
  buildSourceUrls
};
