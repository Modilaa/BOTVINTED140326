const fs = require('fs');
const path = require('path');
const config = require('./config');
const { attachImageSignals } = require('./image-match');
const { chooseBestSoldListings } = require('./matching');
const { getEbaySoldListings } = require('./marketplaces/ebay');
const { getPokemonMarketPrice } = require('./marketplaces/pokemon-tcg');
const { getYugiohMarketPrice } = require('./marketplaces/ygoprodeck');
const { getVintedListings } = require('./marketplaces/vinted');
const { buildTelegramMessage, sendTelegramMessage } = require('./notifier');
const { buildProfitAnalysis, isOpportunity } = require('./profit');
const { findUnderpricedListings } = require('./underpriced');

async function ensureOutputDir(outputDir) {
  await fs.promises.mkdir(outputDir, { recursive: true });
}

// Save current scan state to disk and notify dashboard
// previousListings = cards from previous scans (history) to keep visible during scan
async function flushProgress(outputDir, opportunities, underpricedAlerts, searchedListings, previousListings) {
  // Combine current scan progress with previous history
  const previousByUrl = new Map();
  for (const prev of previousListings) {
    previousByUrl.set(prev.url, prev);
  }
  // Current scan items override previous ones with same URL
  for (const item of searchedListings) {
    previousByUrl.set(item.url, item);
  }
  const allListings = [...previousByUrl.values()];

  const snapshot = {
    scannedAt: new Date().toISOString(),
    scanning: true,
    thresholds: {
      minProfitEur: config.minProfitEur,
      minProfitPercent: config.minProfitPercent
    },
    scannedCount: searchedListings.length,
    opportunities: [...opportunities].sort((a, b) => b.profit.profit - a.profit.profit),
    underpricedAlerts,
    searchedListings: allListings
  };
  const outputPath = path.join(outputDir, 'latest-scan.json');
  await fs.promises.writeFile(outputPath, JSON.stringify(snapshot, null, 2));
  if (global._broadcastSSE) {
    global._broadcastSSE({ type: 'scan-update' });
  }
}

async function runScan(previousListings) {
  const opportunities = [];
  const searchedListings = [];
  const underpricedAlerts = [];
  const minPrice = config.minListingPriceEur || 2;

  for (const search of config.searches) {
    console.log(`Scan Vinted: ${search.name}`);

    let listings = [];
    try {
      listings = await getVintedListings(search, config);
    } catch (error) {
      console.error(`Impossible de lire Vinted pour ${search.name}: ${error.message}`);
      continue;
    }

    // Filter out bait listings (< 2 EUR = auction bait)
    const validListings = listings.filter((l) => l.buyerPrice >= minPrice);
    const filtered = listings.length - validListings.length;
    if (filtered > 0) {
      console.log(`  ${listings.length} brutes -> ${validListings.length} valides (${filtered} < ${minPrice}EUR ignorees)`);
    } else {
      console.log(`  ${validListings.length} annonce(s) candidates.`);
    }

    // Detect underpriced cards (same card, much cheaper than others on Vinted)
    const searchUnderpriced = findUnderpricedListings(validListings, config);
    for (const alert of searchUnderpriced) {
      underpricedAlerts.push({ search: search.name, ...alert });
      console.log(`  SOUS-EVALUE: ${alert.listing.title.slice(0, 50)} -> ${alert.listing.buyerPrice}EUR vs median ${alert.medianPrice}EUR (-${alert.discount}%)`);
    }

    const pricingSource = search.pricingSource || 'ebay';
    const useApi = pricingSource !== 'ebay';
    if (useApi) {
      console.log(`  Source de prix: ${pricingSource} (API directe)`);
    }

    // For eBay-based searches, limit items to avoid rate limiting
    const effectiveLimit = useApi ? validListings.length : Math.min(validListings.length, config.maxItemsPerSearch);
    const itemsToProcess = validListings.slice(0, effectiveLimit);

    for (let i = 0; i < itemsToProcess.length; i += 1) {
      const listing = itemsToProcess[i];
      try {
        console.log(`  [${i + 1}/${itemsToProcess.length}] ${listing.title.slice(0, 60)}...`);

        let matchedSales = [];

        if (pricingSource === 'pokemon-tcg-api') {
          // Use Pokemon TCG API for pricing
          const apiResult = await getPokemonMarketPrice(listing, config);
          if (apiResult && apiResult.matchedSales.length > 0) {
            matchedSales = apiResult.matchedSales;
            console.log(`    API: ${apiResult.bestMatch} -> ${apiResult.marketPrice.toFixed(2)} EUR (${apiResult.confidence})`);
          } else {
            console.log(`    API: pas de match Pokemon`);
          }
        } else if (pricingSource === 'ygoprodeck') {
          // Use YGOPRODeck API for pricing
          const apiResult = await getYugiohMarketPrice(listing, config);
          if (apiResult && apiResult.matchedSales.length > 0) {
            matchedSales = apiResult.matchedSales;
            console.log(`    API: ${apiResult.bestMatch} -> ${apiResult.marketPrice.toFixed(2)} EUR (${apiResult.confidence})`);
          } else {
            console.log(`    API: pas de match Yu-Gi-Oh`);
          }
        } else {
          // eBay scraping flow (Topps, Panini, One Piece, etc.)
          const soldListings = await getEbaySoldListings(listing.title, config);
          const validSoldListings = soldListings.filter((s) => s.totalPrice >= minPrice);
          const textMatches = chooseBestSoldListings(listing, validSoldListings);
          matchedSales = await attachImageSignals(listing, textMatches, config);

          if (textMatches.length > 0 && matchedSales.length === 0) {
            console.log(`    ${textMatches.length} match(es) texte rejete(s) par image.`);
          } else if (matchedSales.length > 0) {
            const avgScore = matchedSales.reduce((s, m) => s + (m.imageMatch?.score || 0), 0) / matchedSales.length;
            console.log(`    ${matchedSales.length} match(es) valide(s) (img: ${(avgScore * 100).toFixed(0)}%)`);
          }
        }

        const profit = buildProfitAnalysis(listing, matchedSales, config);

        const row = {
          search: search.name,
          title: listing.title,
          vintedListedPrice: listing.listedPrice,
          vintedBuyerPrice: listing.buyerPrice,
          sourceQuery: listing.sourceQuery || '',
          url: listing.url,
          imageUrl: listing.imageUrl,
          rawTitle: listing.rawTitle,
          pricingSource,
          matchedSales,
          profit
        };

        searchedListings.push(row);

        if (isOpportunity(profit, config)) {
          opportunities.push(row);
          console.log(`  Opportunite: ${listing.title} -> ${profit.profit.toFixed(2)} EUR`);
        }

        // Flush progress to dashboard after each listing (include history so count doesn't reset)
        await flushProgress(config.outputDir, opportunities, underpricedAlerts, searchedListings, previousListings);
      } catch (error) {
        console.error(`  Erreur sur "${listing.title}": ${error.message}`);
      }
    }
  }

  opportunities.sort((left, right) => right.profit.profit - left.profit.profit);

  return {
    scannedAt: new Date().toISOString(),
    scanning: false,
    thresholds: {
      minProfitEur: config.minProfitEur,
      minProfitPercent: config.minProfitPercent
    },
    scannedCount: searchedListings.length,
    opportunities,
    underpricedAlerts,
    searchedListings
  };
}

// Load previous scan results and merge with new ones to persist cards across scans
function mergeWithHistory(newResult, outputDir, previousData) {
  const previousListings = (previousData && previousData.searchedListings) || [];
  const previousAlertsList = (previousData && previousData.underpricedAlerts) || [];

  // Index new listings by Vinted URL for fast lookup
  const newByUrl = new Map();
  for (const listing of newResult.searchedListings) {
    listing.lastSeenAt = newResult.scannedAt;
    listing.firstSeenAt = listing.firstSeenAt || newResult.scannedAt;
    newByUrl.set(listing.url, listing);
  }

  // Keep previous listings that are NOT in the new scan (they persist)
  const maxAgeDays = 7; // Keep cards for up to 7 days
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  for (const prev of previousListings) {
    if (newByUrl.has(prev.url)) {
      // Card found again — update but keep firstSeenAt
      const updated = newByUrl.get(prev.url);
      updated.firstSeenAt = prev.firstSeenAt || prev.lastSeenAt || newResult.scannedAt;
      continue;
    }

    // Card not in current scan — keep it if not too old and not archived
    const seenAt = Date.parse(prev.lastSeenAt || prev.firstSeenAt || 0);
    if (prev.archived || (seenAt && seenAt < cutoff)) {
      continue; // Drop archived or expired cards
    }

    prev.stale = true; // Mark as not found in latest scan
    newByUrl.set(prev.url, prev);
  }

  // Also preserve previous opportunities not in current scan
  const newOppUrls = new Set(newResult.opportunities.map((o) => o.url));
  const previousOpps = previousListings
    .filter((l) => !newOppUrls.has(l.url) && !l.archived)
    .filter((l) => {
      const profit = l.profit;
      if (!profit) return false;
      return profit.profit >= config.minProfitEur && profit.profitPercent >= config.minProfitPercent;
    });

  const mergedListings = [...newByUrl.values()];
  const mergedOpportunities = [...newResult.opportunities, ...previousOpps];

  // Merge underpriced alerts similarly
  const newAlertUrls = new Set((newResult.underpricedAlerts || []).map((a) => a.listing?.url));
  const previousAlerts = previousAlertsList
    .filter((a) => a.listing && !newAlertUrls.has(a.listing.url));

  return {
    ...newResult,
    searchedListings: mergedListings,
    opportunities: mergedOpportunities,
    underpricedAlerts: [...(newResult.underpricedAlerts || []), ...previousAlerts]
  };
}

async function runOnce() {
  await ensureOutputDir(config.outputDir);

  // Save previous history BEFORE the scan (flushProgress will overwrite latest-scan.json)
  const historyPath = path.join(config.outputDir, 'latest-scan.json');
  let previousData = null;
  try {
    if (fs.existsSync(historyPath)) {
      previousData = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    }
  } catch {
    previousData = null;
  }

  const previousListings = (previousData && previousData.searchedListings) || [];
  const result = await runScan(previousListings);
  const merged = mergeWithHistory(result, config.outputDir, previousData);
  const outputPath = path.join(config.outputDir, 'latest-scan.json');

  await fs.promises.writeFile(outputPath, JSON.stringify(merged, null, 2));

  // Notify dashboard to refresh
  if (global._broadcastSSE) {
    global._broadcastSSE({ type: 'scan-update' });
    console.log('Dashboard notifie.');
  }

  console.log(`Scan termine. ${result.scannedCount} annonces analysees (${merged.searchedListings.length} total avec historique).`);
  console.log(`${merged.opportunities.length} opportunite(s) detectee(s).`);
  console.log(`${merged.underpricedAlerts.length} carte(s) sous-evaluee(s).`);
  console.log(`Resultat: ${outputPath}`);

  if (result.opportunities.length > 0 || result.underpricedAlerts.length > 0) {
    const message = buildTelegramMessage(result);
    try {
      await sendTelegramMessage(config.telegram, message);
      console.log('Notification Telegram envoyee.');
    } catch (error) {
      console.error(`Notification Telegram impossible: ${error.message}`);
    }
  }

  return merged;
}

const loopEnabled = process.argv.includes('--loop');
const loopIntervalMs = (function parseInterval() {
  const flag = process.argv.find((arg) => arg.startsWith('--interval='));
  return flag ? Number(flag.split('=')[1]) * 60 * 1000 : 30 * 60 * 1000;
})();

async function main() {
  // Launch dashboard server automatically
  const { broadcastSSE } = require('./server');
  global._broadcastSSE = broadcastSSE;

  if (!loopEnabled) {
    await runOnce();
    return;
  }

  console.log(`Mode boucle active. Scan toutes les ${loopIntervalMs / 60000} minutes.`);
  console.log('Appuie sur Ctrl+C pour arreter.\n');

  while (true) {
    const startedAt = Date.now();
    try {
      await runOnce();
    } catch (error) {
      console.error(`Erreur pendant le scan: ${error.message}`);
    }

    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(0, loopIntervalMs - elapsed);
    const nextScanAt = new Date(Date.now() + waitMs).toLocaleTimeString('fr-FR');
    console.log(`\nProchain scan a ${nextScanAt} ...\n`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
