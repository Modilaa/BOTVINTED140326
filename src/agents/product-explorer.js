/**
 * Agent Product Explorer — Explore de nouvelles catégories de produits rentables
 * au-delà des cartes TCG pour l'arbitrage Vinted → eBay.
 *
 * Responsabilités :
 *   1. Base de connaissances de niches rentables (sneakers, LEGO, vinyles, etc.)
 *   2. Analyse de rentabilité par catégorie (marge, volume, risque)
 *   3. Générateur de queries Vinted pour les top catégories
 *   4. Veille tendances via scraping web
 *   5. Rapport classé par score de rentabilité
 *   6. Notification Telegram avec le résumé
 */

const fs = require('fs');
const path = require('path');
const { fetchText } = require('../http');
const { sendTelegramMessage } = require('../notifier');

// ═══════════════════════════════════════════════════════════════════════
//  1. BASE DE CONNAISSANCES — NICHES RENTABLES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Chaque niche contient :
 *   - category : identifiant unique
 *   - label : nom lisible
 *   - avgBuyPrice : prix d'achat moyen Vinted (EUR)
 *   - avgSellPrice : prix de revente moyen eBay (EUR)
 *   - volumeScore : 1-10 (combien d'annonces dispo)
 *   - sourcingEase : 1-10 (facilité à trouver)
 *   - counterFeitRisk : 1-10 (10 = très risqué)
 *   - shippingDifficulty : 1-10 (10 = fragile/volumineux)
 *   - keywords : mots-clés typiques
 *   - vintedQueries : queries de recherche Vinted prêtes à l'emploi
 *   - ebayMatchCriteria : critères pour matcher sur eBay
 *   - priceRange : { min, max } filtre prix Vinted
 *   - hotItems : sous-catégories / produits les plus rentables
 *   - notes : remarques pour l'arbitragiste
 */
const NICHE_DATABASE = [
  // ── Cartes TCG (référence — déjà implémenté) ──────────────────────
  {
    category: 'tcg_cards',
    label: 'Cartes TCG (Pokémon, Yu-Gi-Oh, One Piece, Magic, Sports)',
    avgBuyPrice: 8,
    avgSellPrice: 22,
    volumeScore: 9,
    sourcingEase: 8,
    counterfeitRisk: 5,
    shippingDifficulty: 1,
    keywords: ['pokemon', 'yugioh', 'one piece', 'magic', 'topps', 'panini'],
    vintedQueries: [],
    ebayMatchCriteria: { condition: 'any', listingType: 'sold' },
    priceRange: { min: 2, max: 150 },
    hotItems: [
      'Illustration Rare Pokémon', 'Starlight Rare Yu-Gi-Oh',
      'Alt Art One Piece', 'Silver Prizm Panini', 'Refractor Topps'
    ],
    notes: 'Déjà couvert par le bot. Référence de comparaison.',
    alreadyImplemented: true
  },

  // ── Sneakers ───────────────────────────────────────────────────────
  {
    category: 'sneakers',
    label: 'Sneakers (Nike Dunk, Jordan, NB 550, Asics)',
    avgBuyPrice: 55,
    avgSellPrice: 110,
    volumeScore: 9,
    sourcingEase: 7,
    counterfeitRisk: 8,
    shippingDifficulty: 3,
    keywords: ['nike dunk', 'jordan', 'new balance 550', 'asics gel', 'yeezy', 'adidas samba'],
    vintedQueries: [
      'nike dunk low',
      'nike dunk neuf',
      'jordan 1 retro',
      'jordan 4 neuf',
      'new balance 550 neuf',
      'asics gel kayano',
      'asics gel lyte III',
      'adidas samba OG neuf',
      'nike air max 1 neuf',
      'jordan 3 retro'
    ],
    ebayMatchCriteria: { condition: 'new', listingType: 'sold', sizeMatching: true },
    priceRange: { min: 30, max: 200 },
    hotItems: [
      'Nike Dunk Low coloris exclusifs', 'Jordan 1 Mid/High collab',
      'New Balance 550 coloris limités', 'Asics Gel-Lyte III collab',
      'Nike Air Max 1 Patta/Travis Scott'
    ],
    notes: 'Attention aux contrefaçons. Vérifier boîte, étiquette, pointure. Marge excellente sur les collabs.'
  },

  // ── LEGO ───────────────────────────────────────────────────────────
  {
    category: 'lego',
    label: 'LEGO (sets discontinués, minifigs rares)',
    avgBuyPrice: 25,
    avgSellPrice: 55,
    volumeScore: 7,
    sourcingEase: 6,
    counterfeitRisk: 3,
    shippingDifficulty: 5,
    keywords: ['lego', 'lego star wars', 'lego technic', 'lego city', 'lego creator', 'minifig'],
    vintedQueries: [
      'lego star wars set complet',
      'lego technic neuf',
      'lego creator expert',
      'lego architecture',
      'lego minifigure rare',
      'lego harry potter set',
      'lego icons',
      'lego ideas neuf',
      'lego ninjago set',
      'lego lot minifigures'
    ],
    ebayMatchCriteria: { condition: 'any', listingType: 'sold', checkCompleteness: true },
    priceRange: { min: 10, max: 300 },
    hotItems: [
      'Sets Star Wars discontinués (UCS)', 'Minifigs Cloud City Boba Fett',
      'Creator Expert modulaires', 'Ideas sets épuisés', 'Technic grands modèles'
    ],
    notes: 'Les sets scellés valent 2-3x plus. Vérifier si complet (pièces + notice). Envoi volumineux.'
  },

  // ── Vinyles ────────────────────────────────────────────────────────
  {
    category: 'vinyl_records',
    label: 'Vinyles (pressages limités, collectors)',
    avgBuyPrice: 12,
    avgSellPrice: 35,
    volumeScore: 8,
    sourcingEase: 7,
    counterfeitRisk: 2,
    shippingDifficulty: 4,
    keywords: ['vinyle', 'vinyl', 'LP', '33 tours', 'pressage limité', 'picture disc'],
    vintedQueries: [
      'vinyle collector neuf',
      'vinyle édition limitée',
      'vinyle picture disc',
      'vinyle couleur limité',
      'vinyl record sealed',
      'vinyle rap français limité',
      'vinyle rock collector',
      'vinyle K-pop',
      'vinyle Taylor Swift',
      'vinyle Daft Punk'
    ],
    ebayMatchCriteria: { condition: 'any', listingType: 'sold' },
    priceRange: { min: 5, max: 150 },
    hotItems: [
      'Pressages colorés limités', 'Vinyles K-pop (BTS, Stray Kids)',
      'Rap FR éditions limitées (PNL, SCH)', 'Picture discs collector',
      'Premiers pressages rock 70-80s', 'Taylor Swift variantes exclusives'
    ],
    notes: 'Vérifier état du vinyle et de la pochette (VG+, NM). Les scellés se vendent beaucoup plus cher.'
  },

  // ── Consoles rétro ────────────────────────────────────────────────
  {
    category: 'retro_consoles',
    label: 'Consoles rétro (Game Boy, N64, PS1, PSP)',
    avgBuyPrice: 35,
    avgSellPrice: 75,
    volumeScore: 6,
    sourcingEase: 5,
    counterfeitRisk: 2,
    shippingDifficulty: 4,
    keywords: ['game boy', 'gameboy', 'nintendo 64', 'n64', 'ps1', 'playstation', 'psp', 'gba', 'snes'],
    vintedQueries: [
      'game boy color console',
      'game boy advance SP',
      'nintendo 64 console',
      'PSP console lot',
      'PS1 console lot jeux',
      'game boy pocket',
      'nintendo DS lite',
      'super nintendo console',
      'gamecube console',
      'sega mega drive'
    ],
    ebayMatchCriteria: { condition: 'used', listingType: 'sold', testFunctionality: true },
    priceRange: { min: 15, max: 200 },
    hotItems: [
      'Game Boy Micro', 'Game Boy Advance SP AGS-101',
      'N64 + manettes + jeux', 'PSP éditions limitées',
      'GameCube avec manettes', 'PS1 lot complet'
    ],
    notes: 'Tester le fonctionnement. Les lots (console + jeux + accessoires) se vendent mieux. Marché international solide.'
  },

  // ── Jeux vidéo rétro ──────────────────────────────────────────────
  {
    category: 'retro_games',
    label: 'Jeux vidéo rétro (CIB, sealed)',
    avgBuyPrice: 15,
    avgSellPrice: 40,
    volumeScore: 7,
    sourcingEase: 6,
    counterfeitRisk: 4,
    shippingDifficulty: 2,
    keywords: ['jeu retro', 'jeu nintendo', 'jeu game boy', 'jeu n64', 'jeu PS1', 'CIB'],
    vintedQueries: [
      'jeu game boy complet',
      'jeu nintendo 64 boite',
      'jeu PS1 complet',
      'jeu super nintendo complet',
      'jeu GBA complet boite',
      'zelda game boy',
      'pokemon game boy jeu',
      'mario nintendo 64',
      'final fantasy PS1',
      'jeu gamecube complet'
    ],
    ebayMatchCriteria: { condition: 'used', listingType: 'sold' },
    priceRange: { min: 5, max: 150 },
    hotItems: [
      'Pokémon versions GBC/GBA complètes', 'Zelda tous supports',
      'Mario Kart 64 CIB', 'Final Fantasy PS1 complets',
      'Jeux scellés (sealed) toutes plateformes'
    ],
    notes: 'CIB (Complete In Box) vaut 2-5x le jeu loose. Les contrefaçons GBA sont courantes. Vérifier le label.'
  },

  // ── Parfums ────────────────────────────────────────────────────────
  {
    category: 'perfumes',
    label: 'Parfums (niche, éditions limitées, flacons discontinués)',
    avgBuyPrice: 25,
    avgSellPrice: 55,
    volumeScore: 7,
    sourcingEase: 6,
    counterfeitRisk: 7,
    shippingDifficulty: 5,
    keywords: ['parfum', 'eau de parfum', 'cologne', 'niche', 'tom ford', 'dior', 'chanel'],
    vintedQueries: [
      'parfum tom ford neuf',
      'parfum creed aventus',
      'parfum dior sauvage',
      'parfum baccarat rouge',
      'parfum discontinué',
      'parfum niche rare',
      'parfum maison francis kurkdjian',
      'parfum le labo',
      'parfum amouage',
      'parfum byredo'
    ],
    ebayMatchCriteria: { condition: 'new', listingType: 'sold', authenticityCheck: true },
    priceRange: { min: 15, max: 200 },
    hotItems: [
      'Tom Ford Private Blend', 'Creed Aventus / Green Irish Tweed',
      'Maison Francis Kurkdjian Baccarat Rouge', 'Parfums discontinués (Dior, YSL)',
      'Le Labo Santal 33', 'Amouage Interlude'
    ],
    notes: 'Risque de contrefaçon élevé. Vérifier batch code, packaging, code barre. Envoi fragile.'
  },

  // ── Montres ────────────────────────────────────────────────────────
  {
    category: 'watches',
    label: 'Montres (Casio vintage, Swatch, Seiko)',
    avgBuyPrice: 20,
    avgSellPrice: 50,
    volumeScore: 7,
    sourcingEase: 6,
    counterfeitRisk: 5,
    shippingDifficulty: 3,
    keywords: ['casio', 'swatch', 'seiko', 'montre vintage', 'G-Shock', 'casio vintage'],
    vintedQueries: [
      'casio vintage montre',
      'casio G-Shock',
      'swatch montre vintage',
      'swatch moonswatch',
      'seiko 5 automatique',
      'seiko presage',
      'casio A168 doré',
      'montre vintage homme',
      'G-Shock limited edition',
      'swatch collector'
    ],
    ebayMatchCriteria: { condition: 'any', listingType: 'sold' },
    priceRange: { min: 10, max: 200 },
    hotItems: [
      'Casio Vintage dorées (A168, A700)', 'G-Shock Casioak GA-2100',
      'Swatch X Omega MoonSwatch', 'Swatch vintage 80-90s',
      'Seiko 5 Sports', 'Casio éditions limitées'
    ],
    notes: 'Les Casio vintage dorées ont un excellent ratio marge/facilité. MoonSwatch très demandées à l\'international.'
  },

  // ── Vêtements vintage ─────────────────────────────────────────────
  {
    category: 'vintage_clothing',
    label: 'Vêtements vintage (Ralph Lauren, Burberry, TNF)',
    avgBuyPrice: 15,
    avgSellPrice: 40,
    volumeScore: 10,
    sourcingEase: 8,
    counterfeitRisk: 6,
    shippingDifficulty: 3,
    keywords: ['vintage', 'ralph lauren', 'burberry', 'the north face', 'carhartt', 'nike vintage'],
    vintedQueries: [
      'ralph lauren polo vintage',
      'burberry écharpe vintage',
      'the north face nuptse vintage',
      'carhartt veste vintage',
      'nike vintage sweat',
      'adidas vintage veste',
      'lacoste vintage pull',
      'tommy hilfiger vintage',
      'stussy vintage',
      'ralph lauren bear sweat'
    ],
    ebayMatchCriteria: { condition: 'used', listingType: 'sold', brandCheck: true },
    priceRange: { min: 5, max: 150 },
    hotItems: [
      'TNF Nuptse 700', 'Ralph Lauren Polo Bear sweat',
      'Burberry écharpes Nova Check', 'Carhartt WIP vestes Detroit',
      'Nike vintage swoosh center', 'Adidas vintage 3 bandes'
    ],
    notes: 'Volume énorme sur Vinted. Marges plus faibles mais très régulières. Vérifier authenticité des étiquettes.'
  },

  // ── Livres rares ──────────────────────────────────────────────────
  {
    category: 'rare_books',
    label: 'Livres rares (premières éditions, mangas collector)',
    avgBuyPrice: 8,
    avgSellPrice: 25,
    volumeScore: 6,
    sourcingEase: 5,
    counterfeitRisk: 1,
    shippingDifficulty: 3,
    keywords: ['manga', 'première édition', 'collector', 'berserk', 'one piece', 'naruto', 'dragon ball'],
    vintedQueries: [
      'manga collector édition',
      'berserk manga lot',
      'one piece manga lot',
      'dragon ball manga première édition',
      'naruto manga lot complet',
      'manga rare épuisé',
      'manga edition originale',
      'livre première édition',
      'coffret manga collector',
      'manga perfect edition'
    ],
    ebayMatchCriteria: { condition: 'any', listingType: 'sold' },
    priceRange: { min: 3, max: 200 },
    hotItems: [
      'Berserk édition originale Glénat', 'Dragon Ball première édition',
      'Coffrets manga collector', 'Manga épuisés/out of print',
      'Light novels collector', 'Artbooks limités'
    ],
    notes: 'Les lots complets de séries populaires se vendent très bien. Les premières éditions Glénat sont recherchées.'
  },

  // ── Figurines ─────────────────────────────────────────────────────
  {
    category: 'figurines',
    label: 'Figurines (Funko Pop, anime, Star Wars)',
    avgBuyPrice: 12,
    avgSellPrice: 30,
    volumeScore: 8,
    sourcingEase: 7,
    counterfeitRisk: 4,
    shippingDifficulty: 5,
    keywords: ['funko pop', 'figurine', 'figure', 'star wars', 'dragon ball', 'one piece', 'anime'],
    vintedQueries: [
      'funko pop rare',
      'funko pop exclusive',
      'funko pop chase',
      'figurine dragon ball',
      'figurine one piece',
      'figurine star wars vintage',
      'figurine anime collector',
      'figurine naruto',
      'funko pop marvel',
      'figurine Bandai'
    ],
    ebayMatchCriteria: { condition: 'any', listingType: 'sold' },
    priceRange: { min: 5, max: 150 },
    hotItems: [
      'Funko Pop Chase/Exclusive/Convention', 'Figurines Dragon Ball Ichiban Kuji',
      'Star Wars Black Series vintage', 'One Piece Portrait of Pirates',
      'Funko Pop vaultées', 'Figurines Bandai SH Figuarts'
    ],
    notes: 'Les Funko Pop "vaultées" (arrêtées) prennent de la valeur. Boîte en bon état = +50% de valeur.'
  },

  // ── Tech / Gadgets ────────────────────────────────────────────────
  {
    category: 'tech_gadgets',
    label: 'Tech (AirPods, claviers mécaniques, calculatrices TI)',
    avgBuyPrice: 30,
    avgSellPrice: 65,
    volumeScore: 7,
    sourcingEase: 6,
    counterfeitRisk: 6,
    shippingDifficulty: 3,
    keywords: ['airpods', 'clavier mécanique', 'calculatrice', 'TI-83', 'TI-84', 'ipad', 'apple'],
    vintedQueries: [
      'airpods pro neuf',
      'airpods neuf scellé',
      'clavier mécanique',
      'calculatrice TI-83',
      'calculatrice TI-84',
      'calculatrice casio graph',
      'apple watch occasion',
      'ipad occasion',
      'kindle paperwhite',
      'sony WH-1000XM'
    ],
    ebayMatchCriteria: { condition: 'any', listingType: 'sold', verifySerial: true },
    priceRange: { min: 15, max: 300 },
    hotItems: [
      'AirPods Pro (occasion bon état)', 'Calculatrices TI-83/84 (rentrée scolaire)',
      'Claviers mécaniques customs', 'Kindle Paperwhite occasion',
      'Apple Watch occasion', 'Casques Sony WH-1000XM'
    ],
    notes: 'Calculatrices TI = gold mine à la rentrée (juillet-septembre). AirPods : vérifier authenticité + numéro de série.'
  }
];

// ═══════════════════════════════════════════════════════════════════════
//  2. ANALYSE DE RENTABILITÉ
// ═══════════════════════════════════════════════════════════════════════

/**
 * Calcule le score de rentabilité global pour chaque niche.
 *
 * Formule du score (sur 100) :
 *   grossMargin (30%) + volume (20%) + sourcingEase (20%)
 *   - counterfeitRisk (15%) - shippingDifficulty (15%)
 *
 * @param {Array} niches - Liste des niches de NICHE_DATABASE
 * @returns {Array} Niches enrichies avec les métriques de rentabilité
 */
function analyzeAllNiches(niches) {
  const results = [];

  for (const niche of niches) {
    const grossMargin = niche.avgSellPrice - niche.avgBuyPrice;
    const grossMarginPercent = niche.avgBuyPrice > 0
      ? Math.round((grossMargin / niche.avgBuyPrice) * 100)
      : 0;

    // Frais eBay estimés (13% + 3% paiement + port sortant ~4.50€)
    const ebayFees = niche.avgSellPrice * 0.13;
    const paymentFees = niche.avgSellPrice * 0.03;
    const shippingOut = 4.50;
    const shippingIn = 3.50; // frais port Vinted entrant estimé
    const totalCost = niche.avgBuyPrice + shippingIn;
    const netRevenue = niche.avgSellPrice - ebayFees - paymentFees - shippingOut;
    const netProfit = netRevenue - totalCost;
    const netMarginPercent = totalCost > 0
      ? Math.round((netProfit / totalCost) * 100)
      : 0;

    // Score composite (0-100)
    const marginScore = Math.min(grossMarginPercent / 2, 30); // max 30 pts
    const volumePoints = (niche.volumeScore / 10) * 20;       // max 20 pts
    const sourcingPoints = (niche.sourcingEase / 10) * 20;     // max 20 pts
    const riskPenalty = (niche.counterfeitRisk / 10) * 15;     // max -15 pts
    const shippingPenalty = (niche.shippingDifficulty / 10) * 15; // max -15 pts

    const globalScore = Math.round(
      marginScore + volumePoints + sourcingPoints - riskPenalty - shippingPenalty
    );

    results.push({
      ...niche,
      metrics: {
        grossMargin,
        grossMarginPercent,
        ebayFees: Math.round(ebayFees * 100) / 100,
        paymentFees: Math.round(paymentFees * 100) / 100,
        shippingOut,
        shippingIn,
        totalCost: Math.round(totalCost * 100) / 100,
        netRevenue: Math.round(netRevenue * 100) / 100,
        netProfit: Math.round(netProfit * 100) / 100,
        netMarginPercent,
        globalScore: Math.max(0, Math.min(100, globalScore))
      }
    });
  }

  // Trier par score décroissant
  results.sort((a, b) => b.metrics.globalScore - a.metrics.globalScore);

  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  3. GÉNÉRATEUR DE QUERIES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Pour les top N catégories, génère la config de recherche
 * compatible avec le format de config.searches du bot.
 *
 * @param {Array} rankedNiches - Niches triées par score
 * @param {number} topN - Nombre de catégories à inclure
 * @returns {Array} Configs de recherche prêtes à intégrer
 */
function generateSearchConfigs(rankedNiches, topN = 5) {
  const configs = [];

  const newNiches = rankedNiches
    .filter((n) => !n.alreadyImplemented)
    .slice(0, topN);

  for (const niche of newNiches) {
    // Générer les tokens de filtrage
    const requiredAnyTokens = niche.keywords.slice(0, 5);
    const blockedTokens = generateBlockedTokens(niche.category);

    configs.push({
      name: niche.label.split(' (')[0], // Nom court
      category: niche.category,
      pricingSource: 'ebay',
      maxPrice: niche.priceRange.max,
      vintedQueries: niche.vintedQueries,
      requiredAnyTokens,
      blockedTokens,
      priceRange: niche.priceRange,
      estimatedMetrics: {
        netProfit: niche.metrics.netProfit,
        netMarginPercent: niche.metrics.netMarginPercent,
        globalScore: niche.metrics.globalScore
      },
      notes: niche.notes
    });
  }

  return configs;
}

/**
 * Génère des tokens bloqués spécifiques à chaque catégorie
 * pour éviter les faux positifs.
 */
function generateBlockedTokens(category) {
  const commonBlocked = ['cassé', 'broken', 'pièces détachées', 'pour pièces', 'HS'];

  const categoryBlocked = {
    sneakers: ['chaussette', 'semelle', 'lacet seul', 'réplique', 'inspired'],
    lego: ['playmobil', 'mega bloks', 'compatible lego', 'copie'],
    vinyl_records: ['CD', 'cassette', 'MP3', 'poster', 'tshirt', 'tee shirt'],
    retro_consoles: ['coque', 'skin', 'sticker', 'housse seule'],
    retro_games: ['repro', 'reproduction', 'custom', 'romhack'],
    perfumes: ['échantillon', 'sample', 'miniature 5ml', 'testeur', 'vide', 'flacon vide'],
    watches: ['bracelet seul', 'boitier seul', 'pile', 'réplique'],
    vintage_clothing: ['tache', 'troué', 'déchiré', 'réplique'],
    rare_books: ['photocopie', 'ebook', 'numérique'],
    figurines: ['custom', 'print 3d', 'bootleg', 'copie'],
    tech_gadgets: ['coque', 'étui', 'câble seul', 'chargeur seul', 'réplique']
  };

  return [...commonBlocked, ...(categoryBlocked[category] || [])];
}

// ═══════════════════════════════════════════════════════════════════════
//  4. VEILLE TENDANCES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sources de veille tendances.
 * On scrape des pages publiques pour détecter les produits en hausse.
 */
const TREND_SOURCES = [
  {
    name: 'eBay Trending FR',
    url: 'https://www.ebay.fr/deals',
    parser: 'ebay_deals'
  },
  {
    name: 'eBay Trending UK',
    url: 'https://www.ebay.co.uk/deals',
    parser: 'ebay_deals'
  }
];

/**
 * Tente de récupérer les tendances depuis les sources web.
 * Mode dégradé : si le scraping échoue, on utilise les données internes.
 *
 * @param {Object} config - Configuration globale (pour http settings)
 * @returns {Object} Données de tendances
 */
async function fetchTrends(config) {
  const trends = {
    fetchedAt: new Date().toISOString(),
    sources: [],
    hotProducts: [],
    errors: []
  };

  for (const source of TREND_SOURCES) {
    try {
      const cacheDir = path.join(config.outputDir, 'cache', 'trends');
      const html = await fetchText(source.url, {
        cacheDir,
        cacheTtlSeconds: 3600 * 6, // cache 6h
        minDelayMs: config.httpMinDelayMs || 900,
        maxDelayMs: config.httpMaxDelayMs || 1600,
        timeoutMs: config.requestTimeoutMs || 60000
      });

      const products = parseTrendPage(html, source.parser);
      trends.sources.push({
        name: source.name,
        url: source.url,
        status: 'success',
        productsFound: products.length
      });
      trends.hotProducts.push(...products);
    } catch (error) {
      trends.sources.push({
        name: source.name,
        url: source.url,
        status: 'error',
        error: error.message
      });
      trends.errors.push(`${source.name}: ${error.message}`);
    }
  }

  // Enrichir avec les tendances internes (connaissances codées en dur)
  trends.hotProducts.push(...getInternalTrends());

  // Dédupliquer
  const seen = new Set();
  trends.hotProducts = trends.hotProducts.filter((p) => {
    const key = p.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return trends;
}

/**
 * Parse une page de deals/trending eBay pour extraire les produits.
 */
function parseTrendPage(html, parserType) {
  const products = [];

  if (parserType === 'ebay_deals') {
    // Extraction basique des titres et prix dans les deals eBay
    const titleRegex = /<span[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/span>/gi;
    const matches = html.matchAll(titleRegex);

    for (const match of matches) {
      const title = match[1].trim();
      if (title.length > 10 && title.length < 200) {
        // Identifier la catégorie potentielle
        const category = identifyCategory(title);
        if (category) {
          products.push({
            name: title,
            source: 'ebay_deals',
            category,
            trendScore: 7
          });
        }
      }
    }
  }

  return products.slice(0, 20); // Limiter à 20 produits par source
}

/**
 * Identifie la catégorie d'un produit d'après son titre.
 */
function identifyCategory(title) {
  const lower = title.toLowerCase();
  const categoryMap = {
    sneakers: ['nike', 'jordan', 'new balance', 'asics', 'adidas', 'puma', 'sneaker', 'dunk'],
    lego: ['lego'],
    vinyl_records: ['vinyle', 'vinyl', 'LP', '33 tours'],
    retro_consoles: ['game boy', 'gameboy', 'nintendo 64', 'n64', 'ps1', 'psp', 'gamecube', 'snes'],
    retro_games: ['jeu retro', 'jeu nintendo', 'retro game'],
    perfumes: ['parfum', 'eau de', 'cologne', 'fragrance'],
    watches: ['montre', 'watch', 'casio', 'swatch', 'seiko', 'g-shock'],
    vintage_clothing: ['vintage', 'ralph lauren', 'burberry', 'north face', 'carhartt'],
    rare_books: ['manga', 'livre', 'edition', 'berserk', 'collector book'],
    figurines: ['funko', 'figurine', 'figure', 'pop!'],
    tech_gadgets: ['airpods', 'clavier', 'keyboard', 'calculatrice', 'ipad', 'kindle']
  };

  for (const [cat, keywords] of Object.entries(categoryMap)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return cat;
    }
  }

  return null;
}

/**
 * Tendances internes basées sur les connaissances du marché.
 * Mises à jour manuellement (saison, sorties, etc.)
 */
function getInternalTrends() {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12

  const trends = [];

  // Tendances saisonnières
  if (month >= 7 && month <= 9) {
    trends.push(
      { name: 'Calculatrices TI (rentrée)', source: 'internal', category: 'tech_gadgets', trendScore: 10 },
      { name: 'Fournitures scolaires premium', source: 'internal', category: 'tech_gadgets', trendScore: 7 }
    );
  }

  if (month === 11 || month === 12) {
    trends.push(
      { name: 'LEGO sets (Noël)', source: 'internal', category: 'lego', trendScore: 10 },
      { name: 'Consoles rétro (cadeaux)', source: 'internal', category: 'retro_consoles', trendScore: 9 },
      { name: 'Funko Pop (cadeaux)', source: 'internal', category: 'figurines', trendScore: 8 }
    );
  }

  if (month >= 3 && month <= 5) {
    trends.push(
      { name: 'Sneakers printemps (Nike Dunk)', source: 'internal', category: 'sneakers', trendScore: 8 },
      { name: 'Vinyles Record Store Day', source: 'internal', category: 'vinyl_records', trendScore: 9 }
    );
  }

  // Tendances permanentes (2025-2026)
  trends.push(
    { name: 'Swatch MoonSwatch', source: 'internal', category: 'watches', trendScore: 8 },
    { name: 'Nike Dunk Low Panda', source: 'internal', category: 'sneakers', trendScore: 7 },
    { name: 'Funko Pop vaultées', source: 'internal', category: 'figurines', trendScore: 8 },
    { name: 'Game Boy Advance SP AGS-101', source: 'internal', category: 'retro_consoles', trendScore: 9 },
    { name: 'Vinyles K-pop limités', source: 'internal', category: 'vinyl_records', trendScore: 8 },
    { name: 'LEGO UCS Star Wars discontinués', source: 'internal', category: 'lego', trendScore: 9 },
    { name: 'Manga Berserk épuisé', source: 'internal', category: 'rare_books', trendScore: 7 },
    { name: 'Ralph Lauren Polo Bear vintage', source: 'internal', category: 'vintage_clothing', trendScore: 7 },
    { name: 'Tom Ford parfums Private Blend', source: 'internal', category: 'perfumes', trendScore: 7 },
    { name: 'Pokémon jeux Game Boy scellés', source: 'internal', category: 'retro_games', trendScore: 10 }
  );

  return trends;
}

// ═══════════════════════════════════════════════════════════════════════
//  5. RAPPORT DE RENTABILITÉ
// ═══════════════════════════════════════════════════════════════════════

/**
 * Génère un rapport complet avec classement des niches.
 *
 * @param {Array} rankedNiches - Résultat de analyzeAllNiches
 * @param {Array} searchConfigs - Résultat de generateSearchConfigs
 * @param {Object} trends - Résultat de fetchTrends
 * @returns {Object} Rapport structuré
 */
function buildReport(rankedNiches, searchConfigs, trends) {
  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalNiches: rankedNiches.length,
      newNiches: rankedNiches.filter((n) => !n.alreadyImplemented).length,
      topCategory: rankedNiches[0]?.label || 'N/A',
      topScore: rankedNiches[0]?.metrics.globalScore || 0,
      avgNetProfit: Math.round(
        rankedNiches
          .filter((n) => !n.alreadyImplemented)
          .reduce((sum, n) => sum + n.metrics.netProfit, 0) /
        Math.max(rankedNiches.filter((n) => !n.alreadyImplemented).length, 1) * 100
      ) / 100,
      trendingProducts: (trends.hotProducts || []).length
    },

    // Classement complet
    ranking: rankedNiches.map((n, i) => ({
      rank: i + 1,
      category: n.category,
      label: n.label,
      score: n.metrics.globalScore,
      netProfit: n.metrics.netProfit,
      netMarginPercent: n.metrics.netMarginPercent,
      grossMarginPercent: n.metrics.grossMarginPercent,
      volumeScore: n.volumeScore,
      counterfeitRisk: n.counterfeitRisk,
      alreadyImplemented: n.alreadyImplemented || false,
      hotItems: n.hotItems.slice(0, 3),
      notes: n.notes
    })),

    // Configs de recherche prêtes à intégrer
    suggestedSearches: searchConfigs,

    // Tendances
    trends: {
      sources: trends.sources,
      topProducts: (trends.hotProducts || [])
        .sort((a, b) => (b.trendScore || 0) - (a.trendScore || 0))
        .slice(0, 15),
      errors: trends.errors
    }
  };

  return report;
}

// ═══════════════════════════════════════════════════════════════════════
//  6. MESSAGE TELEGRAM
// ═══════════════════════════════════════════════════════════════════════

/**
 * Construit le message Telegram de résumé exploration.
 */
function buildExplorerTelegramMessage(report) {
  const lines = [];
  lines.push('=== PRODUCT EXPLORER ===');
  lines.push(`${report.summary.newNiches} nouvelles niches analysees`);
  lines.push('');

  // Top 5 niches (hors TCG déjà implémenté)
  lines.push('--- CLASSEMENT RENTABILITE ---');
  const newNiches = report.ranking.filter((n) => !n.alreadyImplemented);
  for (const niche of newNiches.slice(0, 7)) {
    const star = niche.score >= 50 ? '★' : '☆';
    lines.push(`${star} #${niche.rank} ${niche.label.split(' (')[0]}`);
    lines.push(`   Score: ${niche.score}/100 | Profit net: ~${niche.netProfit} EUR`);
    lines.push(`   Marge nette: ${niche.netMarginPercent}% | Risque contrefacon: ${niche.counterfeitRisk}/10`);
    lines.push(`   Top: ${niche.hotItems[0] || '-'}`);
    lines.push('');
  }

  // Tendances
  const topTrends = report.trends.topProducts.slice(0, 5);
  if (topTrends.length > 0) {
    lines.push('--- TENDANCES ---');
    for (const trend of topTrends) {
      lines.push(`  > ${trend.name} (${trend.category})`);
    }
    lines.push('');
  }

  // Queries suggérées
  if (report.suggestedSearches.length > 0) {
    lines.push('--- QUERIES A AJOUTER ---');
    for (const search of report.suggestedSearches.slice(0, 3)) {
      lines.push(`  ${search.name}: ${search.vintedQueries.slice(0, 3).join(', ')}`);
    }
    lines.push('');
  }

  lines.push(`Genere le ${new Date().toLocaleString('fr-FR')}`);
  lines.push('Voir output/agents/product-explorer-latest.json');

  return lines.join('\n').trim();
}

// ═══════════════════════════════════════════════════════════════════════
//  7. AGENT PRINCIPAL — explore()
// ═══════════════════════════════════════════════════════════════════════

/**
 * Lance l'exploration complète des niches de produits.
 *
 * @param {Object} config - Configuration globale du bot
 * @param {Object} options
 *   - topN {number} - Nombre de catégories à détailler (défaut: 5)
 *   - fetchTrendsEnabled {boolean} - Activer la veille web (défaut: true)
 *   - sendTelegram {boolean} - Envoyer le résumé Telegram (défaut: true)
 * @returns {Object} Rapport d'exploration
 */
async function explore(config, options = {}) {
  const {
    topN = 5,
    fetchTrendsEnabled = true,
    sendTelegram = true
  } = options;

  const startTime = Date.now();
  console.log('\n========================================');
  console.log('  PRODUCT EXPLORER — Analyse de niches');
  console.log('========================================\n');

  // 1. Analyser toutes les niches
  console.log('[Explorer] Analyse de rentabilité des niches...');
  const rankedNiches = analyzeAllNiches(NICHE_DATABASE);
  console.log(`[Explorer] ${rankedNiches.length} niches analysées et classées.`);

  // 2. Générer les configs de recherche pour le bot
  console.log(`[Explorer] Génération des configs pour le top ${topN}...`);
  const searchConfigs = generateSearchConfigs(rankedNiches, topN);
  console.log(`[Explorer] ${searchConfigs.length} configs de recherche générées.`);

  // 3. Veille tendances
  let trends = { sources: [], hotProducts: [], errors: [] };
  if (fetchTrendsEnabled) {
    console.log('[Explorer] Veille tendances en cours...');
    try {
      trends = await fetchTrends(config);
      console.log(`[Explorer] ${trends.hotProducts.length} produits tendance détectés.`);
    } catch (error) {
      console.error(`[Explorer] Erreur veille tendances: ${error.message}`);
      trends.errors.push(error.message);
      // Fallback sur tendances internes uniquement
      trends.hotProducts = getInternalTrends();
    }
  } else {
    trends.hotProducts = getInternalTrends();
  }

  // 4. Construire le rapport
  console.log('[Explorer] Construction du rapport...');
  const report = buildReport(rankedNiches, searchConfigs, trends);
  report.durationMs = Date.now() - startTime;

  // 5. Sauvegarder le rapport
  const resultsDir = path.join(config.outputDir, 'agents');
  await fs.promises.mkdir(resultsDir, { recursive: true });
  const reportPath = path.join(resultsDir, 'product-explorer-latest.json');
  await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`[Explorer] Rapport sauvegardé: ${reportPath}`);

  // 6. Notification Telegram
  if (sendTelegram && config.telegram.token && config.telegram.chatId) {
    try {
      const message = buildExplorerTelegramMessage(report);
      await sendTelegramMessage(config.telegram, message);
      report.telegramSent = true;
      console.log('[Explorer] Notification Telegram envoyée.');
    } catch (error) {
      console.error(`[Explorer] Erreur Telegram: ${error.message}`);
      report.telegramSent = false;
      report.telegramError = error.message;
    }
  }

  // 7. Résumé console
  console.log('\n========================================');
  console.log('  EXPLORATION TERMINEE');
  console.log(`  Durée: ${report.durationMs}ms`);
  console.log(`  Niches: ${report.summary.totalNiches} (${report.summary.newNiches} nouvelles)`);
  console.log(`  Top: ${report.summary.topCategory} (score ${report.summary.topScore}/100)`);
  console.log(`  Profit net moyen: ${report.summary.avgNetProfit} EUR`);
  console.log(`  Tendances: ${report.summary.trendingProducts} produits`);
  console.log(`  Configs générées: ${searchConfigs.length}`);
  console.log('========================================\n');

  return report;
}

// ═══════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
  explore,
  analyzeAllNiches,
  generateSearchConfigs,
  fetchTrends,
  buildReport,
  buildExplorerTelegramMessage,
  NICHE_DATABASE,
  getInternalTrends,
  identifyCategory
};
