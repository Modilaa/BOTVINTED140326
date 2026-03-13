const fs = require('fs');
const path = require('path');
const config = require('./config');
const { attachImageSignals } = require('./image-match');
const { chooseBestSoldListings } = require('./matching');
const { getEbaySoldListings } = require('./marketplaces/ebay');
const { getVintedListings } = require('./marketplaces/vinted');
const { buildTelegramMessage, sendTelegramMessage } = require('./notifier');
const { buildProfitAnalysis, isOpportunity } = require('./profit');
const { findUnderpricedListings } = require('./underpriced');

async function ensureOutputDir(outputDir) {
  await fs.promises.mkdir(outputDir, { recursive: true });
}

async function runScan() {
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

    for (let i = 0; i < validListings.length; i += 1) {
      const listing = validListings[i];
      try {
        console.log(`  [${i + 1}/${validListings.length}] ${listing.title.slice(0, 60)}...`);
        const soldListings = await getEbaySoldListings(listing.title, config);

        // Also filter eBay sold listings under minimum price (auction bait)
        const validSoldListings = soldListings.filter((s) => s.totalPrice >= minPrice);

        const textMatches = chooseBestSoldListings(listing, validSoldListings);
        const matchedSales = await attachImageSignals(listing, textMatches, config);

        if (textMatches.length > 0 && matchedSales.length === 0) {
          console.log(`    ${textMatches.length} match(es) texte rejete(s) par image.`);
        } else if (matchedSales.length > 0) {
          const avgScore = matchedSales.reduce((s, m) => s + (m.imageMatch?.score || 0), 0) / matchedSales.length;
          console.log(`    ${matchedSales.length} match(es) valide(s) (img: ${(avgScore * 100).toFixed(0)}%)`);
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
          matchedSales,
          profit
        };

        searchedListings.push(row);

        if (isOpportunity(profit, config)) {
          opportunities.push(row);
          console.log(`  Opportunite: ${listing.title} -> ${profit.profit.toFixed(2)} EUR`);
        }
      } catch (error) {
        console.error(`  Erreur sur "${listing.title}": ${error.message}`);
      }
    }
  }

  opportunities.sort((left, right) => right.profit.profit - left.profit.profit);

  return {
    scannedAt: new Date().toISOString(),
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

async function runOnce() {
  await ensureOutputDir(config.outputDir);
  const result = await runScan();
  const outputPath = path.join(config.outputDir, 'latest-scan.json');

  await fs.promises.writeFile(outputPath, JSON.stringify(result, null, 2));

  console.log(`Scan termine. ${result.scannedCount} annonces analysees.`);
  console.log(`${result.opportunities.length} opportunite(s) detectee(s).`);
  console.log(`${result.underpricedAlerts.length} carte(s) sous-evaluee(s).`);
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

  return result;
}

const loopEnabled = process.argv.includes('--loop');
const loopIntervalMs = (function parseInterval() {
  const flag = process.argv.find((arg) => arg.startsWith('--interval='));
  return flag ? Number(flag.split('=')[1]) * 60 * 1000 : 30 * 60 * 1000;
})();

async function main() {
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
