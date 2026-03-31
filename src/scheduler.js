/**
 * Scheduler — Orchestrateur de cycles autonomes pour les agents.
 *
 * Ce process tourne en permanence (PM2) et declenche les agents
 * selon un planning configurable via .env :
 *
 *   - Agent Diagnostic   : toutes les 6h   (sante des niches)
 *   - Agent Discovery    : toutes les 12h  (nouvelles niches TCG)
 *   - Agent Explorateur  : toutes les 24h  (autres categories)
 *   - Agent Strategiste  : rapport hebdo    (dimanche 20h)
 *   - Nettoyage cache    : toutes les 24h  (purge pages bloquees)
 *
 * Le scan principal (toutes les 15 min) est gere par bot-scanner (index.js).
 *
 * Usage : node src/scheduler.js
 *         pm2 start ecosystem.config.js
 */

require('dns').setDefaultResultOrder('ipv4first');

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sendTelegramMessage } = require('./notifier');

// ─── Configuration via .env ──────────────────────────────────────────

const SCHEDULER_ENABLED = process.env.SCHEDULER_ENABLED !== 'false';
const DIAGNOSTIC_INTERVAL_HOURS = Number(process.env.DIAGNOSTIC_INTERVAL_HOURS) || 6;
const DISCOVERY_INTERVAL_HOURS = Number(process.env.DISCOVERY_INTERVAL_HOURS) || 12;
const EXPLORER_INTERVAL_HOURS = Number(process.env.EXPLORER_INTERVAL_HOURS) || 24;
const STRATEGY_DAY = Number(process.env.STRATEGY_DAY) || 0; // 0 = dimanche
const STRATEGY_HOUR = Number(process.env.STRATEGY_HOUR) || 20; // 20h
const CACHE_CLEANUP_INTERVAL_HOURS = Number(process.env.CACHE_CLEANUP_INTERVAL_HOURS) || 24;
const INIT_ON_START = process.env.SCHEDULER_INIT_ON_START !== 'false';

// Convertir heures en ms
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// ─── Logger ──────────────────────────────────────────────────────────

const LOG_DIR = path.join(config.outputDir);
const LOG_FILE = path.join(LOG_DIR, 'scheduler.log');

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch { /* ignore */ }
}

function log(level, agent, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] [${agent}] ${message}`;
  console.log(line);

  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* ignore */ }
}

// ─── Etat du scheduler ──────────────────────────────────────────────

const state = {
  startedAt: null,
  cycles: {
    diagnostic: { lastRun: null, nextRun: null, runCount: 0, lastStatus: null, lastDurationMs: null },
    discovery: { lastRun: null, nextRun: null, runCount: 0, lastStatus: null, lastDurationMs: null },
    explorer: { lastRun: null, nextRun: null, runCount: 0, lastStatus: null, lastDurationMs: null },
    strategist: { lastRun: null, nextRun: null, runCount: 0, lastStatus: null, lastDurationMs: null },
    cacheCleanup: { lastRun: null, nextRun: null, runCount: 0, lastStatus: null, lastDurationMs: null }
  }
};

function saveState() {
  try {
    const statePath = path.join(config.outputDir, 'scheduler-state.json');
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch { /* ignore */ }
}

// ─── Execution securisee d'un agent ─────────────────────────────────

async function runAgent(agentName, fn) {
  const cycle = state.cycles[agentName];
  const startTime = Date.now();

  log('INFO', agentName, 'Demarrage...');
  cycle.lastRun = new Date().toISOString();
  cycle.runCount += 1;

  try {
    await fn();
    const durationMs = Date.now() - startTime;
    cycle.lastStatus = 'success';
    cycle.lastDurationMs = durationMs;
    log('INFO', agentName, `Termine en ${(durationMs / 1000).toFixed(1)}s`);
  } catch (error) {
    const durationMs = Date.now() - startTime;
    cycle.lastStatus = 'error';
    cycle.lastDurationMs = durationMs;
    log('ERROR', agentName, `Erreur: ${error.message}`);
    log('ERROR', agentName, error.stack || '');
  }

  saveState();
}

// ─── Agents individuels ─────────────────────────────────────────────

async function runDiagnostic() {
  const { diagnose } = require('./agents/diagnostic');
  await diagnose(config, {
    deepDiagnose: true,
    checkPlatforms: true,
    sendTelegram: true
  });
}

async function runDiscovery() {
  // DISABLED 2026-03-22: Discovery Telegram spam — failsafe return.
  return;
  const { discover } = require('./agents/discovery');
  await discover(config);

  // Envoyer un resume Telegram
  try {
    const resultPath = path.join(config.outputDir, 'agents', 'discovery-latest.json');
    if (fs.existsSync(resultPath)) {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      const highPrio = (result.suggestions || []).filter((s) => s.priority === 'high');
      if (highPrio.length > 0) {
        const msg = [
          '--- DISCOVERY (cycle auto) ---',
          `${highPrio.length} suggestion(s) haute priorite:`,
          ...highPrio.slice(0, 3).map((s) => `> ${s.reason}`),
          '',
          `Prochain cycle dans ${DISCOVERY_INTERVAL_HOURS}h`
        ].join('\n');
        await sendTelegramMessage(config.telegram, msg);
      }
    }
  } catch (error) {
    log('WARN', 'discovery', `Notification Telegram echouee: ${error.message}`);
  }
}

async function runExplorer() {
  const { explore } = require('./agents/product-explorer');
  await explore(config, {
    topN: 5,
    fetchTrendsEnabled: true,
    sendTelegram: true
  });
}

async function runStrategist() {
  const { strategize, getPortfolioData } = require('./agents/strategist');

  // Charger le dernier scan pour avoir les opportunites
  const scanPath = path.join(config.outputDir, 'latest-scan.json');
  let opportunities = [];
  try {
    const scanData = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
    opportunities = scanData.opportunities || [];
  } catch {
    log('WARN', 'strategist', 'Pas de scan existant, evaluation a vide.');
  }

  await strategize(opportunities, { sendTelegram: true });

  // Rapport hebdo special
  try {
    const portfolio = getPortfolioData();
    const msg = [
      '=== RAPPORT HEBDO STRATEGIST ===',
      `Portefeuille: ${portfolio.totalPortfolioValue} EUR`,
      `Capital disponible: ${portfolio.availableBalance} EUR`,
      `ROI global: ${portfolio.globalROI}%`,
      `Palier: ${portfolio.tier.id} - ${portfolio.tier.name}`,
      '',
      `A acheter: ${(await loadLatestStrategyResult()).acheter || 0}`,
      `Prochain rapport: dimanche ${STRATEGY_HOUR}h`
    ].join('\n');
    await sendTelegramMessage(config.telegram, msg);
  } catch (error) {
    log('WARN', 'strategist', `Rapport hebdo notification echouee: ${error.message}`);
  }
}

async function loadLatestStrategyResult() {
  try {
    const resultPath = path.join(config.outputDir, 'agents', 'strategist-latest.json');
    if (fs.existsSync(resultPath)) {
      const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      return data.summary || {};
    }
  } catch { /* ignore */ }
  return {};
}

async function runCacheCleanup() {
  const { purgeBlockedCache } = require('./http');

  const cacheDir = path.join(config.outputDir, 'http-cache');
  if (!fs.existsSync(cacheDir)) {
    log('INFO', 'cacheCleanup', 'Pas de dossier cache, skip.');
    return;
  }

  // Nettoyer chaque sous-dossier de cache
  const subdirs = fs.readdirSync(cacheDir);
  let totalPurged = 0;

  for (const subdir of subdirs) {
    const subdirPath = path.join(cacheDir, subdir);
    try {
      const stat = fs.statSync(subdirPath);
      if (stat.isDirectory()) {
        const purged = await purgeBlockedCache(subdirPath);
        totalPurged += purged || 0;
      }
    } catch { /* ignore */ }
  }

  log('INFO', 'cacheCleanup', `${totalPurged} fichier(s) cache purge(s).`);
}

// ─── Notification Telegram de synthese ──────────────────────────────

async function sendCycleSummary(agentName) {
  if (!config.telegram.token || !config.telegram.chatId) return;

  const cycle = state.cycles[agentName];
  const status = cycle.lastStatus === 'success' ? 'OK' : 'ERREUR';
  const duration = cycle.lastDurationMs ? `${(cycle.lastDurationMs / 1000).toFixed(1)}s` : '?';

  // Ne pas envoyer de Telegram pour chaque cycle individuel
  // (les agents envoient deja leurs propres notifications)
  // On log juste l'etat
  log('INFO', 'scheduler', `[${agentName}] ${status} en ${duration} (cycle #${cycle.runCount})`);
}

// ─── Planning du strategiste (dimanche 20h) ─────────────────────────

function msUntilNextStrategyRun() {
  const now = new Date();
  const target = new Date(now);

  // Trouver le prochain jour cible
  target.setHours(STRATEGY_HOUR, 0, 0, 0);

  // Avancer au bon jour de la semaine
  const currentDay = now.getDay();
  let daysUntil = STRATEGY_DAY - currentDay;
  if (daysUntil < 0 || (daysUntil === 0 && now >= target)) {
    daysUntil += 7;
  }
  target.setDate(target.getDate() + daysUntil);

  return target.getTime() - now.getTime();
}

// ─── Boucle principale ──────────────────────────────────────────────

const intervals = [];

function scheduleInterval(agentName, fn, intervalMs) {
  const cycle = state.cycles[agentName];
  cycle.nextRun = new Date(Date.now() + intervalMs).toISOString();

  const handle = setInterval(async () => {
    await runAgent(agentName, fn);
    await sendCycleSummary(agentName);
    cycle.nextRun = new Date(Date.now() + intervalMs).toISOString();
    saveState();
  }, intervalMs);

  intervals.push(handle);
  log('INFO', 'scheduler', `${agentName} programme toutes les ${intervalMs / HOUR_MS}h`);
}

function scheduleStrategyWeekly() {
  const delay = msUntilNextStrategyRun();
  const nextRun = new Date(Date.now() + delay);
  state.cycles.strategist.nextRun = nextRun.toISOString();

  log('INFO', 'scheduler', `strategist programme pour ${nextRun.toLocaleString('fr-FR')} (dans ${(delay / HOUR_MS).toFixed(1)}h)`);

  const handle = setTimeout(async function runAndReschedule() {
    await runAgent('strategist', runStrategist);
    await sendCycleSummary('strategist');

    // Re-programmer pour la semaine suivante
    const nextDelay = msUntilNextStrategyRun();
    state.cycles.strategist.nextRun = new Date(Date.now() + nextDelay).toISOString();
    saveState();

    const nextHandle = setTimeout(runAndReschedule, nextDelay);
    intervals.push(nextHandle);
  }, delay);

  intervals.push(handle);
}

async function runInitialScan() {
  log('INFO', 'scheduler', '=== INITIALISATION : scan complet de tous les agents ===');

  const agents = [
    { name: 'diagnostic', fn: runDiagnostic },
    // DISABLED 2026-03-22: Discovery spams Telegram every restart — killed completely
    // { name: 'discovery', fn: runDiscovery },
    { name: 'explorer', fn: runExplorer },
    { name: 'cacheCleanup', fn: runCacheCleanup }
  ];

  for (const agent of agents) {
    await runAgent(agent.name, agent.fn);
    await sendCycleSummary(agent.name);
    // Petite pause entre les agents pour ne pas surcharger
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  // Strategist aussi a l'init
  await runAgent('strategist', runStrategist);
  await sendCycleSummary('strategist');

  log('INFO', 'scheduler', '=== INITIALISATION TERMINEE ===');

  // Notification Telegram de demarrage
  try {
    const statusLines = Object.entries(state.cycles).map(([name, cycle]) => {
      const status = cycle.lastStatus === 'success' ? 'OK' : (cycle.lastStatus || 'N/A');
      return `  ${name}: ${status}`;
    });

    const msg = [
      '=== SCHEDULER DEMARRE ===',
      `Heure: ${new Date().toLocaleString('fr-FR')}`,
      '',
      'Etat initial:',
      ...statusLines,
      '',
      'Planning:',
      `  Diagnostic: toutes les ${DIAGNOSTIC_INTERVAL_HOURS}h`,
      `  Discovery: toutes les ${DISCOVERY_INTERVAL_HOURS}h`,
      `  Explorateur: toutes les ${EXPLORER_INTERVAL_HOURS}h`,
      `  Strategiste: dimanche ${STRATEGY_HOUR}h`,
      `  Cache cleanup: toutes les ${CACHE_CLEANUP_INTERVAL_HOURS}h`
    ].join('\n');

    await sendTelegramMessage(config.telegram, msg);
  } catch (error) {
    log('WARN', 'scheduler', `Notification de demarrage echouee: ${error.message}`);
  }
}

async function main() {
  if (!SCHEDULER_ENABLED) {
    log('INFO', 'scheduler', 'Scheduler desactive (SCHEDULER_ENABLED=false). Arret.');
    return;
  }

  ensureLogDir();

  state.startedAt = new Date().toISOString();
  log('INFO', 'scheduler', '========================================');
  log('INFO', 'scheduler', '  SCHEDULER AUTONOME — Demarrage');
  log('INFO', 'scheduler', '========================================');
  log('INFO', 'scheduler', `  Diagnostic:    toutes les ${DIAGNOSTIC_INTERVAL_HOURS}h`);
  log('INFO', 'scheduler', `  Discovery:     toutes les ${DISCOVERY_INTERVAL_HOURS}h`);
  log('INFO', 'scheduler', `  Explorateur:   toutes les ${EXPLORER_INTERVAL_HOURS}h`);
  log('INFO', 'scheduler', `  Strategiste:   dimanche ${STRATEGY_HOUR}h`);
  log('INFO', 'scheduler', `  Cache cleanup: toutes les ${CACHE_CLEANUP_INTERVAL_HOURS}h`);
  log('INFO', 'scheduler', `  Init au start: ${INIT_ON_START ? 'OUI' : 'NON'}`);
  log('INFO', 'scheduler', '========================================');

  // Scan complet initial (tous les agents une fois)
  if (INIT_ON_START) {
    await runInitialScan();
  }

  // Programmer les intervalles recurrents
  scheduleInterval('diagnostic', runDiagnostic, DIAGNOSTIC_INTERVAL_HOURS * HOUR_MS);
  // DISABLED 2026-03-22: Discovery spams Telegram every restart — killed completely
  // scheduleInterval('discovery', runDiscovery, DISCOVERY_INTERVAL_HOURS * HOUR_MS);
  scheduleInterval('explorer', runExplorer, EXPLORER_INTERVAL_HOURS * HOUR_MS);
  scheduleInterval('cacheCleanup', runCacheCleanup, CACHE_CLEANUP_INTERVAL_HOURS * HOUR_MS);

  // Strategiste hebdo (dimanche 20h)
  scheduleStrategyWeekly();

  saveState();

  log('INFO', 'scheduler', 'Tous les cycles sont programmes. En attente...');

  // Garder le process vivant
  // PM2 gerera le restart si besoin
}

// ─── Cleanup propre ─────────────────────────────────────────────────

function shutdown(signal) {
  log('INFO', 'scheduler', `Signal ${signal} recu. Arret propre...`);
  for (const handle of intervals) {
    clearInterval(handle);
    clearTimeout(handle);
  }
  saveState();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  log('ERROR', 'scheduler', `Exception non capturee: ${error.message}`);
  log('ERROR', 'scheduler', error.stack || '');
  // Ne pas crasher — PM2 redemarrera si necessaire
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', 'scheduler', `Promise rejetee non geree: ${reason}`);
  // Ne pas crasher
});

// ─── Lancement ──────────────────────────────────────────────────────

main().catch((error) => {
  log('ERROR', 'scheduler', `Erreur fatale: ${error.message}`);
  log('ERROR', 'scheduler', error.stack || '');
  process.exitCode = 1;
});
