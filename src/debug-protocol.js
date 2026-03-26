'use strict';

/**
 * debug-protocol.js — Protocole de debugging structuré root-cause.
 *
 * Chaque événement de debug est loggé dans output/debug-log.jsonl (une ligne = un événement JSON).
 * Un compteur par module track les fixes consécutifs échoués.
 * Si 3+ fixes échoués sur un même module → signal "architectural_review_needed".
 */

const fs = require('fs');
const path = require('path');

const DEBUG_LOG_PATH = path.join(__dirname, '..', 'output', 'debug-log.jsonl');

// Compteur in-mémoire des fixes échoués consécutifs par module
const _failedFixCounts = {};

/**
 * Logge un événement de debug structuré dans output/debug-log.jsonl
 *
 * @param {Object} event
 *   - phase       {string}  Phase du scan (ex: 'vinted-fetch', 'price-router', 'vision')
 *   - module      {string}  Module source (ex: 'vinted.js', 'price-router.js')
 *   - symptom     {string}  Ce qui a été observé (ex: '403 Forbidden')
 *   - cause       {string}  Cause probable (ex: 'IP bloquée par Vinted')
 *   - hypothesis  {string}  Hypothèse de fix (ex: 'Rotation proxy')
 *   - fix         {string}  Action prise (ex: 'Retry avec proxy ScraperAPI')
 *   - verified    {boolean} Le fix a-t-il résolu le problème ?
 *   - error       {string}  Message d'erreur brut (optionnel)
 */
function logDebugEvent(event) {
  try {
    // Créer le dossier output si nécessaire
    const outputDir = path.dirname(DEBUG_LOG_PATH);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const entry = {
      ts: new Date().toISOString(),
      phase: event.phase || 'unknown',
      module: event.module || 'unknown',
      symptom: event.symptom || '',
      cause: event.cause || '',
      hypothesis: event.hypothesis || '',
      fix: event.fix || '',
      verified: event.verified !== undefined ? Boolean(event.verified) : null,
      error: event.error || null
    };

    // Mettre à jour le compteur de fixes échoués
    if (event.module) {
      if (event.verified === false) {
        _failedFixCounts[event.module] = (_failedFixCounts[event.module] || 0) + 1;
      } else if (event.verified === true) {
        _failedFixCounts[event.module] = 0; // Reset sur succès
      }
    }

    fs.appendFileSync(DEBUG_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Ne pas crasher le bot si le log échoue
    console.error(`[debug-protocol] Erreur écriture log: ${err.message}`);
  }
}

/**
 * Vérifie si un module a atteint le seuil de 3 fixes consécutifs échoués.
 *
 * @param {string} module - Nom du module
 * @returns {{ stop: boolean, reason?: string, failedFixes?: number }}
 */
function checkFixThreshold(module) {
  const count = _failedFixCounts[module] || 0;
  if (count >= 3) {
    return {
      stop: true,
      reason: 'architectural_review_needed',
      failedFixes: count,
      message: `${module}: ${count} fixes échoués consécutifs — revue architecturale recommandée`
    };
  }
  return { stop: false, failedFixes: count };
}

/**
 * Lit les N derniers événements de debug depuis le fichier JSONL.
 *
 * @param {number} limit - Nombre max d'événements (défaut: 50)
 * @returns {Object[]}
 */
function readDebugLog(limit = 50) {
  try {
    if (!fs.existsSync(DEBUG_LOG_PATH)) return [];
    const content = fs.readFileSync(DEBUG_LOG_PATH, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    const events = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { /* ignore malformed */ }
    }
    return events.slice(-limit);
  } catch {
    return [];
  }
}

module.exports = { logDebugEvent, checkFixThreshold, readDebugLog };
