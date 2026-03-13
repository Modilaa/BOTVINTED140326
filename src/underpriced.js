const { extractCardSignature } = require('./matching');
const { compareListingImages } = require('./image-match');

/**
 * Build a comparable key from a card signature for grouping similar cards.
 * Two cards with the same groupKey are considered "the same card".
 */
function buildGroupKey(signature) {
  const parts = [];

  // Identity tokens (player/character name) are the primary grouping signal
  if (signature.identityTokens.length > 0) {
    parts.push(signature.identityTokens.sort().join('+'));
  }

  // Card number is a strong secondary signal
  if (signature.cardNumber) {
    parts.push(`#${signature.cardNumber}`);
  }

  // Year helps distinguish editions
  if (signature.year) {
    parts.push(signature.year);
  }

  // Variant tokens (color parallels, print runs) distinguish parallels
  if (signature.variantTokens.length > 0) {
    parts.push(signature.variantTokens.sort().join('+'));
  }

  // Graded vs raw
  if (signature.graded) {
    parts.push('graded');
    if (signature.gradeValue) {
      parts.push(`g${signature.gradeValue}`);
    }
  }

  // Autograph
  if (signature.autograph) {
    parts.push('auto');
  }

  return parts.length >= 2 ? parts.join('|') : null;
}

/**
 * Within a single search's listings, find cards that are significantly cheaper
 * than other comparable listings on Vinted.
 *
 * Returns an array of { listing, avgPrice, medianPrice, compCount, discount }
 * for listings that are at least (1 - threshold) cheaper than the median.
 */
function findUnderpricedListings(listings, config) {
  const threshold = config.underpricedThreshold || 0.50;
  const minComps = config.underpricedMinComps || 3;
  const minPrice = config.minListingPriceEur || 2;

  // Group listings by card signature
  const groups = new Map();

  for (const listing of listings) {
    if (listing.buyerPrice < minPrice) {
      continue;
    }

    const signature = extractCardSignature(listing.title);
    const groupKey = buildGroupKey(signature);

    if (!groupKey) {
      continue;
    }

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(listing);
  }

  const underpriced = [];

  for (const [groupKey, group] of groups) {
    if (group.length < minComps) {
      continue;
    }

    const prices = group.map((l) => l.buyerPrice).sort((a, b) => a - b);
    const medianPrice = prices[Math.floor(prices.length / 2)];
    const avgPrice = prices.reduce((s, p) => s + p, 0) / prices.length;

    for (const listing of group) {
      const discount = 1 - (listing.buyerPrice / medianPrice);
      if (discount >= threshold) {
        underpriced.push({
          listing,
          groupKey,
          avgPrice: Math.round(avgPrice * 100) / 100,
          medianPrice: Math.round(medianPrice * 100) / 100,
          compCount: group.length,
          discount: Math.round(discount * 100)
        });
      }
    }
  }

  return underpriced.sort((a, b) => b.discount - a.discount);
}

/**
 * Extended version: also compare with OTHER Vinted listings from the same search
 * that match by image similarity (for when titles are different but it's the same card).
 */
async function findUnderpricedWithImages(allListings, config) {
  const minPrice = config.minListingPriceEur || 2;
  const threshold = config.underpricedThreshold || 0.50;
  const minImageSimilarity = config.minImageSimilarity || 0.60;

  // First pass: text-based grouping
  const textUnderpriced = findUnderpricedListings(allListings, config);

  // Second pass: for listings that didn't group by text, try image grouping
  // Only do this for listings with images and above minimum price
  const ungrouped = allListings.filter((l) => {
    if (l.buyerPrice < minPrice || !l.imageUrl) {
      return false;
    }

    const sig = extractCardSignature(l.title);
    const key = buildGroupKey(sig);
    // Skip if already found underpriced by text
    return !textUnderpriced.some((u) => u.listing.url === l.url);
  });

  // Image comparison is expensive, so only compare within the same search
  // and only for listings that look like they could be underpriced (bottom 25% by price)
  if (ungrouped.length < 4) {
    return textUnderpriced;
  }

  const sortedByPrice = [...ungrouped].sort((a, b) => a.buyerPrice - b.buyerPrice);
  const cheapQuarter = sortedByPrice.slice(0, Math.ceil(sortedByPrice.length / 4));
  const restListings = sortedByPrice.slice(Math.ceil(sortedByPrice.length / 4));

  const imageUnderpriced = [];

  for (const cheap of cheapQuarter) {
    const similarPrices = [];

    for (const comp of restListings) {
      try {
        const match = await compareListingImages(cheap.imageUrl, comp.imageUrl, config);
        if (match && match.score !== null && match.score >= minImageSimilarity) {
          similarPrices.push(comp.buyerPrice);
        }
      } catch (error) {
        // Skip failed comparisons
      }
    }

    if (similarPrices.length >= 2) {
      const median = similarPrices.sort((a, b) => a - b)[Math.floor(similarPrices.length / 2)];
      const discount = 1 - (cheap.buyerPrice / median);

      if (discount >= threshold) {
        imageUnderpriced.push({
          listing: cheap,
          groupKey: `img:${cheap.title.slice(0, 30)}`,
          avgPrice: Math.round(similarPrices.reduce((s, p) => s + p, 0) / similarPrices.length * 100) / 100,
          medianPrice: Math.round(median * 100) / 100,
          compCount: similarPrices.length + 1,
          discount: Math.round(discount * 100),
          matchedByImage: true
        });
      }
    }
  }

  return [...textUnderpriced, ...imageUnderpriced].sort((a, b) => b.discount - a.discount);
}

module.exports = {
  findUnderpricedListings,
  findUnderpricedWithImages
};
