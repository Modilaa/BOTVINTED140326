/**
 * Cardmarket Scraper — Prix de reference + sourcing d'annonces sous-evaluees.
 *
 * DEUX MODES :
 *   1. PRICING : scrape le "Price Trend", le prix "From" et la moyenne 30j
 *      → utilise par le price-router comme source prioritaire pour les cartes TCG EU
 *   2. SOURCING : cherche les vendeurs qui listent en dessous du trend
 *      → genere des opportunites d'achat (comme Vinted)
 *
 * Anti-bot : User-Agent rotation, delais 2-4s, cache disque 24h, gestion captcha gracieuse.
 */

const path = require('path');
const cheerio = require('cheerio');
const { fetchText } = require('../http');
const { sleep } = require('../utils');

// ─── Mapping jeu → path Cardmarket ──────────────────────────────────────────

const GAME_PATHS = {
  'yugioh':   'YuGiOh',
  'yu-gi-oh': 'YuGiOh',
  'pokemon':  'Pokemon',
  'onepiece':  'OnePiece',
  'one piece': 'OnePiece',
  'magic':     'Magic',
  'mtg':       'Magic',
  'topps':     'Topps'
};

/**
 * Detecte le jeu a partir du titre ou de la config de recherche.
 */
function detectGame(titleOrSearchName) {
  const lower = (titleOrSearchName || '').toLowerCase();
  if (lower.includes('pokemon') || lower.includes('pokémon')) return 'Pokemon';
  if (lower.includes('yugioh') || lower.includes('yu-gi-oh') || lower.includes('yu gi oh')) return 'YuGiOh';
  if (lower.includes('one piece')) return 'OnePiece';
  if (lower.includes('magic') || lower.includes('mtg')) return 'Magic';
  if (lower.includes('topps')) return 'Topps';
  // Defaut : Pokemon (le plus courant)
  return 'Pokemon';
}

// ─── Constantes ─────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.cardmarket.com';
const SEARCH_DELAY_MIN_MS = 2000;
const SEARCH_DELAY_MAX_MS = 4000;
const CACHE_TTL_SECONDS = 86400; // 24h

function getCacheDir(config) {
  return path.join(config.outputDir || 'output', 'http-cache', 'cardmarket');
}

function getFetchOptions(config) {
  return {
    cacheDir: getCacheDir(config),
    cacheTtlSeconds: CACHE_TTL_SECONDS,
    minDelayMs: SEARCH_DELAY_MIN_MS,
    maxDelayMs: SEARCH_DELAY_MAX_MS,
    timeoutMs: config.requestTimeoutMs || 30000,
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9,fr;q=0.8,de;q=0.7',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'upgrade-insecure-requests': '1'
    }
  };
}

// ─── 1. PRICING : Scrape les prix d'une carte specifique ────────────────────

/**
 * Recherche une carte sur Cardmarket et retourne les infos de prix.
 *
 * @param {string} query - Nom de la carte a chercher
 * @param {string} game - Jeu : 'Pokemon', 'YuGiOh', 'OnePiece', 'Magic', 'Topps'
 * @param {object} config - Config globale
 * @returns {object|null} { priceTrend, priceFrom, priceAvg30, url, title, source }
 */
async function getCardmarketPrice(query, game, config) {
  const gamePath = GAME_PATHS[game.toLowerCase()] || game;
  const searchUrl = `${BASE_URL}/en/${gamePath}/Products/Search?searchString=${encodeURIComponent(query)}`;

  let html;
  try {
    html = await fetchText(searchUrl, getFetchOptions(config));
  } catch (err) {
    if (isCaptchaOrBlock(err)) {
      console.log('    Cardmarket: captcha/block detecte, skip');
      return null;
    }
    throw err;
  }

  if (!html || isCaptchaPage(html)) {
    console.log('    Cardmarket: page captcha, skip');
    return null;
  }

  const $ = cheerio.load(html);

  // Cherche le premier resultat de recherche
  const firstResult = $('.table-body .row a.col-10, .table-body .row a[href*="/Products/Singles/"]').first();
  if (!firstResult.length) {
    // Peut-etre qu'on est directement sur la page produit (redirect)
    return parseProductPage($, searchUrl);
  }

  const productHref = firstResult.attr('href');
  if (!productHref) return null;

  const productUrl = productHref.startsWith('http') ? productHref : BASE_URL + productHref;
  const productTitle = firstResult.text().trim();

  // Attendre avant la requete suivante
  await sleep(SEARCH_DELAY_MIN_MS + Math.random() * (SEARCH_DELAY_MAX_MS - SEARCH_DELAY_MIN_MS));

  // Scrape la page produit pour les prix detailles
  let productHtml;
  try {
    productHtml = await fetchText(productUrl, getFetchOptions(config));
  } catch (err) {
    if (isCaptchaOrBlock(err)) return null;
    throw err;
  }

  if (!productHtml || isCaptchaPage(productHtml)) return null;

  const $product = cheerio.load(productHtml);
  return parseProductPage($product, productUrl, productTitle);
}

/**
 * Parse la page produit Cardmarket pour extraire les prix.
 */
function parseProductPage($, url, fallbackTitle) {
  // Prix trend — cherche dans la section "Price Trend" ou "Tendance des prix"
  const priceTrend = extractPriceFromLabel($, ['Price Trend', 'Tendance des prix', 'Preistrend']);
  const priceFrom = extractPriceFromLabel($, ['From', 'A partir de', 'Ab', 'Starting from']);
  const priceAvg30 = extractPriceFromLabel($, ['30-days average price', 'Avg. sell price (30 days)', 'Prix moyen 30 jours']);

  // Titre du produit
  const title = $('h1').first().text().trim() || fallbackTitle || '';

  // Si aucun prix trouve, essayer le format tableau info
  const infoTable = {};
  $('dl.labeled dt, .info-list-container dt, .col-6.col-lg-3 dt').each(function() {
    const label = $(this).text().trim();
    const value = $(this).next('dd').text().trim();
    infoTable[label] = value;
  });

  const trend = priceTrend || parseEuroPrice(infoTable['Price Trend'] || infoTable['Tendance des prix'] || '');
  const from = priceFrom || parseEuroPrice(infoTable['From'] || infoTable['A partir de'] || '');
  const avg30 = priceAvg30 || parseEuroPrice(infoTable['30-days average price'] || '');

  if (!trend && !from) {
    return null;
  }

  return {
    priceTrend: trend || from || 0,
    priceFrom: from || trend || 0,
    priceAvg30: avg30 || trend || from || 0,
    url,
    title,
    source: 'cardmarket'
  };
}

function extractPriceFromLabel($, labels) {
  for (const label of labels) {
    // Cherche dans les dt/dd pairs
    $('dt').each(function() {
      const text = $(this).text().trim();
      if (text.includes(label)) {
        const dd = $(this).next('dd');
        if (dd.length) {
          const price = parseEuroPrice(dd.text());
          if (price > 0) return price;
        }
      }
    });

    // Cherche dans les spans/divs avec label
    const selector = `*:contains("${label}")`;
    $(selector).each(function() {
      const parent = $(this).parent();
      const priceEl = parent.find('.font-weight-bold, .price-tag, .text-right, span.d-block');
      if (priceEl.length) {
        const price = parseEuroPrice(priceEl.first().text());
        if (price > 0) return price;
      }
    });
  }
  return 0;
}

function parseEuroPrice(text) {
  if (!text) return 0;
  // Cardmarket utilise le format "1,23 EUR" ou "1.23 EUR" ou "1,23 $"
  const cleaned = text.replace(/[^\d,.\-]/g, '').replace(',', '.');
  const val = parseFloat(cleaned);
  return Number.isFinite(val) && val > 0 ? val : 0;
}

// ─── 2. PRICING pour le price-router (format unifie) ────────────────────────

/**
 * Interface compatible avec le price-router.
 * Retourne le format standard { matchedSales, pricingSource, bestMatch, marketPrice, confidence }
 *
 * @param {object} listing - Listing a evaluer { title, buyerPrice, ... }
 * @param {object} config - Config globale
 * @returns {object|null}
 */
async function getCardmarketMarketPrice(listing, config) {
  const game = detectGame(listing.searchName || listing.title);

  const priceData = await getCardmarketPrice(listing.title, game, config);
  if (!priceData || priceData.priceTrend <= 0) {
    return null;
  }

  // Construire un "matchedSale" synthetique a partir du prix Cardmarket
  const matchedSale = {
    title: priceData.title || listing.title,
    price: priceData.priceTrend,
    totalPrice: priceData.priceTrend,
    url: priceData.url,
    source: 'cardmarket',
    isApiPrice: true,
    sourceUrl: priceData.url,
    cardmarketUrl: priceData.url
  };

  const confidence = priceData.priceAvg30 > 0 ? 'high' : (priceData.priceFrom > 0 ? 'medium' : 'low');

  return {
    matchedSales: [matchedSale],
    pricingSource: 'cardmarket',
    bestMatch: priceData.title || listing.title,
    marketPrice: priceData.priceTrend,
    confidence
  };
}

// ─── 3. SOURCING : Trouver les annonces sous-evaluees ───────────────────────

/**
 * Cherche les cartes en vente sur Cardmarket en dessous du prix de tendance.
 *
 * @param {object} search - Config de recherche { name, vintedQueries, ... }
 * @param {object} config - Config globale
 * @returns {Array<object>} Listings au format standard
 */
async function getCardmarketListings(search, config) {
  const game = detectGame(search.name);
  const gamePath = GAME_PATHS[game.toLowerCase()] || game;
  const listings = [];
  const seen = new Set();

  // Utilise les queries Vinted adaptees pour Cardmarket
  const queries = (search.cardmarketQueries || search.vintedQueries || []).slice(0, 3);

  for (const query of queries) {
    try {
      const searchUrl = `${BASE_URL}/en/${gamePath}/Products/Search?searchString=${encodeURIComponent(query)}`;

      let html;
      try {
        html = await fetchText(searchUrl, getFetchOptions(config));
      } catch (err) {
        if (isCaptchaOrBlock(err)) {
          console.log(`    Cardmarket: captcha sur "${query}", skip`);
          continue;
        }
        throw err;
      }

      if (!html || isCaptchaPage(html)) continue;

      const $ = cheerio.load(html);

      // Parse les resultats de recherche — chaque produit a un lien + prix
      const productLinks = [];
      $('.table-body .row, .search-results .row, tr[data-href]').each(function() {
        const link = $(this).find('a[href*="/Products/Singles/"]').first();
        const href = link.attr('href') || $(this).attr('data-href') || '';
        const name = link.text().trim();
        const priceText = $(this).find('.price-container, .col-price, td:last-child').text();
        const price = parseEuroPrice(priceText);

        if (href && name && price > 0) {
          productLinks.push({
            url: href.startsWith('http') ? href : BASE_URL + href,
            title: name,
            price
          });
        }
      });

      // Pour chaque produit, verifier si le prix "From" est bien en dessous du trend
      // On limite a 5 produits par query pour ne pas surcharger
      for (const product of productLinks.slice(0, 5)) {
        if (seen.has(product.url)) continue;
        seen.add(product.url);

        await sleep(SEARCH_DELAY_MIN_MS + Math.random() * (SEARCH_DELAY_MAX_MS - SEARCH_DELAY_MIN_MS));

        let productHtml;
        try {
          productHtml = await fetchText(product.url, getFetchOptions(config));
        } catch (err) {
          if (isCaptchaOrBlock(err)) continue;
          console.log(`    Cardmarket produit erreur: ${err.message}`);
          continue;
        }

        if (!productHtml || isCaptchaPage(productHtml)) continue;

        const $p = cheerio.load(productHtml);
        const priceData = parseProductPage($p, product.url, product.title);
        if (!priceData || !priceData.priceTrend) continue;

        // Cherche les vendeurs avec des offres en dessous du trend
        const deals = parseSellerOffers($p, priceData.priceTrend, product.url);
        for (const deal of deals) {
          listings.push({
            title: `${priceData.title || product.title}`,
            price: deal.price,
            buyerPrice: deal.price + 1.5, // Estimation frais d'envoi Cardmarket
            listedPrice: deal.price,
            url: deal.url || product.url,
            imageUrl: '',
            seller: deal.seller,
            condition: deal.condition,
            platform: 'cardmarket',
            trendPrice: priceData.priceTrend,
            discount: Math.round((1 - deal.price / priceData.priceTrend) * 100),
            rawTitle: priceData.title || product.title,
            sourceQuery: query
          });
        }
      }
    } catch (err) {
      console.log(`    Cardmarket query "${query}" erreur: ${err.message}`);
    }
  }

  return listings;
}

/**
 * Parse les offres vendeurs sur une page produit.
 * Retourne celles qui sont 30%+ en dessous du trend.
 */
function parseSellerOffers($, trendPrice, productUrl) {
  const deals = [];
  const discountThreshold = 0.30; // 30% en dessous

  // Cardmarket liste les offres dans un tableau
  // Selecteurs adaptes aux differents formats de page
  $('.table-body .row, .article-table .row, .offers-table tr, .table tr').each(function() {
    const priceText = $(this).find('.price-container, .col-offer-price, .price, .col-price, td.price').text();
    const price = parseEuroPrice(priceText);
    if (!price || price <= 0) return;

    // Verifier le seuil de discount
    const discount = 1 - price / trendPrice;
    if (discount < discountThreshold) return;

    const seller = $(this).find('.seller-name a, .col-seller a, td.seller a, a[href*="/Users/"]').first().text().trim() || 'inconnu';
    const condition = $(this).find('.badge, .article-condition, .product-condition, .col-condition').first().text().trim() || '';
    const offerLink = $(this).find('a[href*="/Offers/"]').first().attr('href');
    const url = offerLink ? (offerLink.startsWith('http') ? offerLink : BASE_URL + offerLink) : productUrl;

    deals.push({ price, seller, condition, url });
  });

  return deals;
}

// ─── Detection anti-bot ─────────────────────────────────────────────────────

function isCaptchaOrBlock(err) {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('captcha') || msg.includes('blocked') || msg.includes('403') || msg.includes('429');
}

function isCaptchaPage(html) {
  const lower = (html || '').toLowerCase();
  return lower.includes('captcha') ||
    lower.includes('recaptcha') ||
    lower.includes('challenge-running') ||
    lower.includes('please verify') ||
    lower.includes('access denied');
}

// ─── Memory Cache ───────────────────────────────────────────────────────────

const memoryCache = new Map();

function clearMemoryCache() {
  memoryCache.clear();
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getCardmarketPrice,
  getCardmarketMarketPrice,
  getCardmarketListings,
  detectGame,
  clearMemoryCache
};
