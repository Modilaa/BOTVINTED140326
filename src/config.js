const path = require('path');

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseList(value, fallback) {
  if (!value) {
    return fallback;
  }

  const items = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length > 0 ? items : fallback;
}

function loadDotEnv() {
  const fs = require('fs');
  const envPath = path.join(process.cwd(), '.env');

  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const searches = [
  {
    name: 'Topps F1',
    maxPrice: 120,
    vintedQueries: [
      'topps chrome f1 card',
      'topps formula 1 card',
      'topps turbo attax f1',
      'topps f1 antonelli',
      'topps f1 bearman',
      'topps f1 refractor',
      'topps f1 autograph'
    ],
    requiredAllTokens: ['topps'],
    requiredAnyTokens: ['f1', 'formula', 'turbo', 'attax'],
    blockedTokens: ['panini', 'pokemon', 'yugioh']
  },
  {
    name: 'Topps Chrome Football',
    maxPrice: 120,
    vintedQueries: [
      'topps chrome ucc card',
      'topps merlin chrome card',
      'topps finest uefa card',
      'topps chrome yamal',
      'topps chrome bellingham',
      'topps chrome musiala',
      'topps merlin heritage'
    ],
    requiredAllTokens: ['topps'],
    requiredAnyTokens: ['chrome', 'finest', 'merlin', 'uefa', 'champions', 'premier'],
    blockedTokens: ['panini', 'futera', 'mundicromo', 'world cup', 'mondial']
  },
  {
    name: 'Pokemon',
    maxPrice: 150,
    vintedQueries: [
      'pokemon carte rare',
      'pokemon psa',
      'pokemon carte illustration rare',
      'pokemon carte japonaise',
      'pokemon carte gold',
      'pokemon SIR carte',
      'pokemon art rare carte',
      'pokemon prismatic evolutions',
      'pokemon 151 carte',
      'pokemon paldean fates'
    ],
    requiredAnyTokens: ['pokemon'],
    blockedTokens: ['yugioh', 'one piece', 'digimon', 'peluche', 'figurine', 'classeur', 'album', 'tapis', 'playmat']
  },
  {
    name: 'One Piece TCG',
    maxPrice: 100,
    vintedQueries: [
      'one piece card game',
      'one piece tcg carte',
      'one piece manga card rare',
      'one piece card game leader',
      'one piece manga rare',
      'one piece alt art carte',
      'one piece OP13 carte'
    ],
    requiredAnyTokens: ['one piece'],
    blockedTokens: ['pokemon', 'yugioh', 'figurine', 'poster', 'manga livre', 'tapis', 'playmat']
  },
  {
    name: 'Panini Football',
    maxPrice: 120,
    vintedQueries: [
      'panini prizm football card',
      'panini donruss football card',
      'panini select football card',
      'panini mosaic football card',
      'panini chronicles football',
      'panini prizm premier league',
      'panini select premier league',
      'panini prizm silver'
    ],
    requiredAllTokens: ['panini'],
    requiredAnyTokens: ['prizm', 'donruss', 'select', 'mosaic', 'football', 'chronicles', 'optic', 'premier'],
    blockedTokens: ['topps', 'pokemon', 'album', 'sticker', 'autocollant', 'vignette']
  },
  {
    name: 'Yu-Gi-Oh',
    maxPrice: 100,
    vintedQueries: [
      'yugioh carte rare',
      'yu-gi-oh card rare',
      'yugioh starlight rare',
      'yugioh quarter century secret rare',
      'yugioh ghost rare',
      'yugioh carte secret'
    ],
    requiredAnyTokens: ['yugioh', 'yu-gi-oh', 'yu gi oh'],
    blockedTokens: ['pokemon', 'one piece', 'digimon', 'classeur', 'album', 'tapis', 'playmat', 'deck box', 'sleeves']
  }
];

module.exports = {
  searches,
  minListingPriceEur: parseNumber(process.env.MIN_LISTING_PRICE_EUR, 2),
  underpricedThreshold: parseNumber(process.env.UNDERPRICED_THRESHOLD, 0.50),
  underpricedMinComps: parseNumber(process.env.UNDERPRICED_MIN_COMPS, 3),
  minProfitEur: parseNumber(process.env.MIN_PROFIT_EUR, 5),
  minProfitPercent: parseNumber(process.env.MIN_PROFIT_PERCENT, 20),
  maxItemsPerSearch: parseNumber(process.env.MAX_ITEMS_PER_SEARCH, 18),
  requestTimeoutMs: parseNumber(process.env.REQUEST_TIMEOUT_MS, 60000),
  vintedShippingEstimate: parseNumber(process.env.VINTED_SHIPPING_ESTIMATE, 3.5),
  ebayOutboundShippingEstimate: parseNumber(process.env.EBAY_OUTBOUND_SHIPPING_ESTIMATE, 4.5),
  vintedPagesPerSearch: parseNumber(process.env.VINTED_PAGES_PER_SEARCH, 5),
  vintedMaxListingsPerQuery: parseNumber(process.env.VINTED_MAX_LISTINGS_PER_QUERY, 36),
  vintedMaxListingsPerSearch: parseNumber(process.env.VINTED_MAX_LISTINGS_PER_SEARCH, 90),
  ebayPagesPerQuery: parseNumber(process.env.EBAY_PAGES_PER_QUERY, 2),
  httpMinDelayMs: parseNumber(process.env.HTTP_MIN_DELAY_MS, 900),
  httpMaxDelayMs: parseNumber(process.env.HTTP_MAX_DELAY_MS, 1600),
  cacheTtlSeconds: parseNumber(process.env.CACHE_TTL_SECONDS, 3600),
  minListingSpecificity: parseNumber(process.env.MIN_LISTING_SPECIFICITY, 3),
  maxEbayQueryVariants: parseNumber(process.env.MAX_EBAY_QUERY_VARIANTS, 3),
  ebayBaseUrls: parseList(process.env.EBAY_BASE_URLS, [
    'https://www.ebay.co.uk',
    'https://www.ebay.de',
    'https://www.ebay.fr',
    'https://www.ebay.it',
    'https://www.ebay.es'
  ]),
  ebayBaseUrl: process.env.EBAY_BASE_URL || 'https://www.ebay.co.uk',
  ebayFindingApiEnabled: parseBoolean(process.env.EBAY_FINDING_API_ENABLED, false),
  usdToEurRate: parseNumber(process.env.USD_TO_EUR_RATE, 0.865),
  gbpToEurRate: parseNumber(process.env.GBP_TO_EUR_RATE, 1.153),
  minImageSimilarity: parseNumber(process.env.MIN_IMAGE_SIMILARITY, 0.60),
  ebayAppId: process.env.EBAY_APP_ID || '',
  outputDir: path.resolve(process.cwd(), process.env.OUTPUT_DIR || 'output'),
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || ''
  }
};
