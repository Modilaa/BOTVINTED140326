'use strict';

/**
 * opportunity-state.js — State machine par opportunité.
 *
 * Chaque opportunité est persistée dans output/opportunities/{id}.json
 * avec un historique complet des transitions de statut (audit trail).
 *
 * Statuts possibles :
 *   discovered → evaluated → pending → accepted / rejected / dismissed / expired / sold
 *
 * Complément du système existant (latest-scan.json) — les deux coexistent.
 */

const fs = require('fs');
const path = require('path');

const OPPORTUNITIES_DIR = path.join(__dirname, '..', 'output', 'opportunities');

function ensureDir() {
  if (!fs.existsSync(OPPORTUNITIES_DIR)) {
    fs.mkdirSync(OPPORTUNITIES_DIR, { recursive: true });
  }
}

function oppPath(id) {
  // Sécuriser le nom de fichier (éviter path traversal)
  const safe = String(id).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 100);
  return path.join(OPPORTUNITIES_DIR, `${safe}.json`);
}

/**
 * Lit l'état actuel d'une opportunité.
 * Retourne null si elle n'existe pas encore.
 */
function getState(opportunityId) {
  try {
    const p = oppPath(opportunityId);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Crée ou met à jour l'état d'une opportunité.
 * Si l'opportunité n'existe pas encore, elle est créée avec les données fournies.
 * Un événement de transition est ajouté à statusHistory si le statut change.
 *
 * @param {string} opportunityId  - ID unique (ex: "vinted_123456")
 * @param {Object} updates        - Champs à mettre à jour (dont optionnellement status, by, details)
 * @returns {Object} L'état mis à jour
 */
function updateState(opportunityId, updates) {
  ensureDir();

  const now = new Date().toISOString();
  const existing = getState(opportunityId) || {
    id: opportunityId,
    vintedUrl: null,
    title: null,
    category: null,
    status: null,
    statusHistory: [],
    vintedPrice: null,
    ebayAvgPrice: null,
    profitEstimated: null,
    confidenceScore: null,
    gptVerification: null,
    createdAt: now,
    updatedAt: now
  };

  // Extraire les méta-champs de transition (ne pas stocker dans l'état principal)
  const { by = 'system', details = null, ...fields } = updates;
  const prevStatus = existing.status;
  const newStatus = fields.status !== undefined ? fields.status : prevStatus;

  // Fusionner les champs
  const updated = { ...existing, ...fields, updatedAt: now };

  // Ajouter une entrée dans statusHistory si le statut change
  if (newStatus !== prevStatus) {
    updated.statusHistory = [
      ...(existing.statusHistory || []),
      {
        from: prevStatus,
        to: newStatus,
        at: now,
        by,
        ...(details ? { details } : {})
      }
    ];
  }

  try {
    fs.writeFileSync(oppPath(opportunityId), JSON.stringify(updated, null, 2));
  } catch (err) {
    console.error(`[opportunity-state] Erreur écriture ${opportunityId}: ${err.message}`);
  }

  return updated;
}

/**
 * Liste toutes les opportunités ayant un statut donné.
 * Retourne un tableau d'états.
 */
function listByStatus(status) {
  ensureDir();
  const results = [];
  try {
    const files = fs.readdirSync(OPPORTUNITIES_DIR).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(OPPORTUNITIES_DIR, f), 'utf8'));
        if (data.status === status) results.push(data);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return results;
}

/**
 * Retourne l'historique complet des transitions pour une opportunité.
 */
function getHistory(opportunityId) {
  const state = getState(opportunityId);
  return state ? (state.statusHistory || []) : [];
}

module.exports = { updateState, getState, listByStatus, getHistory };
