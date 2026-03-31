const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sleep } = require('./utils');

const lastRequestByHost = new Map();

// ─── User-Agent rotation pool ──────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildCachePath(cacheDir, url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  return path.join(cacheDir, `${hash}.json`);
}

async function ensureCacheDir(cacheDir) {
  if (!cacheDir) {
    return;
  }

  await fs.promises.mkdir(cacheDir, { recursive: true });
}

async function readFromCache(cacheDir, url, ttlSeconds) {
  if (!cacheDir || !ttlSeconds) {
    return null;
  }

  const cachePath = buildCachePath(cacheDir, url);
  try {
    const raw = await fs.promises.readFile(cachePath, 'utf8');
    const payload = JSON.parse(raw);
    const ageMs = Date.now() - Number(payload.fetchedAt || 0);
    if (ageMs > ttlSeconds * 1000) {
      return null;
    }

    return payload.body;
  } catch (error) {
    return null;
  }
}

async function writeToCache(cacheDir, url, body) {
  if (!cacheDir) {
    return;
  }

  const cachePath = buildCachePath(cacheDir, url);
  const payload = {
    url,
    fetchedAt: Date.now(),
    body
  };

  await fs.promises.writeFile(cachePath, JSON.stringify(payload));
}

async function paceRequest(url, options) {
  const hostname = new URL(url).hostname;
  const minDelayMs = Number(options.minDelayMs || 0);
  const maxDelayMs = Number(options.maxDelayMs || minDelayMs);
  const delayMs = minDelayMs >= maxDelayMs
    ? minDelayMs
    : Math.floor(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));

  const lastRequestAt = lastRequestByHost.get(hostname) || 0;
  const waitMs = delayMs - (Date.now() - lastRequestAt);
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  lastRequestByHost.set(hostname, Date.now());
}

function detectBlockedPage(body) {
  const lowerBody = body.toLowerCase();
  const markers = [
    '<title>access denied',
    '<title>pardon our interruption',
    '<title>ci scusiamo',
    '<title>nous sommes',
    '<title>es tut uns leid',
    '<title>lo sentimos',
    'robot check',
    'unusual traffic',
    'please verify you are a human',
    'attention required',
    'captcha challenge',
    '/captcha/',
    'splashui',
    'captchatoken'
  ];
  return markers.some((marker) => lowerBody.includes(marker));
}

// Build proxy dispatcher for eBay requests
// Supports: PROXY_URL=http://user:pass@host:port (HTTP/HTTPS proxy)
//           SCRAPER_API_KEY=xxx (ScraperAPI fallback)
function getProxyUrl() {
  const url = process.env.PROXY_URL || process.env.HTTP_PROXY || null;
  // Rejeter les placeholders non configurés (USER:PASS, user:pass, etc.)
  if (url && /USER:PASS|user:pass|<user>|<pass>/i.test(url)) {
    return null;
  }
  return url;
}

function buildScraperApiUrl(url) {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) return null;
  try {
    if (!new URL(url).hostname.includes('ebay')) return null;
  } catch { return null; }
  return `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(url)}`;
}

function shouldProxy(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.includes('ebay') || hostname.includes('cardmarket');
  } catch { return false; }
}

// ─── Decodo Web Scraping API ─────────────────────────────────────────────────
let scrapingApiRequestCount = 0;

function resetScrapingApiCounter() {
  scrapingApiRequestCount = 0;
}

function isScrapingApiEnabled() {
  return ['1', 'true', 'yes', 'on'].includes((process.env.DECODO_SCRAPING_API || '').toLowerCase());
}

function getScrapingApiAuth() {
  // Priorité 1 : token explicite DECODO_AUTH_TOKEN (déjà en base64)
  const token = process.env.DECODO_AUTH_TOKEN || '';
  if (token) return token;

  // Priorité 2 : dériver depuis PROXY_URL (user:pass)
  const proxyUrl = process.env.PROXY_URL || '';
  if (!proxyUrl) return null;
  try {
    const parsed = new URL(proxyUrl);
    const user = decodeURIComponent(parsed.username || '');
    const pass = decodeURIComponent(parsed.password || '');
    if (!user || !pass) return null;
    return Buffer.from(`${user}:${pass}`).toString('base64');
  } catch {
    return null;
  }
}

function shouldUseScrapingApi(url) {
  if (!isScrapingApiEnabled()) return false;
  try {
    const hostname = new URL(url).hostname;
    // Exclure les endpoints API officiels (pas du HTML scraping)
    if (hostname.includes('svcs.ebay') || hostname === 'api.ebay.com') return false;
    return hostname.includes('ebay') || hostname.includes('cardmarket') || hostname.includes('leboncoin');
  } catch { return false; }
}

async function fetchViaScrapingApi(url) {
  const maxRequests = Number(process.env.MAX_SCRAPING_REQUESTS || 100);
  if (scrapingApiRequestCount >= maxRequests) {
    throw new Error(`[SCRAPING-API] Budget épuisé: ${maxRequests} requêtes max atteint pour ce scan`);
  }

  const auth = getScrapingApiAuth();
  if (!auth) {
    throw new Error('[SCRAPING-API] Credentials manquants dans PROXY_URL');
  }

  scrapingApiRequestCount++;
  const cumulativeCost = (scrapingApiRequestCount * 0.0005).toFixed(4);
  const hostname = new URL(url).hostname.replace('www.', '');
  console.log(`    [SCRAPING-API] Requête #${scrapingApiRequestCount} ce scan → ${hostname} (coût estimé: $${cumulativeCost})`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch('https://scraper-api.decodo.com/v2/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url, headless: 'html', proxy_pool: 'premium' }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Scraping API HTTP ${response.status} pour ${url}`);
    }

    const data = await response.json();
    const html = data.body || data.html || data.content || '';

    if (!html) {
      throw new Error(`Scraping API: réponse vide pour ${url}`);
    }

    return html;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, options = {}) {
  await ensureCacheDir(options.cacheDir);

  if (!options.skipCache) {
    const cachedBody = await readFromCache(options.cacheDir, url, options.cacheTtlSeconds);
    if (cachedBody && !detectBlockedPage(cachedBody)) {
      return cachedBody;
    }
  }

  await paceRequest(url, options);

  // ─── Decodo Web Scraping API (DECODO_SCRAPING_API=true) ───────────────────
  if (shouldUseScrapingApi(url)) {
    const body = await fetchViaScrapingApi(url);
    if (detectBlockedPage(body)) {
      throw new Error(`Blocked page detected for ${url}`);
    }
    if (!options.skipCache) {
      await writeToCache(options.cacheDir, url, body);
    }
    return body;
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 60000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const proxyUrl = getProxyUrl();
  const scraperApiUrl = buildScraperApiUrl(url);
  const useProxy = shouldProxy(url) && proxyUrl;
  const useScraperApi = shouldProxy(url) && !proxyUrl && scraperApiUrl;
  const fetchUrl = useScraperApi ? scraperApiUrl : url;

  const fetchOptions = {
    method: 'GET',
    redirect: 'follow',
    headers: useScraperApi ? {} : {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9,fr;q=0.8',
      'cache-control': 'no-cache',
      'user-agent': options.userAgent || getRandomUserAgent(),
      ...(options.headers || {})
    },
    signal: controller.signal
  };

  // Use HTTP proxy if configured (for residential proxy services like Decodo, SmartProxy etc.)
  if (useProxy) {
    try {
      const { ProxyAgent } = require('undici');
      fetchOptions.dispatcher = new ProxyAgent(proxyUrl);
      console.log(`    [PROXY] ${new URL(url).hostname} → via proxy`);
    } catch (proxyErr) {
      // undici ProxyAgent not available, try https-proxy-agent
      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        fetchOptions.agent = new HttpsProxyAgent(proxyUrl);
        console.log(`    [PROXY] ${new URL(url).hostname} → via https-proxy-agent`);
      } catch {
        // No proxy library available — log warning and fall through to direct fetch
        console.warn(`    [PROXY] ATTENTION: aucune lib proxy disponible (undici: ${proxyErr.message}). Requête directe!`);
      }
    }
  }

  try {
    const response = await fetch(fetchUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    const body = await response.text();
    if (detectBlockedPage(body)) {
      throw new Error(`Blocked page detected for ${url}`);
    }

    // Cache using original URL as key (not the proxied URL)
    if (!options.skipCache) {
      await writeToCache(options.cacheDir, url, body);
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}

// Purge blocked/captcha pages from cache directory so next scan retries them
async function purgeBlockedCache(cacheDir) {
  if (!cacheDir) return 0;
  try {
    const files = await fs.promises.readdir(cacheDir);
    let purged = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(cacheDir, file);
      try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const payload = JSON.parse(raw);
        if (payload.body && detectBlockedPage(payload.body)) {
          await fs.promises.unlink(filePath);
          purged++;
        }
      } catch { /* skip unreadable files */ }
    }
    if (purged > 0) {
      console.log(`Cache ${path.basename(cacheDir)}: ${purged} page(s) bloquee(s) purgee(s).`);
    }
    return purged;
  } catch { return 0; }
}

/**
 * Purge expired cache files from a directory based on file modification time.
 * Unlike readFromCache (which checks TTL per-read), this actually DELETES old files
 * to reclaim disk space. Critical for VPS with limited storage.
 *
 * @param {string} cacheDir - Path to cache directory
 * @param {number} maxAgeSeconds - Delete files older than this (default: 6h)
 * @returns {number} Number of files deleted
 */
async function purgeExpiredDiskCache(cacheDir, maxAgeSeconds = 6 * 3600) {
  if (!cacheDir) return 0;
  try {
    const entries = await fs.promises.readdir(cacheDir, { withFileTypes: true });
    const now = Date.now();
    const maxAgeMs = maxAgeSeconds * 1000;
    let purged = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const filePath = path.join(cacheDir, entry.name);
        const stat = await fs.promises.stat(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.promises.unlink(filePath);
          purged++;
        }
      } catch { /* skip individual file errors */ }
    }

    if (purged > 0) {
      console.log(`[cache-purge] ${path.basename(cacheDir)}: ${purged} fichier(s) expire(s) supprime(s)`);
    }
    return purged;
  } catch { return 0; }
}

module.exports = {
  fetchText,
  fetchViaScrapingApi,
  resetScrapingApiCounter,
  purgeBlockedCache,
  purgeExpiredDiskCache
};
