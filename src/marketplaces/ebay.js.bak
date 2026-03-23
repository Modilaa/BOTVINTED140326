const path = require('path');
const cheerio = require('cheerio');
const { extractCardSignature } = require('../matching');
const { fetchText } = require('../http');
const { normalizeSpaces, parseMoneyValue, toSlugTokens } = require('../utils');

function buildSoldUrl(baseUrl, query, pageNumber) {
  const url = new URL('/sch/i.html', baseUrl);
  url.searchParams.set('_nkw', query);
  url.searchParams.set('LH_Sold', '1');
  url.searchParams.set('LH_Complete', '1');
  url.searchParams.set('_sacat', '261328');
  url.searchParams.set('_ipg', '60');
  url.searchParams.set('_sop', '13');
  if (pageNumber > 1) {
    url.searchParams.set('_pgn', String(pageNumber));
  }

  return url.toString();
}

function extractEbayItemKey(url) {
  try {
    const parsedUrl = new URL(url);
    const itemMatch = parsedUrl.pathname.match(/\/itm\/(?:[^/]+\/)?(\d+)/i);
    if (itemMatch) {
      return itemMatch[1];
    }

    const itemParam = parsedUrl.searchParams.get('item');
    if (itemParam) {
      return itemParam;
    }
  } catch (error) {
    return url;
  }

  return url;
}

function isSandboxAppId(appId) {
  return /(?:^|-)SBX(?:-|$)/i.test(appId || '');
}

function buildFindingApiUrl(appId, query, pageNumber) {
  const baseUrl = isSandboxAppId(appId)
    ? 'https://svcs.sandbox.ebay.com/services/search/FindingService/v1'
    : 'https://svcs.ebay.com/services/search/FindingService/v1';

  const url = new URL(baseUrl);
  url.searchParams.set('OPERATION-NAME', 'findCompletedItems');
  url.searchParams.set('SERVICE-VERSION', '1.0.0');
  url.searchParams.set('SECURITY-APPNAME', appId);
  url.searchParams.set('RESPONSE-DATA-FORMAT', 'JSON');
  url.searchParams.set('REST-PAYLOAD', '');
  url.searchParams.set('keywords', query);
  url.searchParams.set('itemFilter(0).name', 'SoldItemsOnly');
  url.searchParams.set('itemFilter(0).value', 'true');
  url.searchParams.set('paginationInput.entriesPerPage', '20');
  url.searchParams.set('paginationInput.pageNumber', String(pageNumber));
  url.searchParams.set('sortOrder', 'EndTimeSoonest');
  return url.toString();
}

function cleanEbayTitle(title) {
  return normalizeSpaces(
    String(title || '')
      .replace(/^new listing\s*/i, '')
      .replace(/^nouvelle annonce\s*/i, '')
      .replace(/^neu eingestellt\s*/i, '')
      .replace(/^nuova inserzione\s*/i, '')
      .replace(/^nuevo anuncio\s*/i, '')
      .replace(/la page s'ouvre.*$/i, '')
      .replace(/la page souvre.*$/i, '')
      .replace(/opens in a new window.*$/i, '')
      .replace(/wird in neuem fenster.*$/i, '')
      .replace(/si apre in una nuova finestra.*$/i, '')
      .replace(/viene aperta una nuova finestra.*$/i, '')
      .replace(/se abre en una ventana.*$/i, '')
  );
}

function dedupeTokens(tokens) {
  return [...new Set(tokens.filter(Boolean).map((token) => String(token).trim()).filter(Boolean))];
}

function buildQueryVariants(title, maxVariants) {
  const signature = extractCardSignature(title);
  const rawTokens = toSlugTokens(title);
  const alphaSpecific = signature.specificTokens.filter((token) => /[a-z]/.test(token));
  const numericTokens = dedupeTokens([signature.cardNumber, signature.parallelToken, signature.year]);

  const candidateQueries = [
    dedupeTokens([...alphaSpecific.slice(0, 5), ...numericTokens]),
    dedupeTokens([...alphaSpecific.slice(0, 4), signature.cardNumber, signature.parallelToken]),
    dedupeTokens([...alphaSpecific.slice(0, 4), signature.year]),
    dedupeTokens(rawTokens.slice(0, 8))
  ];

  return candidateQueries
    .map((tokens) => tokens.filter(Boolean).join(' ').trim())
    .filter(Boolean)
    .filter((query, index, queries) => queries.indexOf(query) === index)
    .slice(0, maxVariants);
}

function parseFrenchDate(value) {
  const text = normalizeSpaces(value || '').toLowerCase();
  const match = text.match(/(\d{1,2})\s+([a-zéû.]+)\s+(\d{4})/);

  if (!match) {
    return null;
  }

  const months = {
    janv: 0,
    janvier: 0,
    fevr: 1,
    fevrier: 1,
    'févr': 1,
    'février': 1,
    mars: 2,
    avr: 3,
    avril: 3,
    mai: 4,
    juin: 5,
    juil: 6,
    juillet: 6,
    aout: 7,
    'août': 7,
    sept: 8,
    septembre: 8,
    oct: 9,
    octobre: 9,
    nov: 10,
    novembre: 10,
    dec: 11,
    decembre: 11,
    'déc': 11,
    'décembre': 11
  };

  const monthKey = match[2].replace('.', '');
  const month = months[monthKey];
  if (month === undefined) {
    return null;
  }

  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseLocalizedDate(value) {
  const text = normalizeSpaces(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,]/g, ' ')
    .toLowerCase();
  const match = text.match(/(\d{1,2})\s+([a-z]{3,10})\s+(\d{4})/);

  if (!match) {
    return null;
  }

  const months = {
    jan: 0,
    genn: 0,
    janv: 0,
    januar: 0,
    janvier: 0,
    gennaio: 0,
    enero: 0,
    ene: 0,
    feb: 1,
    febr: 1,
    fev: 1,
    fevr: 1,
    februar: 1,
    fevrier: 1,
    febbraio: 1,
    febrero: 1,
    mar: 2,
    mrz: 2,
    mars: 2,
    marz: 2,
    marzo: 2,
    abr: 3,
    abril: 3,
    avr: 3,
    april: 3,
    aprile: 3,
    avril: 3,
    mai: 4,
    may: 4,
    maggio: 4,
    mayo: 4,
    jun: 5,
    juin: 5,
    juni: 5,
    giugno: 5,
    junio: 5,
    jul: 6,
    lug: 6,
    juil: 6,
    juli: 6,
    juillet: 6,
    luglio: 6,
    julio: 6,
    aug: 7,
    ago: 7,
    aout: 7,
    agosto: 7,
    sep: 8,
    set: 8,
    sept: 8,
    septiembre: 8,
    settembre: 8,
    oktober: 9,
    oct: 9,
    octobre: 9,
    octubre: 9,
    ott: 9,
    ottobre: 9,
    nov: 10,
    novembre: 10,
    noviembre: 10,
    dez: 11,
    dec: 11,
    dic: 11,
    dicembre: 11,
    december: 11,
    decembre: 11,
    diciembre: 11
  };

  const month = months[match[2]];
  if (month === undefined) {
    return null;
  }

  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseSoldDate(value) {
  const normalized = normalizeSpaces(value || '');
  const localizedDate = parseLocalizedDate(normalized);
  if (localizedDate) {
    return localizedDate;
  }

  const frenchDate = parseFrenchDate(normalized);
  if (frenchDate) {
    return frenchDate;
  }

  const englishMatch = normalized.match(/(?:sold\s*)?([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})/i);
  if (!englishMatch) {
    return null;
  }

  const parsed = new Date(englishMatch[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isSoldCaption(text) {
  return /(sold|vendu|venduti|venduta|vendido|vendida|verkauft)/i.test(text || '');
}

function convertToEur(money, config) {
  if (!money) {
    return null;
  }

  if (money.currency === 'EUR') {
    return money.amount;
  }

  if (money.currency === 'USD') {
    return money.amount * config.usdToEurRate;
  }

  if (money.currency === 'GBP') {
    return money.amount * config.gbpToEurRate;
  }

  return null;
}

function sortSoldListingsByRecency(listings) {
  return [...listings].sort((left, right) => {
    const soldDiff = (right.soldAtTs || 0) - (left.soldAtTs || 0);
    if (soldDiff !== 0) {
      return soldDiff;
    }

    return (right.totalPrice || 0) - (left.totalPrice || 0);
  });
}

function isLikelySingleCardTitle(title) {
  const lowerTitle = String(title || '').toLowerCase();
  const blockedPatterns = [
    /^\(\d+\)\s/,
    /\blot\b/,
    /\bbundle\b/,
    /\bbox\b/,
    /\bbooster\b/,
    /\bpacks?\b/,
    /\bset\b/,
    /\bcards\b/,
    /\brefractors\b/,
    /\bparallels\b/,
    /\binserts\b/,
    /\bpick your\b/,
    /\bchoose your\b/,
    /\bselect your\b/,
    /\balle\b.*\bkarten\b/
  ];

  return !blockedPatterns.some((pattern) => pattern.test(lowerTitle));
}

function parseSoldPage(html, query, config) {
  const $ = cheerio.load(html);
  const listings = [];

  $('li.s-card, li.s-item, li[data-view]').each((_, element) => {
    const item = $(element);
    const soldText = item
      .find('.s-card__caption, .s-item__caption, .su-styled-text.positive, .POSITIVE')
      .map((__, node) => normalizeSpaces($(node).text()))
      .get()
      .find((text) => isSoldCaption(text)) || '';
    if (!isSoldCaption(soldText)) {
      return;
    }

    const titleNode = item.find('.s-card__title, .s-item__title').first();
    const priceNode = item.find('.s-card__price, .s-item__price').first();
    const linkNode = item.find('a[href*="/itm/"]').first();
    const imageNode = item.find('img').first();
    const shippingText = item
      .find('.s-card__attribute-row, .s-item__shipping, .s-item__logisticsCost')
      .map((__, row) => normalizeSpaces($(row).text()))
      .get()
      .find((text) => /(livraison|shipping|postage|versand|spedizione|envio)/i.test(text));
    const saleSignals = item
      .find('.s-card__attribute-row, .s-item__detail, .s-item__subtitle')
      .map((__, row) => normalizeSpaces($(row).text()))
      .get()
      .filter(Boolean);

    const itemTitle = cleanEbayTitle(titleNode.text());
    const itemPriceMoney = parseMoneyValue(priceNode.text());
    const shippingMoney = shippingText && /gratuite|free/i.test(shippingText)
      ? { amount: 0, currency: itemPriceMoney ? itemPriceMoney.currency : 'EUR' }
      : parseMoneyValue(shippingText);
    const itemPrice = convertToEur(itemPriceMoney, config);
    const shippingPrice = shippingMoney ? convertToEur(shippingMoney, config) : 0;
    const soldAt = parseSoldDate(soldText);
    const href = linkNode.attr('href') || '';
    const resolvedUrl = href.startsWith('http') ? href : new URL(href, config.ebayBaseUrl).toString();
    const imageUrl = imageNode.attr('data-defer-load') || imageNode.attr('src') || '';

    if (!itemTitle || !itemPrice || !href) {
      return;
    }

    const lowerTitle = itemTitle.toLowerCase();
    if (lowerTitle.includes('shop on ebay') || !isLikelySingleCardTitle(itemTitle)) {
      return;
    }

    listings.push({
      title: itemTitle,
      price: itemPrice,
      shippingPrice: shippingPrice || 0,
      totalPrice: itemPrice + (shippingPrice || 0),
      originalPrice: itemPriceMoney ? itemPriceMoney.amount : itemPrice,
      originalCurrency: itemPriceMoney ? itemPriceMoney.currency : 'EUR',
      soldAt,
      soldAtTs: soldAt ? Date.parse(soldAt) : 0,
      soldText,
      saleSignals,
      url: resolvedUrl,
      itemKey: extractEbayItemKey(resolvedUrl),
      imageUrl,
      marketplace: new URL(config.ebayBaseUrl).hostname,
      queryUsed: query
    });
  });

  return listings;
}

function parseFindingApiListings(rawBody, query, config) {
  const json = JSON.parse(rawBody);
  const response = json.findCompletedItemsResponse && json.findCompletedItemsResponse[0];

  if (!response) {
    return [];
  }

  if (json.errorMessage || response.ack?.[0] === 'Failure') {
    const apiError = json.errorMessage?.[0]?.error?.[0]?.message?.[0] || 'Unknown eBay API error';
    throw new Error(apiError);
  }

  const items = response.searchResult?.[0]?.item || [];
  return items
    .map((item) => {
      const title = cleanEbayTitle(item.title?.[0] || '');
      const sellingStatus = item.sellingStatus?.[0] || {};
      const shippingInfo = item.shippingInfo?.[0] || {};
      const currentPrice = sellingStatus.currentPrice?.[0];
      const shippingCost = shippingInfo.shippingServiceCost?.[0];

      const priceMoney = currentPrice
        ? {
            amount: Number(currentPrice.__value__),
            currency: currentPrice['@currencyId'] || 'USD'
          }
        : null;
      const shippingMoney = shippingCost
        ? {
            amount: Number(shippingCost.__value__),
            currency: shippingCost['@currencyId'] || (priceMoney ? priceMoney.currency : 'USD')
          }
        : { amount: 0, currency: priceMoney ? priceMoney.currency : 'USD' };

      const price = convertToEur(priceMoney, config);
      const shippingPrice = convertToEur(shippingMoney, config) || 0;
      const soldAt = item.listingInfo?.[0]?.endTime?.[0] || null;
      const url = item.viewItemURL?.[0] || '';

      if (!title || !price || !url) {
        return null;
      }

      const lowerTitle = title.toLowerCase();
      if (lowerTitle.includes('lot') || lowerTitle.includes('bundle') || lowerTitle.includes('booster box')) {
        return null;
      }

      return {
        title,
        price,
        shippingPrice,
        totalPrice: price + shippingPrice,
        originalPrice: priceMoney ? priceMoney.amount : price,
        originalCurrency: priceMoney ? priceMoney.currency : 'USD',
        soldAt,
        soldAtTs: soldAt ? Date.parse(soldAt) : 0,
        url,
        itemKey: extractEbayItemKey(url),
        marketplace: 'api',
        queryUsed: query
      };
    })
    .filter(Boolean);
}

async function getEbaySoldListingsViaApi(title, config) {
  const cacheDir = path.join(config.outputDir, 'http-cache', 'ebay-api');
  const queries = buildQueryVariants(title, config.maxEbayQueryVariants);
  const dedupedListings = new Map();

  for (const query of queries) {
    for (let pageNumber = 1; pageNumber <= config.ebayPagesPerQuery; pageNumber += 1) {
      const body = await fetchText(buildFindingApiUrl(config.ebayAppId, query, pageNumber), {
        timeoutMs: config.requestTimeoutMs,
        cacheDir,
        cacheTtlSeconds: config.cacheTtlSeconds,
        minDelayMs: config.httpMinDelayMs,
        maxDelayMs: config.httpMaxDelayMs
      });

      const pageListings = parseFindingApiListings(body, query, config);
      if (!pageListings.length) {
        break;
      }

      for (const listing of pageListings) {
        dedupedListings.set(listing.itemKey || listing.url, listing);
      }

      if (dedupedListings.size >= 18) {
        break;
      }
    }

    if (dedupedListings.size >= 6) {
      break;
    }
  }

  return sortSoldListingsByRecency([...dedupedListings.values()]);
}

async function getEbaySoldListings(title, config) {
  if (config.ebayFindingApiEnabled && config.ebayAppId && !isSandboxAppId(config.ebayAppId)) {
    try {
      const apiListings = await getEbaySoldListingsViaApi(title, config);
      if (apiListings.length > 0) {
        return apiListings;
      }
    } catch (error) {
      console.error(`eBay API fallback vers HTML pour "${title}": ${error.message}`);
    }
  }

  const cacheDir = path.join(config.outputDir, 'http-cache', 'ebay');
  const queries = buildQueryVariants(title, config.maxEbayQueryVariants);
  const dedupedListings = new Map();

  for (const baseUrl of config.ebayBaseUrls) {
    const siteConfig = {
      ...config,
      ebayBaseUrl: baseUrl
    };

    for (const query of queries) {
      for (let pageNumber = 1; pageNumber <= config.ebayPagesPerQuery; pageNumber += 1) {
        let html;
        try {
          html = await fetchText(buildSoldUrl(baseUrl, query, pageNumber), {
            timeoutMs: config.requestTimeoutMs,
            cacheDir,
            cacheTtlSeconds: config.cacheTtlSeconds,
            minDelayMs: config.httpMinDelayMs,
            maxDelayMs: config.httpMaxDelayMs
          });
        } catch (err) {
          // Blocked or timeout on this domain — skip to next domain
          break;
        }

        const pageListings = parseSoldPage(html, query, siteConfig);
        if (!pageListings.length) {
          break;
        }

        for (const listing of pageListings) {
          dedupedListings.set(listing.itemKey || listing.url, listing);
        }

        if (dedupedListings.size >= 120) {
          break;
        }
      }

      if (dedupedListings.size >= 80) {
        break;
      }
    }

    if (dedupedListings.size >= 80) {
      break;
    }
  }

  return sortSoldListingsByRecency([...dedupedListings.values()]);
}

module.exports = {
  getEbaySoldListings
};
