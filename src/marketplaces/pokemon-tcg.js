const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractCardSignature } = require('../matching');
const { normalizeSpaces, toSlugTokens } = require('../utils');

// Cache
const memoryCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function getCacheDir() {
  const dir = path.join(process.cwd(), 'output', 'http-cache', 'pokemon-api');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function cachedFetch(url) {
  const cached = memoryCache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const hash = crypto.createHash('sha1').update(url).digest('hex');
  const cachePath = path.join(getCacheDir(), `${hash}.json`);
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const payload = JSON.parse(raw);
    if (Date.now() - payload.ts < CACHE_TTL_MS) {
      memoryCache.set(url, payload);
      return payload.data;
    }
  } catch {}

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      ...(process.env.POKEMON_TCG_API_KEY ? { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY } : {})
    },
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    if (response.status === 429) throw new Error('rate-limit');
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const payload = { ts: Date.now(), data };
  memoryCache.set(url, payload);
  try { fs.writeFileSync(cachePath, JSON.stringify(payload)); } catch {}
  return data;
}

const API_BASE = 'https://api.pokemontcg.io/v2';

// Comprehensive French → English Pokemon name mapping
const FR_TO_EN = {
  // Gen 1
  bulbizarre: 'bulbasaur', herbizarre: 'ivysaur', florizarre: 'venusaur',
  salameche: 'charmander', reptincel: 'charmeleon', dracaufeu: 'charizard',
  carapuce: 'squirtle', carabaffe: 'wartortle', tortank: 'blastoise',
  chenipan: 'caterpie', chrysacier: 'metapod', papilusion: 'butterfree',
  aspicot: 'weedle', coconfort: 'kakuna', dardargnan: 'beedrill',
  roucool: 'pidgey', roucoups: 'pidgeotto', roucarnage: 'pidgeot',
  rattata: 'rattata', rattatac: 'raticate', piafabec: 'spearow', rapasdepic: 'fearow',
  abo: 'ekans', arbok: 'arbok', pikachu: 'pikachu', raichu: 'raichu',
  sabelette: 'sandshrew', sablaireau: 'sandslash',
  nidoran: 'nidoran', nidorina: 'nidorina', nidoqueen: 'nidoqueen',
  nidorino: 'nidorino', nidoking: 'nidoking',
  melofee: 'clefairy', melodelfe: 'clefable',
  goupix: 'vulpix', feunard: 'ninetales',
  rondoudou: 'jigglypuff', grodoudou: 'wigglytuff',
  nosferapti: 'zubat', nosferalto: 'golbat',
  mystherbe: 'oddish', ortide: 'gloom', rafflesia: 'vileplume',
  paras: 'paras', parasect: 'parasect',
  mimitoss: 'venonat', aeromite: 'venomoth',
  taupiqueur: 'diglett', triopikeur: 'dugtrio',
  miaouss: 'meowth', persian: 'persian',
  psykokwak: 'psyduck', akwakwak: 'golduck',
  ferosinge: 'mankey', colossinge: 'primeape',
  caninos: 'growlithe', arcanin: 'arcanine',
  ptitard: 'poliwag', tetarte: 'poliwhirl', tartard: 'poliwrath',
  abra: 'abra', kadabra: 'kadabra', alakazam: 'alakazam',
  machoc: 'machop', machopeur: 'machoke', mackogneur: 'machamp',
  chetiflor: 'bellsprout', boustiflor: 'weepinbell', empiflor: 'victreebel',
  tentacool: 'tentacool', tentacruel: 'tentacruel',
  racaillou: 'geodude', gravalanch: 'graveler', grolem: 'golem',
  ponyta: 'ponyta', galopa: 'rapidash',
  ramoloss: 'slowpoke', flagadoss: 'slowbro',
  magneti: 'magnemite', magneton: 'magneton',
  canarticho: 'farfetchd', doduo: 'doduo', dodrio: 'dodrio',
  otaria: 'seel', lamantine: 'dewgong',
  tadmorv: 'grimer', grotadmorv: 'muk',
  kokiyas: 'shellder', crustabri: 'cloyster',
  fantominus: 'gastly', spectrum: 'haunter', ectoplasma: 'gengar',
  onix: 'onix', soporifik: 'drowzee', hypnomade: 'hypno',
  krabby: 'krabby', krabboss: 'kingler',
  voltorbe: 'voltorb', electrode: 'electrode',
  noeunoeuf: 'exeggcute', noadkoko: 'exeggutor',
  osselait: 'cubone', ossatueur: 'marowak',
  tygnon: 'hitmonchan', kicklee: 'hitmonlee',
  excelangue: 'lickitung', smogo: 'koffing', smogogo: 'weezing',
  rhinocorne: 'rhyhorn', rhinoferos: 'rhydon',
  leveinard: 'chansey', saquedeneu: 'tangela',
  kangourex: 'kangaskhan', hypotrempe: 'horsea', hypocean: 'seadra',
  poissirene: 'goldeen', poissoroy: 'seaking',
  stari: 'staryu', staross: 'starmie',
  'mr. mime': 'mr. mime', insecateur: 'scyther',
  lippoutou: 'jynx', elektek: 'electabuzz', magmar: 'magmar',
  scarabrute: 'pinsir', tauros: 'tauros',
  magicarpe: 'magikarp', leviator: 'gyarados',
  lokhlass: 'lapras', metamorph: 'ditto',
  evoli: 'eevee', aquali: 'vaporeon', voltali: 'jolteon', pyroli: 'flareon',
  porygon: 'porygon', amonita: 'omanyte', amonistar: 'omastar',
  kabuto: 'kabuto', kabutops: 'kabutops',
  ptera: 'aerodactyl', ronflex: 'snorlax',
  artikodin: 'articuno', electhor: 'zapdos', sulfura: 'moltres',
  minidraco: 'dratini', draco: 'dragonair', dracolosse: 'dragonite',
  mewtwo: 'mewtwo', mew: 'mew',
  // Gen 2
  germignon: 'chikorita', macronium: 'bayleef', meganium: 'meganium',
  hericendre: 'cyndaquil', feurisson: 'quilava', typhlosion: 'typhlosion',
  kaiminus: 'totodile', crocrodil: 'croconaw', aligatueur: 'feraligatr',
  fouinette: 'sentret', fouinar: 'furret',
  hoothoot: 'hoothoot', noarfang: 'noctowl',
  coxy: 'ledyba', coxyclaque: 'ledian',
  mentali: 'espeon', noctali: 'umbreon',
  roigada: 'slowking', insolourdo: 'dunsparce',
  steelix: 'steelix', snubbull: 'snubbull', granbull: 'granbull',
  qwilfish: 'qwilfish', cizayox: 'scizor',
  heracross: 'heracross', farfuret: 'sneasel',
  teddiursa: 'teddiursa', ursaring: 'ursaring',
  delibird: 'delibird', cerfrousse: 'stantler',
  porygon2: 'porygon2', elekid: 'elekid', magby: 'magby',
  ecremeuh: 'miltank', leuphorie: 'blissey',
  raikou: 'raikou', entei: 'entei', suicune: 'suicune',
  embrylex: 'larvitar', ymphect: 'pupitar', tyranocif: 'tyranitar',
  lugia: 'lugia', 'ho-oh': 'ho-oh', celebi: 'celebi',
  // Gen 3+
  poussifeu: 'torchic', galifeu: 'combusken', brasegali: 'blaziken',
  gobou: 'mudkip', flobio: 'marshtomp', laggron: 'swampert',
  arcko: 'treecko', massko: 'grovyle', jungko: 'sceptile',
  gardevoir: 'gardevoir', gallame: 'gallade',
  hariyama: 'hariyama', makuhita: 'makuhita',
  absol: 'absol', metagross: 'metagross',
  latias: 'latias', latios: 'latios',
  kyogre: 'kyogre', groudon: 'groudon', rayquaza: 'rayquaza',
  deoxys: 'deoxys', jirachi: 'jirachi',
  // Gen 4
  tortipouss: 'turtwig', boskara: 'grotle', torterra: 'torterra',
  ouisticram: 'chimchar', chimpenfeu: 'monferno', simiabraz: 'infernape',
  tiplouf: 'piplup', prinplouf: 'prinplup', pingoleon: 'empoleon',
  lucario: 'lucario', riolu: 'riolu',
  carchacrok: 'garchomp', griknot: 'gible',
  togekiss: 'togekiss', togepi: 'togepi',
  dialga: 'dialga', palkia: 'palkia', giratina: 'giratina',
  darkrai: 'darkrai', cresselia: 'cresselia',
  heatran: 'heatran', regigigas: 'regigigas',
  arceus: 'arceus', phione: 'phione', manaphy: 'manaphy',
  // Gen 5
  victini: 'victini', zoroark: 'zoroark', zorua: 'zorua',
  reshiram: 'reshiram', zekrom: 'zekrom', kyurem: 'kyurem',
  genesect: 'genesect', keldeo: 'keldeo', meloetta: 'meloetta',
  // Gen 6
  marisson: 'chespin', blindepique: 'quilladin', blindepic: 'chesnaught',
  feunnec: 'fennekin', roussil: 'braixen', goupelin: 'delphox',
  grenousse: 'froakie', croasser: 'frogadier', amphinobi: 'greninja',
  xerneas: 'xerneas', yveltal: 'yveltal', zygarde: 'zygarde',
  diancie: 'diancie', hoopa: 'hoopa', volcanion: 'volcanion',
  // Gen 7
  brindibou: 'rowlet', efflèche: 'dartrix', archéduc: 'decidueye',
  flamiaou: 'litten', matoufeu: 'torracat', félinferno: 'incineroar',
  otaquin: 'popplio', otarlette: 'brionne', oratoria: 'primarina',
  solgaleo: 'solgaleo', lunala: 'lunala', necrozma: 'necrozma',
  cosmog: 'cosmog', cosmovum: 'cosmoem',
  tokorico: 'tapu koko', tokopiyon: 'tapu lele',
  tokotoro: 'tapu bulu', tokopisco: 'tapu fini',
  marshadow: 'marshadow', zeraora: 'zeraora', melmetal: 'melmetal',
  // Gen 8
  ouistempo: 'grookey', badabouin: 'thwackey', gorythmic: 'rillaboom',
  flambino: 'scorbunny', lapyro: 'raboot', pyrobut: 'cinderace',
  larmeleon: 'sobble', arrozard: 'drizzile', lezardon: 'inteleon',
  zacian: 'zacian', zamazenta: 'zamazenta', eternatus: 'eternatus',
  urshifu: 'urshifu', calyrex: 'calyrex',
  // Gen 9
  poussacha: 'sprigatito', floragato: 'floragato', miascarade: 'meowscarada',
  chochodile: 'fuecoco', crocogril: 'crocalor', flâmigator: 'skeledirge',
  coiffeton: 'quaxly', canarbello: 'quaxwell', palmaval: 'quaquaval',
  miraidon: 'miraidon', koraidon: 'koraidon',
  terapagos: 'terapagos', pecharunt: 'pecharunt',
  // Multi-word French names (Tag Team, etc.)
  'mentali deoxys': 'espeon & deoxys',
  'dracaufeu reshiram': 'charizard & reshiram',
  'mewtwo mew': 'mewtwo & mew',
  'pikachu zekrom': 'pikachu & zekrom',
  'leviator dracaufeu': 'gyarados & charizard'
};

// Card type suffixes
const CARD_TYPES = ['gx', 'ex', 'vmax', 'vstar', 'v', 'tag team', 'break', 'lv.x', 'prime', 'legend'];

// Set name mappings
const SET_ALIASES = {
  '151': 'sv3pt5', 'prismatic': 'sv8pt5', 'prismatic evolutions': 'sv8pt5',
  'paldean fates': 'sv4pt5', 'obsidian flames': 'sv3', 'paradox rift': 'sv4',
  'temporal forces': 'sv5', 'twilight masquerade': 'sv6', 'shrouded fable': 'sv6pt5',
  'stellar crown': 'sv7', 'surging sparks': 'sv8', 'scarlet violet': 'sv1',
  'paldea evolved': 'sv2', 'crown zenith': 'swsh12pt5',
  'silver tempest': 'swsh12', 'lost origin': 'swsh11',
  'astral radiance': 'swsh10', 'brilliant stars': 'swsh9',
  'vivid voltage': 'swsh4', 'darkness ablaze': 'swsh3',
  'rebel clash': 'swsh2', 'sword shield': 'swsh1',
  'champions path': 'swsh35', 'shining fates': 'swsh45',
  'celebrations': 'cel25', 'hidden fates': 'sm115',
  'cosmic eclipse': 'sm12', 'unified minds': 'sm11',
  'unbroken bonds': 'sm10', 'team up': 'sm9',
  'celestial storm': 'sm7', 'ultra prism': 'sm5',
  'guardians rising': 'sm2', 'sun moon': 'sm1',
  'evolutions': 'xy12', 'generations': 'g1',
  'xy base': 'xy1'
};

// PSA grade premium multipliers (approximate market data)
const PSA_PREMIUMS = {
  '10': 5.0,   // PSA 10 = ~5x raw card value
  '9': 2.0,    // PSA 9 = ~2x
  '8': 1.3,    // PSA 8 = ~1.3x
  '7': 1.0,    // PSA 7 = ~raw value
};

function extractPokemonSearchTerms(vintedTitle) {
  const sig = extractCardSignature(vintedTitle);
  const lower = vintedTitle.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = toSlugTokens(vintedTitle);

  // Detect card type suffix (GX, EX, V, VMAX, VSTAR)
  let cardType = null;
  for (const ct of CARD_TYPES) {
    if (lower.includes(ct)) {
      cardType = ct.toUpperCase();
      break;
    }
  }

  // Detect PSA/grading
  let graded = false;
  let gradeValue = null;
  const gradeMatch = lower.match(/(?:psa|bgs|sgc|cgc)\s*(\d{1,2})/);
  if (gradeMatch) {
    graded = true;
    gradeValue = gradeMatch[1];
  }

  // Try multi-word French names first (e.g., "mentali deoxys" → "espeon & deoxys")
  let pokemonName = null;
  for (const [fr, en] of Object.entries(FR_TO_EN)) {
    if (fr.includes(' ') && lower.includes(fr)) {
      pokemonName = en;
      break;
    }
  }

  // Try single-word French names
  if (!pokemonName) {
    for (const token of tokens) {
      if (FR_TO_EN[token]) {
        pokemonName = FR_TO_EN[token];
        break;
      }
    }
  }

  // If no French match, build from title directly
  if (!pokemonName) {
    const skip = new Set([
      'carte', 'card', 'pokemon', 'illustration', 'rare', 'full', 'art',
      'secret', 'promo', 'holo', 'reverse', 'gold', 'silver', 'psa',
      'bgs', 'sgc', 'cgc', 'mint', 'near', 'excellent', 'played',
      'japonais', 'japonaise', 'japanese', 'francais', 'francaise',
      'anglais', 'anglaise', 'english', 'neuf', 'occasion', 'etat',
      'comme', 'tres', 'bon', 'prix', 'grade', 'graded', 'slab'
    ]);
    // Also skip card type tokens and numbers
    const candidates = tokens.filter(t =>
      !skip.has(t) && t.length >= 3 && !/^\d+$/.test(t) &&
      !CARD_TYPES.includes(t)
    );
    if (candidates.length > 0) {
      // Take first 2 candidates as Pokemon name (handles multi-word names)
      pokemonName = candidates.slice(0, 2).join(' ');
    }
  }

  // Append card type to name for more precise search
  let searchName = pokemonName;
  if (pokemonName && cardType && !pokemonName.toLowerCase().includes(cardType.toLowerCase())) {
    searchName = `${pokemonName} ${cardType}`;
  }

  // Extract set info
  let setId = null;
  for (const [alias, id] of Object.entries(SET_ALIASES)) {
    if (lower.includes(alias)) {
      setId = id;
      break;
    }
  }

  // Extract card number (strip leading zeros)
  const rawCardNumber = sig.cardNumber;
  const cardNumber = rawCardNumber ? rawCardNumber.replace(/^0+/, '') || rawCardNumber : null;

  // Detect rarity from title
  let rarity = null;
  if (lower.includes('illustration rare') || lower.includes('illustration speciale')) rarity = 'Illustration Rare';
  else if (lower.includes('art rare') || lower.includes('special art')) rarity = 'Special Art Rare';
  else if (lower.includes('full art')) rarity = 'Ultra Rare';
  else if (lower.includes('gold') || lower.includes('secret')) rarity = 'Hyper Rare';
  else if (lower.includes('rainbow')) rarity = 'Rare Rainbow';

  return { pokemonName, searchName, setId, cardNumber, cardType, graded, gradeValue, rarity, signature: sig };
}

function extractBestPrice(card, terms) {
  const cm = card.cardmarket?.prices;
  const tcg = card.tcgplayer?.prices;

  let cardmarketPrice = null;
  let tcgplayerPrice = null;

  if (cm) {
    cardmarketPrice = cm.trendPrice || cm.averageSellPrice || cm.avg7 || cm.avg30 || cm.lowPrice;
  }

  if (tcg) {
    // Match the right variant based on rarity
    const variantPriority = terms?.rarity === 'Illustration Rare' || terms?.rarity === 'Special Art Rare'
      ? ['holofoil', 'reverseHolofoil', 'normal']
      : ['holofoil', 'normal', 'reverseHolofoil', '1stEditionHolofoil', 'unlimitedHolofoil'];

    for (const variant of variantPriority) {
      if (tcg[variant]?.market > 0) {
        tcgplayerPrice = tcg[variant].market;
        break;
      }
      if (tcg[variant]?.mid > 0) {
        tcgplayerPrice = tcg[variant].mid;
        break;
      }
    }
    // Fallback: any variant with a price
    if (!tcgplayerPrice) {
      for (const variant of Object.values(tcg)) {
        if (variant?.market > 0) { tcgplayerPrice = variant.market; break; }
      }
    }
  }

  let bestPrice = cardmarketPrice > 0 ? cardmarketPrice : (tcgplayerPrice ? tcgplayerPrice * 0.865 : null);

  // Apply PSA premium if graded
  if (bestPrice && terms?.graded && terms?.gradeValue) {
    const premium = PSA_PREMIUMS[terms.gradeValue] || 1.5;
    bestPrice = bestPrice * premium;
  }

  return {
    cardmarketPrice,
    tcgplayerPrice,
    bestPrice,
    source: cardmarketPrice > 0 ? 'cardmarket' : (tcgplayerPrice ? 'tcgplayer' : null),
    allPrices: { cardmarket: cm || null, tcgplayer: tcg || null }
  };
}

function scoreCardMatch(card, terms) {
  let score = 0;
  const cardNameLower = (card.name || '').toLowerCase();
  const searchName = (terms.searchName || terms.pokemonName || '').toLowerCase();
  const baseName = (terms.pokemonName || '').toLowerCase();

  // Card number match (strongest signal)
  if (terms.cardNumber && card.number === terms.cardNumber) {
    score += 15;
  }

  // Set match
  if (terms.setId && card.set?.id === terms.setId) {
    score += 8;
  }

  // Name match
  if (searchName) {
    if (cardNameLower === searchName || cardNameLower === baseName) {
      score += 10;
    } else if (cardNameLower.includes(baseName)) {
      score += 6;
    } else if (baseName.includes(cardNameLower)) {
      score += 4;
    }
  }

  // Card type match (GX, EX, V, etc.)
  if (terms.cardType) {
    const cardSubtypes = (card.subtypes || []).map(s => s.toLowerCase());
    const cardNameHasType = cardNameLower.includes(terms.cardType.toLowerCase());
    if (cardNameHasType || cardSubtypes.includes(terms.cardType.toLowerCase())) {
      score += 5;
    } else {
      score -= 5; // Wrong card type = big penalty
    }
  }

  // Rarity match
  if (terms.rarity && card.rarity) {
    if (card.rarity.toLowerCase().includes(terms.rarity.toLowerCase().split(' ')[0])) {
      score += 3;
    }
  }

  // Prefer cards with prices
  const pricing = extractBestPrice(card, terms);
  if (pricing.bestPrice && pricing.bestPrice > 0) {
    score += 2;
  }

  return score;
}

async function getPokemonMarketPrice(vintedListing, config) {
  const terms = extractPokemonSearchTerms(vintedListing.title);

  if (!terms.pokemonName && !terms.cardNumber) {
    return null;
  }

  // Build query strategies from most specific to broadest
  const queries = [];

  // Strategy 1: set + number (most precise, identifies exact card)
  if (terms.setId && terms.cardNumber) {
    queries.push(`set.id:${terms.setId} number:${terms.cardNumber}`);
  }

  // Strategy 2: name with type + set
  if (terms.searchName && terms.setId) {
    queries.push(`name:"${terms.searchName}" set.id:${terms.setId}`);
  }

  // Strategy 3: name with type + number
  if (terms.searchName && terms.cardNumber) {
    queries.push(`name:"${terms.searchName}" number:${terms.cardNumber}`);
  }

  // Strategy 4: exact name with type
  if (terms.searchName) {
    queries.push(`name:"${terms.searchName}"`);
  }

  // Strategy 5: base name (without type suffix)
  if (terms.pokemonName && terms.pokemonName !== terms.searchName) {
    queries.push(`name:"${terms.pokemonName}*"`);
  }

  try {
    let cards = [];

    for (const q of queries) {
      if (cards.length > 0) break;
      const apiUrl = `${API_BASE}/cards?q=${encodeURIComponent(q)}&pageSize=10&orderBy=-set.releaseDate`;
      try {
        const data = await cachedFetch(apiUrl);
        cards = data.data || [];
      } catch (err) {
        if (err.message === 'rate-limit') {
          console.log('    Pokemon TCG API rate limit, skipping...');
          return null;
        }
        continue;
      }
    }

    if (cards.length === 0) return null;

    // Score and rank
    const scored = cards
      .map(card => ({ card, score: scoreCardMatch(card, terms), pricing: extractBestPrice(card, terms) }))
      .filter(r => r.pricing.bestPrice && r.pricing.bestPrice > 0 && r.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;

    const best = scored[0];
    const gradeLabel = terms.graded ? ` (PSA ${terms.gradeValue})` : '';

    // Only keep results with score close to best
    const goodMatches = scored.filter(r => r.score >= best.score - 5 && r.score > 0);

    const matchedSales = goodMatches.slice(0, 3).map(r => ({
      title: `${r.card.name} - ${r.card.set?.name || ''} #${r.card.number || '?'} [${r.card.rarity || '?'}]${gradeLabel}`,
      price: r.pricing.bestPrice,
      totalPrice: r.pricing.bestPrice,
      shippingPrice: 0,
      soldAt: null,
      soldAtTs: Date.now(),
      url: r.card.cardmarket?.url || `https://www.cardmarket.com/en/Pokemon/Products/Singles?searchString=${encodeURIComponent(r.card.name)}`,
      itemKey: `ptcg-${r.card.id}`,
      imageUrl: r.card.images?.small || r.card.images?.large || '',
      marketplace: 'cardmarket',
      queryUsed: `Pokemon TCG API: ${r.card.name}`,
      match: {
        score: r.score,
        sharedTokens: [],
        sharedSpecificTokens: [r.card.name],
        sharedIdentityTokens: [r.card.name],
        specificCoverage: r.score >= 15 ? 1.0 : r.score >= 8 ? 0.7 : 0.4,
        missingCritical: false,
        identityFullCoverage: true
      },
      imageMatch: {
        score: r.score >= 15 ? 0.95 : r.score >= 8 ? 0.80 : 0.60,
        confidence: r.score >= 15 ? 'high' : r.score >= 8 ? 'medium' : 'low'
      },
      apiData: {
        source: 'pokemon-tcg-api',
        cardId: r.card.id,
        cardName: r.card.name,
        setName: r.card.set?.name,
        number: r.card.number,
        rarity: r.card.rarity,
        graded: terms.graded,
        gradeValue: terms.gradeValue,
        cardmarketPrices: r.pricing.allPrices.cardmarket,
        tcgplayerPrices: r.pricing.allPrices.tcgplayer
      }
    }));

    return {
      matchedSales,
      pricingSource: 'pokemon-tcg-api',
      bestMatch: `${best.card.name}${gradeLabel}`,
      marketPrice: best.pricing.bestPrice,
      confidence: best.score >= 15 ? 'high' : best.score >= 8 ? 'medium' : 'low'
    };
  } catch (error) {
    console.error(`    Pokemon TCG API error: ${error.message}`);
    return null;
  }
}

module.exports = {
  getPokemonMarketPrice,
  extractPokemonSearchTerms
};
