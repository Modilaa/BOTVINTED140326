'use strict';

// Telegram callback polling — handles inline keyboard actions from opportunity alerts.
// Polls getUpdates every 5 seconds (no webhook required).
// Actions: buy_XXX → portfolio add, ignore_XXX → dismiss, verify_XXX → price verify.

const https = require('https');
const http = require('http');
const { updateState: updateOppState } = require('./opportunity-state');

let _lastUpdateId = 0;
let _pollingTimeout = null;
let _token = null;
let _consecutiveErrors = 0;
const MAX_POLL_INTERVAL = 60000; // 1 minute max entre les polls en cas d'erreurs

// ─── HTTP helpers ──────────────────────────────────────────────────────────

function telegramPost(method, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${_token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let resBody = '';
      res.on('data', (chunk) => { resBody += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(resBody)); } catch { resolve({ ok: false, raw: resBody }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function telegramGet(method, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${_token}/${method}${qs ? '?' + qs : ''}`,
      method: 'GET'
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ ok: false, raw: body }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function localPost(apiPath, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const port = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
    const options = {
      hostname: 'localhost',
      port,
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = http.request(options, (res) => {
      let resBody = '';
      res.on('data', (chunk) => { resBody += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(resBody)); } catch { resolve({ raw: resBody }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Callback handlers ────────────────────────────────────────────────────

async function answerCallback(callbackQueryId, text) {
  try {
    await telegramPost('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
  } catch (err) {
    console.error('[TG-Handler] answerCallbackQuery error:', err.message);
  }
}

async function sendTgMessage(chatId, text) {
  try {
    await telegramPost('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[TG-Handler] sendMessage error:', err.message);
  }
}

async function handleCallback(query) {
  const { id: callbackQueryId, from, data, message } = query;
  const chatId = (from && from.id) || (message && message.chat && message.chat.id) || null;

  if (!data || !chatId) return;

  if (data.startsWith('buy_')) {
    const oppId = data.slice(4);
    try {
      const result = await localPost('/api/portfolio/add', { vintedId: oppId });
      if (result.success) {
        // State machine : transition → accepted
        try { updateOppState(oppId, { status: 'accepted', by: 'telegram' }); } catch { /* ignore */ }
        await answerCallback(callbackQueryId, '✅ Ajouté au portfolio!');
      } else {
        await answerCallback(callbackQueryId, '❌ Erreur: ' + (result.error || 'Inconnu'));
      }
    } catch (err) {
      await answerCallback(callbackQueryId, '❌ Erreur: ' + err.message);
    }

  } else if (data.startsWith('ignore_')) {
    const oppId = data.slice(7);
    try {
      const result = await localPost(`/api/opportunities/${oppId}/status`, { status: 'dismissed' });
      if (result.success) {
        // State machine : transition → dismissed
        try { updateOppState(oppId, { status: 'dismissed', by: 'telegram' }); } catch { /* ignore */ }
        await answerCallback(callbackQueryId, '❌ Ignoré');
      } else {
        await answerCallback(callbackQueryId, '❌ Erreur: ' + (result.error || 'Inconnu'));
      }
    } catch (err) {
      await answerCallback(callbackQueryId, '❌ Erreur: ' + err.message);
    }

  } else if (data.startsWith('verify_')) {
    const oppId = data.slice(7);
    await answerCallback(callbackQueryId, '🔍 Vérification en cours...');
    try {
      const result = await localPost('/api/verify-opportunity', { id: oppId });
      if (result.success && result.result) {
        const r = result.result;
        const msg = r.confirmed
          ? `✅ *Confirmé!* Prix: ${r.newPrice}€ via ${r.source} (diff: ${r.diff}%)`
          : `⚠️ *Prix différent:* ${r.newPrice}€ via ${r.source} (diff: ${r.diff}%)`;
        await sendTgMessage(chatId, msg);
      } else {
        await sendTgMessage(chatId, '❌ Vérification échouée: ' + (result.error || 'Inconnu'));
      }
    } catch (err) {
      await sendTgMessage(chatId, '❌ Erreur vérification: ' + err.message);
    }
  }
}

// ─── Polling loop ─────────────────────────────────────────────────────────

async function poll() {
  try {
    const response = await telegramGet('getUpdates', {
      offset: _lastUpdateId + 1,
      timeout: 30, // Long polling (30s) — plus efficace que short polling
      allowed_updates: JSON.stringify(['callback_query'])
    });

    if (response.ok && Array.isArray(response.result) && response.result.length > 0) {
      for (const update of response.result) {
        _lastUpdateId = Math.max(_lastUpdateId, update.update_id);
        if (update.callback_query) {
          handleCallback(update.callback_query).catch((err) => {
            console.error('[TG-Handler] handleCallback error:', err && err.message || err);
          });
        }
      }
    }

    // Succès → reset le compteur d'erreurs
    _consecutiveErrors = 0;
  } catch (err) {
    _consecutiveErrors++;
    // Log uniquement toutes les 10 erreurs pour ne pas spammer
    if (_consecutiveErrors <= 3 || _consecutiveErrors % 10 === 0) {
      console.error(`[TG-Handler] poll error (x${_consecutiveErrors}):`, err && err.message || String(err) || 'unknown');
    }
  }

  // Backoff exponentiel en cas d'erreurs consécutives : 5s, 10s, 20s, 40s, max 60s
  const delay = _consecutiveErrors > 0
    ? Math.min(5000 * Math.pow(2, _consecutiveErrors - 1), MAX_POLL_INTERVAL)
    : 1000; // 1s entre les polls normaux (le long polling fait déjà le gros du délai)
  _pollingTimeout = setTimeout(poll, delay);
}

// ─── Public API ───────────────────────────────────────────────────────────

function start() {
  _token = process.env.TELEGRAM_BOT_TOKEN;
  if (!_token) {
    return; // silently skip — not configured
  }
  console.log('[TG-Handler] Telegram callback polling started (5s interval).');
  poll();
}

function stop() {
  if (_pollingTimeout) {
    clearTimeout(_pollingTimeout);
    _pollingTimeout = null;
  }
}

module.exports = { start, stop };
