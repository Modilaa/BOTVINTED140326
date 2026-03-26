/**
 * Script de migration : peuple dismissed-listings.json
 * à partir des opportunités déjà ignorées dans opportunities-history.json.
 *
 * Usage : node scripts/migrate-dismissed-blacklist.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HISTORY_PATH = path.join(__dirname, '..', 'output', 'opportunities-history.json');
const { addDismissed, getCount, flushSync } = require('../src/dismissed-listings');

function run() {
  if (!fs.existsSync(HISTORY_PATH)) {
    console.log('[migration] Pas de fichier opportunities-history.json — rien à migrer.');
    return;
  }

  let history;
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch (err) {
    console.error('[migration] Erreur lecture:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(history)) {
    console.log('[migration] Format inattendu (pas un tableau).');
    return;
  }

  const dismissed = history.filter((h) => h.status === 'dismissed' || h.status === 'rejected');
  console.log(`[migration] ${dismissed.length} annonce(s) ignorée(s) trouvée(s) dans l'historique.`);

  let added = 0;
  for (const opp of dismissed) {
    // Extraire l'ID Vinted depuis l'id stocké ou l'URL
    const vintedId = opp.id || (opp.url || '').match(/\/items\/(\d+)/)?.[1];
    if (vintedId || opp.title) {
      addDismissed(vintedId, opp.title);
      added++;
    }
  }

  flushSync();

  console.log(`[migration] ✅ ${added} entrée(s) ajoutée(s) à la blacklist.`);
  console.log(`[migration] Total blacklist : ${getCount()} entrée(s).`);
}

run();
