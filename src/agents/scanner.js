/**
 * Agent Scanner — Scrape les sources (Vinted, Cardmarket, Leboncoin, Facebook),
 * trouve des matchs prix bruts via le price-router.
 *
 * NE fait PAS de scoring, NE fait PAS de vision GPT, NE prend PAS de décision.
 * Résultat = liste de candidats bruts prêts à être évalués.
 *
 * Écrit :
 *   output/scanner-results.json  — candidats bruts du scan
 *   output/scanner-health.json   — métriques de santé
 */

'use strict';

require('dns').setDefaultResultOrder('ipv4first');

const fs   = require('fs');
const path = require('path');
const config = require('../config');

const { getVintedListings, fetchVintedDescription } = require('../marketplaces/vinted');
const { enrichTitleFromDescription }                = require('../description-enricher');
const { getFacebookMarketplaceListings }            = require('../marketplaces/facebook');
const { getCardmarketListings }                     = require('../marketplaces/cardmarket');
const { getLeboncoinListings }                      = require('../marketplaces/leboncoin');
const { purgeBlockedCache }                         = require('../http');
const { recordVintedPrice }                         = require('../price-database');
const { getPrice: getPriceViaRouter }               = require('../price-router');
const seenListings                                  = require('../seen-listings');
const { buildProfitAnalysis }                       = require('../profit');
const { evaluateSeller }                            = require('../seller-score');
const { extractCardLanguage }                       = require('./supervisor');
const { findUnderpricedListings }                   = require('../underpriced');
const { checkAndAlert }                             = require('../api-monitor');
const messageBus                                    = require('../message-bus');

// ─── Sprint Contract & Query Corrections — Pattern 4 ─────────────────────────

/**
 * Lit output/sprint-contract.json écrit par l'Orchestrateur.
 */
function loadSprintContract(outputDir) {
  try {
    const p = path.join(outputDir, 'sprint-contract.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* ignore */ }
  return null;
}

/**
 * Lit output/evaluator-feedback.json pour les rejets récents de l'Évaluateur.
 * Retourne uniquement les feedbacks des dernières 48h.
 */
function loadRecentEvaluatorFeedbacks(outputDir) {
  try {
    const p = path.join(outputDir, 'evaluator-feedback.json');
    if (!fs.existsSync(p)) return [];
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const feedbacks = Array.isArray(raw.feedbacks) ? raw.feedbacks : [];
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    return feedbacks.filter(f => {
      try { return new Date(f.timestamp) > cutoff; } catch { return false; }
    });
  } catch { return []; }
}

/**
 * Lit output/query-corrections.json (historique des corrections appliquées).
 */
function loadQueryCorrections(outputDir) {
  try {
    const p = path.join(outputDir, 'query-corrections.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* ignore */ }
  return { corrections: [], updatedAt: null };
}

/**
 * Sauvegarde les corrections de query dans output/query-corrections.json.
 * Pattern 4 : historique des améliorations appliquées au Scanner.
 */
async function saveQueryCorrections(outputDir, corrections) {
  try {
    await fs.promises.mkdir(outputDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(outputDir, 'query-corrections.json'),
      JSON.stringify({ corrections, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch { /* non-bloquant */ }
}

/**
 * Analyse les feedbacks récents de l'Évaluateur et construit une map de corrections
 * à appliquer par catégorie.
 *
 * Pattern 4 : Scanner réessaye avec une query corrigée au prochain scan.
 *
 * @returns {Object} { lego: { forceSetNumber: boolean }, cards: { addVariantTokens: boolean } }
 */
function buildQueryCorrectionRules(recentFeedbacks, sprintContract) {
  const rules = {
    lego:  { forceSetNumber: false },
    cards: { addVariantTokens: false, requireMinObservations: false }
  };

  // Depuis l'evaluator-feedback
  const legoSetRejections    = recentFeedbacks.filter(f => f.suggestion === 'query_should_include_set_number').length;
  const variantRejections    = recentFeedbacks.filter(f => f.suggestion === 'query_should_add_variant_tokens').length;
  const priceRejections      = recentFeedbacks.filter(f => f.suggestion === 'require_more_observations').length;

  if (legoSetRejections >= 2) rules.lego.forceSetNumber = true;
  if (variantRejections >= 2) rules.cards.addVariantTokens = true;
  if (priceRejections   >= 2) rules.cards.requireMinObservations = true;

  // Depuis le sprint-contract (renforce les règles)
  if (sprintContract && sprintContract.queryAdjustments) {
    for (const adj of sprintContract.queryAdjustments) {
      if (adj.type === 'force_set_number_search') rules.lego.forceSetNumber = true;
      if (adj.type === 'add_variant_tokens')      rules.cards.addVariantTokens = true;
      if (adj.type === 'add_rarity_tokens')       rules.cards.addVariantTokens = true;
      if (adj.type === 'require_min_observations') rules.cards.requireMinObservations = true;
    }
  }

  return rules;
}

/**
 * Tente d'extraire le numéro de set LEGO d'un titre Vinted.
 * Les sets LEGO ont généralement 4-6 chiffres.
 * @returns {string|null}
 */
function extractLegoSetNumber(title) {
  const match = (title || '').match(/\b(\d{4,6})\b/);
  return match ? match[1] : null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MANGA_BOOK_WORDS = ['tome', 'manga', 'livre', 'roman', 'volume', 'coffret', 'book'];

function isMangaListing(title) {
  const lower = (title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return MANGA_BOOK_WORDS.some(word => new RegExp(`\\b${word}\\b`).test(lower));
}

function deduplicateListings(listings) {
  const byUrl           = new Map();
  const byNormalizedTitle = new Map();

  for (const listing of listings) {
    if (byUrl.has(listing.url)) continue;
    byUrl.set(listing.url, listing);

    const normTitle = (listing.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    if (normTitle.length < 10) continue;

    const existing = byNormalizedTitle.get(normTitle);
    if (existing) {
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

async function flushProgress(outputDir, candidates, underpricedAlerts, searchedListings, previousListings, scannedSoFar, totalItems) {
  const previousByUrl = new Map();
  for (const prev of previousListings) previousByUrl.set(prev.url, prev);
  for (const item of searchedListings)  previousByUrl.set(item.url, item);
  const allListings = [...previousByUrl.values()];

  const snapshot = {
    scannedAt:        new Date().toISOString(),
    scanning:         true,
    thresholds:       { minProfitEur: config.minProfitEur, minProfitPercent: config.minProfitPercent },
    scannedCount:     searchedListings.length,
    opportunities:    [...candidates].sort((a, b) => (b.profit && b.profit.profit || 0) - (a.profit && a.profit.profit || 0)),
    underpricedAlerts,
    searchedListings: allListings
  };

  await fs.promises.writeFile(path.join(outputDir, 'latest-scan.json'), JSON.stringify(snapshot, null, 2));

  if (global._broadcastSSE) {
    global._broadcastSSE({ type: 'scan-progress', scanned: scannedSoFar || searchedListings.length, total: totalItems || 0 });
  }
}

// ─── Agent principal ──────────────────────────────────────────────────────────

/**
 * Lance le scan complet.
 *
 * @param {Array}  previousListings  — Annonces du scan précédent (pour flushProgress dashboard)
 * @returns {{ candidates, underpricedAlerts, searchedListings, health }}
 */
async function run(previousListings = []) {
  const runStarted = Date.now();
  const candidates        = []; // Items avec données prix — attendent l'Évaluateur
  const searchedListings  = []; // Tous les items traités (pour historique)
  const underpricedAlerts = [];
  const errors            = [];
  const countries         = config.vintedCountries ? [...config.vintedCountries] : [];
  const minPrice          = config.minListingPriceEur || 2;

  // ─── Pattern 4 : Chargement sprint-contract + corrections de query ─────────
  const outputDir         = config.outputDir;
  const sprintContract    = loadSprintContract(outputDir);
  const recentFeedbacks   = loadRecentEvaluatorFeedbacks(outputDir);
  const qcData            = loadQueryCorrections(outputDir);
  const queryRules        = buildQueryCorrectionRules(recentFeedbacks, sprintContract);
  const queryCorrections  = Array.isArray(qcData.corrections) ? [...qcData.corrections] : [];

  if (sprintContract) {
    console.log(`[Scanner] Sprint contract: ${sprintContract.sprintId}`);
    if (queryRules.lego.forceSetNumber) {
      console.log('[Scanner] Règle active: LEGO → recherche forcée par numéro de set');
    }
    if (queryRules.cards.addVariantTokens) {
      console.log('[Scanner] Règle active: Cartes → tokens variante requis dans la query');
    }
  }

  // ─── Filtrer catégories désactivées par feedback-analyzer ──────────────────
  try {
    const { getDisabledCategories } = require('../feedback-analyzer');
    const disabled = getDisabledCategories();
    if (disabled.length > 0) {
      const before = config.searches.length;
      config.searches = config.searches.filter(s => !disabled.includes(s.name));
      const skipped = before - config.searches.length;
      if (skipped > 0) {
        console.log(`[Scanner] ${skipped} catégorie(s) désactivée(s) ignorée(s): ${disabled.join(', ')}`);
      }
    }
  } catch { /* non-bloquant */ }

  // ─── Log quota eBay Browse API avant le scan ───────────────────────────────
  if (config.ebayAppId && config.ebayClientSecret) {
    try {
      const { getEbayQuota, markQuotaExhausted, resetEbayQuota } = require('../marketplaces/ebay-api');
      resetEbayQuota();
      const quota = await getEbayQuota(config);
      if (quota) {
        const resetMs  = quota.resetTime ? new Date(quota.resetTime).getTime() - Date.now() : 0;
        const resetH   = Math.floor(Math.max(0, resetMs) / 3600000);
        const resetMin = Math.floor((Math.max(0, resetMs) % 3600000) / 60000);
        const resetStr = resetMs > 0 ? ` (reset dans ${resetH}h${resetMin}m)` : '';
        global._lastEbayQuota = quota;

        if (quota.remaining === 0) {
          console.log(`[QUOTA] eBay quota épuisé (0/${quota.limit})${resetStr} → Browse API désactivée`);
          markQuotaExhausted();
          checkAndAlert('ebay-quota-zero', true, `Quota eBay Browse API épuisé ! (0/${quota.limit})${resetStr}`);
          checkAndAlert('ebay-quota-low',  true, `Quota eBay: 0/${quota.limit}`);
        } else if (quota.remaining < 500) {
          console.log(`[QUOTA] ⚠ eBay quota bas: ${quota.remaining}/${quota.limit}`);
          checkAndAlert('ebay-quota-zero', false, '');
          checkAndAlert('ebay-quota-low',  true, `Quota eBay bas: ${quota.remaining}/${quota.limit} restants${resetStr}`);
        } else {
          console.log(`[QUOTA] eBay Browse API: ${quota.remaining}/${quota.limit} restants${resetStr}`);
          checkAndAlert('ebay-quota-zero', false, '');
          checkAndAlert('ebay-quota-low',  false, '');
        }
      }
    } catch { /* non-critique */ }
  }

  // ─── Purge cache bloqué ────────────────────────────────────────────────────
  await purgeBlockedCache(path.join(config.outputDir, 'http-cache', 'ebay'));
  await purgeBlockedCache(path.join(config.outputDir, 'http-cache', 'cardmarket'));
  await purgeBlockedCache(path.join(config.outputDir, 'http-cache', 'leboncoin'));

  const platforms = config.sourcingPlatforms || ['vinted'];

  // ─── Boucle principale : catégorie par catégorie ───────────────────────────
  for (const search of config.searches) {
    console.log(`[Scanner] Scan [${platforms.join(',')}]: ${search.name}`);
    try {
      let listings = [];

      // 1. Vinted
      if (platforms.includes('vinted')) {
        try {
          const vintedListings = await getVintedListings(search, config);
          for (const l of vintedListings) l.platform = l.platform || 'vinted';
          listings = listings.concat(vintedListings);
          console.log(`  Vinted: ${vintedListings.length} annonce(s)`);
          checkAndAlert('vinted-empty', vintedListings.length === 0,
            `Vinted retourne 0 annonces pour "${search.name}" — possible blocage`);
        } catch (err) {
          console.error(`  Vinted erreur pour ${search.name}: ${err.message}`);
          errors.push(`vinted:${search.name}: ${err.message}`);
        }
      }

      // 2. Cardmarket
      if (platforms.includes('cardmarket') && config.cardmarketEnabled) {
        try {
          const cmListings = await getCardmarketListings(search, config);
          if (cmListings.length > 0) {
            console.log(`  Cardmarket: ${cmListings.length} annonce(s)`);
            listings = listings.concat(cmListings);
          }
        } catch (err) {
          errors.push(`cardmarket:${search.name}: ${err.message}`);
        }
      }

      // 3. Leboncoin
      if (platforms.includes('leboncoin') && config.leboncoinEnabled) {
        try {
          const lbcListings = await getLeboncoinListings(search, config);
          if (lbcListings.length > 0) {
            console.log(`  Leboncoin: ${lbcListings.length} annonce(s)`);
            listings = listings.concat(lbcListings);
          }
        } catch (err) {
          errors.push(`leboncoin:${search.name}: ${err.message}`);
        }
      }

      // 4. Facebook Marketplace
      if (search.facebookEnabled && process.env.APIFY_API_KEY) {
        try {
          const fbListings = await getFacebookMarketplaceListings(search, config);
          if (fbListings.length > 0) {
            for (const l of fbListings) l.platform = l.platform || 'facebook';
            console.log(`  Facebook: ${fbListings.length} annonce(s)`);
            listings = listings.concat(fbListings);
          }
        } catch (err) {
          errors.push(`facebook:${search.name}: ${err.message}`);
        }
      }

      // ─── Filtrage & déduplication ──────────────────────────────────────────
      const deduped       = deduplicateListings(listings);
      const priceFiltered = deduped.filter(l => l.buyerPrice >= minPrice);
      const validListings = priceFiltered.filter(l => !isMangaListing(l.title));

      const priceDrop = deduped.length - priceFiltered.length;
      const mangaDrop = priceFiltered.length - validListings.length;
      if (priceDrop > 0 || mangaDrop > 0) {
        const details = [];
        if (priceDrop > 0) details.push(`${priceDrop} < ${minPrice}EUR`);
        if (mangaDrop > 0) details.push(`${mangaDrop} manga/livre`);
        console.log(`  ${listings.length} brutes -> ${validListings.length} valides (${details.join(', ')} ignorées)`);
      }

      // Détection sous-évalué (comparaison intra-catégorie)
      for (const alert of findUnderpricedListings(validListings, config)) {
        underpricedAlerts.push({ search: search.name, ...alert });
        console.log(`  SOUS-EVALUE: ${alert.listing.title.slice(0, 50)} -> ${alert.listing.buyerPrice}EUR vs median ${alert.medianPrice}EUR (-${alert.discount}%)`);
      }

      // Cap à maxItems, triés par prix croissant
      const maxItems       = config.maxItemsPerSearch || 30;
      const itemsToProcess = validListings
        .slice()
        .sort((a, b) => (a.buyerPrice || 0) - (b.buyerPrice || 0))
        .slice(0, maxItems);

      if (validListings.length > maxItems) {
        console.log(`  Cap: ${maxItems} items retenus sur ${validListings.length} (les moins chers d'abord)`);
      }

      // ─── Enrichissement des titres via description Vinted ─────────────────
      const vintedToEnrich = itemsToProcess.filter(l => (l.platform === 'vinted' || !l.platform) && l.url);
      if (vintedToEnrich.length > 0) {
        console.log(`  Enrichissement descriptions: ${vintedToEnrich.length} annonce(s)...`);
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
          } catch { /* Non-fatal */ }
        }
      }

      const pricingSource = search.pricingSource || 'ebay';

      // ─── Boucle par annonce ────────────────────────────────────────────────
      for (let i = 0; i < itemsToProcess.length; i++) {
        const listing = itemsToProcess[i];
        try {
          // Enregistrement prix Vinted pour tracking
          if (listing.id && listing.buyerPrice > 0 && (!listing.platform || listing.platform === 'vinted')) {
            recordVintedPrice(listing.title, search.name, listing.buyerPrice, listing.id, listing.vintedCountry || 'be');
          }

          // Skip annonces déjà traitées (résultat définitif en cache)
          if (listing.id && seenListings.isAlreadySeen(listing.id)) {
            console.log(`[seen] Skip ${listing.id} "${listing.title.slice(0, 50)}" (${seenListings.getSeenResult(listing.id)})`);
            continue;
          }

          console.log(`  [${i + 1}/${itemsToProcess.length}] ${listing.title.slice(0, 60)}...`);

          // Price Router — fallbacks automatiques: Browse API → niche API → Cardmarket → HTML
          const routerResult = await getPriceViaRouter(listing, pricingSource, config, search);
          let matchedSales = [];
          let sourceUrls   = [];
          let resultCount  = 0;

          if (routerResult && routerResult.matchedSales.length > 0) {
            matchedSales = routerResult.matchedSales;
            sourceUrls   = routerResult.sourceUrls || [];
            resultCount  = routerResult.resultCount || matchedSales.length;
            console.log(`    Router [${routerResult.pricingSource}]: ${routerResult.bestMatch} -> ${routerResult.marketPrice.toFixed(2)} EUR (${routerResult.confidence})`);
          } else {
            console.log(`    Router: pas de match pour "${listing.title.slice(0, 50)}"`);
          }

          const profit              = buildProfitAnalysis(listing, matchedSales, config);
          const detectedLanguage    = extractCardLanguage(listing.title, listing.rawTitle);
          const actualPricingSource = (routerResult && routerResult.pricingSource) || pricingSource;

          const row = {
            search:           search.name,
            route:            'vinted→ebay',
            title:            listing.title,
            vintedListedPrice: listing.listedPrice,
            vintedBuyerPrice:  listing.buyerPrice,
            sourceQuery:      listing.sourceQuery || '',
            url:              listing.url,
            id:               listing.id,
            imageUrl:         listing.imageUrl,
            rawTitle:         listing.rawTitle,
            enrichedTitle:    listing.enrichedTitle || null,
            platform:         listing.platform || 'vinted',
            vintedCountry:    listing.vintedCountry    || null,
            vintedCountryFlag: listing.vintedCountryFlag || null,
            pricingSource:    actualPricingSource,
            detectedLanguage,
            resultCount,
            scanCount:        (routerResult && routerResult.scanCount) || null,
            matchedSales,
            ebayMatchImageUrl: (matchedSales[0] && matchedSales[0].imageUrl) || null,
            sourceUrls,
            profit,
            priceDetails: routerResult ? (() => {
              const salePrices = matchedSales.map(s => s.price || s.totalPrice || 0).filter(p => p > 0);
              return {
                source:       actualPricingSource,
                observations: salePrices.length,
                lowestPrice:  salePrices.length > 0 ? Math.min(...salePrices) : null,
                highestPrice: salePrices.length > 0 ? Math.max(...salePrices) : null,
                lastUpdated:  new Date().toISOString()
              };
            })() : null,
            scannedAt: new Date().toISOString()
          };

          row.sellerScore = evaluateSeller(listing);

          // ─── Pattern 4 : Application des corrections de query ─────────────
          const isLegoSearch = (search.name || '').toUpperCase().includes('LEGO');
          const isCardSearch = !isLegoSearch;

          if (isLegoSearch && queryRules.lego.forceSetNumber) {
            const setNumber = extractLegoSetNumber(listing.title);
            if (setNumber) {
              row.legoSetNumber = setNumber;
              // Vérifier que le match eBay contient aussi ce numéro
              const ebayTitle = (matchedSales[0] && matchedSales[0].title) || '';
              const ebayHasSetNum = ebayTitle.includes(setNumber);
              if (!ebayHasSetNum && ebayTitle) {
                row.legoSetMismatch = true;
                console.log(`    [query-correction] LEGO set ${setNumber} absent du match eBay "${ebayTitle.slice(0, 50)}"`);
                // Enregistrer une correction pour cet item
                queryCorrections.push({
                  appliedAt:  new Date().toISOString(),
                  category:   'LEGO',
                  rule:       'force_set_number_search',
                  vintedTitle: listing.title,
                  setNumber,
                  ebayTitle,
                  outcome:    'mismatch_detected'
                });
              }
            } else {
              console.log(`    [query-correction] LEGO sans numéro de set: "${listing.title.slice(0, 50)}"`);
            }
          }

          if (isCardSearch && queryRules.cards.addVariantTokens && matchedSales.length === 0) {
            // Quand pas de match et que les tokens variante sont requis → log pour historique
            queryCorrections.push({
              appliedAt:  new Date().toISOString(),
              category:   search.name,
              rule:       'add_variant_tokens',
              vintedTitle: listing.title,
              outcome:    'no_match_variant_tokens_required'
            });
          }

          // ─── Décisions définitives : le Scanner peut marquer comme seen ───
          // (no-price, no-match pur) — les décisions d'opportunité → Évaluateur
          if (!routerResult) {
            seenListings.markAsSeen(listing.id, search.name, listing.title, 'no-price', null);
          } else if (matchedSales.length === 0) {
            seenListings.markAsSeen(listing.id, search.name, listing.title, 'no-match', null);
          } else if (routerResult.isKeywordEstimate) {
            seenListings.markAsSeen(listing.id, search.name, listing.title, 'no-match', null);
            console.log(`  Estimation mots-clés ignorée: ${listing.title.slice(0, 50)}`);
          } else if (actualPricingSource === 'rebrickable' && routerResult.confidence === 'low') {
            seenListings.markAsSeen(listing.id, search.name, listing.title, 'no-match', null);
            console.log(`  Estimation Rebrickable ignorée: ${listing.title.slice(0, 50)}`);
          } else {
            // A des données prix → candidat pour l'Évaluateur
            candidates.push(row);
          }

          searchedListings.push(row);

          // Flush progress vers le dashboard (affiche les candidats à profit positif)
          const profitCandidates = candidates.filter(c => c.profit && c.profit.profit > 0);
          await flushProgress(config.outputDir, profitCandidates, underpricedAlerts, searchedListings, previousListings, i + 1, itemsToProcess.length);

        } catch (err) {
          console.error(`  Erreur sur "${listing.title}": ${err.message}`);
          errors.push(`item:${(listing.title || '').slice(0, 40)}: ${err.message}`);
        }
      }

    } catch (searchErr) {
      console.error(`[Scanner][SKIP] Catégorie "${search.name}" échouée: ${searchErr.message}`);
      errors.push(`search:${search.name}: ${searchErr.message}`);
    }

    // Délai entre catégories
    await new Promise(r => setTimeout(r, 5000));
  }

  // ─── Scan eBay→Vinted (reverse) ───────────────────────────────────────────
  if (process.env.REVERSE_SCAN_ENABLED !== 'false') {
    try {
      const { runReverseScanner } = require('../scanners/reverse-scanner');
      const reverseOpps = await runReverseScanner(config, searchedListings);
      for (const opp of reverseOpps) {
        searchedListings.push(opp);
        candidates.push(opp); // Scoring → Évaluateur
      }
      if (reverseOpps.length > 0) {
        await flushProgress(config.outputDir, candidates.filter(c => c.profit && c.profit.profit > 0), underpricedAlerts, searchedListings, previousListings);
      }
    } catch (err) {
      console.error(`[Scanner] Reverse scanner erreur: ${err.message}`);
      errors.push(`reverse-scanner: ${err.message}`);
    }
  }

  // ─── Scan Cardmarket→eBay ─────────────────────────────────────────────────
  if (process.env.CARDMARKET_SCAN_ENABLED !== 'false') {
    try {
      const { runCardmarketScanner } = require('../scanners/cardmarket-scanner');
      const cmOpps = await runCardmarketScanner(config);
      for (const opp of cmOpps) {
        searchedListings.push(opp);
        candidates.push(opp); // Scoring → Évaluateur
      }
      if (cmOpps.length > 0) {
        await flushProgress(config.outputDir, candidates.filter(c => c.profit && c.profit.profit > 0), underpricedAlerts, searchedListings, previousListings);
      }
    } catch (err) {
      console.error(`[Scanner] Cardmarket scanner erreur: ${err.message}`);
      errors.push(`cardmarket-scanner: ${err.message}`);
    }
  }

  // ─── Sauvegardes ─────────────────────────────────────────────────────────
  const durationMs = Date.now() - runStarted;

  const health = {
    lastRunAt:    new Date().toISOString(),
    itemsScanned: searchedListings.length,
    matchesFound: candidates.length,
    errors:       errors.slice(-20),
    countries,
    durationMs
  };

  await fs.promises.mkdir(outputDir, { recursive: true });

  // Pattern 4 : sauvegarder les corrections de query (garder 500 entrées max)
  if (queryCorrections.length > 0) {
    const trimmed = queryCorrections.slice(0, 500);
    await saveQueryCorrections(outputDir, trimmed);
    console.log(`[Scanner] ${queryCorrections.length} correction(s) de query enregistrée(s)`);
  }

  await fs.promises.writeFile(
    path.join(outputDir, 'scanner-results.json'),
    JSON.stringify({
      scannedAt:        new Date().toISOString(),
      candidates,
      underpricedAlerts,
      scannedCount:     searchedListings.length,
      countries,
      errors
    }, null, 2)
  );

  await fs.promises.writeFile(
    path.join(outputDir, 'scanner-health.json'),
    JSON.stringify(health, null, 2)
  );

  console.log(`[Scanner] Terminé: ${searchedListings.length} annonces, ${candidates.length} candidats (${durationMs}ms)`);

  // ─── Message Bus : transmettre les candidats bruts à l'Évaluateur ─────────
  messageBus.publish('scanner', 'evaluator', 'candidates', {
    scannedAt:    new Date().toISOString(),
    count:        candidates.length,
    listings:     candidates
  });

  return { candidates, underpricedAlerts, searchedListings, health };
}

module.exports = { run };
