const path = require('path');
const cheerio = require('cheerio');
const { extractCardSignature } = require('../matching');
const { fetchText } = require('../http');
const { decodeHtmlEntities, normalizeSpaces, parseEuroAmount } = require('../utils');

// ─── Multi-country support ─────────────────────────────────────────────────────

const VINTED_COUNTRY_DOMAINS = {
  fr: 'www.vinted.fr',
  de: 'www.vinted.de',
  es: 'www.vinted.es',
  it: 'www.vinted.it',
  be: 'www.vinted.be',
  nl: 'www.vinted.nl',
  pl: 'www.vinted.pl',
  uk: 'www.vinted.co.uk'
};

const VINTED_COUNTRY_FLAGS = {
  fr: '🇫🇷', de: '🇩🇪', es: '🇪🇸', it: '🇮🇹', be: '🇧🇪', nl: '🇳🇱', pl: '🇵🇱', uk: '🇬🇧'
};

function getVintedDomain(country) {
  return VINTED_COUNTRY_DOMAINS[country] || 'www.vinted.fr';
}

function buildVintedCatalogUrl(searchText) {
  const url = new URL('https://www.vinted.fr/catalog');
  url.searchParams.set('search_text', searchText);
  return url.toString();
}

function buildVintedCatalogUrlForCountry(searchText, country) {
  const domain = getVintedDomain(country);
  const url = new URL(`https://${domain}/catalog`);
  url.searchParams.set('search_text', searchText);
  return url.toString();
}

function getVintedSearchUrlsForCountry(search, country) {
  if (Array.isArray(search.vintedQueries) && search.vintedQueries.length > 0) {
    return search.vintedQueries.map((query) => buildVintedCatalogUrlForCountry(query, country));
  }
  if (Array.isArray(search.vintedUrls) && search.vintedUrls.length > 0) {
    const domain = getVintedDomain(country);
    return search.vintedUrls.map((u) => {
      try {
        const parsed = new URL(u);
        parsed.hostname = domain;
        return parsed.toString();
      } catch { return u; }
    });
  }
  if (search.vintedUrl) {
    try {
      const parsed = new URL(search.vintedUrl);
      parsed.hostname = getVintedDomain(country);
      return [parsed.toString()];
    } catch { return [search.vintedUrl]; }
  }
  return [];
}

function normalizeForDedup(title) {
  return (title || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function buildVintedPageUrl(baseUrl, pageNumber) {
  const url = new URL(baseUrl);
  if (pageNumber > 1) {
    url.searchParams.set('page', String(pageNumber));
  } else {
    url.searchParams.delete('page');
  }

  return url.toString();
}

function cleanVintedTitle(rawTitle, brand) {
  const titleWithoutMeta = String(rawTitle || '')
    .replace(/,\s*marque:.*$/i, '')
    .replace(/,\s*etat:.*$/i, '')
    .replace(/,\s*etat:.*$/i, '')
    .replace(/,\s*\d+[,.]\d{2}\s*€/i, '')
    .trim();

  const normalizedBrand = normalizeSpaces(brand || '');
  const normalizedTitle = normalizeSpaces(decodeHtmlEntities(titleWithoutMeta));

  if (!normalizedBrand) {
    return normalizedTitle;
  }

  return normalizedTitle.toLowerCase().includes(normalizedBrand.toLowerCase())
    ? normalizedTitle
    : `${normalizedBrand} ${normalizedTitle}`.trim();
}

function isLikelySingleCardTitle(title) {
  const lowerTitle = title.toLowerCase();
  const blockedPatterns = [
    /\blot\b/,
    /\blots\b/,
    /\bbundle\b/,
    /\bbox\b/,
    /\bbooster\b/,
    /\bpack\b/,
    /\bpacks\b/,
    /\bset complet\b/,
    /\bfull set\b/,
    /\bboite\b/,
    /\bdisplay\b/,
    /\bsealed\b/
  ];

  return !blockedPatterns.some((pattern) => pattern.test(lowerTitle));
}

function computeSpecificityScore(title) {
  const signature = extractCardSignature(title);

  let score = signature.specificTokens.length;
  if (signature.year) {
    score += 2;
  }
  if (signature.cardNumber) {
    score += 3;
  }
  if (signature.printRun) {
    score += 4;
  }
  if (signature.rookie) {
    score += 1;
  }
  if (signature.graded) {
    score += 2;
  }
  if (signature.autograph) {
    score += 2;
  }

  return score;
}

function matchesSearchProfile(listing, search) {
  const normalized = normalizeSpaces(`${listing.title} ${listing.rawTitle || ''}`.toLowerCase());
  const requiredAllTokens = search.requiredAllTokens || [];
  const requiredAnyTokens = search.requiredAnyTokens || [];
  const blockedTokens = search.blockedTokens || [];

  if (requiredAllTokens.some((token) => !normalized.includes(token.toLowerCase()))) {
    return false;
  }

  if (requiredAnyTokens.length > 0 && !requiredAnyTokens.some((token) => normalized.includes(token.toLowerCase()))) {
    return false;
  }

  if (blockedTokens.some((token) => normalized.includes(token.toLowerCase()))) {
    return false;
  }

  return true;
}

// ─── JSON API extraction (embedded catalog data) ───────────────────────────

function tryExtractJsonListings(html) {
  // Vinted embeds catalog data as JSON in script tags or __NEXT_DATA__
  const patterns = [
    // Next.js data pattern
    /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
    // Generic JSON catalog data in script tags
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
    // Catalog items JSON pattern
    /"catalogItems"\s*:\s*(\[[\s\S]*?\])\s*[,}]/i,
    /"items"\s*:\s*(\[[\s\S]*?\])\s*[,}]/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match || !match[1]) continue;

    try {
      let data = JSON.parse(match[1]);

      // If __NEXT_DATA__, dig into the catalog items
      if (data && data.props) {
        const pageProps = data.props.pageProps || data.props.initialProps || {};
        const catalogItems = pageProps.catalogItems || pageProps.items || [];
        if (Array.isArray(catalogItems) && catalogItems.length > 0) {
          data = catalogItems;
        }
      }

      if (!Array.isArray(data)) continue;

      const listings = [];
      for (const item of data) {
        if (!item) continue;
        const title = item.title || item.name || '';
        const price = item.price
          ? (typeof item.price === 'object' ? parseFloat(item.price.amount || item.price.value || 0) : parseFloat(item.price))
          : null;
        const totalPrice = item.total_item_price
          ? (typeof item.total_item_price === 'object' ? parseFloat(item.total_item_price.amount || 0) : parseFloat(item.total_item_price))
          : price;
        const url = item.url || item.path || (item.id ? `/items/${item.id}` : '');
        const photo = item.photo || item.photos?.[0] || {};
        const imageUrl = photo.url || photo.full_size_url || photo.thumbnails?.[0]?.url || '';

        if (title && price && url) {
          const user = item.user || {};
          listings.push({
            title: normalizeSpaces(decodeHtmlEntities(title)),
            listedPrice: price,
            buyerPrice: totalPrice || price,
            url: url.startsWith('http') ? url : `https://www.vinted.fr${url}`,
            imageUrl,
            rawTitle: normalizeSpaces(decodeHtmlEntities(title)),
            brand: item.brand_title || item.brand || '',
            // Données vendeur pour seller-score.js
            user: {
              feedback_count: user.feedback_count ?? null,
              feedback_reputation: user.feedback_reputation ?? null,
              given_item_count: user.given_item_count ?? null
            }
          });
        }
      }

      if (listings.length > 0) {
        return listings;
      }
    } catch {
      // JSON parse failed — try next pattern
      continue;
    }
  }

  return null;
}

// ─── HTML parsing with robust fallback selectors ───────────────────────────

function parseVintedPageHtml(html) {
  const $ = cheerio.load(html);
  const listings = [];

  // Primary selectors (current Vinted layout)
  const primarySelectors = [
    '.feed-grid__item',
    '[class*="feed-grid"] > div',
    '[class*="ItemBox"]',
    '[data-testid*="item-box"]',
    '.web_ui__ItemBox',
    'a[href*="/items/"]'
  ];

  let itemSelector = null;
  for (const sel of primarySelectors) {
    if ($(sel).length > 0) {
      itemSelector = sel;
      break;
    }
  }

  if (!itemSelector) {
    return listings;
  }

  $(itemSelector).each((_, element) => {
    const card = $(element);

    // Find link to item (multiple fallback selectors)
    const link = card.is('a[href*="/items/"]')
      ? card
      : card.find('a[href*="/items/"]').first();
    const image = card.find('img').first();

    // Brand extraction with fallback selectors
    const brand = card.find('[data-testid$="--description-title"]').first().text()
      || card.find('[class*="ItemBox__description"] [class*="title"]').first().text()
      || '';

    // Price extraction with fallback selectors
    const listedPriceText = card.find('[data-testid$="--price-text"]').first().text()
      || card.find('[class*="ItemBox__price"]').first().text()
      || card.find('[class*="price"]').first().text()
      || '';
    const buyerPriceText = card.find('[data-testid="total-combined-price"]').first().text()
      || card.find('[class*="total"]').first().text()
      || '';

    const rawTitle = link.attr('title') || image.attr('alt') || link.text() || '';

    const title = cleanVintedTitle(rawTitle, brand);
    const listedPrice = parseEuroAmount(listedPriceText);
    const buyerPrice = parseEuroAmount(buyerPriceText) || listedPrice;
    const href = link.attr('href') || '';

    if (!title || !listedPrice || !href || !isLikelySingleCardTitle(title)) {
      return;
    }

    listings.push({
      title,
      listedPrice,
      buyerPrice,
      url: href.startsWith('http') ? href : `https://www.vinted.fr${href}`,
      imageUrl: image.attr('src') || image.attr('data-src') || '',
      rawTitle: normalizeSpaces(decodeHtmlEntities(rawTitle)),
      specificityScore: computeSpecificityScore(title)
    });
  });

  return listings;
}

function parseVintedPage(html) {
  // Strategy 1: Try to extract from embedded JSON first (more reliable)
  const jsonListings = tryExtractJsonListings(html);
  if (jsonListings && jsonListings.length > 0) {
    // Add specificity scores and filter
    return jsonListings
      .filter((l) => isLikelySingleCardTitle(l.title))
      .map((l) => ({
        ...l,
        title: cleanVintedTitle(l.rawTitle, l.brand),
        specificityScore: computeSpecificityScore(l.title)
      }));
  }

  // Strategy 2: HTML parsing with robust selectors
  const htmlListings = parseVintedPageHtml(html);
  return htmlListings;
}

// ─── Diagnostics: detect parsing failures ──────────────────────────────────

function diagnoseParsingResult(html, listings, pageUrl) {
  if (listings.length > 0) return; // All good

  const $ = cheerio.load(html);
  const bodyText = $('body').text().toLowerCase();
  const bodyLength = html.length;

  // Check if the page is actually empty (no items to list)
  if (bodyLength < 2000) {
    console.warn(`  [VINTED DIAG] Page tres courte (${bodyLength} chars) - probablement vide: ${pageUrl}`);
    return;
  }

  // Check for anti-bot / captcha
  const blockedMarkers = ['captcha', 'robot', 'access denied', 'cloudflare', 'just a moment'];
  const isBlocked = blockedMarkers.some((m) => bodyText.includes(m));
  if (isBlocked) {
    console.error(`  [VINTED DIAG] PAGE BLOQUEE (anti-bot/captcha) pour: ${pageUrl}`);
    return;
  }

  // Check if page has items but selectors are broken
  const hasItemLinks = $('a[href*="/items/"]').length;
  const hasImages = $('img').length;
  const hasPrices = bodyText.match(/\d+[.,]\d{2}\s*€/g);

  if (hasItemLinks > 0 || (hasImages > 5 && hasPrices)) {
    console.error(`  [VINTED DIAG] PARSING CASSE - La page contient des annonces mais 0 extraites!`);
    console.error(`    Links /items/: ${hasItemLinks}, Images: ${hasImages}, Prix trouves: ${hasPrices ? hasPrices.length : 0}`);
    console.error(`    Selectors a mettre a jour dans vinted.js`);

    // Log some class names to help debug
    const gridClasses = [];
    $('[class*="grid"], [class*="feed"], [class*="catalog"], [class*="item"]').each((_, el) => {
      const cls = $(el).attr('class');
      if (cls) gridClasses.push(cls.split(' ')[0]);
    });
    if (gridClasses.length > 0) {
      console.error(`    Classes trouvees: ${[...new Set(gridClasses)].slice(0, 10).join(', ')}`);
    }
  } else {
    console.warn(`  [VINTED DIAG] Page sans contenu identifiable (${bodyLength} chars): ${pageUrl}`);
  }
}

function getVintedSearchUrls(search) {
  if (Array.isArray(search.vintedUrls) && search.vintedUrls.length > 0) {
    return search.vintedUrls;
  }

  if (Array.isArray(search.vintedQueries) && search.vintedQueries.length > 0) {
    return search.vintedQueries.map((query) => buildVintedCatalogUrl(query));
  }

  return search.vintedUrl ? [search.vintedUrl] : [];
}

function interleaveListings(lists, limit) {
  const selected = [];
  const seenUrls = new Set();
  let index = 0;

  while (selected.length < limit) {
    let addedAtThisIndex = false;

    for (const list of lists) {
      const listing = list[index];
      if (!listing || seenUrls.has(listing.url)) {
        continue;
      }

      selected.push(listing);
      seenUrls.add(listing.url);
      addedAtThisIndex = true;

      if (selected.length >= limit) {
        break;
      }
    }

    if (!addedAtThisIndex) {
      break;
    }

    index += 1;
  }

  return selected;
}

function buildCandidatePools(listings, config) {
  const bySpecificity = [...listings].sort((left, right) => {
    const specificityDiff = right.specificityScore - left.specificityScore;
    if (specificityDiff !== 0) {
      return specificityDiff;
    }

    return left.buyerPrice - right.buyerPrice;
  });

  const preciseListings = bySpecificity.filter(
    (listing) => listing.specificityScore >= config.minListingSpecificity
  );
  const baselinePool = preciseListings.length >= Math.min(6, config.maxItemsPerSearch)
    ? preciseListings
    : bySpecificity;
  const byCheapest = [...baselinePool].sort((left, right) => {
    const priceDiff = left.buyerPrice - right.buyerPrice;
    if (priceDiff !== 0) {
      return priceDiff;
    }

    return right.specificityScore - left.specificityScore;
  });
  const byValueDensity = [...baselinePool].sort((left, right) => {
    const leftRatio = left.specificityScore / Math.max(left.buyerPrice || 0, 1);
    const rightRatio = right.specificityScore / Math.max(right.buyerPrice || 0, 1);
    const ratioDiff = rightRatio - leftRatio;
    if (ratioDiff !== 0) {
      return ratioDiff;
    }

    return right.specificityScore - left.specificityScore;
  });

  return [baselinePool, byCheapest, byValueDensity];
}

function pickCandidateListings(listings, config, limit) {
  const [baselinePool, byCheapest, byValueDensity] = buildCandidatePools(listings, config);

  return interleaveListings(
    [baselinePool, byCheapest, byValueDensity],
    limit
  );
}

function selectCandidateListings(listings, config) {
  const groupedListings = new Map();
  for (const listing of listings) {
    const queryKey = listing.sourceQuery || 'default';
    const bucket = groupedListings.get(queryKey) || [];
    bucket.push(listing);
    groupedListings.set(queryKey, bucket);
  }

  const perQueryLimit = Math.max(
    1,
    Math.ceil(config.maxItemsPerSearch / Math.max(groupedListings.size, 1))
  );

  const diversifiedSelections = [...groupedListings.values()]
    .map((bucket) => pickCandidateListings(bucket, config, perQueryLimit))
    .filter((bucket) => bucket.length > 0);

  const primarySelection = interleaveListings(diversifiedSelections, config.maxItemsPerSearch);
  const fallbackSelection = pickCandidateListings(listings, config, config.maxItemsPerSearch * 2);
  const mergedSelection = [];
  const seenUrls = new Set();

  for (const listing of [...primarySelection, ...fallbackSelection]) {
    if (seenUrls.has(listing.url)) {
      continue;
    }

    mergedSelection.push(listing);
    seenUrls.add(listing.url);

    if (mergedSelection.length >= config.maxItemsPerSearch) {
      break;
    }
  }

  return mergedSelection;
}

async function getVintedListings(search, config) {
  const cacheDir = path.join(config.outputDir, 'http-cache', 'vinted');
  const dedupedListings = new Map();
  // Cross-country dedup by normalized title to avoid same card from multiple Vinted domains
  const crossCountryKeys = new Set();
  const countries = (config.vintedCountries && config.vintedCountries.length > 0)
    ? config.vintedCountries
    : ['fr'];
  let totalPagesScraped = 0;
  let totalParsingFailures = 0;

  for (const country of countries) {
    const searchUrls = getVintedSearchUrlsForCountry(search, country);

    for (const baseUrl of searchUrls) {
      let collectedForQuery = 0;

      for (let pageNumber = 1; pageNumber <= config.vintedPagesPerSearch; pageNumber += 1) {
        if (
          collectedForQuery >= config.vintedMaxListingsPerQuery ||
          dedupedListings.size >= config.vintedMaxListingsPerSearch
        ) {
          break;
        }

        const pageUrl = buildVintedPageUrl(baseUrl, pageNumber);
        const html = await fetchText(pageUrl, {
          timeoutMs: config.requestTimeoutMs,
          cacheDir,
          cacheTtlSeconds: config.cacheTtlSeconds,
          minDelayMs: config.httpMinDelayMs,
          maxDelayMs: config.httpMaxDelayMs
        });

        const pageListings = parseVintedPage(html);
        totalPagesScraped += 1;

        if (!pageListings.length) {
          // Run diagnostics to understand WHY 0 listings were parsed
          diagnoseParsingResult(html, pageListings, pageUrl);
          totalParsingFailures += 1;
          break;
        }

        let newListings = 0;
        for (const listing of pageListings) {
          if (
            listing.listedPrice > search.maxPrice ||
            dedupedListings.has(listing.url) ||
            !matchesSearchProfile(listing, search)
          ) {
            continue;
          }

          // Cross-country dedup: skip if same normalized title already seen from another country
          const dedupKey = normalizeForDedup(listing.title) + '|' + listing.listedPrice;
          if (crossCountryKeys.has(dedupKey)) {
            continue;
          }
          crossCountryKeys.add(dedupKey);

          dedupedListings.set(listing.url, {
            ...listing,
            sourceQuery: new URL(baseUrl).searchParams.get('search_text') || '',
            vintedCountry: country,
            vintedCountryFlag: VINTED_COUNTRY_FLAGS[country] || ''
          });
          newListings += 1;
          collectedForQuery += 1;

          if (
            collectedForQuery >= config.vintedMaxListingsPerQuery ||
            dedupedListings.size >= config.vintedMaxListingsPerSearch
          ) {
            break;
          }
        }

        if (
          newListings === 0 ||
          collectedForQuery >= config.vintedMaxListingsPerQuery ||
          dedupedListings.size >= config.vintedMaxListingsPerSearch
        ) {
          break;
        }
      }

      if (dedupedListings.size >= config.vintedMaxListingsPerSearch) {
        break;
      }
    }

    if (dedupedListings.size >= config.vintedMaxListingsPerSearch) {
      break;
    }
  }

  // Summary diagnostics
  if (totalPagesScraped > 0 && dedupedListings.size === 0) {
    console.error(`  [VINTED] ALERTE: ${totalPagesScraped} pages scrapees mais 0 annonces extraites pour "${search.name}"`);
    if (totalParsingFailures === totalPagesScraped) {
      console.error(`  [VINTED] Toutes les pages ont echoue au parsing - les selecteurs CSS sont probablement casses!`);
    }
  }

  return selectCandidateListings([...dedupedListings.values()], config);
}

// ─── Fetch Vinted item description ─────────────────────────────────────────

/**
 * Récupère la description d'une annonce Vinted individuelle.
 * Utilise le même cache HTTP que le scraper principal.
 *
 * Stratégie:
 *   1. Extraction depuis __NEXT_DATA__ JSON (source principale)
 *   2. Fallback sélecteurs HTML
 *
 * @param {string} url - URL complète de l'annonce Vinted
 * @param {object} config - Config globale (outputDir, timeouts, delays…)
 * @returns {string|null} - Description brute (max 600 chars) ou null si indisponible
 */
async function fetchVintedDescription(url, config) {
  const cacheDir = path.join(config.outputDir, 'http-cache', 'vinted-desc');
  try {
    const html = await fetchText(url, {
      timeoutMs: config.requestTimeoutMs,
      cacheDir,
      cacheTtlSeconds: config.cacheTtlSeconds,
      minDelayMs: config.httpMinDelayMs,
      maxDelayMs: config.httpMaxDelayMs
    });

    // Extraction depuis __NEXT_DATA__ (méthode principale, fiable)
    const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch) {
      try {
        const data = JSON.parse(nextDataMatch[1]);
        const item = data && data.props && data.props.pageProps && data.props.pageProps.item;
        if (item && item.description) {
          return String(item.description).trim().slice(0, 600);
        }
      } catch {
        // JSON parse failed — fallback HTML
      }
    }

    // Fallback: sélecteurs HTML connus de Vinted
    const $ = cheerio.load(html);
    const descSelectors = [
      '[data-testid="item-description"]',
      '[itemprop="description"]',
      '[class*="ItemDescription"]',
      '[class*="item-description"]'
    ];
    for (const sel of descSelectors) {
      const text = $(sel).first().text().trim();
      if (text && text.length > 10) {
        return text.slice(0, 600);
      }
    }
  } catch (err) {
    console.warn(`  [VINTED DESC] ${url.slice(0, 80)}: ${err.message}`);
  }
  return null;
}

module.exports = {
  getVintedListings,
  fetchVintedDescription
};
