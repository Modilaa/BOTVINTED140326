/**
 * Cardmarket → eBay Scanner (TCG uniquement)
 *
 * Utilise des APIs gratuites pour trouver des cartes moins chères sur
 * Cardmarket que sur eBay (après frais).
 *
 * YGO  → YGOPRODeck API    (donne cardmarket_price + ebay_price)
 * Pokémon → PokemonTCG.io API (donne cardmarket.prices + tcgplayer.prices)
 *
 * Aucun scraping — APIs officielles gratuites uniquement.
 *
 * Frais (Belgique) :
 *   Achat Cardmarket : prix CM + ~1€ livraison
 *   Vente eBay       : prix eBay × (1 - 0.13) - ~4.5€ livraison
 *   Profit           : net_ebay - coût_total
 */

const YGO_API = 'https://db.ygoprodeck.com/api/v7';
const POKEMON_API = 'https://api.pokemontcg.io/v2';

// ─── Cartes YGO à surveiller (requêtes par nom de carte) ─────────────────────
// On cible les cartes de haut niveau dont les prix CM vs eBay divergent souvent.
const YGO_CARD_NAMES = [
  'Ash Blossom & Joyous Spring',
  'Accesscode Talker',
  'Apollousa, Bow of the Goddess',
  'Knightmare Unicorn',
  'Infinite Impermanence',
  'Borrelsword Dragon',
  'Baronne de Fleur',
  'Nibiru, the Primal Being',
  'Droll & Lock Bird',
  'Ghost Mourner & Moonlit Chill',
  'Pot of Prosperity',
  'Called by the Grave',
  'Crossout Designator',
  'Triple Tactics Thrust',
  'S:P Little Knight'
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json', ...headers },
    signal: AbortSignal.timeout(20000)
  });
  if (response.status === 429) throw new Error('rate-limited');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// ─── YGO scanner ─────────────────────────────────────────────────────────────

async function scanYgo(cfg, minProfit, minPct) {
  const opportunities = [];
  const usdToEur = cfg.usdToEurRate || 0.865;
  const ebayFees = 0.13;
  const ebayShipping = cfg.ebayOutboundShippingEstimate || 4.5;
  const cmShipping = cfg.cardmarketShippingEstimate || 1;

  for (const cardName of YGO_CARD_NAMES) {
    try {
      const url = `${YGO_API}/cardinfo.php?name=${encodeURIComponent(cardName)}&num=1&offset=0`;
      let data;
      try {
        data = await fetchJson(url);
      } catch (err) {
        if (err.message === 'rate-limited') {
          await new Promise(r => setTimeout(r, 1500));
        }
        continue;
      }

      const cards = data.data || [];
      if (cards.length === 0) continue;

      const card = cards[0];
      const prices = card.card_prices && card.card_prices[0] ? card.card_prices[0] : {};

      // cardmarket_price est en EUR, ebay_price est en USD
      const cmPrice = parseFloat(prices.cardmarket_price || 0);
      const ebayUsd = parseFloat(prices.ebay_price || 0);
      const ebayEur = ebayUsd * usdToEur;

      if (cmPrice < 3 || ebayEur < 5) continue;

      const acquisitionCost = cmPrice + cmShipping;
      const netSale = ebayEur * (1 - ebayFees) - ebayShipping;
      const profit = netSale - acquisitionCost;
      const profitPercent = (profit / acquisitionCost) * 100;

      if (profit < minProfit || profitPercent < minPct) continue;

      const cardImageUrl = (card.card_images && card.card_images[0] && card.card_images[0].image_url_small) || '';
      const cardmarketUrl = `https://www.cardmarket.com/en/YuGiOh/Products/Singles?searchString=${encodeURIComponent(card.name)}`;
      const ebaySearchUrl = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(card.name + ' yugioh')}&LH_BIN=1`;

      opportunities.push({
        search: 'Yu-Gi-Oh',
        route: 'cardmarket→ebay',
        title: card.name,
        vintedListedPrice: cmPrice,
        vintedBuyerPrice: cmPrice,
        sourceQuery: cardName,
        url: cardmarketUrl,
        imageUrl: cardImageUrl,
        rawTitle: card.name,
        platform: 'cardmarket',
        pricingSource: 'ygoprodeck',
        detectedLanguage: null,
        matchedSales: [{
          title: card.name + ' [eBay]',
          price: ebayEur,
          url: ebaySearchUrl,
          soldAt: new Date().toISOString()
        }],
        sourceUrls: [
          {
            platform: 'ygoprodeck',
            url: `https://db.ygoprodeck.com/card/?search=${encodeURIComponent(card.name)}`,
            title: `${card.name} — CM: ${cmPrice.toFixed(2)}€`,
            price: cmPrice
          },
          {
            platform: 'ebay',
            url: ebaySearchUrl,
            title: `${card.name} [eBay ~${ebayEur.toFixed(2)}€]`,
            price: ebayEur
          }
        ],
        profit: {
          averageSoldPrice: ebayEur,
          averageBuyerPaid: ebayEur,
          soldPrices: [ebayEur],
          soldTotals: [ebayEur],
          totalCost: acquisitionCost,
          estimatedNetSale: netSale,
          profit,
          profitPercent
        }
      });

      // Pause légère entre requêtes YGOPRODeck (20 req/s max)
      await new Promise(r => setTimeout(r, 100));
    } catch {
      // Non-fatal
    }
  }

  return opportunities;
}

// ─── Pokemon scanner ─────────────────────────────────────────────────────────

async function scanPokemon(cfg, minProfit, minPct) {
  const opportunities = [];
  const usdToEur = cfg.usdToEurRate || 0.865;
  const ebayFees = 0.13;
  const ebayShipping = cfg.ebayOutboundShippingEstimate || 4.5;
  const cmShipping = cfg.cardmarketShippingEstimate || 1;

  // Requête : cartes Illustration Rare ou SIR des sets récents, triées par prix CM décroissant
  const queryUrl = `${POKEMON_API}/cards?q=rarity:"Illustration Rare" OR rarity:"Special Illustration Rare"&orderBy=-cardmarket.prices.averageSellPrice&pageSize=20`;
  const headers = {};
  if (cfg.pokemonTcgApiKey) headers['X-Api-Key'] = cfg.pokemonTcgApiKey;

  let cards;
  try {
    const data = await fetchJson(queryUrl, headers);
    cards = data.data || [];
  } catch (err) {
    console.log(`  [CardmarketScanner] PokemonTCG.io erreur: ${err.message}`);
    return opportunities;
  }

  for (const card of cards) {
    try {
      const cmPrices = card.cardmarket && card.cardmarket.prices;
      const tcgPrices = card.tcgplayer && card.tcgplayer.prices;
      if (!cmPrices || !tcgPrices) continue;

      // Prix Cardmarket (EUR)
      const cmPrice = cmPrices.averageSellPrice || cmPrices.trendPrice || 0;
      if (!cmPrice || cmPrice <= 0) continue;

      // Prix TCGPlayer (USD) → proxy du prix eBay
      const priceTypes = ['holofoil', 'reverseHolofoil', 'normal', '1stEditionHolofoil'];
      let tcgUsd = 0;
      for (const type of priceTypes) {
        const p = tcgPrices[type];
        if (p) {
          tcgUsd = p.market || p.mid || p.low || 0;
          if (tcgUsd > 0) break;
        }
      }
      if (!tcgUsd || tcgUsd <= 0) continue;

      const ebayEur = tcgUsd * usdToEur; // TCGPlayer ≈ référence eBay

      if (cmPrice < 5 || ebayEur < 8) continue;

      const acquisitionCost = cmPrice + cmShipping;
      const netSale = ebayEur * (1 - ebayFees) - ebayShipping;
      const profit = netSale - acquisitionCost;
      const profitPercent = (profit / acquisitionCost) * 100;

      if (profit < minProfit || profitPercent < minPct) continue;

      const cardName = `${card.name} ${card.number}/${card.set && card.set.printedTotal || '?'} [${card.set && card.set.name || ''}]`;
      const cardmarketUrl = (card.cardmarket && card.cardmarket.url) ||
        `https://www.cardmarket.com/en/Pokemon/Products/Singles?searchString=${encodeURIComponent(card.name)}`;
      const ebaySearchUrl = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(card.name + ' pokemon card')}&LH_BIN=1`;

      opportunities.push({
        search: 'Pokemon',
        route: 'cardmarket→ebay',
        title: cardName,
        vintedListedPrice: cmPrice,
        vintedBuyerPrice: cmPrice,
        sourceQuery: card.name,
        url: cardmarketUrl,
        imageUrl: (card.images && card.images.small) || '',
        rawTitle: card.name,
        platform: 'cardmarket',
        pricingSource: 'pokemon-tcg-api',
        detectedLanguage: null,
        matchedSales: [{
          title: card.name + ' [TCGPlayer]',
          price: ebayEur,
          url: (card.tcgplayer && card.tcgplayer.url) || ebaySearchUrl,
          soldAt: new Date().toISOString()
        }],
        sourceUrls: [
          {
            platform: 'pokemontcg',
            url: cardmarketUrl,
            title: `${card.name} — CM: ${cmPrice.toFixed(2)}€`,
            price: cmPrice
          },
          {
            platform: 'ebay',
            url: ebaySearchUrl,
            title: `${card.name} [eBay ref ~${ebayEur.toFixed(2)}€]`,
            price: ebayEur
          }
        ],
        profit: {
          averageSoldPrice: ebayEur,
          averageBuyerPaid: ebayEur,
          soldPrices: [ebayEur],
          soldTotals: [ebayEur],
          totalCost: acquisitionCost,
          estimatedNetSale: netSale,
          profit,
          profitPercent
        }
      });
    } catch {
      // Non-fatal
    }
  }

  return opportunities;
}

// ─── Scanner principal ───────────────────────────────────────────────────────

/**
 * Lance le scan Cardmarket→eBay pour les catégories TCG.
 *
 * @param {object} cfg - Config globale
 * @returns {Array} Opportunités avec route: 'cardmarket→ebay'
 */
async function runCardmarketScanner(cfg) {
  const minProfit = cfg.minProfitEur || 5;
  const minPct = cfg.minProfitPercent || 20;
  const opportunities = [];

  // ─── YGO ────────────────────────────────────────────────────────────────
  // Seulement si la recherche YGO est configurée
  const hasYgo = (cfg.searches || []).some(s => s.name === 'Yu-Gi-Oh' || s.pricingSource === 'ygoprodeck');
  if (hasYgo) {
    console.log('  [CardmarketScanner] Scan YGO via YGOPRODeck...');
    try {
      const ygoOpps = await scanYgo(cfg, minProfit, minPct);
      opportunities.push(...ygoOpps);
    } catch (err) {
      console.error(`  [CardmarketScanner] YGO erreur: ${err.message}`);
    }
  }

  // ─── Pokemon ─────────────────────────────────────────────────────────────
  const hasPokemon = (cfg.searches || []).some(s => s.name === 'Pokemon' || s.pricingSource === 'pokemon-tcg-api');
  if (hasPokemon) {
    console.log('  [CardmarketScanner] Scan Pokemon via PokemonTCG.io...');
    try {
      const pokOpps = await scanPokemon(cfg, minProfit, minPct);
      opportunities.push(...pokOpps);
    } catch (err) {
      console.error(`  [CardmarketScanner] Pokemon erreur: ${err.message}`);
    }
  }

  console.log(`  [CardmarketScanner] ${opportunities.length} opportunité(s) Cardmarket→eBay détectée(s)`);
  return opportunities;
}

module.exports = { runCardmarketScanner };
