const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sleep } = require('./utils');

const lastRequestByHost = new Map();

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
    'robot check',
    'unusual traffic',
    'please verify you are a human',
    'attention required',
    'captcha challenge',
    '/captcha/'
  ];
  return markers.some((marker) => lowerBody.includes(marker));
}

// Build ScraperAPI URL if configured and target is eBay
function buildProxiedUrl(url) {
  const scraperApiKey = process.env.SCRAPER_API_KEY;
  if (!scraperApiKey) {
    return null;
  }

  // Only proxy eBay requests
  try {
    const hostname = new URL(url).hostname;
    if (!hostname.includes('ebay')) {
      return null;
    }
  } catch {
    return null;
  }

  return `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(url)}`;
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

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 60000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Use ScraperAPI proxy for eBay if configured
  const proxiedUrl = buildProxiedUrl(url);
  const fetchUrl = proxiedUrl || url;

  try {
    const response = await fetch(fetchUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: proxiedUrl ? {} : {
        'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
        'user-agent': options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        ...(options.headers || {})
      },
      signal: controller.signal
    });

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

module.exports = {
  fetchText
};
