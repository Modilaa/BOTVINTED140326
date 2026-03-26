'use strict';

/**
 * Message Bus — Communication directe entre agents sans reformulation.
 *
 * Format de chaque message :
 *   { ts, from, to, type, payload }
 *
 * Fichier : output/agents/message-bus.jsonl
 * Rotation : 1000 messages max (purge au démarrage via init())
 */

const fs   = require('fs');
const path = require('path');

const BUS_PATH = path.join(__dirname, '../output/agents/message-bus.jsonl');
const MAX_MESSAGES = 1000;
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * S'assure que le dossier output/agents/ existe.
 */
function ensureDir() {
  const dir = path.dirname(BUS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Publie un message sur le bus.
 * @returns {Object} Le message publié
 */
function publish(from, to, type, payload) {
  const msg = { ts: new Date().toISOString(), from, to, type, payload };
  try {
    ensureDir();
    fs.appendFileSync(BUS_PATH, JSON.stringify(msg) + '\n');
  } catch (err) {
    console.error(`[MessageBus] Erreur écriture: ${err.message}`);
  }
  return msg;
}

/**
 * Lit tous les messages du bus.
 * @param {Object} filter — { from?, to?, type? }
 * @returns {Array}
 */
function getMessages(filter = {}) {
  try {
    if (!fs.existsSync(BUS_PATH)) return [];
    const cutoff = new Date(Date.now() - TTL_MS);
    const lines = fs.readFileSync(BUS_PATH, 'utf8')
      .split('\n')
      .filter(l => l.trim());

    return lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(m => {
        if (!m) return false;
        if (new Date(m.ts) < cutoff) return false;
        if (filter.from && m.from !== filter.from) return false;
        if (filter.to   && m.to   !== filter.to)   return false;
        if (filter.type && m.type !== filter.type) return false;
        return true;
      });
  } catch (err) {
    console.error(`[MessageBus] Erreur lecture: ${err.message}`);
    return [];
  }
}

/**
 * Purge le bus :
 * - Supprime les messages > 24h
 * - Garde au maximum MAX_MESSAGES messages récents
 *
 * À appeler au démarrage du bot (init()).
 */
function purge() {
  try {
    if (!fs.existsSync(BUS_PATH)) return;
    const cutoff = new Date(Date.now() - TTL_MS);
    const lines = fs.readFileSync(BUS_PATH, 'utf8')
      .split('\n')
      .filter(l => l.trim());

    const valid = lines
      .map(l => { try { return { raw: l, msg: JSON.parse(l) }; } catch { return null; } })
      .filter(x => x && new Date(x.msg.ts) >= cutoff)
      .slice(-MAX_MESSAGES)
      .map(x => x.raw);

    const removed = lines.length - valid.length;
    if (removed > 0) {
      ensureDir();
      fs.writeFileSync(BUS_PATH, valid.join('\n') + (valid.length > 0 ? '\n' : ''));
      console.log(`[MessageBus] Purge: ${removed} message(s) supprimé(s), ${valid.length} conservé(s)`);
    }
  } catch (err) {
    console.error(`[MessageBus] Erreur purge: ${err.message}`);
  }
}

module.exports = { publish, getMessages, purge };
