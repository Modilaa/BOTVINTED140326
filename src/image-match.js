const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { sleep } = require('./utils');

function buildCachePath(cacheDir, url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  return path.join(cacheDir, `${hash}.json`);
}

async function ensureCacheDir(cacheDir) {
  await fs.promises.mkdir(cacheDir, { recursive: true });
}

async function readFingerprintFromCache(cacheDir, url, ttlSeconds) {
  if (!ttlSeconds) {
    return null;
  }

  const cachePath = buildCachePath(cacheDir, url);
  try {
    const raw = await fs.promises.readFile(cachePath, 'utf8');
    const payload = JSON.parse(raw);
    const ageMs = Date.now() - Number(payload.generatedAt || 0);
    if (ageMs > ttlSeconds * 1000) {
      return null;
    }

    return payload.fingerprint || null;
  } catch (error) {
    return null;
  }
}

async function writeFingerprintToCache(cacheDir, url, fingerprint) {
  const cachePath = buildCachePath(cacheDir, url);
  const payload = {
    generatedAt: Date.now(),
    url,
    fingerprint
  };
  await fs.promises.writeFile(cachePath, JSON.stringify(payload));
}

function hammingSimilarity(leftBits, rightBits) {
  if (!leftBits || !rightBits || leftBits.length !== rightBits.length) {
    return null;
  }

  let sameCount = 0;
  for (let index = 0; index < leftBits.length; index += 1) {
    if (leftBits[index] === rightBits[index]) {
      sameCount += 1;
    }
  }

  return sameCount / leftBits.length;
}

function colorSimilarity(left, right) {
  if (!left || !right || left.length !== right.length) {
    return null;
  }

  let totalDifference = 0;
  for (let index = 0; index < left.length; index += 1) {
    totalDifference += Math.abs(left[index] - right[index]);
  }

  const maxDifference = left.length * 255;
  return 1 - (totalDifference / maxDifference);
}

function buildConfidenceLabel(score) {
  if (score === null || score === undefined || Number.isNaN(score)) {
    return 'unknown';
  }

  if (score >= 0.78) {
    return 'high';
  }

  if (score >= 0.64) {
    return 'medium';
  }

  return 'low';
}

async function downloadImageBuffer(url) {
  const response = await fetch(url, {
    headers: {
      'cache-control': 'no-cache',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function extractGrayscalePixels(buffer, width, height) {
  const { data } = await sharp(buffer)
    .rotate()
    .resize(width, height, {
      fit: 'cover',
      position: 'centre'
    })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return data;
}

async function extractRgbPixels(buffer, width, height) {
  const { data } = await sharp(buffer)
    .rotate()
    .resize(width, height, {
      fit: 'cover',
      position: 'centre'
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return data;
}

async function generateFingerprint(url, config) {
  const cacheDir = path.join(config.outputDir, 'http-cache', 'image-fingerprints');
  await ensureCacheDir(cacheDir);

  const cached = await readFingerprintFromCache(cacheDir, url, config.cacheTtlSeconds);
  if (cached) {
    return cached;
  }

  await sleep(Math.max(150, Math.floor(config.httpMinDelayMs / 3)));

  const buffer = await downloadImageBuffer(url);
  const averageHashPixels = await extractGrayscalePixels(buffer, 16, 16);
  const averageThreshold = averageHashPixels.reduce((sum, value) => sum + value, 0) / averageHashPixels.length;
  const averageHash = Array.from(averageHashPixels, (value) => (value >= averageThreshold ? '1' : '0')).join('');

  const differenceHashPixels = await extractGrayscalePixels(buffer, 17, 16);
  let differenceHash = '';
  for (let row = 0; row < 16; row += 1) {
    for (let column = 0; column < 16; column += 1) {
      const leftIndex = (row * 17) + column;
      const rightIndex = leftIndex + 1;
      differenceHash += differenceHashPixels[leftIndex] >= differenceHashPixels[rightIndex] ? '1' : '0';
    }
  }

  const rgbPixels = await extractRgbPixels(buffer, 4, 4);
  const averageColor = [0, 1, 2].map((channelOffset) => {
    let channelTotal = 0;
    for (let index = channelOffset; index < rgbPixels.length; index += 3) {
      channelTotal += rgbPixels[index];
    }
    return Math.round(channelTotal / 16);
  });

  const fingerprint = {
    averageHash,
    differenceHash,
    averageColor
  };

  await writeFingerprintToCache(cacheDir, url, fingerprint);
  return fingerprint;
}

async function compareListingImages(vintedImageUrl, ebayImageUrl, config) {
  if (!vintedImageUrl || !ebayImageUrl) {
    return null;
  }

  try {
    const [left, right] = await Promise.all([
      generateFingerprint(vintedImageUrl, config),
      generateFingerprint(ebayImageUrl, config)
    ]);

    const averageHashSimilarity = hammingSimilarity(left.averageHash, right.averageHash);
    const differenceHashSimilarity = hammingSimilarity(left.differenceHash, right.differenceHash);
    const rgbSimilarity = colorSimilarity(left.averageColor, right.averageColor);
    const similarityParts = [averageHashSimilarity, differenceHashSimilarity, rgbSimilarity]
      .filter((value) => value !== null);
    const score = similarityParts.length > 0
      ? similarityParts.reduce((sum, value) => sum + value, 0) / similarityParts.length
      : null;

    return {
      score,
      confidence: buildConfidenceLabel(score),
      averageHashSimilarity,
      differenceHashSimilarity,
      rgbSimilarity
    };
  } catch (error) {
    return {
      score: null,
      confidence: 'unknown',
      error: error.message
    };
  }
}

async function attachImageSignals(vintedListing, soldListings, config) {
  if (!Array.isArray(soldListings) || soldListings.length === 0) {
    return soldListings;
  }

  const enrichedSales = [];
  for (const sale of soldListings) {
    const imageMatch = await compareListingImages(vintedListing.imageUrl, sale.imageUrl, config);
    enrichedSales.push({
      ...sale,
      imageMatch
    });
  }

  return enrichedSales;
}

module.exports = {
  attachImageSignals,
  compareListingImages
};
