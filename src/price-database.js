/**
 * Price Database — Base de données locale de prix persistante.
 *
 * Stocke séparément les prix Vinted observés et les prix marché (eBay, API, etc.).
 * Format: base plate { [productKey]: { vintedPrices[], marketPrices[], ... } }
 *
 * Clé de produit: basée sur le titre uniquement (pas la catégorie ni la source).
 * Même produit = même clé, quelle que soit la source qui l'a découvert.
 */

const fs = require('fs');
const path = require('path');

// ─── Category normalization ──────────────────────────────────────────────────

const CATEGORY_MAP = {
  'pokemon': 'pokemon',
  'pokémon': 'pokemon',
  'yugioh': 'yugioh',
  'yu-gi-oh': 'yugioh',
  'yu-gi-oh!': 'yugioh',
  'lego': 'lego',
  'topps f1': 'topps-f1',
  'topps-f1': 'topps-f1',
  'topps': 'topps-f1',
  'one piece': 'one-piece',
  'one piece tcg': 'one-piece',
  'one-piece': 'one-piece',
  'ebay': 'ebay',
  'discogs': 'discogs',
  'sneakers': 'sneakers',
  'misc': 'misc',
};

function normalizeCategory(cat) {
  if (!cat) return 'other';
  const lower = cat.toLowerCase().trim();
  return CATEGORY_MAP[lower] || lower.replace(/\s+/g, '-');
}

// Categories that are pricing sources, not product categories
const SOURCE_CATEGORIES = new Set([
  'ebay', 'ebay-browse-api', 'apify-ebay', 'local-database',
  'local-database-stale', 'pokemontcg-api', 'ygoprodeck', 'rebrickable',
]);

/**
 * Returns the real product category, detecting from title when the passed
 * category is a pricing source (ebay, pokemontcg-api, etc.).
 */
function detectProductCategory(title, passedCategory) {
  const normPassed = normalizeCategory(passedCategory);
  if (!SOURCE_CATEGORIES.has(normPassed)) return normPassed;

  // passedCategory is a source — detect real category from title
  const t = (title || '').toLowerCase();
  if (/\b(pokemon|pokémon|pikachu|charizard|bulbasaur|squirtle|mewtwo|eevee)\b/.test(t)) return 'pokemon';
  if (/\b(yu-gi-oh|yugioh|magicien.sombre|dark.magician)\b/.test(t)) return 'yugioh';
  if (/\blego\b/.test(t)) return 'lego';
  if (/\b(topps|chrome)\b/.test(t) || /\bf1\b/.test(t)) return 'topps-f1';
  if (/\bone.?piece\b/.test(t)) return 'one-piece';
  return 'misc';
}

// ─── Config ────────────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, '..', 'output', 'price-database.json');
const MAX_VINTED_PRICES = 30;
const MAX_MARKET_PRICES = 20;
const MAX_LIQUIDITY_HISTORY = 30;
const MAX_PRICE_HISTORY = 30;
const MAX_AGE_DAYS_DEFAULT = 30; // Was 365 — 30 jours suffit pour l'arbitrage, réduit la mémoire de 80%
const STALE_THRESHOLD_DAYS = 30;

// ─── In-memory state ────────────────────────────────────────────────────────

let db = null; // lazy-loaded
let dirty = false;
let saveTimer = null;

// ─── Load / Save ────────────────────────────────────────────────────────────

function loadDb() {
  if (db !== null) return db;

  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, 'utf8');
      db = JSON.parse(raw);
    } else {
      db = {};
    }
  } catch {
    db = {};
  }

  // Prune old entries on startup
  pruneOldEntries(MAX_AGE_DAYS_DEFAULT);

  // Migrate entries that used old category-prefixed keys
  migrateKeys();

  return db;
}

function saveDb() {
  if (!dirty) return;
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    dirty = false;
  } catch (err) {
    console.error('[price-db] Erreur sauvegarde:', err.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDb();
  }, 2000); // debounce 2s
}

// ─── Key migration (old category-prefixed keys → title-only keys) ────────────

/**
 * On startup: re-key any entries whose stored key doesn't match the new
 * generateKey(entry.name) format. Merges if the new key already exists.
 */
function migrateKeys() {
  if (!db) return;

  const toMigrate = [];
  for (const [oldKey, entry] of Object.entries(db)) {
    if (!entry || typeof entry !== 'object') continue;
    const newKey = generateKey(entry.name || oldKey);
    if (newKey !== oldKey) {
      toMigrate.push({ oldKey, newKey, entry });
    }
  }

  if (toMigrate.length === 0) return;

  let migrated = 0;
  for (const { oldKey, newKey, entry } of toMigrate) {
    if (db[newKey] && db[newKey] !== entry) {
      // New key already exists — merge price observations into it
      const target = db[newKey];

      const existingVintedIds = new Set(
        (target.vintedPrices || []).map(p => p.vintedId).filter(Boolean)
      );
      for (const p of (entry.vintedPrices || [])) {
        if (!p.vintedId || !existingVintedIds.has(p.vintedId)) {
          target.vintedPrices.push(p);
        }
      }
      if (target.vintedPrices.length > MAX_VINTED_PRICES) {
        target.vintedPrices = target.vintedPrices.slice(-MAX_VINTED_PRICES);
      }

      for (const p of (entry.marketPrices || [])) {
        target.marketPrices.push(p);
      }
      if (target.marketPrices.length > MAX_MARKET_PRICES) {
        target.marketPrices = target.marketPrices.slice(-MAX_MARKET_PRICES);
      }

      const vStats = calcStats(target.vintedPrices);
      target.avgVintedPrice = vStats.avg;
      target.minVintedPrice = vStats.min;
      target.maxVintedPrice = vStats.max;
      target.vintedObservations = target.vintedPrices.length;

      const mStats = calcStats(target.marketPrices);
      target.avgMarketPrice = mStats.avg;
      target.minMarketPrice = mStats.min;
      target.maxMarketPrice = mStats.max;
      target.marketObservations = target.marketPrices.length;

      if (entry.firstSeen && (!target.firstSeen || entry.firstSeen < target.firstSeen)) {
        target.firstSeen = entry.firstSeen;
      }
      if (entry.lastSeen && (!target.lastSeen || entry.lastSeen > target.lastSeen)) {
        target.lastSeen = entry.lastSeen;
      }
    } else {
      // No conflict — just re-key
      db[newKey] = entry;
    }
    delete db[oldKey];
    migrated++;
  }

  console.log(`[price-db] Migrated ${migrated} entries to title-only keys`);
  dirty = true;
  scheduleSave();
}

// ─── Key generation ─────────────────────────────────────────────────────────

/**
 * Normalise un titre en clé de base de données.
 * La clé est basée sur le titre uniquement — pas la catégorie ni la source.
 * Même produit = même clé quelle que soit la source.
 */
function generateKey(title) {
  if (!title) return 'unknown';
  const normalized = title
    .toLowerCase()
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u').replace(/[ç]/g, 'c')
    .replace(/[^a-z0-9\s/\-#]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 150);
  return normalized || 'unknown';
}

// ─── Stats helpers ──────────────────────────────────────────────────────────

function calcStats(prices) {
  if (!prices || prices.length === 0) return { avg: 0, min: 0, max: 0 };
  const sorted = [...prices].map(p => p.price).filter(p => p > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return { avg: 0, min: 0, max: 0 };

  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = Math.round((sum / sorted.length) * 100) / 100;

  return { avg, min: sorted[0], max: sorted[sorted.length - 1] };
}

function calcVolatilityCoeff(prices) {
  if (!prices || prices.length < 2) return null;
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  if (mean === 0) return null;
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
  return Math.sqrt(variance) / mean;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

function makeEmptyEntry(name, category, today) {
  return {
    name: (name || '').slice(0, 80),
    category,
    vintedPrices: [],
    avgVintedPrice: 0,
    minVintedPrice: 0,
    maxVintedPrice: 0,
    vintedObservations: 0,
    marketPrices: [],
    avgMarketPrice: 0,
    minMarketPrice: 0,
    maxMarketPrice: 0,
    marketObservations: 0,
    lastSeen: today,
    firstSeen: today,
    priceHistory: [],
    trend: 'stable',
    trendStrength: 0,
    volatility: 'low'
  };
}

// ─── Trend / Volatility helpers ─────────────────────────────────────────────

/**
 * Calcule le trend à partir d'une entrée (usage interne).
 * Compare la moyenne des 3 derniers prix vs les 3 précédents.
 * Retourne "rising" | "falling" | "stable" | "volatile".
 */
function computeTrendForEntry(entry) {
  if (!entry.priceHistory || entry.priceHistory.length < 3) return 'stable';
  const prices = entry.priceHistory.map(h => h.price).filter(p => p > 0);
  if (prices.length < 3) return 'stable';

  // Volatilité : écart-type > 30% de la moyenne
  const cv = calcVolatilityCoeff(prices);
  if (cv !== null && cv > 0.30) return 'volatile';

  // Trend : avg des 3 derniers vs avg des 3 précédents (ou premiers si < 6 pts)
  const last3 = prices.slice(-3);
  const prev = prices.length >= 6
    ? prices.slice(-6, -3)
    : prices.slice(0, Math.max(1, prices.length - 3));
  const avgLast = last3.reduce((a, b) => a + b, 0) / last3.length;
  const avgPrev = prev.reduce((a, b) => a + b, 0) / prev.length;
  if (avgPrev > 0) {
    const change = (avgLast - avgPrev) / avgPrev;
    if (change > 0.10) return 'rising';
    if (change < -0.10) return 'falling';
  }
  return 'stable';
}

/**
 * Calcule la force du trend (0 à 1) à partir d'une entrée.
 */
function computeTrendStrengthForEntry(entry) {
  if (!entry.priceHistory || entry.priceHistory.length < 3) return 0;
  const prices = entry.priceHistory.map(h => h.price).filter(p => p > 0);
  if (prices.length < 3) return 0;

  const last3 = prices.slice(-3);
  const prev = prices.length >= 6
    ? prices.slice(-6, -3)
    : prices.slice(0, Math.max(1, prices.length - 3));
  const avgLast = last3.reduce((a, b) => a + b, 0) / last3.length;
  const avgPrev = prev.reduce((a, b) => a + b, 0) / prev.length;
  if (avgPrev > 0) {
    const change = Math.abs((avgLast - avgPrev) / avgPrev);
    return Math.round(Math.min(1, change / 0.50) * 100) / 100;
  }
  return 0;
}

/**
 * Calcule la volatilité à partir d'une entrée.
 * Retourne "low" | "medium" | "high".
 */
function computeVolatilityForEntry(entry) {
  if (!entry.priceHistory || entry.priceHistory.length < 2) return 'low';
  const prices = entry.priceHistory.map(h => h.price).filter(p => p > 0);
  const cv = calcVolatilityCoeff(prices);
  if (cv === null) return 'low';
  if (cv > 0.30) return 'high';
  if (cv > 0.15) return 'medium';
  return 'low';
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Enregistre un prix Vinted observé pour un produit.
 * Déduplique par vintedId — le même listing ne sera jamais compté deux fois.
 *
 * @param {string} title       - Titre du listing Vinted
 * @param {string} category    - Catégorie (pokemon, yugioh, lego, …) ou source
 * @param {number} vintedPrice - Prix acheteur Vinted en EUR
 * @param {string} vintedId    - ID unique du listing Vinted
 * @param {string} [country]   - Pays Vinted (be, fr, de, …)
 */
function recordVintedPrice(title, category, vintedPrice, vintedId, country) {
  if (!vintedPrice || vintedPrice <= 0) return;
  if (!title || !category) return;

  const productCat = detectProductCategory(title, category);
  const database = loadDb();
  const key = generateKey(title);
  const today = todayStr();
  const idStr = String(vintedId || '');

  if (!database[key]) {
    database[key] = makeEmptyEntry(title, productCat, today);
  }

  const entry = database[key];

  // If the entry was created with a source category, upgrade it to the real one
  if (SOURCE_CATEGORIES.has(entry.category)) {
    entry.category = productCat;
  }

  // Dédup: si ce vintedId est déjà enregistré, on met juste à jour lastSeen
  if (idStr && entry.vintedPrices.some(p => p.vintedId === idStr)) {
    entry.lastSeen = today;
    dirty = true;
    scheduleSave();
    return;
  }

  entry.vintedPrices.push({
    price: Math.round(vintedPrice * 100) / 100,
    vintedId: idStr,
    date: today,
    country: country || 'be'
  });

  // Garder max 30 observations Vinted
  if (entry.vintedPrices.length > MAX_VINTED_PRICES) {
    entry.vintedPrices = entry.vintedPrices.slice(-MAX_VINTED_PRICES);
  }

  // Recalculer les stats Vinted
  const stats = calcStats(entry.vintedPrices);
  entry.avgVintedPrice = stats.avg;
  entry.minVintedPrice = stats.min;
  entry.maxVintedPrice = stats.max;
  entry.vintedObservations = entry.vintedPrices.length;
  entry.lastSeen = today;

  dirty = true;
  scheduleSave();
}

/**
 * Enregistre un prix marché (eBay, API, Cardmarket, etc.).
 * Les doublons sont permis (sources/dates différentes — tout est utile).
 *
 * @param {string} title       - Titre du listing
 * @param {string} category    - Catégorie ou source
 * @param {number} price       - Prix marché en EUR
 * @param {string} source      - Source (pokemontcg-api, apify-ebay, ebay-browse-api, …)
 * @param {object} [listingData] - Données du listing source {url, listingTitle, imageUrl}
 */
function recordMarketPrice(title, category, price, source, listingData) {
  if (!price || price <= 0) return;
  if (!title || !category) return;

  const productCat = detectProductCategory(title, category);
  const database = loadDb();
  const key = generateKey(title);
  const today = todayStr();

  if (!database[key]) {
    database[key] = makeEmptyEntry(title, productCat, today);
  }

  const entry = database[key];

  // If the entry was created with a source category, upgrade it to the real one
  if (SOURCE_CATEGORIES.has(entry.category)) {
    entry.category = productCat;
  }

  const marketEntry = {
    price: Math.round(price * 100) / 100,
    source: source || 'unknown',
    date: today
  };

  // Store eBay listing data for traceability (url, exact title, image)
  if (listingData) {
    if (listingData.url) marketEntry.url = listingData.url;
    if (listingData.listingTitle) marketEntry.listingTitle = listingData.listingTitle;
    if (listingData.imageUrl) marketEntry.imageUrl = listingData.imageUrl;
  }

  // Skip duplicate URLs — same listing already recorded
  if (marketEntry.url) {
    const existingUrls = entry.marketPrices.map((mp) => mp.url).filter(Boolean);
    if (existingUrls.includes(marketEntry.url)) return;
  }

  entry.marketPrices.push(marketEntry);

  // Garder max 20 observations marché
  if (entry.marketPrices.length > MAX_MARKET_PRICES) {
    entry.marketPrices = entry.marketPrices.slice(-MAX_MARKET_PRICES);
  }

  // Recalculer les stats marché
  const stats = calcStats(entry.marketPrices);
  entry.avgMarketPrice = stats.avg;
  entry.minMarketPrice = stats.min;
  entry.maxMarketPrice = stats.max;
  entry.marketObservations = entry.marketPrices.length;
  entry.lastSeen = today;

  // Mettre à jour l'historique de prix (1 entrée par jour max, 30 jours)
  if (!entry.priceHistory) entry.priceHistory = [];
  const roundedPrice = Math.round(price * 100) / 100;
  const todayHistIdx = entry.priceHistory.findIndex(h => h.date === today);
  if (todayHistIdx >= 0) {
    const hist = entry.priceHistory[todayHistIdx];
    const count = hist.salesCount || 1;
    hist.price = Math.round(((hist.price * count + roundedPrice) / (count + 1)) * 100) / 100;
    hist.salesCount = count + 1;
    hist.source = source || hist.source;
  } else {
    entry.priceHistory.push({ date: today, price: roundedPrice, source: source || 'unknown', salesCount: 1 });
    if (entry.priceHistory.length > MAX_PRICE_HISTORY) {
      entry.priceHistory = entry.priceHistory.slice(-MAX_PRICE_HISTORY);
    }
  }

  // Recalculer trend / volatilité
  entry.trend = computeTrendForEntry(entry);
  entry.trendStrength = computeTrendStrengthForEntry(entry);
  entry.volatility = computeVolatilityForEntry(entry);

  dirty = true;
  scheduleSave();
}

// Alias pour compatibilité avec l'ancien code (price-router.js)
function recordPrice(title, category, price, source, listingData) {
  return recordMarketPrice(title, category, price, source, listingData);
}

/**
 * Recherche un prix marché dans la base locale.
 * Retourne également le prix Vinted moyen pour comparaison.
 *
 * @returns {{ price, minPrice, maxPrice, source, confidence, scanCount, ageDays, key, avgVintedPrice, vintedObservations }} ou null
 */
function lookupPrice(title, category) {
  const database = loadDb();
  const key = generateKey(title);
  const entry = database[key];

  if (!entry) return null;
  if (!entry.marketPrices || entry.marketPrices.length === 0) return null;
  if (!entry.avgMarketPrice || entry.avgMarketPrice <= 0) return null;

  const ageDays = daysBetween(entry.lastSeen);
  const isStale = ageDays > STALE_THRESHOLD_DAYS;

  // Find most recent market price with URL (préférer ceux qui ont aussi une imageUrl)
  const marketPricesReversed = [...(entry.marketPrices || [])].reverse();
  const latestWithImage = marketPricesReversed.find(p => p.url && p.imageUrl);
  const latestWithUrl = latestWithImage || marketPricesReversed.find(p => p.url);

  return {
    price: entry.avgMarketPrice,
    minPrice: entry.minMarketPrice,
    maxPrice: entry.maxMarketPrice,
    source: isStale ? 'local-database-stale' : 'local-database',
    confidence: isStale ? 'low' : (entry.marketObservations >= 3 ? 'high' : 'medium'),
    scanCount: entry.marketObservations,
    ageDays,
    key,
    avgVintedPrice: entry.avgVintedPrice || 0,
    vintedObservations: entry.vintedObservations || 0,
    // eBay listing data from stored observations (for traceability)
    ebayUrl: latestWithUrl ? latestWithUrl.url : null,
    ebayListingTitle: latestWithUrl ? (latestWithUrl.listingTitle || null) : null,
    ebayImageUrl: latestWithUrl ? (latestWithUrl.imageUrl || null) : null,
    // All listings with URLs for display in dashboard
    listings: (entry.marketPrices || [])
      .filter(p => p.url)
      .slice(-5)
      .map(p => ({ url: p.url, title: p.listingTitle || '', price: p.price, imageUrl: p.imageUrl || '', source: p.source, date: p.date }))
  };
}

/**
 * Retourne l'entrée complète d'un produit avec données Vinted et marché.
 */
function getProductInfo(title, category) {
  const database = loadDb();
  const key = generateKey(title);
  return database[key] || null;
}

/**
 * Retourne les statistiques de la base de données.
 */
function getStats() {
  const database = loadDb();
  const stats = {
    totalProducts: 0,
    categories: {},
    dbPath: DB_PATH
  };

  for (const entry of Object.values(database)) {
    if (!entry || typeof entry !== 'object') continue;
    const cat = entry.category || 'other';
    if (!stats.categories[cat]) {
      stats.categories[cat] = { count: 0, avgPrice: 0, _totalAvg: 0 };
    }
    stats.categories[cat].count++;
    if (entry.avgMarketPrice > 0) {
      stats.categories[cat]._totalAvg += entry.avgMarketPrice;
    }
    stats.totalProducts++;
  }

  for (const c of Object.values(stats.categories)) {
    c.avgPrice = c.count > 0 ? Math.round((c._totalAvg / c.count) * 100) / 100 : 0;
    delete c._totalAvg;
  }

  return stats;
}

/**
 * Supprime les entrées non vues depuis plus de maxAgeDays jours.
 */
function pruneOldEntries(maxAgeDays = MAX_AGE_DAYS_DEFAULT) {
  if (!db) return 0;

  const total = Object.keys(db).length;

  // Identifier les clés à supprimer
  const keysToDelete = [];
  for (const key of Object.keys(db)) {
    const entry = db[key];
    if (!entry || typeof entry !== 'object') continue;
    if (entry.lastSeen && daysBetween(entry.lastSeen) > maxAgeDays) {
      keysToDelete.push(key);
    }
  }

  // Protection : ne pas purger si le résultat serait < 50 entrées
  const remaining = total - keysToDelete.length;
  if (remaining < 50 && total > 0) {
    console.log(`[price-db] Purge annulée : ${total} entrées total, purger ${keysToDelete.length} laisserait ${remaining} < 50 entrées (protection activée)`);
    return 0;
  }

  for (const key of keysToDelete) {
    delete db[key];
    dirty = true;
  }

  const pruned = keysToDelete.length;
  if (pruned > 0) {
    console.log(`[price-db] Purgé ${pruned}/${total} entrées périmées (> ${maxAgeDays} jours), ${remaining} conservées`);
    scheduleSave();
  }

  return pruned;
}

/**
 * Enregistre un point d'historique de liquidité pour un produit.
 */
function recordLiquidity(title, category, liquidityData) {
  if (!title || !category || !liquidityData) return;
  if (typeof liquidityData.score !== 'number') return;

  const productCat = detectProductCategory(title, category);
  const database = loadDb();
  const key = generateKey(title);
  const today = todayStr();

  if (!database[key]) {
    database[key] = makeEmptyEntry(title, productCat, today);
  }

  const entry = database[key];
  if (!entry.liquidityHistory) entry.liquidityHistory = [];

  entry.liquidityHistory.push({
    score: liquidityData.score,
    classification: liquidityData.classification,
    date: today,
    soldCount: liquidityData.summary ? (liquidityData.summary.soldCount || 0) : 0,
    avgDaysBetweenSales: liquidityData.summary ? (liquidityData.summary.avgDaysBetweenSales || null) : null
  });

  if (entry.liquidityHistory.length > MAX_LIQUIDITY_HISTORY) {
    entry.liquidityHistory = entry.liquidityHistory.slice(-MAX_LIQUIDITY_HISTORY);
  }

  entry.lastSeen = today;
  dirty = true;
  scheduleSave();
}

/**
 * Détecte les tendances de prix (hausse/baisse) basées sur les prix marché.
 * Compare les 3 premières vs 3 dernières observations (min 5 observations).
 */
function detectTrends() {
  const database = loadDb();
  const activeTrends = [];

  for (const [key, entry] of Object.entries(database)) {
    if (!entry || typeof entry !== 'object') continue;
    const prices = (entry.marketPrices || []).filter(p => p.price > 0);
    if (prices.length < 5) continue;

    const first3 = prices.slice(0, 3);
    const last3 = prices.slice(-3);

    const avgFirst = first3.reduce((s, p) => s + p.price, 0) / first3.length;
    const avgLast = last3.reduce((s, p) => s + p.price, 0) / last3.length;

    if (avgFirst === 0) continue;

    const changePercent = Math.round(((avgLast - avgFirst) / avgFirst) * 100);

    let direction;
    if (changePercent > 15)       direction = 'rising';
    else if (changePercent < -15) direction = 'falling';
    else                           direction = 'stable';

    entry.trend = {
      direction,
      changePercent,
      avgFirst: Math.round(avgFirst * 100) / 100,
      avgLast: Math.round(avgLast * 100) / 100,
      since: prices[prices.length - 3].date || todayStr()
    };

    if (direction !== 'stable') {
      activeTrends.push({
        key,
        category: entry.category || 'other',
        name: entry.name || key,
        trend: entry.trend
      });
      dirty = true;
    }
  }

  if (dirty) scheduleSave();

  return activeTrends;
}

/**
 * Force-save immédiat (appeler avant exit process si nécessaire).
 */
function flushSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveDb();
}

/**
 * Retourne le trend de prix pour une clé produit.
 * @param {string} key - Clé générée par generateKey()
 * @returns {"rising"|"falling"|"stable"|"volatile"}
 */
function getTrend(key) {
  const database = loadDb();
  const entry = database[key];
  if (!entry) return 'stable';
  return computeTrendForEntry(entry);
}

/**
 * Retourne la volatilité de prix pour une clé produit.
 * @param {string} key - Clé générée par generateKey()
 * @returns {"low"|"medium"|"high"}
 */
function getVolatility(key) {
  const database = loadDb();
  const entry = database[key];
  if (!entry) return 'low';
  return computeVolatilityForEntry(entry);
}

/**
 * Retourne la force du trend (0 à 1) pour une clé produit.
 * @param {string} key - Clé générée par generateKey()
 * @returns {number} 0 à 1
 */
function getTrendStrength(key) {
  const database = loadDb();
  const entry = database[key];
  if (!entry) return 0;
  return computeTrendStrengthForEntry(entry);
}

/**
 * Axe 4: Retourne les produits qui ont des observations Vinted
 * mais peu d'observations marché (<= 2), triés par potentiel de profit.
 * Utilisé pour l'enrichissement proactif des prix.
 * @param {number} limit - Nombre max de produits à retourner
 * @returns {Array<{key, name, category, avgVintedPrice, marketObservations}>}
 */
function getUnderPricedProducts(limit = 10) {
  const database = loadDb();
  const candidates = [];

  for (const [key, entry] of Object.entries(database)) {
    if (!entry || typeof entry !== 'object') continue;
    // Produit vu sur Vinted mais pas assez de données marché
    if ((entry.vintedObservations || 0) >= 1 && (entry.marketObservations || 0) <= 2) {
      candidates.push({
        key,
        name: entry.name || key,
        category: entry.category || 'other',
        avgVintedPrice: entry.avgVintedPrice || 0,
        marketObservations: entry.marketObservations || 0,
        lastSeen: entry.lastSeen || ''
      });
    }
  }

  // Trier par prix Vinted décroissant (les plus chers en premier = plus de potentiel)
  candidates.sort((a, b) => b.avgVintedPrice - a.avgVintedPrice);
  return candidates.slice(0, limit);
}

module.exports = {
  normalizeCategory,
  detectProductCategory,
  generateKey,
  lookupPrice,
  recordVintedPrice,
  recordMarketPrice,
  recordPrice,       // alias pour compatibilité
  recordLiquidity,
  detectTrends,
  getStats,
  getProductInfo,
  pruneOldEntries,
  getUnderPricedProducts,
  flushSync,
  // Historique de prix temporel
  getTrend,
  getVolatility,
  getTrendStrength
};
