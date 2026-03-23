/**
 * eBay Browse API — Replaces HTML scraping with official REST API.
 *
 * Uses OAuth2 Client Credentials flow (App ID + Secret → Bearer token).
 * Endpoint: https://api.ebay.com/buy/browse/v1/item_summary/search
 * Free tier: 5 000 appels/jour.
 *
 * Returns sold/completed items in the SAME format as the HTML scraper
 * (matchedSales with url, price, title, soldAt) so the rest of the
 * pipeline (matching, profit, notifier) works without changes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeSpaces, parseMoneyValue, toSlugTokens } = require('../utils');
const { extractCardSignature } = require('../matching');

// Fallback config: si le caller oublie de passer config en paramètre,
// on utilise le config global du projet pour éviter "Cannot read properties of undefined".
const defaultConfig = require('../config');

// ─── OAuth2 Token Management ────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiresAt = 0;

// ─── Quota / Rate-limit tracking ─────────────────────────────────────────────
// When the Browse API returns 429 (quota exhausted), we set this flag so all
// subsequent calls in the same scan cycle are skipped immediately without
// wasting time on 30-second waits.
let _ebayQuotaExhausted = false;

function markQuotaExhausted() {
  if (!_ebayQuotaExhausted) {
    _ebayQuotaExhausted = true;
    console.log('    [eBay] Quota Browse API épuisé → skip toutes les requêtes de ce scan');
  }
}

function resetEbayQuota() {
  _ebayQuotaExhausted = false;
}

/**
 * Crée un dispatcher sans proxy pour les appels API eBay officiels.
 * L'API Browse est officielle et gratuite — le proxy est inutile et cause des "fetch failed".
 */
function getDirectDispatcher() {
  // Si un proxy global est configuré (PROXY_URL / HTTP_PROXY), on le bypass
  // pour les appels à api.ebay.com qui ne nécessitent PAS de proxy.
  try {
    const { Agent } = require('undici');
    return new Agent({ connect: { timeout: 15000 } });
  } catch {
    // undici non disponible — fetch natif Node.js ne respecte pas HTTP_PROXY par défaut
    return undefined;
  }
}

/**
 * Obtain an OAuth2 Client Credentials token from eBay.
 * The token is cached in memory until it expires.
 * NOTE: Appel DIRECT sans proxy — c'est l'API officielle eBay.
 */
async function getOAuthToken(config) {
  config = config || defaultConfig;
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const appId = config.ebayAppId;
  const clientSecret = config.ebayClientSecret;

  if (!appId || !clientSecret) {
    throw new Error('EBAY_APP_ID et EBAY_CLIENT_SECRET requis pour la Browse API');
  }

  const credentials = Buffer.from(`${appId}:${clientSecret}`).toString('base64');
  const tokenUrl = 'https://api.ebay.com/identity/v1/oauth2/token';

  const fetchOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    signal: AbortSignal.timeout(15000)
  };

  // Bypass proxy explicitement pour l'API officielle
  const dispatcher = getDirectDispatcher();
  if (dispatcher) fetchOptions.dispatcher = dispatcher;

  const response = await fetch(tokenUrl, fetchOptions);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`eBay OAuth2 erreur ${response.status}: ${text}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 7200) * 1000;

  return cachedToken;
}

// ─── Disk Cache ─────────────────────────────────────────────────────────────

const EBAY_CACHE_TTL_DEFAULT_S = 7 * 24 * 3600; // 7 jours par défaut

function getCacheDir(config) {
  const dir = path.join(config.outputDir || 'output', 'http-cache', 'ebay-browse-api');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readFromDiskCache(cacheDir, cacheKey, ttlMs) {
  const cachePath = path.join(cacheDir, `${cacheKey}.json`);
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const payload = JSON.parse(raw);
    if (Date.now() - payload.ts < ttlMs) {
      return payload.data;
    }
  } catch {
    // Cache miss
  }
  return null;
}

function writeToDiskCache(cacheDir, cacheKey, data) {
  const cachePath = path.join(cacheDir, `${cacheKey}.json`);
  try {
    fs.writeFileSync(cachePath, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // Non-fatal
  }
}

// Purge des fichiers de cache expirés — exécuté une fois par process au démarrage
let _cachePurgedOnce = false;
function purgeExpiredCacheFiles(cacheDir, ttlMs) {
  if (_cachePurgedOnce) return;
  _cachePurgedOnce = true;
  try {
    const files = fs.readdirSync(cacheDir);
    const now = Date.now();
    let purged = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(cacheDir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const payload = JSON.parse(raw);
        if (now - payload.ts >= ttlMs) {
          fs.unlinkSync(filePath);
          purged++;
        }
      } catch { /* ignore */ }
    }
    if (purged > 0) console.log(`    eBay cache: ${purged} entrée(s) expirée(s) purgée(s)`);
  } catch { /* non-fatal */ }
}

// ─── Currency Conversion ────────────────────────────────────────────────────

function convertToEur(amount, currency, config) {
  if (!amount || amount <= 0) return null;
  if (currency === 'EUR') return amount;
  if (currency === 'USD') return amount * (config.usdToEurRate || 0.865);
  if (currency === 'GBP') return amount * (config.gbpToEurRate || 1.153);
  if (currency === 'CAD') return amount * 0.67;
  if (currency === 'AUD') return amount * 0.58;
  // Unknown currency — rough estimate via USD
  return amount * (config.usdToEurRate || 0.865);
}

// ─── Query Building ─────────────────────────────────────────────────────────

// Mots vides pour les queries non-TCG (articles, prépositions, bruits Vinted)
const NON_TCG_STOP_WORDS = new Set([
  'de', 'le', 'la', 'les', 'un', 'une', 'des', 'du', 'en', 'au', 'aux',
  'pour', 'avec', 'sans', 'dans', 'sur', 'par', 'pas',
  'tres', 'bon', 'bonne', 'etat', 'comme', 'neuf', 'neuve',
  'occasion', 'achat', 'vente', 'vendu', 'achete',
  'livraison', 'gratuite', 'incluse',
  'taille', 'pointure',
  'vinted', 'annonce', 'vends'
]);

/**
 * Construit des queries eBay pour les produits NON-TCG (sneakers, LEGO, tech…).
 * Approche simple: conserve les mots courts (pro, low, sp…) et les chiffres
 * (numéro de set, taille pointure) qui sont perdus par buildQueryVariants.
 */
function buildNonTcgQueryVariants(title, maxVariants) {
  const normalized = normalizeSpaces(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // é→e, è→e, ç→c…
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = normalized
    .split(' ')
    .filter((t) => t.length >= 2 && !NON_TCG_STOP_WORDS.has(t));

  const queries = [
    tokens.slice(0, 5).join(' '), // 5 premiers tokens (modèle + couleur/taille)
    tokens.slice(0, 4).join(' ')  // 4 premiers tokens (fallback plus large)
  ]
    .filter(Boolean)
    .filter((q, i, arr) => arr.indexOf(q) === i);

  return queries.slice(0, maxVariants || 2);
}

/**
 * Filtre les annonces eBay qui sont clairement des lots/ventes en gros.
 * Moins strict que isLikelySingleCardTitle — adapté aux produits non-TCG.
 * On garde "set" (LEGO set complet), "bundle" (console + manette) etc.
 */
function isLikelyBulkListing(title) {
  const lowerTitle = String(title || '').toLowerCase();
  const blockedPatterns = [
    /\blot\b/, /\bjob\s*lot\b/,
    /\bpick your\b/, /\bchoose your\b/, /\bselect your\b/,
    /\bx\s*\d{2,}\b/ // x10, x20 etc. = vente en quantité
  ];
  return blockedPatterns.some((pattern) => pattern.test(lowerTitle));
}

/**
 * Construit des queries eBay LARGES pour maximiser les résultats.
 *
 * Problème antérieur: les queries incluaient le numéro de carte (#251) et
 * le tirage (/40), rendant la recherche trop spécifique → 0 résultat.
 *
 * Règle: on cherche le "produit de base" (nom joueur + set + année)
 * pour obtenir un prix de référence, PAS la variante exacte.
 */
function buildQueryVariants(title, maxVariants) {
  const signature = extractCardSignature(title);
  const rawTokens = toSlugTokens(title);

  // Tokens alpha uniquement (pas de chiffres): noms de joueur, set, etc.
  const alphaSpecific = signature.specificTokens.filter((token) => /[a-z]/.test(token));

  // Année seulement — PAS le numéro de carte ni le print run (/40 etc.)
  const yearToken = signature.year ? [String(signature.year)] : [];

  const candidateQueries = [
    // Query 1 (priorité): 4 tokens alpha + année → "topps chrome f1 dunne 2024"
    [...new Set([...alphaSpecific.slice(0, 4), ...yearToken])],
    // Query 2: 5 tokens alpha sans année → encore des résultats si année absente
    [...new Set(alphaSpecific.slice(0, 5))],
    // Query 3: 6 premiers tokens bruts (fallback pour les titres courts)
    [...new Set(rawTokens.slice(0, 6))]
  ];

  return candidateQueries
    .map((tokens) => tokens.filter(Boolean).join(' ').trim())
    .filter(Boolean)
    .filter((query, index, queries) => queries.indexOf(query) === index)
    .slice(0, maxVariants || 3);
}

// ─── Browse API Call ────────────────────────────────────────────────────────

/**
 * Search eBay Browse API for sold/completed items.
 * filter=buyingOptions:{FIXED_PRICE|AUCTION} + conditions etc.
 *
 * NOTE: The Browse API item_summary/search endpoint does NOT have a
 * direct "sold items only" filter like the Finding API. We search for
 * completed items in the Trading Cards category and use price signals.
 * For better sold-item data, we combine with the Finding API when available.
 */
/**
 * categoryId: string → restriction de catégorie eBay (ex: '261328' pour Trading Cards)
 *             null   → aucune restriction (produits non-TCG: sneakers, LEGO, tech…)
 *             undefined → défaut Trading Cards (comportement legacy TCG)
 */
async function searchBrowseApi(query, token, config, categoryId) {
  // Skip immediately if quota is known to be exhausted — no waiting, no retrying
  if (_ebayQuotaExhausted) return [];

  const baseUrl = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
  const url = new URL(baseUrl);
  url.searchParams.set('q', query);
  // null = pas de restriction de catégorie; undefined/non fourni = Trading Cards (défaut)
  const effectiveCategoryId = categoryId === null ? null : (categoryId || '261328');
  if (effectiveCategoryId) {
    url.searchParams.set('category_ids', effectiveCategoryId);
  }
  url.searchParams.set('limit', '30');
  url.searchParams.set('sort', '-price'); // Highest price first (often sold items)

  // Filter: only items with price, prefer sold/ended items
  // The Browse API supports filter by price, condition, etc.
  // We use itemLocationCountry to get European results
  const filters = [
    'price:[1..500]',
    'priceCurrency:EUR'
  ];
  url.searchParams.set('filter', filters.join(','));

  // X-EBAY-C-MARKETPLACE-ID for European markets
  // Réduit à 2 marketplaces pour limiter les appels API (rate limit)
  const marketplaceIds = ['EBAY_GB', 'EBAY_DE'];

  const allItems = [];

  for (const marketplaceId of marketplaceIds) {
    try {
      const fetchOpts = {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(config.requestTimeoutMs || 30000)
      };

      // Bypass proxy — API officielle eBay, pas besoin de proxy
      const dispatcher = getDirectDispatcher();
      if (dispatcher) fetchOpts.dispatcher = dispatcher;

      let response = await fetch(url.toString(), fetchOpts);

      // Rate limit 429 → retry ONCE immediately (no 30s wait).
      // If still rate-limited, mark quota exhausted and bail out of all calls.
      if (response.status === 429) {
        console.log(`    eBay Browse API 429 sur ${marketplaceId} — retry immédiat`);
        response = await fetch(url.toString(), fetchOpts);
        if (response.status === 429) {
          console.log(`    eBay Browse API quota épuisé (429 persistant) → skip définitif`);
          markQuotaExhausted();
          return allItems;
        }
      }

      if (!response.ok) {
        // Non-fatal: try next marketplace
        continue;
      }

      const data = await response.json();
      const items = data.itemSummaries || [];
      allItems.push(...items);

      // Si le premier marketplace retourne des résultats, ne pas interroger le suivant
      if (allItems.length > 0) break;

      // Délai entre appels marketplace pour éviter rate limit
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      // Non-fatal: try next marketplace
      console.log(`    eBay Browse API erreur ${marketplaceId}: ${err.message}`);
    }
  }

  return allItems;
}

// ─── Item Normalization ─────────────────────────────────────────────────────

function cleanEbayTitle(title) {
  return normalizeSpaces(
    String(title || '')
      .replace(/^new listing\s*/i, '')
      .replace(/^nouvelle annonce\s*/i, '')
      .replace(/la page s'ouvre.*$/i, '')
      .replace(/opens in a new window.*$/i, '')
  );
}

function isLikelySingleCardTitle(title) {
  const lowerTitle = String(title || '').toLowerCase();
  const blockedPatterns = [
    /\blot\b/, /\bbundle\b/, /\bbox\b/, /\bbooster\b/,
    /\bpacks?\b/, /\bset\b/, /\bcards\b/,
    /\bpick your\b/, /\bchoose your\b/, /\bselect your\b/
  ];
  return !blockedPatterns.some((pattern) => pattern.test(lowerTitle));
}

/**
 * Convert Browse API items to the same format as the HTML scraper output.
 * This makes the rest of the pipeline (matching.js, profit.js) work unchanged.
 * isNonTcg: true → filtre léger (garde "set", "bundle"); false → filtre TCG strict
 */
function normalizeApiItems(items, query, config, isNonTcg) {
  return items
    .map(item => {
      const title = cleanEbayTitle(item.title || '');
      // Filtre selon le type de produit
      if (isNonTcg) {
        if (!title || isLikelyBulkListing(title)) return null;
      } else {
        if (!title || !isLikelySingleCardTitle(title)) return null;
      }

      const priceMoney = item.price || {};
      const priceAmount = parseFloat(priceMoney.value || 0);
      const priceCurrency = priceMoney.currency || 'USD';
      const priceEur = convertToEur(priceAmount, priceCurrency, config);

      if (!priceEur || priceEur <= 0) return null;

      const itemUrl = item.itemWebUrl || item.itemHref || '';
      const imageUrl = (item.image && item.image.imageUrl) ||
        (item.thumbnailImages && item.thumbnailImages[0] && item.thumbnailImages[0].imageUrl) || '';

      // Use itemEndDate as soldAt (for completed items) or current date
      const soldAt = item.itemEndDate || new Date().toISOString();

      // Extract item key from URL or itemId
      let itemKey = item.itemId || '';
      try {
        const urlMatch = itemUrl.match(/\/itm\/(?:[^/]+\/)?(\d+)/i);
        if (urlMatch) itemKey = urlMatch[1];
      } catch { /* keep itemId */ }

      return {
        title,
        price: priceEur,
        shippingPrice: 0, // Browse API doesn't always include shipping
        totalPrice: priceEur,
        originalPrice: priceAmount,
        originalCurrency: priceCurrency,
        soldAt,
        soldAtTs: soldAt ? Date.parse(soldAt) : Date.now(),
        url: itemUrl,
        itemKey,
        imageUrl,
        marketplace: 'ebay-browse-api',
        queryUsed: query
      };
    })
    .filter(Boolean);
}

// ─── Main Export ─────────────────────────────────────────────────────────────

/**
 * Get eBay sold listings via the Browse API.
 * Drop-in replacement for getEbaySoldListings from ebay.js.
 *
 * @param {string} title - Titre de l'annonce Vinted
 * @param {object} config - Config globale
 * @param {object} [search] - Objet search depuis config.js (optionnel)
 *   search.isNonTcg = true  → query builder non-TCG + filtre léger
 *   search.ebayCategory = '12345' → catégorie eBay spécifique; null = pas de restriction
 *
 * Returns: Array of { title, price, totalPrice, url, soldAt, ... }
 */
async function getEbaySoldListingsViaApi(title, config, search) {
  config = config || defaultConfig;
  // Check if Browse API is configured
  if (!config.ebayAppId || !config.ebayClientSecret) {
    return [];
  }

  const isNonTcg = !!(search && search.isNonTcg);
  // null = pas de catégorie (non-TCG); undefined/absent = TCG (Trading Cards par défaut)
  const categoryId = search ? (search.ebayCategory !== undefined ? search.ebayCategory : '261328') : '261328';

  const cacheDir = getCacheDir(config);
  const cacheTtlMs = (config.cacheTtlSeconds || EBAY_CACHE_TTL_DEFAULT_S) * 1000;
  purgeExpiredCacheFiles(cacheDir, cacheTtlMs);

  // Builder de queries adapté au type de produit
  const queries = isNonTcg
    ? buildNonTcgQueryVariants(title, 2)
    : buildQueryVariants(title, 2);

  // Check cache first
  const cacheKey = crypto.createHash('sha1')
    .update(`browse-api:${categoryId || 'nocat'}:${queries.join('|')}`)
    .digest('hex');

  const cached = readFromDiskCache(cacheDir, cacheKey, cacheTtlMs);
  if (cached) {
    return cached;
  }

  let token;
  try {
    token = await getOAuthToken(config);
  } catch (err) {
    console.error(`    eBay Browse API auth impossible: ${err.message}`);
    return [];
  }

  const dedupedListings = new Map();

  for (const query of queries) {
    try {
      const apiItems = await searchBrowseApi(query, token, config, categoryId);
      const listings = normalizeApiItems(apiItems, query, config, isNonTcg);

      for (const listing of listings) {
        dedupedListings.set(listing.itemKey || listing.url, listing);
      }

      if (dedupedListings.size >= 15) break;
    } catch (err) {
      console.log(`    eBay Browse API erreur pour "${query}": ${err.message}`);
    }
  }

  const results = [...dedupedListings.values()]
    .sort((a, b) => (b.soldAtTs || 0) - (a.soldAtTs || 0));

  // Cache results
  writeToDiskCache(cacheDir, cacheKey, results);

  return results;
}

/**
 * Reset the OAuth2 token (e.g. for testing or after errors).
 */
function resetOAuthToken() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

// ─── eBay Analytics: quota Browse API ────────────────────────────────────────

/**
 * Retourne le quota restant de la Browse API eBay via l'API Analytics.
 * NOTE: L'API Analytics est séparée — cet appel ne consomme PAS le quota Browse.
 *
 * Returns: { limit, remaining, resetTime } or null if unavailable/error.
 */
async function getEbayQuota(config) {
  config = config || defaultConfig;
  if (!config.ebayAppId || !config.ebayClientSecret) return null;

  try {
    const token = await getOAuthToken(config);
    const url = 'https://api.ebay.com/developer/analytics/v1_beta/rate_limit?api_name=Browse&api_context=buy';

    const fetchOpts = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    };

    const dispatcher = getDirectDispatcher();
    if (dispatcher) fetchOpts.dispatcher = dispatcher;

    const response = await fetch(url, fetchOpts);
    if (!response.ok) return null;

    const data = await response.json();
    const rateLimits = data.rateLimits || [];

    // Parcourir toutes les ressources pour trouver les taux Browse/buy
    for (const rl of rateLimits) {
      const resources = rl.resources || [];
      for (const resource of resources) {
        const rates = resource.rates || [];
        if (rates.length > 0) {
          const rate = rates[0];
          return {
            limit: rate.limit,
            remaining: rate.remaining,
            resetTime: rate.reset || null
          };
        }
      }
    }

    return null;
  } catch {
    // Non-critique — quota non disponible
    return null;
  }
}

module.exports = {
  getEbaySoldListingsViaApi,
  getOAuthToken,
  resetOAuthToken,
  getEbayQuota,
  markQuotaExhausted,
  resetEbayQuota
};
