const { normalizeSpaces, toSlugTokens } = require('./utils');

// ─── FR→EN translation map for common TCG terms ───────────────────────────
const FR_EN_TRANSLATIONS = {
  // Card types / rarity
  'carte': 'card',
  'cartes': 'cards',
  'rare': 'rare',
  'ultra': 'ultra',
  'secrete': 'secret',
  'commune': 'common',
  'peu commune': 'uncommon',
  'brillante': 'shiny',
  'holographique': 'holo',
  'illustration': 'illustration',
  'doree': 'gold',
  'argentee': 'silver',
  'noire': 'black',
  'blanche': 'white',
  'rouge': 'red',
  'bleue': 'blue',
  'verte': 'green',
  'rose': 'pink',
  'violette': 'purple',
  // Conditions
  'neuf': 'mint',
  'neuve': 'mint',
  'excellent': 'excellent',
  'bon etat': 'good condition',
  // TCG specific
  'booster': 'booster',
  'extension': 'expansion',
  'coffret': 'box',
  'lot': 'lot',
  'francaise': 'french',
  'japonaise': 'japanese',
  'anglaise': 'english',
  // Sports terms (Topps/Panini)
  'or': 'gold',
  'argent': 'silver',
  'bronze': 'bronze',
  'parallele': 'parallel',
  'numerotee': 'numbered',
  'numerote': 'numbered',
  'autographe': 'autograph',
  'dedie': 'autograph',
  'dedicace': 'autograph',
  'refracteur': 'refractor',
  'debutant': 'rookie',
  'recrue': 'rookie',
  // One Piece specific
  'chef': 'leader',
  'personnage': 'character',
  'evenement': 'event',
  'scene': 'stage',
  // LEGO specific
  'coffret': 'set',
  'complet': 'complete',
  'boite': 'box',
  'notice': 'instructions',
  'pieces': 'pieces',
  'figurine': 'minifigure',
  // Sneakers
  'chaussures': 'shoes',
  'baskets': 'sneakers',
  'taille': 'size',
  'pointure': 'size',
  // Consoles / jeux vidéo
  'manette': 'controller',
  'jeu': 'game',
  'console': 'console',
  'en boite': 'boxed',
  // Vinyles
  'disque': 'vinyl',
  'album': 'album',
  'edition limitee': 'limited edition',
  'pressage': 'pressing',
  // Conditions générales
  'etat neuf': 'mint condition',
  'comme neuf': 'near mint',
  'avec boite': 'with box',
  'sans boite': 'no box',
  'lot de': 'lot of'
};

function translateFrToEn(text) {
  let translated = text.toLowerCase();
  // Sort by length descending to match longer phrases first
  const entries = Object.entries(FR_EN_TRANSLATIONS).sort((a, b) => b[0].length - a[0].length);
  for (const [fr, en] of entries) {
    translated = translated.replace(new RegExp(`\\b${fr}\\b`, 'gi'), en);
  }
  return translated;
}

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
  'single',
  // Mots Vinted bruit (absents des annonces eBay)
  'lot',
  'vends', 'vente',
  'neuf', 'neuve',
  'etat',
  'parfait',
  'tres', 'bon',
  'great',
  'envoi', 'rapide', 'suivi', 'livraison', 'gratuit', 'offert',
  'prix', 'negociable', 'ferme', 'urgent',
  'super', 'magnifique', 'superbe',
  'collectionneur'
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
  'racing',
  // Product/set name words — not player identity
  'turbo',
  'attax',
  'attack',
  'supernova',
  'parallele',
  'parallel',
  'creators',
  'autographs',
  'autograph',
  'signed',
  'signature',
  'signe',
  'numbered',
  'patch',
  'mosaic',
  'prizm',
  'select',
  'donruss',
  'panini',
  'optic',
  'rated',
  'stellar',
  'fusion',
  'cosmic',
  // One Piece TCG
  'piece',
  'game',
  'leader',
  'blocker',
  'manga',
  'anime',
  'bandai',
  // Panini
  'chronicles',
  'national',
  'treasures'
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
  const t = String(token || '').replace(/^#/, '');
  // Strip leading zeros from pure numeric tokens: "044" → "44"
  if (/^\d+$/.test(t)) return String(parseInt(t, 10));
  // Strip leading zeros from serial-number format: "044/185" → "44/185"
  if (/^\d+\/\d+$/.test(t)) {
    const parts = t.split('/');
    return `${parseInt(parts[0], 10)}/${parseInt(parts[1], 10)}`;
  }
  return t;
}

/**
 * Extract TCG set code prefix from card titles.
 * Yu-Gi-Oh: "YAP1-JP006" → "YAP1", "HC01-JP003" → "HC01", "RA04-FR029" → "RA04"
 * Pokemon: "sv4pt5" → "sv4pt5", "swsh12pt5" → "swsh12pt5"
 * One Piece: "ST01-012" → "ST01", "OP01-025" → "OP01"
 */
function extractTcgSetCode(title) {
  const t = String(title || '');

  // Yu-Gi-Oh set codes: 2-4 letters + 1-2 digits, followed by -XX (language) + digits
  // Examples: YAP1-JP006, HC01-JP003, RA04-FR029, PHNI-EN001
  const ygMatch = t.match(/\b([A-Z]{2,4}\d{1,2})-(?:JP|EN|FR|DE|IT|ES|PT|KR)\d{2,4}\b/i);
  if (ygMatch) return ygMatch[1].toUpperCase();

  // One Piece TCG: ST01-012, OP01-025, EB01-001
  const opMatch = t.match(/\b([A-Z]{2}\d{2})-\d{3}\b/i);
  if (opMatch) return opMatch[1].toUpperCase();

  // Pokemon set codes: sv1, sv4pt5, swsh12, etc.
  const pkMatch = t.match(/\b(sv\d+(?:pt\d+)?|swsh\d+(?:pt\d+)?|sm\d+|xy\d+|bw\d+)\b/i);
  if (pkMatch) return pkMatch[1].toLowerCase();

  return null;
}

function findCardNumberToken(rawTokens, comparableTokens, year, ignoredNumbers = []) {
  // Handle tokens like "-#113-" from eBay titles with dashes wrapping the number
  const dashWrappedToken = rawTokens.find((token) => /^-?#\d{1,4}-?$/i.test(token));
  if (dashWrappedToken) {
    const match = dashWrappedToken.match(/(\d{1,4})/);
    if (match) {
      return match[1];
    }
  }

  const explicitRawToken = rawTokens.find((token) => /^#\d{1,4}$/i.test(token));
  if (explicitRawToken) {
    return normalizeComparableToken(explicitRawToken);
  }

  const explicitComparableToken = comparableTokens.find((token) => /^[a-z]{2,4}\d{1,4}$/i.test(token));
  if (explicitComparableToken) {
    return normalizeComparableToken(explicitComparableToken);
  }

  // Handle "RC32/RC32", "TG15/TG30" — alphanumeric card code with self/total format
  // (digits-only serials like "069/187" are handled by serialNumber, not here)
  const alphaSlashToken = comparableTokens.find((token) => /^[a-z]{1,4}\d{1,4}\/[a-z]{1,4}\d{1,4}$/i.test(token));
  if (alphaSlashToken) {
    return alphaSlashToken.split('/')[0].toLowerCase();
  }

  const ignoredSet = new Set(ignoredNumbers.filter(Boolean).map(String));
  const numericToken = comparableTokens.find(
    (token) => /^\d{2,4}$/.test(token) && token !== year && !ignoredSet.has(token)
  );
  return numericToken ? normalizeComparableToken(numericToken) : null;
}

function extractCardSignature(title) {
  const normalized = normalizeSpaces(title || '');
  // Normalize hyphenated/spaced Pokémon card type variants before tokenizing:
  // "V-Max" / "V Max" → "vmax",  "V-Star" → "vstar",  "V-Union" → "vunion"
  const preprocessed = normalized
    .replace(/\bv[\s\-]max\b/gi, 'vmax')
    .replace(/\bv[\s\-]star\b/gi, 'vstar')
    .replace(/\bv[\s\-]union\b/gi, 'vunion');
  const rawTokens = toSlugTokens(preprocessed).filter((token) => token && token !== '-');
  const comparableTokens = [...new Set(rawTokens.map(normalizeComparableToken))];
  const year = comparableTokens.find((token) => /^20\d{2}$/.test(token)) || null;
  const graded = comparableTokens.includes('psa') || comparableTokens.includes('sgc') || comparableTokens.includes('bgs') || comparableTokens.includes('cgc') || normalized.toLowerCase().includes('collect aura');
  const gradeMatch = normalized.match(/(?:psa|sgc|bgs|cgc|collect\s+aura)\s*(10|[1-9](?:\.\d)?)/i);
  const gradeValue = gradeMatch ? gradeMatch[1] : null;
  const cardNumber = findCardNumberToken(rawTokens, comparableTokens, year, [gradeValue]);
  // Detect season format like 2024/25 — this is NOT a serial/print run
  const isSeasonFormat = (token) => /^20\d{2}\/\d{2}$/.test(token);
  const serialNumber = comparableTokens.find((token) => /^\d{1,4}\/\d{1,4}$/.test(token) && !isSeasonFormat(token)) || null;
  const embeddedPrintRun = serialNumber ? serialNumber.split('/')[1] : null;
  const standalonePrintRunToken = comparableTokens.find((token) => /^\/\d{1,4}$/.test(token)) || null;
  // Don't extract standalone /25 if it comes from a season like 2024/25
  const seasonToken = comparableTokens.find(isSeasonFormat);
  const seasonSuffix = seasonToken ? '/' + seasonToken.split('/')[1] : null;
  const printRun = embeddedPrintRun || (standalonePrintRunToken && standalonePrintRunToken !== seasonSuffix ? standalonePrintRunToken.slice(1) : null);
  const parallelToken = printRun ? `/${printRun}` : null;
  const allComparableTokens = parallelToken && !comparableTokens.includes(parallelToken)
    ? [...comparableTokens, parallelToken]
    : comparableTokens;
  const rookie = comparableTokens.includes('rookie') || comparableTokens.includes('rc');
  const chrome = comparableTokens.includes('chrome');
  const autograph = comparableTokens.includes('auto') || comparableTokens.includes('autograph') ||
    comparableTokens.includes('signed') || comparableTokens.includes('signature') ||
    comparableTokens.includes('signe') || normalized.toLowerCase().includes('signé');

  // ─── Lot / bundle detection ──────────────────────────────────────────────
  const lotPatterns = /\b(lot|bundle|joblot|job\s*lot)\b/i;
  const multiPattern = /\bx\s*(\d+)\b/i;
  const multiMatch = normalized.match(multiPattern);
  const isLot = lotPatterns.test(normalized) || (multiMatch && parseInt(multiMatch[1], 10) >= 2);

  const tokens = allComparableTokens.filter((token) => !GENERIC_STOP_WORDS.has(token));
  const specificTokens = tokens.filter((token) => token.length >= 4 && !GENERIC_STOP_WORDS.has(token));
  const identityTokens = specificTokens.filter((token) => /^[a-z][a-z-]{3,}$/.test(token) && !IDENTITY_TOKEN_STOP_WORDS.has(token));
  const variantTokens = tokens.filter((token) => VARIANT_TOKENS.has(token) || /^\/\d{2,4}$/.test(token));

  // ─── Card category classification ────────────────────────────────────────
  // Categories are mutually exclusive priority: numbered > signed > graded > variant > base
  let cardCategory = 'base';
  if (printRun) {
    cardCategory = 'numbered';
  } else if (autograph) {
    cardCategory = 'signed';
  } else if (graded) {
    cardCategory = 'graded';
  } else if (variantTokens.length > 0) {
    cardCategory = 'variant';
  }

  const tcgSetCode = extractTcgSetCode(normalized);

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
    isLot,
    cardCategory,
    specificTokens,
    identityTokens,
    variantTokens,
    tcgSetCode
  };
}

function scoreSoldListing(vintedListing, soldListing) {
  // Try matching with translated title as well
  const left = extractCardSignature(vintedListing.title);
  const leftTranslated = extractCardSignature(translateFrToEn(vintedListing.title));
  const right = extractCardSignature(soldListing.title);

  // Merge original + translated tokens for broader matching
  const leftTokensMerged = new Set([...left.tokens, ...leftTranslated.tokens]);
  const leftSpecificMerged = new Set([...left.specificTokens, ...leftTranslated.specificTokens]);
  const leftIdentityMerged = new Set([...left.identityTokens, ...leftTranslated.identityTokens]);

  const leftSet = leftTokensMerged;
  const rightSet = new Set(right.tokens);
  const sharedTokens = [...leftSet].filter((token) => rightSet.has(token));
  const leftSpecific = leftSpecificMerged;
  const rightSpecific = new Set(right.specificTokens);
  const sharedSpecificTokens = [...leftSpecific].filter((token) => rightSpecific.has(token));
  const leftIdentity = leftIdentityMerged;
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

  // ─── Variant/rarity mismatch ──────────────────────────────────────────────
  // Fusionne les variant tokens de l'original et de la traduction FR→EN
  const leftAllVariants = new Set([...left.variantTokens, ...leftTranslated.variantTokens]);
  const rightAllVariants = new Set(right.variantTokens);

  // Les deux côtés ont des variantes mais aucune en commun → parallèles différents → rejet dur
  const variantMismatch = leftAllVariants.size > 0 && rightAllVariants.size > 0 &&
    ![...leftAllVariants].some(t => rightAllVariants.has(t));

  // Un seul côté a des variantes → pénalité de score
  const variantAsymmetry = (leftAllVariants.size > 0) !== (rightAllVariants.size > 0);
  if (variantAsymmetry) score -= 5;

  const printRunMismatch =
    (!left.printRun && right.printRun) ||
    (!right.printRun && left.printRun);

  const cardNumberMissing =
    (left.cardNumber && !right.allTokens.includes(left.cardNumber)) ||
    (right.cardNumber && !left.allTokens.includes(right.cardNumber));

  // STRICT IDENTITY MATCHING: le nom principal du produit doit être partagé
  // On filtre les tokens génériques de catégorie (pokemon, yugioh, topps, etc.)
  const CATEGORY_TOKENS = new Set(['pokemon', 'yugioh', 'yu-gi-oh', 'topps', 'panini', 'lego', 'funko', 'bandai', 'onepiece', 'carte', 'card', 'cards', 'cartes']);
  const leftProductTokens = left.identityTokens.filter(t => !CATEGORY_TOKENS.has(t));
  const leftTranslatedProductTokens = leftTranslated.identityTokens.filter(t => !CATEGORY_TOKENS.has(t));
  const leftAllProductTokens = new Set([...leftProductTokens, ...leftTranslatedProductTokens]);
  const rightProductTokens = right.identityTokens.filter(t => !CATEGORY_TOKENS.has(t));

  // Le premier token produit de Vinted (le nom du Pokémon/personnage) doit exister côté eBay
  const primaryProductMatch = leftAllProductTokens.size === 0 || rightProductTokens.length === 0 ||
    [...leftAllProductTokens].some(t => rightProductTokens.includes(t));

  const sourceIdentityCount = left.identityTokens.length;
  const identityCoverageRatio = sourceIdentityCount === 0 ? 1 : sharedIdentityTokens.length / sourceIdentityCount;
  const identityFullCoverage = sourceIdentityCount === 0 ||
    (identityCoverageRatio >= 0.6 && primaryProductMatch);
  const identityPartialOnly = !primaryProductMatch ||
    (sourceIdentityCount >= 2 && sharedIdentityTokens.length > 0 && identityCoverageRatio < 0.6);

  // REVERSE COVERAGE: check how many eBay identity tokens are NOT in the Vinted listing
  // If eBay has many extra identity tokens (e.g. "Road To Euro Spain The Man"),
  // it's likely a different card from the same set.
  // Note: Vinted titles can be TRUNCATED (e.g. "Saud..." → token "saud"), so we skip
  // eBay tokens that are merely an extension of a truncated Vinted token (prefix match).
  const ebayExtraIdentity = right.identityTokens.filter((token) => {
    if (leftSet.has(token)) return false;
    // Check if any Vinted token is a prefix of this eBay token (truncation artifact)
    const isTruncationExtension = [...leftSet].some(
      (lt) => lt.length >= 4 && token.startsWith(lt)
    );
    return !isTruncationExtension;
  });
  const ebayExtraSpecific = right.specificTokens.filter((token) => !leftSet.has(token));
  // Threshold stays at 2: prefix-match above already strips truncation artifacts
  // (e.g. "saudi" is ignored if Vinted has "saud", so "arabia" alone won't trigger it)
  const reverseMismatch = ebayExtraIdentity.length >= 2;

  // ─── Card category mismatch (numbered vs signed vs base etc.) ──────────
  // Use merged left signature for category — pick the most specific one
  const leftCategory = left.cardCategory !== 'base' ? left.cardCategory : leftTranslated.cardCategory;
  const rightCategory = right.cardCategory;
  const categoryMismatch = leftCategory !== 'base' && rightCategory !== 'base' &&
    leftCategory !== rightCategory;
  // Strong penalty: one side is numbered and other is signed (or vice versa)
  const hardCategoryConflict =
    (leftCategory === 'numbered' && rightCategory === 'signed') ||
    (leftCategory === 'signed' && rightCategory === 'numbered');

  // ─── Lot detection mismatch ──────────────────────────────────────────────
  const leftIsLot = left.isLot || leftTranslated.isLot;
  const rightIsLot = right.isLot;
  const lotMismatch = leftIsLot !== rightIsLot;

  // Serial number (e.g. "069/187") vs alphanumeric card code (e.g. "RC32", "TG15"):
  // these are incompatible numbering systems — one side is a set-numbered card,
  // the other is a special sub-set card with a lettered code.
  const ALPHANUM_CARD_CODE = /^[a-z]{1,4}\d{1,4}$/i;
  const serialVsCodeConflict =
    (left.serialNumber && right.cardNumber && ALPHANUM_CARD_CODE.test(right.cardNumber)) ||
    (right.serialNumber && left.cardNumber && ALPHANUM_CARD_CODE.test(left.cardNumber));

  // TCG set code mismatch: if both sides have a set code and they differ → hard reject
  const tcgSetMismatch = left.tcgSetCode && right.tcgSetCode &&
    left.tcgSetCode !== right.tcgSetCode &&
    leftTranslated.tcgSetCode !== right.tcgSetCode;

  const missingCritical =
    (left.year && right.year && left.year !== right.year) ||
    (left.cardNumber && right.cardNumber && left.cardNumber !== right.cardNumber) ||
    (left.printRun && right.printRun && left.printRun !== right.printRun) ||
    (left.gradeValue && right.gradeValue && left.gradeValue !== right.gradeValue) ||
    left.graded !== right.graded ||
    left.autograph !== right.autograph ||
    // printRunMismatch removed: having a print run on one side only is NOT a blocker
    // cardNumberMissing removed: eBay titles often omit the card number, not a blocker
    identityPartialOnly ||
    reverseMismatch ||
    hardCategoryConflict ||
    lotMismatch ||
    serialVsCodeConflict ||
    variantMismatch ||  // les deux côtés ont des variantes différentes (ex: Aqua vs Gold)
    tcgSetMismatch;  // les deux côtés ont des codes set TCG différents (ex: YAP1 vs HC01)

  return {
    score,
    sharedTokens,
    sharedSpecificTokens,
    sharedIdentityTokens,
    specificCoverage,
    missingCritical,
    printRunMismatch,
    cardNumberMissing,
    identityFullCoverage,
    identityPartialOnly,
    reverseMismatch,
    ebayExtraIdentity,
    categoryMismatch,
    hardCategoryConflict,
    lotMismatch,
    serialVsCodeConflict,
    variantMismatch,
    variantAsymmetry,
    tcgSetMismatch
  };
}

// ─── Non-TCG structural matching helpers ────────────────────────────────────
// These are used when the search has isNonTcg=true or a specific category name.
// They extract features (size, condition, set number, etc.) that must agree for
// a valid match. Token-based matching alone is insufficient for physical products.

function normTextForFeature(title) {
  return String(title || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Extract EU shoe size from a title.
 * Returns a number (e.g. 42) or null.
 */
function extractSneakerSize(title) {
  const t = normTextForFeature(title);
  // EU sizes 35-50, optionally preceded by "eu", "taille", "pointure", "size", "sz", "t"
  const euMatch = t.match(/\b(?:eu|taille|pointure|size|sz|t\.?)?\s*(3[5-9]|4[0-9]|50)(?:[.,]5)?\b/);
  if (euMatch) return parseFloat(euMatch[1]);
  // UK → EU rough conversion (+33)
  const ukMatch = t.match(/\buk\s*(\d{1,2}(?:[.,]\d)?)\b/);
  if (ukMatch) return parseFloat(String(ukMatch[1]).replace(',', '.')) + 33;
  // US men's → EU rough conversion (+33)
  const usMatch = t.match(/\bus\s*(\d{1,2}(?:[.,]\d)?)\b/);
  if (usMatch) return parseFloat(String(usMatch[1]).replace(',', '.')) + 33;
  return null;
}

/**
 * Extract clothing size (XS/S/M/L/XL/XXL or numeric FR 36-52).
 * Returns normalized string or null.
 */
function extractClothingSize(title) {
  const t = normTextForFeature(title);
  const textMatch = t.match(/\b(xxs|xs|xxl|xl|s|m|l)\b/);
  if (textMatch) return textMatch[1].toUpperCase();
  const numMatch = t.match(/\b(3[6-9]|4[0-9]|50|52)\b/);
  if (numMatch) return numMatch[1];
  return null;
}

/**
 * Extract condition category: 'new', 'used', or null (unknown).
 */
function extractCondition(title) {
  const t = normTextForFeature(title);
  if (/\b(neuf|neuve|new|mint|sealed|scelle|jamais utilise|deadstock|ds|vnds|like new)\b/.test(t)) return 'new';
  if (/\b(occasion|used|wear|worn|use|cracked|casse|rayure|abime|defaut|traces|pour pieces)\b/.test(t)) return 'used';
  return null;
}

/**
 * Extract LEGO set number (4–6 digit LEGO-style number, not a year/price).
 * Returns string or null.
 */
function extractLegoSetNumber(title) {
  const t = String(title || '');
  // Match numbers 1000–99999 that are not years (2000-2030)
  const matches = t.match(/\b(\d{4,6})\b/g) || [];
  for (const m of matches) {
    const n = parseInt(m, 10);
    if (n >= 1000 && n <= 99999 && !(n >= 2000 && n <= 2030)) return m;
  }
  return null;
}

/**
 * Extract console model string for retro gaming (normalised).
 * Returns a canonical model key or null.
 */
function extractConsoleModel(title) {
  const t = normTextForFeature(title);
  const models = [
    ['game boy color', 'gbc'], ['game boy colour', 'gbc'],
    ['game boy advance sp', 'gbasp'], ['gba sp', 'gbasp'],
    ['game boy advance', 'gba'], ['game boy pocket', 'gbp'],
    ['game boy', 'gb'],
    ['nintendo 64', 'n64'], ['n64', 'n64'],
    ['super nintendo', 'snes'], ['snes', 'snes'], ['super nes', 'snes'],
    ['playstation 5', 'ps5'], ['ps5', 'ps5'],
    ['playstation 4', 'ps4'], ['ps4', 'ps4'],
    ['playstation 3', 'ps3'], ['ps3', 'ps3'],
    ['playstation 2', 'ps2'], ['ps2', 'ps2'],
    ['playstation vita', 'psvita'], ['psvita', 'psvita'],
    ['playstation portable', 'psp'], ['psp', 'psp'],
    ['playstation 1', 'ps1'], ['playstation one', 'ps1'], ['ps1', 'ps1'], ['psx', 'ps1'],
    ['mega drive', 'megadrive'], ['sega genesis', 'megadrive'],
    ['neo geo', 'neogeo'],
    ['game gear', 'gamegear'],
    ['atari 2600', 'atari2600'], ['atari 7800', 'atari7800']
  ];
  for (const [pattern, key] of models) {
    if (t.includes(pattern)) return key;
  }
  return null;
}

/**
 * Extract vinyl edition tokens: 'original', 'reissue', 'picture', 'colored', 'promo'.
 */
function extractVinylEdition(title) {
  const t = normTextForFeature(title);
  const tags = [];
  if (/\b(original|originale|first\s*press(?:ing)?|premiere\s*press|1st\s*press|og)\b/.test(t)) tags.push('original');
  if (/\b(reissue|repress|re.?edition|remaster(?:ed)?)\b/.test(t)) tags.push('reissue');
  if (/\bpicture\s*dis[ck]\b/.test(t)) tags.push('picture');
  if (/\b(colored|couleur|splatter|marbre)\b/.test(t)) tags.push('colored');
  if (/\b(promo|white\s*label)\b/.test(t)) tags.push('promo');
  return tags;
}

/**
 * Extract football card product line (Prizm, Donruss, Select, Mosaic, etc.).
 * Returns normalised product line string or null.
 */
function extractFootballProductLine(title) {
  const t = normTextForFeature(title);
  const lines = [
    'national treasures', 'topps chrome', 'topps merlin', 'topps heritage',
    'topps finest', 'topps ucc', 'turbo attax', 'stadium club',
    'prizm', 'donruss', 'select', 'mosaic', 'chronicles', 'optic',
    'panini gold standard', 'panini honors'
  ];
  for (const line of lines) { if (t.includes(line)) return line; }
  return null;
}

/**
 * Extract clothing brand for vintage items.
 */
function extractVintageBrand(title) {
  const t = normTextForFeature(title);
  const brands = [
    'ralph lauren', 'polo sport', 'north face', 'nuptse', 'carhartt',
    'stone island', 'arcteryx', 'arc\'teryx', 'patagonia', 'burberry',
    'cp company', 'lacoste', 'fred perry', 'barbour', 'woolrich'
  ];
  for (const b of brands) { if (t.includes(b)) return b; }
  return null;
}

/**
 * Apply category-specific hard rejection rules.
 * Returns an array of rejection reason strings (empty = no rejection).
 *
 * @param {string} vintedTitle
 * @param {string} ebayTitle
 * @param {string} category - search.name from config
 */
function getCategoryRejectionReasons(vintedTitle, ebayTitle, category) {
  const reasons = [];
  if (!category) return reasons;

  const cat = category.toLowerCase();

  // ─── Sneakers: size must match ──────────────────────────────────────────
  if (cat === 'sneakers') {
    const vSize = extractSneakerSize(vintedTitle);
    const eSize = extractSneakerSize(ebayTitle);
    if (vSize && eSize && Math.abs(vSize - eSize) > 0.5) {
      reasons.push(`sneaker size mismatch: Vinted=${vSize} eBay=${eSize}`);
    }
  }

  // ─── Vetements Vintage: brand + size must match ──────────────────────────
  if (cat === 'vetements vintage') {
    const vBrand = extractVintageBrand(vintedTitle);
    const eBrand = extractVintageBrand(ebayTitle);
    if (vBrand && eBrand && vBrand !== eBrand) {
      reasons.push(`vintage brand mismatch: "${vBrand}" ≠ "${eBrand}"`);
    }
    const vSize = extractClothingSize(vintedTitle);
    const eSize = extractClothingSize(ebayTitle);
    if (vSize && eSize && vSize !== eSize) {
      reasons.push(`vintage size mismatch: ${vSize} ≠ ${eSize}`);
    }
  }

  // ─── LEGO: set number must match when both present ───────────────────────
  if (cat === 'lego') {
    const vSet = extractLegoSetNumber(vintedTitle);
    const eSet = extractLegoSetNumber(ebayTitle);
    if (vSet && eSet && vSet !== eSet) {
      reasons.push(`lego set number mismatch: ${vSet} ≠ ${eSet}`);
    }
  }

  // ─── Tech / Consoles Retro: condition conflict blocks high-value items ───
  if (cat === 'tech' || cat === 'consoles retro') {
    const vCond = extractCondition(vintedTitle);
    const eCond = extractCondition(ebayTitle);
    if (vCond && eCond && vCond !== eCond) {
      reasons.push(`condition mismatch: Vinted=${vCond} eBay=${eCond}`);
    }
    // Console model must match (PS1 ≠ PS2, GBA ≠ GBC, etc.)
    if (cat === 'consoles retro') {
      const vModel = extractConsoleModel(vintedTitle);
      const eModel = extractConsoleModel(ebayTitle);
      if (vModel && eModel && vModel !== eModel) {
        reasons.push(`console model mismatch: ${vModel} ≠ ${eModel}`);
      }
    }
  }

  // ─── Vinyles: edition type must not conflict ─────────────────────────────
  if (cat === 'vinyles') {
    const vEditions = extractVinylEdition(vintedTitle);
    const eEditions = extractVinylEdition(ebayTitle);
    // If one is clearly "original" and the other is clearly "reissue", reject
    const vIsOriginal = vEditions.includes('original');
    const eIsOriginal = eEditions.includes('original');
    const vIsReissue = vEditions.includes('reissue');
    const eIsReissue = eEditions.includes('reissue');
    if ((vIsOriginal && eIsReissue) || (vIsReissue && eIsOriginal)) {
      reasons.push(`vinyl edition conflict: original vs reissue`);
    }
  }

  // ─── Topps Chrome Football / Panini Football: product line must match ────
  if (cat === 'topps chrome football' || cat === 'panini football') {
    const vLine = extractFootballProductLine(vintedTitle);
    const eLine = extractFootballProductLine(ebayTitle);
    if (vLine && eLine && vLine !== eLine) {
      reasons.push(`football product line mismatch: "${vLine}" ≠ "${eLine}"`);
    }
  }

  return reasons;
}

// Debug flag: set env MATCH_DEBUG=1 to see per-listing rejection reasons
const MATCH_DEBUG = process.env.MATCH_DEBUG === '1';

function debugReject(ebayTitle, reason) {
  if (MATCH_DEBUG) {
    console.log(`    [MATCH] REJECT "${ebayTitle.slice(0, 60)}" → ${reason}`);
  }
}

function chooseBestSoldListings(vintedListing, soldListings, searchConfig) {
  const sourceSignature = extractCardSignature(vintedListing.title);
  const sourceTranslatedSignature = extractCardSignature(translateFrToEn(vintedListing.title));
  const sourceCategory = sourceSignature.cardCategory !== 'base'
    ? sourceSignature.cardCategory : sourceTranslatedSignature.cardCategory;
  const sourceIsLot = sourceSignature.isLot || sourceTranslatedSignature.isLot;
  const sourceGraded = sourceSignature.graded || sourceTranslatedSignature.graded;
  const vintedPrice = Number(vintedListing.price) || 0;

  if (MATCH_DEBUG) {
    console.log(`  [MATCH] Vinted: "${vintedListing.title.slice(0, 80)}"`);
    console.log(`  [MATCH] identity=${JSON.stringify(sourceSignature.identityTokens)} cardNumber=${sourceSignature.cardNumber} printRun=${sourceSignature.printRun} year=${sourceSignature.year}`);
  }

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
        if (MATCH_DEBUG) {
          const m = listing.match;
          const left = extractCardSignature(vintedListing.title);
          const right = listing.signature;
          const reasons = [];
          if (left.year && right.year && left.year !== right.year) reasons.push(`year ${left.year}≠${right.year}`);
          if (left.cardNumber && right.cardNumber && left.cardNumber !== right.cardNumber) reasons.push(`cardNum ${left.cardNumber}≠${right.cardNumber}`);
          if (left.printRun && right.printRun && left.printRun !== right.printRun) reasons.push(`printRun ${left.printRun}≠${right.printRun}`);
          if (left.graded !== right.graded) reasons.push(`graded ${left.graded}≠${right.graded}`);
          if (left.autograph !== right.autograph) reasons.push(`auto ${left.autograph}≠${right.autograph}`);
          if (m.identityPartialOnly) reasons.push(`identityPartial(${m.sharedIdentityTokens.length}/${left.identityTokens.length})`);
          if (m.reverseMismatch) reasons.push(`reverseExtra[${m.ebayExtraIdentity.join(',')}]`);
          if (m.hardCategoryConflict) reasons.push(`categoryConflict`);
          if (m.lotMismatch) reasons.push(`lotMismatch`);
          debugReject(listing.title, `missingCritical: ${reasons.join(', ') || 'unknown'}`);
        }
        return false;
      }

      // ─── Filter lots: ignore eBay lots unless Vinted is also a lot ──────
      if (listing.signature.isLot && !sourceIsLot) {
        debugReject(listing.title, 'ebay=lot vinted=single');
        return false;
      }

      // ─── Filter graded: ignore graded eBay cards unless Vinted mentions grading
      if (listing.signature.graded && !sourceGraded) {
        debugReject(listing.title, 'ebay=graded vinted=raw');
        return false;
      }

      // ─── Price ratio sanity check ──────────────────────────────────────
      if (vintedPrice > 0 && listing.soldPrice) {
        const ebayPrice = Number(listing.soldPrice) || 0;
        if (ebayPrice > 0) {
          const ratio = ebayPrice / vintedPrice;
          // Hard cap absolu : ratio >= 15x → rejet systématique quelle que soit la catégorie
          if (ratio >= 15) {
            debugReject(listing.title, `price ratio ${ratio.toFixed(1)}x exceeds hard cap 15x`);
            return false;
          }
          // Soft cap : ratio >= 10x rejeté si catégories différentes
          if (ratio >= 10 && sourceCategory !== listing.signature?.cardCategory) {
            debugReject(listing.title, `price ratio ${ratio.toFixed(1)}x+ category mismatch`);
            return false;
          }
        }
      }

      // FLEXIBLE: if Vinted has identity tokens, at least 60% must be found in eBay
      if (sourceSignature.identityTokens.length > 0) {
        if (!listing.match.identityFullCoverage) {
          debugReject(listing.title, `identityCoverage<60% (${listing.match.sharedIdentityTokens.length}/${sourceSignature.identityTokens.length})`);
          return false;
        }
      }

      // If Vinted has NO identity tokens (too generic like "Carte Topps Turbo Attack 2024"),
      // require decent specific coverage + card number match
      if (sourceSignature.identityTokens.length === 0) {
        if (!sourceSignature.cardNumber) {
          // No player name AND no card number = too vague to match anything
          debugReject(listing.title, 'no identity tokens and no card number (too vague)');
          return false;
        }
        // Must match the card number at minimum
        if (!listing.match.sharedTokens.includes(sourceSignature.cardNumber)) {
          debugReject(listing.title, `no identity + cardNumber ${sourceSignature.cardNumber} not in eBay tokens`);
          return false;
        }
        // And need reasonable coverage (lowered from 0.8 to 0.6)
        if (listing.match.specificCoverage < 0.6) {
          debugReject(listing.title, `no identity + specificCoverage ${listing.match.specificCoverage.toFixed(2)}<0.6`);
          return false;
        }
      }

      if (listing.match.sharedSpecificTokens.length >= 2) {
        const pass = (
          !sourceSignature.cardNumber ||
          listing.match.specificCoverage >= 0.75 ||
          listing.match.sharedTokens.includes(sourceSignature.cardNumber)
        );
        if (!pass) debugReject(listing.title, `2+specific but cardNum ${sourceSignature.cardNumber} missing and coverage ${listing.match.specificCoverage.toFixed(2)}<0.75`);
        return pass;
      }

      const pass = (
        listing.match.sharedSpecificTokens.length >= 1 &&
        (sourceSignature.cardNumber
          ? (
              listing.match.sharedTokens.includes(sourceSignature.cardNumber) ||
              listing.match.specificCoverage >= 0.85
            )
          : listing.match.score >= 12)
      );
      if (!pass) debugReject(listing.title, `score=${listing.match.score} specific=${listing.match.sharedSpecificTokens.length} coverage=${listing.match.specificCoverage.toFixed(2)}`);
      if (!pass) return false;

      // ─── Non-TCG structural matching (size, set number, condition…) ──────
      if (searchConfig && searchConfig.name) {
        const catReasons = getCategoryRejectionReasons(
          vintedListing.title, listing.title, searchConfig.name
        );
        if (catReasons.length > 0) {
          debugReject(listing.title, catReasons.join('; '));
          return false;
        }
      }

      return true;
    })
    .sort((a, b) => {
      const scoreDiff = b.match.score - a.match.score;
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return (b.soldAtTs || 0) - (a.soldAtTs || 0);
    });

  const minScore = 4;
  if (!ranked.length || ranked[0].match.score < minScore) {
    return [];
  }

  const scoreFloor = Math.max(minScore, ranked[0].match.score - 3);
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

  // Try to find a consistent pair first
  for (let leftIndex = 0; leftIndex < shortlisted.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < shortlisted.length; rightIndex += 1) {
      const left = shortlisted[leftIndex];
      const right = shortlisted[rightIndex];
      const leftVariants = new Set(left.signature.variantTokens);
      const rightVariants = new Set(right.signature.variantTokens);
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

      // Both sold listings must have the same print run (or both have none)
      if (left.signature.printRun !== right.signature.printRun) {
        continue;
      }

      // Check variant COLOR consistency - if one is "Pink RayWave" and the other is "Forest Green RayWave", those are different parallels
      const leftColors = left.signature.variantTokens.filter((t) => !(/^\/\d/.test(t)));
      const rightColors = right.signature.variantTokens.filter((t) => !(/^\/\d/.test(t)));
      const colorsMatch = leftColors.length === rightColors.length &&
        leftColors.every((c) => rightColors.includes(c));
      if (!colorsMatch && (leftColors.length > 0 || rightColors.length > 0)) {
        continue;
      }

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

  // No consistent pair found — return best individual matches if strong enough
  // A single high-confidence match is enough to estimate profit
  if (shortlisted.length > 0 && shortlisted[0].match.score >= 8 &&
      shortlisted[0].match.identityFullCoverage &&
      shortlisted[0].match.specificCoverage >= 0.4) {
    return shortlisted;
  }

  // Even a single match with very high score is worth returning
  if (shortlisted.length > 0 && shortlisted[0].match.score >= 12) {
    return [shortlisted[0]];
  }

  return [];
}

module.exports = {
  chooseBestSoldListings,
  extractCardSignature,
  scoreSoldListing,
  translateFrToEn,
  getCategoryRejectionReasons,
  extractLegoSetNumber,
  extractCondition,
  extractTcgSetCode
};
