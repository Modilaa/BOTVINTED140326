/**
 * Seen-Listings Cache — Évite de retraiter les mêmes annonces Vinted.
 *
 * Stocke les IDs d'annonces déjà traitées dans output/seen-listings.json.
 * Les entrées expirent après 24h (le prix peut avoir changé).
 * Les entrées "no-price" sont toujours retraitées (API peut être revenue).
 */

const fs = require('fs');
const path = require('path');

// ─── Config ─────────────────────────────────────────────────────────────────

const CACHE_PATH = path.join(__dirname, '..', 'output', 'seen-listings.json');
const MAX_AGE_HOURS = 24;

// Résultats définitifs — on peut les skipper
const SKIP_RESULTS = new Set(['opportunity', 'no-profit', 'no-match', 'expired']);

// ─── In-memory state ─────────────────────────────────────────────────────────

let cache = null; // lazy-loaded
let dirty = false;
let saveTimer = null;

// ─── Load / Save ─────────────────────────────────────────────────────────────

function loadCache() {
  if (cache !== null) return cache;

  try {
    if (fs.existsSync(CACHE_PATH)) {
      const raw = fs.readFileSync(CACHE_PATH, 'utf8');
      cache = JSON.parse(raw);
    } else {
      cache = {};
    }
  } catch {
    cache = {};
  }

  // Prune old entries on startup
  pruneOld(MAX_AGE_HOURS);

  return cache;
}

function saveCache() {
  if (!dirty) return;
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
    dirty = false;
  } catch (err) {
    console.error('[seen-listings] Erreur sauvegarde:', err.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveCache();
  }, 2000); // debounce 2s
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Retourne true si cette annonce a déjà été traitée dans les 24 dernières heures
 * avec un résultat définitif (pas "no-price").
 */
function isAlreadySeen(listingId) {
  const db = loadCache();
  const entry = db[String(listingId)];
  if (!entry) return false;

  // "no-price" = API indisponible au dernier scan → toujours retenter
  if (entry.result === 'no-price') return false;

  // Expiration 24h : le prix a peut-être changé
  const ageMs = Date.now() - new Date(entry.firstSeen).getTime();
  if (ageMs > MAX_AGE_HOURS * 60 * 60 * 1000) return false;

  return SKIP_RESULTS.has(entry.result);
}

/**
 * Enregistre une annonce comme traitée.
 * @param {string|number} listingId
 * @param {string} category  - ex: "pokemon", "topps-f1"
 * @param {string} title     - Titre de l'annonce
 * @param {string} result    - "opportunity" | "no-match" | "no-profit" | "no-price" | "expired"
 * @param {number|null} price - Prix de marché détecté (null si non trouvé)
 */
function markAsSeen(listingId, category, title, result, price) {
  const db = loadCache();
  db[String(listingId)] = {
    firstSeen: new Date().toISOString(),
    category: category || '',
    title: (title || '').slice(0, 100),
    result: result || 'no-match',
    price: (price != null && price > 0) ? Math.round(price * 100) / 100 : null
  };
  dirty = true;
  scheduleSave();
}

/**
 * Retourne le nombre d'annonces en cache.
 */
function getSeenCount() {
  return Object.keys(loadCache()).length;
}

/**
 * Supprime les entrées plus vieilles que maxAgeHours heures.
 * Appelé automatiquement au démarrage.
 */
function pruneOld(maxAgeHours = MAX_AGE_HOURS) {
  if (!cache) return 0;

  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let pruned = 0;

  for (const id of Object.keys(cache)) {
    const entry = cache[id];
    if (!entry.firstSeen || new Date(entry.firstSeen).getTime() < cutoff) {
      delete cache[id];
      pruned++;
      dirty = true;
    }
  }

  if (pruned > 0) {
    console.log(`[seen-listings] Pruned ${pruned} entrées (> ${maxAgeHours}h)`);
    scheduleSave();
  }

  return pruned;
}

/**
 * Retourne le résultat mis en cache pour une annonce donnée.
 * Retourne null si l'annonce n'est pas en cache.
 */
function getSeenResult(listingId) {
  const db = loadCache();
  const entry = db[String(listingId)];
  return entry ? entry.result : null;
}

/**
 * Retourne les stats de turnover pour une catégorie donnée.
 * Utilisé par computeLiquidity() pour le facteur D (turnover des annonces).
 *
 * @param {string} category - Nom de la catégorie (ex: "pokemon", "topps-f1")
 * @returns {{ total, expired, expiredRatio }} expiredRatio = null si données insuffisantes
 */
function getCategoryStats(category) {
  const db = loadCache();
  const cat = (category || '').toLowerCase();
  let expired = 0;
  let total = 0;
  for (const entry of Object.values(db)) {
    if ((entry.category || '').toLowerCase() === cat) {
      total++;
      if (entry.result === 'expired') expired++;
    }
  }
  return {
    total,
    expired,
    expiredRatio: total > 0 ? Math.round((expired / total) * 100) / 100 : null
  };
}

/**
 * Force-save immédiat (appeler avant exit process si nécessaire).
 */
function flushSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveCache();
}

module.exports = {
  isAlreadySeen,
  markAsSeen,
  getSeenCount,
  pruneOld,
  getSeenResult,
  getCategoryStats,
  flushSync
};
