'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { sleep } = require('./utils');

// ─────────────────────────────────────────────────────────────────────────────
// Tesseract OCR singleton (lazy init, reused across calls)
// undefined = not yet initialized, null = unavailable, object = ready
// ─────────────────────────────────────────────────────────────────────────────
let _ocrWorker = undefined; // eslint-disable-line no-undefined
let _ocrInitPromise = null;

async function getOcrWorker() {
  if (_ocrWorker !== undefined) return _ocrWorker; // fast path (null or worker)
  if (_ocrInitPromise) return _ocrInitPromise;      // wait for ongoing init

  _ocrInitPromise = (async () => {
    try {
      const { createWorker } = require('tesseract.js'); // eslint-disable-line global-require
      const worker = await createWorker('eng', 1, { logger: () => {} });
      _ocrWorker = worker;
      return worker;
    } catch (err) {
      console.warn('[image-match] OCR indisponible (tesseract.js):', err.message);
      _ocrWorker = null;
      return null;
    }
  })();

  return _ocrInitPromise;
}

process.on('beforeExit', async () => {
  if (_ocrWorker) {
    try { await _ocrWorker.terminate(); } catch (_) {}
    _ocrWorker = null;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache helpers
// ─────────────────────────────────────────────────────────────────────────────
const FINGERPRINT_VERSION = 2; // bump to invalidate old v1 caches

function buildCachePath(cacheDir, url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  return path.join(cacheDir, `${hash}.json`);
}

async function ensureCacheDir(cacheDir) {
  await fs.promises.mkdir(cacheDir, { recursive: true });
}

async function readFingerprintFromCache(cacheDir, url, ttlSeconds) {
  if (!ttlSeconds) return null;
  try {
    const raw = await fs.promises.readFile(buildCachePath(cacheDir, url), 'utf8');
    const payload = JSON.parse(raw);
    if (Date.now() - Number(payload.generatedAt || 0) > ttlSeconds * 1000) return null;
    const fp = payload.fingerprint;
    if (!fp || fp.version !== FINGERPRINT_VERSION) return null; // old format → re-compute
    return fp;
  } catch {
    return null;
  }
}

async function writeFingerprintToCache(cacheDir, url, fingerprint) {
  await fs.promises.writeFile(
    buildCachePath(cacheDir, url),
    JSON.stringify({ generatedAt: Date.now(), url, fingerprint })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic similarity helpers
// ─────────────────────────────────────────────────────────────────────────────
function hammingSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let same = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) same += 1;
  }
  return same / a.length;
}

function colorSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff += Math.abs(a[i] - b[i]);
  return 1 - diff / (a.length * 255);
}

function buildConfidenceLabel(score) {
  if (score === null || score === undefined || Number.isNaN(score)) return 'unknown';
  if (score >= 0.78) return 'high';
  if (score >= 0.64) return 'medium';
  return 'low';
}

// ─────────────────────────────────────────────────────────────────────────────
// Image download
// ─────────────────────────────────────────────────────────────────────────────
async function downloadImageBuffer(url) {
  const res = await fetch(url, {
    headers: {
      'cache-control': 'no-cache',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─────────────────────────────────────────────────────────────────────────────
// A) pHash — identical to v1 for backward-compatible legacy fields
// ─────────────────────────────────────────────────────────────────────────────
async function computePhash(buffer) {
  const grayPixels = async (w, h) => {
    const { data } = await sharp(buffer)
      .rotate()
      .resize(w, h, { fit: 'cover', position: 'centre' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data;
  };

  const avgPx = await grayPixels(16, 16);
  const threshold = avgPx.reduce((s, v) => s + v, 0) / avgPx.length;
  const averageHash = Array.from(avgPx, (v) => (v >= threshold ? '1' : '0')).join('');

  const diffPx = await grayPixels(17, 16);
  let differenceHash = '';
  for (let row = 0; row < 16; row += 1) {
    for (let col = 0; col < 16; col += 1) {
      const idx = row * 17 + col;
      differenceHash += diffPx[idx] >= diffPx[idx + 1] ? '1' : '0';
    }
  }

  const { data: rgbPx } = await sharp(buffer)
    .rotate()
    .resize(4, 4, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const averageColor = [0, 1, 2].map((ch) => {
    let total = 0;
    for (let i = ch; i < rgbPx.length; i += 3) total += rgbPx[i];
    return Math.round(total / 16);
  });

  return { averageHash, differenceHash, averageColor };
}

// ─────────────────────────────────────────────────────────────────────────────
// B) Border / frame color detection
//    Trading cards have distinctive colored borders (gold, silver, red, blue…)
//    We sample the outer rim (~7%) of the card image and classify the avg color.
// ─────────────────────────────────────────────────────────────────────────────
function classifyBorderColor(r, g, b) {
  const brightness = (r + g + b) / 3;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);

  if (brightness < 45)                                                return 'black';
  if (brightness > 185 && sat < 35)                                   return 'silver';
  // Gold: warm yellow — high R+G, low B, saturated
  if (r > 140 && g > 110 && b < 95 && sat > 55 && r >= g * 0.92)     return 'gold';
  // Red: dominant R channel
  if (r > 120 && r > g * 1.5 && r > b * 1.4)                         return 'red';
  // Blue: dominant B
  if (b > 100 && b > r * 1.25 && b >= g)                             return 'blue';
  // Green: dominant G
  if (g > 100 && g > r * 1.2 && g > b * 1.15)                        return 'green';
  // Purple: R and B both elevated, G depressed
  if (r > 70 && b > 70 && g < r * 0.75 && g < b * 0.75 && sat > 30) return 'purple';
  return 'other';
}

async function computeBorderFeatures(buffer) {
  const W = 120;
  const H = 168;
  const rim = 9; // ~7.5% — outer pixel ring representing the card border

  const { data } = await sharp(buffer)
    .rotate()
    .resize(W, H, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let n = 0;

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (y < rim || y >= H - rim || x < rim || x >= W - rim) {
        const i = (y * W + x) * 3;
        rSum += data[i];
        gSum += data[i + 1];
        bSum += data[i + 2];
        n += 1;
      }
    }
  }

  const r = Math.round(rSum / n);
  const g = Math.round(gSum / n);
  const b = Math.round(bSum / n);

  return { borderRgb: [r, g, b], borderColor: classifyBorderColor(r, g, b) };
}

// ─────────────────────────────────────────────────────────────────────────────
// C) OCR — card number + print run (/25, /50 …)
//    Crops bottom 22% of the card image (where the number is usually printed),
//    upscales 3× for better accuracy, then runs Tesseract locally.
// ─────────────────────────────────────────────────────────────────────────────
const KNOWN_PRINT_RUNS = new Set([5, 10, 25, 50, 75, 99, 100, 149, 150, 175, 199, 250, 499, 500]);

function parseCardNumber(text) {
  // "069/187" or "147/150" — most reliable format
  const m1 = text.match(/\b(\d{1,4})\/(\d{2,4})\b/);
  if (m1) return `${m1[1]}/${m1[2]}`;
  // "#147" format
  const m2 = text.match(/#(\d{1,4})\b/);
  if (m2) return `#${m2[1]}`;
  // Alphanumeric codes like RC32, PSA10
  const m3 = text.match(/\b([A-Z]{1,3}\d{1,4})\b/);
  if (m3) return m3[1];
  return null;
}

function parsePrintRun(text) {
  for (const m of text.matchAll(/\/(\d{1,3})\b/g)) {
    if (KNOWN_PRINT_RUNS.has(parseInt(m[1], 10))) return `/${m[1]}`;
  }
  return null;
}

async function computeOcrFeatures(buffer) {
  try {
    const meta = await sharp(buffer).rotate().metadata();
    const W = meta.width;
    const H = meta.height;
    const cropH = Math.max(25, Math.floor(H * 0.22));

    // Upscale 3× + grayscale + normalise contrast for better OCR accuracy
    const crop = await sharp(buffer)
      .rotate()
      .extract({ left: 0, top: H - cropH, width: W, height: cropH })
      .resize({ width: W * 3, kernel: 'lanczos3' })
      .grayscale()
      .normalise()
      .toBuffer();

    const worker = await getOcrWorker();
    if (!worker) return { cardNumber: null, printRun: null };

    const { data: { text } } = await worker.recognize(crop);
    return {
      cardNumber: parseCardNumber(text),
      printRun: parsePrintRun(text)
    };
  } catch {
    return { cardNumber: null, printRun: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// D) Grid brightness — 4×4 zone analysis
//    Resizes to 200×280, divides into 16 zones, computes avg brightness per zone.
//    Different parallels (refractor, holo, base) produce different brightness maps
//    even when showing the same player photo.
// ─────────────────────────────────────────────────────────────────────────────
async function computeGridBrightness(buffer) {
  const W = 200;
  const H = 280;
  const GX = 4;
  const GY = 4;

  const { data } = await sharp(buffer)
    .rotate()
    .resize(W, H, { fit: 'cover', position: 'centre' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const grid = [];
  for (let gy = 0; gy < GY; gy += 1) {
    for (let gx = 0; gx < GX; gx += 1) {
      const y0 = Math.floor(gy * H / GY);
      const y1 = Math.floor((gy + 1) * H / GY);
      const x0 = Math.floor(gx * W / GX);
      const x1 = Math.floor((gx + 1) * W / GX);
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          sum += data[y * W + x];
          n += 1;
        }
      }
      grid.push(n > 0 ? Math.round(sum / n) : 0);
    }
  }

  return grid;
}

function gridSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff += Math.abs(a[i] - b[i]);
  return 1 - diff / (a.length * 255);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint generation — all features computed in parallel, cached on disk
// ─────────────────────────────────────────────────────────────────────────────
async function generateFingerprint(url, config) {
  const cacheDir = path.join(config.outputDir, 'http-cache', 'image-fingerprints');
  await ensureCacheDir(cacheDir);

  const cached = await readFingerprintFromCache(cacheDir, url, config.cacheTtlSeconds);
  if (cached) return cached;

  await sleep(Math.max(150, Math.floor(config.httpMinDelayMs / 3)));
  const buffer = await downloadImageBuffer(url);

  // Run all analyses in parallel for speed
  const [phash, borderFeatures, gridBrightness, ocrFeatures] = await Promise.all([
    computePhash(buffer),
    computeBorderFeatures(buffer),
    computeGridBrightness(buffer),
    computeOcrFeatures(buffer)
  ]);

  const fingerprint = {
    version: FINGERPRINT_VERSION,
    ...phash,
    ...borderFeatures,
    gridBrightness,
    ...ocrFeatures
  };

  await writeFingerprintToCache(cacheDir, url, fingerprint);
  return fingerprint;
}

// ─────────────────────────────────────────────────────────────────────────────
// E + F) Combined scoring with hard caps + rich metadata
//
// Weights:
//   pHash (avg+diff hash)  → 20%
//   Border color match     → 25%   ← critical for parallels
//   Card number OCR        → 30%   ← most reliable identifier
//   Print run (/25 etc.)   → 10%
//   Grid brightness map    → 15%
//
// Hard caps:
//   Border mismatch (known colors differ) → score capped at 0.35
//   Number mismatch (both read, differ)   → score capped at 0.20
// ─────────────────────────────────────────────────────────────────────────────
async function compareListingImages(vintedImageUrl, ebayImageUrl, config) {
  if (!vintedImageUrl || !ebayImageUrl) return null;

  try {
    const [L, R] = await Promise.all([
      generateFingerprint(vintedImageUrl, config),
      generateFingerprint(ebayImageUrl, config)
    ]);

    // ── pHash ──────────────────────────────────────────────────────────────
    const aHashSim = hammingSimilarity(L.averageHash, R.averageHash);
    const dHashSim = hammingSimilarity(L.differenceHash, R.differenceHash);
    const rgbSim = colorSimilarity(L.averageColor, R.averageColor);
    const validHashes = [aHashSim, dHashSim].filter((v) => v !== null);
    const phashScore = validHashes.length > 0
      ? validHashes.reduce((s, v) => s + v, 0) / validHashes.length
      : null;

    // ── Border ─────────────────────────────────────────────────────────────
    const bothBordersKnown = L.borderColor !== 'other' && R.borderColor !== 'other';
    const borderMismatch = bothBordersKnown && L.borderColor !== R.borderColor;
    const borderMatch = bothBordersKnown && L.borderColor === R.borderColor;
    const borderScore = borderMatch ? 1.0 : borderMismatch ? 0.0 : 0.5;

    // ── Card number ────────────────────────────────────────────────────────
    const numberMismatch = Boolean(L.cardNumber && R.cardNumber && L.cardNumber !== R.cardNumber);
    const numberMatch = Boolean(L.cardNumber && R.cardNumber && L.cardNumber === R.cardNumber);
    const numberAvailable = Boolean(L.cardNumber || R.cardNumber);
    const numberScore = numberMatch ? 1.0 : numberMismatch ? 0.0 : 0.5;

    // ── Print run ──────────────────────────────────────────────────────────
    const printRunMismatch = Boolean(L.printRun && R.printRun && L.printRun !== R.printRun);
    const printRunMatch = Boolean(L.printRun && R.printRun && L.printRun === R.printRun);
    const printRunAvailable = Boolean(L.printRun || R.printRun);
    const printRunScore = printRunMatch ? 1.0 : printRunMismatch ? 0.0 : 0.5;

    // ── Grid brightness ────────────────────────────────────────────────────
    const gScore = gridSimilarity(L.gridBrightness, R.gridBrightness);

    // ── Weighted combination (normalize weight when feature is absent) ─────
    const parts = [
      { w: 0.20, s: phashScore,    avail: phashScore !== null },
      { w: 0.25, s: borderScore,   avail: true },
      { w: 0.30, s: numberScore,   avail: numberAvailable },
      { w: 0.10, s: printRunScore, avail: printRunAvailable },
      { w: 0.15, s: gScore,        avail: gScore !== null }
    ].filter((p) => p.avail);

    const totalW = parts.reduce((s, p) => s + p.w, 0);
    let score = parts.reduce((s, p) => s + p.s * p.w, 0) / (totalW || 1);

    // ── Hard caps for definitive mismatches ────────────────────────────────
    if (borderMismatch) score = Math.min(score, 0.35);
    if (numberMismatch) score = Math.min(score, 0.20);

    return {
      score,
      confidence: buildConfidenceLabel(score),
      method: 'enhanced-perceptual',
      // Border metadata
      vintedBorderColor: L.borderColor,
      ebayBorderColor: R.borderColor,
      borderMatch,
      // Card number metadata
      vintedCardNumber: L.cardNumber,
      ebayCardNumber: R.cardNumber,
      numberMatch,
      // Print run metadata
      vintedPrintRun: L.printRun,
      ebayPrintRun: R.printRun,
      printRunMatch,
      // Legacy fields (used by scoring.js / server.js)
      averageHashSimilarity: aHashSim,
      differenceHashSimilarity: dHashSim,
      rgbSimilarity: rgbSim
    };
  } catch (error) {
    return { score: null, confidence: 'unknown', error: error.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// attachImageSignals — same interface as v1, backward-compatible
// ─────────────────────────────────────────────────────────────────────────────
async function attachImageSignals(vintedListing, soldListings, config) {
  if (!Array.isArray(soldListings) || soldListings.length === 0) return soldListings;

  const minSim = config.minImageSimilarity || 0.60;
  const enrichedSales = [];

  for (const sale of soldListings) {
    const imageMatch = await compareListingImages(vintedListing.imageUrl, sale.imageUrl, config);
    const enriched = { ...sale, imageMatch };

    if (imageMatch && imageMatch.score !== null && imageMatch.score < minSim) {
      const detail = imageMatch.method === 'enhanced-perceptual'
        ? ` [${imageMatch.vintedBorderColor}→${imageMatch.ebayBorderColor}]`
        : '';
      console.log(`    Image rejetee (${(imageMatch.score * 100).toFixed(0)}%)${detail}: ${sale.title.slice(0, 50)}`);
      continue;
    }

    enrichedSales.push(enriched);
  }

  return enrichedSales;
}

module.exports = { attachImageSignals, compareListingImages };
