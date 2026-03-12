const fs = require('fs');
const path = require('path');
const config = require('./config');
const { attachImageSignals } = require('./image-match');
const { chooseBestSoldListings } = require('./matching');
const { getEbaySoldListings } = require('./marketplaces/ebay');
const { getVintedListings } = require('./marketplaces/vinted');
const { buildTelegramMessage, sendTelegramMessage } = require('./notifier');
const { buildProfitAnalysis, isOpportunity } = require('./profit');

async function ensureOutputDir(outputDir) {
  await fs.promises.mkdir(outputDir, { recursive: true });
}

async function runScan() {
  const opportunities = [];
  const searchedListings = [];

  for (const search of config.searches) {
    console.log(`Scan Vinted: ${search.name}`);

    let listings = [];
    try {
      listings = await getVintedListings(search, config);
    } catch (error) {
      console.error(`Impossible de lire Vinted pour ${search.name}: ${error.message}`);
      continue;
    }

    console.log(`  ${listings.length} annonce(s) candidates.`);

    for (const listing of listings) {
      try {
        const soldListings = await getEbaySoldListings(listing.title, config);
        const matchedSales = await attachImageSignals(
          listing,
          chooseBestSoldListings(listing, soldListings),
          config
        );
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
    searchedListings
  };
}

async function main() {
  await ensureOutputDir(config.outputDir);
  const result = await runScan();
  const outputPath = path.join(config.outputDir, 'latest-scan.json');

  await fs.promises.writeFile(outputPath, JSON.stringify(result, null, 2));

  console.log(`Scan termine. ${result.scannedCount} annonces analysees.`);
  console.log(`${result.opportunities.length} opportunite(s) detectee(s).`);
  console.log(`Resultat: ${outputPath}`);

  if (result.opportunities.length > 0) {
    const message = buildTelegramMessage(result);
    try {
      await sendTelegramMessage(config.telegram, message);
      console.log('Notification Telegram envoyee.');
    } catch (error) {
      console.error(`Notification Telegram impossible: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
