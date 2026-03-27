// Force IPv4-first DNS: pokemontcg.io IPv6 returns 404 via Cloudflare
require('dns').setDefaultResultOrder('ipv4first');

const fs = require('fs');
const path = require('path');
const config = require('./config');
// Note: matching/image-match/ebay sont utilisés par le price-router, plus besoin ici
const { clearMemoryCache: clearPokemonCache } = require('./marketplaces/pokemon-tcg');
const { clearMemoryCache: clearYugiohCache } = require('./marketplaces/ygoprodeck');
const { clearMemoryCache: clearPokemonTcgApiCache } = require('./marketplaces/pokemontcg-api');
const { getPrice: getPriceViaRouter, clearPriceCache } = require('./price-router');
const seenListings = require('./seen-listings');
const dismissedListings = require('./dismissed-listings');
const { getVintedListings, fetchVintedDescription } = require('./marketplaces/vinted');
const { enrichTitleFromDescription } = require('./description-enricher');
const { getFacebookMarketplaceListings } = require('./marketplaces/facebook');
const { getCardmarketListings, clearMemoryCache: clearCardmarketCache } = require('./marketplaces/cardmarket');
const { getLeboncoinListings, clearMemoryCache: clearLeboncoinCache } = require('./marketplaces/leboncoin');
const { purgeBlockedCache } = require('./http');
const { buildTelegramMessage, sendTelegramMessage, sendOpportunityAlert } = require('./notifier');
const { detectTrends, getStats: getPriceDbStats, recordVintedPrice, getUnderPricedProducts } = require('./price-database');
const { checkAndAlert, errorCounts: apiErrorCounts } = require('./api-monitor');
const { logDebugEvent } = require('./debug-protocol');
const { buildProfitAnalysis, isOpportunity } = require('./profit');
const { findUnderpricedListings } = require('./underpriced');
const { runPipeline, runHealthCheck, writeSprintContract } = require('./agents/orchestrator');
const { run: runScanner }  = require('./agents/scanner');
const { run: runEvaluator } = require('./agents/evaluator');
const messageBus = require('./message-bus');

async function ensureOutputDir(outputDir) {
  await fs.promises.mkdir(outputDir, { recursive: true });
}

// Purge message bus au démarrage (rotation 1000 messages, TTL 24h)
messageBus.purge();

// ─── Scratch pad — dump brut au début du scan ─────────────────────────────

const SCRATCH_DIR = path.join(config.outputDir, 'scratch');
const SCRATCH_MAX = 10;

/**
 * Écrit un dump brut dans output/scratch/scan-{timestamp}.json.
 * Garde seulement les SCRATCH_MAX derniers fichiers.
 * Retourne le chemin du fichier créé (pour la reprise).
 */
async function writeScratchDump(data) {
  try {
    await fs.promises.mkdir(SCRATCH_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(SCRATCH_DIR, `scan-${ts}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));

    // Purge des anciens fichiers (garder les SCRATCH_MAX derniers)
    const files = (await fs.promises.readdir(SCRATCH_DIR))
      .filter((f) => f.startsWith('scan-') && f.endsWith('.json'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(SCRATCH_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const old of files.slice(SCRATCH_MAX)) {
      try { await fs.promises.unlink(path.join(SCRATCH_DIR, old.name)); } catch { /* ignore */ }
    }

    return filePath;
  } catch (err) {
    console.error(`[scratch] Erreur écriture: ${err.message}`);
    return null;
  }
}

/**
 * Lit le dernier scratch file et retourne les IDs d'annonces déjà traitées.
 * Permet de ne pas re-scanner ce qui a déjà été fait en cas de crash mid-scan.
 */
function loadLastScratchResume() {
  try {
    if (!fs.existsSync(SCRATCH_DIR)) return new Set();
    const files = fs.readdirSync(SCRATCH_DIR)
      .filter((f) => f.startsWith('scan-') && f.endsWith('.json'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(SCRATCH_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return new Set();

    const lastFile = path.join(SCRATCH_DIR, files[0].name);
    const data = JSON.parse(fs.readFileSync(lastFile, 'utf8'));

    // Reprise seulement si le scratch est récent (< 30 min) et le scan n'était pas terminé
    const scratchAge = Date.now() - files[0].mtime;
    if (scratchAge > 30 * 60 * 1000) return new Set(); // Trop vieux
    if (data.scanCompleted) return new Set(); // Scan terminé normalement

    const processedIds = new Set(data.processedIds || []);
    if (processedIds.size > 0) {
      console.log(`[scratch] Reprise: ${processedIds.size} annonce(s) déjà traitées ignorées.`);
    }
    return processedIds;
  } catch {
    return new Set();
  }
}

// Global filter: remove physical manga/book listings from ALL categories.
// Vinted queries for TCG cards frequently surface manga volumes, novels, and
// collector boxes that have nothing to do with the card game.
const MANGA_BOOK_WORDS = ['tome', 'manga', 'livre', 'roman', 'volume', 'coffret', 'book'];
function isMangaListing(title) {
  const lower = (title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return MANGA_BOOK_WORDS.some(word => new RegExp(`\\b${word}\\b`).test(lower));
}

// Save current scan state to disk and notify dashboard
// previousListings = cards from previous scans (history) to keep visible during scan
async function flushProgress(outputDir, opportunities, underpricedAlerts, searchedListings, previousListings, scannedSoFar, totalItems) {
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
    global._broadcastSSE({ type: 'scan-progress', scanned: scannedSoFar || searchedListings.length, total: totalItems || 0 });
  }
}

/**
 * Deduplique les listings multi-plateforme.
 * Garde la version la moins chere si le meme titre apparait sur 2 plateformes.
 */
function deduplicateListings(listings) {
  const byUrl = new Map();
  const byNormalizedTitle = new Map();

  for (const listing of listings) {
    // Dedup exact par URL
    if (byUrl.has(listing.url)) continue;
    byUrl.set(listing.url, listing);

    // Dedup par titre normalise : garder le moins cher
    const normTitle = (listing.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    if (normTitle.length < 10) continue; // Titre trop court pour dedup

    const existing = byNormalizedTitle.get(normTitle);
    if (existing) {
      // Garder le moins cher
      if (listing.buyerPrice < existing.buyerPrice) {
        byUrl.delete(existing.url);
        byNormalizedTitle.set(normTitle, listing);
      } else {
        byUrl.delete(listing.url);
      }
    } else {
      byNormalizedTitle.set(normTitle, listing);
    }
  }

  return [...byUrl.values()];
}

async function runScan(previousListings) {
  const opportunities = [];
  const searchedListings = [];
  const underpricedAlerts = [];
  const minPrice = config.minListingPriceEur || 2;

  // Log blacklist count au démarrage du scan
  const blacklistCount = dismissedListings.getCount();
  if (blacklistCount > 0) {
    console.log(`[blacklist] ${blacklistCount} annonce(s) en blacklist permanente (ignorées définitivement)`);
  }

  // ─── Filtrer les catégories désactivées par le feedback-analyzer ──────────
  try {
    const { getDisabledCategories } = require('./feedback-analyzer');
    const disabled = getDisabledCategories();
    if (disabled.length > 0) {
      const before = config.searches.length;
      config.searches = config.searches.filter(s => !disabled.includes(s.name));
      const skipped = before - config.searches.length;
      if (skipped > 0) {
        console.log(`[feedback-analyzer] ${skipped} catégorie(s) désactivée(s) ignorée(s): ${disabled.join(', ')}`);
      }
    }
  } catch { /* non-bloquant */ }

  // ─── Log quota eBay Browse API avant le scan ───────────────────────────────
  if (config.ebayAppId && config.ebayClientSecret) {
    try {
      const { getEbayQuota, markQuotaExhausted: markEbayQuotaExhausted, resetEbayQuota } = require('./marketplaces/ebay-api');
      // Reset the exhaustion flag at the start of each scan cycle
      resetEbayQuota();
      const quota = await getEbayQuota(config);
      if (quota) {
        const resetMs = quota.resetTime ? new Date(quota.resetTime).getTime() - Date.now() : 0;
        const resetH = Math.floor(Math.max(0, resetMs) / 3600000);
        const resetMin = Math.floor((Math.max(0, resetMs) % 3600000) / 60000);
        const resetStr = resetMs > 0 ? ` (reset dans ${resetH}h${resetMin}m)` : '';
        _lastEbayQuota = quota;
        if (quota.remaining === 0) {
          console.log(`[QUOTA] eBay quota épuisé (0/${quota.limit})${resetStr} → Browse API désactivée pour ce scan`);
          markEbayQuotaExhausted();
          checkAndAlert('ebay-quota-zero', true, `Quota eBay Browse API épuisé ! (0/${quota.limit})${resetStr}`);
          checkAndAlert('ebay-quota-low', true, `Quota eBay: 0/${quota.limit}`);
        } else if (quota.remaining < 500) {
          console.log(`[QUOTA] ⚠ eBay quota bas: ${quota.remaining}/${quota.limit} — scan réduit recommandé`);
          checkAndAlert('ebay-quota-zero', false, '');
          checkAndAlert('ebay-quota-low', true, `Quota eBay bas: ${quota.remaining}/${quota.limit} restants${resetStr}`);
        } else {
          console.log(`[QUOTA] eBay Browse API: ${quota.remaining}/${quota.limit} restants${resetStr}`);
          checkAndAlert('ebay-quota-zero', false, '');
          checkAndAlert('ebay-quota-low', false, '');
        }
      }
    } catch { /* non-critique */ }
  }

  // Purge blocked pages from cache before scanning
  const ebayCacheDir = path.join(config.outputDir, 'http-cache', 'ebay');
  const cardmarketCacheDir = path.join(config.outputDir, 'http-cache', 'cardmarket');
  const leboncoinCacheDir = path.join(config.outputDir, 'http-cache', 'leboncoin');
  await purgeBlockedCache(ebayCacheDir);
  await purgeBlockedCache(cardmarketCacheDir);
  await purgeBlockedCache(leboncoinCacheDir);

  const platforms = config.sourcingPlatforms || ['vinted'];

  for (const search of config.searches) {
    console.log(`Scan [${platforms.join(',')}]: ${search.name}`);
  try {

    let listings = [];

    // ─── 1. Vinted (toujours actif si dans les platforms) ──────────────
    if (platforms.includes('vinted')) {
      try {
        const vintedListings = await getVintedListings(search, config);
        // Tag chaque listing avec sa plateforme source
        for (const l of vintedListings) { l.platform = l.platform || 'vinted'; }
        listings = listings.concat(vintedListings);
        console.log(`  Vinted: ${vintedListings.length} annonce(s)`);
        checkAndAlert('vinted-empty', vintedListings.length === 0, `Vinted retourne 0 annonces pour "${search.name}" — possible blocage`);
      } catch (error) {
        console.error(`  Vinted erreur pour ${search.name}: ${error.message}`);
      }
    }

    // ─── 2. Cardmarket sourcing (si active) ───────────────────────────
    if (platforms.includes('cardmarket') && config.cardmarketEnabled) {
      try {
        console.log(`  Scan Cardmarket: ${search.name}`);
        const cmListings = await getCardmarketListings(search, config);
        if (cmListings.length > 0) {
          console.log(`  Cardmarket: ${cmListings.length} annonce(s) ajoutees`);
          listings = listings.concat(cmListings);
        }
      } catch (error) {
        console.error(`  Cardmarket erreur pour ${search.name}: ${error.message}`);
      }
    }

    // ─── 3. Leboncoin sourcing (si active) ────────────────────────────
    if (platforms.includes('leboncoin') && config.leboncoinEnabled) {
      try {
        console.log(`  Scan Leboncoin: ${search.name}`);
        const lbcListings = await getLeboncoinListings(search, config);
        if (lbcListings.length > 0) {
          console.log(`  Leboncoin: ${lbcListings.length} annonce(s) ajoutees`);
          listings = listings.concat(lbcListings);
        }
      } catch (error) {
        console.error(`  Leboncoin erreur pour ${search.name}: ${error.message}`);
      }
    }

    // ─── 4. Facebook Marketplace (existant) ───────────────────────────
    if (search.facebookEnabled && process.env.APIFY_API_KEY) {
      try {
        console.log(`  Scan Facebook Marketplace: ${search.name}`);
        const fbListings = await getFacebookMarketplaceListings(search, config);
        if (fbListings.length > 0) {
          for (const l of fbListings) { l.platform = l.platform || 'facebook'; }
          console.log(`  Facebook: ${fbListings.length} annonce(s) ajoutees`);
          listings = listings.concat(fbListings);
        }
      } catch (error) {
        console.error(`  Facebook Marketplace erreur pour ${search.name}: ${error.message}`);
      }
    }

    // ─── Deduplication multi-plateforme ───────────────────────────────
    // Deduplique par titre normalise (meme carte sur 2 plateformes)
    const deduped = deduplicateListings(listings);

    // Filter out bait listings (< 2 EUR = auction bait)
    const priceFiltered = deduped.filter((l) => l.buyerPrice >= minPrice);
    // Global filter: remove manga/book listings regardless of category
    const validListings = priceFiltered.filter((l) => !isMangaListing(l.title));
    const priceDrop = deduped.length - priceFiltered.length;
    const mangaDrop = priceFiltered.length - validListings.length;
    if (priceDrop > 0 || mangaDrop > 0) {
      const details = [];
      if (priceDrop > 0) details.push(`${priceDrop} < ${minPrice}EUR`);
      if (mangaDrop > 0) details.push(`${mangaDrop} manga/livre`);
      console.log(`  ${listings.length} brutes -> ${validListings.length} valides (${details.join(', ')} ignorées)`);
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

    // TOUJOURS utiliser le price-router — il gère les fallbacks automatiquement
    // (Browse API → API spécifique → Cardmarket → HTML scraping)
    console.log(`  Source de prix: ${pricingSource} via price-router`);

    // Limiter à 30 items max par catégorie, triés par prix croissant
    // (les moins chers = plus de chances d'arbitrage)
    const maxItems = config.maxItemsPerSearch || 30;
    const itemsToProcess = validListings
      .slice()
      .sort((a, b) => (a.buyerPrice || 0) - (b.buyerPrice || 0))
      .slice(0, maxItems);
    if (validListings.length > maxItems) {
      console.log(`  Cap: ${maxItems} items retenus sur ${validListings.length} (les moins chers d'abord)`);
    }

    // ─── Enrichissement des titres via description Vinted ─────────────────────
    // Améliore la précision du matching eBay : le titre est souvent trop vague.
    // On scrape la description de chaque annonce Vinted validée (pas les 150 brutes).
    // La description révèle: chrome/refractor/base, RC, /299, etc.
    const vintedToEnrich = itemsToProcess.filter(
      (l) => (l.platform === 'vinted' || !l.platform) && l.url
    );
    if (vintedToEnrich.length > 0) {
      console.log(`  Enrichissement descriptions: ${vintedToEnrich.length} annonce(s) Vinted...`);
      for (const listing of vintedToEnrich) {
        try {
          const description = await fetchVintedDescription(listing.url, config);
          if (description) {
            listing.description = description;
            const enriched = enrichTitleFromDescription(listing.title, description);
            if (enriched !== listing.title) {
              listing.enrichedTitle = enriched;
              console.log(`    [ENRICH] "${listing.title.slice(0, 45)}" → "${enriched.slice(0, 55)}"`);
            }
          }
        } catch {
          // Non-fatal — le titre original sera utilisé
        }
      }
    }

    for (let i = 0; i < itemsToProcess.length; i += 1) {
      const listing = itemsToProcess[i];
      try {
        // Record Vinted price for every listing (before seen-check, to always track prices)
        if (listing.id && listing.buyerPrice > 0 && (!listing.platform || listing.platform === 'vinted')) {
          recordVintedPrice(listing.title, search.name, listing.buyerPrice, listing.id, listing.vintedCountry || 'be');
        }

        // Skip listings already processed in the last 24h with a definitive result
        if (listing.id && seenListings.isAlreadySeen(listing.id)) {
          console.log(`[seen] Skip ${listing.id} "${listing.title.slice(0, 50)}" (déjà traité: ${seenListings.getSeenResult(listing.id)})`);
          continue;
        }

        // Skip listings blacklistées par l'utilisateur (dismiss permanent)
        if (dismissedListings.isDismissed(listing.id, listing.title)) {
          console.log(`[blacklist] Skip ${listing.id} "${listing.title.slice(0, 50)}" (ignoré définitivement)`);
          continue;
        }

        console.log(`  [${i + 1}/${itemsToProcess.length}] ${listing.title.slice(0, 60)}...`);

        let matchedSales = [];
        let sourceUrls = [];
        let resultCount = 0;

        // Price Router — gère automatiquement les fallbacks:
        // Browse API → API spécifique (YGOPRODeck/PokemonTCG) → Cardmarket → HTML
        const routerResult = await getPriceViaRouter(listing, pricingSource, config, search);
        if (routerResult && routerResult.matchedSales.length > 0) {
          matchedSales = routerResult.matchedSales;
          sourceUrls = routerResult.sourceUrls || [];
          resultCount = routerResult.resultCount || matchedSales.length;
          console.log(`    Router [${routerResult.pricingSource}]: ${routerResult.bestMatch} -> ${routerResult.marketPrice.toFixed(2)} EUR (${routerResult.confidence})`);
        } else {
          console.log(`    Router: pas de match pour "${listing.title.slice(0, 50)}"`);
        }

        const profit = buildProfitAnalysis(listing, matchedSales, config);

        // Langue détectée pour traçabilité
        const rowDetectedLang = extractCardLanguage(listing.title, listing.rawTitle);

        // Source réelle utilisée par le router (peut différer de la config)
        const actualPricingSource = (routerResult && routerResult.pricingSource) || pricingSource;

        const row = {
          search: search.name,
          route: 'vinted→ebay',
          title: listing.title,
          vintedListedPrice: listing.listedPrice,
          vintedBuyerPrice: listing.buyerPrice,
          sourceQuery: listing.sourceQuery || '',
          url: listing.url,
          imageUrl: listing.imageUrl,
          rawTitle: listing.rawTitle,
          enrichedTitle: listing.enrichedTitle || null,
          platform: listing.platform || 'vinted',
          vintedCountry: listing.vintedCountry || null,
          vintedCountryFlag: listing.vintedCountryFlag || null,
          pricingSource: actualPricingSource,
          detectedLanguage: rowDetectedLang,
          resultCount,
          scanCount: (routerResult && routerResult.scanCount) || null,
          matchedSales,
          ebayMatchImageUrl: (matchedSales[0] && matchedSales[0].imageUrl) || null,
          sourceUrls,
          profit,
          priceDetails: routerResult ? (() => {
            const salePrices = matchedSales.map(s => s.price || s.totalPrice || 0).filter(p => p > 0);
            return {
              source: actualPricingSource,
              observations: salePrices.length,
              lowestPrice: salePrices.length > 0 ? Math.min(...salePrices) : null,
              highestPrice: salePrices.length > 0 ? Math.max(...salePrices) : null,
              lastUpdated: new Date().toISOString()
            };
          })() : null
        };

        // Seller score (données vendeur Vinted si disponibles)
        row.sellerScore = evaluateSeller(listing);

        // Auto-vision: run BEFORE computeConfidence so the result informs the score.
        // GPT-4o mini verdict → computeConfidence returns 0 on reject (instant gate fail).
        if (row.imageUrl && row.ebayMatchImageUrl && matchedSales.length > 0 && process.env.OPENAI_API_KEY) {
          try {
            console.log(`[vision-auto] Vérification image: "${row.title.slice(0, 50)}"`);
            const visionResult = await compareCardImages(row.imageUrl, row.ebayMatchImageUrl);
            if (visionResult) {
              row.visionVerified = true;
              row.visionResult = visionResult;
              row.visionSameCard = visionResult.sameCard;
              if (visionResult.sameCard === false) {
                console.log(`[vision-auto] ❌ REJET: "${row.title.slice(0, 50)}" — ${visionResult.summary}`);
              } else {
                console.log(`[vision-auto] ✅ CONFIRMÉ: "${row.title.slice(0, 50)}" (${visionResult.confidence}%)`);
              }
            }
          } catch (err) {
            console.log(`[vision-auto] Erreur: ${err.message} — on continue sans vision`);
          }
        } else if (!row.ebayMatchImageUrl) {
          console.log(`[vision-auto] ⏭ SKIP: "${row.title.slice(0, 50)}" — pas d'image eBay (bloqué par hard gate)`);
        } else if (!process.env.OPENAI_API_KEY) {
          console.log(`[vision-auto] ⏭ SKIP: OPENAI_API_KEY manquante (toutes les opportunités bloquées par hard gate)`);
        }

        // Scores — confidence now incorporates vision result (returns 0 if GPT rejected)
        row.confidence = computeConfidence(row);
        row.liquidity = computeLiquidity(row);

        searchedListings.push(row);

        // Determine result type for seen-listings cache
        let _seenResult;
        if (!routerResult) {
          _seenResult = 'no-price'; // API totalement indisponible → retenter au prochain scan
        } else if (routerResult.matchedSales.length === 0) {
          _seenResult = 'no-match';
        } else if (routerResult.isKeywordEstimate) {
          _seenResult = 'no-match'; // Estimation ignorée, pas fiable
          console.log(`  Estimation mots-clés ignorée (pas assez fiable): ${listing.title.slice(0, 50)}`);
        } else if (actualPricingSource === 'rebrickable' && routerResult.confidence === 'low') {
          _seenResult = 'no-match'; // Estimation Rebrickable 0.12€/pièce = prix inventé, pas de vente eBay confirmée
          console.log(`  Estimation Rebrickable ignorée (aucune vente eBay): ${listing.title.slice(0, 50)}`);
        } else {
          // ── Seuils d'opportunité stricts ──────────────────────────────────
          const _minProfitEur = Math.max(5, (search && search.minProfitEur != null) ? search.minProfitEur : config.minProfitEur);
          const _minProfitPct = Math.max(20, (search && search.minProfitPercent != null) ? search.minProfitPercent : config.minProfitPercent);
          const _liquidityScore = (row.liquidity && typeof row.liquidity === 'object') ? row.liquidity.score : 0;

          const _failsProfit = !profit || profit.profit < _minProfitEur;
          const _failsMargin = !profit || profit.profitPercent < _minProfitPct;
          const _failsConfidence = row.confidence < 50;
          const _minLiquidity = actualPricingSource === 'local-database' ? 25 : 40;
          const _failsLiquidity = _liquidityScore < _minLiquidity;

          if (_failsProfit || _failsMargin || _failsConfidence || _failsLiquidity) {
            const _reasons = [];
            if (_failsProfit) _reasons.push(`profit ${profit ? profit.profit.toFixed(2) : '0.00'}€ < ${_minProfitEur}€`);
            if (_failsMargin) _reasons.push(`marge ${profit ? profit.profitPercent.toFixed(1) : '0.0'}% < ${_minProfitPct}%`);
            if (_failsConfidence) _reasons.push(`confiance ${row.confidence}/100 < 50`);
            if (_failsLiquidity) _reasons.push(`liquidité ${_liquidityScore}/100 < ${_minLiquidity}`);
            console.log(`  [no-opportunity] ${listing.title.slice(0, 50)}: ${_reasons.join(', ')}`);
            _seenResult = 'no-match';
          } else {
            // Vision ran before computeConfidence — if GPT rejected, confidence = 0 → already filtered above
            _seenResult = 'opportunity';
            opportunities.push(row);
            console.log(`  Opportunite: ${listing.title} -> ${profit.profit.toFixed(2)} EUR`);
            sendOpportunityAlert(row).catch(() => {});
          }
        }

        // Record listing as processed (skip on next scan if result is definitive)
        if (listing.id) {
          seenListings.markAsSeen(
            listing.id,
            search.name,
            listing.title,
            _seenResult,
            routerResult ? (routerResult.marketPrice || null) : null
          );
        }

        // Flush progress to dashboard after each listing (include history so count doesn't reset)
        await flushProgress(config.outputDir, opportunities, underpricedAlerts, searchedListings, previousListings, i + 1, itemsToProcess.length);
      } catch (error) {
        console.error(`  Erreur sur "${listing.title}": ${error.message}`);
      }
    }
  } catch (searchError) {
    console.error(`  [SKIP] Categorie "${search.name}" echouee (${searchError.message}), passage a la suivante.`);
  }

  // Délai entre catégories pour éviter le rate limit
  await new Promise((r) => setTimeout(r, 5000));
  }

  // ─── Scan eBay→Vinted (reverse) ─────────────────────────────────────────
  if (process.env.REVERSE_SCAN_ENABLED !== 'false') {
    try {
      const reverseOpps = await runReverseScanner(config, searchedListings);
      for (const opp of reverseOpps) {
        opp.confidence = computeConfidence(opp);
        opp.liquidity = computeLiquidity(opp);
        searchedListings.push(opp);
        if (isOpportunity(opp.profit, config, config.searches.find(s => s.name === opp.search))) {
          opportunities.push(opp);
          console.log(`  Opportunite eBay→Vinted: ${opp.title.slice(0, 60)} -> ${opp.profit.profit.toFixed(2)} EUR`);
        }
      }
      if (reverseOpps.length > 0) {
        await flushProgress(config.outputDir, opportunities, underpricedAlerts, searchedListings, previousListings);
      }
    } catch (err) {
      console.error(`Reverse scanner erreur: ${err.message}`);
    }
  }

  // ─── Scan Cardmarket→eBay (TCG uniquement) ───────────────────────────────
  if (process.env.CARDMARKET_SCAN_ENABLED !== 'false') {
    try {
      const cmOpps = await runCardmarketScanner(config);
      for (const opp of cmOpps) {
        opp.confidence = computeConfidence(opp);
        opp.liquidity = computeLiquidity(opp);
        searchedListings.push(opp);
        if (isOpportunity(opp.profit, config, config.searches.find(s => s.name === opp.search))) {
          opportunities.push(opp);
          console.log(`  Opportunite CM→eBay: ${opp.title.slice(0, 60)} -> ${opp.profit.profit.toFixed(2)} EUR`);
        }
      }
      if (cmOpps.length > 0) {
        await flushProgress(config.outputDir, opportunities, underpricedAlerts, searchedListings, previousListings);
      }
    } catch (err) {
      console.error(`Cardmarket scanner erreur: ${err.message}`);
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
  // GARDIEN : seulement les items validés par Vision (status active + visionVerified)
  // Les items bruts de searchedListings n'ont pas de visionVerified → exclus automatiquement
  const newOppUrls = new Set(newResult.opportunities.map((o) => o.url));
  const previousOpps = previousListings
    .filter((l) => !newOppUrls.has(l.url) && !l.archived && l.status === 'active' && l.visionVerified === true)
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

  // ─── Scratch dump — reprise en cas de crash ──────────────────────────
  const scratchResumeIds = loadLastScratchResume();
  const scratchPath = await writeScratchDump({
    startedAt: new Date().toISOString(),
    scanCompleted: false,
    processedIds: [...scratchResumeIds]
  });
  // Exposer globalement pour que les modules downstream puissent enrichir le dump
  global._scratchPath = scratchPath;
  global._scratchResumeIds = scratchResumeIds;

  // ─── Country rotation in loop mode ─────────────────────────────────────
  if (loopEnabled && _allVintedCountries.length > 0) {
    const rotIdx = _countryRotationIndex % _allVintedCountries.length;
    const currentCountry = _allVintedCountries[rotIdx];
    _countryRotationIndex++;
    const flag = _COUNTRY_FLAGS[currentCountry] || '';
    const name = _COUNTRY_NAMES[currentCountry] || currentCountry.toUpperCase();
    console.log(`[scan] ${flag} Scan Vinted ${name} (${rotIdx + 1}/${_allVintedCountries.length})`);
    config.vintedCountries = [currentCountry];
    global._currentVintedCountry = currentCountry;
  }

  // Save previous history BEFORE the scan (le scanner écrase latest-scan.json pendant le scan)
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

  // Signaler au dashboard que le scan commence
  const scanningPath = path.join(config.outputDir, 'latest-scan.json');
  try {
    const scanningSnapshot = { ...(previousData || {}), scanning: true, scannedAt: new Date().toISOString() };
    await fs.promises.writeFile(scanningPath, JSON.stringify(scanningSnapshot, null, 2));
    if (global._broadcastSSE) global._broadcastSSE({ type: 'scan-start' });
  } catch { /* ignore */ }

  // ─── V10: Pipeline multi-agents ─────────────────────────────────────────────
  // 0. Orchestrateur écrit le contrat de sprint (critères + ajustements query)
  //    Pattern 1 (contrat) + Pattern 3 (feedback utilisateur → ajustements auto)
  try {
    await writeSprintContract(config);
  } catch (err) {
    console.error(`[sprint-contract] Erreur écriture: ${err.message}`);
  }

  // 1. Agent Scanner  : scrape + price-router (sans scoring ni vision)
  let scanResult;
  try {
    scanResult = await runScanner(previousListings);
  } catch (err) {
    logDebugEvent({
      phase: 'scan',
      module: 'scanner',
      symptom: 'Agent Scanner a crashé',
      cause: err.message,
      hypothesis: 'Erreur réseau, blocage Vinted ou bug interne',
      fix: 'Scan abandonné pour ce cycle',
      verified: false,
      error: err.message
    });
    throw err; // On propage — le scan entier est bloqué
  }

  // 2. Agent Évaluateur : scoring + vision GPT + décision opportunité
  let evalResult;
  try {
    evalResult = await runEvaluator(scanResult.candidates);
  } catch (err) {
    logDebugEvent({
      phase: 'evaluation',
      module: 'evaluator',
      symptom: 'Agent Évaluateur a crashé',
      cause: err.message,
      hypothesis: 'Erreur GPT Vision ou scoring',
      fix: 'Évaluation abandonnée, opportunités vides',
      verified: false,
      error: err.message
    });
    // Fallback : pas d'opportunités plutôt que crash total
    evalResult = { opportunities: [], candidates: [] };
  }

  // 3. Assemble result compatible avec mergeWithHistory (même format qu'avant)
  //    Les objets candidates sont mutés in-place par l'Évaluateur
  //    (confidence, liquidity, visionResult) → searchedListings déjà enrichi.
  const result = {
    scannedAt:        new Date().toISOString(),
    scanning:         false,
    thresholds:       { minProfitEur: config.minProfitEur, minProfitPercent: config.minProfitPercent },
    scannedCount:     scanResult.searchedListings.length,
    opportunities:    evalResult.opportunities.slice().sort((a, b) => b.profit.profit - a.profit.profit),
    pendingReview:    (evalResult.pendingReview || []).slice(), // candidats en attente de Vision
    underpricedAlerts: scanResult.underpricedAlerts,
    searchedListings: scanResult.searchedListings
  };

  const merged = mergeWithHistory(result, config.outputDir, previousData);
  const outputPath = path.join(config.outputDir, 'latest-scan.json');

  await fs.promises.writeFile(outputPath, JSON.stringify(merged, null, 2));

  // Append to scan history (FIX 11: historique des scans)
  if (global._appendScanHistory) {
    try { global._appendScanHistory(merged); } catch { /* non-bloquant */ }
  }

  // Marquer le scratch comme terminé (empêche la reprise au prochain scan normal)
  if (global._scratchPath) {
    try {
      await fs.promises.writeFile(global._scratchPath, JSON.stringify({
        startedAt: new Date().toISOString(),
        scanCompleted: true,
        scannedCount: result.scannedCount,
        opportunityCount: result.opportunities.length
      }, null, 2));
    } catch { /* non-bloquant */ }
  }

  // Notify dashboard to refresh
  if (global._broadcastSSE) {
    global._broadcastSSE({ type: 'scan-update' });
    console.log('Dashboard notifie.');
  }

  // Free memory after scan — disk cache persists for next scan
  clearPokemonCache();
  clearYugiohCache();
  clearPokemonTcgApiCache();
  clearPriceCache();
  clearCardmarketCache();
  clearLeboncoinCache();

  // Detect price trends at end of scan cycle
  try {
    const trends = detectTrends();
    if (trends.length > 0) {
      console.log(`[Tendances] ${trends.length} tendance(s) détectée(s): ${trends.map(t => `${t.name} ${t.trend.direction === 'rising' ? '📈' : '📉'} ${t.trend.changePercent > 0 ? '+' : ''}${t.trend.changePercent}%`).slice(0, 3).join(', ')}`);
    }
  } catch { /* non-bloquant */ }

  console.log(`Scan termine. ${result.scannedCount} annonces analysees (${merged.searchedListings.length} total avec historique).`);
  console.log(`${merged.opportunities.length} opportunite(s) detectee(s).`);
  console.log(`${merged.underpricedAlerts.length} carte(s) sous-evaluee(s).`);
  console.log(`Resultat: ${outputPath}`);

  // ─── Résumé Telegram : UNIQUEMENT si au moins 1 opportunité ─────────────
  try {
    const activeAlerts = Object.entries(apiErrorCounts)
      .filter(([, count]) => count > 0)
      .map(([name]) => name);

    const opportunitiesFound = result.opportunities.length;
    if (opportunitiesFound > 0) {
      const dbStats = getPriceDbStats();

      // Lecture budget Apify du jour
      let apifyStr = 'N/A';
      try {
        const usageRaw = fs.readFileSync(path.join(config.outputDir, 'apify-usage.json'), 'utf8');
        const usageData = JSON.parse(usageRaw);
        const today = new Date().toISOString().slice(0, 10);
        if (usageData.date === today) apifyStr = `${usageData.count}/50 (jour)`;
      } catch { /* pas de fichier usage */ }

      const ebayStr = global._lastEbayQuota
        ? `${global._lastEbayQuota.remaining}/${global._lastEbayQuota.limit}`
        : 'N/A';

      const summaryLines = [
        '📊 RÉSUMÉ SCAN',
        '',
        `🔍 Annonces scannées: ${result.scannedCount}`,
        `✅ Opportunités trouvées: ${opportunitiesFound}`,
        `📊 Base de prix: ${dbStats.totalProducts} produits`,
        `🔋 eBay: ${ebayStr}`,
        `🔋 Apify: ${apifyStr}`
      ];

      if (activeAlerts.length > 0) {
        summaryLines.push('');
        summaryLines.push(`⚠️ Alertes: ${activeAlerts.join(', ')}`);
      }

      const telegramConfig = {
        token: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
      };
      sendTelegramMessage(telegramConfig, summaryLines.join('\n')).catch(() => {});
    }
  } catch { /* non-bloquant */ }

  // ─── Pipeline multi-agents DÉSACTIVÉ (auto-run supprimé) ───────
  // Les agents (discovery, diagnostic, orchestrator) ne tournent plus
  // automatiquement après chaque scan — ils spammaient Justin toutes les
  // 10 min avec des messages "Discovery Multi-Categories" inutiles.
  // Pour les lancer manuellement : boutons "Lancer" du dashboard (server.js).
  // Les alertes opportunités individuelles sont déjà envoyées via
  // sendOpportunityAlert() dans la boucle de scan ci-dessus.

  // ─── Axe 5: Vérification expiration des opportunités actives ────────────
  // Tous les 3 scans, vérifie si les opportunités actives sont encore dispo sur Vinted
  _scanCounter++;
  if (_scanCounter % 3 === 0) {
    try {
      const activeOpps = merged.opportunities.filter(o => !o.stale && !o.archived);
      const toCheck = activeOpps.slice(0, 5); // Max 5 par cycle pour limiter les requêtes
      let expired = 0;
      for (const opp of toCheck) {
        try {
          const resp = await fetch(opp.url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (!resp.ok) continue;
          const html = await resp.text();
          const isSold = /item-sold|sold-overlay|"is_closed"\s*:\s*true|"status"\s*:\s*"(sold|hidden)"|réservé|reserved|vendu/i.test(html);
          if (isSold) {
            opp.stale = true;
            opp.expiredAt = new Date().toISOString();
            expired++;
            console.log(`[expiration] ❌ Expirée: "${opp.title.slice(0, 50)}"`);
          }
        } catch { /* continue silently */ }
      }
      if (expired > 0) {
        console.log(`[expiration] ${expired}/${toCheck.length} opportunités expirées retirées`);
      }
    } catch { /* non-bloquant */ }
  }

  // ─── Axe 4: Enrichissement proactif des prix marché ─────────────────────
  // Tous les 2 scans, enrichit les produits avec peu d'observations marché
  if (_scanCounter % 2 === 0) {
    try {
      const toEnrich = getUnderPricedProducts(5);
      if (toEnrich.length > 0) {
        console.log(`[enrichment] Enrichissement proactif de ${toEnrich.length} produit(s)...`);
        const ENRICHMENT_PRICING_MAP = { pokemon: 'pokemon-tcg-api', yugioh: 'ygoprodeck', lego: 'rebrickable' };
        for (const product of toEnrich) {
          try {
            const pricingSrc = ENRICHMENT_PRICING_MAP[product.category] || 'ebay';
            const fakeListing = { title: product.name, url: '', price: product.avgVintedPrice || 0 };
            const routerResult = await getPriceViaRouter(fakeListing, pricingSrc, config);
            if (routerResult && routerResult.marketPrice > 0) {
              console.log(`[enrichment] ✅ ${product.name.slice(0, 40)} → ${routerResult.marketPrice.toFixed(2)}€ (${routerResult.source})`);
            }
          } catch { /* continue silently */ }
        }
      }
    } catch { /* non-bloquant */ }
  }

  // ─── V10: Orchestrateur Health Check (toutes les 2 boucles) ────────────────
  // Analyse les fichiers scanner-health.json + evaluator-health.json,
  // détecte les problèmes (vision KO, tout rejeté, aucun match) et applique
  // des corrections dans orchestrator-decisions.json (lu par l'Évaluateur).
  if (_scanCounter % 2 === 0) {
    try {
      await runHealthCheck(config);
    } catch (err) {
      console.error(`[Orchestrateur] Health check erreur: ${err.message}`);
    }
  }

  // ─── Axe 8: Digest quotidien Telegram (une fois par jour) ──────────────
  try {
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    if (todayKey !== _lastDigestDate && now.getHours() >= 20) {
      _lastDigestDate = todayKey;
      const { sendDailyDigest } = require('./notifier');
      sendDailyDigest(merged).catch(() => {});
    }
  } catch { /* non-bloquant */ }

  // ─── Auto-amélioration: analyse feedback quotidienne (à minuit) ──────────
  try {
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    if (todayKey !== _lastAnalysisDate && now.getHours() >= 0 && now.getHours() < 4) {
      _lastAnalysisDate = todayKey;
      const { runAnalysis } = require('./feedback-analyzer');
      console.log('[feedback-analyzer] Analyse quotidienne déclenchée...');
      runAnalysis({ sendTelegram: true }).catch(err => console.error('[feedback-analyzer] Erreur analyse:', err.message));
    }
  } catch { /* non-bloquant */ }

  return merged;
}

const loopEnabled = process.argv.includes('--loop');
const loopIntervalMs = (function parseInterval() {
  const flag = process.argv.find((arg) => arg.startsWith('--interval='));
  return flag ? Number(flag.split('=')[1]) * 60 * 1000 : 10 * 60 * 1000;
})();

// ─── Country rotation (loop mode) ─────────────────────────────────────────
// Snapshot the full country list once at startup (before runOnce mutates it)
const _allVintedCountries = [...config.vintedCountries];
let _countryRotationIndex = 0;

const _COUNTRY_FLAGS = { be: '🇧🇪', fr: '🇫🇷', de: '🇩🇪', es: '🇪🇸', it: '🇮🇹', nl: '🇳🇱', pl: '🇵🇱', uk: '🇬🇧' };
const _COUNTRY_NAMES = { be: 'Belgique', fr: 'France', de: 'Allemagne', es: 'Espagne', it: 'Italie', nl: 'Pays-Bas', pl: 'Pologne', uk: 'Royaume-Uni' };

// Axe 5: compteur de scans pour la vérification d'expiration (tous les 3 scans)
let _scanCounter = 0;
// Axe 8: date du dernier digest quotidien envoyé
let _lastDigestDate = '';
// Auto-amélioration: date de la dernière analyse feedback (1x/jour à minuit)
let _lastAnalysisDate = '';

async function main() {
  // Launch dashboard server automatically
  const { broadcastSSE, appendScanHistory } = require('./server');
  global._broadcastSSE = broadcastSSE;
  global._appendScanHistory = appendScanHistory;

  // Start Telegram callback polling (handles inline keyboard button presses)
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const telegramHandler = require('./telegram-handler');
    telegramHandler.start();
  }

  if (!loopEnabled) {
    await runOnce();
    return;
  }

  console.log(`Mode boucle active. Scan toutes les ${loopIntervalMs / 60000} minutes.`);
  console.log('Appuie sur Ctrl+C pour arreter.\n');

  while (true) {
    global._triggerScan = null; // non disponible pendant le scan
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
    await new Promise((resolve) => {
      let done = false;
      global._triggerScan = () => {
        if (!done) {
          done = true;
          global._triggerScan = null;
          console.log('[dashboard] Scan manuel déclenché.');
          resolve();
        }
      };
      setTimeout(() => {
        if (!done) {
          done = true;
          global._triggerScan = null;
          resolve();
        }
      }, waitMs);
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
