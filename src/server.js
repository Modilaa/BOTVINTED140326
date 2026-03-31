const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getPortfolioData, loadPortfolio, recordPurchase, recordSale, sendWeeklyReport } = require('./agents/strategist');
const { diagnose } = require('./agents/diagnostic');
const { discover } = require('./agents/discovery');
const { explore } = require('./agents/product-explorer');
const { strategize } = require('./agents/strategist');
const { assessLiquidity } = require('./agents/liquidity');
const { saveAgentResult } = require('./agents/orchestrator');
const { updateState: updateOppState, getState: getOppState, getHistory: getOppHistory } = require('./opportunity-state');
const { readDebugLog } = require('./debug-protocol');
const dismissedListings = require('./dismissed-listings');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;
const DASHBOARD_ENABLED = process.env.DASHBOARD_ENABLED !== 'false';

// ─── Bot start time (for uptime) ─────────────────────────────────────
const botStartTime = Date.now();

// ─── Middleware ───────────────────────────────────────────────────────
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ─── SSE clients registry ────────────────────────────────────────────
const sseClients = [];

const broadcastSSE = (message) => {
  sseClients.forEach((client) => {
    client.write(`data: ${JSON.stringify(message)}\n\n`);
  });
};

// ─── Agent status tracking ──────────────────────────────────────────
// V10: Discovery, Explorateur, Liquidité gérés automatiquement par le pipeline multi-agents.
// Seuls Diagnostic (analyse manuelle des niches) et Stratégie (portfolio) restent en accès manuel.
const agentStatus = {
  diagnostic: { status: 'idle', lastRun: null, lastResult: null, error: null },
  strategy:   { status: 'idle', lastRun: null, lastResult: null, error: null }
};

// ─── Helpers ─────────────────────────────────────────────────────────
const getClaimsPath = () => path.join(config.outputDir, 'claims.json');
const getScanPath = () => path.join(config.outputDir, 'latest-scan.json');
const getAgentPath = (name) => path.join(config.outputDir, 'agents', `${name}-latest.json`);
const getScansHistoryPath = () => path.join(config.outputDir, 'scans-history.json');
const getOpportunitiesHistoryPath = () => path.join(config.outputDir, 'opportunities-history.json');
const getFeedbackPath = () => path.join(config.outputDir, 'feedback-reports.json');
const getFeedbackLogPath = () => path.join(config.outputDir, 'feedback-log.json');

function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (raw && raw.trim()) return JSON.parse(raw);
    }
  } catch { /* ignore */ }
  return null;
}

function writeJsonSafe(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readClaims() {
  return readJsonSafe(getClaimsPath()) || {};
}

function writeClaims(claims) {
  writeJsonSafe(getClaimsPath(), claims);
}

// ─── Scan history tracking ───────────────────────────────────────────
function appendScanHistory(scanData) {
  const historyPath = getScansHistoryPath();
  let history = readJsonSafe(historyPath) || [];

  history.push({
    scannedAt: scanData.scannedAt,
    scannedCount: scanData.scannedCount || 0,
    opportunityCount: (scanData.opportunities || []).length,
    underpricedCount: (scanData.underpricedAlerts || []).length,
    searches: [...new Set((scanData.searchedListings || []).map((l) => l.search).filter(Boolean))]
  });

  // Keep last 100 scans
  if (history.length > 100) {
    history = history.slice(-100);
  }

  writeJsonSafe(historyPath, history);
}

// ─── Opportunities history (persistent across scans) ────────────────
function getOpportunitiesHistory() {
  const raw = readJsonSafe(getOpportunitiesHistoryPath());
  if (!raw) return [];
  // Gérer le format {"opportunities":[...]} ET le format [...]
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.opportunities)) return raw.opportunities;
  return [];
}

function saveOpportunitiesHistory(history) {
  writeJsonSafe(getOpportunitiesHistoryPath(), history);
}

/**
 * Deduplicate history by item ID.
 * Same item can appear on multiple country domains (vinted.fr, vinted.be…).
 * Priority: dismissed > archived > sold > active > expired
 * Among equal status, keep the most recently seen entry.
 */
function deduplicateHistoryById(history) {
  const statusRank = { rejected: 1, accepted: 2, dismissed: 3, archived: 4, sold: 5, bought: 6, active: 7, expired: 8 };
  const seenIds = new Map();
  for (const h of history) {
    if (!h.id) continue;
    if (!seenIds.has(h.id)) {
      seenIds.set(h.id, h);
    } else {
      const prev = seenIds.get(h.id);
      const currRank = statusRank[h.status] || 99;
      const prevRank = statusRank[prev.status] || 99;
      if (currRank < prevRank || (currRank === prevRank && new Date(h.lastSeenAt) > new Date(prev.lastSeenAt))) {
        seenIds.set(h.id, h);
      }
    }
  }
  return [...seenIds.values(), ...history.filter((h) => !h.id)];
}

function readFeedback() {
  const data = readJsonSafe(getFeedbackPath());
  if (!data) return { reports: [] };
  return data;
}

function writeFeedback(data) {
  writeJsonSafe(getFeedbackPath(), data);
}

function readFeedbackLog() {
  return readJsonSafe(getFeedbackLogPath()) || [];
}

function appendFeedbackLog(entry) {
  const log = readFeedbackLog();
  log.push(entry);
  writeJsonSafe(getFeedbackLogPath(), log.length > 1000 ? log.slice(-1000) : log);
}

/**
 * Retourne le meilleur score image (0-100) parmi les ventes matchées.
 * Null si aucune comparaison image n'a été faite.
 */
function getBestImageSimilarity(matchedSales) {
  if (!matchedSales || matchedSales.length === 0) return null;
  const scores = matchedSales
    .map((s) => (s.imageMatch && s.imageMatch.score != null ? s.imageMatch.score : null))
    .filter((s) => s !== null);
  if (scores.length === 0) return null;
  return Math.round(Math.max(...scores) * 100);
}

/**
 * Add new opportunities to history. Each opp gets a unique ID, timestamp, status.
 * Duplicates (same URL) are updated instead of added.
 */
function appendOpportunitiesToHistory(scanOpportunities, scannedAt) {
  let history = getOpportunitiesHistory();
  const existingByUrl = new Map();
  const existingById = new Map();
  for (const h of history) {
    if (h.url) existingByUrl.set(h.url, h);
    if (h.id) existingById.set(h.id, h);
  }

  for (const opp of scanOpportunities) {
    // Extract item ID from URL first so same item on fr/be/etc. domains doesn't create duplicates
    const itemKey = (opp.url || '').match(/\/items\/(\d+)/)?.[1] || null;
    const existing = existingByUrl.get(opp.url) || (itemKey ? existingById.get(itemKey) : null);
    if (existing) {
      // Update existing: refresh lastSeenAt and data
      existing.lastSeenAt = scannedAt;
      existing.title = opp.title;
      existing.imageUrl = opp.imageUrl;
      existing.platform = opp.platform || existing.platform || 'vinted';
      if (opp.vintedCountry) existing.vintedCountry = opp.vintedCountry;
      if (opp.vintedCountryFlag) existing.vintedCountryFlag = opp.vintedCountryFlag;
      existing.sourceQuery = opp.sourceQuery || existing.sourceQuery || null;
      existing.sourceUrls = opp.sourceUrls || existing.sourceUrls || [];
      // Never overwrite status/confidence/vision for manually accepted items
      if (!existing.manualOverride) {
        existing.vintedPrice = opp.vintedBuyerPrice || opp.vintedListedPrice;
        existing.estimatedSalePrice = opp.profit ? opp.profit.averageSoldPrice : existing.estimatedSalePrice;
        existing.profit = opp.profit ? opp.profit.profit : existing.profit;
        existing.profitPercent = opp.profit ? opp.profit.profitPercent : existing.profitPercent;
        existing.search = opp.search;
        existing.pricingSource = opp.pricingSource;
        existing.matchedSalesCount = (opp.matchedSales || []).length;
        existing.ebayMatchTitle = (opp.matchedSales && opp.matchedSales[0] && opp.matchedSales[0].title) || existing.ebayMatchTitle || null;
        existing.ebayMatchImageUrl = (opp.matchedSales && opp.matchedSales[0] && opp.matchedSales[0].imageUrl) || existing.ebayMatchImageUrl || null;
        existing.imageSimilarityScore = getBestImageSimilarity(opp.matchedSales) ?? existing.imageSimilarityScore ?? null;
        if (opp.priceDetails) existing.priceDetails = opp.priceDetails;
        if (opp.confidence != null) existing.confidence = opp.confidence;
        if (opp.liquidity != null) existing.liquidity = opp.liquidity;
        if (opp.sellerScore != null) existing.sellerScore = opp.sellerScore;
        if (opp.visionVerified != null) existing.visionVerified = opp.visionVerified;
        if (opp.visionSameCard != null) existing.visionSameCard = opp.visionSameCard;
        if (opp.visionResult) existing.visionFullResponse = opp.visionResult;
        if (opp.visionResult && opp.visionResult.visionReason) existing.visionReason = opp.visionResult.visionReason;
        // Upgrade candidate → active UNIQUEMENT si Vision a confirmé
        if (opp.status === 'active' && opp.visionVerified === true && existing.status === 'candidate') {
          existing.status = 'active';
        }
        // Re-activate expired items — sans Vision confirmée → candidate
        if (existing.status === 'expired') {
          existing.status = (opp.status === 'active' && !opp.visionVerified) ? 'candidate' : (opp.status || 'candidate');
        }
      }
    } else {
      // New opportunity
      const newItemKey = itemKey || `opp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      history.push({
        id: newItemKey,
        url: opp.url,
        title: opp.title,
        search: opp.search,
        platform: opp.platform || 'vinted',
        vintedCountry: opp.vintedCountry || null,
        vintedCountryFlag: opp.vintedCountryFlag || null,
        vintedPrice: opp.vintedBuyerPrice || opp.vintedListedPrice,
        estimatedSalePrice: opp.profit ? opp.profit.averageSoldPrice : null,
        profit: opp.profit ? opp.profit.profit : null,
        profitPercent: opp.profit ? opp.profit.profitPercent : null,
        imageUrl: opp.imageUrl,
        pricingSource: opp.pricingSource,
        priceDetails: opp.priceDetails || null,
        matchedSalesCount: (opp.matchedSales || []).length,
        ebayMatchTitle: (opp.matchedSales && opp.matchedSales[0] && opp.matchedSales[0].title) || null,
        ebayMatchImageUrl: (opp.matchedSales && opp.matchedSales[0] && opp.matchedSales[0].imageUrl) || null,
        imageSimilarityScore: getBestImageSimilarity(opp.matchedSales),
        sourceQuery: opp.sourceQuery || null,
        sourceUrls: opp.sourceUrls || [],
        confidence: opp.confidence != null ? opp.confidence : null,
        liquidity: opp.liquidity != null ? opp.liquidity : null,
        sellerScore: opp.sellerScore != null ? opp.sellerScore : null,
        visionVerified: opp.visionVerified || false,
        visionSameCard: opp.visionSameCard != null ? opp.visionSameCard : null,
        visionFullResponse: opp.visionResult || null,
        visionReason: (opp.visionResult && opp.visionResult.visionReason) || null,
        status: (opp.status === 'active' && !opp.visionVerified) ? 'candidate' : (opp.status || 'candidate'), // active (Vision requis), candidate, sold, expired, archived
        firstSeenAt: scannedAt,
        lastSeenAt: scannedAt
      });
    }
  }

  // Auto-expire active opportunities older than 7 days (never expire accepted/rejected/manualOverride)
  const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const h of history) {
    if (h.status === 'active' && !h.manualOverride) {
      const lastSeen = new Date(h.lastSeenAt).getTime();
      if (now - lastSeen > EXPIRY_MS) {
        h.status = 'expired';
      }
    }
  }

  // Expire stale active items SEULEMENT si vieux (7j) ET confidence très basse (< 30)
  // Ne jamais supprimer une opportunité juste parce que GPT n'a pas tourné (confidence 50-59)
  const CONFIDENCE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
  for (const h of history) {
    if (h.status === 'active' && !h.manualOverride && h.confidence != null && h.confidence < 30) {
      const age = Date.now() - new Date(h.firstSeenAt || h.lastSeenAt || 0).getTime();
      if (age > CONFIDENCE_EXPIRY_MS) {
        h.status = 'expired';
      }
    }
  }

  // Expire les candidats Vision (status=candidate) après 3 jours sans validation
  // Au-delà, l'annonce Vinted est probablement vendue ou retirée
  const CANDIDATE_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;
  for (const h of history) {
    if (h.status === 'candidate' && !h.manualOverride) {
      const lastSeen = new Date(h.lastSeenAt || h.firstSeenAt || 0).getTime();
      if (now - lastSeen > CANDIDATE_EXPIRY_MS) {
        h.status = 'expired';
      }
    }
  }

  // Keep max 500 entries (remove oldest archived/expired first)
  if (history.length > 500) {
    history.sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());
    history = history.slice(0, 500);
  }

  saveOpportunitiesHistory(history);
  return history;
}

// ─── Serve dashboard HTML ────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ─── API: Bot status ─────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  const scanData = readJsonSafe(getScanPath());
  const supervisorData = readJsonSafe(getAgentPath('supervisor'));
  const pipelineData = readJsonSafe(getAgentPath('pipeline'));

  const uptimeMs = Date.now() - botStartTime;
  const lastScanAt = scanData ? scanData.scannedAt : null;
  let isScanning = scanData ? scanData.scanning === true : false;

  // Watchdog : si scanning:true depuis plus de 10 min, le bot a crashé pendant le scan
  if (isScanning && scanData && scanData.scannedAt) {
    const scanAgeMs = Date.now() - new Date(scanData.scannedAt).getTime();
    if (scanAgeMs > 10 * 60 * 1000) {
      isScanning = false;
      try {
        writeJsonSafe(getScanPath(), { ...scanData, scanning: false });
      } catch { /* ignore */ }
    }
  }

  let lastError = null;
  if (pipelineData && pipelineData.pipeline) {
    const failedAgent = (pipelineData.pipeline.agents || []).find((a) => a.status === 'error');
    if (failedAgent) {
      lastError = { agent: failedAgent.name, error: failedAgent.error };
    }
  }

  res.json({
    online: true,
    uptimeMs,
    uptimeFormatted: formatDuration(uptimeMs),
    lastScanAt,
    lastScanAgo: lastScanAt ? formatDuration(Date.now() - new Date(lastScanAt).getTime()) : null,
    isScanning,
    lastScannedCountry: global._currentVintedCountry || null,
    totalListings: scanData ? (scanData.searchedListings || []).length : 0,
    totalOpportunities: scanData ? (scanData.opportunities || []).length : 0,
    lastError,
    configuredSearches: config.searches.map((s) => s.name),
    thresholds: {
      minProfitEur: config.minProfitEur,
      minProfitPercent: config.minProfitPercent
    }
  });
});

// ─── API: Opportunities (reads from history, enriches with live data) ─
app.get('/api/opportunities', (req, res) => {
  const filter = req.query.filter || 'active'; // active, accepted
  const scanData = readJsonSafe(getScanPath());

  // First, sync latest scan into history if available
  if (scanData && scanData.opportunities && scanData.opportunities.length > 0) {
    appendOpportunitiesToHistory(scanData.opportunities, scanData.scannedAt || new Date().toISOString());
  }
  // Sync candidates (en attente de vérification Vision)
  if (scanData && scanData.pendingReview && scanData.pendingReview.length > 0) {
    appendOpportunitiesToHistory(scanData.pendingReview, scanData.scannedAt || new Date().toISOString());
  }

  // Deduplicate by item ID: same Vinted item can appear on multiple country domains (fr/be/…)
  let history = deduplicateHistoryById(getOpportunitiesHistory());

  // Auto-fix: recalculer la confiance des opps où Vision a confirmé mais le score n'a pas été mis à jour
  let needsSave = false;
  try {
    const { computeConfidence } = require('./scoring');
    for (const h of history) {
      if (h.visionVerified && h.visionSameCard === true && (h.confidence || 0) < 50) {
        // Vision a confirmé mais le score est resté bas — recalculer
        if (!h.visionResult) h.visionResult = { sameCard: true, sameProduct: true };
        const oldConf = h.confidence || 0;
        h.confidence = computeConfidence(h);
        if (h.confidence !== oldConf) {
          needsSave = true;
          console.log(`[auto-fix] Confiance recalculée pour "${(h.title || '').slice(0, 50)}": ${oldConf} → ${h.confidence}`);
        }
      }
    }
    if (needsSave) saveOpportunitiesHistory(history);
  } catch (e) { /* non-bloquant */ }

  // Filter by status — aligné avec les counts (lignes 488-494)
  if (filter === 'accepted') {
    history = history.filter((h) => h.status === 'accepted');
  } else if (filter === 'dismissed') {
    history = history.filter((h) => h.status === 'dismissed' || h.status === 'rejected');
  } else if (filter === 'candidate') {
    // Candidats en attente de vérification Vision :
    // status=candidate OU status=active mais sans Vision confirmée
    history = history.filter((h) => h.status === 'candidate' || (h.status === 'active' && !h.visionVerified && !h.visionSameCard));
  } else {
    // Default: active ET validées par Vision GPT uniquement
    history = history.filter((h) => h.status === 'active' && (h.visionVerified === true || h.visionSameCard === true));
  }

  const supervisorData = readJsonSafe(getAgentPath('supervisor'));
  const liquidityData = readJsonSafe(getAgentPath('liquidity'));
  const claims = readClaims();

  // Index liquidité par URL pour lookup rapide
  const liquidityByUrl = {};
  if (liquidityData && liquidityData.opportunities) {
    for (const lo of liquidityData.opportunities) {
      if (lo.url) liquidityByUrl[lo.url] = lo.liquidity;
    }
  }

  let opportunities = history.map((opp) => {
    const itemKey = opp.id || (opp.url || '').match(/\/items\/(\d+)/)?.[1] || opp.url;

    // Enrich with supervisor data if available
    let verification = null;
    if (supervisorData && supervisorData.verified) {
      const match = supervisorData.verified.find((v) => v.url === opp.url);
      if (match) verification = match.verification;
    }

    // Enrich with liquidity data
    const liq = liquidityByUrl[opp.url] || (verification ? verification.liquidity : null);

    return {
      itemKey,
      search: opp.search,
      title: opp.title,
      platform: opp.platform || 'vinted',
      vintedPrice: opp.vintedPrice,
      estimatedSalePrice: opp.estimatedSalePrice,
      profit: opp.profit,
      profitPercent: opp.profitPercent,
      // Scores inline (calculés au scan) — priorité sur les données agents
      // opp.liquidity peut être un objet { score, classification, summary } (nouveau)
      // ou un number (anciens scans sérialisés), ou null
      confidenceScore: opp.confidence != null ? opp.confidence : (verification ? verification.confidenceScore : 0),
      liquidityScore: opp.liquidity != null
        ? (typeof opp.liquidity === 'object' ? opp.liquidity.score : opp.liquidity)
        : (liq ? liq.liquidityScore : null),
      liquiditySummary: (opp.liquidity && typeof opp.liquidity === 'object')
        ? opp.liquidity.summary
        : (liq ? liq.summary : null),
      adjustedMarginPercent: liq ? (liq.adjustedMargin ? liq.adjustedMargin.adjustedMarginPercent : null) : null,
      verdict: verification ? verification.verdict : null,
      url: opp.url,
      vintedCountry: opp.vintedCountry || null,
      vintedCountryFlag: opp.vintedCountryFlag || null,
      imageUrl: opp.imageUrl,
      ebayMatchImageUrl: opp.ebayMatchImageUrl || null,
      imageSimilarityScore: opp.imageSimilarityScore != null ? opp.imageSimilarityScore : null,
      pricingSource: opp.pricingSource,
      priceDetails: opp.priceDetails || null,
      matchedSalesCount: opp.matchedSalesCount || 0,
      ebayMatchTitle: opp.ebayMatchTitle || null,
      sourceQuery: opp.sourceQuery || null,
      sourceUrls: opp.sourceUrls || [],
      confidenceBreakdown: opp.confidenceBreakdown || null,
      sellerScore: opp.sellerScore != null ? opp.sellerScore : null,
      visionVerified: opp.visionVerified || false,
      visionSameCard: opp.visionSameCard != null ? opp.visionSameCard : null,
      visionResult: opp.visionFullResponse || null,
      visionReason: opp.visionReason || null,
      claim: claims[itemKey] || null,
      stale: opp.status === 'expired',
      status: opp.status,
      firstSeenAt: opp.firstSeenAt,
      lastSeenAt: opp.lastSeenAt
    };
  });

  // Filter out zero-profit items (not for dismissed/accepted/candidate views)
  if (filter === 'active' || filter === 'candidate') {
    opportunities = opportunities.filter((o) => (o.profit || 0) > 0);
  }

  // Sort by profit descending
  opportunities.sort((a, b) => (b.profit || 0) - (a.profit || 0));

  // Count by status for the badge (use deduplicated view)
  // IMPORTANT: appliquer le même filtre profit > 0 que pour les listes affichées
  // sinon les counts ne correspondent pas au nombre d'items visibles
  const allHistoryDeduped = deduplicateHistoryById(getOpportunitiesHistory());
  const hasProfitOrNoFilter = (h) => (h.profit || 0) > 0;
  const counts = {
    active: allHistoryDeduped.filter((h) => h.status === 'active' && (h.visionVerified === true || h.visionSameCard === true) && hasProfitOrNoFilter(h)).length,
    candidate: allHistoryDeduped.filter((h) => (h.status === 'candidate' || (h.status === 'active' && !h.visionVerified && !h.visionSameCard)) && hasProfitOrNoFilter(h)).length,
    accepted: allHistoryDeduped.filter((h) => h.status === 'accepted').length,
    dismissed: allHistoryDeduped.filter((h) => h.status === 'dismissed' || h.status === 'rejected').length,
    total: allHistoryDeduped.filter((h) => ((h.status === 'active' && (h.visionVerified === true || h.visionSameCard === true)) || h.status === 'accepted') && hasProfitOrNoFilter(h)).length,
    blacklisted: dismissedListings.getCount()
  };

  res.json({
    opportunities,
    total: opportunities.length,
    counts,
    scannedAt: scanData ? scanData.scannedAt : null
  });
});

// ─── API: Update opportunity status ─────────────────────────────────
app.post('/api/opportunities/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const validStatuses = ['active', 'sold', 'expired', 'archived', 'dismissed', 'bought'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Statut invalide. Valides: ${validStatuses.join(', ')}` });
  }

  let history = getOpportunitiesHistory();
  const opp = history.find((h) => h.id === id);
  if (!opp) {
    return res.status(404).json({ error: 'Opportunité non trouvée' });
  }

  opp.status = status;
  if (status === 'sold') opp.soldAt = new Date().toISOString();
  if (status === 'dismissed') {
    opp.dismissedAt = new Date().toISOString();
    // Ajouter à la blacklist permanente
    const vintedId = opp.id || (opp.url || '').match(/\/items\/(\d+)/)?.[1];
    if (vintedId) dismissedListings.addDismissed(vintedId, opp.title);
  }
  saveOpportunitiesHistory(history);

  broadcastSSE({ type: 'opportunities-update' });
  res.json({ success: true, opportunity: opp });
});

// ─── API: Accept opportunity ──────────────────────────────────────────
app.post('/api/opportunity/:id/accept', (req, res) => {
  const { id } = req.params;
  const history = getOpportunitiesHistory();
  const opp = history.find((h) => h.id === id);
  if (!opp) return res.status(404).json({ error: 'Opportunité non trouvée' });

  opp.status = 'accepted';
  opp.acceptedAt = new Date().toISOString();
  opp.manualOverride = true;
  saveOpportunitiesHistory(history);

  // State machine audit trail
  updateOppState(id, {
    status: 'accepted',
    title: opp.title,
    category: opp.search,
    vintedUrl: opp.url,
    vintedPrice: opp.vintedPrice || opp.vintedBuyerPrice,
    ebayAvgPrice: opp.estimatedSalePrice,
    profitEstimated: opp.profit && opp.profit.profit,
    confidenceScore: opp.confidence,
    by: 'manual'
  });

  appendFeedbackLog({
    id: opp.id,
    title: opp.title,
    decision: 'accepted',
    source: 'manual',
    reason: null,
    vintedPrice: opp.vintedPrice,
    marketPrice: opp.estimatedSalePrice,
    pricingSource: opp.pricingSource,
    timestamp: new Date().toISOString()
  });

  broadcastSSE({ type: 'opportunities-update' });
  res.json({ success: true });
});

// ─── API: Reject opportunity ──────────────────────────────────────────
app.post('/api/opportunity/:id/reject', (req, res) => {
  const { id } = req.params;
  const { reason, source } = req.body || {};
  const history = getOpportunitiesHistory();
  const opp = history.find((h) => h.id === id);
  if (!opp) return res.status(404).json({ error: 'Opportunité non trouvée' });

  opp.status = 'rejected';
  opp.rejectedAt = new Date().toISOString();
  saveOpportunitiesHistory(history);

  // State machine audit trail
  updateOppState(id, {
    status: 'rejected',
    title: opp.title,
    category: opp.search,
    vintedUrl: opp.url,
    vintedPrice: opp.vintedPrice || opp.vintedBuyerPrice,
    ebayAvgPrice: opp.estimatedSalePrice,
    by: source || 'manual',
    details: reason ? { reason } : null
  });

  appendFeedbackLog({
    id: opp.id,
    title: opp.title,
    decision: 'rejected',
    source: source || 'manual',
    reason: reason || null,
    vintedPrice: opp.vintedPrice,
    marketPrice: opp.estimatedSalePrice,
    pricingSource: opp.pricingSource,
    timestamp: new Date().toISOString()
  });

  broadcastSSE({ type: 'opportunities-update' });
  res.json({ success: true });
});

// ─── API: Historique transitions d'une opportunité ────────────────────
app.get('/api/opportunity/:id/history', (req, res) => {
  const { id } = req.params;
  const history = getOppHistory(id);
  const state = getOppState(id);
  res.json({ id, state: state || null, history });
});

// ─── API: Debug log (50 derniers événements root-cause) ──────────────
app.get('/api/debug-log', (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const events = readDebugLog(Math.min(limit, 200));
  res.json({ count: events.length, events });
});

// ─── API: Feedback report (stats apprentissage) ───────────────────────
app.get('/api/feedback-report', (_req, res) => {
  const log = readFeedbackLog();
  if (log.length === 0) {
    return res.json({ total: 0, accepted: 0, rejected: 0, acceptRate: 0, topRejectReasons: [], categoryStats: [], suggestions: [] });
  }

  const accepted = log.filter((e) => e.decision === 'accepted').length;
  const rejected = log.filter((e) => e.decision === 'rejected').length;
  const total = log.length;
  const acceptRate = total > 0 ? Math.round((accepted / total) * 100) : 0;

  // Top reject reasons
  const reasonCounts = {};
  log.filter((e) => e.decision === 'rejected' && e.reason).forEach((e) => {
    const key = String(e.reason).slice(0, 80);
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
  });
  const topRejectReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  // Source breakdown (manual vs gpt-vision)
  const gptAccepted = log.filter((e) => e.decision === 'accepted' && e.source === 'gpt-vision').length;
  const gptRejected = log.filter((e) => e.decision === 'rejected' && e.source === 'gpt-vision').length;

  // Category stats (by pricingSource as proxy for category)
  const catMap = {};
  log.forEach((e) => {
    const cat = e.pricingSource || 'unknown';
    if (!catMap[cat]) catMap[cat] = { accepted: 0, rejected: 0 };
    if (e.decision === 'accepted') catMap[cat].accepted++;
    else if (e.decision === 'rejected') catMap[cat].rejected++;
  });
  const categoryStats = Object.entries(catMap).map(([cat, stats]) => {
    const t = stats.accepted + stats.rejected;
    return { category: cat, accepted: stats.accepted, rejected: stats.rejected, total: t, acceptRate: Math.round((stats.accepted / t) * 100) };
  }).sort((a, b) => b.acceptRate - a.acceptRate);

  // Auto-generated suggestions
  const suggestions = [];
  if (rejected > accepted * 2 && total >= 5) {
    suggestions.push(`Taux de rejet élevé (${100 - acceptRate}%) — améliorer le matching de variantes dans scoring.js`);
  }
  if (topRejectReasons.length > 0 && topRejectReasons[0].count >= 3) {
    suggestions.push(`Raison dominante : "${topRejectReasons[0].reason.slice(0, 60)}" (${topRejectReasons[0].count}×)`);
  }
  if (total >= 5 && (gptRejected + gptAccepted) > 0) {
    const gptRejectRate = Math.round((gptRejected / (gptRejected + gptAccepted)) * 100);
    if (gptRejectRate > 60) {
      suggestions.push(`GPT Vision rejette ${gptRejectRate}% des vérifications — améliorer la qualité des images eBay`);
    }
  }

  res.json({ total, accepted, rejected, acceptRate, topRejectReasons, categoryStats, suggestions, gptAccepted, gptRejected });
});

// ─── API: Scan history ───────────────────────────────────────────────
app.get('/api/scans', (_req, res) => {
  const history = readJsonSafe(getScansHistoryPath()) || [];
  const scanData = readJsonSafe(getScanPath());

  // If current scan not yet in history, add it
  if (scanData && scanData.scannedAt) {
    const alreadyRecorded = history.some((h) => h.scannedAt === scanData.scannedAt);
    if (!alreadyRecorded) {
      history.push({
        scannedAt: scanData.scannedAt,
        scannedCount: scanData.scannedCount || 0,
        opportunityCount: (scanData.opportunities || []).length,
        underpricedCount: (scanData.underpricedAlerts || []).length,
        searches: [...new Set((scanData.searchedListings || []).map((l) => l.search).filter(Boolean))]
      });
    }
  }

  res.json({
    scans: history.slice(-50).reverse(),
    total: history.length
  });
});

// ─── API: Global stats ───────────────────────────────────────────────
app.get('/api/stats', (_req, res) => {
  const scanData = readJsonSafe(getScanPath());
  const supervisorData = readJsonSafe(getAgentPath('supervisor'));
  const history = readJsonSafe(getScansHistoryPath()) || [];

  if (!scanData) {
    return res.json({
      totalEstimatedProfit: 0,
      totalOpportunities: 0,
      scansToday: 0,
      successRate: 0,
      nicheStats: [],
      topNiche: null
    });
  }

  const allListings = scanData.searchedListings || [];

  // Total estimated profit: active Vision-verified + accepted opportunities
  const totalEstimatedProfit = Math.round(
    deduplicateHistoryById(getOpportunitiesHistory())
      .filter((h) => (h.status === 'active' || h.status === 'accepted') && (h.visionVerified === true || h.visionSameCard === true))
      .reduce((sum, h) => sum + (h.profit || 0), 0) * 100
  ) / 100;

  // For per-niche stats: use full history (active+accepted) pour les stats complètes
  // Plus fiable que le scan courant seul (1 scan = 1 pays, history = tous pays/scans)
  const opportunities = scanData.opportunities || [];

  // Scans today
  const today = new Date().toISOString().slice(0, 10);
  const scansToday = history.filter((h) => h.scannedAt && h.scannedAt.startsWith(today)).length;

  // Success rate: from history (stable data) — active+accepted opps with confidence >= 50 / total
  const activeHistory = deduplicateHistoryById(getOpportunitiesHistory()).filter((h) => h.status === 'active' || h.status === 'accepted');
  const successRate = activeHistory.length > 0
    ? Math.round((activeHistory.filter((h) => (h.confidence || 0) >= 50).length / activeHistory.length) * 10000) / 100
    : 0;

  // Per-niche stats
  const nicheMap = new Map();
  for (const listing of allListings) {
    const niche = listing.search || 'unknown';
    if (!nicheMap.has(niche)) {
      nicheMap.set(niche, { scanned: 0, opportunities: 0, totalProfit: 0, profits: [] });
    }
    const stat = nicheMap.get(niche);
    stat.scanned++;
  }

  // Niche opportunities: utilise l'historique complet (active+accepted) pour stats cross-scans
  for (const opp of activeHistory) {
    const niche = opp.search || 'unknown';
    if (!nicheMap.has(niche)) {
      nicheMap.set(niche, { scanned: 0, opportunities: 0, totalProfit: 0, profits: [] });
    }
    const stat = nicheMap.get(niche);
    stat.opportunities++;
    // Dans l'historique, opp.profit est un nombre (pas un objet)
    const profit = typeof opp.profit === 'number' ? opp.profit : (opp.profit && opp.profit.profit) ? opp.profit.profit : 0;
    stat.totalProfit += profit;
    stat.profits.push(profit);
  }

  const nicheStats = [...nicheMap.entries()].map(([name, stat]) => ({
    name,
    scanned: stat.scanned,
    opportunities: stat.opportunities,
    totalProfit: Math.round(stat.totalProfit * 100) / 100,
    avgProfit: stat.profits.length > 0
      ? Math.round((stat.totalProfit / stat.profits.length) * 100) / 100
      : 0,
    successRate: stat.scanned > 0
      ? Math.round((stat.opportunities / stat.scanned) * 10000) / 100
      : 0
  }));

  nicheStats.sort((a, b) => b.totalProfit - a.totalProfit);

  // Platform breakdown stats
  const platformStats = {};
  for (const listing of allListings) {
    const plat = listing.platform || 'vinted';
    platformStats[plat] = (platformStats[plat] || 0) + 1;
  }

  res.json({
    totalEstimatedProfit: Math.round(totalEstimatedProfit * 100) / 100,
    totalOpportunities: activeHistory.length,
    totalScanned: allListings.length,
    scansToday,
    successRate,
    nicheStats,
    platformStats,
    topNiche: nicheStats.length > 0 ? nicheStats[0].name : null,
    underpricedCount: (scanData.underpricedAlerts || []).length
  });
});

// ─── API: Performance history (charts) ──────────────────────────────
app.get('/api/performance-history', (_req, res) => {
  try {
    const history = deduplicateHistoryById(getOpportunitiesHistory());
    const scansHistory = readJsonSafe(getScansHistoryPath()) || [];

    // ── Profit history: group Vision-verified opportunities by date ──
    const profitByDate = new Map();
    for (const h of history) {
      if (!h.lastSeenAt) continue;
      // Graphique honnête : uniquement les opportunités validées par GPT Vision
      if (!h.visionVerified && !h.visionSameCard) continue;
      const date = h.lastSeenAt.slice(0, 10);
      if (!profitByDate.has(date)) {
        profitByDate.set(date, { profit: 0, count: 0 });
      }
      const entry = profitByDate.get(date);
      entry.profit += h.profit || 0;
      entry.count++;
    }
    const profitHistory = [...profitByDate.entries()]
      .map(([date, v]) => ({ date, profit: Math.round(v.profit * 100) / 100, count: v.count }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-30);

    // ── Category breakdown: Vision-verified only ──
    const catMap = new Map();
    for (const h of history) {
      // Uniquement les opportunités validées par GPT Vision
      if (!h.visionVerified && !h.visionSameCard) continue;
      const cat = h.search || 'Autre';
      if (!catMap.has(cat)) {
        catMap.set(cat, { profit: 0, count: 0 });
      }
      const entry = catMap.get(cat);
      entry.profit += h.profit || 0;
      entry.count++;
    }
    const categoryBreakdown = [...catMap.entries()]
      .map(([category, v]) => ({ category, profit: Math.round(v.profit * 100) / 100, count: v.count }))
      .sort((a, b) => b.profit - a.profit);

    // ── Daily scans: from scans history ──
    const scansByDate = new Map();
    for (const s of scansHistory) {
      if (!s.scannedAt) continue;
      const date = s.scannedAt.slice(0, 10);
      if (!scansByDate.has(date)) {
        scansByDate.set(date, { scans: 0, opportunities: 0 });
      }
      const entry = scansByDate.get(date);
      entry.scans++;
      entry.opportunities += s.opportunityCount || 0;
    }
    const dailyScans = [...scansByDate.entries()]
      .map(([date, v]) => ({ date, scans: v.scans, opportunities: v.opportunities }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-30);

    res.json({ profitHistory, categoryBreakdown, dailyScans });
  } catch (e) {
    console.error('Performance history error:', e.message);
    res.json({ profitHistory: [], categoryBreakdown: [], dailyScans: [] });
  }
});

// ─── API: eBay Browse API quota ─────────────────────────────────────
let _ebayQuotaCache = null;
let _ebayQuotaCachedAt = 0;

app.get('/api/ebay-quota', async (_req, res) => {
  const now = Date.now();
  if (_ebayQuotaCache !== undefined && now - _ebayQuotaCachedAt < 60000) {
    return res.json(_ebayQuotaCache);
  }
  try {
    const { getEbayQuota } = require('./marketplaces/ebay-api');
    const quota = await getEbayQuota(config);
    _ebayQuotaCache = quota || null;
    _ebayQuotaCachedAt = now;
    res.json(_ebayQuotaCache);
  } catch {
    res.json(null);
  }
});

// ─── API: Price database stats ──────────────────────────────────────
app.get('/api/price-database/stats', (_req, res) => {
  try {
    const priceDatabase = require('./price-database');
    const seenListings = require('./seen-listings');
    const stats = priceDatabase.getStats();
    stats.seenListings = seenListings.getSeenCount();
    res.json(stats);
  } catch (err) {
    res.json({ totalProducts: 0, categories: {}, seenListings: 0, error: err.message });
  }
});

// ─── API: Price trends ───────────────────────────────────────────────
app.get('/api/price-trends', (_req, res) => {
  try {
    const priceDatabase = require('./price-database');
    const trends = priceDatabase.detectTrends();
    res.json({ trends, total: trends.length });
  } catch (err) {
    res.json({ trends: [], total: 0, error: err.message });
  }
});

// ─── API: Price database browse ─────────────────────────────────────
app.get('/api/price-database/browse', (_req, res) => {
  try {
    const priceDatabase = require('./price-database');
    const stats = priceDatabase.getStats();
    const dbPath = path.join(config.outputDir, 'price-database.json');
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch { /* empty */ }

    const products = [];
    for (const [key, entry] of Object.entries(raw)) {
      if (!entry || !entry.name) continue;

      // Tendance basée sur les prix marché
      const mPrices = (entry.marketPrices || []).filter(p => p.price > 0);
      let trend = 'stable';
      if (mPrices.length >= 5) {
        const avg3first = mPrices.slice(0, 3).reduce((s, p) => s + p.price, 0) / 3;
        const avg3last = mPrices.slice(-3).reduce((s, p) => s + p.price, 0) / 3;
        const pct = ((avg3last - avg3first) / avg3first) * 100;
        if (pct > 15) trend = 'rising';
        else if (pct < -15) trend = 'falling';
      }

      // Spread marché vs Vinted (en %)
      const spread = (entry.avgVintedPrice > 0 && entry.avgMarketPrice > 0)
        ? Math.round(((entry.avgMarketPrice - entry.avgVintedPrice) / entry.avgVintedPrice) * 100)
        : null;

      products.push({
        key,
        name: entry.name,
        category: entry.category || 'misc',
        avgVintedPrice: entry.avgVintedPrice || 0,
        avgMarketPrice: entry.avgMarketPrice || 0,
        minMarketPrice: entry.minMarketPrice || 0,
        maxMarketPrice: entry.maxMarketPrice || 0,
        vintedObservations: entry.vintedObservations || 0,
        marketObservations: entry.marketObservations || 0,
        spread,
        lastSeen: entry.lastSeen || null,
        trend,
        listings: (entry.marketPrices || [])
          .filter(mp => mp.url)
          .map(mp => ({
            url: mp.url,
            price: mp.price,
            source: mp.source,
            title: mp.listingTitle || '',
            date: mp.date
          }))
      });
    }

    products.sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
    res.json({ products, stats });
  } catch (err) {
    res.json({ products: [], stats: { totalProducts: 0, categories: {} }, error: err.message });
  }
});

// ─── API: Liquidity data ────────────────────────────────────────────
app.get('/api/liquidity', (_req, res) => {
  const liquidityData = readJsonSafe(getAgentPath('liquidity'));
  if (!liquidityData) {
    return res.json({ opportunities: [], summary: null });
  }
  res.json(liquidityData);
});

// ─── API: Discovery data ─────────────────────────────────────────────
app.get('/api/discovery', (_req, res) => {
  const discoveryData = readJsonSafe(getAgentPath('discovery'));
  if (!discoveryData) {
    return res.json({ suggestions: [], patterns: null, priceTrends: [], summary: null });
  }
  res.json(discoveryData);
});

// ─── API: Trigger manual scan ────────────────────────────────────────
app.post('/api/scan', (_req, res) => {
  const scanData = readJsonSafe(getScanPath());
  if (scanData && scanData.scanning) {
    return res.status(409).json({ error: 'Un scan est déjà en cours.' });
  }

  // Signal the main process to start a scan
  if (global._triggerScan) {
    global._triggerScan();
    res.json({ success: true, message: 'Scan lancé.' });
  } else {
    res.status(503).json({
      error: 'Le bot n\'est pas en mode boucle. Lancez avec: npm run loop'
    });
  }
});

// ─── API: Scan ciblé par niche (1h max) ─────────────────────────────
app.post('/api/scan/niche', (req, res) => {
  const { niche, durationMinutes } = req.body || {};
  if (!niche) {
    return res.status(400).json({ error: 'Paramètre "niche" requis.' });
  }

  // Vérifier que la niche existe dans config.searches
  const matchingSearch = config.searches.find(s => s.name === niche);
  if (!matchingSearch) {
    return res.status(404).json({ error: `Niche "${niche}" introuvable.`, available: config.searches.map(s => s.name) });
  }

  // Vérifier qu'un scan n'est pas déjà en cours
  const scanData = readJsonSafe(getScanPath());
  if (scanData && scanData.scanning) {
    return res.status(409).json({ error: 'Un scan est déjà en cours. Attendez qu\'il finisse.' });
  }

  const duration = Math.min(Math.max(parseInt(durationMinutes) || 60, 5), 120); // 5min - 2h, défaut 1h

  // Activer le mode niche ciblée
  global._nicheOverride = {
    niche: niche,
    searchConfig: matchingSearch,
    startedAt: Date.now(),
    endsAt: Date.now() + duration * 60 * 1000,
    durationMinutes: duration,
    scansCompleted: 0
  };

  // Timer pour désactiver automatiquement après la durée
  if (global._nicheOverrideTimer) clearTimeout(global._nicheOverrideTimer);
  global._nicheOverrideTimer = setTimeout(() => {
    if (global._nicheOverride) {
      console.log(`[niche-scan] Fin du scan ciblé "${niche}" après ${duration}min (${global._nicheOverride.scansCompleted} scans effectués)`);
      global._nicheOverride = null;
    }
  }, duration * 60 * 1000);

  console.log(`[niche-scan] Scan ciblé "${niche}" activé pour ${duration} minutes`);

  // Déclencher un scan immédiatement
  if (global._triggerScan) {
    global._triggerScan();
  }

  res.json({
    success: true,
    message: `Scan ciblé "${niche}" activé pour ${duration} minutes.`,
    niche: niche,
    durationMinutes: duration,
    endsAt: new Date(global._nicheOverride.endsAt).toISOString()
  });
});

// ─── API: Arrêter le scan ciblé ─────────────────────────────────────
app.post('/api/scan/niche/stop', (_req, res) => {
  if (!global._nicheOverride) {
    return res.json({ success: true, message: 'Aucun scan ciblé en cours.' });
  }
  const niche = global._nicheOverride.niche;
  const scans = global._nicheOverride.scansCompleted;
  global._nicheOverride = null;
  if (global._nicheOverrideTimer) {
    clearTimeout(global._nicheOverrideTimer);
    global._nicheOverrideTimer = null;
  }
  console.log(`[niche-scan] Scan ciblé "${niche}" arrêté manuellement (${scans} scans effectués)`);
  res.json({ success: true, message: `Scan ciblé "${niche}" arrêté.`, scansCompleted: scans });
});

// ─── API: Status du scan ciblé ──────────────────────────────────────
app.get('/api/scan/niche/status', (_req, res) => {
  if (!global._nicheOverride) {
    return res.json({ active: false });
  }
  const o = global._nicheOverride;
  res.json({
    active: true,
    niche: o.niche,
    startedAt: new Date(o.startedAt).toISOString(),
    endsAt: new Date(o.endsAt).toISOString(),
    remainingMinutes: Math.max(0, Math.round((o.endsAt - Date.now()) / 60000)),
    scansCompleted: o.scansCompleted,
    durationMinutes: o.durationMinutes
  });
});

// ─── API: Latest scan data (legacy compat) ───────────────────────────
app.get('/api/scan/raw', (_req, res) => {
  const scanData = readJsonSafe(getScanPath());
  if (!scanData) {
    return res.json({ error: 'Aucun scan disponible.' });
  }
  res.json(scanData);
});

// ─── API: Config info ────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    searches: config.searches.map((s) => ({
      name: s.name,
      maxPrice: s.maxPrice,
      pricingSource: s.pricingSource,
      vintedQueries: s.vintedQueries,
      requiredAllTokens: s.requiredAllTokens,
      requiredAnyTokens: s.requiredAnyTokens,
      blockedTokens: s.blockedTokens,
      facebookEnabled: s.facebookEnabled || false
    })),
    minProfitEur: config.minProfitEur,
    minProfitPercent: config.minProfitPercent,
    maxItemsPerSearch: config.maxItemsPerSearch,
    ebayBaseUrls: config.ebayBaseUrls,
    vintedShippingEstimate: config.vintedShippingEstimate,
    ebayOutboundShippingEstimate: config.ebayOutboundShippingEstimate,
    dashboardPort: PORT
  });
});

// ─── API: Claim / Unclaim ────────────────────────────────────────────
app.post('/api/claim', (req, res) => {
  const { itemKey, username, vintedUrl } = req.body;
  if (!itemKey || !username) {
    return res.status(400).json({ error: 'itemKey and username required' });
  }

  const claims = readClaims();
  claims[itemKey] = {
    username,
    vintedUrl: vintedUrl || null,
    claimedAt: new Date().toISOString()
  };
  writeClaims(claims);
  broadcastSSE({ type: 'claim', data: claims[itemKey] });
  res.json({ success: true, claim: claims[itemKey] });
});

app.delete('/api/claim/:itemKey', (req, res) => {
  const { itemKey } = req.params;
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ error: 'username query param required' });
  }

  const claims = readClaims();
  const claim = claims[itemKey];

  if (!claim) return res.status(404).json({ error: 'Claim not found' });
  if (claim.username !== username) return res.status(403).json({ error: 'Only the claiming user can unclaim' });

  delete claims[itemKey];
  writeClaims(claims);
  broadcastSSE({ type: 'unclaim', data: { itemKey } });
  res.json({ success: true });
});

app.get('/api/claims', (_req, res) => {
  res.json(readClaims());
});

// ─── API: Archive listing ────────────────────────────────────────────
app.delete('/api/listing/:itemKey', (req, res) => {
  const { itemKey } = req.params;
  const scanPath = getScanPath();
  const scanData = readJsonSafe(scanPath);

  if (!scanData) return res.status(404).json({ error: 'No scan data' });

  let found = false;

  if (scanData.searchedListings) {
    scanData.searchedListings = scanData.searchedListings.filter((l) => {
      const lKey = l.url.match(/\/items\/(\d+)/)?.[1] || l.url;
      if (lKey === itemKey) { found = true; return false; }
      return true;
    });
  }

  if (scanData.opportunities) {
    scanData.opportunities = scanData.opportunities.filter((l) => {
      const lKey = l.url.match(/\/items\/(\d+)/)?.[1] || l.url;
      return lKey !== itemKey;
    });
  }

  if (scanData.underpricedAlerts) {
    scanData.underpricedAlerts = scanData.underpricedAlerts.filter((a) => {
      if (!a.listing) return true;
      const lKey = a.listing.url.match(/\/items\/(\d+)/)?.[1] || a.listing.url;
      return lKey !== itemKey;
    });
  }

  if (!found) return res.status(404).json({ error: 'Listing not found' });

  writeJsonSafe(scanPath, scanData);
  broadcastSSE({ type: 'scan-update' });
  res.json({ success: true });
});

// ─── API: Portfolio (Strategist) ─────────────────────────────────────

app.get('/api/portfolio/strategy', (_req, res) => {
  try {
    const data = getPortfolioData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/portfolio/purchase', (req, res) => {
  const { productName, purchasePrice, shippingCost, platform, category, estimatedSalePrice, url, imageUrl, notes } = req.body;
  if (!productName || !purchasePrice) {
    return res.status(400).json({ error: 'productName et purchasePrice requis' });
  }

  const portfolio = loadPortfolio();
  const result = recordPurchase(portfolio, {
    productName, purchasePrice: Number(purchasePrice),
    shippingCost: Number(shippingCost || 0),
    platform: platform || 'vinted',
    category: category || 'tcg',
    estimatedSalePrice: estimatedSalePrice ? Number(estimatedSalePrice) : null,
    url, imageUrl, notes
  });

  if (!result.success) {
    return res.status(400).json(result);
  }

  broadcastSSE({ type: 'portfolio-update' });
  res.json(result);
});

app.post('/api/portfolio/sale', (req, res) => {
  const { purchaseId, salePrice, salePlatform, platformFees, shippingCost, notes } = req.body;
  if (!purchaseId || !salePrice) {
    return res.status(400).json({ error: 'purchaseId et salePrice requis' });
  }

  const portfolio = loadPortfolio();
  const result = recordSale(portfolio, {
    purchaseId, salePrice: Number(salePrice),
    salePlatform: salePlatform || 'ebay',
    platformFees: platformFees !== undefined ? Number(platformFees) : null,
    shippingCost: Number(shippingCost || 0),
    notes
  });

  if (!result.success) {
    return res.status(400).json(result);
  }

  broadcastSSE({ type: 'portfolio-update' });
  res.json(result);
});

app.post('/api/portfolio/weekly-report', async (_req, res) => {
  try {
    const portfolio = loadPortfolio();
    const report = await sendWeeklyReport(portfolio);
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Agent control ─────────────────────────────────────────────
app.get('/api/agents/status', (_req, res) => {
  res.json(agentStatus);
});

app.post('/api/agents/:agentName', async (req, res) => {
  const { agentName } = req.params;

  if (!agentStatus[agentName]) {
    return res.status(404).json({ error: `Agent inconnu: ${agentName}` });
  }

  if (agentStatus[agentName].status === 'running') {
    return res.status(409).json({ error: `L'agent ${agentName} est déjà en cours d'exécution.` });
  }

  // Mark as running
  agentStatus[agentName].status = 'running';
  agentStatus[agentName].error = null;
  broadcastSSE({ type: 'agent-status', data: agentStatus });

  // Respond immediately, run in background
  res.json({ success: true, message: `Agent ${agentName} lancé.` });

  // Execute agent in background
  try {
    let result;
    const scanData = readJsonSafe(getScanPath());

    switch (agentName) {
      case 'diagnostic':
        result = await diagnose(config, {
          deepDiagnose: true,
          checkPlatforms: true,
          sendTelegram: false
        });
        await saveAgentResult('diagnostic', result);
        agentStatus[agentName].lastResult = result.summary || { status: 'done' };
        break;

      case 'discovery':
        result = await discover(config, { sendTelegram: false });
        if (!result) result = { summary: { status: 'désactivé' }, suggestions: [] };
        await saveAgentResult('discovery', result);
        agentStatus[agentName].lastResult = result.summary || { totalSuggestions: (result.suggestions || []).length };
        break;

      case 'explore':
        result = await explore(config, { sendTelegram: false });
        await saveAgentResult('product-explorer', result);
        // Normalise les champs pour le dashboard
        agentStatus[agentName].lastResult = result.summary
          ? {
            categoriesEvaluated: result.summary.totalNiches || result.summary.total || 0,
            topCategory: result.summary.topCategory || null,
            avgNetProfit: result.summary.avgNetProfit || 0,
            trendingProducts: result.summary.trendingProducts || 0
          }
          : { status: 'done' };
        break;

      case 'strategy': {
        const opps = scanData ? (scanData.opportunities || []) : [];
        try {
          result = await strategize(opps, { sendTelegram: false });
        } catch (stratErr) {
          console.error('[Agent strategy] erreur:', stratErr.message);
          result = null;
        }
        if (!result) result = { summary: { status: 'erreur', tier: '-', tierName: 'Inconnu', availableBalance: 0, acheter: 0, total: 0 } };
        await saveAgentResult('strategist', result);
        // Normalise les champs pour le dashboard
        agentStatus[agentName].lastResult = result.summary
          ? {
            currentTier: { level: result.summary.tier, name: result.summary.tierName },
            availableBudget: result.summary.availableBalance,
            activePurchases: result.summary.acheter || 0,
            total: result.summary.total
          }
          : { status: 'done' };
        break;
      }

      case 'liquidity': {
        const opps = scanData ? (scanData.opportunities || []) : [];
        if (opps.length === 0) {
          agentStatus[agentName].lastResult = { message: 'Aucune opportunité à analyser' };
          break;
        }
        result = await assessLiquidity(opps);
        await saveAgentResult('liquidity', result);
        // Normalise les champs pour le dashboard
        agentStatus[agentName].lastResult = result.summary
          ? {
            totalAnalyzed: result.summary.total,
            flashCount: (result.summary.speedDistribution || {}).flash || 0,
            fastCount: (result.summary.speedDistribution || {}).rapide || 0,
            slowCount: ((result.summary.speedDistribution || {}).lent || 0) + ((result.summary.speedDistribution || {}).tresLent || 0),
            avgLiquidityScore: result.summary.avgLiquidityScore
          }
          : { status: 'done' };
        break;
      }
    }

    agentStatus[agentName].status = 'idle';
    agentStatus[agentName].lastRun = new Date().toISOString();
  } catch (error) {
    agentStatus[agentName].status = 'error';
    agentStatus[agentName].error = error.message;
    agentStatus[agentName].lastRun = new Date().toISOString();
    agentStatus[agentName].lastResult = { error: error.message };
    console.error(`[API] Erreur agent ${agentName}: ${error.message}`);
  }

  broadcastSSE({ type: 'agent-status', data: agentStatus });
});

// ─── API: Archive opportunity (🗑 button) ─────────────────────────────
app.delete('/api/opportunities/:id', (req, res) => {
  const { id } = req.params;
  let history = getOpportunitiesHistory();
  const opp = history.find((h) => h.id === id);
  if (!opp) return res.status(404).json({ error: 'Opportunité non trouvée' });

  opp.status = 'archived';
  opp.archivedAt = new Date().toISOString();
  saveOpportunitiesHistory(history);
  broadcastSSE({ type: 'opportunities-update' });
  res.json({ success: true });
});

// ─── API: Submit feedback ────────────────────────────────────────────
app.post('/api/feedback', (req, res) => {
  const { opportunityId, validated, note } = req.body;
  if (opportunityId === undefined || validated === undefined) {
    return res.status(400).json({ error: 'opportunityId et validated requis' });
  }

  const history = getOpportunitiesHistory();
  const opp = history.find((h) => h.id === opportunityId);

  const feedback = readFeedback();
  const existingIdx = feedback.reports.findIndex((r) => r.opportunityId === opportunityId);
  const report = {
    id: existingIdx >= 0 ? feedback.reports[existingIdx].id : `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    opportunityId,
    title: opp ? opp.title : null,
    validated: Boolean(validated),
    note: note || null,
    vintedUrl: opp ? opp.url : null,
    ebayPrice: opp ? opp.estimatedSalePrice : null,
    vintedPrice: opp ? opp.vintedPrice : null,
    category: opp ? opp.search : null,
    timestamp: new Date().toISOString()
  };

  if (existingIdx >= 0) {
    feedback.reports[existingIdx] = report; // Update existing — prevent duplicates
  } else {
    feedback.reports.push(report);
  }
  writeFeedback(feedback);

  // Rebuild learned rules after each new feedback (non-blocking)
  try { rebuildRules(); invalidateRulesCache(); } catch { /* ignore */ }

  // Auto-dismiss on negative feedback
  if (!Boolean(validated) && opp) {
    opp.status = 'dismissed';
    opp.dismissedAt = new Date().toISOString();
    // Blacklist permanente
    const vintedIdFb = opp.id || (opp.url || '').match(/\/items\/(\d+)/)?.[1];
    if (vintedIdFb) dismissedListings.addDismissed(vintedIdFb, opp.title);
    saveOpportunitiesHistory(history);
    broadcastSSE({ type: 'opportunities-update' });
  }

  res.json({ success: true, report });
});

// ─── API: Get all feedback reports ──────────────────────────────────
app.get('/api/feedback', (_req, res) => {
  res.json(readFeedback());
});

// ─── API: Proxy image (bypass Vinted CDN hotlink protection) ─────────
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return res.status(400).end(); }

  try {
    const response = await fetch(parsedUrl.toString(), {
      headers: {
        'Referer': 'https://www.vinted.fr/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
      },
      redirect: 'follow'
    });
    if (!response.ok) return res.status(response.status).end();
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) return res.status(400).end();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// ─── API: Feedback Analyzer (auto-amélioration) ──────────────────────
let _analyzerRunning = false;

app.get('/api/feedback-analyzer/run', async (_req, res) => {
  if (_analyzerRunning) {
    return res.status(409).json({ error: 'Analyse déjà en cours.' });
  }
  _analyzerRunning = true;
  try {
    const { runAnalysis } = require('./feedback-analyzer');
    const result = await runAnalysis({ sendTelegram: false });
    res.json({ success: true, report: result });
  } catch (err) {
    console.error('[API] feedback-analyzer erreur:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    _analyzerRunning = false;
  }
});

app.get('/api/feedback-analyzer/report', (_req, res) => {
  const { getLastReport, getAdjustmentsLog } = require('./feedback-analyzer');
  const report = getLastReport();
  const log = getAdjustmentsLog();
  res.json({ report, adjustmentsLog: log.slice(-20).reverse() });
});

// ─── SSE: Server-Sent Events ─────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  sseClients.push(res);
  res.write('event: connected\ndata: {"message":"Connected"}\n\n');

  const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const idx = sseClients.indexOf(res);
    if (idx > -1) sseClients.splice(idx, 1);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}j ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}min`;
  if (minutes > 0) return `${minutes}min`;
  return `${seconds}s`;
}

// ─── API: Reverse scan (eBay→Vinted) on demand ──────────────────────────────
app.post('/api/scan/reverse', async (_req, res) => {
  const scanPath = path.join(config.outputDir, 'latest-scan.json');
  let scanData = null;
  try {
    if (fs.existsSync(scanPath)) scanData = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
  } catch { /* ignore */ }

  if (scanData && scanData.scanning) {
    return res.status(409).json({ error: 'Un scan est déjà en cours.' });
  }
  res.json({ success: true, message: 'Scan eBay→Vinted lancé.' });

  try {
    const { runReverseScanner } = require('./scanners/reverse-scanner');
    const { computeConfidence, computeLiquidity } = require('./scoring');
    const { isOpportunity } = require('./profit');
    const existingVinted = (scanData && scanData.searchedListings) || [];
    const newOpps = await runReverseScanner(config, existingVinted);
    if (newOpps.length > 0 && scanData) {
      for (const opp of newOpps) {
        opp.confidence = computeConfidence(opp);
        opp.liquidity = computeLiquidity(opp);
        opp.lastSeenAt = new Date().toISOString();
        opp.firstSeenAt = opp.firstSeenAt || opp.lastSeenAt;
      }
      const existingByUrl = new Map((scanData.searchedListings || []).map(l => [l.url, l]));
      for (const opp of newOpps) { if (opp.url) existingByUrl.set(opp.url, opp); }
      scanData.searchedListings = [...existingByUrl.values()];
      const existingOppUrls = new Set((scanData.opportunities || []).map(o => o.url));
      for (const opp of newOpps) {
        if (opp.url && !existingOppUrls.has(opp.url) && isOpportunity(opp.profit, config)) {
          scanData.opportunities = scanData.opportunities || [];
          scanData.opportunities.push(opp);
        }
      }
      fs.writeFileSync(scanPath, JSON.stringify(scanData, null, 2), 'utf8');
      broadcastSSE({ type: 'scan-update' });
    }
    console.log(`[API] Scan reverse terminé: ${newOpps.length} opportunité(s) eBay→Vinted`);
  } catch (err) {
    console.error(`[API] Reverse scan erreur: ${err.message}`);
  }
});

// ─── API: Cardmarket→eBay scan on demand ─────────────────────────────────────
app.post('/api/scan/cardmarket', async (_req, res) => {
  const scanPath = path.join(config.outputDir, 'latest-scan.json');
  let scanData = null;
  try {
    if (fs.existsSync(scanPath)) scanData = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
  } catch { /* ignore */ }

  if (scanData && scanData.scanning) {
    return res.status(409).json({ error: 'Un scan est déjà en cours.' });
  }
  res.json({ success: true, message: 'Scan Cardmarket→eBay lancé.' });

  try {
    const { runCardmarketScanner } = require('./scanners/cardmarket-scanner');
    const { computeConfidence, computeLiquidity } = require('./scoring');
    const { isOpportunity } = require('./profit');
    const cmOpps = await runCardmarketScanner(config);
    if (cmOpps.length > 0 && scanData) {
      for (const opp of cmOpps) {
        opp.confidence = computeConfidence(opp);
        opp.liquidity = computeLiquidity(opp);
        opp.lastSeenAt = new Date().toISOString();
        opp.firstSeenAt = opp.firstSeenAt || opp.lastSeenAt;
      }
      const existingByUrl = new Map((scanData.searchedListings || []).map(l => [l.url, l]));
      for (const opp of cmOpps) { if (opp.url) existingByUrl.set(opp.url, opp); }
      scanData.searchedListings = [...existingByUrl.values()];
      const existingOppUrls = new Set((scanData.opportunities || []).map(o => o.url));
      for (const opp of cmOpps) {
        if (opp.url && !existingOppUrls.has(opp.url) && isOpportunity(opp.profit, config)) {
          scanData.opportunities = scanData.opportunities || [];
          scanData.opportunities.push(opp);
        }
      }
      fs.writeFileSync(scanPath, JSON.stringify(scanData, null, 2), 'utf8');
      broadcastSSE({ type: 'scan-update' });
    }
    console.log(`[API] Cardmarket scan terminé: ${cmOpps.length} opportunité(s) CM→eBay`);
  } catch (err) {
    console.error(`[API] Cardmarket scan erreur: ${err.message}`);
  }
});

// ─── API: Verify opportunity (re-run pricing cascade) ────────────────
app.post('/api/verify-opportunity', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id requis' });

  const history = getOpportunitiesHistory();
  const opp = history.find((h) => h.id === id);
  if (!opp) return res.status(404).json({ error: 'Opportunité non trouvée' });

  try {
    const { getPrice, clearPriceCache } = require('./price-router');

    const listing = {
      title: opp.title,
      buyerPrice: opp.vintedPrice,
      imageUrl: opp.imageUrl || null,
      url: opp.url
    };

    // Find the matching search config
    const searchConfig = config.searches.find((s) => s.name === opp.search);
    const pricingSource = searchConfig ? searchConfig.pricingSource : (opp.pricingSource || 'ebay');

    // Clear cache entry so we get a fresh result
    clearPriceCache();

    const result = await getPrice(listing, pricingSource, config, searchConfig);

    if (!result || !result.marketPrice) {
      return res.json({
        success: true,
        result: {
          confirmed: false,
          source: 'aucune source',
          newPrice: opp.estimatedSalePrice,
          newProfit: opp.profit,
          diff: 0,
          message: 'Impossible de vérifier le prix'
        }
      });
    }

    const originalPrice = opp.estimatedSalePrice || 0;
    const newPrice = result.marketPrice;
    const diff = originalPrice > 0 ? Math.round(Math.abs(newPrice - originalPrice) / originalPrice * 100) : 100;
    const confirmed = diff <= 30;

    // Recompute profit with new price
    const shippingOut = config.ebayOutboundShippingEstimate || 3.5;
    const ebayFees = 0.13;
    const newNetSale = newPrice * (1 - ebayFees) - shippingOut;
    const newProfit = Math.round((newNetSale - (opp.vintedPrice || 0)) * 100) / 100;

    // Update price data if price has changed (before vision check)
    if (!confirmed) {
      opp.estimatedSalePrice = Math.round(newPrice * 100) / 100;
      opp.profit = newProfit;
      opp.profitPercent = opp.vintedPrice > 0
        ? Math.round((newProfit / opp.vintedPrice) * 10000) / 100
        : null;
      opp.pricingSource = result.pricingSource;
    }

    // ─── Vision verification (GPT-4o mini) ──────────────────
    let vision = null;
    try {
      const { compareCardImages } = require('./vision-verify');
      const vintedImg = opp.imageUrl || null;
      // Use stored eBay image from history as fallback (price-router doesn't return referenceImageUrl)
      const ebayImg = result.referenceImageUrl || opp.ebayMatchImageUrl || null;
      if (vintedImg && ebayImg) {
        console.log(`[API] Vision verify: Vinted=${vintedImg.slice(0, 60)} eBay=${ebayImg.slice(0, 60)}`);
        vision = await compareCardImages(vintedImg, ebayImg);
      } else {
        console.log(`[API] Vision verify skipped: vintedImg=${!!vintedImg} ebayImg=${!!ebayImg}`);
      }
    } catch (vErr) {
      console.warn('[API] Vision verify ignorée:', vErr.message);
    }

    const visionMismatch = vision && vision.verdict === 'no_match';

    // Persist verification result to history (survives dashboard refresh)
    opp.verification = {
      date: new Date().toISOString(),
      confirmed: confirmed && !visionMismatch,
      vision,
      priceCheck: {
        source: result.pricingSource || 'inconnu',
        newPrice: Math.round(newPrice * 100) / 100,
        newProfit,
        diff
      }
    };
    saveOpportunitiesHistory(history);
    broadcastSSE({ type: 'opportunities-update' });

    return res.json({
      success: true,
      result: {
        confirmed: confirmed && !visionMismatch,
        source: result.pricingSource || 'inconnu',
        newPrice: Math.round(newPrice * 100) / 100,
        newProfit,
        diff,
        vision
      }
    });
  } catch (err) {
    console.error(`[API] Verify opportunity erreur: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ─── API: Verify image (GPT Vision + auto-dismiss si mismatch) ────────
app.post('/api/verify-image', async (req, res) => {
  const { id, manual } = req.body;
  if (!id) return res.status(400).json({ error: 'id requis' });

  const history = getOpportunitiesHistory();
  const opp = history.find((h) => h.id === id);
  if (!opp) return res.status(404).json({ error: 'Opportunité non trouvée' });

  try {
    const { compareCardImages } = require('./vision-verify');
    const vintedImg = (opp.photos && opp.photos[0]) || opp.imageUrl || null;
    const ebayImg = opp.ebayMatchImageUrl || opp.matchImage || opp.ebayImage || null;

    if (!vintedImg || !ebayImg) {
      return res.json({
        success: true,
        skipped: true,
        reason: `Images manquantes (vinted=${!!vintedImg}, ebay=${!!ebayImg})`
      });
    }

    console.log(`[API] verify-image: Vinted=${vintedImg.slice(0, 60)} eBay=${ebayImg.slice(0, 60)}`);
    const vision = await compareCardImages(vintedImg, ebayImg);

    if (!vision) {
      return res.json({ success: true, skipped: true, reason: 'Vision API indisponible' });
    }

    // Title override: si sameProduct=true mais sameVariant=false, vérifier les titres
    if (vision.sameProduct === true && vision.sameVariant === false && vision.verdict === 'no_match') {
      const VARIANT_KEYWORDS = [
        'diamond pull', 'diamond', 'holo', 'holographic', 'silver', 'gold',
        'refractor', 'cracked ice', 'prizm', 'parallel', 'chrome', 'rainbow',
        'pink', 'green', 'blue', 'red', 'purple', 'orange', 'black', 'white',
        'numbered', '/75', '/99', '/199', '/499',
        '1st edition', 'first edition', 'shadowless', 'reverse holo',
        'sealed', 'scellé', 'neuf', 'misb', 'nisb', 'complete', 'complet'
      ];
      const vintedTitle = (opp.title || '').toLowerCase();
      const ebayTitle = (opp.ebayMatchTitle || '').toLowerCase();
      if (vintedTitle && ebayTitle) {
        const sharedKeyword = VARIANT_KEYWORDS.find((kw) => vintedTitle.includes(kw) && ebayTitle.includes(kw));
        if (sharedKeyword) {
          vision.verdict = 'match';
          vision.reason = `titre override: même variante dans les deux titres ("${sharedKeyword}")`;
          console.log(`[API] verify-image titre override: "${sharedKeyword}" dans les deux titres`);
        }
      }
    }

    // Save GPT report to opportunity history
    opp.gptReport = {
      checkedAt: new Date().toISOString(),
      verdict: vision.verdict,
      reason: vision.reason || '',
      sameProduct: vision.sameProduct,
      sameVariant: vision.sameVariant,
      conditionComparable: vision.conditionComparable,
      report: vision.report || null
    };

    const previousStatus = opp.status;

    if (vision.verdict === 'no_match') {
      opp.status = 'rejected';
      opp.rejectedAt = new Date().toISOString();
      opp.rejectReason = 'gpt-vision-mismatch';
      opp.gptVerdict = vision.reason || 'Produits différents';
      opp.visionVerified = true;
      opp.visionSameCard = false;

      appendFeedbackLog({
        id: opp.id,
        title: opp.title,
        decision: 'rejected',
        source: 'gpt-vision',
        reason: vision.reason || (vision.report || ''),
        vintedPrice: opp.vintedPrice,
        marketPrice: opp.estimatedSalePrice,
        pricingSource: opp.pricingSource,
        timestamp: new Date().toISOString()
      });
    } else {
      // GPT confirms match → promote candidate→active, or accept if already active
      if (previousStatus === 'candidate') {
        opp.status = 'active';
        console.log(`[API] verify-image: candidate → active (Vision OK): "${(opp.title || '').slice(0, 50)}"`);
      } else {
        opp.status = 'accepted';
      }
      opp.acceptedAt = new Date().toISOString();
      opp.visionVerified = true;
      opp.visionSameCard = true;

      appendFeedbackLog({
        id: opp.id,
        title: opp.title,
        decision: previousStatus === 'candidate' ? 'promoted' : 'accepted',
        source: 'gpt-vision',
        reason: vision.reason || (vision.report || ''),
        vintedPrice: opp.vintedPrice,
        marketPrice: opp.estimatedSalePrice,
        pricingSource: opp.pricingSource,
        timestamp: new Date().toISOString()
      });
    }

    const wasPromoted = vision.verdict === 'match' && previousStatus === 'candidate';

    // Recalculer le score de confiance avec le résultat Vision
    try {
      const { computeConfidence } = require('./scoring');
      opp.visionResult = { sameCard: opp.visionSameCard, sameProduct: opp.visionSameCard, confidence: vision.confidence || null };
      const newConf = computeConfidence(opp);
      console.log(`[API] verify-image: confiance recalculée ${opp.confidence || '?'} → ${newConf} (vision=${opp.visionSameCard ? 'OK' : 'NON'})`);
      opp.confidence = newConf;
    } catch (e) {
      console.log(`[API] verify-image: erreur recalcul confiance: ${e.message}`);
    }

    saveOpportunitiesHistory(history);
    broadcastSSE({ type: 'opportunities-update' });

    return res.json({
      success: true,
      match: vision.verdict === 'match',
      accepted: vision.verdict === 'match',
      verdict: vision.verdict,
      reason: vision.reason || '',
      sameProduct: vision.sameProduct,
      sameVariant: vision.sameVariant,
      conditionComparable: vision.conditionComparable,
      report: vision.report || null,
      vision: { ...vision, promoted: wasPromoted }
    });
  } catch (err) {
    console.error(`[API] verify-image erreur: ${err.message}`);
    if (err.isVisionError) {
      // Erreur Vision spécifique (rate limit, timeout) — pas une erreur serveur
      const reason = err.isRateLimit
        ? 'Rate limit OpenAI — attends 1 minute avant de réessayer'
        : `Vision temporairement indisponible: ${err.message}`;
      return res.json({ success: true, skipped: true, reason });
    }
    return res.status(500).json({ error: err.message });
  }
});

// ─── API: Batch Vision — traite toutes les candidates en séquentiel ────────────
let _batchVisionRunning = false;
let _batchVisionProgress = null;

app.post('/api/batch-vision', async (req, res) => {
  if (_batchVisionRunning) {
    return res.json({ success: false, error: 'Batch Vision déjà en cours', progress: _batchVisionProgress });
  }
  _batchVisionRunning = true;
  _batchVisionProgress = { started: new Date().toISOString(), processed: 0, total: 0, matched: 0, rejected: 0, errors: 0 };

  // Réponse immédiate — le traitement continue en arrière-plan
  res.json({ success: true, message: 'Batch Vision lancé en arrière-plan', progress: _batchVisionProgress });

  try {
    const { compareCardImages } = require('./vision-verify');
    const history = getOpportunitiesHistory();

    // Toutes les candidates avec images dispo
    const candidates = history.filter((h) =>
      (h.status === 'candidate' || (h.status === 'active' && !h.visionVerified && !h.visionSameCard)) &&
      (h.imageUrl || (h.photos && h.photos[0])) &&
      (h.ebayMatchImageUrl || h.matchImage || h.ebayImage)
    );

    _batchVisionProgress.total = candidates.length;
    console.log(`[batch-vision] Lancement: ${candidates.length} candidates à vérifier...`);

    for (const opp of candidates) {
      _batchVisionProgress.processed++;
      const vintedImg = (opp.photos && opp.photos[0]) || opp.imageUrl || null;
      const ebayImg = opp.ebayMatchImageUrl || opp.matchImage || opp.ebayImage || null;

      if (!vintedImg || !ebayImg) {
        console.log(`[batch-vision] ⏭ Skip (images manquantes): "${(opp.title || '').slice(0, 50)}"`);
        continue;
      }

      try {
        // Délai de 3 secondes entre chaque appel pour respecter le TPM
        await new Promise(r => setTimeout(r, 3000));

        console.log(`[batch-vision] [${_batchVisionProgress.processed}/${_batchVisionProgress.total}] "${(opp.title || '').slice(0, 50)}"...`);
        const vision = await compareCardImages(vintedImg, ebayImg);

        if (!vision) {
          _batchVisionProgress.errors++;
          continue;
        }

        // Sauvegarder le rapport GPT
        opp.gptReport = {
          checkedAt: new Date().toISOString(),
          verdict: vision.verdict,
          reason: vision.reason || '',
          sameProduct: vision.sameProduct,
          sameVariant: vision.sameVariant,
          conditionComparable: vision.conditionComparable,
          report: vision.report || null
        };
        opp.visionVerified = true;
        opp.visionSameCard = vision.sameCard;
        opp.visionResult = { sameCard: vision.sameCard, sameProduct: vision.sameProduct, confidence: vision.confidence || null };

        if (vision.sameCard === true) {
          opp.status = 'active';
          _batchVisionProgress.matched++;
          console.log(`[batch-vision] ✅ Match: "${(opp.title || '').slice(0, 50)}"`);
        } else if (vision.sameCard === 'uncertain') {
          opp.status = 'candidate';
          _batchVisionProgress.matched++; // Count as potential match (needs manual review)
          console.log(`[batch-vision] 🔶 Incertain: "${(opp.title || '').slice(0, 50)}" — ${vision.reason || ''} (reste candidate)`);
        } else {
          opp.status = 'rejected';
          opp.rejectedAt = new Date().toISOString();
          opp.rejectReason = 'gpt-vision-mismatch';
          opp.gptVerdict = vision.reason || 'Produits différents';
          _batchVisionProgress.rejected++;
          console.log(`[batch-vision] ❌ Rejet: "${(opp.title || '').slice(0, 50)}" — ${vision.reason || ''}`);
        }

        // Recalculer le score de confiance avec le résultat Vision
        try {
          const { computeConfidence } = require('./scoring');
          const oldConf = opp.confidence || 0;
          opp.confidence = computeConfidence(opp);
          console.log(`[batch-vision] Confiance recalculée: ${oldConf} → ${opp.confidence}`);
        } catch (e) { /* non-bloquant */ }

        // Sauvegarder après chaque traitement (pour ne pas perdre en cas de crash)
        saveOpportunitiesHistory(history);
      } catch (err) {
        _batchVisionProgress.errors++;
        console.log(`[batch-vision] ⚠ Erreur: "${(opp.title || '').slice(0, 40)}": ${err.message}`);
        // Si rate limit, attendre 60 secondes avant de continuer
        if (err.isRateLimit) {
          console.log('[batch-vision] Rate limit — pause 60s...');
          await new Promise(r => setTimeout(r, 60000));
        }
      }
    }

    broadcastSSE({ type: 'opportunities-update' });
    _batchVisionProgress.finished = new Date().toISOString();
    console.log(`[batch-vision] Terminé: ${_batchVisionProgress.matched} match, ${_batchVisionProgress.rejected} rejet, ${_batchVisionProgress.errors} erreur(s)`);
  } catch (err) {
    console.error(`[batch-vision] Erreur globale: ${err.message}`);
    _batchVisionProgress.error = err.message;
  } finally {
    _batchVisionRunning = false;
  }
});

app.get('/api/batch-vision-status', (_req, res) => {
  res.json({ running: _batchVisionRunning, progress: _batchVisionProgress });
});

// ─── API: Nettoyage quotidien — vérifie si les annonces actives sont encore en ligne ──
const { checkVintedAvailability } = require('./agents/supervisor');

let _cleanupRunning = false;
let _lastCleanupResult = null;

app.post('/api/cleanup-expired', async (req, res) => {
  if (_cleanupRunning) {
    return res.json({ success: false, error: 'Nettoyage déjà en cours', lastResult: _lastCleanupResult });
  }
  _cleanupRunning = true;

  try {
    const history = getOpportunitiesHistory();
    // Seulement les annonces actives validées par Vision
    const activeOpps = history.filter((h) =>
      (h.status === 'active' || h.status === 'candidate') &&
      h.url && h.url.includes('vinted')
    );

    console.log(`[cleanup] Vérification de ${activeOpps.length} annonces actives sur Vinted...`);
    let expired = 0;
    let stillOnline = 0;
    let errors = 0;
    const details = [];

    for (const opp of activeOpps) {
      try {
        // Délai entre les requêtes pour ne pas se faire bloquer par Vinted
        await new Promise(r => setTimeout(r, 1500));
        const result = await checkVintedAvailability(opp.url, config);

        if (!result.available) {
          opp.status = 'expired';
          opp.expiredAt = new Date().toISOString();
          opp.expireReason = 'vinted-listing-gone';
          expired++;
          details.push({ title: (opp.title || '').slice(0, 50), url: opp.url, result: 'expired' });
          console.log(`[cleanup] ❌ Expirée: "${(opp.title || '').slice(0, 50)}"`);
        } else {
          stillOnline++;
          // Mettre à jour le prix si changé
          if (result.currentPrice && opp.vintedPrice && result.currentPrice !== opp.vintedPrice) {
            console.log(`[cleanup] 💰 Prix changé: "${(opp.title || '').slice(0, 50)}" ${opp.vintedPrice}€ → ${result.currentPrice}€`);
            opp.vintedPrice = result.currentPrice;
          }
        }
      } catch (err) {
        errors++;
        console.log(`[cleanup] ⚠ Erreur: "${(opp.title || '').slice(0, 40)}": ${err.message}`);
      }
    }

    saveOpportunitiesHistory(history);
    if (expired > 0) broadcastSSE({ type: 'opportunities-update' });

    _lastCleanupResult = {
      timestamp: new Date().toISOString(),
      checked: activeOpps.length,
      expired,
      stillOnline,
      errors,
      details: details.slice(0, 20)
    };

    console.log(`[cleanup] Terminé: ${expired} expirée(s), ${stillOnline} en ligne, ${errors} erreur(s)`);
    res.json({ success: true, ..._lastCleanupResult });
  } catch (err) {
    console.error(`[cleanup] Erreur globale: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    _cleanupRunning = false;
  }
});

app.get('/api/cleanup-status', (_req, res) => {
  res.json({ running: _cleanupRunning, lastResult: _lastCleanupResult });
});

// ─── Nettoyage automatique quotidien à 8h UTC ──────────────────────────
let _lastAutoCleanupDate = null;

function scheduleAutoCleanup() {
  setInterval(async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const hour = now.getUTCHours();

    // Exécuter une fois par jour à 8h UTC (10h heure belge)
    if (hour === 8 && _lastAutoCleanupDate !== today && !_cleanupRunning) {
      _lastAutoCleanupDate = today;
      console.log(`[cleanup-auto] Lancement nettoyage quotidien (${today})...`);

      try {
        const history = getOpportunitiesHistory();
        const activeOpps = history.filter((h) =>
          (h.status === 'active' || h.status === 'candidate') &&
          h.url && h.url.includes('vinted')
        );

        let expired = 0;
        for (const opp of activeOpps) {
          try {
            await new Promise(r => setTimeout(r, 1500));
            const result = await checkVintedAvailability(opp.url, config);
            if (!result.available) {
              opp.status = 'expired';
              opp.expiredAt = new Date().toISOString();
              opp.expireReason = 'vinted-listing-gone';
              expired++;
              console.log(`[cleanup-auto] ❌ Expirée: "${(opp.title || '').slice(0, 50)}"`);
            } else if (result.currentPrice && opp.vintedPrice && result.currentPrice !== opp.vintedPrice) {
              opp.vintedPrice = result.currentPrice;
            }
          } catch { /* continue */ }
        }

        saveOpportunitiesHistory(history);
        if (expired > 0) broadcastSSE({ type: 'opportunities-update' });

        _lastCleanupResult = {
          timestamp: new Date().toISOString(),
          checked: activeOpps.length,
          expired,
          stillOnline: activeOpps.length - expired,
          auto: true
        };
        console.log(`[cleanup-auto] Terminé: ${expired}/${activeOpps.length} expirée(s)`);
      } catch (err) {
        console.error(`[cleanup-auto] Erreur: ${err.message}`);
      }
    }
  }, 5 * 60 * 1000); // Vérifier toutes les 5 minutes si c'est l'heure
}

// Lancer le scheduler au démarrage du serveur
scheduleAutoCleanup();

// ─── API: Portfolio ───────────────────────────────────────────────────
const portfolio = require('./portfolio');
const { rebuildRules, invalidateRulesCache } = require('./feedback-learner');

app.get('/api/portfolio', (_req, res) => {
  res.json(portfolio.loadPortfolio());
});

app.get('/api/portfolio/stats', (_req, res) => {
  res.json(portfolio.getPortfolioStats());
});

app.post('/api/portfolio/add', (req, res) => {
  const { vintedId } = req.body;
  if (!vintedId) {
    return res.status(400).json({ error: 'vintedId requis' });
  }

  // Look up opportunity from history
  const history = getOpportunitiesHistory();
  const opp = history.find((h) => h.id === vintedId || h.url?.includes(vintedId));
  if (!opp) {
    return res.status(404).json({ error: 'Opportunité non trouvée dans l\'historique' });
  }

  const entry = portfolio.addToPortfolio({
    id: opp.id,
    title: opp.title,
    search: opp.search,
    vintedPrice: opp.vintedPrice,
    estimatedSalePrice: opp.estimatedSalePrice,
    url: opp.url
  });

  // Mark opportunity as bought — remove from Active tab and estimated profit
  opp.status = 'bought';
  opp.boughtAt = new Date().toISOString();
  saveOpportunitiesHistory(history);

  broadcastSSE({ type: 'portfolio-update' });
  broadcastSSE({ type: 'opportunities-update' });
  res.json({ success: true, entry });
});

app.post('/api/portfolio/sold', (req, res) => {
  const { id, soldPrice } = req.body;
  if (!id || soldPrice == null) {
    return res.status(400).json({ error: 'id et soldPrice requis' });
  }

  const item = portfolio.markAsSold(id, Number(soldPrice));
  if (!item) {
    return res.status(404).json({ error: 'Item non trouvé dans le portfolio' });
  }

  broadcastSSE({ type: 'portfolio-update' });
  res.json({ success: true, item });
});

app.post('/api/portfolio/update-prices', async (_req, res) => {
  const updated = portfolio.updateMarketPrices();
  res.json({ success: true, updatedCount: updated.length });
});

// ─── API: Orchestrateur V10 ───────────────────────────────────────────
app.get('/api/orchestrator-status', (req, res) => {
  const outputDir = config.outputDir;

  function safeRead(file) {
    const p = path.join(outputDir, file);
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* ignore */ }
    return null;
  }

  const scannerHealth   = safeRead('scanner-health.json');
  const evaluatorHealth = safeRead('evaluator-health.json');
  const rawDecisions    = safeRead('orchestrator-decisions.json') || [];
  const now             = new Date();

  const activeDecisions = rawDecisions.filter(d =>
    d.active && (!d.expiresAt || new Date(d.expiresAt) > now)
  );
  const recentDecisions = rawDecisions
    .slice()
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .slice(0, 10);

  res.json({
    scannerHealth,
    evaluatorHealth,
    activeDecisions,
    recentDecisions
  });
});

// ─── API: Budget Vision ───────────────────────────────────────────────
app.get('/api/vision-budget', (req, res) => {
  const outputDir = config.outputDir;
  const filePath  = path.join(outputDir, 'vision-budget.json');
  const dailyBudgetCents = config.visionDailyBudgetCents || 100;

  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      if (data.date === today) {
        return res.json({ ...data, dailyBudgetCents });
      }
    }
  } catch { /* ignore */ }

  // Reset ou fichier absent
  res.json({ date: new Date().toISOString().slice(0, 10), callsToday: 0, estimatedCostCents: 0, dailyBudgetCents });
});

// ─── Export + Start ──────────────────────────────────────────────────
module.exports = { broadcastSSE, appendScanHistory, appendOpportunitiesToHistory };

// Le dashboard est deja lance automatiquement par index.js (bot-scanner)
// via require('./server'). Pour eviter un double listen en PM2,
// on ne lance le serveur que si on est le module principal (standalone)
// ou si le bot-scanner nous require (comportement existant).
if (DASHBOARD_ENABLED) {
  app.listen(PORT, () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
  });
} else {
  console.log('Dashboard desactive (DASHBOARD_ENABLED=false)');
}
