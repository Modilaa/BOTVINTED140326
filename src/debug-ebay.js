const config = require('./config');
const { attachImageSignals } = require('./image-match');
const { chooseBestSoldListings } = require('./matching');
const { getEbaySoldListings } = require('./marketplaces/ebay');

async function main() {
  const rawArgs = process.argv.slice(2);
  const imageUrlArg = rawArgs.find((argument) => argument.startsWith('--image-url='));
  const title = rawArgs
    .filter((argument) => !argument.startsWith('--image-url='))
    .join(' ')
    .trim();
  if (!title) {
    throw new Error('Usage: node src/debug-ebay.js "<card title>" [--image-url=https://...]');
  }

  const imageUrl = imageUrlArg ? imageUrlArg.slice('--image-url='.length) : '';
  const soldListings = await getEbaySoldListings(title, config);
  const matchedSales = await attachImageSignals(
    { title, imageUrl },
    chooseBestSoldListings({ title }, soldListings),
    config
  );

  const payload = {
    title,
    imageUrl,
    soldCount: soldListings.length,
    soldListings: soldListings.slice(0, 20).map((listing) => ({
      title: listing.title,
      soldAt: listing.soldAt,
      soldText: listing.soldText,
      totalPrice: listing.totalPrice,
      marketplace: listing.marketplace,
      queryUsed: listing.queryUsed,
      imageUrl: listing.imageUrl,
      url: listing.url
    })),
    matchedSales: matchedSales.map((listing) => ({
      title: listing.title,
      soldAt: listing.soldAt,
      soldText: listing.soldText,
      totalPrice: listing.totalPrice,
      marketplace: listing.marketplace,
      queryUsed: listing.queryUsed,
      imageUrl: listing.imageUrl,
      imageMatch: listing.imageMatch,
      url: listing.url
    }))
  };

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
