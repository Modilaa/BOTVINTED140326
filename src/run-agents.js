/**
 * Script standalone pour lancer les agents Superviseur + Discovery + Diagnostic
 * sur les résultats d'un scan existant.
 *
 * Usage:
 *   node src/run-agents.js                    # Lance superviseur + discovery
 *   node src/run-agents.js --supervisor-only   # Superviseur seul
 *   node src/run-agents.js --discovery-only    # Discovery seul
 *   node src/run-agents.js --diagnostic-only   # Diagnostic seul (santé des niches)
 *   node src/run-agents.js --explore-only      # Product Explorer seul (nouvelles niches)
 *   node src/run-agents.js --strategy-only     # Strategist seul (portefeuille + recommandations)
 *   node src/run-agents.js --liquidity-only    # Liquidité seul (analyse facilité de vente)
 *   node src/run-agents.js --reverify          # Re-vérifier les prix (plus lent)
 *   node src/run-agents.js --no-telegram       # Sans notification Telegram
 *   node src/run-agents.js --min-confidence=50 # Score minimum de confiance
 */

require('dns').setDefaultResultOrder('ipv4first');

const args = process.argv.slice(2);
const isDiagnosticOnly = args.includes('--diagnostic-only');
const isExploreOnly = args.includes('--explore-only');
const isStrategyOnly = args.includes('--strategy-only');
const isLiquidityOnly = args.includes('--liquidity-only');

if (isLiquidityOnly) {
  // Mode Liquidité standalone — analyse la facilité de vente
  const fs = require('fs');
  const path = require('path');
  const configModule = require('./config');
  const { assessLiquidity, buildLiquidityReportMessage } = require('./agents/liquidity');
  const { sendTelegramMessage } = require('./notifier');

  console.log('Configuration agents:');
  console.log('  Mode: LIQUIDITÉ (facilité de vente)');
  console.log(`  Telegram: ${args.includes('--no-telegram') ? 'NON' : 'OUI'}`);
  console.log('');

  // Charger le dernier scan
  const scanPath = path.join(configModule.outputDir, 'latest-scan.json');
  let opportunities = [];
  try {
    const scanData = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
    opportunities = scanData.opportunities || [];
  } catch {
    console.log('[Liquidité] Pas de scan existant.');
  }

  if (opportunities.length === 0) {
    console.log('[Liquidité] Aucune opportunité à analyser.');
    process.exit(0);
  }

  assessLiquidity(opportunities).then(async (result) => {
    console.log('\n--- Résultats Liquidité ---');
    console.log(`  Score moyen: ${result.summary.avgLiquidityScore}/100`);
    console.log(`  Marge ajustée moyenne: ${result.summary.avgAdjustedMargin}%`);
    console.log(`  Haute liquidité: ${result.summary.highLiquidity}`);
    console.log(`  Moyenne: ${result.summary.mediumLiquidity}`);
    console.log(`  Faible: ${result.summary.lowLiquidity}`);

    // Sauvegarder le résultat
    const outPath = path.join(configModule.outputDir, 'agents', 'liquidity-latest.json');
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`\nRésultat sauvegardé: ${outPath}`);

    // Telegram
    if (!args.includes('--no-telegram') && configModule.telegram.token && configModule.telegram.chatId) {
      const message = buildLiquidityReportMessage(result);
      await sendTelegramMessage(configModule.telegram, message);
      console.log('[Liquidité] Rapport envoyé par Telegram.');
    }
  }).catch((error) => {
    console.error(`Erreur fatale: ${error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  });
} else if (isStrategyOnly) {
  // Mode Strategist standalone — evalue les opportunites vs portefeuille
  const fs = require('fs');
  const path = require('path');
  const configModule = require('./config');
  const { strategize, getPortfolioData } = require('./agents/strategist');

  console.log('Configuration agents:');
  console.log('  Mode: STRATEGIST (Portefeuille)');
  console.log(`  Telegram: ${args.includes('--no-telegram') ? 'NON' : 'OUI'}`);
  console.log('');

  // Charger le dernier scan pour avoir les opportunites
  const scanPath = path.join(configModule.outputDir, 'latest-scan.json');
  let opportunities = [];
  try {
    const scanData = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
    opportunities = scanData.opportunities || [];
  } catch {
    console.log('[Strategist] Pas de scan existant, evaluation a vide.');
  }

  // Afficher l'etat du portefeuille
  const portfolioData = getPortfolioData();
  console.log(`Portefeuille: ${portfolioData.totalPortfolioValue} EUR (Palier ${portfolioData.tier.id} - ${portfolioData.tier.name})`);
  console.log(`Capital disponible: ${portfolioData.availableBalance} EUR`);
  console.log(`ROI global: ${portfolioData.globalROI}%`);
  console.log('');

  strategize(opportunities, {
    sendTelegram: !args.includes('--no-telegram')
  }).then((result) => {
    console.log('\n--- Resultats Strategist ---');
    console.log(`  A acheter: ${result.summary.acheter}`);
    console.log(`  Interessant: ${result.summary.interessant}`);
    console.log(`  Prudence: ${result.summary.prudence}`);
    console.log(`  Skip: ${result.summary.skip}`);
  }).catch((error) => {
    console.error(`Erreur fatale: ${error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  });
} else if (isExploreOnly) {
  // Mode Product Explorer standalone — analyse de nouvelles niches
  const config = require('./config');
  const { explore } = require('./agents/product-explorer');

  console.log('Configuration agents:');
  console.log('  Mode: PRODUCT EXPLORER');
  console.log(`  Telegram: ${args.includes('--no-telegram') ? 'NON' : 'OUI'}`);
  console.log('');

  explore(config, {
    topN: 5,
    fetchTrendsEnabled: !args.includes('--no-trends'),
    sendTelegram: !args.includes('--no-telegram')
  }).catch((error) => {
    console.error(`Erreur fatale: ${error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  });
} else if (isDiagnosticOnly) {
  // Mode diagnostic standalone — pas besoin du scan existant
  const config = require('./config');
  const { diagnose } = require('./agents/diagnostic');

  console.log('Configuration agents:');
  console.log('  Mode: DIAGNOSTIC SEUL');
  console.log(`  Telegram: ${args.includes('--no-telegram') ? 'NON' : 'OUI'}`);
  console.log('');

  diagnose(config, {
    deepDiagnose: true,
    checkPlatforms: true,
    sendTelegram: !args.includes('--no-telegram')
  }).catch((error) => {
    console.error(`Erreur fatale: ${error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  });
} else {
  const { runStandalone } = require('./agents/orchestrator');

  const options = {
    runSupervisor: !args.includes('--discovery-only'),
    runDiscovery: !args.includes('--supervisor-only'),
    runDiagnostic: args.includes('--with-diagnostic'),
    reverifyPrices: args.includes('--reverify'),
    checkAvailability: !args.includes('--skip-availability'),
    sendTelegram: !args.includes('--no-telegram'),
    minConfidence: 30
  };

  // Parse --min-confidence=XX
  const confFlag = args.find((a) => a.startsWith('--min-confidence='));
  if (confFlag) {
    options.minConfidence = Number(confFlag.split('=')[1]) || 30;
  }

  console.log('Configuration agents:');
  console.log(`  Superviseur: ${options.runSupervisor ? 'OUI' : 'NON'}`);
  console.log(`  Discovery:   ${options.runDiscovery ? 'OUI' : 'NON'}`);
  console.log(`  Diagnostic:  ${options.runDiagnostic ? 'OUI' : 'NON'}`);
  console.log(`  Re-vérif:    ${options.reverifyPrices ? 'OUI' : 'NON'}`);
  console.log(`  Telegram:    ${options.sendTelegram ? 'OUI' : 'NON'}`);
  console.log(`  Confiance min: ${options.minConfidence}/100`);
  console.log('');

  runStandalone(options).catch((error) => {
    console.error(`Erreur fatale: ${error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  });
}
