/**
 * Leboncoin Scraper — Sourcing d'annonces TCG sous-evaluees.
 *
 * Leboncoin est une enorme plateforme francaise avec beaucoup de cartes TCG
 * vendues par des particuliers qui ne connaissent pas les prix du marche.
 *
 * STRATEGIE :
 *   - API interne JSON (POST /finder/search) — rapide mais peut changer
 *   - Fallback : scraping HTML de la page de recherche
 *   - Categories ciblees : "Collection" (cat 10) et "Jeux & Jouets" (cat 12)
 *
 * Anti-bot : User-Agent rotation, delais 2-4s, gestion captcha gracieuse.
 */

const path = require('path');
const cheerio = require('cheerio');
const { fetchText } = require('../http');
const { sleep } = require('../utils');

// ─── Constantes ─────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.leboncoin.fr';
const API_URL = 'https://api.leboncoin.fr/finder/search';
const SEARCH_DELAY_MIN_MS = 2500;
const SEARCH_DELAY_MAX_MS = 4500;
const CACHE_TTL_SECONDS = 14400; // 4h (les annonces LBC bougent vite)

// Categories Leboncoin utiles pour les TCG
const CATEGORIES = {
  collection: 10,
  jeux_jouets: 12
};

function getCacheDir(config) {
  return path.join(config.outputDir || 'output', 'http-cache', 'leboncoin');
}

function getBaseHeaders() {
  return {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'upgrade-insecure-requests': '1'
  };
}

function getApiHeaders() {
  return {
    'accept': 'application/json',
    'content-type': 'application/json',
    'accept-language': 'fr-FR,fr;q=0.9',
    'origin': BASE_URL,
    'referer': BASE_URL + '/recherche',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'api_key': 'ba0c2dad52b3ec'  // Cle publique LBC (extraite du frontend)
  };
}

// ─── API JSON (methode preferee) ────────────────────────────────────────────

/**
 * Recherche via l'API interne Leboncoin (POST JSON).
 * C'est la methode la plus fiable car elle retourne du JSON structure.
 *
 * @param {string} query - Mots-cles de recherche
 * @param {object} options - { maxPrice, category, limit }
 * @param {object} config - Config globale
 * @returns {Array<object>} Listings
 */
async function searchViaApi(query, options, config) {
  const { maxPrice, category, limit } = options;

  const body = {
    limit: limit || 30,
    limit_alu: 0,
    filters: {
      category: { id: String(category || CATEGORIES.collection) },
      keywords: { text: query },
      ranges: {}
    },
    sort_by: 'time',
    sort_order: 'desc'
  };

  if (maxPrice) {
    body.filters.ranges.price = { max: maxPrice };
  }

  const fetchOptions = {
    cacheDir: getCacheDir(config),
    cacheTtlSeconds: CACHE_TTL_SECONDS,
    minDelayMs: SEARCH_DELAY_MIN_MS,
    maxDelayMs: SEARCH_DELAY_MAX_MS,
    timeoutMs: config.requestTimeoutMs || 30000,
    headers: getApiHeaders(),
    skipCache: false
  };

  // fetchText fait du GET, on doit faire du POST manuellement ici
  // On utilise fetch directement avec les memes protections
  await sleep(SEARCH_DELAY_MIN_MS + Math.random() * (SEARCH_DELAY_MAX_MS - SEARCH_DELAY_MIN_MS));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchOptions.timeoutMs);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        ...getApiHeaders(),
        'user-agent': getRandomUserAgent()
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Leboncoin API HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data.ads || !Array.isArray(data.ads)) {
      return [];
    }

    return data.ads.map(ad => parseLeboncoinAd(ad)).filter(Boolean);
  } catch (err) {
    if (isCaptchaOrBlock(err)) {
      console.log('    Leboncoin API: bloque/captcha, tentative HTML...');
      return [];
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse une annonce JSON Leboncoin.
 */
function parseLeboncoinAd(ad) {
  if (!ad || !ad.subject) return null;

  const price = ad.price ? ad.price[0] || 0 : 0;
  if (price <= 0) return null;

  const imageUrl = (ad.images && ad.images.urls && ad.images.urls[0]) || '';
  const location = ad.location
    ? [ad.location.city, ad.location.zipcode].filter(Boolean).join(' ')
    : '';

  return {
    title: ad.subject || '',
    price,
    buyerPrice: price, // Pas de frais acheteur sur LBC (hors livraison)
    listedPrice: price,
    url: ad.url || `${BASE_URL}/ad/${ad.list_id || ''}`,
    imageUrl,
    location,
    seller: (ad.owner && ad.owner.name) || 'inconnu',
    platform: 'leboncoin',
    rawTitle: ad.subject || '',
    publishedAt: ad.first_publication_date || '',
    sourceQuery: ''
  };
}

// ─── Fallback HTML Scraping ─────────────────────────────────────────────────

/**
 * Recherche via scraping HTML (fallback si l'API est bloquee).
 *
 * @param {string} query - Mots-cles
 * @param {object} options - { maxPrice, category }
 * @param {object} config - Config globale
 * @returns {Array<object>} Listings
 */
async function searchViaHtml(query, options, config) {
  const { maxPrice, category } = options;

  const searchUrl = new URL(`${BASE_URL}/recherche`);
  searchUrl.searchParams.set('text', query);
  if (category) {
    searchUrl.searchParams.set('category', String(category));
  }
  if (maxPrice) {
    searchUrl.searchParams.set('price', `0-${maxPrice}`);
  }
  searchUrl.searchParams.set('sort', 'time');

  const fetchOptions = {
    cacheDir: getCacheDir(config),
    cacheTtlSeconds: CACHE_TTL_SECONDS,
    minDelayMs: SEARCH_DELAY_MIN_MS,
    maxDelayMs: SEARCH_DELAY_MAX_MS,
    timeoutMs: config.requestTimeoutMs || 30000,
    headers: getBaseHeaders()
  };

  let html;
  try {
    html = await fetchText(searchUrl.toString(), fetchOptions);
  } catch (err) {
    if (isCaptchaOrBlock(err)) {
      console.log('    Leboncoin HTML: captcha/block, skip');
      return [];
    }
    throw err;
  }

  if (!html || isCaptchaPage(html)) {
    console.log('    Leboncoin HTML: page captcha detectee, skip');
    return [];
  }

  const $ = cheerio.load(html);
  const listings = [];

  // Leboncoin utilise du SSR avec des data-attributes ou du JSON dans le HTML
  // Essayer d'extraire le JSON embarque d'abord (plus fiable)
  const scriptData = extractEmbeddedJson($);
  if (scriptData && scriptData.length > 0) {
    return scriptData;
  }

  // Fallback : parse le HTML directement
  // Les selecteurs peuvent changer — on essaie plusieurs patterns
  $('a[data-qa-id="aditem_container"], a[href*="/ad/"], .styles_adCard__').each(function() {
    const el = $(this);
    const title = el.find('[data-qa-id="aditem_title"], .styles_adTitle__, h3, p[data-qa-id]').first().text().trim();
    const priceText = el.find('[data-qa-id="aditem_price"], .styles_price__, .aditem_price').first().text().trim();
    const price = parsePrice(priceText);
    const href = el.attr('href') || '';
    const url = href.startsWith('http') ? href : BASE_URL + href;
    const location = el.find('[data-qa-id="aditem_location"], .styles_location__').first().text().trim();
    const img = el.find('img').first().attr('src') || '';

    if (title && price > 0) {
      listings.push({
        title,
        price,
        buyerPrice: price,
        listedPrice: price,
        url,
        imageUrl: img,
        location,
        seller: '',
        platform: 'leboncoin',
        rawTitle: title,
        sourceQuery: ''
      });
    }
  });

  return listings;
}

/**
 * Tente d'extraire les annonces depuis le JSON embarque dans les scripts LBC.
 */
function extractEmbeddedJson($) {
  const listings = [];

  $('script').each(function() {
    const content = $(this).html() || '';
    // LBC met souvent les donnees dans window.__NEXT_DATA__ ou __REDIAL_PROPS__
    const patterns = [
      /window\.__NEXT_DATA__\s*=\s*({.*?});?\s*<\/script/s,
      /__REDIAL_PROPS__\s*=\s*({.*?});?\s*<\/script/s
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (!match) continue;

      try {
        const data = JSON.parse(match[1]);
        // Naviguer dans la structure pour trouver les annonces
        const ads = findAdsInObject(data);
        for (const ad of ads) {
          const parsed = parseLeboncoinAd(ad);
          if (parsed) listings.push(parsed);
        }
      } catch {
        // JSON invalide, on continue
      }
    }
  });

  return listings;
}

/**
 * Parcourt recursivement un objet pour trouver les tableaux d'annonces.
 */
function findAdsInObject(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 8 || !obj || typeof obj !== 'object') return [];

  // Si c'est un tableau d'objets avec 'subject' et 'price', c'est des annonces
  if (Array.isArray(obj)) {
    const looksLikeAds = obj.length > 0 && obj[0] && obj[0].subject && obj[0].price;
    if (looksLikeAds) return obj;

    // Sinon chercher plus profond
    for (const item of obj.slice(0, 5)) {
      const found = findAdsInObject(item, depth + 1);
      if (found.length > 0) return found;
    }
    return [];
  }

  // Objet : chercher les cles qui ressemblent a des listes d'annonces
  const keysToCheck = ['ads', 'results', 'items', 'listings', 'props', 'pageProps', 'data'];
  for (const key of keysToCheck) {
    if (obj[key]) {
      const found = findAdsInObject(obj[key], depth + 1);
      if (found.length > 0) return found;
    }
  }

  return [];
}

// ─── Interface principale ───────────────────────────────────────────────────

/**
 * Cherche des annonces TCG sur Leboncoin.
 * Essaie l'API JSON d'abord, puis le HTML en fallback.
 *
 * @param {object} search - Config de recherche { name, vintedQueries, maxPrice, ... }
 * @param {object} config - Config globale
 * @returns {Array<object>} Listings au format standard
 */
async function getLeboncoinListings(search, config) {
  const allListings = [];
  const seen = new Set();

  // Utilise les queries dediees LBC ou celles de Vinted
  const queries = (search.leboncoinQueries || search.vintedQueries || []).slice(0, 4);
  const maxPrice = search.maxPrice || 100;

  for (const query of queries) {
    console.log(`    Leboncoin: "${query}"`);
    let results = [];

    // 1. Essayer l'API JSON
    try {
      results = await searchViaApi(query, {
        maxPrice,
        category: CATEGORIES.collection,
        limit: 30
      }, config);
    } catch (err) {
      console.log(`    Leboncoin API erreur: ${err.message}`);
    }

    // 2. Fallback HTML si l'API n'a rien donne
    if (results.length === 0) {
      try {
        results = await searchViaHtml(query, {
          maxPrice,
          category: CATEGORIES.collection
        }, config);
      } catch (err) {
        console.log(`    Leboncoin HTML erreur: ${err.message}`);
      }
    }

    // 3. Aussi chercher dans Jeux & Jouets
    if (results.length < 5) {
      try {
        const jouetsResults = await searchViaApi(query, {
          maxPrice,
          category: CATEGORIES.jeux_jouets,
          limit: 20
        }, config);
        results = results.concat(jouetsResults);
      } catch {
        // Silencieux sur le fallback categorie
      }
    }

    // Deduplique par URL
    for (const listing of results) {
      listing.sourceQuery = query;
      if (!seen.has(listing.url)) {
        seen.add(listing.url);
        allListings.push(listing);
      }
    }

    // Delai entre les queries
    if (queries.indexOf(query) < queries.length - 1) {
      await sleep(SEARCH_DELAY_MIN_MS + Math.random() * (SEARCH_DELAY_MAX_MS - SEARCH_DELAY_MIN_MS));
    }
  }

  console.log(`    Leboncoin: ${allListings.length} annonce(s) trouvee(s) pour "${search.name}"`);
  return allListings;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parsePrice(text) {
  if (!text) return 0;
  const cleaned = text.replace(/[^\d,.\-]/g, '').replace(',', '.');
  const val = parseFloat(cleaned);
  return Number.isFinite(val) && val > 0 ? val : 0;
}

function isCaptchaOrBlock(err) {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('captcha') || msg.includes('blocked') || msg.includes('403') || msg.includes('429');
}

function isCaptchaPage(html) {
  const lower = (html || '').toLowerCase();
  return lower.includes('captcha') ||
    lower.includes('recaptcha') ||
    lower.includes('datadome') ||
    lower.includes('challenge-running') ||
    lower.includes('access denied');
}

// User-Agent rotation locale (le module http.js en a aussi, mais on en a besoin pour les appels POST)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── Memory Cache ───────────────────────────────────────────────────────────

function clearMemoryCache() {
  // Rien en memoire pour l'instant, mais expose pour coherence
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getLeboncoinListings,
  clearMemoryCache
};
