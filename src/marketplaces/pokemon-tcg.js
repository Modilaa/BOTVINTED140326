const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractCardSignature } = require('../matching');
const { normalizeSpaces, toSlugTokens } = require('../utils');

// Simple in-memory + disk cache for API results (avoid re-fetching)
const memoryCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function getCacheDir() {
  const dir = path.join(process.cwd(), 'output', 'http-cache', 'pokemon-api');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function cachedFetch(url) {
  // Check memory cache first
  const cached = memoryCache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  // Check disk cache
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  const cachePath = path.join(getCacheDir(), `${hash}.json`);
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const payload = JSON.parse(raw);
    if (Date.now() - payload.ts < CACHE_TTL_MS) {
      memoryCache.set(url, payload);
      return payload.data;
    }
  } catch {}

  // Fetch from API
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      ...(process.env.POKEMON_TCG_API_KEY ? { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY } : {})
    },
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('rate-limit');
    }
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();

  // Cache result
  const payload = { ts: Date.now(), data };
  memoryCache.set(url, payload);
  try { fs.writeFileSync(cachePath, JSON.stringify(payload)); } catch {}

  return data;
}

// Pokemon TCG API - https://pokemontcg.io
// Free, no key required (1000 req/day), with key 20k/day
// Returns both TCGPlayer (US) and Cardmarket (EU) prices

const API_BASE = 'https://api.pokemontcg.io/v2';

// French → English Pokemon name mapping (most common)
const FR_TO_EN = {
  dracaufeu: 'charizard', tortank: 'blastoise', florizarre: 'venusaur',
  evoli: 'eevee', pikachu: 'pikachu', mewtwo: 'mewtwo', mew: 'mew',
  leviator: 'gyarados', dracolosse: 'dragonite', mentali: 'espeon',
  noctali: 'umbreon', lucario: 'lucario', gardevoir: 'gardevoir',
  ectoplasma: 'gengar', sulfura: 'moltres', artikodin: 'articuno',
  electhor: 'zapdos', lugia: 'lugia', celebi: 'celebi', rayquaza: 'rayquaza',
  arceus: 'arceus', giratina: 'giratina', dialga: 'dialga', palkia: 'palkia',
  reshiram: 'reshiram', zekrom: 'zekrom', kyurem: 'kyurem',
  greninja: 'greninja', amphinobi: 'greninja', feunard: 'ninetales',
  goupix: 'vulpix', demolosse: 'houndoom', tyranocif: 'tyranitar',
  alakazam: 'alakazam', machopeur: 'machamp', ronflex: 'snorlax',
  lokhlass: 'lapras', carapuce: 'squirtle', salameche: 'charmander',
  bulbizarre: 'bulbasaur', raichu: 'raichu', nidoking: 'nidoking',
  arcanin: 'arcanine', ptera: 'aerodactyl', kabuto: 'kabuto',
  kabutops: 'kabutops', amonistar: 'omastar', amonita: 'omanyte',
  scarabrute: 'pinsir', tauros: 'tauros', leveinard: 'chansey',
  kangourex: 'kangaskhan', elektek: 'electabuzz', magmar: 'magmar',
  simiabraz: 'infernape', carchacrok: 'garchomp', togekiss: 'togekiss',
  cizayox: 'scizor', steelix: 'steelix', heracross: 'heracross',
  latias: 'latias', latios: 'latios', deoxys: 'deoxys', jirachi: 'jirachi',
  darkrai: 'darkrai', cresselia: 'cresselia', heatran: 'heatran',
  regigigas: 'regigigas', zoroark: 'zoroark', genesect: 'genesect',
  xerneas: 'xerneas', yveltal: 'yveltal', zygarde: 'zygarde',
  solgaleo: 'solgaleo', lunala: 'lunala', necrozma: 'necrozma',
  zacian: 'zacian', zamazenta: 'zamazenta', eternatus: 'eternatus',
  miraidon: 'miraidon', koraidon: 'koraidon', feunegre: 'houndstone',
  roigada: 'slowking', flagadoss: 'slowbro', zarude: 'zarude',
  pachirisu: 'pachirisu', dedenne: 'dedenne', morpeko: 'morpeko',
  toxtricity: 'toxtricity', urshifu: 'urshifu', calyrex: 'calyrex',
  dondozo: 'dondozo', palafin: 'palafin', annihilape: 'annihilape',
  kingambit: 'kingambit', gholdengo: 'gholdengo', terapagos: 'terapagos',
  pecharunt: 'pecharunt'
};

// Common set name mappings
const SET_ALIASES = {
  '151': 'sv3pt5', 'prismatic': 'sv8pt5', 'prismatic evolutions': 'sv8pt5',
  'paldean fates': 'sv4pt5', 'obsidian flames': 'sv3', 'paradox rift': 'sv4',
  'temporal forces': 'sv5', 'twilight masquerade': 'sv6', 'shrouded fable': 'sv6pt5',
  'stellar crown': 'sv7', 'surging sparks': 'sv8', 'scarlet violet': 'sv1',
  'paldea evolved': 'sv2', 'crown zenith': 'swsh12pt5',
  'silver tempest': 'swsh12', 'lost origin': 'swsh11',
  'astral radiance': 'swsh10', 'brilliant stars': 'swsh9'
};

function extractPokemonSearchTerms(vintedTitle) {
  const sig = extractCardSignature(vintedTitle);
  const lower = vintedTitle.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Try to extract Pokemon name (translate French if needed)
  const tokens = toSlugTokens(vintedTitle);
  let pokemonName = null;

  for (const token of tokens) {
    if (FR_TO_EN[token]) {
      pokemonName = FR_TO_EN[token];
      break;
    }
  }

  // If no French match, try using identity tokens as English name
  if (!pokemonName && sig.identityTokens.length > 0) {
    // Filter out non-pokemon words
    const skip = new Set(['carte', 'card', 'pokemon', 'illustration', 'rare', 'full', 'art', 'secret', 'promo', 'holo', 'reverse', 'gold', 'silver']);
    const candidates = sig.identityTokens.filter(t => !skip.has(t) && t.length >= 3);
    if (candidates.length > 0) {
      pokemonName = candidates[0];
    }
  }

  // Extract set info
  let setId = null;
  for (const [alias, id] of Object.entries(SET_ALIASES)) {
    if (lower.includes(alias)) {
      setId = id;
      break;
    }
  }

  // Extract card number (strip leading zeros: "006" → "6")
  const rawCardNumber = sig.cardNumber;
  const cardNumber = rawCardNumber ? rawCardNumber.replace(/^0+/, '') || rawCardNumber : null;

  return { pokemonName, setId, cardNumber, signature: sig };
}

function buildSearchQuery(terms) {
  const parts = [];

  if (terms.pokemonName) {
    parts.push(`name:"${terms.pokemonName}*"`);
  }

  if (terms.setId) {
    parts.push(`set.id:${terms.setId}`);
  }

  if (terms.cardNumber) {
    parts.push(`number:${terms.cardNumber}`);
  }

  return parts.join(' ');
}

function extractBestPrice(card) {
  // Prefer Cardmarket prices (European reference)
  const cm = card.cardmarket?.prices;
  const tcg = card.tcgplayer?.prices;

  let cardmarketPrice = null;
  let tcgplayerPrice = null;
  let source = null;

  if (cm) {
    // Use trendPrice as the most reliable market indicator
    cardmarketPrice = cm.trendPrice || cm.averageSellPrice || cm.avg7 || cm.avg30 || cm.lowPrice;
    if (cardmarketPrice > 0) {
      source = 'cardmarket';
    }
  }

  if (tcg) {
    // TCGPlayer has prices per variant (normal, holofoil, reverseHolofoil, etc.)
    const variants = Object.values(tcg);
    for (const variant of variants) {
      if (variant && variant.market && variant.market > 0) {
        tcgplayerPrice = variant.market;
        break;
      }
      if (variant && variant.mid && variant.mid > 0) {
        tcgplayerPrice = variant.mid;
        break;
      }
    }
  }

  // Cardmarket is EUR, TCGPlayer is USD
  return {
    cardmarketPrice,
    tcgplayerPrice,
    bestPrice: cardmarketPrice || (tcgplayerPrice ? tcgplayerPrice * 0.865 : null),
    source: cardmarketPrice ? 'cardmarket' : (tcgplayerPrice ? 'tcgplayer' : null),
    allPrices: { cardmarket: cm || null, tcgplayer: tcg || null }
  };
}

function scoreCardMatch(card, terms) {
  let score = 0;

  if (terms.cardNumber && card.number === terms.cardNumber) {
    score += 10;
  }

  if (terms.setId && card.set?.id === terms.setId) {
    score += 5;
  }

  if (terms.pokemonName) {
    const cardNameLower = (card.name || '').toLowerCase();
    const searchName = terms.pokemonName.toLowerCase();
    if (cardNameLower === searchName) {
      score += 8;
    } else if (cardNameLower.includes(searchName) || searchName.includes(cardNameLower)) {
      score += 4;
    }
  }

  // Prefer cards with prices
  const pricing = extractBestPrice(card);
  if (pricing.bestPrice && pricing.bestPrice > 0) {
    score += 3;
  }

  return score;
}

async function getPokemonMarketPrice(vintedListing, config) {
  const terms = extractPokemonSearchTerms(vintedListing.title);

  if (!terms.pokemonName && !terms.cardNumber) {
    return null;
  }

  const query = buildSearchQuery(terms);
  if (!query) {
    return null;
  }

  // Build multiple query strategies from most specific to broadest
  const queries = [];

  // Strategy 1: set + number (most precise)
  if (terms.setId && terms.cardNumber) {
    queries.push(`set.id:${terms.setId} number:${terms.cardNumber}`);
  }

  // Strategy 2: name + set
  if (terms.pokemonName && terms.setId) {
    queries.push(`name:"${terms.pokemonName}*" set.id:${terms.setId}`);
  }

  // Strategy 3: name + number
  if (terms.pokemonName && terms.cardNumber) {
    queries.push(`name:"${terms.pokemonName}*" number:${terms.cardNumber}`);
  }

  // Strategy 4: just name
  if (terms.pokemonName) {
    queries.push(`name:"${terms.pokemonName}*"`);
  }

  try {
    let cards = [];

    for (const q of queries) {
      if (cards.length > 0) break;

      const apiUrl = `${API_BASE}/cards?q=${encodeURIComponent(q)}&pageSize=10&orderBy=-set.releaseDate`;
      try {
        const data = await cachedFetch(apiUrl);
        cards = data.data || [];
      } catch (err) {
        if (err.message === 'rate-limit') {
          console.log('    Pokemon TCG API rate limit, skipping...');
          return null;
        }
        // Try next query strategy
        continue;
      }
    }

    if (cards.length === 0) {
      return null;
    }

    // Score and rank matches
    const scored = cards
      .map(card => ({ card, score: scoreCardMatch(card, terms), pricing: extractBestPrice(card) }))
      .filter(r => r.pricing.bestPrice && r.pricing.bestPrice > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return null;
    }

    const best = scored[0];
    const marketPrice = best.pricing.bestPrice;

    // Build synthetic "sold listings" compatible with buildProfitAnalysis
    const matchedSales = scored.slice(0, 3).map(r => ({
      title: `${r.card.name} - ${r.card.set?.name || ''} #${r.card.number || '?'}`,
      price: r.pricing.bestPrice,
      totalPrice: r.pricing.bestPrice,
      shippingPrice: 0,
      soldAt: new Date().toISOString(),
      soldAtTs: Date.now(),
      url: r.card.cardmarket?.url || `https://www.cardmarket.com/en/Pokemon/Products/Singles?searchString=${encodeURIComponent(r.card.name)}`,
      itemKey: `ptcg-${r.card.id}`,
      imageUrl: r.card.images?.small || r.card.images?.large || '',
      marketplace: r.pricing.source || 'cardmarket',
      queryUsed: `Pokemon TCG API: ${r.card.name}`,
      match: {
        score: r.score,
        sharedTokens: [],
        sharedSpecificTokens: [r.card.name],
        sharedIdentityTokens: [r.card.name],
        specificCoverage: r.score >= 10 ? 1.0 : r.score >= 5 ? 0.7 : 0.4,
        missingCritical: false,
        identityFullCoverage: true
      },
      imageMatch: {
        score: r.score >= 10 ? 0.95 : 0.75,
        confidence: r.score >= 10 ? 'high' : 'medium'
      },
      apiData: {
        source: 'pokemon-tcg-api',
        cardId: r.card.id,
        cardName: r.card.name,
        setName: r.card.set?.name,
        number: r.card.number,
        rarity: r.card.rarity,
        cardmarketPrices: r.pricing.allPrices.cardmarket,
        tcgplayerPrices: r.pricing.allPrices.tcgplayer
      }
    }));

    return {
      matchedSales,
      pricingSource: 'pokemon-tcg-api',
      bestMatch: best.card.name,
      marketPrice,
      confidence: best.score >= 10 ? 'high' : best.score >= 5 ? 'medium' : 'low'
    };
  } catch (error) {
    console.error(`    Pokemon TCG API error: ${error.message}`);
    return null;
  }
}

module.exports = {
  getPokemonMarketPrice,
  extractPokemonSearchTerms
};
