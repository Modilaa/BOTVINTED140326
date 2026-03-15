const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractCardSignature } = require('../matching');
const { toSlugTokens } = require('../utils');

// Cache for API results
const memoryCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function getCacheDir() {
  const dir = path.join(process.cwd(), 'output', 'http-cache', 'ygoprodeck');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function cachedFetch(url) {
  const cached = memoryCache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

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
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const payload = { ts: Date.now(), data };
  memoryCache.set(url, payload);
  try { fs.writeFileSync(cachePath, JSON.stringify(payload)); } catch {}
  return data;
}

// YGOPRODeck API - https://db.ygoprodeck.com/api-guide/
// Free, no key, 20 requests/second
// Returns prices from Cardmarket, TCGPlayer, eBay, Amazon, CoolStuffInc

const API_BASE = 'https://db.ygoprodeck.com/api/v7';

// French → English Yu-Gi-Oh card name mappings (common ones)
const FR_TO_EN = {
  'magicien sombre': 'dark magician',
  'dragon blanc aux yeux bleus': 'blue-eyes white dragon',
  'dragon noir aux yeux rouges': 'red-eyes black dragon',
  'exodia': 'exodia the forbidden one',
  'chevalier noir': 'dark magician',
  'soldat du lustre noir': 'black luster soldier',
  'invocation de dieu': 'slifer the sky dragon',
  'obelisque': 'obelisk the tormentor',
  'dragon aile de ra': 'the winged dragon of ra'
};

function extractYugiohSearchTerms(vintedTitle) {
  const sig = extractCardSignature(vintedTitle);
  const lower = vintedTitle.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Words to strip to find the card name (everything else IS the card name)
  const stripWords = new Set([
    'carte', 'card', 'cards', 'cartes', 'yugioh', 'yu-gi-oh', 'yu', 'gi', 'oh',
    'tcg', 'trading', 'game', 'jeu', 'de',
    // Rarity words (extracted separately)
    'rare', 'ultra', 'super', 'secret', 'starlight', 'ghost', 'quarter', 'century',
    'collector', 'collectors', 'prismatic', 'ultimate',
    // Condition/language
    'french', 'francais', 'francaise', 'anglais', 'anglaise', 'english',
    'japonais', 'japonaise', 'japanese',
    'edition', '1st', '1ere', 'unlimited', 'near', 'mint', 'played', 'excellent',
    'good', 'lightly', 'moderately', 'heavily', 'nm', 'lp', 'mp', 'hp',
    // Generic
    'neuf', 'occasion', 'tres', 'bon', 'etat', 'comme', 'prix'
  ]);

  // Try French to English mapping first
  let cardName = null;
  for (const [fr, en] of Object.entries(FR_TO_EN)) {
    if (lower.includes(fr)) {
      cardName = en;
      break;
    }
  }

  // Direct extraction: take title, remove yugioh/rarity/condition words, what's left is the card name
  if (!cardName) {
    // Split on common separators but preserve hyphens within words (e.g., "blue-eyes")
    const words = lower
      .replace(/[,;|()[\]{}#]/g, ' ')
      .replace(/\b\d{1,4}\/\d{1,4}\b/g, '') // Remove serial numbers like 1/25
      .replace(/\b[a-z]{2,5}-[a-z]{2}\d{3}\b/gi, '') // Remove set codes like PHNI-FR001
      .split(/\s+/)
      .filter(w => w.length >= 2 && !stripWords.has(w.replace(/-/g, '')) && !/^\d+$/.test(w));

    if (words.length > 0) {
      cardName = words.slice(0, 6).join(' ');
    }
  }

  // Extract set code (e.g., "PHNI-FR001", "RA02-EN001")
  const setCodeMatch = vintedTitle.match(/([A-Z]{2,5}-[A-Z]{2}\d{3})/i);
  const setCode = setCodeMatch ? setCodeMatch[1].toUpperCase() : null;

  // Extract rarity from title
  let rarity = null;
  if (lower.includes('starlight')) rarity = 'Starlight Rare';
  else if (lower.includes('ghost rare')) rarity = 'Ghost Rare';
  else if (lower.includes('quarter century')) rarity = 'Quarter Century Secret Rare';
  else if (lower.includes('secret rare') || lower.includes('secret')) rarity = 'Secret Rare';
  else if (lower.includes('ultra rare') || lower.includes('ultra')) rarity = 'Ultra Rare';
  else if (lower.includes('super rare') || lower.includes('super')) rarity = 'Super Rare';
  else if (lower.includes('collector')) rarity = "Collector's Rare";

  return { cardName, setCode, rarity, signature: sig };
}

function findBestSetMatch(cardSets, terms) {
  if (!cardSets || cardSets.length === 0) return null;

  // If we have a set code, match it
  if (terms.setCode) {
    const match = cardSets.find(s =>
      (s.set_code || '').toUpperCase().startsWith(terms.setCode.split('-')[0])
    );
    if (match) return match;
  }

  // If we have a rarity, filter by it
  if (terms.rarity) {
    const rarityMatches = cardSets.filter(s =>
      (s.set_rarity || '').toLowerCase().includes(terms.rarity.toLowerCase())
    );
    if (rarityMatches.length > 0) {
      // Return the one with highest price
      return rarityMatches.sort((a, b) =>
        parseFloat(b.set_price || 0) - parseFloat(a.set_price || 0)
      )[0];
    }
  }

  // Default: return the set with the highest price (most valuable printing)
  return [...cardSets].sort((a, b) =>
    parseFloat(b.set_price || 0) - parseFloat(a.set_price || 0)
  )[0];
}

async function getYugiohMarketPrice(vintedListing, config) {
  const terms = extractYugiohSearchTerms(vintedListing.title);

  if (!terms.cardName) {
    return null;
  }

  // Use fuzzy name search
  const apiUrl = `${API_BASE}/cardinfo.php?fname=${encodeURIComponent(terms.cardName)}&num=5&offset=0`;

  try {
    let data;
    try {
      data = await cachedFetch(apiUrl);
    } catch (err) {
      if (err.message.includes('429')) {
        console.log('    YGOPRODeck API rate limit, waiting...');
        await new Promise(r => setTimeout(r, 1500));
        return null;
      }
      return null;
    }

    const cards = data.data || [];

    if (cards.length === 0) {
      return null;
    }

    // Score each card against the Vinted title
    const scored = cards.map(card => {
      let score = 0;
      const cardNameLower = (card.name || '').toLowerCase();
      const searchLower = (terms.cardName || '').toLowerCase();
      const searchTokens = toSlugTokens(terms.cardName);
      const cardTokens = toSlugTokens(card.name);

      // Exact name match
      if (cardNameLower === searchLower) {
        score += 15;
      } else if (cardNameLower.startsWith(searchLower) && cardNameLower.length <= searchLower.length + 5) {
        // Close match (e.g., "ash blossom" → "Ash Blossom & Joyous Spring")
        score += 10;
      } else if (searchLower.includes(cardNameLower)) {
        // Search contains the full card name
        score += 8;
      } else {
        // Token overlap - all search tokens must be in card name
        const cardTokenSet = new Set(cardTokens);
        const overlap = searchTokens.filter(t => cardTokenSet.has(t)).length;
        const coverage = overlap / Math.max(searchTokens.length, 1);

        if (coverage >= 0.8) {
          score += 7;
        } else if (coverage >= 0.5) {
          score += 3;
        } else {
          score -= 5; // Penalize poor matches
        }
      }

      // STRICT: reject cards where the name is a superset that changes identity
      // e.g., "Dark Magician" should NOT match "Dark Magician Girl"
      const extraCardTokens = cardTokens.filter(t => !new Set(searchTokens).has(t) && t.length >= 3);
      if (extraCardTokens.length >= 2) {
        score -= extraCardTokens.length * 2; // Heavy penalty for extra name tokens
      }

      // Find best set/printing match
      const bestSet = findBestSetMatch(card.card_sets, terms);
      const setPrice = bestSet ? parseFloat(bestSet.set_price || 0) : 0;

      // Get aggregate prices
      const prices = card.card_prices?.[0] || {};
      const cardmarketPrice = parseFloat(prices.cardmarket_price || 0);
      const tcgplayerPrice = parseFloat(prices.tcgplayer_price || 0);
      const ebayPrice = parseFloat(prices.ebay_price || 0);

      // When rarity is specified, ALWAYS use set-specific price if available
      let bestPrice = null;
      let source = 'cardmarket';

      if (terms.rarity && bestSet && setPrice > 0) {
        // Use set-specific price for the matched rarity (USD → EUR)
        bestPrice = setPrice * (config.usdToEurRate || 0.865);
        source = 'ygoprodeck-set';
      } else if (cardmarketPrice > 0) {
        bestPrice = cardmarketPrice;
        source = 'cardmarket';
      } else if (tcgplayerPrice > 0) {
        bestPrice = tcgplayerPrice * (config.usdToEurRate || 0.865);
        source = 'tcgplayer';
      } else if (ebayPrice > 0) {
        bestPrice = ebayPrice * (config.usdToEurRate || 0.865);
        source = 'ebay-ygoprodeck';
      }

      return {
        card,
        bestSet,
        score,
        bestPrice,
        source,
        cardmarketPrice,
        tcgplayerPrice,
        ebayPrice,
        setPrice
      };
    })
      .filter(r => r.bestPrice && r.bestPrice > 0 && r.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return null;
    }

    const best = scored[0];

    // Only keep results with a score close to the best match (avoid polluting with wrong cards)
    const bestScore = scored[0].score;
    const goodMatches = scored.filter(r => r.score >= bestScore - 3 && r.score > 0);

    // Build synthetic matched sales
    const matchedSales = goodMatches.slice(0, 3).map(r => ({
      title: `${r.card.name}${r.bestSet ? ` (${r.bestSet.set_name} - ${r.bestSet.set_rarity})` : ''}`,
      price: r.bestPrice,
      totalPrice: r.bestPrice,
      shippingPrice: 0,
      soldAt: new Date().toISOString(),
      soldAtTs: Date.now(),
      url: `https://www.cardmarket.com/en/YuGiOh/Products/Singles?searchString=${encodeURIComponent(r.card.name)}`,
      itemKey: `ygo-${r.card.id}`,
      imageUrl: r.card.card_images?.[0]?.image_url_small || r.card.card_images?.[0]?.image_url || '',
      marketplace: r.source || 'cardmarket',
      queryUsed: `YGOPRODeck API: ${r.card.name}`,
      match: {
        score: r.score,
        sharedTokens: [],
        sharedSpecificTokens: [r.card.name],
        sharedIdentityTokens: [r.card.name],
        specificCoverage: r.score >= 8 ? 1.0 : r.score >= 4 ? 0.7 : 0.4,
        missingCritical: false,
        identityFullCoverage: true
      },
      imageMatch: {
        score: r.score >= 8 ? 0.95 : 0.75,
        confidence: r.score >= 8 ? 'high' : 'medium'
      },
      apiData: {
        source: 'ygoprodeck',
        cardId: r.card.id,
        cardName: r.card.name,
        setName: r.bestSet?.set_name,
        setCode: r.bestSet?.set_code,
        rarity: r.bestSet?.set_rarity,
        cardmarketPrice: r.cardmarketPrice,
        tcgplayerPrice: r.tcgplayerPrice,
        ebayPrice: r.ebayPrice,
        setPrice: r.setPrice
      }
    }));

    return {
      matchedSales,
      pricingSource: 'ygoprodeck',
      bestMatch: best.card.name,
      marketPrice: best.bestPrice,
      confidence: best.score >= 8 ? 'high' : best.score >= 4 ? 'medium' : 'low'
    };
  } catch (error) {
    console.error(`    YGOPRODeck API error: ${error.message}`);
    return null;
  }
}

module.exports = {
  getYugiohMarketPrice,
  extractYugiohSearchTerms
};
