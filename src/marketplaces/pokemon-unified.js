/**
 * pokemon-unified.js — Interface unifiée pour les APIs Pokémon TCG.
 *
 * Fusionne pokemontcg-api.js (PokemonTCG.io / TCGPlayer) et pokemon-tcg.js (TCGdex + eBay).
 *
 * Routing interne :
 *   1. PokemonTCG.io → prix TCGPlayer directs, pas de scraping requis
 *   2. TCGdex + eBay sold → prix de ventes réelles (nécessite DECODO_SCRAPING_API)
 *
 * Utilisation dans price-router.js :
 *   const { getMarketPrice } = require('./pokemon-unified');
 *   const result = await getMarketPrice(listing, config);
 */

const { getPokemonPriceViaTcgApi, clearMemoryCache: clearTcgApiCache } = require('./pokemontcg-api');
const { getPokemonMarketPrice, clearMemoryCache: clearTcgdexCache } = require('./pokemon-tcg');

/**
 * Obtient le prix marché d'un listing Pokémon Vinted.
 * Essaie PokemonTCG.io en premier, puis TCGdex + eBay en fallback.
 *
 * @param {object} listing - { title, buyerPrice, imageUrl, url }
 * @param {object} config  - Config globale
 * @returns {object|null}  - { matchedSales, pricingSource, bestMatch, marketPrice, confidence }
 */
async function getMarketPrice(listing, config) {
  // 1. PokemonTCG.io (prix TCGPlayer directs — préféré)
  try {
    const result = await getPokemonPriceViaTcgApi(listing, config);
    if (result && result.matchedSales && result.matchedSales.length > 0) {
      return result;
    }
  } catch (err) {
    console.log(`    [PokemonUnified] PokemonTCG.io erreur: ${err.message}`);
  }

  // 2. TCGdex + eBay sold (fallback — nécessite scraping activé)
  try {
    const result = await getPokemonMarketPrice(listing, config);
    if (result && result.matchedSales && result.matchedSales.length > 0) {
      return result;
    }
  } catch (err) {
    console.log(`    [PokemonUnified] TCGdex+eBay erreur: ${err.message}`);
  }

  return null;
}

/**
 * Récupère les détails d'une carte par son ID PokemonTCG.io.
 *
 * @param {string} cardId - Ex: "sv3pt5-143"
 * @returns {object|null} - Carte avec images, tcgplayer prices, etc.
 */
async function getCardDetails(cardId) {
  if (!cardId) return null;
  try {
    const url = `https://api.pokemontcg.io/v2/cards/${encodeURIComponent(cardId)}`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.data || null;
  } catch {
    return null;
  }
}

/**
 * Recherche des cartes par nom via PokemonTCG.io.
 *
 * @param {string} query   - Nom anglais ou français de la carte
 * @param {number} [limit] - Nombre max de résultats (défaut 10)
 * @returns {Array}        - Tableau de cartes
 */
async function searchByName(query, limit = 10) {
  if (!query) return [];
  try {
    const q = encodeURIComponent(`name:"${query}"`);
    const url = `https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=${limit}&orderBy=-set.releaseDate`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch {
    return [];
  }
}

/**
 * Vide les caches mémoire des deux sous-modules.
 */
function clearMemoryCache() {
  clearTcgApiCache();
  clearTcgdexCache();
}

module.exports = {
  getMarketPrice,
  getCardDetails,
  searchByName,
  clearMemoryCache
};
