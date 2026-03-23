const path = require('path');
const cheerio = require('cheerio');
const { extractCardSignature } = require('../matching');
const { fetchText } = require('../http');
const { decodeHtmlEntities, normalizeSpaces, parseEuroAmount } = require('../utils');

function buildVintedCatalogUrl(searchText) {
  const url = new URL('https://www.vinted.fr/catalog');
  url.searchParams.set('search_text', searchText);
  return url.toString();
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

function parseVintedPage(html) {
  const $ = cheerio.load(html);
  const listings = [];

  $('.feed-grid__item').each((_, element) => {
    const card = $(element);
    const link = card.find('a[href*="/items/"]').first();
    const image = card.find('img').first();
    const brand = card.find('[data-testid$="--description-title"]').first().text();
    const listedPriceText = card.find('[data-testid$="--price-text"]').first().text();
    const buyerPriceText = card.find('[data-testid="total-combined-price"]').first().text();
    const rawTitle = link.attr('title') || image.attr('alt') || '';

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
  const searchUrls = getVintedSearchUrls(search);

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
      if (!pageListings.length) {
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

        dedupedListings.set(listing.url, {
          ...listing,
          sourceQuery: new URL(baseUrl).searchParams.get('search_text') || ''
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

  return selectCandidateListings([...dedupedListings.values()], config);
}

module.exports = {
  getVintedListings
};
