/**
 * Agent Discovery v2 — Moteur multi-catégories pour l'arbitrage Vinted → eBay.
 *
 * Refonte complète : ne se limite plus aux cartes TCG.
 * Explore des catégories de produits complètes pour atteindre 5000€/mois net.
 *
 * Responsabilités :
 *   1. Analyser les opportunités passées (patterns historiques)
 *   2. Base de connaissances multi-catégories (sneakers, LEGO, vinyles, etc.)
 *   3. Analyse de rentabilité par catégorie (marge nette, volume, risque)
 *   4. Générer des queries Vinted prêtes à copier-coller par catégorie
 *   5. Estimation de profit mensuel par catégorie
 *   6. Recommandations top 5 catégories à ajouter
 *   7. Veille tendances saisonnières
 *   8. Rapport enrichi pour le dashboard
 *   9. Notification Telegram avec résumé actionnable
 */

const fs = require('fs');
const path = require('path');
const { fetchText } = require('../http');
const { extractCardSignature } = require('../matching');
const { median } = require('../utils');
const { sendTelegramMessage } = require('../notifier');

// ═══════════════════════════════════════════════════════════════════════
//  1. BASE DE CONNAISSANCES — TOUTES CATÉGORIES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Chaque catégorie contient :
 *   - category : identifiant unique
 *   - label : nom lisible
 *   - emoji : pour le dashboard et Telegram
 *   - avgBuyPrice : prix d'achat moyen Vinted (EUR)
 *   - avgSellPrice : prix de revente moyen eBay (EUR)
 *   - volumeScore : 1-10 (combien d'annonces dispo par jour)
 *   - sourcingEase : 1-10 (facilité à trouver des deals)
 *   - counterfeitRisk : 1-10 (10 = très risqué)
 *   - shippingDifficulty : 1-10 (10 = fragile/volumineux)
 *   - keywords : mots-clés de détection
 *   - vintedQueries : queries Vinted prêtes à l'emploi (FR)
 *   - priceRange : { min, max } filtre prix Vinted
 *   - hotItems : sous-catégories les plus rentables
 *   - seasonality : mois de pic (1-12) ou null si permanent
 *   - notes : remarques pour l'arbitragiste
 *   - alreadyImplemented : true si déjà actif dans le bot
 */
const CATEGORY_DATABASE = [
  // ── Cartes TCG (déjà implémenté — référence) ─────────────────────
  {
    category: 'tcg_cards',
    label: 'Cartes TCG',
    emoji: '🃏',
    avgBuyPrice: 8,
    avgSellPrice: 22,
    volumeScore: 9,
    sourcingEase: 8,
    counterfeitRisk: 5,
    shippingDifficulty: 1,
    keywords: ['pokemon', 'yugioh', 'one piece', 'magic', 'topps', 'panini'],
    vintedQueries: [
      'pokemon carte rare illustration',
      'pokemon SIR carte',
      'yugioh starlight rare',
      'one piece alt art carte',
      'panini silver prizm',
      'topps refractor chrome'
    ],
    priceRange: { min: 2, max: 150 },
    hotItems: [
      'Illustration Rare Pokémon', 'Starlight Rare Yu-Gi-Oh',
      'Alt Art One Piece', 'Silver Prizm Panini', 'Refractor Topps'
    ],
    seasonality: null,
    notes: 'Déjà couvert par le bot. Référence de comparaison.',
    alreadyImplemented: true
  },

  // ── Sneakers ──────────────────────────────────────────────────────
  {
    category: 'sneakers',
    label: 'Sneakers',
    emoji: '👟',
    avgBuyPrice: 55,
    avgSellPrice: 110,
    volumeScore: 9,
    sourcingEase: 7,
    counterfeitRisk: 8,
    shippingDifficulty: 3,
    keywords: ['nike dunk', 'jordan', 'new balance 550', 'asics gel', 'yeezy', 'adidas samba'],
    vintedQueries: [
      'nike dunk low neuf',
      'nike dunk low homme neuf',
      'jordan 1 retro neuf',
      'jordan 4 retro neuf',
      'new balance 550 neuf',
      'asics gel kayano neuf',
      'asics gel lyte III',
      'adidas samba OG neuf',
      'nike air max 1 neuf',
      'jordan 3 retro neuf'
    ],
    priceRange: { min: 30, max: 200 },
    hotItems: [
      'Nike Dunk Low coloris exclusifs', 'Jordan 1 Mid/High collab',
      'New Balance 550 coloris limités', 'Asics Gel-Lyte III collab',
      'Nike Air Max 1 collabs (Patta, Travis Scott)'
    ],
    seasonality: [3, 4, 5, 9, 10],
    notes: 'Attention contrefaçons. Vérifier boîte + étiquette + pointure. Marge excellente sur collabs.'
  },

  // ── LEGO ──────────────────────────────────────────────────────────
  {
    category: 'lego',
    label: 'LEGO',
    emoji: '🧱',
    avgBuyPrice: 25,
    avgSellPrice: 55,
    volumeScore: 7,
    sourcingEase: 6,
    counterfeitRisk: 3,
    shippingDifficulty: 5,
    keywords: ['lego', 'lego star wars', 'lego technic', 'lego city', 'lego creator', 'minifig'],
    vintedQueries: [
      'lego star wars set complet',
      'lego technic neuf scellé',
      'lego creator expert neuf',
      'lego architecture neuf',
      'lego minifigure rare',
      'lego harry potter set complet',
      'lego icons neuf',
      'lego ideas neuf scellé',
      'lego ninjago set complet',
      'lego lot minifigures'
    ],
    priceRange: { min: 10, max: 300 },
    hotItems: [
      'Sets Star Wars UCS discontinués', 'Minifigs rares (Cloud City Boba Fett)',
      'Creator Expert modulaires scellés', 'Ideas sets épuisés', 'Technic grands modèles'
    ],
    seasonality: [11, 12, 1],
    notes: 'Sets scellés valent 2-3x plus. Vérifier si complet (pièces + notice). Envoi volumineux.'
  },

  // ── Vinyles ───────────────────────────────────────────────────────
  {
    category: 'vinyl_records',
    label: 'Vinyles',
    emoji: '🎵',
    avgBuyPrice: 12,
    avgSellPrice: 35,
    volumeScore: 8,
    sourcingEase: 7,
    counterfeitRisk: 2,
    shippingDifficulty: 4,
    keywords: ['vinyle', 'vinyl', 'LP', '33 tours', 'pressage limité', 'picture disc'],
    vintedQueries: [
      'vinyle collector neuf scellé',
      'vinyle édition limitée',
      'vinyle picture disc',
      'vinyle couleur limité neuf',
      'vinyl record sealed',
      'vinyle rap français limité',
      'vinyle rock collector',
      'vinyle K-pop neuf',
      'vinyle Taylor Swift variante',
      'vinyle Daft Punk'
    ],
    priceRange: { min: 5, max: 150 },
    hotItems: [
      'Pressages colorés limités', 'Vinyles K-pop (BTS, Stray Kids)',
      'Rap FR éditions limitées (PNL, SCH)', 'Picture discs collector',
      'Premiers pressages rock 70-80s', 'Taylor Swift variantes exclusives'
    ],
    seasonality: [4, 11, 12],
    notes: 'Vérifier état vinyle + pochette (VG+, NM). Scellés = prix x2-3. Record Store Day en avril.'
  },

  // ── Jeux vidéo rétro ──────────────────────────────────────────────
  {
    category: 'retro_games',
    label: 'Jeux vidéo rétro',
    emoji: '🎮',
    avgBuyPrice: 15,
    avgSellPrice: 40,
    volumeScore: 7,
    sourcingEase: 6,
    counterfeitRisk: 4,
    shippingDifficulty: 2,
    keywords: ['jeu retro', 'jeu game boy', 'jeu n64', 'jeu PS1', 'CIB', 'game boy'],
    vintedQueries: [
      'jeu game boy complet boite',
      'jeu nintendo 64 complet',
      'jeu PS1 complet notice',
      'jeu super nintendo complet',
      'jeu GBA complet boite',
      'zelda game boy jeu',
      'pokemon game boy jeu complet',
      'mario nintendo 64 jeu',
      'final fantasy PS1 complet',
      'jeu gamecube complet'
    ],
    priceRange: { min: 5, max: 150 },
    hotItems: [
      'Pokémon versions GBC/GBA CIB', 'Zelda tous supports CIB',
      'Mario Kart 64 CIB', 'Final Fantasy PS1 complets',
      'Jeux scellés (sealed) toutes plateformes'
    ],
    seasonality: null,
    notes: 'CIB (Complete In Box) vaut 2-5x le jeu loose. Contrefaçons GBA courantes : vérifier label.'
  },

  // ── Figurines ─────────────────────────────────────────────────────
  {
    category: 'figurines',
    label: 'Figurines',
    emoji: '🗿',
    avgBuyPrice: 12,
    avgSellPrice: 30,
    volumeScore: 8,
    sourcingEase: 7,
    counterfeitRisk: 4,
    shippingDifficulty: 5,
    keywords: ['funko pop', 'figurine', 'figure', 'star wars', 'dragon ball', 'one piece', 'anime'],
    vintedQueries: [
      'funko pop rare neuf',
      'funko pop exclusive convention',
      'funko pop chase',
      'figurine dragon ball Ichiban',
      'figurine one piece collector',
      'figurine star wars vintage',
      'figurine anime collector neuf',
      'figurine naruto Bandai',
      'funko pop marvel exclusive',
      'figurine Bandai SH Figuarts'
    ],
    priceRange: { min: 5, max: 150 },
    hotItems: [
      'Funko Pop Chase / Exclusive / Convention', 'Dragon Ball Ichiban Kuji',
      'Star Wars Black Series vintage', 'One Piece Portrait of Pirates',
      'Funko Pop vaultées (arrêtées)', 'Bandai SH Figuarts'
    ],
    seasonality: [11, 12],
    notes: 'Funko Pop "vaultées" (arrêtées) prennent de la valeur. Boîte bon état = +50% valeur.'
  },

  // ── Tech / Gadgets ────────────────────────────────────────────────
  {
    category: 'tech_gadgets',
    label: 'Tech & Gadgets',
    emoji: '🎧',
    avgBuyPrice: 30,
    avgSellPrice: 65,
    volumeScore: 7,
    sourcingEase: 6,
    counterfeitRisk: 6,
    shippingDifficulty: 3,
    keywords: ['airpods', 'clavier mécanique', 'calculatrice', 'TI-83', 'ipad', 'apple'],
    vintedQueries: [
      'airpods pro neuf scellé',
      'airpods 3 neuf',
      'clavier mécanique neuf',
      'calculatrice TI-83 plus',
      'calculatrice TI-84',
      'calculatrice casio graph 35',
      'apple watch occasion bon état',
      'ipad occasion bon état',
      'kindle paperwhite occasion',
      'sony WH-1000XM casque'
    ],
    priceRange: { min: 15, max: 300 },
    hotItems: [
      'AirPods Pro (occasion bon état)', 'Calculatrices TI-83/84 (rentrée)',
      'Claviers mécaniques customs', 'Kindle Paperwhite occasion',
      'Apple Watch occasion', 'Casques Sony WH-1000XM'
    ],
    seasonality: [7, 8, 9],
    notes: 'Calculatrices TI = goldmine rentrée (juil-sept). AirPods : vérifier authenticité + S/N.'
  },

  // ── Vêtements vintage ─────────────────────────────────────────────
  {
    category: 'vintage_clothing',
    label: 'Vêtements vintage',
    emoji: '👕',
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
      'nike vintage sweat swoosh',
      'adidas vintage veste 3 bandes',
      'lacoste vintage pull',
      'tommy hilfiger vintage sweat',
      'stussy vintage tee',
      'ralph lauren bear sweat'
    ],
    priceRange: { min: 5, max: 150 },
    hotItems: [
      'TNF Nuptse 700', 'Ralph Lauren Polo Bear sweat',
      'Burberry écharpes Nova Check', 'Carhartt WIP vestes Detroit',
      'Nike vintage swoosh center', 'Adidas vintage 3 bandes'
    ],
    seasonality: [9, 10, 11],
    notes: 'Volume énorme sur Vinted. Marges plus faibles mais très régulières. Vérifier authenticité étiquettes.'
  },

  // ── Parfums ───────────────────────────────────────────────────────
  {
    category: 'perfumes',
    label: 'Parfums',
    emoji: '🧴',
    avgBuyPrice: 25,
    avgSellPrice: 55,
    volumeScore: 7,
    sourcingEase: 6,
    counterfeitRisk: 7,
    shippingDifficulty: 5,
    keywords: ['parfum', 'eau de parfum', 'cologne', 'tom ford', 'dior', 'chanel'],
    vintedQueries: [
      'parfum tom ford neuf',
      'parfum creed aventus neuf',
      'parfum dior sauvage neuf',
      'parfum baccarat rouge 540',
      'parfum discontinué rare',
      'parfum niche rare neuf',
      'parfum maison francis kurkdjian',
      'parfum le labo neuf',
      'parfum amouage neuf',
      'parfum byredo neuf'
    ],
    priceRange: { min: 15, max: 200 },
    hotItems: [
      'Tom Ford Private Blend', 'Creed Aventus / Green Irish Tweed',
      'MFK Baccarat Rouge 540', 'Parfums discontinués (Dior, YSL)',
      'Le Labo Santal 33', 'Amouage Interlude'
    ],
    seasonality: [11, 12, 2],
    notes: 'Risque contrefaçon élevé. Vérifier batch code + packaging + code barre. Envoi fragile.'
  },

  // ── Montres ───────────────────────────────────────────────────────
  {
    category: 'watches',
    label: 'Montres',
    emoji: '⌚',
    avgBuyPrice: 20,
    avgSellPrice: 50,
    volumeScore: 7,
    sourcingEase: 6,
    counterfeitRisk: 5,
    shippingDifficulty: 3,
    keywords: ['casio', 'swatch', 'seiko', 'montre vintage', 'G-Shock'],
    vintedQueries: [
      'casio vintage montre dorée',
      'casio G-Shock neuf',
      'swatch montre vintage',
      'swatch moonswatch neuf',
      'seiko 5 automatique',
      'seiko presage montre',
      'casio A168 doré neuf',
      'montre vintage homme',
      'G-Shock limited edition',
      'swatch collector rare'
    ],
    priceRange: { min: 10, max: 200 },
    hotItems: [
      'Casio Vintage dorées (A168, A700)', 'G-Shock Casioak GA-2100',
      'Swatch X Omega MoonSwatch', 'Swatch vintage 80-90s',
      'Seiko 5 Sports', 'Casio éditions limitées'
    ],
    seasonality: [11, 12, 2, 6],
    notes: 'Casio vintage dorées = excellent ratio marge/facilité. MoonSwatch très demandées à l\'international.'
  },

  // ── Livres & Mangas ───────────────────────────────────────────────
  {
    category: 'rare_books',
    label: 'Livres & Mangas',
    emoji: '📚',
    avgBuyPrice: 8,
    avgSellPrice: 25,
    volumeScore: 6,
    sourcingEase: 5,
    counterfeitRisk: 1,
    shippingDifficulty: 3,
    keywords: ['manga', 'première édition', 'collector', 'berserk', 'one piece', 'naruto'],
    vintedQueries: [
      'manga collector édition limitée',
      'berserk manga lot complet',
      'one piece manga lot',
      'dragon ball manga première édition',
      'naruto manga lot complet',
      'manga rare épuisé',
      'manga edition originale glénat',
      'livre première édition',
      'coffret manga collector',
      'manga perfect edition neuf'
    ],
    priceRange: { min: 3, max: 200 },
    hotItems: [
      'Berserk édition originale Glénat', 'Dragon Ball première édition',
      'Coffrets manga collector', 'Manga épuisés/out of print',
      'Light novels collector', 'Artbooks limités'
    ],
    seasonality: [12, 1],
    notes: 'Lots complets de séries populaires se vendent très bien. Premières éditions Glénat recherchées.'
  },

  // ── Consoles rétro ────────────────────────────────────────────────
  {
    category: 'retro_consoles',
    label: 'Consoles rétro',
    emoji: '🕹️',
    avgBuyPrice: 35,
    avgSellPrice: 75,
    volumeScore: 6,
    sourcingEase: 5,
    counterfeitRisk: 2,
    shippingDifficulty: 4,
    keywords: ['game boy', 'gameboy', 'nintendo 64', 'n64', 'ps1', 'psp', 'gamecube', 'snes'],
    vintedQueries: [
      'game boy color console',
      'game boy advance SP',
      'nintendo 64 console lot',
      'PSP console lot jeux',
      'PS1 console lot jeux',
      'game boy pocket console',
      'nintendo DS lite console',
      'super nintendo console',
      'gamecube console manette',
      'sega mega drive console'
    ],
    priceRange: { min: 15, max: 200 },
    hotItems: [
      'Game Boy Micro', 'Game Boy Advance SP AGS-101',
      'N64 + manettes + jeux', 'PSP éditions limitées',
      'GameCube avec manettes', 'PS1 lot complet'
    ],
    seasonality: null,
    notes: 'Tester fonctionnement. Lots (console + jeux + accessoires) se vendent mieux. Marché international.'
  }
];

// ── Calendrier TCG (conservé pour les suggestions de nouvelles sorties) ──

const TCG_RELEASE_CALENDAR = {
  pokemon: {
    recentSets: [
      { name: 'Prismatic Evolutions', date: '2025-01', hype: 'very_high' },
      { name: 'Journey Together', date: '2025-03', hype: 'high' },
      { name: 'Destinees de Paldea', date: '2025-06', hype: 'medium' },
      { name: 'Surging Sparks', date: '2024-11', hype: 'high' }
    ],
    hotCards: ['illustration rare', 'SIR', 'SAR', 'art rare', 'full art', 'gold'],
    queryTemplates: ['pokemon {set} carte rare', 'pokemon {set} illustration rare', 'pokemon {set} SIR']
  },
  onepiece: {
    recentSets: [
      { name: 'OP13', date: '2025-03', hype: 'very_high' },
      { name: 'OP09', date: '2024-12', hype: 'high' }
    ],
    hotCards: ['leader', 'alt art', 'manga rare', 'secret rare', 'SP card'],
    queryTemplates: ['one piece {set} alt art', 'one piece {set} leader', 'one piece {set} carte rare']
  },
  yugioh: {
    recentSets: [
      { name: 'BLCR', date: '2024-11', hype: 'very_high' },
      { name: 'AGOV', date: '2024-10', hype: 'medium' }
    ],
    hotCards: ['starlight rare', 'quarter century secret rare', 'ghost rare', 'ultimate rare'],
    queryTemplates: ['yugioh {set} starlight', 'yugioh {set} secret rare']
  }
};

// ═══════════════════════════════════════════════════════════════════════
//  2. ANALYSE DE RENTABILITÉ
// ═══════════════════════════════════════════════════════════════════════

/**
 * Calcule le score de rentabilité et le profit mensuel estimé pour chaque catégorie.
 *
 * Score composite (0-100) :
 *   grossMargin (30%) + volume (20%) + sourcingEase (20%)
 *   - counterfeitRisk (15%) - shippingDifficulty (15%)
 *
 * Estimation profit mensuel :
 *   netProfit × dealsParJour × 30 jours
 */
function analyzeAllCategories(categories, currentBudget = 500) {
  const results = [];

  for (const cat of categories) {
    // Vérifier si le prix d'achat est compatible avec le budget actuel
    if (cat.avgBuyPrice > currentBudget * 0.4) continue; // Max 40% du budget par achat

    const grossMargin = cat.avgSellPrice - cat.avgBuyPrice;
    const grossMarginPercent = cat.avgBuyPrice > 0
      ? Math.round((grossMargin / cat.avgBuyPrice) * 100)
      : 0;

    // Frais détaillés
    const ebayFees = cat.avgSellPrice * 0.13;
    const paymentFees = cat.avgSellPrice * 0.03;
    const shippingOut = 4.50;
    const shippingIn = 3.50;
    const totalCost = cat.avgBuyPrice + shippingIn;
    const netRevenue = cat.avgSellPrice - ebayFees - paymentFees - shippingOut;
    const netProfit = netRevenue - totalCost;
    const netMarginPercent = totalCost > 0
      ? Math.round((netProfit / totalCost) * 100)
      : 0;

    // Score composite (0-100)
    const marginScore = Math.min(grossMarginPercent / 2, 30);
    const volumePoints = (cat.volumeScore / 10) * 20;
    const sourcingPoints = (cat.sourcingEase / 10) * 20;
    const riskPenalty = (cat.counterfeitRisk / 10) * 15;
    const shippingPenalty = (cat.shippingDifficulty / 10) * 15;
    const globalScore = Math.round(
      marginScore + volumePoints + sourcingPoints - riskPenalty - shippingPenalty
    );

    // Estimation deals par jour (basé sur volume et sourcing)
    const dealsPerDay = Math.max(0.5, Math.round((cat.volumeScore * cat.sourcingEase / 30) * 10) / 10);
    const monthlyProfit = Math.round(netProfit * dealsPerDay * 30 * 100) / 100;
    const monthlyVolume = Math.round(dealsPerDay * 30);

    // Bonus saisonnier
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const isInSeason = cat.seasonality
      ? cat.seasonality.includes(currentMonth)
      : true;

    results.push({
      ...cat,
      metrics: {
        grossMargin: Math.round(grossMargin * 100) / 100,
        grossMarginPercent,
        ebayFees: Math.round(ebayFees * 100) / 100,
        paymentFees: Math.round(paymentFees * 100) / 100,
        shippingOut,
        shippingIn,
        totalCost: Math.round(totalCost * 100) / 100,
        netRevenue: Math.round(netRevenue * 100) / 100,
        netProfit: Math.round(netProfit * 100) / 100,
        netMarginPercent,
        globalScore: Math.max(0, Math.min(100, globalScore)),
        dealsPerDay,
        monthlyVolume,
        monthlyProfit,
        isInSeason,
        seasonBonus: isInSeason ? '+20%' : 'hors saison'
      }
    });
  }

  // Trier par score décroissant
  results.sort((a, b) => b.metrics.globalScore - a.metrics.globalScore);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  3. ANALYSE DES PATTERNS HISTORIQUES (conservé de v1)
// ═══════════════════════════════════════════════════════════════════════

function analyzeHistoricalPatterns(scanData) {
  const opportunities = scanData.opportunities || [];
  const allListings = scanData.searchedListings || [];

  const bySearch = new Map();
  for (const opp of opportunities) {
    const search = opp.search || 'unknown';
    if (!bySearch.has(search)) bySearch.set(search, []);
    bySearch.get(search).push(opp);
  }

  const patterns = [];
  for (const [searchName, opps] of bySearch) {
    const profits = opps
      .filter((o) => o.profit && o.profit.profit > 0)
      .map((o) => o.profit.profit);

    const totalListings = allListings.filter((l) => l.search === searchName).length;
    const hitRate = totalListings > 0 ? opps.length / totalListings : 0;

    patterns.push({
      searchName,
      opportunityCount: opps.length,
      totalScanned: totalListings,
      hitRate: Math.round(hitRate * 100) / 100,
      avgProfit: profits.length > 0
        ? Math.round(profits.reduce((a, b) => a + b, 0) / profits.length * 100) / 100
        : 0,
      medianProfit: profits.length > 0 ? Math.round(median(profits) * 100) / 100 : 0,
      maxProfit: profits.length > 0 ? Math.max(...profits) : 0,
      topKeywords: extractTopKeywords(opps)
    });
  }

  patterns.sort((a, b) => (b.avgProfit * b.hitRate) - (a.avgProfit * a.hitRate));

  return {
    patterns,
    totalOpportunities: opportunities.length,
    totalScanned: allListings.length,
    overallHitRate: allListings.length > 0
      ? Math.round(opportunities.length / allListings.length * 10000) / 100
      : 0,
    analyzedAt: new Date().toISOString()
  };
}

function extractTopKeywords(opportunities) {
  const wordCount = new Map();
  const stopWords = new Set([
    'carte', 'card', 'cards', 'cartes', 'lot', 'set', 'rare',
    'neuf', 'new', 'the', 'de', 'du', 'le', 'la', 'les', 'des',
    'for', 'and', 'with', 'from'
  ]);

  for (const opp of opportunities) {
    const sig = extractCardSignature(opp.title || '');
    for (const token of sig.specificTokens) {
      if (!stopWords.has(token) && token.length >= 3) {
        wordCount.set(token, (wordCount.get(token) || 0) + 1);
      }
    }
    for (const token of sig.identityTokens) {
      wordCount.set(token, (wordCount.get(token) || 0) + 2);
    }
  }

  return [...wordCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));
}

// ═══════════════════════════════════════════════════════════════════════
//  4. GÉNÉRATEUR DE SUGGESTIONS MULTI-CATÉGORIES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Génère des suggestions :
 *   - Nouvelles catégories de produits à explorer
 *   - Nouvelles sorties TCG
 *   - Queries basées sur keywords performants
 *   - Alertes niches sous-performantes
 */
function generateSuggestions(historicalAnalysis, rankedCategories, currentSearches) {
  const suggestions = [];

  // ── 1. Suggestions multi-catégories (TOP 5 à ajouter) ──
  const newCategories = rankedCategories
    .filter((c) => !c.alreadyImplemented && c.metrics.netProfit > 0);

  for (const cat of newCategories.slice(0, 7)) {
    const alreadyCovered = currentSearches.some((s) =>
      cat.keywords.some((kw) =>
        s.vintedQueries && s.vintedQueries.some((q) => q.toLowerCase().includes(kw))
      )
    );

    suggestions.push({
      type: 'new_category',
      priority: cat.metrics.globalScore >= 50 ? 'high' : 'medium',
      category: cat.category,
      label: cat.label,
      emoji: cat.emoji,
      reason: alreadyCovered
        ? `${cat.label} partiellement couvert — enrichir les queries`
        : `Nouvelle catégorie rentable à ajouter`,
      suggestedQueries: cat.vintedQueries,
      priceRange: cat.priceRange,
      metrics: {
        score: cat.metrics.globalScore,
        netProfit: cat.metrics.netProfit,
        netMarginPercent: cat.metrics.netMarginPercent,
        monthlyProfit: cat.metrics.monthlyProfit,
        monthlyVolume: cat.metrics.monthlyVolume,
        isInSeason: cat.metrics.isInSeason
      },
      hotItems: cat.hotItems,
      notes: cat.notes,
      alreadyCovered
    });
  }

  // ── 2. Suggestions basées sur les nouvelles sorties TCG ──
  for (const [universe, data] of Object.entries(TCG_RELEASE_CALENDAR)) {
    const recentHighHype = data.recentSets.filter((s) => {
      const monthsAgo = getMonthsAgo(s.date);
      return monthsAgo <= 4 && (s.hype === 'high' || s.hype === 'very_high');
    });

    for (const set of recentHighHype) {
      const alreadyCovered = currentSearches.some((search) =>
        search.vintedQueries && search.vintedQueries.some((q) =>
          q.toLowerCase().includes(set.name.toLowerCase().split(' ')[0])
        )
      );

      if (!alreadyCovered) {
        const newQueries = data.queryTemplates.map((t) => t.replace('{set}', set.name));
        suggestions.push({
          type: 'new_tcg_set',
          priority: set.hype === 'very_high' ? 'high' : 'medium',
          category: 'tcg_cards',
          label: `TCG — ${universe}`,
          emoji: '🃏',
          reason: `Nouveau set ${set.hype === 'very_high' ? 'très hypé' : 'populaire'}: ${set.name}`,
          suggestedQueries: newQueries,
          setName: set.name,
          releaseDate: set.date
        });
      }
    }
  }

  // ── 3. Suggestions basées sur keywords performants ──
  const performingPatterns = historicalAnalysis.patterns.filter((p) =>
    p.avgProfit >= 5 && p.hitRate >= 0.02
  );
  for (const pattern of performingPatterns) {
    const topWords = pattern.topKeywords.slice(0, 3).map((k) => k.word);
    if (topWords.length >= 2) {
      const currentQueries = currentSearches
        .filter((s) => s.name === pattern.searchName)
        .flatMap((s) => s.vintedQueries || []);

      const possibleNewQueries = generateQueryVariations(topWords, pattern.searchName);
      const newQueries = possibleNewQueries.filter(
        (q) => !currentQueries.some((cq) => cq.toLowerCase() === q.toLowerCase())
      );

      if (newQueries.length > 0) {
        suggestions.push({
          type: 'keyword_expansion',
          priority: pattern.avgProfit >= 10 ? 'high' : 'medium',
          category: 'tcg_cards',
          label: pattern.searchName,
          emoji: '🔍',
          reason: `Mots-clés performants: ${topWords.join(', ')}`,
          suggestedQueries: newQueries.slice(0, 4),
          basedOn: {
            avgProfit: pattern.avgProfit,
            hitRate: pattern.hitRate,
            topKeywords: topWords
          }
        });
      }
    }
  }

  // ── 4. Alertes niches sous-performantes ──
  const underperforming = historicalAnalysis.patterns
    .filter((p) => p.totalScanned >= 20 && p.hitRate < 0.005 && p.opportunityCount === 0);
  for (const p of underperforming) {
    suggestions.push({
      type: 'underperforming_warning',
      priority: 'info',
      category: 'tcg_cards',
      label: p.searchName,
      emoji: '⚠️',
      reason: `0 opportunités sur ${p.totalScanned} scannées — ajuster les filtres`,
      suggestion: 'Vérifier les tokens bloqués et les seuils de prix'
    });
  }

  // Trier par priorité
  const priorityOrder = { high: 0, medium: 1, low: 2, info: 3 };
  suggestions.sort((a, b) => (priorityOrder[a.priority] || 99) - (priorityOrder[b.priority] || 99));

  return suggestions;
}

function generateQueryVariations(keywords, searchName) {
  const variations = [];
  const searchLower = searchName.toLowerCase();

  if (keywords.length >= 2) {
    variations.push(`${keywords[0]} ${keywords[1]} carte`);
    variations.push(`${keywords[0]} ${keywords[1]} rare`);
  }
  if (keywords.length >= 3) {
    variations.push(`${keywords[0]} ${keywords[1]} ${keywords[2]}`);
  }

  for (const kw of keywords) {
    if (searchLower.includes('pokemon')) variations.push(`pokemon ${kw} carte`);
    else if (searchLower.includes('one piece')) variations.push(`one piece ${kw} carte`);
    else if (searchLower.includes('yugioh')) variations.push(`yugioh ${kw} carte`);
    else if (searchLower.includes('topps')) variations.push(`topps ${kw} card`);
    else if (searchLower.includes('panini')) variations.push(`panini ${kw} card`);
  }

  return [...new Set(variations)];
}

function getMonthsAgo(dateStr) {
  const [year, month] = dateStr.split('-').map(Number);
  const now = new Date();
  return (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - month);
}

// ═══════════════════════════════════════════════════════════════════════
//  5. TENDANCES SAISONNIÈRES
// ═══════════════════════════════════════════════════════════════════════

function getSeasonalTrends() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const trends = [];

  if (month >= 7 && month <= 9) {
    trends.push(
      { name: 'Calculatrices TI (rentrée)', category: 'tech_gadgets', trendScore: 10 },
      { name: 'Sacs à dos premium', category: 'vintage_clothing', trendScore: 7 }
    );
  }
  if (month === 11 || month === 12) {
    trends.push(
      { name: 'LEGO sets (Noël)', category: 'lego', trendScore: 10 },
      { name: 'Consoles rétro (cadeaux)', category: 'retro_consoles', trendScore: 9 },
      { name: 'Funko Pop (cadeaux)', category: 'figurines', trendScore: 8 },
      { name: 'Parfums coffrets cadeaux', category: 'perfumes', trendScore: 9 }
    );
  }
  if (month >= 3 && month <= 5) {
    trends.push(
      { name: 'Sneakers printemps (Nike Dunk)', category: 'sneakers', trendScore: 8 },
      { name: 'Vinyles Record Store Day', category: 'vinyl_records', trendScore: 9 }
    );
  }
  if (month >= 1 && month <= 2) {
    trends.push(
      { name: 'Parfums Saint-Valentin', category: 'perfumes', trendScore: 8 },
      { name: 'Montres cadeaux Saint-Valentin', category: 'watches', trendScore: 7 }
    );
  }

  // Tendances permanentes 2025-2026
  trends.push(
    { name: 'Swatch MoonSwatch', category: 'watches', trendScore: 8 },
    { name: 'Nike Dunk Low', category: 'sneakers', trendScore: 7 },
    { name: 'Funko Pop vaultées', category: 'figurines', trendScore: 8 },
    { name: 'Game Boy Advance SP AGS-101', category: 'retro_consoles', trendScore: 9 },
    { name: 'Vinyles K-pop limités', category: 'vinyl_records', trendScore: 8 },
    { name: 'LEGO UCS Star Wars discontinués', category: 'lego', trendScore: 9 },
    { name: 'Manga Berserk épuisé', category: 'rare_books', trendScore: 7 },
    { name: 'Ralph Lauren Polo Bear', category: 'vintage_clothing', trendScore: 7 },
    { name: 'Tom Ford Private Blend', category: 'perfumes', trendScore: 7 },
    { name: 'Pokémon jeux GB scellés', category: 'retro_games', trendScore: 10 }
  );

  return trends;
}

// ═══════════════════════════════════════════════════════════════════════
//  6. DÉTECTION TENDANCES PRIX (conservé de v1)
// ═══════════════════════════════════════════════════════════════════════

function detectPriceTrends(scanData) {
  const allListings = scanData.searchedListings || [];
  const trends = new Map();

  for (const listing of allListings) {
    const key = listing.search || 'unknown';
    if (!trends.has(key)) trends.set(key, { prices: [], dates: [] });
    const group = trends.get(key);
    if (listing.vintedBuyerPrice && listing.lastSeenAt) {
      group.prices.push(listing.vintedBuyerPrice);
      group.dates.push(listing.lastSeenAt);
    }
  }

  const trendResults = [];
  for (const [searchName, data] of trends) {
    if (data.prices.length < 5) continue;
    const avgPrice = data.prices.reduce((a, b) => a + b, 0) / data.prices.length;
    const medianPrice = median(data.prices);
    const sorted = [...data.prices].sort((a, b) => a - b);
    const lowerQuartile = sorted[Math.floor(sorted.length * 0.25)];
    const upperQuartile = sorted[Math.floor(sorted.length * 0.75)];

    trendResults.push({
      searchName,
      sampleSize: data.prices.length,
      avgPrice: Math.round(avgPrice * 100) / 100,
      medianPrice: Math.round(medianPrice * 100) / 100,
      priceRange: {
        min: Math.min(...data.prices),
        max: Math.max(...data.prices),
        lowerQuartile: Math.round(lowerQuartile * 100) / 100,
        upperQuartile: Math.round(upperQuartile * 100) / 100
      }
    });
  }

  return trendResults;
}

// ═══════════════════════════════════════════════════════════════════════
//  7. CONFIGS DE RECHERCHE PRÊTES À INTÉGRER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Génère des configs de recherche compatibles avec config.searches.
 */
function generateSearchConfigs(rankedCategories, topN = 5) {
  const configs = [];
  const newCategories = rankedCategories
    .filter((n) => !n.alreadyImplemented && n.metrics.netProfit > 0)
    .slice(0, topN);

  for (const cat of newCategories) {
    const requiredAnyTokens = cat.keywords.slice(0, 5);
    const blockedTokens = generateBlockedTokens(cat.category);

    configs.push({
      name: cat.label,
      category: cat.category,
      emoji: cat.emoji,
      pricingSource: 'ebay',
      maxPrice: cat.priceRange.max,
      vintedQueries: cat.vintedQueries,
      requiredAnyTokens,
      blockedTokens,
      priceRange: cat.priceRange,
      estimatedMetrics: {
        netProfit: cat.metrics.netProfit,
        netMarginPercent: cat.metrics.netMarginPercent,
        monthlyProfit: cat.metrics.monthlyProfit,
        globalScore: cat.metrics.globalScore
      },
      notes: cat.notes
    });
  }

  return configs;
}

function generateBlockedTokens(category) {
  const commonBlocked = ['cassé', 'broken', 'pièces détachées', 'pour pièces', 'HS', 'ne fonctionne pas'];
  const categoryBlocked = {
    sneakers: ['chaussette', 'semelle seule', 'lacet seul', 'réplique', 'inspired', 'style'],
    lego: ['playmobil', 'mega bloks', 'compatible lego', 'copie', 'type lego'],
    vinyl_records: ['CD', 'cassette', 'MP3', 'poster seul', 'tshirt'],
    retro_consoles: ['coque seule', 'skin', 'sticker', 'housse seule'],
    retro_games: ['repro', 'reproduction', 'custom rom', 'romhack'],
    perfumes: ['échantillon', 'sample', 'miniature 5ml', 'testeur', 'vide', 'flacon vide'],
    watches: ['bracelet seul', 'boitier seul', 'pile seule', 'réplique'],
    vintage_clothing: ['tache', 'troué', 'déchiré', 'réplique', 'style'],
    rare_books: ['photocopie', 'ebook', 'numérique', 'scan'],
    figurines: ['custom', 'print 3d', 'bootleg', 'copie', 'imitation'],
    tech_gadgets: ['coque seule', 'étui seul', 'câble seul', 'chargeur seul', 'réplique']
  };

  return [...commonBlocked, ...(categoryBlocked[category] || [])];
}

// ═══════════════════════════════════════════════════════════════════════
//  8. ESTIMATION OBJECTIF 5000€/MOIS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Calcule un plan pour atteindre l'objectif de 5000€/mois.
 */
function buildObjectivePlan(rankedCategories) {
  const target = 5000;
  let cumulativeMonthly = 0;
  const plan = [];

  const viable = rankedCategories
    .filter((c) => !c.alreadyImplemented && c.metrics.netProfit > 0)
    .sort((a, b) => b.metrics.monthlyProfit - a.metrics.monthlyProfit);

  // Ajouter TCG (déjà implémenté)
  const tcg = rankedCategories.find((c) => c.alreadyImplemented);
  if (tcg) {
    cumulativeMonthly += tcg.metrics.monthlyProfit;
    plan.push({
      category: tcg.label,
      emoji: tcg.emoji,
      monthlyProfit: tcg.metrics.monthlyProfit,
      cumulative: cumulativeMonthly,
      status: 'actif'
    });
  }

  for (const cat of viable) {
    if (cumulativeMonthly >= target) break;
    cumulativeMonthly += cat.metrics.monthlyProfit;
    plan.push({
      category: cat.label,
      emoji: cat.emoji,
      monthlyProfit: cat.metrics.monthlyProfit,
      cumulative: Math.round(cumulativeMonthly * 100) / 100,
      status: 'a_ajouter'
    });
  }

  return {
    targetMonthly: target,
    projectedMonthly: Math.round(cumulativeMonthly * 100) / 100,
    gap: Math.max(0, Math.round((target - cumulativeMonthly) * 100) / 100),
    achievable: cumulativeMonthly >= target,
    categoriesNeeded: plan.filter((p) => p.status === 'a_ajouter').length,
    plan
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  9. MESSAGE TELEGRAM
// ═══════════════════════════════════════════════════════════════════════

function buildDiscoveryTelegramMessage(result) {
  const lines = [];
  lines.push('=== DISCOVERY MULTI-CATEGORIES ===');
  lines.push(`${result.summary.totalCategories} categories analysees`);
  lines.push(`${result.summary.totalSuggestions} suggestions`);
  lines.push('');

  // Objectif 5000€
  if (result.objectivePlan) {
    const plan = result.objectivePlan;
    lines.push('--- OBJECTIF 5000 EUR/MOIS ---');
    lines.push(`Projection: ${plan.projectedMonthly} EUR/mois`);
    lines.push(`${plan.achievable ? 'ATTEIGNABLE' : 'GAP: ' + plan.gap + ' EUR'}`);
    lines.push(`Categories necessaires: ${plan.categoriesNeeded}`);
    lines.push('');

    for (const step of plan.plan.slice(0, 8)) {
      const marker = step.status === 'actif' ? '[OK]' : '[+]';
      lines.push(`${marker} ${step.emoji} ${step.category}: +${step.monthlyProfit} EUR/mois (cumul: ${step.cumulative} EUR)`);
    }
    lines.push('');
  }

  // Top 5 nouvelles catégories
  const newCatSuggestions = (result.suggestions || [])
    .filter((s) => s.type === 'new_category');
  if (newCatSuggestions.length > 0) {
    lines.push('--- TOP CATEGORIES A AJOUTER ---');
    for (const sug of newCatSuggestions.slice(0, 5)) {
      lines.push(`${sug.emoji} ${sug.label} (score ${sug.metrics.score}/100)`);
      lines.push(`  Profit net: ~${sug.metrics.netProfit} EUR/vente`);
      lines.push(`  Estimation mensuelle: ~${sug.metrics.monthlyProfit} EUR/mois`);
      lines.push(`  Marge nette: ${sug.metrics.netMarginPercent}%`);
      lines.push(`  Queries: ${sug.suggestedQueries.slice(0, 3).join(', ')}`);
      lines.push('');
    }
  }

  // Tendances
  const trends = result.seasonalTrends || [];
  if (trends.length > 0) {
    lines.push('--- TENDANCES ACTUELLES ---');
    for (const trend of trends.slice(0, 5)) {
      lines.push(`  > ${trend.name} (${trend.category}) score ${trend.trendScore}/10`);
    }
    lines.push('');
  }

  // TCG suggestions
  const tcgSuggestions = (result.suggestions || [])
    .filter((s) => s.type === 'new_tcg_set')
    .slice(0, 3);
  if (tcgSuggestions.length > 0) {
    lines.push('--- NOUVEAUX SETS TCG ---');
    for (const sug of tcgSuggestions) {
      lines.push(`  ${sug.emoji} ${sug.reason}`);
      lines.push(`    Queries: ${sug.suggestedQueries.slice(0, 2).join(', ')}`);
    }
    lines.push('');
  }

  lines.push(`Genere le ${new Date().toLocaleString('fr-FR')}`);
  lines.push('Dashboard: /api/discovery');

  return lines.join('\n').trim();
}

// ═══════════════════════════════════════════════════════════════════════
//  10. AGENT PRINCIPAL — discover()
// ═══════════════════════════════════════════════════════════════════════

/**
 * Lance l'analyse Discovery complète multi-catégories.
 *
 * @param {Object} config - Configuration globale du bot
 * @param {Object} options
 *   - scanDataPath {string} - Chemin vers latest-scan.json
 *   - currentBudget {number} - Budget actuel (défaut: 500)
 *   - topN {number} - Nombre de catégories top à détailler (défaut: 5)
 *   - sendTelegram {boolean} - Envoyer résumé Telegram (défaut: true)
 * @returns {Object} Résultat complet de l'analyse Discovery
 */
async function discover(config, options = {}) {
  // DISABLED 2026-03-22: spammait Telegram toutes les 10 min — tué complètement
  return null;

  const {
    currentBudget = 500,
    topN = 5,
    sendTelegram = true
  } = options;

  const startTime = Date.now();
  console.log('\n========================================');
  console.log('  DISCOVERY v2 — Multi-catégories');
  console.log('========================================\n');

  // 1. Charger les données du dernier scan
  const scanDataPath = options.scanDataPath ||
    path.join(config.outputDir, 'latest-scan.json');

  let scanData = { opportunities: [], searchedListings: [] };
  try {
    if (fs.existsSync(scanDataPath)) {
      scanData = JSON.parse(fs.readFileSync(scanDataPath, 'utf8'));
    }
  } catch (error) {
    console.log(`[Discovery] Pas de données historiques: ${error.message}`);
  }

  // 2. Analyser les patterns historiques (TCG)
  console.log('[Discovery] Analyse des patterns historiques...');
  const historicalPatterns = analyzeHistoricalPatterns(scanData);

  // 3. Analyser TOUTES les catégories de produits
  console.log('[Discovery] Analyse de rentabilité multi-catégories...');
  const rankedCategories = analyzeAllCategories(CATEGORY_DATABASE, currentBudget);
  console.log(`[Discovery] ${rankedCategories.length} catégories analysées et classées.`);

  // 4. Détecter les tendances de prix
  console.log('[Discovery] Détection des tendances de prix...');
  const priceTrends = detectPriceTrends(scanData);

  // 5. Tendances saisonnières
  console.log('[Discovery] Analyse des tendances saisonnières...');
  const seasonalTrends = getSeasonalTrends();

  // 6. Générer les suggestions multi-catégories
  console.log('[Discovery] Génération des suggestions multi-catégories...');
  const suggestions = generateSuggestions(historicalPatterns, rankedCategories, config.searches || []);

  // 7. Configs de recherche prêtes à intégrer
  console.log(`[Discovery] Génération des configs pour le top ${topN}...`);
  const searchConfigs = generateSearchConfigs(rankedCategories, topN);

  // 8. Plan objectif 5000€/mois
  console.log('[Discovery] Calcul du plan objectif 5000 EUR/mois...');
  const objectivePlan = buildObjectivePlan(rankedCategories);

  // Construire le résultat
  const result = {
    // Patterns historiques TCG
    historicalPatterns,
    priceTrends,

    // Multi-catégories
    ranking: rankedCategories.map((c, i) => ({
      rank: i + 1,
      category: c.category,
      label: c.label,
      emoji: c.emoji,
      score: c.metrics.globalScore,
      netProfit: c.metrics.netProfit,
      netMarginPercent: c.metrics.netMarginPercent,
      grossMarginPercent: c.metrics.grossMarginPercent,
      monthlyProfit: c.metrics.monthlyProfit,
      monthlyVolume: c.metrics.monthlyVolume,
      dealsPerDay: c.metrics.dealsPerDay,
      volumeScore: c.volumeScore,
      counterfeitRisk: c.counterfeitRisk,
      isInSeason: c.metrics.isInSeason,
      alreadyImplemented: c.alreadyImplemented || false,
      hotItems: c.hotItems.slice(0, 3),
      vintedQueries: c.vintedQueries,
      priceRange: c.priceRange,
      notes: c.notes
    })),

    // Suggestions
    suggestions,

    // Configs de recherche prêtes à copier-coller
    suggestedSearches: searchConfigs,

    // Tendances
    seasonalTrends: seasonalTrends
      .sort((a, b) => (b.trendScore || 0) - (a.trendScore || 0))
      .slice(0, 15),

    // Plan objectif
    objectivePlan,

    // Méta
    discoveredAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,

    // Résumé
    summary: {
      totalCategories: rankedCategories.length,
      newCategories: rankedCategories.filter((c) => !c.alreadyImplemented).length,
      totalSuggestions: suggestions.length,
      highPriority: suggestions.filter((s) => s.priority === 'high').length,
      mediumPriority: suggestions.filter((s) => s.priority === 'medium').length,
      lowPriority: suggestions.filter((s) => s.priority === 'low').length,
      warnings: suggestions.filter((s) => s.type === 'underperforming_warning').length,
      topCategory: rankedCategories.length > 0 ? rankedCategories[0].label : 'N/A',
      topScore: rankedCategories.length > 0 ? rankedCategories[0].metrics.globalScore : 0,
      projectedMonthly: objectivePlan.projectedMonthly,
      objectiveAchievable: objectivePlan.achievable,
      topPerformingNiche: historicalPatterns.patterns.length > 0
        ? historicalPatterns.patterns[0].searchName
        : 'N/A'
    }
  };

  // Sauvegarder
  const resultsDir = path.join(config.outputDir, 'agents');
  await fs.promises.mkdir(resultsDir, { recursive: true });
  const reportPath = path.join(resultsDir, 'discovery-latest.json');
  await fs.promises.writeFile(reportPath, JSON.stringify(result, null, 2));
  console.log(`[Discovery] Rapport sauvegardé: ${reportPath}`);

  // Notification Telegram
  if (sendTelegram && config.telegram && config.telegram.token && config.telegram.chatId) {
    try {
      const message = buildDiscoveryTelegramMessage(result);
      await sendTelegramMessage(config.telegram, message);
      result.telegramSent = true;
      console.log('[Discovery] Notification Telegram envoyée.');
    } catch (error) {
      console.error(`[Discovery] Erreur Telegram: ${error.message}`);
      result.telegramSent = false;
      result.telegramError = error.message;
    }
  }

  // Résumé console
  console.log('\n========================================');
  console.log('  DISCOVERY v2 TERMINÉE');
  console.log(`  Durée: ${result.durationMs}ms`);
  console.log(`  Catégories: ${result.summary.totalCategories} (${result.summary.newCategories} nouvelles)`);
  console.log(`  Top: ${result.summary.topCategory} (score ${result.summary.topScore}/100)`);
  console.log(`  Suggestions: ${result.summary.totalSuggestions} (${result.summary.highPriority} haute priorité)`);
  console.log(`  Objectif 5000€: ${result.summary.objectiveAchievable ? 'ATTEIGNABLE' : 'GAP ' + objectivePlan.gap + '€'}`);
  console.log(`  Projection: ${result.summary.projectedMonthly} EUR/mois`);
  console.log('========================================\n');

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
//  11. FILESYSTEM CONTEXT — Workspace discovery/findings.md
// ═══════════════════════════════════════════════════════════════════════

/**
 * Appende les résultats d'un run Discovery dans output/agents/discovery/findings.md
 * Format markdown avec date + nb suggestions + top catégories.
 */
async function appendDiscoveryFindings(result, cfg) {
  if (!result) return;
  const outputDir = (cfg && cfg.outputDir) || path.join(__dirname, '..', '..', 'output');
  const findingsPath = path.join(outputDir, 'agents', 'discovery', 'findings.md');

  try {
    await fs.promises.mkdir(path.dirname(findingsPath), { recursive: true });

    const now = new Date();
    const dateStr = now.toISOString().replace('T', ' ').slice(0, 19);
    const lines = [
      `\n## Run ${dateStr}`,
      ''
    ];

    // Résumé
    if (result.summary) {
      const s = result.summary;
      lines.push(`- **Catégories analysées :** ${s.totalCategories || 0} (${s.newCategories || 0} nouvelles)`);
      lines.push(`- **Suggestions :** ${s.totalSuggestions || 0} (${s.highPriority || 0} haute priorité)`);
      lines.push(`- **Top catégorie :** ${s.topCategory || 'n/a'} (score ${s.topScore || 0}/100)`);
      lines.push(`- **Projection mensuelle :** ${s.projectedMonthly || 0} EUR/mois`);
      lines.push(`- **Objectif 5000€ :** ${s.objectiveAchievable ? 'ATTEIGNABLE ✅' : `GAP ${result.objectivePlan ? result.objectivePlan.gap : '?'} EUR ❌`}`);
    }

    // Top 3 suggestions haute priorité
    const highPrio = (result.suggestions || []).filter((s) => s.priority === 'high').slice(0, 3);
    if (highPrio.length > 0) {
      lines.push('');
      lines.push('**Suggestions haute priorité :**');
      for (const s of highPrio) {
        lines.push(`- [${s.type}] ${s.emoji || ''} ${s.label || s.reason}`);
      }
    }

    lines.push('');
    await fs.promises.appendFile(findingsPath, lines.join('\n'));
  } catch (err) {
    console.error(`[Discovery] Erreur écriture findings.md: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
  discover,
  appendDiscoveryFindings,
  analyzeHistoricalPatterns,
  analyzeAllCategories,
  generateSuggestions,
  generateSearchConfigs,
  detectPriceTrends,
  buildObjectivePlan,
  buildDiscoveryTelegramMessage,
  getSeasonalTrends,
  CATEGORY_DATABASE,
  TCG_RELEASE_CALENDAR
};
