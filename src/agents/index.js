/**
 * Point d'entrée du système multi-agents.
 * Exporte tous les agents pour utilisation dans index.js ou en standalone.
 */

const { supervise, computeConfidenceScore, computeDetailedProfit, checkVintedAvailability, extractCardLanguage, analyzeCardLanguage, getLanguageSearchKeyword, LANGUAGE_KEYWORDS, PLATFORM_FEES } = require('./supervisor');
const { discover, analyzeHistoricalPatterns, generateSuggestions, detectPriceTrends, TCG_RELEASE_CALENDAR } = require('./discovery');
const { diagnose, analyzeNicheSuccessRates, computeNicheHealthScore, evaluateAlternativePlatforms, buildDiagnosticTelegramMessage, HEALTH_THRESHOLDS, ALTERNATIVE_PLATFORMS } = require('./diagnostic');
const { runPipeline, runStandalone, buildEnrichedTelegramMessage, saveAgentResult, loadAgentResult } = require('./orchestrator');
const { explore, analyzeAllNiches, generateSearchConfigs, fetchTrends, buildReport, buildExplorerTelegramMessage, NICHE_DATABASE, getInternalTrends } = require('./product-explorer');
const {
  assessLiquidity, analyzeLiquidity, analyzeVolume, analyzeSpeed, analyzeStability,
  computeLiquidityScore, computeAdjustedMargin, computeCapitalLockup,
  classifyLiquidityScore, classifySpeed, buildLiquidityTelegramSnippet,
  buildLiquidityReportMessage, SPEED_TIERS, WEIGHTS: LIQUIDITY_WEIGHTS, LOOKBACK_DAYS
} = require('./liquidity');
const {
  strategize, loadPortfolio, savePortfolio, recordPurchase, recordSale,
  getPortfolioData, getCurrentTier, getTotalPortfolioValue, getAvailableBalance,
  getROI, getWeeklyROI, getProgressToNextTier, evaluateOpportunity,
  evaluateOpportunities, categorizeProduct, generateWeeklyReport,
  sendWeeklyReport, sendTierChangeAlert, sendTopOpportunitiesAlert,
  TIERS, PORTFOLIO_PATH
} = require('./strategist');

module.exports = {
  // Orchestrateur
  runPipeline,
  runStandalone,
  buildEnrichedTelegramMessage,
  saveAgentResult,
  loadAgentResult,

  // Superviseur
  supervise,
  computeConfidenceScore,
  computeDetailedProfit,
  checkVintedAvailability,
  extractCardLanguage,
  analyzeCardLanguage,
  getLanguageSearchKeyword,
  LANGUAGE_KEYWORDS,
  PLATFORM_FEES,

  // Discovery
  discover,
  analyzeHistoricalPatterns,
  generateSuggestions,
  detectPriceTrends,
  TCG_RELEASE_CALENDAR,

  // Diagnostic
  diagnose,
  analyzeNicheSuccessRates,
  computeNicheHealthScore,
  evaluateAlternativePlatforms,
  buildDiagnosticTelegramMessage,
  HEALTH_THRESHOLDS,
  ALTERNATIVE_PLATFORMS,

  // Strategist
  strategize,
  loadPortfolio,
  savePortfolio,
  recordPurchase,
  recordSale,
  getPortfolioData,
  getCurrentTier,
  getTotalPortfolioValue,
  getAvailableBalance,
  getROI,
  getWeeklyROI,
  getProgressToNextTier,
  evaluateOpportunity,
  evaluateOpportunities,
  categorizeProduct,
  generateWeeklyReport,
  sendWeeklyReport,
  sendTierChangeAlert,
  sendTopOpportunitiesAlert,
  TIERS,
  PORTFOLIO_PATH,

  // Product Explorer
  explore,
  analyzeAllNiches,
  generateSearchConfigs,
  fetchTrends,
  buildReport,
  buildExplorerTelegramMessage,
  NICHE_DATABASE,
  getInternalTrends,

  // Liquidité
  assessLiquidity,
  analyzeLiquidity,
  analyzeVolume,
  analyzeSpeed,
  analyzeStability,
  computeLiquidityScore,
  computeAdjustedMargin,
  computeCapitalLockup,
  classifyLiquidityScore,
  classifySpeed,
  buildLiquidityTelegramSnippet,
  buildLiquidityReportMessage,
  SPEED_TIERS,
  LIQUIDITY_WEIGHTS,
  LOOKBACK_DAYS
};
