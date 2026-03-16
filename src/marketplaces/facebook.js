const { sleep } = require('../utils');

const APIFY_BASE = 'https://api.apify.com/v2';
const ACTOR_ID = 'curious_coder~facebook-marketplace';

/**
 * Run the Apify Facebook Marketplace scraper for a given search query.
 * Returns an array of normalized listing objects (same shape as Vinted listings).
 */
async function getFacebookMarketplaceListings(search, config) {
  const apiKey = process.env.APIFY_API_KEY;
  if (!apiKey) {
    console.log('  Facebook Marketplace: APIFY_API_KEY not set, skipping');
    return [];
  }

  const allListings = [];
  const seenIds = new Set();
  const queries = search.facebookQueries || search.vintedQueries || [];
  const maxItems = search.maxFacebookItems || 20;
  const location = search.facebookLocation || 'Paris, France';

  for (const query of queries.slice(0, 3)) { // Limit to 3 queries to save Apify credits
    try {
      const searchUrl = `https://www.facebook.com/marketplace/${encodeURIComponent(location)}/search?query=${encodeURIComponent(query)}&exact=false`;

      // Start the actor run
      const runResponse = await fetch(`${APIFY_BASE}/acts/${ACTOR_ID}/runs?waitForFinish=120`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          urls: [searchUrl],
          maxItems: Math.min(maxItems, 30)
        }),
        signal: AbortSignal.timeout(150000)
      });

      if (!runResponse.ok) {
        const errText = await runResponse.text();
        console.error(`  Facebook Marketplace API error (${runResponse.status}): ${errText.slice(0, 200)}`);
        continue;
      }

      const runData = await runResponse.json();
      const run = runData.data;

      if (!run || !run.defaultDatasetId) {
        console.log(`  Facebook: run started but no dataset ID`);
        continue;
      }

      // If still running, wait a bit more
      if (run.status === 'RUNNING') {
        await sleep(30000);
      }

      // Fetch results from the dataset
      const datasetUrl = `${APIFY_BASE}/datasets/${run.defaultDatasetId}/items?limit=${maxItems}`;
      const dataResponse = await fetch(datasetUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30000)
      });

      if (!dataResponse.ok) continue;

      const items = await dataResponse.json();
      if (!Array.isArray(items)) continue;

      for (const item of items) {
        const id = item.id;
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);

        const title = item.marketplace_listing_title || item.custom_title || '';
        if (!title) continue;

        const priceData = item.listing_price;
        const price = priceData ? parseFloat(priceData.amount || priceData.formatted_amount?.replace(/[^0-9.,]/g, '') || '0') : 0;
        if (price <= 0) continue;

        // Filter by max price
        if (search.maxPrice && price > search.maxPrice) continue;

        const imageUrl = item.primary_listing_photo?.image?.uri
          || item.primary_listing_photo_url
          || '';

        const city = item.location?.reverse_geocode?.city || '';
        const fbUrl = `https://www.facebook.com/marketplace/item/${id}`;

        allListings.push({
          title: title,
          rawTitle: title,
          listedPrice: price,
          buyerPrice: price, // Facebook has no buyer protection fee
          url: fbUrl,
          imageUrl: imageUrl,
          sourceQuery: query,
          marketplace: 'facebook',
          location: city,
          isSold: item.is_sold || false
        });
      }

      console.log(`  Facebook "${query}": ${items.length} resultats`);
    } catch (error) {
      console.error(`  Facebook Marketplace error for "${query}": ${error.message}`);
    }
  }

  // Filter out sold items
  const active = allListings.filter(l => !l.isSold);
  return active;
}

module.exports = {
  getFacebookMarketplaceListings
};
