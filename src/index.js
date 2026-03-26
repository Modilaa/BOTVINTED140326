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
const { getVintedListings, fetchVintedDescription } = require('./marketplaces/vinted');
const { enrichTitleFromDescription } = require('./description-enricher');
const { getFacebookMarketplaceListings } = require('./marketplaces/facebook');
const { getCardmarketListings, clearMemoryCache: clearCardmarketCache } = require('./marketplaces/cardmarket');
const { getLeboncoinListings, clearMemoryCache: clearLeboncoinCache } = require('./marketplaces/leboncoin');
const { purgeBlockedCache } = require('./http');
const { buildTelegramMessage, sendTelegramMessage, sendOpportunityAlert } = require('./notifier');
const { detectTrends, getStats: getPriceDbStats, recordVintedPrice, getUnderPricedProducts } = require('./price-database');
const { checkAndAlert, errorCounts: apiErrorCounts } = require('./api-monitor');
const { buildProfitAnalysis, isOpportunity } = require('./profit');
const { findUnderpricedListings } = require('./underpriced');
const { runPipeline, runHealthCheck, writeSprintContract } = require('./agents/orchestrator');
const { run: runScanner }  = require('./agents/scanner');
const { run: runEvaluator } = require('./agents/evaluator');

async function ensureOutputDir(outputDir) {
  await fs.promises.mkdir(outputDir, { recursive: true });
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
  const newOppUrls = new Set(newResult.opportunities.map((o) => o.url));
  const previousOpps = previousListings
    .filter((l) => !newOppUrls.has(l.url) && !l.archived)
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
  const scanResult = await runScanner(previousListings);

  // 2. Agent Évaluateur : scoring + vision GPT + décision opportunité
  const evalResult = await runEvaluator(scanResult.candidates);

  // 3. Assemble result compatible avec mergeWithHistory (même format qu'avant)
  //    Les objets candidates sont mutés in-place par l'Évaluateur
  //    (confidence, liquidity, visionResult) → searchedListings déjà enrichi.
  const result = {
    scannedAt:        new Date().toISOString(),
    scanning:         false,
    thresholds:       { minProfitEur: config.minProfitEur, minProfitPercent: config.minProfitPercent },
    scannedCount:     scanResult.searchedListings.length,
    opportunities:    evalResult.opportunities.slice().sort((a, b) => b.profit.profit - a.profit.profit),
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
