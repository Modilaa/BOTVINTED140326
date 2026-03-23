/**
 * Rebrickable API — Identification de sets LEGO.
 *
 * API gratuite : https://rebrickable.com/api/v3/
 * Clé API      : gratuite sur rebrickable.com → variable REBRICKABLE_API_KEY
 * Sans clé     : la recherche est bloquée (401), le module ne plante pas.
 *
 * Stratégie    :
 *   1. Détecte le numéro de set dans le titre Vinted (ex: "75192")
 *   2. Interroge Rebrickable pour obtenir nom officiel + num_parts + année
 *   3. Construit une query eBay enrichie (ex: "LEGO 75192 Millennium Falcon")
 *   4. Retourne une estimation de prix (0.12€/pièce) comme fallback de dernier recours
 */

const { request } = require('undici');

const REBRICKABLE_BASE = 'https://rebrickable.com/api/v3';
const TIMEOUT_MS = 5000;

// ─── Cache ────────────────────────────────────────────────────────────────────

const legoCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h (les sets changent peu)

function getCached(key) {
  const entry = legoCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
  return undefined;
}

function setCache(key, data) {
  if (legoCache.size >= 500) legoCache.clear();
  legoCache.set(key, { ts: Date.now(), data });
}

// ─── Rebrickable API ─────────────────────────────────────────────────────────

async function searchLegoSet(query, apiKey) {
  const cacheKey = `search:${String(query).toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${REBRICKABLE_BASE}/lego/sets/?search=${encodeURIComponent(query)}&page_size=5`;
  const headers = { 'Accept': 'application/json' };
  if (apiKey) headers['Authorization'] = `key ${apiKey}`;

  try {
    const { statusCode, body } = await request(url, {
      method: 'GET',
      headers,
      bodyTimeout: TIMEOUT_MS,
      headersTimeout: TIMEOUT_MS
    });

    if (statusCode === 401) {
      console.log('    [LEGO] Rebrickable: clé API invalide/manquante (REBRICKABLE_API_KEY)');
      setCache(cacheKey, null);
      return null;
    }
    if (statusCode !== 200) {
      console.log(`    [LEGO] Rebrickable: HTTP ${statusCode}`);
      setCache(cacheKey, null);
      return null;
    }

    const data = JSON.parse(await body.text());
    const result = (data.results && data.results.length > 0) ? data.results[0] : null;
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.log(`    [LEGO] Rebrickable erreur: ${err.message}`);
    return null;
  }
}

// ─── Estimation de prix ───────────────────────────────────────────────────────

/**
 * Estimation grossière basée sur le nombre de pièces.
 * Utilisé uniquement comme dernier recours (confidence: 'low').
 */
function estimateLegoPrice(set) {
  if (!set || !set.num_parts || set.num_parts < 10) return null;

  const name = (set.name || '').toLowerCase();
  const year = set.year || 2020;

  let pricePerPart = 0.12; // Standard
  if (name.includes('technic') || name.includes('expert')) pricePerPart = 0.18;
  if (name.includes('ideas') || name.includes('creator expert')) pricePerPart = 0.20;
  if (name.includes('architecture') || name.includes(' art')) pricePerPart = 0.22;
  if (name.includes('star wars') || name.includes('harry potter')) pricePerPart = 0.15;
  if (name.includes('disney') || name.includes('marvel')) pricePerPart = 0.14;

  const ageBonus = year < 2015 ? 1.3 : year < 2018 ? 1.1 : 1.0;
  const raw = set.num_parts * pricePerPart * ageBonus;

  return Math.max(10, Math.round(raw / 5) * 5); // Min 10€, arrondi à 5€
}

// ─── Résultat Rebrickable ─────────────────────────────────────────────────────

function buildLegoResult(set, listing) {
  const setName = set.name || listing.title;
  const setNum = (set.set_num || '').replace(/-\d+$/, ''); // "75192-1" → "75192"
  const estimatedPrice = estimateLegoPrice(set);
  const rebrickableUrl = set.set_url || `https://rebrickable.com/sets/${set.set_num}/`;

  // Query enrichie pour eBay : numéro officiel + nom du set
  const enrichedQuery = setNum ? `LEGO ${setNum} ${setName}` : `LEGO ${setName}`;

  console.log(`    [LEGO] Identifié: "${setName}" (${set.set_num}, ${set.num_parts} pièces, ${set.year})`);

  if (!estimatedPrice) {
    // Retourner quand même l'enrichedQuery même sans prix estimé
    return {
      matchedSales: [],
      pricingSource: 'rebrickable',
      bestMatch: setName,
      marketPrice: 0,
      confidence: 'low',
      enrichedQuery,
      legoSetInfo: { setNum: set.set_num, name: setName, year: set.year, numParts: set.num_parts }
    };
  }

  const matchedSales = [{
    title: `${setName} (${set.num_parts} pièces, ${set.year}) — estimation`,
    price: estimatedPrice,
    totalPrice: estimatedPrice,
    url: rebrickableUrl,
    sourceUrl: rebrickableUrl,
    source: 'rebrickable',
    marketplace: 'rebrickable',
    enrichedQuery
  }];

  console.log(`    [LEGO] Prix estimé: ${estimatedPrice}€ pour "${setName}" (${set.num_parts} pièces)`);

  return {
    matchedSales,
    pricingSource: 'rebrickable',
    bestMatch: setName,
    marketPrice: estimatedPrice,
    confidence: 'low', // Estimation — price-router utilisera eBay en priorité
    enrichedQuery,
    legoSetInfo: { setNum: set.set_num, name: setName, year: set.year, numParts: set.num_parts }
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Identifie un set LEGO via Rebrickable et retourne métadonnées + estimation.
 * Le price-router utilise enrichedQuery pour construire une meilleure query eBay.
 *
 * @param {object} listing - { title, buyerPrice, imageUrl, url }
 * @param {object} config  - Config globale (non utilisé ici)
 * @returns {object|null}  - { matchedSales, pricingSource, bestMatch, marketPrice, confidence, enrichedQuery }
 */
async function getLegoMarketPrice(listing, config) {
  const apiKey = process.env.REBRICKABLE_API_KEY || '';

  // Détecter un numéro de set dans le titre (4 à 6 chiffres)
  const setNumberMatch = listing.title.match(/\b(\d{4,6})\b/);
  const setNumber = setNumberMatch ? setNumberMatch[1] : null;

  let set = null;

  if (setNumber) {
    console.log(`    [LEGO] Recherche Rebrickable par numéro: "${setNumber}"`);
    set = await searchLegoSet(setNumber, apiKey);
  }

  if (!set) {
    // Fallback: recherche par titre sans le numéro
    const titleQuery = setNumber
      ? listing.title.replace(setNumber, '').replace(/\s+/g, ' ').trim()
      : listing.title;
    console.log(`    [LEGO] Recherche Rebrickable par titre: "${titleQuery}"`);
    set = await searchLegoSet(titleQuery, apiKey);
  }

  if (!set) {
    console.log('    [LEGO] Set non trouvé sur Rebrickable');
    return null;
  }

  return buildLegoResult(set, listing);
}

module.exports = { getLegoMarketPrice, searchLegoSet };
