/**
 * DEPRECATED: use src/marketplaces/pokemon-unified.js
 * Ce fichier est conservé comme dépendance interne de pokemon-unified.js.
 *
 * PokemonTCG.io API — Prix TCGPlayer directs pour les cartes Pokémon.
 *
 * Endpoint: https://api.pokemontcg.io/v2/cards?q=name:...
 * Gratuit, pas de clé pour usage basique (mais clé optionnelle pour + de requêtes).
 * Retourne les prix TCGPlayer (market, low, mid, high) directement.
 *
 * Ceci remplace la dépendance à eBay pour le pricing Pokémon.
 * Le format de sortie est compatible avec matchedSales (url, price, title, soldAt).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const { extractCardSignature } = require('../matching');
const { toSlugTokens } = require('../utils');
const { compareListingImages } = require('../image-match');

// Force IPv4-first: pokemontcg.io IPv6 retourne 404 via Cloudflare
dns.setDefaultResultOrder('ipv4first');

// ─── Cache ──────────────────────────────────────────────────────────────────

const memoryCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_MEMORY_CACHE_SIZE = 200;

function clearMemoryCache() { memoryCache.clear(); }

function getCacheDir() {
  const dir = path.join(process.cwd(), 'output', 'http-cache', 'pokemontcg-api');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function cachedFetch(url, apiKey) {
  const cached = memoryCache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const hash = crypto.createHash('sha1').update(url).digest('hex');
  const cachePath = path.join(getCacheDir(), `${hash}.json`);
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const payload = JSON.parse(raw);
    if (Date.now() - payload.ts < CACHE_TTL_MS) {
      memoryCache.set(url, payload);
      return payload.data;
    }
  } catch { /* cache miss */ }

  const headers = { 'Accept': 'application/json' };
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20000)
  });

  if (response.status === 429) {
    console.log('    PokemonTCG.io rate limit, attente...');
    await new Promise(r => setTimeout(r, 2000));
    throw new Error('Rate limited');
  }

  if (!response.ok) {
    throw new Error(`PokemonTCG.io HTTP ${response.status}`);
  }

  const data = await response.json();
  const payload = { ts: Date.now(), data };
  if (memoryCache.size >= MAX_MEMORY_CACHE_SIZE) memoryCache.clear();
  memoryCache.set(url, payload);
  try { fs.writeFileSync(cachePath, JSON.stringify(payload)); } catch { /* non-fatal */ }
  return data;
}

// ─── Pokemon Name Extraction ────────────────────────────────────────────────

const SKIP_WORDS = new Set([
  'carte', 'card', 'cards', 'pokemon', 'pokmon', 'illustration', 'rare',
  'full', 'art', 'secret', 'promo', 'holo', 'reverse', 'gold', 'silver',
  'psa', 'bgs', 'sgc', 'cgc', 'mint', 'near', 'excellent', 'played',
  'japonais', 'japonaise', 'japanese', 'japan', 'jap', 'francais', 'francaise',
  'anglais', 'anglaise', 'english', 'korean', 'neuf', 'occasion', 'etat',
  'comme', 'tres', 'bon', 'prix', 'grade', 'graded', 'slab',
  'base', 'set', 'star', 'stars', 'trainer', 'gallery', 'common',
  'uncommon', 'rainbow', 'ultra', 'hyper', 'special', 'super', 'mega',
  'radiant', 'shiny', 'shining', 'amazing', 'alternate', 'collection',
  'nm', 'lp', 'mp', 'hp', 'dmg', 'tag', 'team', 'kor', 'fra', 'eng', 'jpn',
  'vstar', 'vmax', 'ex', 'gx', 'v', 'break'
]);

// Common FR → EN Pokemon name mappings
const POKEMON_FR_TO_EN = {
  'dracaufeu': 'charizard', 'tortank': 'blastoise', 'florizarre': 'venusaur',
  'pikachu': 'pikachu', 'mewtwo': 'mewtwo', 'mew': 'mew',
  'leviator': 'gyarados', 'dracolosse': 'dragonite', 'mentali': 'espeon',
  'noctali': 'umbreon', 'evoli': 'eevee', 'sulfura': 'moltres',
  'artikodin': 'articuno', 'electhor': 'zapdos', 'lucario': 'lucario',
  'gardevoir': 'gardevoir', 'rayquaza': 'rayquaza', 'lugia': 'lugia',
  'ho-oh': 'ho-oh', 'celebi': 'celebi', 'arceus': 'arceus',
  'giratina': 'giratina', 'palkia': 'palkia', 'dialga': 'dialga',
  'reshiram': 'reshiram', 'zekrom': 'zekrom', 'kyurem': 'kyurem',
  'solgaleo': 'solgaleo', 'lunala': 'lunala', 'necrozma': 'necrozma',
  'zacian': 'zacian', 'zamazenta': 'zamazenta', 'eternatus': 'eternatus',
  'feunard': 'ninetales', 'alakazam': 'alakazam', 'ectoplasma': 'gengar',
  'tyranocif': 'tyranitar', 'carchacrok': 'garchomp', 'gallame': 'gallade',
  'roigada': 'slowking', 'demolosse': 'houndoom', 'elecsprint': 'manectric',
  'noadkoko': 'exeggutor', 'milobellus': 'milotic', 'absol': 'absol',
  'cizayox': 'scizor', 'steelix': 'steelix', 'togekiss': 'togekiss',
  'amphinobi': 'greninja', 'braségali': 'blaziken', 'brasegali': 'blaziken',
  'jungko': 'sceptile', 'laggron': 'swampert', 'tengalice': 'shiftry',
  'corboss': 'honchkrow', 'darkrai': 'darkrai', 'cresselia': 'cresselia',
  'magireve': 'mismagius', 'roserade': 'roserade', 'staross': 'starmie',
  'deoxys': 'deoxys', 'jirachi': 'jirachi', 'latias': 'latias',
  'latios': 'latios', 'groudon': 'groudon', 'kyogre': 'kyogre',
  'miaouss': 'meowth', 'ronflex': 'snorlax', 'lokhlass': 'lapras',
  'magicarpe': 'magikarp', 'ptera': 'aerodactyl', 'carapuce': 'squirtle',
  'salameche': 'charmander', 'bulbizarre': 'bulbasaur',
  'herbizarre': 'ivysaur', 'reptincel': 'charmeleon', 'carabaffe': 'wartortle'
};

function extractPokemonName(vintedTitle) {
  const lower = vintedTitle.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = toSlugTokens(vintedTitle);

  // Try FR → EN mapping first
  for (const [fr, en] of Object.entries(POKEMON_FR_TO_EN)) {
    if (lower.includes(fr)) {
      return en;
    }
  }

  // Fallback: first meaningful token
  for (const token of tokens) {
    if (SKIP_WORDS.has(token) || /^\d+$/.test(token) || token.length < 3) continue;
    if (/^[a-z\u00e0-\u00ff-]{3,}$/.test(token)) {
      return token;
    }
  }

  return null;
}

// ─── Card Number Extraction ─────────────────────────────────────────────────

function extractCardNumber(vintedTitle) {
  // Match patterns like 143/188, #143, 025/165
  const serialMatch = vintedTitle.match(/(\d{1,4})\/(\d{1,4})/);
  if (serialMatch) {
    const num = parseInt(serialMatch[1], 10);
    const total = parseInt(serialMatch[2], 10);
    if (num > 0 && total > 10 && num <= total * 2) {
      return serialMatch[1];
    }
  }

  const hashMatch = vintedTitle.match(/#(\d{1,4})\b/);
  if (hashMatch) return hashMatch[1];

  return null;
}

// ─── Set Detection ──────────────────────────────────────────────────────────

const SET_HINTS = {
  '151': 'sv3pt5', 'prismatic': 'sv8pt5', 'prismatic evolutions': 'sv8pt5',
  'paldean fates': 'sv4pt5', 'obsidian flames': 'sv3', 'paradox rift': 'sv4',
  'temporal forces': 'sv5', 'twilight masquerade': 'sv6', 'shrouded fable': 'sv6pt5',
  'stellar crown': 'sv7', 'surging sparks': 'sv8', 'scarlet violet': 'sv1',
  'paldea evolved': 'sv2', 'crown zenith': 'swsh12pt5',
  'celebrations': 'cel25', 'hidden fates': 'sm115'
};

function detectSet(vintedTitle) {
  const lower = vintedTitle.toLowerCase();
  for (const [hint, setId] of Object.entries(SET_HINTS)) {
    if (lower.includes(hint)) return setId;
  }
  return null;
}

// ─── PokemonTCG.io API ─────────────────────────────────────────────────────

/**
 * Search PokemonTCG.io for a card by name.
 * Returns an array of card objects with tcgplayer prices.
 */
async function searchPokemonTcgApi(pokemonName, cardNumber, setHint, apiKey) {
  const queryParts = [`name:"${pokemonName}"`];

  // Add set filter if we know the set
  if (setHint) {
    queryParts.push(`set.id:${setHint}`);
  }

  // Add number filter
  if (cardNumber) {
    queryParts.push(`number:${cardNumber}`);
  }

  const q = queryParts.join(' ');
  const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=5&orderBy=-set.releaseDate`;

  const data = await cachedFetch(url, apiKey);
  return data.data || [];
}

/**
 * Get the best TCGPlayer price from a PokemonTCG.io card object.
 * Returns price in EUR.
 */
function extractBestPrice(card, config) {
  const tcgprices = card.tcgplayer && card.tcgplayer.prices;
  if (!tcgprices) return null;

  // Priority: holofoil > reverseHolofoil > normal > 1stEditionHolofoil
  const priceTypes = [
    'holofoil', 'reverseHolofoil', 'normal',
    '1stEditionHolofoil', '1stEditionNormal',
    'unlimitedHolofoil', 'unlimited'
  ];

  for (const type of priceTypes) {
    const prices = tcgprices[type];
    if (prices) {
      // Prefer market price, then mid, then low
      const usdPrice = prices.market || prices.mid || prices.low;
      if (usdPrice && usdPrice > 0) {
        return {
          priceEur: usdPrice * (config.usdToEurRate || 0.865),
          priceUsd: usdPrice,
          priceType: type,
          low: prices.low,
          mid: prices.mid,
          high: prices.high,
          market: prices.market
        };
      }
    }
  }

  return null;
}

// ─── Main Pricing Function ──────────────────────────────────────────────────

/**
 * Get Pokemon market price using PokemonTCG.io API.
 * Returns in the same format as getYugiohMarketPrice / getPokemonMarketPrice.
 *
 * @param {object} vintedListing - { title, buyerPrice, imageUrl, url }
 * @param {object} config - Global config
 * @returns {object|null} - { matchedSales, pricingSource, bestMatch, marketPrice, confidence }
 */
async function getPokemonPriceViaTcgApi(vintedListing, config) {
  const pokemonName = extractPokemonName(vintedListing.title);
  if (!pokemonName) return null;

  const cardNumber = extractCardNumber(vintedListing.title);
  const setHint = detectSet(vintedListing.title);
  const apiKey = config.pokemonTcgApiKey || process.env.POKEMON_TCG_API_KEY || '';

  let cards;
  try {
    cards = await searchPokemonTcgApi(pokemonName, cardNumber, setHint, apiKey);
  } catch (err) {
    if (err.message.includes('Rate limited')) return null;
    console.log(`    PokemonTCG.io erreur: ${err.message}`);
    return null;
  }

  if (!cards || cards.length === 0) {
    // Retry without set/number filter
    if (setHint || cardNumber) {
      try {
        cards = await searchPokemonTcgApi(pokemonName, null, null, apiKey);
      } catch {
        return null;
      }
    }
    if (!cards || cards.length === 0) return null;
  }

  // Score and filter cards
  const candidates = cards
    .map(card => {
      const priceInfo = extractBestPrice(card, config);
      if (!priceInfo || priceInfo.priceEur <= 0) return null;

      // Score by name match quality
      let score = 0;
      const cardNameLower = (card.name || '').toLowerCase();
      if (cardNameLower === pokemonName.toLowerCase()) score += 10;
      else if (cardNameLower.includes(pokemonName.toLowerCase())) score += 6;
      else score += 2;

      // Bonus for matching card number
      if (cardNumber && card.number === cardNumber) score += 5;

      // Bonus for matching set
      if (setHint && card.set && card.set.id === setHint) score += 3;

      return { card, priceInfo, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return null;

  // Image comparison if available
  const minImageSimilarity = config.minImageSimilarity || 0.60;
  let best = null;

  for (const candidate of candidates.slice(0, 3)) {
    const apiImageUrl = candidate.card.images && (candidate.card.images.small || candidate.card.images.large);

    if (vintedListing.imageUrl && apiImageUrl) {
      try {
        const imageMatch = await compareListingImages(vintedListing.imageUrl, apiImageUrl, config);
        if (imageMatch && imageMatch.score !== null && imageMatch.score < minImageSimilarity) {
          console.log(`    PokemonTCG.io image rejetée (${(imageMatch.score * 100).toFixed(0)}%): ${candidate.card.name}`);
          continue;
        }
      } catch {
        // Non-fatal: continue without image validation
      }
    }

    best = candidate;
    break;
  }

  if (!best) {
    best = candidates[0]; // Fallback to best scored if image rejected all
  }

  const { card, priceInfo, score } = best;

  // Build source URLs for this card
  const tcgplayerUrl = card.tcgplayer && card.tcgplayer.url
    ? card.tcgplayer.url
    : `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(card.name)}`;
  // pokemontcg.io has no public card pages — sourceUrl set to null, TCGPlayer link is used instead
  const pokemontcgUrl = null;

  const matchedSale = {
    title: `${card.name} (${card.set ? card.set.name : 'Unknown Set'} #${card.number || '?'})`,
    price: priceInfo.priceEur,
    totalPrice: priceInfo.priceEur,
    shippingPrice: 0,
    soldAt: card.tcgplayer && card.tcgplayer.updatedAt ? card.tcgplayer.updatedAt : new Date().toISOString(),
    soldAtTs: Date.now(),
    url: tcgplayerUrl,
    itemKey: `ptcg-${card.id}`,
    imageUrl: (card.images && card.images.small) || '',
    marketplace: 'pokemontcg-api',
    queryUsed: `PokemonTCG.io: ${pokemonName}`,
    sourceUrl: pokemontcgUrl,
    tcgplayerUrl: tcgplayerUrl,
    match: {
      score,
      sharedTokens: [],
      sharedSpecificTokens: [card.name],
      sharedIdentityTokens: [card.name],
      specificCoverage: score >= 8 ? 1.0 : score >= 4 ? 0.7 : 0.4,
      missingCritical: false,
      identityFullCoverage: true
    },
    apiData: {
      source: 'pokemontcg-api',
      cardId: card.id,
      cardName: card.name,
      setName: card.set ? card.set.name : null,
      setId: card.set ? card.set.id : null,
      number: card.number,
      rarity: card.rarity,
      priceType: priceInfo.priceType,
      tcgplayerLow: priceInfo.low,
      tcgplayerMid: priceInfo.mid,
      tcgplayerHigh: priceInfo.high,
      tcgplayerMarket: priceInfo.market
    }
  };

  const confidence = score >= 10 ? 'high' : score >= 5 ? 'medium' : 'low';

  return {
    matchedSales: [matchedSale],
    pricingSource: 'pokemontcg-api',
    bestMatch: matchedSale.title,
    marketPrice: priceInfo.priceEur,
    confidence
  };
}

module.exports = {
  getPokemonPriceViaTcgApi,
  extractPokemonName,
  clearMemoryCache
};
