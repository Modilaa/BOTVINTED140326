/**
 * API Health Monitor — Surveille les quotas et erreurs des APIs externes.
 *
 * Envoie des alertes Telegram quand :
 *   - Le quota eBay Browse API est bas (< 500) ou épuisé (0)
 *   - PokemonTCG.io échoue 3 fois de suite
 *   - YGOPRODeck échoue 3 fois de suite
 *   - Vinted retourne 0 annonces 3 fois de suite (blocage potentiel)
 *   - OpenAI Vision échoue (clé invalide, quota dépassé)
 *
 * Anti-spam : cooldowns FICHIER (résistent aux redémarrages PM2).
 *   - Tout le reste : 1h
 */

const path = require('path');
const fs = require('fs');
const { sendTelegramMessage } = require('./notifier');
const { logDebugEvent } = require('./debug-protocol');

// ─── Fichier de persistance des alertes (résiste aux restarts PM2) ──────────

const ALERT_LOG_PATH = path.join(__dirname, '..', 'output', 'alert-log.json');

function getLastAlertTime(apiName) {
  try {
    const log = JSON.parse(fs.readFileSync(ALERT_LOG_PATH, 'utf8'));
    return log[apiName] || 0;
  } catch { return 0; }
}

function setLastAlertTime(apiName) {
  let log = {};
  try { log = JSON.parse(fs.readFileSync(ALERT_LOG_PATH, 'utf8')); } catch {}
  log[apiName] = Date.now();
  try { fs.writeFileSync(ALERT_LOG_PATH, JSON.stringify(log)); } catch {}
}

// ─── State ──────────────────────────────────────────────────────────────────

// Nombre d'erreurs consécutives par API (en mémoire — seulement pour le seuil)
const errorCounts = {};

// ─── Seuils de déclenchement ─────────────────────────────────────────────────

const thresholds = {
  'ebay-quota-low':      1, // immédiat
  'ebay-quota-zero':     1, // immédiat
  'pokemontcg':          3, // 3 erreurs consécutives
  'ygoprodeck':          3,
  'vinted-empty':        3, // 3 scans consécutifs sans annonces
  'openai-vision':       1  // immédiat
};

// ─── Cooldowns (en ms) ───────────────────────────────────────────────────────

const spamCooldown = {
  default:               3600000   // 1h pour tout le reste
};

// ─── Fonction principale ─────────────────────────────────────────────────────

/**
 * Vérifie l'état d'une API et envoie une alerte Telegram si nécessaire.
 *
 * @param {string}  apiName  - Identifiant de l'API (ex: 'pokemontcg')
 * @param {boolean} isError  - true = erreur / false = succès (reset compteur)
 * @param {string}  details  - Message de détail inclus dans l'alerte
 */
function checkAndAlert(apiName, isError, details) {
  if (isError) {
    errorCounts[apiName] = (errorCounts[apiName] || 0) + 1;
  } else {
    errorCounts[apiName] = 0; // reset sur succès
    return;
  }

  // Pas encore atteint le seuil
  if (errorCounts[apiName] < (thresholds[apiName] || 3)) return;

  // Anti-spam BULLETPROOF : cooldown stocké en fichier (survive aux restarts PM2)
  const cooldown = spamCooldown[apiName] !== undefined ? spamCooldown[apiName] : spamCooldown.default;
  const lastAlert = getLastAlertTime(apiName);
  if (Date.now() - lastAlert < cooldown) return;

  // Enregistrer l'heure AVANT l'envoi pour éviter les doublons en cas d'erreur async
  setLastAlertTime(apiName);

  // Log structuré root-cause
  logDebugEvent({
    phase: 'api-monitor',
    module: apiName,
    symptom: `${apiName} en erreur (${errorCounts[apiName]} fois consécutives)`,
    cause: details,
    hypothesis: 'Quota dépassé, IP bloquée ou service indisponible',
    fix: 'Alerte Telegram envoyée — surveillance active',
    verified: null,
    error: details
  });

  const telegramConfig = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  };

  const message = `⚠️ ALERTE API\n\n🔴 ${apiName}\n${details}\n\nLe bot continue de tourner mais cette source de prix est indisponible.`;
  sendTelegramMessage(telegramConfig, message).catch(() => {});
}

module.exports = { checkAndAlert, errorCounts };
