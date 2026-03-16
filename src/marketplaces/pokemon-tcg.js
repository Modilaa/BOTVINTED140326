const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const { extractCardSignature, chooseBestSoldListings } = require('../matching');
const { normalizeSpaces, toSlugTokens } = require('../utils');
const { getEbaySoldListings } = require('./ebay');
const { attachImageSignals } = require('../image-match');

// Force IPv4-first DNS resolution
dns.setDefaultResultOrder('ipv4first');

// Memory cache (disk cache is the real persistence layer)
const memoryCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_MEMORY_CACHE_SIZE = 200;

function clearMemoryCache() { memoryCache.clear(); }

function getCacheDir() {
  const dir = path.join(process.cwd(), 'output', 'http-cache', 'tcgdex-api');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function cachedFetch(url) {
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
  } catch {}

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`TCGdex HTTP ${response.status} for ${url}`);
  }

  const data = await response.json();
  const payload = { ts: Date.now(), data };
  if (memoryCache.size >= MAX_MEMORY_CACHE_SIZE) memoryCache.clear();
  memoryCache.set(url, payload);
  try { fs.writeFileSync(cachePath, JSON.stringify(payload)); } catch {}
  return data;
}

const TCGDEX_BASE = 'https://api.tcgdex.net/v2';

// Card type suffixes (used for search query building)
const CARD_TYPES = ['gx', 'ex', 'vmax', 'vstar', 'v', 'tag team', 'break', 'lv.x', 'prime', 'legend'];

// Set name aliases (kept for title context extraction only - TCGdex handles set identification)
const SET_ALIASES = {
  '151': 'sv3pt5', 'prismatic': 'sv8pt5', 'prismatic evolutions': 'sv8pt5',
  'paldean fates': 'sv4pt5', 'obsidian flames': 'sv3', 'paradox rift': 'sv4',
  'temporal forces': 'sv5', 'twilight masquerade': 'sv6', 'shrouded fable': 'sv6pt5',
  'stellar crown': 'sv7', 'surging sparks': 'sv8', 'scarlet violet': 'sv1',
  'paldea evolved': 'sv2', 'crown zenith': 'swsh12pt5',
  'silver tempest': 'swsh12', 'lost origin': 'swsh11',
  'astral radiance': 'swsh10', 'brilliant stars': 'swsh9',
  'vivid voltage': 'swsh4', 'darkness ablaze': 'swsh3',
  'rebel clash': 'swsh2', 'sword shield': 'swsh1',
  'champions path': 'swsh35', 'shining fates': 'swsh45',
  'celebrations': 'cel25', 'hidden fates': 'sm115',
  'cosmic eclipse': 'sm12', 'unified minds': 'sm11',
  'unbroken bonds': 'sm10', 'team up': 'sm9',
  'celestial storm': 'sm7', 'ultra prism': 'sm5',
  'guardians rising': 'sm2', 'sun moon': 'sm1',
  'evolutions': 'xy12', 'generations': 'g1',
  'xy base': 'xy1'
};

// PSA grade premium multipliers
const PSA_PREMIUMS = {
  '10': 5.0,
  '9':  2.0,
  '8':  1.3,
  '7':  1.0,
};

// Words that are NEVER a Pokemon name
const SKIP_WORDS = new Set([
  'carte', 'card', 'cards', 'pokemon', 'pokmon', 'illustration', 'rare',
  'full', 'art', 'secret', 'promo', 'holo', 'reverse', 'gold', 'silver',
  'psa', 'bgs', 'sgc', 'cgc', 'mint', 'near', 'excellent', 'played',
  'japonais', 'japonaise', 'japanese', 'japan', 'jap', 'francais', 'francaise',
  'anglais', 'anglaise', 'english', 'korean', 'neuf', 'occasion', 'etat',
  'comme', 'tres', 'bon', 'prix', 'grade', 'graded', 'slab', 'double',
  'starter', 'deck', 'booster', 'pack', 'custom', 'proxy', 'fake', 'orica',
  'base', 'set', 'star', 'stars', 'future', 'trainer', 'gallery', 'common',
  'uncommon', 'rainbow', 'ultra', 'hyper', 'special', 'super', 'mega',
  'radiant', 'shiny', 'shining', 'amazing', 'alternate', 'collection',
  'nm', 'lp', 'mp', 'hp', 'dmg', 'tag', 'team', 'kor', 'fra', 'eng', 'jpn',
  'sv2a', 'swsh', 'xy', 'sm', 'bw', 'dp', 'ex', 'gx', 'vmax', 'vstar',
  'francais', 'francaise', 'coreen', 'coreenne', 'coréen', 'coréenne',
  'langue', 'language', 'version', 'edition'
]);

// ─── Language Detection ───────────────────────────────────────────────────────

/**
 * Detects the card language from the listing title.
 * Returns one of: 'fr', 'en', 'jap', 'kor', or null (unknown).
 */
function detectCardLanguage(title) {
  const lower = title.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // French
  if (/\b(francais|francaise|fra|vf|version\s*fran[c]?aise|langue\s*fr[a]?n[c]?aise)\b/.test(lower)) return 'fr';
  // English
  if (/\b(english|anglais|anglaise|eng|version\s*anglaise|langue\s*anglaise)\b/.test(lower)) return 'en';
  // Japanese
  if (/\b(japonais|japonaise|japanese|japan|jap|jpn)\b/.test(lower)) return 'jap';
  // Korean
  if (/\b(korean|kor|coreen|coreenne)\b/.test(lower)) return 'kor';

  return null; // unknown / not specified
}

// ─── Card Term Extraction ─────────────────────────────────────────────────────

/**
 * Extracts the Pokemon name (as-written in title), card number, card type,
 * grading info, rarity hint, and card language from a Vinted listing title.
 * No FR→EN mapping needed here — TCGdex handles French names natively.
 */
function extractPokemonSearchTerms(vintedTitle) {
  const sig = extractCardSignature(vintedTitle);
  const lower = vintedTitle.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = toSlugTokens(vintedTitle);

  // REJECT proxy/custom/fake cards immediately
  if (/\b(custom|proxy|fake|orica|replica)\b/i.test(vintedTitle)) {
    return {
      pokemonName: null, searchName: null, setId: null,
      cardNumber: null, cardType: null, graded: false,
      gradeValue: null, rarity: null, signature: sig,
      language: null, isProxy: true
    };
  }

  // Detect card language
  const language = detectCardLanguage(vintedTitle);

  // Detect card type suffix (GX, EX, V, VMAX, VSTAR, etc.)
  let cardType = null;
  for (const ct of CARD_TYPES) {
    if (lower.includes(ct)) {
      cardType = ct.toUpperCase();
      break;
    }
  }

  // Detect PSA/grading
  let graded = false;
  let gradeValue = null;
  const gradeMatch = lower.match(/(?:psa|bgs|sgc|cgc)\s*(\d{1,2})/);
  if (gradeMatch) {
    graded = true;
    gradeValue = gradeMatch[1];
  }

  // === POKEMON NAME EXTRACTION ===
  // We extract the raw name token(s) from the title as-is (may be French or English).
  // TCGdex will accept the French name directly.
  let pokemonName = null;

  // Clean title for matching
  const cleanLower = lower.replace(/[()[\]{},;:!?]/g, ' ').replace(/\s+/g, ' ').trim();

  // Try to find a multi-word Pokemon name pattern first (Tag Team, &, etc.)
  // e.g. "Mentali & Deoxys", "Dracaufeu & Reshiram"
  const tagTeamMatch = cleanLower.match(
    /([a-z\u00e0-\u00ff]{3,})\s*[&]\s*([a-z\u00e0-\u00ff]{3,})/
  );
  if (tagTeamMatch) {
    const part1 = tagTeamMatch[1].trim();
    const part2 = tagTeamMatch[2].trim();
    if (!SKIP_WORDS.has(part1) && !SKIP_WORDS.has(part2)) {
      pokemonName = `${part1} & ${part2}`;
    }
  }

  // Fallback: find first name-like token in title order
  if (!pokemonName) {
    let firstLongMatch = null;  // 4+ chars
    let firstShortMatch = null; // 3 chars (e.g. "mew")

    for (const token of tokens) {
      if (SKIP_WORDS.has(token) || /^\d+$/.test(token) || CARD_TYPES.includes(token)) continue;
      // Skip pure language/grade tokens
      if (/^(psa|bgs|sgc|cgc|fra|eng|jpn|kor|vf|va)$/.test(token)) continue;

      if (token.length >= 4 && /^[a-z\u00e0-\u00ff-]+$/.test(token) && !firstLongMatch) {
        firstLongMatch = token;
        break; // First long token is almost certainly the Pokemon name
      } else if (token.length === 3 && /^[a-z]+$/.test(token) && !firstShortMatch) {
        firstShortMatch = token;
      }
    }

    pokemonName = firstLongMatch || firstShortMatch;
  }

  // Build searchName (append card type if needed)
  let searchName = pokemonName;
  if (pokemonName && cardType && !pokemonName.toLowerCase().includes(cardType.toLowerCase())) {
    searchName = `${pokemonName} ${cardType}`;
  }

  // Extract set hint from title (for logging/context only)
  let setId = null;
  for (const [alias, id] of Object.entries(SET_ALIASES)) {
    if (lower.includes(alias)) {
      setId = id;
      break;
    }
  }

  // Extract card number from signature
  let rawCardNumber = sig.cardNumber;
  if (!rawCardNumber && sig.serialNumber) {
    const parts = sig.serialNumber.split('/');
    if (parts.length === 2) {
      const num = parseInt(parts[0], 10);
      const total = parseInt(parts[1], 10);
      if (num > 10 && total > 10 && num <= total * 2) {
        rawCardNumber = parts[0];
      }
    }
  }
  const cardNumber = rawCardNumber ? rawCardNumber.replace(/^0+/, '') || rawCardNumber : null;

  // Detect rarity hints from title
  let rarity = null;
  if (lower.includes('illustration rare') || lower.includes('illustration speciale')) rarity = 'Illustration Rare';
  else if (lower.includes('art rare') || lower.includes('special art')) rarity = 'Special Art Rare';
  else if (lower.includes('full art')) rarity = 'Ultra Rare';
  else if (lower.includes('gold') || lower.includes('secret')) rarity = 'Hyper Rare';
  else if (lower.includes('rainbow')) rarity = 'Rare Rainbow';

  return {
    pokemonName,
    searchName,
    setId,
    cardNumber,
    cardType,
    graded,
    gradeValue,
    rarity,
    signature: sig,
    language
  };
}

// ─── TCGdex API ───────────────────────────────────────────────────────────────

/**
 * Search TCGdex for a card by French name, optionally filtering by card number.
 * Returns the best matched card object, or null.
 *
 * Card object shape: { id, localId, name, set: { id, name, cardCount: { total } }, rarity, image }
 */
async function tcgdexSearchCard(pokemonName, cardNumber) {
  if (!pokemonName) return null;

  try {
    // Search by French name in the FR endpoint
    const searchUrl = `${TCGDEX_BASE}/fr/cards?name=${encodeURIComponent(pokemonName)}`;
    const results = await cachedFetch(searchUrl);

    if (!Array.isArray(results) || results.length === 0) return null;

    let candidates = results;

    // If we have a card number, try to filter by it
    if (cardNumber) {
      // localId is the card number within the set (e.g. "143" or "143/188")
      const filtered = candidates.filter(c => {
        const local = String(c.localId || '').replace(/^0+/, '');
        const localBase = local.split('/')[0];
        const target = String(cardNumber).replace(/^0+/, '');
        return localBase === target || local === target;
      });
      if (filtered.length > 0) candidates = filtered;
    }

    // Fetch full detail for the first (best) candidate
    const best = candidates[0];
    if (!best || !best.id) return null;

    const detailUrl = `${TCGDEX_BASE}/fr/cards/${encodeURIComponent(best.id)}`;
    const detail = await cachedFetch(detailUrl);
    return detail || null;

  } catch (err) {
    console.log(`    TCGdex search error for "${pokemonName}": ${err.message}`);
    return null;
  }
}

/**
 * Given a TCGdex card id (e.g. "me01-143"), fetch the English name.
 * Returns the English name string, or null.
 */
async function tcgdexGetEnglishName(cardId) {
  if (!cardId) return null;
  try {
    const enUrl = `${TCGDEX_BASE}/en/cards/${encodeURIComponent(cardId)}`;
    const enCard = await cachedFetch(enUrl);
    return (enCard && enCard.name) ? enCard.name : null;
  } catch {
    return null;
  }
}

// ─── eBay Query Building ──────────────────────────────────────────────────────

/**
 * Builds eBay search query string from extracted card info.
 * Includes the card language label so eBay results are language-accurate.
 *
 * Priority: English name (from TCGdex EN endpoint) if available,
 * else the original name from the title (FR name).
 */
function buildEbayQuery(terms, englishName, tcgdexCard) {
  const parts = [];

  // Prefer English name for eBay (broader international market)
  const primaryName = englishName || terms.pokemonName;

  if (primaryName) {
    parts.push(primaryName);
  }

  // Append card type if present (GX, V, VMAX, etc.)
  if (terms.cardType) {
    const nameHasType = primaryName && primaryName.toUpperCase().includes(terms.cardType);
    if (!nameHasType) {
      parts.push(terms.cardType);
    }
  }

  // Append card number (localId or extracted number)
  const cardNum = terms.cardNumber || (tcgdexCard && tcgdexCard.localId ? tcgdexCard.localId : null);
  if (cardNum) {
    parts.push(cardNum);
  }

  // Append language label for eBay search accuracy
  if (terms.language) {
    const langLabels = {
      fr: 'french',
      en: 'english',
      jap: 'japanese',
      kor: 'korean'
    };
    const label = langLabels[terms.language];
    if (label) parts.push(label);
  }

  // For graded cards, include grade info
  if (terms.graded && terms.gradeValue) {
    parts.push(`psa ${terms.gradeValue}`);
  }

  return parts.join(' ').trim();
}

// ─── Main Pricing Function ────────────────────────────────────────────────────

async function getPokemonMarketPrice(vintedListing, config) {
  const terms = extractPokemonSearchTerms(vintedListing.title);

  // Nothing useful to search on
  if (!terms.pokemonName && !terms.cardNumber) {
    return null;
  }

  // Reject proxies/customs immediately
  if (terms.isProxy) {
    return null;
  }

  let tcgdexCard = null;
  let englishName = null;

  // ── Step 1: Identify the card via TCGdex FR API ──────────────────────────
  if (terms.pokemonName) {
    tcgdexCard = await tcgdexSearchCard(terms.pokemonName, terms.cardNumber);

    if (tcgdexCard) {
      // Step 2: Get English name from TCGdex EN endpoint
      englishName = await tcgdexGetEnglishName(tcgdexCard.id);
      if (englishName) {
        console.log(`    TCGdex: "${terms.pokemonName}" → EN: "${englishName}" (${tcgdexCard.id})`);
      } else {
        console.log(`    TCGdex: "${terms.pokemonName}" trouvé (${tcgdexCard.id}), pas de nom EN`);
      }
    } else {
      console.log(`    TCGdex: "${terms.pokemonName}" non trouvé, recherche eBay avec nom original`);
    }
  }

  // ── Step 3: Build eBay search query ──────────────────────────────────────
  const ebayQuery = buildEbayQuery(terms, englishName, tcgdexCard);

  if (!ebayQuery) {
    return null;
  }

  console.log(`    eBay query: "${ebayQuery}"`);

  // ── Step 4: Fetch eBay sold listings ──────────────────────────────────────
  let soldListings = [];
  try {
    soldListings = await getEbaySoldListings(ebayQuery, config);
  } catch (err) {
    console.error(`    eBay sold listings error: ${err.message}`);
    return null;
  }

  if (!soldListings || soldListings.length === 0) {
    console.log(`    Aucune vente eBay trouvée pour "${ebayQuery}"`);
    return null;
  }

  // ── Step 5: Find best matching eBay listings ──────────────────────────────
  // We run chooseBestSoldListings against a synthetic listing that uses the
  // eBay-style title (English name + card number) so matching tokens align.
  const syntheticListing = {
    title: ebayQuery,
    rawTitle: vintedListing.rawTitle || vintedListing.title,
    buyerPrice: vintedListing.buyerPrice,
    imageUrl: vintedListing.imageUrl,
    url: vintedListing.url
  };

  let matchedSales = chooseBestSoldListings(syntheticListing, soldListings);

  if (!matchedSales || matchedSales.length === 0) {
    console.log(`    chooseBestSoldListings: aucune vente qualifiée pour "${ebayQuery}"`);
    return null;
  }

  // ── Step 6: Image comparison (Vinted vs eBay sold listings) ──────────────
  // Also use TCGdex card image as secondary validation reference
  const tcgdexImageUrl = tcgdexCard
    ? (tcgdexCard.image ? `${tcgdexCard.image}/high.webp` : null)
    : null;

  try {
    // attachImageSignals compares Vinted image vs each eBay sold listing image
    matchedSales = await attachImageSignals(vintedListing, matchedSales, config);
  } catch (err) {
    console.log(`    Image signal warning: ${err.message}`);
    // Non-fatal: continue without image filtering
  }

  // Filter out listings where image comparison strongly rejects the match
  const minImageSimilarity = config.minImageSimilarity || 0.55;
  const imagePassed = matchedSales.filter(sale => {
    const imgScore = sale.imageMatch && sale.imageMatch.score !== null
      ? sale.imageMatch.score
      : null;
    return imgScore === null || imgScore >= minImageSimilarity;
  });

  if (imagePassed.length === 0) {
    console.log(`    Toutes les ventes eBay rejetées par image similarity`);
    return null;
  }

  matchedSales = imagePassed;

  // ── Step 7: Apply PSA premium if graded ──────────────────────────────────
  if (terms.graded && terms.gradeValue) {
    const premium = PSA_PREMIUMS[terms.gradeValue] || 1.5;
    matchedSales = matchedSales.map(sale => ({
      ...sale,
      price: sale.price * premium,
      totalPrice: (sale.totalPrice || sale.price) * premium
    }));
  }

  // ── Step 8: Compute market price (median of top matched sales) ────────────
  const prices = matchedSales.map(s => s.price).filter(p => p > 0).sort((a, b) => a - b);
  if (prices.length === 0) return null;

  const medianIdx = Math.floor(prices.length / 2);
  const marketPrice = prices.length % 2 === 0
    ? (prices[medianIdx - 1] + prices[medianIdx]) / 2
    : prices[medianIdx];

  const gradeLabel = terms.graded ? ` (PSA ${terms.gradeValue})` : '';
  const displayName = englishName || terms.pokemonName || terms.searchName;
  const cardNumLabel = terms.cardNumber ? ` #${terms.cardNumber}` : '';
  const langLabel = terms.language ? ` [${terms.language.toUpperCase()}]` : '';

  // Confidence based on number of matched sales and match quality
  let confidence = 'low';
  if (matchedSales.length >= 5 && matchedSales[0].match && matchedSales[0].match.score >= 15) {
    confidence = 'high';
  } else if (matchedSales.length >= 2 || (matchedSales[0] && matchedSales[0].match && matchedSales[0].match.score >= 10)) {
    confidence = 'medium';
  }

  return {
    matchedSales,
    pricingSource: 'ebay-sold',
    bestMatch: `${displayName}${cardNumLabel}${gradeLabel}${langLabel}`,
    marketPrice,
    confidence,
    pokemonName: terms.pokemonName,
    searchName: terms.searchName,
    englishName,
    language: terms.language,
    tcgdexCardId: tcgdexCard ? tcgdexCard.id : null,
    tcgdexImageUrl,
    ebayQuery
  };
}

module.exports = {
  getPokemonMarketPrice,
  extractPokemonSearchTerms,
  clearMemoryCache
};
