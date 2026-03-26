/**
 * Dismissed Listings Blacklist — Empêche les annonces ignorées de réapparaître.
 *
 * Contrairement à seen-listings.js (TTL 6h), cette blacklist est PERMANENTE.
 * Quand l'utilisateur clique "Ignorer", l'annonce ne reviendra plus jamais.
 *
 * Identifiants :
 *  - Par vintedId (numérique) : fiable mais un vendeur peut reposter avec un nouvel ID
 *  - Par titre normalisé : couvre les reposts avec nouvel ID (expire après 30 jours)
 *
 * Limite : 5000 entrées max. Au-delà, les plus anciennes sont supprimées.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const BLACKLIST_PATH = path.join(__dirname, '..', 'output', 'dismissed-listings.json');
const MAX_ENTRIES = 5000;
const TITLE_TTL_DAYS = 30; // Le titre normalisé expire après 30 jours (repost possible)

// ─── In-memory state ─────────────────────────────────────────────────────────

let db = null; // lazy-loaded
let dirty = false;
let saveTimer = null;

// ─── Normalisation du titre ───────────────────────────────────────────────────

/**
 * Normalise un titre pour la comparaison : lowercase, sans accents, sans ponctuation,
 * espaces multiples réduits. Retourne les 80 premiers caractères.
 */
function normalizeTitle(title) {
  if (!title) return '';
  return (title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // supprime les accents
    .replace(/[^a-z0-9\s]/g, ' ')    // remplace ponctuation par espace
    .replace(/\s+/g, ' ')             // espaces multiples
    .trim()
    .slice(0, 80);
}

// ─── Load / Save ─────────────────────────────────────────────────────────────

function loadDb() {
  if (db !== null) return db;

  try {
    if (fs.existsSync(BLACKLIST_PATH)) {
      const raw = fs.readFileSync(BLACKLIST_PATH, 'utf8');
      db = JSON.parse(raw);
    } else {
      db = { byId: {}, byTitle: {} };
    }
  } catch {
    db = { byId: {}, byTitle: {} };
  }

  // Assurer la structure
  if (!db.byId) db.byId = {};
  if (!db.byTitle) db.byTitle = {};

  return db;
}

function saveDb() {
  if (!dirty) return;
  try {
    const dir = path.dirname(BLACKLIST_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(BLACKLIST_PATH, JSON.stringify(db, null, 2), 'utf8');
    dirty = false;
  } catch (err) {
    console.error('[dismissed-listings] Erreur sauvegarde:', err.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDb();
  }, 2000);
}

// ─── Pruning ──────────────────────────────────────────────────────────────────

/**
 * Supprime les titres expirés (> TITLE_TTL_DAYS) et tronque si > MAX_ENTRIES.
 */
function pruneIfNeeded() {
  const d = loadDb();
  const titleCutoff = Date.now() - TITLE_TTL_DAYS * 24 * 60 * 60 * 1000;

  // Expiration des titres normalisés
  for (const key of Object.keys(d.byTitle)) {
    const entry = d.byTitle[key];
    if (entry.dismissedAt && new Date(entry.dismissedAt).getTime() < titleCutoff) {
      delete d.byTitle[key];
      dirty = true;
    }
  }

  // Limite de taille : garder les MAX_ENTRIES les plus récents (byId)
  const idEntries = Object.entries(d.byId);
  if (idEntries.length > MAX_ENTRIES) {
    idEntries.sort((a, b) => new Date(a[1].dismissedAt) - new Date(b[1].dismissedAt));
    const toDelete = idEntries.slice(0, idEntries.length - MAX_ENTRIES);
    for (const [key] of toDelete) {
      delete d.byId[key];
      dirty = true;
    }
    console.log(`[dismissed-listings] Pruned ${toDelete.length} entrées anciennes (limite ${MAX_ENTRIES})`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Vérifie si une annonce est dans la blacklist.
 * @param {string|number} vintedId - ID numérique Vinted
 * @param {string} title - Titre de l'annonce
 * @returns {boolean}
 */
function isDismissed(vintedId, title) {
  const d = loadDb();

  // 1. Vérification par ID (permanent)
  if (vintedId && d.byId[String(vintedId)]) {
    return true;
  }

  // 2. Vérification par titre normalisé (expire après 30 jours)
  if (title) {
    const normTitle = normalizeTitle(title);
    if (normTitle.length >= 10) {
      const entry = d.byTitle[normTitle];
      if (entry) {
        const age = Date.now() - new Date(entry.dismissedAt).getTime();
        if (age < TITLE_TTL_DAYS * 24 * 60 * 60 * 1000) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Ajoute une annonce à la blacklist permanente.
 * @param {string|number} vintedId - ID numérique Vinted
 * @param {string} title - Titre de l'annonce
 */
function addDismissed(vintedId, title) {
  const d = loadDb();
  const now = new Date().toISOString();

  // Enregistrement par ID
  if (vintedId) {
    const key = String(vintedId);
    if (d.byId[key]) {
      d.byId[key].dismissedCount = (d.byId[key].dismissedCount || 1) + 1;
      d.byId[key].dismissedAt = now; // update timestamp
    } else {
      d.byId[key] = {
        title: (title || '').slice(0, 120),
        dismissedAt: now,
        dismissedCount: 1
      };
    }
  }

  // Enregistrement par titre normalisé
  if (title) {
    const normTitle = normalizeTitle(title);
    if (normTitle.length >= 10) {
      d.byTitle[normTitle] = {
        vintedId: vintedId ? String(vintedId) : null,
        dismissedAt: now
      };
    }
  }

  dirty = true;
  pruneIfNeeded();
  scheduleSave();
}

/**
 * Retourne le nombre d'entrées dans la blacklist (par ID unique).
 */
function getCount() {
  return Object.keys(loadDb().byId).length;
}

/**
 * Force-save immédiat (appeler avant exit process).
 */
function flushSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveDb();
}

module.exports = {
  isDismissed,
  addDismissed,
  getCount,
  normalizeTitle,
  flushSync
};
