/**
 * Apify eBay Sold Listings Scraper
 *
 * Utilise l'acteur Apify "caffein.dev/ebay-sold-listings" pour récupérer
 * les ventes eBay réellement vendues (sold listings).
 *
 * Chaîne d'appels :
 *   1. POST /runs → lance le scraper
 *   2. Poll /runs/last → attend SUCCEEDED (max 30s)
 *   3. GET /runs/last/dataset/items → récupère les résultats
 *
 * Retourne un tableau de sold listings au format standard du pipeline :
 *   { title, price, totalPrice, soldAt, url, marketplace }
 *
 * Optimisations crédit :
 *   - maxItems = 10 (suffisant pour une médiane fiable)
 *   - Cache disque 7 jours (évite de refaire le même appel)
 *   - Budget journalier limité (APIFY_DAILY_LIMIT, défaut 50)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { checkAndAlert } = require('../api-monitor');

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const ACTOR_ID = 'caffein.dev~ebay-sold-listings';
const BASE_URL = 'https://api.apify.com/v2';

const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 30000;

// ─── Cache disque (7 jours) ──────────────────────────────────────────────────

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

function getCacheDir() {
  const dir = path.join(process.cwd(), 'output', 'http-cache', 'apify');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getCacheKey(query) {
  const normalized = query.toLowerCase().trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

function readCache(query) {
  try {
    const cachePath = path.join(getCacheDir(), `${getCacheKey(query)}.json`);
    const raw = fs.readFileSync(cachePath, 'utf8');
    const payload = JSON.parse(raw);
    if (Date.now() - payload.ts < CACHE_TTL_MS) {
      return payload.data;
    }
  } catch {}
  return null;
}

function writeCache(query, data) {
  try {
    const cachePath = path.join(getCacheDir(), `${getCacheKey(query)}.json`);
    fs.writeFileSync(cachePath, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

// ─── Budget journalier ───────────────────────────────────────────────────────

const USAGE_FILE = path.join(process.cwd(), 'output', 'apify-usage.json');
const DAILY_LIMIT = parseInt(process.env.APIFY_DAILY_LIMIT || '50', 10);

function loadUsage() {
  try {
    const raw = fs.readFileSync(USAGE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { date: '', count: 0 };
  }
}

function saveUsage(usage) {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
  } catch {}
}

function checkAndIncrementBudget() {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const usage = loadUsage();

  if (usage.date !== today) {
    // New day — reset counter
    usage.date = today;
    usage.count = 0;
  }

  if (usage.count >= DAILY_LIMIT) {
    checkAndAlert('apify-daily-limit', true, `Budget Apify journalier épuisé (${usage.count}/${DAILY_LIMIT} appels). Recharge demain.`);
    console.log(`    [APIFY] Budget journalier atteint (${usage.count}/${DAILY_LIMIT} appels) — skipping`);
    return false;
  }

  usage.count += 1;
  saveUsage(usage);

  // Alerte à 80% du budget journalier
  const limit80 = Math.floor(DAILY_LIMIT * 0.8);
  if (usage.count >= limit80) {
    checkAndAlert('apify-daily-80pct', true, `Budget Apify: ${usage.count}/${DAILY_LIMIT} appels aujourd'hui (80%)`);
  }

  console.log(`    [APIFY] Appel #${usage.count}/${DAILY_LIMIT} aujourd'hui`);
  return true;
}

// ─── Scraper principal ───────────────────────────────────────────────────────

/**
 * Lance le scraper Apify eBay Sold Listings et attend les résultats.
 *
 * @param {string} query - Mots-clés de recherche
 * @param {object} config - Config globale (non utilisée directement, pour cohérence)
 * @returns {{ prices: number[], medianPrice: number, resultCount: number, soldListings: object[], source: string }|null}
 */
async function getApifyEbaySoldPrices(query, config) {
  if (!APIFY_TOKEN) {
    console.log('    [APIFY] APIFY_API_TOKEN non défini — skipping');
    return null;
  }

  // ── Cache disque ──────────────────────────────────────────────────────────
  const cached = readCache(query);
  if (cached) {
    console.log(`    [APIFY] Cache hit pour "${query}" (${cached.soldListings?.length || 0} résultats)`);
    return cached;
  }

  // ── Budget journalier ─────────────────────────────────────────────────────
  if (!checkAndIncrementBudget()) {
    return null;
  }

  try {
    // ── 1. Lancer le scraper ─────────────────────────────────────────────────
    const runRes = await fetch(
      `${BASE_URL}/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword: query,
          maxItems: 10
        }),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!runRes.ok) {
      const body = await runRes.text();
      if (runRes.status === 403) {
        checkAndAlert('apify-monthly-limit', true, 'Quota mensuel Apify épuisé ! Recharger les crédits sur apify.com.');
      }
      console.log(`    [APIFY] Erreur lancement run (${runRes.status}): ${body.slice(0, 200)}`);
      return null;
    }

    const runData = await runRes.json();
    const runId = runData?.data?.id;
    if (!runId) {
      console.log('    [APIFY] Pas de runId dans la réponse');
      return null;
    }

    // ── 2. Attendre que le run se termine (poll toutes les 2s, max 30s) ──────
    const deadline = Date.now() + TIMEOUT_MS;
    let status = runData?.data?.status || 'RUNNING';

    while (status === 'RUNNING' || status === 'READY') {
      if (Date.now() >= deadline) {
        console.log(`    [APIFY] Timeout 30s atteint pour "${query}"`);
        return null;
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      const pollRes = await fetch(
        `${BASE_URL}/actor-runs/${runId}?token=${APIFY_TOKEN}`,
        { signal: AbortSignal.timeout(5000) }
      );

      if (!pollRes.ok) break;

      const pollData = await pollRes.json();
      status = pollData?.data?.status || 'RUNNING';
    }

    if (status !== 'SUCCEEDED') {
      console.log(`    [APIFY] Run terminé avec status: ${status}`);
      return null;
    }

    // ── 3. Récupérer les résultats ────────────────────────────────────────────
    const itemsRes = await fetch(
      `${BASE_URL}/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&clean=true`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (!itemsRes.ok) {
      console.log(`    [APIFY] Erreur récupération items (${itemsRes.status})`);
      return null;
    }

    const items = await itemsRes.json();
    if (!Array.isArray(items) || items.length === 0) {
      console.log(`    [APIFY] 0 item retourné pour "${query}"`);
      return null;
    }

    // ── 4. Extraire les prix ──────────────────────────────────────────────────
    const soldListings = [];

    for (const item of items) {
      // Les champs peuvent varier selon la version de l'acteur
      const rawPrice = item.price ?? item.soldPrice ?? item.finalPrice ?? null;
      if (rawPrice == null) continue;

      // Normaliser le prix (peut être "£12.99", "12.99", 12.99)
      const priceNum = typeof rawPrice === 'number'
        ? rawPrice
        : parseFloat(String(rawPrice).replace(/[^0-9.]/g, ''));

      if (!priceNum || priceNum <= 0) continue;

      const soldAtStr = item.soldDate || item.date || null;
      soldListings.push({
        title: item.title || item.name || query,
        price: priceNum,
        totalPrice: priceNum,
        soldAt: soldAtStr,
        soldAtTs: soldAtStr ? (Date.parse(soldAtStr) || Date.now()) : Date.now(),
        url: item.url || item.itemUrl || '',
        marketplace: 'ebay-apify'
      });
    }

    if (soldListings.length === 0) {
      console.log(`    [APIFY] 0 prix valide extrait pour "${query}"`);
      return null;
    }

    // ── 5. Calculer la médiane ────────────────────────────────────────────────
    const prices = soldListings.map(s => s.price).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const medianPrice = prices.length % 2 === 0
      ? (prices[mid - 1] + prices[mid]) / 2
      : prices[mid];

    console.log(`    [APIFY] Recherche "${query}" → ${soldListings.length} résultats, prix médian: ${medianPrice.toFixed(2)}€`);

    const result = {
      prices,
      medianPrice,
      resultCount: soldListings.length,
      soldListings,
      source: 'apify-ebay'
    };

    // ── 6. Sauvegarder en cache ───────────────────────────────────────────────
    writeCache(query, result);

    return result;

  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.log(`    [APIFY] Timeout réseau pour "${query}"`);
    } else {
      console.log(`    [APIFY] Erreur: ${err.message}`);
    }
    return null;
  }
}

module.exports = { getApifyEbaySoldPrices };
