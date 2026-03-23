/**
 * Agent Diagnostic — Analyse la santé des niches et explore de nouvelles plateformes.
 *
 * Responsabilités :
 *   1. Analyser les scans échoués (taux de succès, parsing, blocages)
 *   2. Vérifier la validité des niches (morte vs problème technique)
 *   3. Explorer les plateformes alternatives (Cardmarket, Leboncoin, etc.)
 *   4. Produire un rapport de santé avec score par niche
 *   5. Envoyer un résumé via Telegram
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { fetchText } = require('../http');
const { sendTelegramMessage } = require('../notifier');
const { sleep } = require('../utils');

// ─── Constantes ──────────────────────────────────────────────────────

const HEALTH_THRESHOLDS = {
  CRITICAL: 20,   // < 20 = niche en danger critique
  WARNING: 50,    // < 50 = à surveiller
  HEALTHY: 75     // >= 75 = en bonne santé
};

const CONSECUTIVE_FAILURES_THRESHOLD = 5;

// Plateformes alternatives à évaluer
const ALTERNATIVE_PLATFORMS = [
  {
    name: 'Cardmarket',
    url: 'https://www.cardmarket.com',
    type: 'marketplace_tcg',
    scrapeMethod: 'html',
    relevantNiches: ['Pokemon', 'Yu-Gi-Oh', 'One Piece TCG'],
    testPath: '/en/Pokemon/Products/Singles',
    pros: ['API publique partielle', 'Spécialisé TCG', 'Prix de marché fiables', 'Gros volume EU'],
    cons: ['Nécessite auth pour API complète', 'Rate-limiting strict'],
    difficulty: 'medium',
    priority: 'high'
  },
  {
    name: 'Leboncoin',
    url: 'https://www.leboncoin.fr',
    type: 'marketplace_general',
    scrapeMethod: 'api_json',
    relevantNiches: ['Pokemon', 'Yu-Gi-Oh', 'One Piece TCG', 'Panini Football', 'Topps F1', 'Topps Chrome Football'],
    testPath: '/recherche?text=carte+pokemon+rare&category=30',
    pros: ['Gros volume FR', 'API JSON interne exploitable', 'Bons deals de particuliers'],
    cons: ['Anti-bot agressif (DataDome)', 'Pas de ventes terminées visibles'],
    difficulty: 'hard',
    priority: 'medium'
  },
  {
    name: 'Facebook Marketplace',
    url: 'https://www.facebook.com/marketplace',
    type: 'marketplace_general',
    scrapeMethod: 'graphql',
    relevantNiches: ['Pokemon', 'Yu-Gi-Oh', 'One Piece TCG', 'Panini Football'],
    testPath: '/marketplace/search/?query=carte%20pokemon%20rare',
    pros: ['Très gros volume', 'Deals de particuliers sous-évalués'],
    cons: ['Auth obligatoire', 'GraphQL complexe', 'Risque ban compte', 'Déjà partiellement implémenté'],
    difficulty: 'hard',
    priority: 'low'
  },
  {
    name: 'Wallapop',
    url: 'https://www.wallapop.com',
    type: 'marketplace_general',
    scrapeMethod: 'api_json',
    relevantNiches: ['Pokemon', 'Yu-Gi-Oh', 'Panini Football', 'Topps Chrome Football'],
    testPath: '/app/search?keywords=pokemon+card+rare&category_ids=12467',
    pros: ['API REST ouverte', 'Gros marché ES/IT', 'Peu de concurrence bot'],
    cons: ['Marché ES/IT principalement', 'Volume plus faible sur TCG'],
    difficulty: 'easy',
    priority: 'high'
  },
  {
    name: 'Rakuten (PriceMinister)',
    url: 'https://fr.shopping.rakuten.com',
    type: 'marketplace_general',
    scrapeMethod: 'html',
    relevantNiches: ['Pokemon', 'Yu-Gi-Oh', 'One Piece TCG'],
    testPath: '/offer/buy/7148283070/carte-pokemon-rare.html',
    pros: ['Prix fixes affichés', 'Structure HTML stable', 'Marché FR solide'],
    cons: ['Principalement vendeurs pro', 'Moins de deals'],
    difficulty: 'medium',
    priority: 'medium'
  },
  {
    name: 'Amazon Warehouse',
    url: 'https://www.amazon.fr',
    type: 'marketplace_general',
    scrapeMethod: 'html',
    relevantNiches: ['Pokemon'],
    testPath: '/s?k=carte+pokemon+rare&i=warehouse-deals',
    pros: ['Deals Warehouse intéressants', 'Structure stable'],
    cons: ['Peu de cartes individuelles', 'Plutôt sealed product', 'Anti-bot Amazon'],
    difficulty: 'hard',
    priority: 'low'
  }
];

// ─── Analyse des scans par niche ─────────────────────────────────────

/**
 * Charge l'historique des scans (le dernier + éventuels précédents).
 * Retourne un tableau d'objets scanResult.
 */
function loadScanHistory(config) {
  const scanHistory = [];

  // Charger le scan le plus récent
  const latestPath = path.join(config.outputDir, 'latest-scan.json');
  try {
    if (fs.existsSync(latestPath)) {
      const data = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
      scanHistory.push(data);
    }
  } catch (error) {
    console.log(`[Diagnostic] Impossible de lire latest-scan.json: ${error.message}`);
  }

  // Charger les résultats agents précédents si disponibles
  const agentDir = path.join(config.outputDir, 'agents');
  try {
    if (fs.existsSync(agentDir)) {
      const files = fs.readdirSync(agentDir)
        .filter((f) => f.startsWith('pipeline-') || f === 'pipeline-latest.json')
        .sort()
        .reverse()
        .slice(0, 10);

      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(agentDir, file), 'utf8'));
          if (data.scanResult) {
            scanHistory.push(data.scanResult);
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  return scanHistory;
}

/**
 * Analyse le taux de succès des scans pour chaque niche.
 */
function analyzeNicheSuccessRates(scanHistory, searches) {
  const nicheStats = new Map();

  // Initialiser les stats pour chaque niche configurée
  for (const search of searches) {
    nicheStats.set(search.name, {
      name: search.name,
      totalScans: 0,
      successfulScans: 0,      // au moins 1 listing trouvé
      zeroResultScans: 0,      // 0 listing
      totalListingsFound: 0,
      totalOpportunities: 0,
      consecutiveZeroResults: 0,
      lastListingCount: 0,
      queriesConfigured: search.vintedQueries ? search.vintedQueries.length : 0,
      pricingSource: search.pricingSource || 'ebay',
      maxPrice: search.maxPrice
    });
  }

  // Agréger les données des scans
  for (const scan of scanHistory) {
    const listings = scan.searchedListings || [];
    const opportunities = scan.opportunities || [];

    // Compter les listings par niche
    const listingsByNiche = new Map();
    for (const listing of listings) {
      const niche = listing.search || 'unknown';
      listingsByNiche.set(niche, (listingsByNiche.get(niche) || 0) + 1);
    }

    // Compter les opportunités par niche
    const oppsByNiche = new Map();
    for (const opp of opportunities) {
      const niche = opp.search || 'unknown';
      oppsByNiche.set(niche, (oppsByNiche.get(niche) || 0) + 1);
    }

    // Mettre à jour les stats
    for (const [nicheName, stats] of nicheStats) {
      const listingCount = listingsByNiche.get(nicheName) || 0;
      const oppCount = oppsByNiche.get(nicheName) || 0;

      stats.totalScans += 1;
      stats.totalListingsFound += listingCount;
      stats.totalOpportunities += oppCount;

      if (listingCount > 0) {
        stats.successfulScans += 1;
        stats.consecutiveZeroResults = 0;
      } else {
        stats.zeroResultScans += 1;
        stats.consecutiveZeroResults += 1;
      }

      stats.lastListingCount = listingCount;
    }
  }

  return nicheStats;
}

// ─── Diagnostic approfondi d'une niche ───────────────────────────────

/**
 * Pour une niche à 0 résultat, vérifie la cause :
 *   - Page Vinted vide (la niche est morte)
 *   - Page Vinted bloquée (captcha/anti-bot)
 *   - Sélecteurs CSS cassés (parsing KO)
 *   - eBay bloqué pour cette niche
 */
async function deepDiagnoseNiche(search, config) {
  console.log(`  [Diagnostic] Diagnostic approfondi: ${search.name}`);

  const diagnosis = {
    niche: search.name,
    vintedStatus: 'unknown',
    ebayStatus: 'unknown',
    issues: [],
    suggestions: []
  };

  // ── Test Vinted ──
  const vintedQueries = search.vintedQueries || [];
  const vintedCacheDir = path.join(config.outputDir, 'http-cache', 'vinted');
  let vintedEmptyCount = 0;
  let vintedBlockedCount = 0;
  let vintedParsingBrokenCount = 0;
  let vintedOkCount = 0;
  const testedQueries = vintedQueries.slice(0, 3); // Tester max 3 queries

  for (const query of testedQueries) {
    const url = `https://www.vinted.fr/catalog?search_text=${encodeURIComponent(query)}`;
    try {
      const html = await fetchText(url, {
        timeoutMs: config.requestTimeoutMs || 30000,
        cacheDir: vintedCacheDir,
        cacheTtlSeconds: 300, // Cache court pour le diagnostic
        minDelayMs: config.httpMinDelayMs || 1500,
        maxDelayMs: config.httpMaxDelayMs || 3000,
        skipCache: true // On veut le résultat frais
      });

      const bodyLength = html.length;
      const $ = cheerio.load(html);
      const bodyText = $('body').text().toLowerCase();

      // Vérifier si bloqué
      const blockedMarkers = ['captcha', 'robot', 'access denied', 'cloudflare', 'just a moment'];
      const isBlocked = blockedMarkers.some((m) => bodyText.includes(m));

      if (isBlocked) {
        vintedBlockedCount += 1;
        continue;
      }

      // Vérifier si page vide (aucun item)
      if (bodyLength < 3000) {
        vintedEmptyCount += 1;
        continue;
      }

      // Vérifier si des items existent mais ne sont pas parsés
      const hasItemLinks = $('a[href*="/items/"]').length;
      const hasPriceIndicators = bodyText.match(/\d+[.,]\d{2}\s*€/g);

      if (hasItemLinks > 0 || (hasPriceIndicators && hasPriceIndicators.length > 2)) {
        // Il y a des items mais le parsing ne les extrait peut-être pas
        // Tester le parser
        const jsonPatterns = [
          /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
          /"catalogItems"\s*:\s*(\[[\s\S]*?\])\s*[,}]/i,
          /"items"\s*:\s*(\[[\s\S]*?\])\s*[,}]/i
        ];

        let foundJson = false;
        for (const pattern of jsonPatterns) {
          if (pattern.test(html)) {
            foundJson = true;
            break;
          }
        }

        if (!foundJson && hasItemLinks > 0) {
          vintedParsingBrokenCount += 1;
        } else {
          vintedOkCount += 1;
        }
      } else {
        // Page chargée mais vraiment aucun résultat
        vintedEmptyCount += 1;
      }
    } catch (error) {
      diagnosis.issues.push(`Erreur Vinted pour "${query}": ${error.message}`);
    }

    await sleep(1500);
  }

  // Déterminer le statut Vinted
  if (vintedBlockedCount === testedQueries.length) {
    diagnosis.vintedStatus = 'blocked';
    diagnosis.issues.push('TOUTES les pages Vinted sont bloquées (anti-bot/captcha)');
    diagnosis.suggestions.push('Utiliser un proxy résidentiel ou attendre avant de re-scanner');
  } else if (vintedEmptyCount === testedQueries.length) {
    diagnosis.vintedStatus = 'empty';
    diagnosis.issues.push('Aucun résultat Vinted pour toutes les queries — niche potentiellement morte');
    diagnosis.suggestions.push('Vérifier manuellement sur Vinted, ajuster les queries ou supprimer la niche');
  } else if (vintedParsingBrokenCount > 0) {
    diagnosis.vintedStatus = 'parsing_broken';
    diagnosis.issues.push(`Sélecteurs CSS cassés: ${vintedParsingBrokenCount}/${testedQueries.length} pages ont du contenu mais 0 extractions`);
    diagnosis.suggestions.push('Mettre à jour les sélecteurs dans src/marketplaces/vinted.js');
  } else if (vintedOkCount > 0) {
    diagnosis.vintedStatus = 'ok';
  }

  // ── Test eBay ──
  if (search.pricingSource === 'ebay') {
    const ebayCacheDir = path.join(config.outputDir, 'http-cache', 'ebay');
    const testQuery = vintedQueries[0] || search.name;
    const ebayUrl = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(testQuery)}&LH_Sold=1&LH_Complete=1&_sacat=261328`;

    try {
      const html = await fetchText(ebayUrl, {
        timeoutMs: config.requestTimeoutMs || 30000,
        cacheDir: ebayCacheDir,
        cacheTtlSeconds: 300,
        minDelayMs: config.httpMinDelayMs || 1500,
        maxDelayMs: config.httpMaxDelayMs || 3000
      });

      const $ = cheerio.load(html);
      const bodyText = $('body').text().toLowerCase();
      const blockedMarkers = ['access denied', 'unusual traffic', 'captcha', 'robot check'];
      const isBlocked = blockedMarkers.some((m) => bodyText.includes(m));

      if (isBlocked) {
        diagnosis.ebayStatus = 'blocked';
        diagnosis.issues.push('eBay bloqué (captcha/anti-bot)');
        diagnosis.suggestions.push('Utiliser ScraperAPI ou un proxy pour eBay');
      } else {
        const soldItems = $('li.s-card, li.s-item, li[data-view]').length;
        if (soldItems > 0) {
          diagnosis.ebayStatus = 'ok';
        } else {
          diagnosis.ebayStatus = 'no_results';
          diagnosis.issues.push('eBay retourne 0 vente terminée pour cette niche');
        }
      }
    } catch (error) {
      diagnosis.ebayStatus = 'error';
      diagnosis.issues.push(`Erreur eBay: ${error.message}`);
    }
  } else {
    diagnosis.ebayStatus = 'not_applicable';
  }

  return diagnosis;
}

// ─── Score de santé par niche ────────────────────────────────────────

/**
 * Calcule un score de santé (0-100) pour une niche.
 *
 * Facteurs :
 *   - Taux de succès des scans (40%)
 *   - Nombre de listings trouvés (20%)
 *   - Nombre d'opportunités (20%)
 *   - Absence de problèmes techniques (20%)
 */
function computeNicheHealthScore(stats, diagnosis) {
  let score = 0;

  // 1. Taux de succès des scans (0-40)
  if (stats.totalScans > 0) {
    const successRate = stats.successfulScans / stats.totalScans;
    score += 40 * successRate;
  }

  // 2. Volume de listings (0-20)
  if (stats.totalScans > 0) {
    const avgListings = stats.totalListingsFound / stats.totalScans;
    if (avgListings >= 50) {
      score += 20;
    } else if (avgListings >= 20) {
      score += 15;
    } else if (avgListings >= 5) {
      score += 10;
    } else if (avgListings > 0) {
      score += 5;
    }
  }

  // 3. Opportunités trouvées (0-20)
  if (stats.totalOpportunities > 0) {
    score += Math.min(20, stats.totalOpportunities * 4);
  }

  // 4. Santé technique (0-20)
  if (diagnosis) {
    if (diagnosis.vintedStatus === 'ok' && diagnosis.ebayStatus === 'ok') {
      score += 20;
    } else if (diagnosis.vintedStatus === 'ok' || diagnosis.ebayStatus === 'ok') {
      score += 10;
    } else if (diagnosis.vintedStatus === 'blocked' || diagnosis.ebayStatus === 'blocked') {
      score += 5; // Problème temporaire, pas mort
    }
    // 'empty' ou 'parsing_broken' = 0 points
  } else {
    // Pas de diagnostic approfondi, bonus par défaut si des résultats existent
    if (stats.lastListingCount > 0) {
      score += 15;
    }
  }

  // Pénalité pour zéros consécutifs
  if (stats.consecutiveZeroResults >= CONSECUTIVE_FAILURES_THRESHOLD) {
    score *= 0.5;
  }

  return Math.round(Math.min(100, Math.max(0, score)));
}

// ─── Vérification de validité des niches ─────────────────────────────

/**
 * Pour les niches à 0 résultat, vérifie si la niche est vivante
 * en regardant le volume actuel sur Vinted.
 */
async function checkNicheViability(search, config) {
  const queries = (search.vintedQueries || []).slice(0, 2);
  let totalFound = 0;

  for (const query of queries) {
    const url = `https://www.vinted.fr/catalog?search_text=${encodeURIComponent(query)}`;
    try {
      const html = await fetchText(url, {
        timeoutMs: config.requestTimeoutMs || 30000,
        minDelayMs: 2000,
        maxDelayMs: 4000,
        skipCache: true
      });

      // Tenter d'extraire le nombre total de résultats
      const countMatch = html.match(/"totalCount"\s*:\s*(\d+)/i)
        || html.match(/"total_items"\s*:\s*(\d+)/i)
        || html.match(/"itemCount"\s*:\s*(\d+)/i)
        || html.match(/(\d+)\s*résultat/i);

      if (countMatch) {
        totalFound += parseInt(countMatch[1], 10);
      } else {
        // Compter les liens d'items comme proxy
        const $ = cheerio.load(html);
        totalFound += $('a[href*="/items/"]').length;
      }
    } catch { /* ignore */ }

    await sleep(2000);
  }

  return {
    niche: search.name,
    estimatedActiveListings: totalFound,
    isViable: totalFound > 5,
    checkedAt: new Date().toISOString()
  };
}

/**
 * Détecte si une niche est saisonnière en analysant le calendrier TCG.
 */
function detectSeasonality(search) {
  const TCG_RELEASE_CALENDAR = require('./discovery').TCG_RELEASE_CALENDAR;
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const seasonalInfo = {
    isSeasonal: false,
    currentSeason: 'normal',
    nextRelease: null,
    note: ''
  };

  // Mapper les niches aux univers TCG
  const nicheToUniverse = {
    'Pokemon': 'pokemon',
    'Yu-Gi-Oh': 'yugioh',
    'One Piece TCG': 'onepiece',
    'Topps F1': 'topps',
    'Topps Chrome Football': 'topps',
    'Panini Football': 'panini'
  };

  const universe = nicheToUniverse[search.name];
  if (!universe || !TCG_RELEASE_CALENDAR[universe]) {
    return seasonalInfo;
  }

  const calendarData = TCG_RELEASE_CALENDAR[universe];
  const recentSets = calendarData.recentSets || [];

  // Trouver la prochaine sortie
  for (const set of recentSets) {
    const [year, month] = set.date.split('-').map(Number);
    const releaseDate = new Date(year, month - 1, 1);

    if (releaseDate > now) {
      seasonalInfo.nextRelease = {
        name: set.name,
        date: set.date,
        hype: set.hype
      };
      break;
    }

    // Si un set à forte hype est sorti il y a moins de 2 mois
    const monthsAgo = (now.getFullYear() - year) * 12 + (currentMonth - month);
    if (monthsAgo <= 2 && (set.hype === 'high' || set.hype === 'very_high')) {
      seasonalInfo.isSeasonal = true;
      seasonalInfo.currentSeason = 'post_release_peak';
      seasonalInfo.note = `Set "${set.name}" sorti récemment (${set.hype}) — pic d'activité attendu`;
    }
  }

  // Noël et Black Friday = peak season pour les cartes
  if (currentMonth === 11 || currentMonth === 12) {
    seasonalInfo.isSeasonal = true;
    seasonalInfo.currentSeason = 'holiday_peak';
    seasonalInfo.note = 'Période fêtes — volume élevé, prix parfois gonflés';
  }

  // Été = creux
  if (currentMonth >= 6 && currentMonth <= 8) {
    seasonalInfo.currentSeason = 'summer_dip';
    seasonalInfo.note = 'Période estivale — volume potentiellement plus bas';
  }

  return seasonalInfo;
}

// ─── Évaluation des plateformes alternatives ─────────────────────────

/**
 * Pour chaque plateforme alternative, vérifie si le scraping est faisable.
 * Ne fait PAS de vrai scraping, juste un test de connectivité + structure.
 */
async function evaluateAlternativePlatforms(searches, config) {
  console.log('[Diagnostic] Évaluation des plateformes alternatives...');
  const evaluations = [];

  for (const platform of ALTERNATIVE_PLATFORMS) {
    const evaluation = {
      ...platform,
      accessible: false,
      responseTime: null,
      antiBot: 'unknown',
      recommendedNiches: [],
      overallScore: 0
    };

    // Tester l'accessibilité
    const testUrl = `${platform.url}${platform.testPath}`;
    const startMs = Date.now();

    try {
      const html = await fetchText(testUrl, {
        timeoutMs: 15000,
        minDelayMs: 1000,
        maxDelayMs: 2000,
        skipCache: true
      });

      evaluation.responseTime = Date.now() - startMs;
      evaluation.accessible = true;

      // Vérifier l'anti-bot
      const lowerHtml = html.toLowerCase();
      const antiBotMarkers = [
        'captcha', 'cloudflare', 'datadome', 'recaptcha',
        'robot', 'access denied', 'blocked'
      ];
      const hasAntiBot = antiBotMarkers.some((m) => lowerHtml.includes(m));
      evaluation.antiBot = hasAntiBot ? 'detected' : 'none';

      // Vérifier si la structure est exploitable
      const hasJsonData = lowerHtml.includes('"price"') ||
        lowerHtml.includes('"items"') ||
        lowerHtml.includes('"products"');
      const hasStructuredHtml = lowerHtml.includes('itemscope') ||
        lowerHtml.includes('data-testid') ||
        lowerHtml.includes('class="product');

      if (hasJsonData) {
        evaluation.scrapeMethod = 'api_json';
      } else if (hasStructuredHtml) {
        evaluation.scrapeMethod = 'html_structured';
      }
    } catch (error) {
      evaluation.accessible = false;
      evaluation.error = error.message;
    }

    // Calculer les niches pertinentes
    for (const search of searches) {
      if (platform.relevantNiches.includes(search.name)) {
        evaluation.recommendedNiches.push(search.name);
      }
    }

    // Score global (0-100)
    let score = 0;
    if (evaluation.accessible) score += 30;
    if (evaluation.antiBot === 'none') score += 25;
    if (evaluation.responseTime && evaluation.responseTime < 5000) score += 15;
    if (evaluation.difficulty === 'easy') score += 20;
    else if (evaluation.difficulty === 'medium') score += 10;
    if (evaluation.priority === 'high') score += 10;
    else if (evaluation.priority === 'medium') score += 5;

    evaluation.overallScore = Math.min(100, score);

    evaluations.push(evaluation);
    await sleep(2000);
  }

  // Trier par score
  evaluations.sort((a, b) => b.overallScore - a.overallScore);

  return evaluations;
}

// ─── Analyse du cache HTTP pour détecter les blocages ────────────────

/**
 * Analyse le cache HTTP pour détecter les pages bloquées par plateforme.
 */
async function analyzeCacheHealth(config) {
  const cacheStats = {
    vinted: { total: 0, blocked: 0, empty: 0, ok: 0 },
    ebay: { total: 0, blocked: 0, empty: 0, ok: 0 }
  };

  const blockedMarkers = [
    '<title>access denied',
    '<title>pardon our interruption',
    'robot check',
    'unusual traffic',
    'captcha',
    'splashui'
  ];

  for (const platform of ['vinted', 'ebay']) {
    const cacheDir = path.join(config.outputDir, 'http-cache', platform);
    try {
      if (!fs.existsSync(cacheDir)) continue;

      const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
      // Échantillonner au maximum 50 fichiers récents
      const sampleFiles = files.slice(-50);

      for (const file of sampleFiles) {
        cacheStats[platform].total += 1;
        try {
          const raw = fs.readFileSync(path.join(cacheDir, file), 'utf8');
          const payload = JSON.parse(raw);
          const body = (payload.body || '').toLowerCase();

          if (blockedMarkers.some((m) => body.includes(m))) {
            cacheStats[platform].blocked += 1;
          } else if (body.length < 2000) {
            cacheStats[platform].empty += 1;
          } else {
            cacheStats[platform].ok += 1;
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  return cacheStats;
}

// ─── Génération du rapport ───────────────────────────────────────────

/**
 * Construit le rapport de diagnostic complet.
 */
function buildDiagnosticReport(nicheReports, platformEvals, cacheHealth) {
  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalNiches: nicheReports.length,
      healthyNiches: 0,
      warningNiches: 0,
      criticalNiches: 0,
      deadNiches: 0,
      technicalIssues: 0
    },
    niches: nicheReports,
    platforms: platformEvals,
    cacheHealth,
    recommendations: {
      nichesToRemove: [],
      nichesToFix: [],
      nichesToKeep: [],
      platformsToAdd: []
    }
  };

  // Classifier les niches
  for (const niche of nicheReports) {
    if (niche.healthScore >= HEALTH_THRESHOLDS.HEALTHY) {
      report.summary.healthyNiches += 1;
      report.recommendations.nichesToKeep.push({
        name: niche.name,
        score: niche.healthScore,
        note: 'Niche en bonne santé'
      });
    } else if (niche.healthScore >= HEALTH_THRESHOLDS.WARNING) {
      report.summary.warningNiches += 1;
      report.recommendations.nichesToKeep.push({
        name: niche.name,
        score: niche.healthScore,
        note: 'À surveiller'
      });
    } else if (niche.healthScore >= HEALTH_THRESHOLDS.CRITICAL) {
      report.summary.criticalNiches += 1;

      // Déterminer si c'est un problème technique ou une niche morte
      if (niche.diagnosis && (niche.diagnosis.vintedStatus === 'blocked' || niche.diagnosis.vintedStatus === 'parsing_broken')) {
        report.summary.technicalIssues += 1;
        report.recommendations.nichesToFix.push({
          name: niche.name,
          score: niche.healthScore,
          issue: niche.diagnosis.vintedStatus,
          fix: niche.diagnosis.suggestions.join(' | ')
        });
      } else {
        report.recommendations.nichesToKeep.push({
          name: niche.name,
          score: niche.healthScore,
          note: 'Score critique mais pas de problème technique identifié — surveiller'
        });
      }
    } else {
      // Score < 20
      if (niche.viability && !niche.viability.isViable) {
        report.summary.deadNiches += 1;
        report.recommendations.nichesToRemove.push({
          name: niche.name,
          score: niche.healthScore,
          reason: 'Niche morte — 0 résultat Vinted + non viable'
        });
      } else if (niche.diagnosis && niche.diagnosis.vintedStatus !== 'ok') {
        report.summary.technicalIssues += 1;
        report.recommendations.nichesToFix.push({
          name: niche.name,
          score: niche.healthScore,
          issue: niche.diagnosis.vintedStatus,
          fix: niche.diagnosis.suggestions.join(' | ')
        });
      } else {
        report.recommendations.nichesToRemove.push({
          name: niche.name,
          score: niche.healthScore,
          reason: 'Score trop bas sans cause identifiée — considérer la suppression'
        });
      }
    }
  }

  // Recommandations plateformes
  const topPlatforms = platformEvals.filter((p) => p.overallScore >= 50 && p.accessible);
  for (const platform of topPlatforms.slice(0, 3)) {
    report.recommendations.platformsToAdd.push({
      name: platform.name,
      score: platform.overallScore,
      difficulty: platform.difficulty,
      relevantNiches: platform.recommendedNiches,
      pros: platform.pros
    });
  }

  return report;
}

// ─── Message Telegram ────────────────────────────────────────────────

function buildDiagnosticTelegramMessage(report) {
  const lines = [];

  lines.push('=== DIAGNOSTIC NICHES ===');
  lines.push('');

  // Résumé
  const s = report.summary;
  lines.push(`Niches: ${s.totalNiches} total`);
  lines.push(`  OK: ${s.healthyNiches} | Attention: ${s.warningNiches} | Critique: ${s.criticalNiches} | Mortes: ${s.deadNiches}`);
  if (s.technicalIssues > 0) {
    lines.push(`  Problemes techniques: ${s.technicalIssues}`);
  }
  lines.push('');

  // Scores par niche
  lines.push('--- SCORES ---');
  for (const niche of report.niches.sort((a, b) => a.healthScore - b.healthScore)) {
    const emoji = niche.healthScore >= 75 ? 'OK' : niche.healthScore >= 50 ? '!!' : niche.healthScore >= 20 ? 'XX' : 'DEAD';
    lines.push(`[${emoji}] ${niche.name}: ${niche.healthScore}/100 (${niche.stats.totalListingsFound} listings, ${niche.stats.totalOpportunities} opps)`);
  }
  lines.push('');

  // Niches à supprimer
  if (report.recommendations.nichesToRemove.length > 0) {
    lines.push('--- A SUPPRIMER ---');
    for (const n of report.recommendations.nichesToRemove) {
      lines.push(`  x ${n.name}: ${n.reason}`);
    }
    lines.push('');
  }

  // Niches à corriger
  if (report.recommendations.nichesToFix.length > 0) {
    lines.push('--- A CORRIGER ---');
    for (const n of report.recommendations.nichesToFix) {
      lines.push(`  ! ${n.name} (${n.issue}): ${n.fix}`);
    }
    lines.push('');
  }

  // Plateformes recommandées
  if (report.recommendations.platformsToAdd.length > 0) {
    lines.push('--- NOUVELLES PLATEFORMES ---');
    for (const p of report.recommendations.platformsToAdd) {
      lines.push(`  + ${p.name} (score: ${p.score}/100, difficulte: ${p.difficulty})`);
      lines.push(`    Niches: ${p.relevantNiches.join(', ')}`);
    }
    lines.push('');
  }

  // Cache health
  if (report.cacheHealth) {
    const vc = report.cacheHealth.vinted;
    const ec = report.cacheHealth.ebay;
    if (vc.blocked > 0 || ec.blocked > 0) {
      lines.push('--- CACHE ---');
      if (vc.blocked > 0) lines.push(`  Vinted: ${vc.blocked}/${vc.total} pages bloquees`);
      if (ec.blocked > 0) lines.push(`  eBay: ${ec.blocked}/${ec.total} pages bloquees`);
      lines.push('');
    }
  }

  lines.push(`Diagnostic: ${new Date().toLocaleTimeString('fr-FR')}`);

  return lines.join('\n').trim();
}

// ─── Agent principal ─────────────────────────────────────────────────

/**
 * Lance le diagnostic complet de toutes les niches.
 *
 * @param {Object} config - Configuration globale
 * @param {Object} options
 *   - deepDiagnose {boolean} - Faire un diagnostic approfondi des niches faibles (défaut: true)
 *   - checkPlatforms {boolean} - Évaluer les plateformes alternatives (défaut: true)
 *   - sendTelegram {boolean} - Envoyer le rapport via Telegram (défaut: true)
 * @returns {Object} Rapport de diagnostic complet
 */
async function diagnose(config, options = {}) {
  const {
    deepDiagnose = true,
    checkPlatforms = true,
    sendTelegram: doSendTelegram = true
  } = options;

  const startTime = Date.now();
  console.log('\n========================================');
  console.log('  AGENT DIAGNOSTIC — Analyse de santé');
  console.log('========================================\n');

  // 1. Charger l'historique des scans
  console.log('[Diagnostic] Chargement de l\'historique...');
  const scanHistory = loadScanHistory(config);
  console.log(`[Diagnostic] ${scanHistory.length} scan(s) chargé(s)`);

  // 2. Analyser les taux de succès par niche
  console.log('[Diagnostic] Analyse des taux de succès...');
  const nicheStats = analyzeNicheSuccessRates(scanHistory, config.searches);

  // 3. Diagnostic approfondi des niches faibles
  const nicheReports = [];
  for (const search of config.searches) {
    const stats = nicheStats.get(search.name);
    let diagnosis = null;
    let viability = null;
    const seasonality = detectSeasonality(search);

    // Si la niche a des échecs consécutifs, diagnostic approfondi
    if (deepDiagnose && stats.consecutiveZeroResults >= CONSECUTIVE_FAILURES_THRESHOLD) {
      console.log(`[Diagnostic] Niche "${search.name}" a ${stats.consecutiveZeroResults} échecs consécutifs — diagnostic approfondi...`);
      diagnosis = await deepDiagnoseNiche(search, config);
      viability = await checkNicheViability(search, config);
    } else if (deepDiagnose && stats.totalScans > 0 && stats.successfulScans === 0) {
      console.log(`[Diagnostic] Niche "${search.name}" a 0 succès — diagnostic approfondi...`);
      diagnosis = await deepDiagnoseNiche(search, config);
      viability = await checkNicheViability(search, config);
    }

    const healthScore = computeNicheHealthScore(stats, diagnosis);

    nicheReports.push({
      name: search.name,
      healthScore,
      healthStatus: healthScore >= HEALTH_THRESHOLDS.HEALTHY ? 'healthy'
        : healthScore >= HEALTH_THRESHOLDS.WARNING ? 'warning'
        : healthScore >= HEALTH_THRESHOLDS.CRITICAL ? 'critical'
        : 'dead',
      stats,
      diagnosis,
      viability,
      seasonality,
      pricingSource: search.pricingSource,
      queriesCount: (search.vintedQueries || []).length
    });
  }

  // 4. Évaluer les plateformes alternatives
  let platformEvals = [];
  if (checkPlatforms) {
    platformEvals = await evaluateAlternativePlatforms(config.searches, config);
  }

  // 5. Analyser la santé du cache HTTP
  console.log('[Diagnostic] Analyse du cache HTTP...');
  const cacheHealth = await analyzeCacheHealth(config);

  // 6. Construire le rapport
  console.log('[Diagnostic] Construction du rapport...');
  const report = buildDiagnosticReport(nicheReports, platformEvals, cacheHealth);
  report.durationMs = Date.now() - startTime;

  // 7. Sauvegarder le rapport
  const agentsDir = path.join(config.outputDir, 'agents');
  await fs.promises.mkdir(agentsDir, { recursive: true });
  const reportPath = path.join(agentsDir, 'diagnostic-latest.json');
  await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`[Diagnostic] Rapport sauvegardé: ${reportPath}`);

  // 8. Envoyer via Telegram
  if (doSendTelegram && config.telegram.token && config.telegram.chatId) {
    try {
      const message = buildDiagnosticTelegramMessage(report);
      await sendTelegramMessage(config.telegram, message);
      console.log('[Diagnostic] Rapport envoyé via Telegram.');
    } catch (error) {
      console.error(`[Diagnostic] Erreur Telegram: ${error.message}`);
    }
  }

  // 9. Résumé console
  console.log('\n========================================');
  console.log('  DIAGNOSTIC TERMINE');
  console.log(`  Durée: ${report.durationMs}ms`);
  console.log(`  Niches: ${report.summary.healthyNiches} OK, ${report.summary.warningNiches} attention, ${report.summary.criticalNiches} critique, ${report.summary.deadNiches} mortes`);
  if (report.summary.technicalIssues > 0) {
    console.log(`  Problèmes techniques: ${report.summary.technicalIssues}`);
  }
  if (platformEvals.length > 0) {
    const topPlatform = platformEvals[0];
    console.log(`  Meilleure plateforme alternative: ${topPlatform.name} (score: ${topPlatform.overallScore}/100)`);
  }
  console.log('========================================\n');

  return report;
}

module.exports = {
  diagnose,
  analyzeNicheSuccessRates,
  deepDiagnoseNiche,
  computeNicheHealthScore,
  checkNicheViability,
  detectSeasonality,
  evaluateAlternativePlatforms,
  analyzeCacheHealth,
  buildDiagnosticReport,
  buildDiagnosticTelegramMessage,
  HEALTH_THRESHOLDS,
  ALTERNATIVE_PLATFORMS
};
