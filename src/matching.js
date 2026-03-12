const { normalizeSpaces, toSlugTokens } = require('./utils');

const GENERIC_STOP_WORDS = new Set([
  'card',
  'cards',
  'carte',
  'cartes',
  'trading',
  'fr',
  'uk',
  'de',
  'nrmt',
  'mint',
  'near',
  'excellent',
  'good',
  'rare',
  'new',
  'edition',
  'topps',
  'football',
  'soccer',
  'basketball',
  'f1',
  'formula',
  'premier',
  'update',
  'club',
  'collection',
  'single'
]);

const IDENTITY_TOKEN_STOP_WORDS = new Set([
  ...GENERIC_STOP_WORDS,
  'pokemon',
  'japanese',
  'japonaise',
  'japan',
  'english',
  'francais',
  'francaise',
  'giapponese',
  'psa',
  'sgc',
  'bgs',
  'cgc',
  'aura',
  'collect',
  'gem',
  'mint',
  'holo',
  'rare',
  'ultra',
  'base',
  'refractor',
  'sapphire',
  'raywave',
  'wave',
  'pink',
  'purple',
  'green',
  'blue',
  'gold',
  'silver',
  'black',
  'white',
  'red',
  'orange',
  'yellow',
  'aqua',
  'viola',
  'zaffiro',
  'rookie',
  'winner',
  'winners',
  'team',
  'logo',
  'grand',
  'prix',
  'formula',
  'chrome',
  'topps',
  'uefa',
  'ucc',
  'vstar',
  'universe',
  'vmax',
  'wild',
  'force',
  'super',
  'raro',
  'art',
  'fire',
  'champions',
  'league',
  'competition',
  'competitions',
  'merlin',
  'finest',
  'inception',
  'heritage',
  'renaissance',
  'wonderkids',
  'sorcerers',
  'stadium',
  'club',
  'clubs',
  'case',
  'shiny',
  'packs',
  'dual',
  'match',
  'ball',
  'relic',
  'base',
  'real',
  'madrid',
  'barca',
  'barcelona',
  'arsenal',
  'chelsea',
  'liverpool',
  'juventus',
  'inter',
  'milan',
  'ajax',
  'sporting',
  'shakhtar',
  'donetsk',
  'manchester',
  'united',
  'city',
  'bayern',
  'munich',
  'munchen',
  'paris',
  'saint',
  'germain',
  'benfica',
  'porto',
  'dortmund',
  'leipzig',
  'salzburg',
  'sevilla',
  'valencia',
  'napoli',
  'roma',
  'monaco',
  'atalanta',
  'stake',
  'kick',
  'ferrari',
  'mercedes',
  'mclaren',
  'alpine',
  'williams',
  'haas',
  'sauber',
  'aston',
  'martin',
  'bulls',
  'racing'
]);

const VARIANT_TOKENS = new Set([
  'refractor',
  'sapphire',
  'raywave',
  'wave',
  'aqua',
  'gold',
  'silver',
  'pink',
  'purple',
  'green',
  'blue',
  'orange',
  'red',
  'black',
  'white',
  'sepia',
  'checker',
  'flag',
  'zaffiro',
  'viola',
  'violet',
  'fuchsia',
  'shimmer',
  'speckle',
  'base',
  'holo',
  'logofractor',
  'toppsfractor',
  'superfractor',
  'stadium',
  'lazer'
]);

function normalizeComparableToken(token) {
  return String(token || '').replace(/^#/, '');
}

function findCardNumberToken(rawTokens, comparableTokens, year, ignoredNumbers = []) {
  const explicitRawToken = rawTokens.find((token) => /^#\d{1,4}$/i.test(token));
  if (explicitRawToken) {
    return normalizeComparableToken(explicitRawToken);
  }

  const explicitComparableToken = comparableTokens.find((token) => /^[a-z]{2,4}\d{1,4}$/i.test(token));
  if (explicitComparableToken) {
    return normalizeComparableToken(explicitComparableToken);
  }

  const ignoredSet = new Set(ignoredNumbers.filter(Boolean).map(String));
  const numericToken = comparableTokens.find(
    (token) => /^\d{2,4}$/.test(token) && token !== year && !ignoredSet.has(token)
  );
  return numericToken ? normalizeComparableToken(numericToken) : null;
}

function extractCardSignature(title) {
  const normalized = normalizeSpaces(title || '');
  const rawTokens = toSlugTokens(normalized).filter((token) => token && token !== '-');
  const comparableTokens = [...new Set(rawTokens.map(normalizeComparableToken))];
  const year = comparableTokens.find((token) => /^20\d{2}$/.test(token)) || null;
  const graded = comparableTokens.includes('psa') || comparableTokens.includes('sgc') || comparableTokens.includes('bgs') || comparableTokens.includes('cgc') || normalized.toLowerCase().includes('collect aura');
  const gradeMatch = normalized.match(/(?:psa|sgc|bgs|cgc|collect\s+aura)\s*(10|[1-9](?:\.\d)?)/i);
  const gradeValue = gradeMatch ? gradeMatch[1] : null;
  const cardNumber = findCardNumberToken(rawTokens, comparableTokens, year, [gradeValue]);
  const serialNumber = comparableTokens.find((token) => /^\d{1,4}\/\d{1,4}$/.test(token)) || null;
  const embeddedPrintRun = serialNumber ? serialNumber.split('/')[1] : null;
  const standalonePrintRunToken = comparableTokens.find((token) => /^\/\d{1,4}$/.test(token)) || null;
  const printRun = embeddedPrintRun || (standalonePrintRunToken ? standalonePrintRunToken.slice(1) : null);
  const parallelToken = printRun ? `/${printRun}` : null;
  const allComparableTokens = parallelToken && !comparableTokens.includes(parallelToken)
    ? [...comparableTokens, parallelToken]
    : comparableTokens;
  const rookie = comparableTokens.includes('rookie') || comparableTokens.includes('rc');
  const chrome = comparableTokens.includes('chrome');
  const autograph = comparableTokens.includes('auto') || comparableTokens.includes('autograph');
  const tokens = allComparableTokens.filter((token) => !GENERIC_STOP_WORDS.has(token));
  const specificTokens = tokens.filter((token) => token.length >= 4 && !GENERIC_STOP_WORDS.has(token));
  const identityTokens = specificTokens.filter((token) => /^[a-z][a-z-]{3,}$/.test(token) && !IDENTITY_TOKEN_STOP_WORDS.has(token));
  const variantTokens = tokens.filter((token) => VARIANT_TOKENS.has(token) || /^\/\d{2,4}$/.test(token));

  return {
    raw: normalized,
    allTokens: allComparableTokens,
    tokens,
    year,
    cardNumber,
    serialNumber,
    printRun,
    parallelToken,
    rookie,
    chrome,
    graded,
    gradeValue,
    autograph,
    specificTokens,
    identityTokens,
    variantTokens
  };
}

function scoreSoldListing(vintedListing, soldListing) {
  const left = extractCardSignature(vintedListing.title);
  const right = extractCardSignature(soldListing.title);

  const leftSet = new Set(left.tokens);
  const rightSet = new Set(right.tokens);
  const sharedTokens = [...leftSet].filter((token) => rightSet.has(token));
  const leftSpecific = new Set(left.specificTokens);
  const rightSpecific = new Set(right.specificTokens);
  const sharedSpecificTokens = [...leftSpecific].filter((token) => rightSpecific.has(token));
  const leftIdentity = new Set(left.identityTokens);
  const rightIdentity = new Set(right.identityTokens);
  const sharedIdentityTokens = [...leftIdentity].filter((token) => rightIdentity.has(token));
  const sourceSpecificCount = Math.max(left.specificTokens.length, 1);
  const specificCoverage = sharedSpecificTokens.length / sourceSpecificCount;

  let score = 0;
  if (left.year && right.year && left.year === right.year) {
    score += 3;
  }
  if (left.cardNumber && right.cardNumber && left.cardNumber === right.cardNumber) {
    score += 4;
  }
  if (left.printRun && right.printRun && left.printRun === right.printRun) {
    score += 3;
  }
  if (left.rookie && right.rookie) {
    score += 1;
  }
  if (left.chrome && right.chrome) {
    score += 1;
  }
  if (left.graded && right.graded) {
    score += 1;
  }
  if (left.autograph && right.autograph) {
    score += 1;
  }

  score += sharedTokens.length;
  score += sharedSpecificTokens.length * 2;
  score += sharedIdentityTokens.length * 3;
  score += specificCoverage >= 0.8 ? 3 : specificCoverage >= 0.6 ? 1 : 0;

  const missingCritical =
    (left.year && right.year && left.year !== right.year) ||
    (left.cardNumber && right.cardNumber && left.cardNumber !== right.cardNumber) ||
    (left.printRun && right.printRun && left.printRun !== right.printRun) ||
    (left.gradeValue && right.gradeValue && left.gradeValue !== right.gradeValue) ||
    left.graded !== right.graded ||
    left.autograph !== right.autograph;

  return {
    score,
    sharedTokens,
    sharedSpecificTokens,
    sharedIdentityTokens,
    specificCoverage,
    missingCritical
  };
}

function chooseBestSoldListings(vintedListing, soldListings) {
  const sourceSignature = extractCardSignature(vintedListing.title);
  const dedupedSoldListings = [...new Map(
    soldListings.map((listing) => [listing.itemKey || listing.url || listing.title, listing])
  ).values()]
    .filter((listing) => Number(listing.soldAtTs) > 0);
  const ranked = dedupedSoldListings
    .map((listing) => ({
      ...listing,
      signature: extractCardSignature(listing.title),
      match: scoreSoldListing(vintedListing, listing)
    }))
    .filter((listing) => {
      if (listing.match.missingCritical) {
        return false;
      }

      if (sourceSignature.identityTokens.length > 0 && listing.match.sharedIdentityTokens.length === 0) {
        return false;
      }

      if (listing.match.sharedSpecificTokens.length >= 2) {
        return (
          !sourceSignature.cardNumber ||
          listing.match.specificCoverage >= 0.75 ||
          listing.match.sharedTokens.includes(sourceSignature.cardNumber)
        );
      }

      return (
        listing.match.sharedSpecificTokens.length >= 1 &&
        (sourceSignature.cardNumber
          ? (
              listing.match.sharedTokens.includes(sourceSignature.cardNumber) ||
              listing.match.specificCoverage >= 0.85
            )
          : listing.match.score >= 12)
      );
    })
    .sort((a, b) => {
      const scoreDiff = b.match.score - a.match.score;
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return (b.soldAtTs || 0) - (a.soldAtTs || 0);
    });

  const minScore = 5;
  if (!ranked.length || ranked[0].match.score < minScore) {
    return [];
  }

  const scoreFloor = Math.max(minScore, ranked[0].match.score - 2);
  const shortlisted = ranked
    .filter((listing) => listing.match.score >= scoreFloor)
    .sort((a, b) => {
      const soldDiff = (b.soldAtTs || 0) - (a.soldAtTs || 0);
      if (soldDiff !== 0) {
        return soldDiff;
      }

      return b.match.score - a.match.score;
    })
    .slice(0, 6);

  for (let leftIndex = 0; leftIndex < shortlisted.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < shortlisted.length; rightIndex += 1) {
      const left = shortlisted[leftIndex];
      const right = shortlisted[rightIndex];
      const leftVariants = new Set(left.signature.variantTokens);
      const rightVariants = new Set(right.signature.variantTokens);
      const sharedPairVariants = [...leftVariants].filter((token) => rightVariants.has(token));
      const sharedPairIdentityTokens = sourceSignature.identityTokens.filter(
        (token) => left.match.sharedIdentityTokens.includes(token) && right.match.sharedIdentityTokens.includes(token)
      );
      const sourceVariants = sourceSignature.variantTokens || [];
      const sourceHasVariants = sourceVariants.length > 0;
      const leftMatchesSourceVariant = !sourceHasVariants || sourceVariants.some((token) => leftVariants.has(token));
      const rightMatchesSourceVariant = !sourceHasVariants || sourceVariants.some((token) => rightVariants.has(token));
      const pairIsVariantConsistent = sourceHasVariants
        ? leftMatchesSourceVariant && rightMatchesSourceVariant
        : leftVariants.size === 0 && rightVariants.size === 0;
      const pairHasStableIdentity = sourceSignature.identityTokens.length === 0 || sharedPairIdentityTokens.length > 0;

      if (!pairIsVariantConsistent || !pairHasStableIdentity) {
        continue;
      }

      return [left, right]
        .sort((a, b) => {
          const soldDiff = (b.soldAtTs || 0) - (a.soldAtTs || 0);
          if (soldDiff !== 0) {
            return soldDiff;
          }

          return b.match.score - a.match.score;
        });
    }
  }

  return [];
}

module.exports = {
  chooseBestSoldListings,
  extractCardSignature
};
