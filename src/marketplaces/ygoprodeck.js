const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractCardSignature } = require('../matching');
const { toSlugTokens } = require('../utils');
const { compareListingImages } = require('../image-match');

// Cache for API results (limited size — disk cache is the real persistence layer)
const memoryCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_MEMORY_CACHE_SIZE = 200;

function clearMemoryCache() { memoryCache.clear(); }

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
  if (memoryCache.size >= MAX_MEMORY_CACHE_SIZE) memoryCache.clear();
  memoryCache.set(url, payload);
  try { fs.writeFileSync(cachePath, JSON.stringify(payload)); } catch {}
  return data;
}

// YGOPRODeck API - https://db.ygoprodeck.com/api-guide/
// Free, no key, 20 requests/second
// Returns prices from Cardmarket, TCGPlayer, eBay, Amazon, CoolStuffInc

const API_BASE = 'https://db.ygoprodeck.com/api/v7';

// Comprehensive French → English Yu-Gi-Oh card name mappings
const FR_TO_EN = {
  // Iconic monsters
  'magicien sombre': 'dark magician',
  'magicienne des tenebres': 'dark magician girl',
  'magicienne sombre': 'dark magician girl',
  'dragon blanc aux yeux bleus': 'blue-eyes white dragon',
  'dragon ultime aux yeux bleus': 'blue-eyes ultimate dragon',
  'dragon noir aux yeux rouges': 'red-eyes black dragon',
  'dragon metallique noir aux yeux rouges': 'red-eyes b. dragon',
  'exodia': 'exodia the forbidden one',
  'soldat du lustre noir': 'black luster soldier',
  'soldat de lustre noir': 'black luster soldier',
  'chevalier de la flamme': 'flame swordsman',
  'dragon aile de ra': 'the winged dragon of ra',
  'obelisque le tourmenteur': 'obelisk the tormentor',
  'slifer le dragon du ciel': 'slifer the sky dragon',
  // Popular modern cards
  'ash blossom': 'ash blossom & joyous spring',
  'fleur de cendres': 'ash blossom & joyous spring',
  'fleur de cendre': 'ash blossom & joyous spring',
  'fantome ogre': 'ghost ogre & snow rabbit',
  'ogre fantome': 'ghost ogre & snow rabbit',
  'fille fantome': 'ghost belle & haunted mansion',
  'veiler effect': 'effect veiler',
  'voileur deffet': 'effect veiler',
  'belle fantome': 'ghost belle & haunted mansion',
  'mourner fantome': 'ghost mourner & moonlit chill',
  'dragon borrelsword': 'borrelsword dragon',
  'dragon borrelend': 'borrelend dragon',
  'dragon borreload': 'borreload dragon',
  'dragon savage borreload': 'borreload savage dragon',
  'dragon tonnerre': 'thunder dragon',
  'baronne de fleur': 'baronne de fleur',
  'dragon poussiere detoile': 'stardust dragon',
  'dragon de la rose noire': 'black rose dragon',
  'dragon rouge archdemon': 'red dragon archfiend',
  'dragon quasar a tir groupe': 'shooting quasar dragon',
  'numero 39 utopie': 'number 39: utopia',
  'numero 62 dragon photon': 'number 62: galaxy-eyes prime photon dragon',
  'dragon aux yeux galactiques': 'galaxy-eyes photon dragon',
  'dragon xyz rebelle': 'dark rebellion xyz dragon',
  'dragon aile cristalline': 'crystal wing synchro dragon',
  'dragon access code talker': 'accesscode talker',
  'dragon arc-en-ciel': 'rainbow dragon',
  'heros elementaire neos': 'elemental hero neos',
  'heros masque': 'masked hero',
  'guerrier buster': 'buster blader',
  'chasseur de dragons buster': 'buster blader',
  'invocateur aleister': 'aleister the invoker',
  'mecaniste aleister': 'aleister the invoker of madness',
  // Dragon types
  'dragon du chaos': 'chaos dragon',
  'dragon de la destruction': 'destruction dragon',
  'dragon a 5 tetes': 'five-headed dragon',
  'dragon arme': 'armed dragon',
  // Staple cards
  'appel de letre hante': 'call of the haunted',
  'monster reborn': 'monster reborn',
  'renaissance du monstre': 'monster reborn',
  'pot de dualite': 'pot of duality',
  'pot de prosperite': 'pot of prosperity',
  'pot de desirs': 'pot of desires',
  'pot davarice': 'pot of avarice',
  'trou noir': 'dark hole',
  'raigeki': 'raigeki',
  'sombre requin': 'dark requiem xyz dragon',
  // Archetypes (common French archetype names)
  'dragon du tonnerre': 'thunder dragon',
  'serpent de la nuit': 'snake of night',
  'chevalier gem': 'gem-knight',
  'harpie': 'harpie lady',
  'soeurs harpie': 'harpie lady sisters',
  'cyber dragon': 'cyber dragon',
  'dragon cybernétique': 'cyber dragon',
  'dragon cybernetique': 'cyber dragon',
  // Extra deck monsters
  'dragon noir meteore aux yeux rouges': 'red-eyes flare metal dragon',
  'dragon du chaos max aux yeux bleus': 'blue-eyes chaos max dragon',
  'alternative dragon blanc aux yeux bleus': 'blue-eyes alternative white dragon',
  'dragon esprit aux yeux bleus': 'blue-eyes spirit dragon',
  // Number/Numero cards
  'numero 17 dragon leviathan': 'number 17: leviathan dragon',
  'numero 32 requin dragon': 'number 32: shark drake',
  'numero 107 dragon tachyon': 'number 107: galaxy-eyes tachyon dragon',
  'numero c107': 'number c107: neo galaxy-eyes tachyon dragon',
  // Ghost/Starlight popular targets
  'paladin de lillumination': 'paladin of the illumination',
  'paladin de l\'illumination': 'paladin of the illumination',
  'dragon predapouvoir': 'predaplant verte anaconda',
  'dragon fusion predapouvoir venin affame': 'starving venom fusion dragon'
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

  // Extract set code — full code first (e.g., "PHNI-FR001"), then simple prefix (e.g., "RA04", "MAGO", "LDK2")
  const fullCodeMatch = vintedTitle.match(/\b([A-Z]{2,5}-[A-Z]{2}\d{3})\b/i);
  const prefixCodeMatch = !fullCodeMatch ? vintedTitle.match(/\b([A-Z]{2,5}\d{1,3})\b/) : null;
  const setCode = fullCodeMatch
    ? fullCodeMatch[1].toUpperCase()
    : (prefixCodeMatch ? prefixCodeMatch[1].toUpperCase() : null);

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

  const lowestPrice = (sets) =>
    [...sets].sort((a, b) => parseFloat(a.set_price || 0) - parseFloat(b.set_price || 0))[0];

  // If we have a set code, try to match it
  if (terms.setCode) {
    const match = cardSets.find(s =>
      (s.set_code || '').toUpperCase().startsWith(terms.setCode.split('-')[0])
    );
    if (match) return { ...match, _setCodeFound: true }; // Exact set code match — high confidence

    // Set code was specified but NOT found in this card's printings.
    // Do NOT fall through to rarity — that risks picking an expensive wrong variant
    // (e.g. a 689€ promo when the actual card is a 4€ reprint).
    // Use the LOWEST priced printing as a conservative estimate.
    return { ...lowestPrice(cardSets), _setCodeFound: false };
  }

  // No set code — try rarity matching
  if (terms.rarity) {
    const rarityMatches = cardSets.filter(s =>
      (s.set_rarity || '').toLowerCase().includes(terms.rarity.toLowerCase())
    );
    if (rarityMatches.length > 0) {
      // Return LOWEST priced rarity match (conservative — avoids anchoring on expensive promos)
      return lowestPrice(rarityMatches);
    }
  }

  // Default: return the LOWEST priced printing
  return lowestPrice(cardSets);
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

      // Price priority: set-specific > min across all sets > global aggregate.
      // Using the global cardmarket aggregate risks returning the most expensive
      // variant (e.g. a 690€ promo) for a listing that is clearly a cheap reprint.
      let bestPrice = null;
      let source = 'cardmarket';

      if (bestSet && setPrice > 0) {
        // Best case: the matched set has a price — use it directly
        bestPrice = setPrice * (config.usdToEurRate || 0.865);
        source = 'ygoprodeck-set';
      } else {
        // No set-specific price available. Use the MINIMUM price across all
        // set printings to avoid anchoring on the most expensive variant.
        const allSetPrices = (card.card_sets || [])
          .map(s => parseFloat(s.set_price || 0))
          .filter(p => p > 0);
        const minSetPrice = allSetPrices.length > 0 ? Math.min(...allSetPrices) : 0;

        if (minSetPrice > 0) {
          bestPrice = minSetPrice * (config.usdToEurRate || 0.865);
          source = 'ygoprodeck-set-min';
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
      }

      return {
        card,
        bestSet,
        setCodeFound: bestSet?._setCodeFound, // true = exact set code match, false = miss, undefined = no code in title
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

    // Compare images: Vinted photo vs API card image to verify same edition
    const vintedImageUrl = vintedListing.imageUrl;
    const minImageSimilarity = config.minImageSimilarity || 0.60;
    const candidates = scored.slice(0, Math.min(5, scored.length));
    let matchedSale = null;

    for (const r of candidates) {
      const apiImageUrl = r.card.card_images?.[0]?.image_url_small || r.card.card_images?.[0]?.image_url || '';
      let imageMatch = null;

      if (vintedImageUrl && apiImageUrl) {
        imageMatch = await compareListingImages(vintedImageUrl, apiImageUrl, config);
      }

      if (imageMatch && imageMatch.score !== null && imageMatch.score < minImageSimilarity) {
        console.log(`    Image rejetee (${(imageMatch.score * 100).toFixed(0)}%): ${r.card.name}${r.bestSet ? ` (${r.bestSet.set_name})` : ''}`);
        continue;
      }

      // Build source URLs
      const cardSlug = (r.card.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const ygoprodeckUrl = `https://ygoprodeck.com/card/${cardSlug}-${r.card.id}`;
      const cmSearchUrl = `https://www.cardmarket.com/en/YuGiOh/Products/Singles?searchString=${encodeURIComponent(r.card.name)}`;

      matchedSale = {
        title: `${r.card.name}${r.bestSet ? ` (${r.bestSet.set_name} - ${r.bestSet.set_rarity})` : ''}`,
        price: r.bestPrice,
        totalPrice: r.bestPrice,
        shippingPrice: 0,
        soldAt: new Date().toISOString(),
        soldAtTs: Date.now(),
        url: cmSearchUrl,
        itemKey: `ygo-${r.card.id}`,
        imageUrl: apiImageUrl,
        marketplace: r.source || 'cardmarket',
        queryUsed: `YGOPRODeck API: ${r.card.name}`,
        sourceUrl: ygoprodeckUrl,
        cardmarketUrl: cmSearchUrl,
        match: {
          score: r.score,
          sharedTokens: [],
          sharedSpecificTokens: [r.card.name],
          sharedIdentityTokens: [r.card.name],
          specificCoverage: r.score >= 8 ? 1.0 : r.score >= 4 ? 0.7 : 0.4,
          missingCritical: false,
          identityFullCoverage: true
        },
        imageMatch: imageMatch || { score: null, confidence: 'unknown' },
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
          setPrice: r.setPrice,
          setCodeFound: r.setCodeFound
        }
      };
      break;
    }

    if (!matchedSale) return null;

    // ── Sanity check: price ratio ────────────────────────────────────────────
    const vintedPrice = vintedListing.buyerPrice || vintedListing.price || 0;
    let confidence = matchedSale.match.score >= 8 ? 'high' : matchedSale.match.score >= 4 ? 'medium' : 'low';

    // HARD SAFETY NET: reject insane price ratios regardless of source.
    // Root cause of the 689€ false positive: set code miss → rarity fallback picks most expensive
    // "secret rare" variant → source='ygoprodeck-set' → old cap was bypassed.
    // Now we apply this cap ALWAYS. A 30x ratio (e.g. 4€ Vinted → 120€+ market) is almost
    // always a wrong-set match, not a legitimate opportunity.
    console.log(`[ygoprodeck] SAFETY CHECK: card="${matchedSale.apiData.cardName}", price=${matchedSale.price.toFixed(2)}, vintedPrice=${vintedPrice}, ratio=${vintedPrice > 0 ? (matchedSale.price / vintedPrice).toFixed(1) : 'N/A'} (buyerPrice=${vintedListing.buyerPrice}, listingPrice=${vintedListing.price})`);
    if (vintedPrice > 0 && matchedSale.price > vintedPrice * 30) {
      console.log(`[ygoprodeck] REJECTED: ${matchedSale.price.toFixed(2)}€ > 30x ${vintedPrice}€ (setCodeFound=${matchedSale.apiData.setCodeFound})`);
      return null;
    }
    if (vintedPrice === 0) {
      console.log(`[ygoprodeck] WARNING: vintedPrice=0, safety cap cannot fire — buyerPrice=${vintedListing.buyerPrice}, price=${vintedListing.price}`);
    }

    if (vintedPrice > 0 && matchedSale.price > vintedPrice * 20) {
      console.log(`    [YGO] Sanity check: prix API ${matchedSale.price.toFixed(2)}€ >> vinted ${vintedPrice}€ → confidence plafonnée`);
      matchedSale.match.score = Math.min(matchedSale.match.score, 20);
      confidence = 'low';
    }

    return {
      matchedSales: [matchedSale],
      pricingSource: 'ygoprodeck',
      bestMatch: matchedSale.apiData.cardName,
      marketPrice: matchedSale.price,
      confidence
    };
  } catch (error) {
    console.error(`    YGOPRODeck API error: ${error.message}`);
    return null;
  }
}

module.exports = {
  getYugiohMarketPrice,
  extractYugiohSearchTerms,
  clearMemoryCache
};
