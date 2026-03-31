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

// ─── Searches TCG prioritaires (toujours actives) ────────────────────────────
// Pokemon, Yu-Gi-Oh, Topps F1, One Piece TCG = sources de prix fiables
// Topps Chrome Football et Panini Football désactivés (re-activer via SEARCH_TOPPS_FOOTBALL / SEARCH_PANINI)
const tcgSearches = [
  {
    name: 'Topps F1',
    pricingSource: 'ebay',
    maxPrice: 120,
    vintedQueries: [
      'topps chrome f1 card',
      'topps formula 1 card',
      'topps turbo attax f1',
      'topps f1 antonelli',
      'topps f1 bearman',
      'topps f1 refractor',
      'topps f1 autograph',
      'topps f1 verstappen',
      'topps f1 hamilton carte',
      'topps f1 norris card'
    ],
    requiredAllTokens: ['topps'],
    requiredAnyTokens: ['f1', 'formula', 'turbo', 'attax'],
    blockedTokens: ['panini', 'pokemon', 'yugioh']
  },
  {
    name: 'Pokemon',
    pricingSource: 'pokemon-tcg-api',
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
      'pokemon paldean fates',
      'pokemon carte ex',
      'pokemon full art',
      'pokemon trainer gallery',
      'pokemon surging sparks',
      'pokemon stellar crown',
      'pokemon twilight masquerade',
      'pokemon charizard carte',
      'pokemon temporal forces',
      'pokemon scarlet violet rare',
      'pokemon destinees de paldea'
    ],
    requiredAnyTokens: ['pokemon'],
    blockedTokens: ['yugioh', 'one piece', 'digimon', 'peluche', 'figurine', 'classeur', 'album', 'tapis', 'playmat', 'booster', 'display', 'coffret', 'tin'],
    facebookEnabled: true,
    facebookQueries: [
      'carte pokemon rare',
      'pokemon carte illustration rare',
      'pokemon psa',
      'pokemon carte ex'
    ],
    facebookLocation: 'paris'
  },
  {
    name: 'One Piece TCG',
    pricingSource: 'ebay',
    maxPrice: 100,
    vintedQueries: [
      'one piece card game',
      'one piece tcg carte',
      'one piece card rare',
      'one piece card game leader',
      'one piece alt art carte',
      'one piece OP13 carte',
      'one piece tcg rare',
      'one piece carte secret rare',
      'one piece card game luffy',
      'one piece OP anglais rare'
    ],
    requiredAnyTokens: ['one piece'],
    blockedTokens: ['pokemon', 'yugioh', 'figurine', 'poster', 'manga livre', 'tapis', 'playmat', 'tome', 'livre', 'roman', 'volume', 'coffret'],
    facebookEnabled: true,
    facebookQueries: ['one piece card game rare', 'one piece tcg carte'],
    facebookLocation: 'paris'
  },
  {
    name: 'Yu-Gi-Oh',
    pricingSource: 'ygoprodeck',
    maxPrice: 100,
    vintedQueries: [
      'yugioh carte rare',
      'yu-gi-oh card rare',
      'yugioh starlight rare',
      'yugioh quarter century secret rare',
      'yugioh ghost rare',
      'yugioh carte secret',
      'yugioh ultimate rare',
      'yugioh collector rare',
      'yugioh prismatic',
      'yugioh carte francaise rare',
      'yugioh secret rare francais',
      'yugioh accesscode talker',
      'yugioh carte graded'
    ],
    requiredAnyTokens: ['yugioh', 'yu-gi-oh', 'yu gi oh'],
    blockedTokens: ['pokemon', 'one piece', 'digimon', 'classeur', 'album', 'tapis', 'playmat', 'deck box', 'sleeves'],
    facebookEnabled: true,
    facebookQueries: ['yugioh carte rare', 'yu-gi-oh carte secret rare'],
    facebookLocation: 'paris'
  }
];

// ─── Catégories TCG désactivées (re-activer via SEARCH_TOPPS_FOOTBALL / SEARCH_PANINI) ─
const toppsFootballSearches = parseBoolean(process.env.SEARCH_TOPPS_FOOTBALL, false) ? [
  {
    name: 'Topps Chrome Football',
    pricingSource: 'ebay',
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
  }
] : [];

const paniniSearches = parseBoolean(process.env.SEARCH_PANINI, false) ? [
  {
    name: 'Panini Football',
    pricingSource: 'ebay',
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
  }
] : [];

const toppsUfcSearches = parseBoolean(process.env.SEARCH_TOPPS_UFC, false) ? [
  {
    name: 'Topps UFC',
    pricingSource: 'ebay',
    maxPrice: 120,
    vintedQueries: [
      'topps ufc',
      'topps chrome ufc',
      'topps finest ufc',
      'ufc prizm',
      'ufc card',
      'topps ufc numbered',
      'topps ufc auto',
      'topps ufc gold',
      'topps ufc refractor',
      'ufc panini'
    ],
    requiredAllTokens: ['topps'],
    requiredAnyTokens: ['ufc', 'mma'],
    blockedTokens: ['pokemon', 'yugioh', 'football', 'f1', 'tennis', 'album', 'sticker']
  }
] : [];

const toppsTennisSearches = parseBoolean(process.env.SEARCH_TOPPS_TENNIS, false) ? [
  {
    name: 'Topps Tennis',
    pricingSource: 'ebay',
    maxPrice: 120,
    vintedQueries: [
      'topps tennis',
      'topps chrome tennis',
      'topps tennis gold',
      'topps tennis refractor',
      'topps tennis auto',
      'topps tennis numbered',
      'tennis card topps',
      'topps finest tennis'
    ],
    requiredAllTokens: ['topps'],
    requiredAnyTokens: ['tennis'],
    blockedTokens: ['pokemon', 'yugioh', 'football', 'f1', 'ufc', 'album', 'sticker']
  }
] : [];

const toppsSportGeneralSearches = parseBoolean(process.env.SEARCH_TOPPS_SPORT_GENERAL, false) ? [
  {
    name: 'Topps Sport General',
    pricingSource: 'ebay',
    maxPrice: 120,
    vintedQueries: [
      'topps sapphire',
      'topps gold refractor',
      'bowman chrome',
      'topps chrome hobby',
      'topps finest',
      'topps sterling',
      'topps tribute',
      'topps tier one',
      'topps museum',
      'topps inception'
    ],
    requiredAllTokens: ['topps'],
    requiredAnyTokens: ['sapphire', 'sterling', 'tribute', 'tier one', 'museum', 'inception', 'chrome', 'finest'],
    blockedTokens: ['pokemon', 'yugioh', 'album', 'sticker', 'autocollant', 'vignette']
  }
] : [];

// ─── Catégories multi-produits (Discovery v2) ────────────────────────────
// Chaque catégorie est activable/désactivable via le .env

const sneakersSearches = []; // Sneakers désactivées — trop de contrefaçons sur Vinted

const funkoPopSearches = parseBoolean(process.env.SEARCH_FUNKO_POP, true) ? [
  {
    name: 'Funko Pop',
    pricingSource: 'ebay',
    isNonTcg: true,
    ebayCategory: null,
    minProfitEur: 8,
    minProfitPercent: 30,
    maxPrice: 100,
    vintedQueries: [
      // 8 queries ciblées (au lieu de 19) — réduit la mémoire et les appels API
      // Les "figurine pop X" sont des doublons des "funko pop X" sur Vinted
      'funko pop marvel',
      'funko pop dragon ball',
      'funko pop naruto',
      'funko pop one piece',
      'funko pop star wars',
      'funko pop anime',
      'funko pop exclusif',
      'funko pop chase'
    ],
    requiredAnyTokens: ['funko', 'funko pop', 'figurine pop', 'pop vinyl'],
    blockedTokens: ['poster', 'tshirt', 'maillot', 'autocollant', 'sticker', 'porte-cles', 'keychain', 'tapis', 'mug', 'coussin', 'lot vide', 'boite vide', 'empty box', 'sans boite', 'loose', 'abime', 'casse'],
    maxPricePerQuery: {
      'funko pop marvel': 80,
      'funko pop disney': 80,
      'funko pop dragon ball': 100,
      'funko pop naruto': 80,
      'funko pop one piece': 100,
      'funko pop star wars': 80,
      'funko pop harry potter': 60,
      'funko pop dc comics': 60,
      'funko pop pokemon': 100,
      'funko pop anime': 80,
      'funko pop exclusif': 100,
      'funko pop chase': 100,
      'funko pop flocked': 80,
      'funko pop glow in the dark': 80
    }
  }
] : [];

// LEGO supprimé (catégorie retirée par Justin — pas d'achat LEGO)

// DÉSACTIVÉ — titres trop vagues, profits irréalistes (P3 fix 31 mars 2026)
const vintageSearches = parseBoolean(process.env.SEARCH_VINTAGE, false) ? [
  {
    name: 'Vetements Vintage',
    pricingSource: 'ebay',
    isNonTcg: true,
    ebayCategory: null,
    minProfitEur: 10,
    minProfitPercent: 20,
    maxPrice: 100,
    vintedQueries: [
      'ralph lauren vintage',
      'the north face nuptse',
      'the north face vintage',
      'carhartt wip veste',
      'carhartt detroit jacket',
      'burberry trench vintage',
      'stone island vintage',
      'arcteryx veste'
    ],
    requiredAnyTokens: ['ralph lauren', 'north face', 'nuptse', 'burberry', 'carhartt', 'stone island', 'arcteryx', 'patagonia'],
    blockedTokens: ['contrefacon', 'replica', 'inspired', 'style', 'casquette seule', 'chaussette'],
    maxPricePerQuery: {
      'ralph lauren vintage': 40,
      'the north face nuptse': 100,
      'the north face vintage': 80,
      'carhartt wip veste': 80,
      'carhartt detroit jacket': 80,
      'burberry trench vintage': 100,
      'stone island vintage': 100,
      'arcteryx veste': 100
    }
  }
] : [];

// DÉSACTIVÉ — titres trop vagues, profits irréalistes (P3 fix 31 mars 2026)
const techSearches = parseBoolean(process.env.SEARCH_TECH, false) ? [
  {
    name: 'Tech',
    pricingSource: 'ebay',
    isNonTcg: true,
    ebayCategory: null,
    minProfitEur: 20,
    minProfitPercent: 20,
    maxPrice: 200,
    vintedQueries: [
      'airpods pro',
      'airpods 3eme generation',
      'iphone 13',
      'iphone 12',
      'ipad air',
      'dyson airwrap',
      'sony wh1000xm5',
      'nintendo switch oled'
    ],
    requiredAnyTokens: ['airpods', 'iphone', 'ipad', 'dyson', 'sony wh', 'switch oled', 'samsung galaxy', 'gopro'],
    blockedTokens: ['coque seule', 'etui seul', 'protection seule', 'film seul', 'cable seul', 'chargeur seul', 'pieces detachees', 'pour pieces', 'hs', 'casse', 'bloque', 'icloud'],
    maxPricePerQuery: {
      'airpods pro': 120,
      'airpods 3eme generation': 80,
      'iphone 13': 200,
      'iphone 12': 150,
      'ipad air': 200,
      'dyson airwrap': 200,
      'sony wh1000xm5': 150,
      'nintendo switch oled': 200
    }
  }
] : [];

// DÉSACTIVÉ — titres trop vagues, profits irréalistes (P3 fix 31 mars 2026)
const retroSearches = parseBoolean(process.env.SEARCH_RETRO, false) ? [
  {
    name: 'Consoles Retro',
    pricingSource: 'ebay',
    isNonTcg: true,
    ebayCategory: null,
    minProfitEur: 10,
    minProfitPercent: 20,
    maxPrice: 120,
    vintedQueries: [
      'game boy color',
      'game boy advance',
      'gameboy advance sp',
      'nintendo 64 console',
      'super nintendo console',
      'sega mega drive console',
      'ps1 playstation console',
      'psp sony'
    ],
    requiredAnyTokens: ['game boy', 'gameboy', 'nintendo 64', 'n64', 'super nintendo', 'snes', 'sega', 'mega drive', 'ps1', 'playstation 1', 'psp', 'gba'],
    blockedTokens: ['jeu seul', 'boitier seul', 'coque seule', 'pieces detachees', 'pour pieces', 'hs', 'casse', 'ne fonctionne pas', 'en panne'],
    maxPricePerQuery: {
      'game boy color': 80,
      'game boy advance': 60,
      'gameboy advance sp': 80,
      'nintendo 64 console': 100,
      'super nintendo console': 80,
      'sega mega drive console': 80,
      'ps1 playstation console': 60,
      'psp sony': 80
    }
  }
] : [];

const vinylesSearches = parseBoolean(process.env.SEARCH_VINYLES, false) ? [
  {
    name: 'Vinyles',
    pricingSource: 'discogs',
    isNonTcg: true,
    ebayCategory: null,
    minProfitEur: 5,
    minProfitPercent: 25,
    maxPrice: 60,
    vintedQueries: [
      'vinyle edition limitee',
      'vinyle rap francais',
      'vinyle rock classique',
      'vinyl collector',
      'vinyle jazz rare',
      'disque vinyle france gall',
      'disque vinyle serge gainsbourg'
    ],
    requiredAnyTokens: ['vinyle', 'vinyl', 'disque', '33 tours', 'lp', 'ep'],
    blockedTokens: ['platine', 'tourne disque', 'lecteur', 'enceinte', 'ampli', 'cadre', 'decoration', 'poster', 'livre'],
    maxPricePerQuery: {
      'vinyle edition limitee': 60,
      'vinyle rap francais': 30,
      'vinyle rock classique': 25,
      'vinyl collector': 60,
      'vinyle jazz rare': 40,
      'disque vinyle france gall': 40,
      'disque vinyle serge gainsbourg': 40
    }
  }
] : [];

// ─── Fusion de toutes les recherches ─────────────────────────────────────
const searches = [
  ...tcgSearches,
  ...toppsFootballSearches,
  ...paniniSearches,
  ...toppsUfcSearches,
  ...toppsTennisSearches,
  ...toppsSportGeneralSearches,
  ...sneakersSearches,
  ...funkoPopSearches,
  // legoSearches supprimé
  ...vintageSearches,
  ...techSearches,
  ...retroSearches,
  ...vinylesSearches
];

// ─── Multi-plateforme sourcing ──────────────────────────────────────────────
const sourcingPlatforms = parseList(process.env.SOURCING_PLATFORMS, ['vinted']);
const cardmarketEnabled = parseBoolean(process.env.CARDMARKET_ENABLED, false);
const leboncoinEnabled = parseBoolean(process.env.LEBONCOIN_ENABLED, false);

module.exports = {
  searches,
  sourcingPlatforms,
  cardmarketEnabled,
  leboncoinEnabled,
  minListingPriceEur: parseNumber(process.env.MIN_LISTING_PRICE_EUR, 2),
  underpricedThreshold: parseNumber(process.env.UNDERPRICED_THRESHOLD, 0.50),
  underpricedMinComps: parseNumber(process.env.UNDERPRICED_MIN_COMPS, 3),
  minProfitEur: parseNumber(process.env.MIN_PROFIT_EUR, 5),
  minProfitPercent: parseNumber(process.env.MIN_PROFIT_PERCENT, 20),
  maxItemsPerSearch: parseNumber(process.env.MAX_ITEMS_PER_SEARCH, 50),
  requestTimeoutMs: parseNumber(process.env.REQUEST_TIMEOUT_MS, 60000),
  vintedCountries: parseList(process.env.VINTED_COUNTRIES, ['be', 'fr', 'de', 'nl']),
  vintedShippingEstimate: parseNumber(process.env.VINTED_SHIPPING_ESTIMATE, 3.5),
  ebayOutboundShippingEstimate: parseNumber(process.env.EBAY_OUTBOUND_SHIPPING_ESTIMATE, 4.5),
  vintedPagesPerSearch: parseNumber(process.env.VINTED_PAGES_PER_SEARCH, 8),
  vintedMaxListingsPerQuery: parseNumber(process.env.VINTED_MAX_LISTINGS_PER_QUERY, 60),
  vintedMaxListingsPerSearch: parseNumber(process.env.VINTED_MAX_LISTINGS_PER_SEARCH, 300),
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
  minImageSimilarity: parseNumber(process.env.MIN_IMAGE_SIMILARITY, 0.40),
  ebayAppId: process.env.EBAY_APP_ID || '',
  ebayClientSecret: process.env.EBAY_CLIENT_SECRET || '',
  pricingStrategy: process.env.PRICING_STRATEGY || 'api',
  pokemonTcgApiKey: process.env.POKEMON_TCG_API_KEY || '',
  outputDir: path.resolve(process.cwd(), process.env.OUTPUT_DIR || 'output'),
  cardmarketShippingEstimate: parseNumber(process.env.CARDMARKET_SHIPPING_ESTIMATE, 1.5),
  leboncoinShippingEstimate: parseNumber(process.env.LEBONCOIN_SHIPPING_ESTIMATE, 4.0),
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || ''
  },
  // ─── Budget Vision GPT ────────────────────────────────────────────────────
  // VISION_DAILY_BUDGET_CENTS=200  → 2$/jour max (ajustable dans .env)
  // VISION_MIN_PROFIT_FOR_CHECK=0  → vérifier TOUTES les candidates (Vision = gardien final)
  visionDailyBudgetCents:    parseNumber(process.env.VISION_DAILY_BUDGET_CENTS,    200),
  visionMinProfitForCheck:   parseNumber(process.env.VISION_MIN_PROFIT_FOR_CHECK,    0),
  visionCostPerCallCents:    parseNumber(process.env.VISION_COST_PER_CALL_CENTS,     3)
};
