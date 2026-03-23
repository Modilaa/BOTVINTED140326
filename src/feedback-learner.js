/**
 * Feedback Learner — Apprend des rejets de Justin pour améliorer le matching.
 *
 * Lit output/feedback-reports.json, détecte les patterns dans les opportunités
 * rejetées (validated: false), et construit output/learned-rules.json.
 *
 * applyLearnedRules(vintedTitle, ebayTitle) retourne une pénalité (0 à -50)
 * à soustraire du score de confiance.
 */

const fs = require('fs');
const path = require('path');

const FEEDBACK_PATH = path.join(__dirname, '..', 'output', 'feedback-reports.json');
const RULES_PATH = path.join(__dirname, '..', 'output', 'learned-rules.json');

// ─── Pattern detectors ────────────────────────────────────────────────────────

const PATTERN_DETECTORS = [
  {
    rule: 'graded_raw_mismatch',
    pattern: 'PSA|BGS|CGC|BVG|CSG',
    // Penalize if Vinted listing is graded (high price mismatch risk)
    test: (vintedTitle, _ebayTitle) => /\b(PSA|BGS|CGC|BVG|CSG)\s*\d/i.test(vintedTitle),
    action: 'reject_if_mismatch',
    penalty: -30
  },
  {
    rule: 'lot_mismatch',
    pattern: 'lot|bundle|x2|x3|x4|x5|lot de',
    test: (vintedTitle, _ebayTitle) => /\b(lot|bundle|x[2-9]|x\d{2}|lot de)\b/i.test(vintedTitle),
    action: 'reject',
    penalty: -40
  },
  {
    rule: 'set_complet_mismatch',
    pattern: 'set complet|full set|collection complete|complete set',
    test: (vintedTitle, _ebayTitle) => /\b(set complet|full set|collection complet|complete set)\b/i.test(vintedTitle),
    action: 'reject',
    penalty: -35
  },
  {
    rule: 'variant_gold_mismatch',
    pattern: 'gold|golden|prismatic gold',
    // Penalize if one title has "gold" and the other doesn't
    test: (vintedTitle, ebayTitle) => {
      const vHasGold = /\bgold\b/i.test(vintedTitle);
      const eHasGold = /\bgold\b/i.test(ebayTitle);
      return vHasGold !== eHasGold;
    },
    action: 'penalize_50',
    penalty: -20
  },
  {
    rule: 'variant_rainbow_mismatch',
    pattern: 'rainbow|rainbow rare',
    test: (vintedTitle, ebayTitle) => {
      const vHas = /\brainbow\b/i.test(vintedTitle);
      const eHas = /\brainbow\b/i.test(ebayTitle);
      return vHas !== eHas;
    },
    action: 'penalize_50',
    penalty: -20
  }
];

// ─── Load / Save ──────────────────────────────────────────────────────────────

function loadFeedback() {
  try {
    if (fs.existsSync(FEEDBACK_PATH)) {
      const raw = fs.readFileSync(FEEDBACK_PATH, 'utf8');
      if (raw.trim()) {
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : (data.reports || []);
      }
    }
  } catch { /* ignore */ }
  return [];
}

function saveRules(rules) {
  fs.writeFileSync(RULES_PATH, JSON.stringify(rules, null, 2), 'utf8');
}

function loadRules() {
  try {
    if (fs.existsSync(RULES_PATH)) {
      const raw = fs.readFileSync(RULES_PATH, 'utf8');
      if (raw.trim()) return JSON.parse(raw);
    }
  } catch { /* ignore */ }
  return [];
}

// ─── Build rules from feedback ────────────────────────────────────────────────

/**
 * Scans feedback-reports.json and rebuilds learned-rules.json.
 * Called on startup and after each new feedback.
 * @returns {Array} The rebuilt rules list
 */
function rebuildRules() {
  const reports = loadFeedback();
  const rejected = reports.filter((r) => r.validated === false);

  const ruleCounts = {};

  for (const report of rejected) {
    const vintedTitle = report.title || '';
    const ebayTitle = report.ebayMatchTitle || '';

    for (const detector of PATTERN_DETECTORS) {
      if (detector.test(vintedTitle, ebayTitle)) {
        ruleCounts[detector.rule] = (ruleCounts[detector.rule] || 0) + 1;
      }
    }
  }

  const rules = PATTERN_DETECTORS.map((d) => ({
    rule: d.rule,
    pattern: d.pattern,
    count: ruleCounts[d.rule] || 0,
    action: d.action,
    penalty: d.penalty
  }));

  saveRules(rules);
  return rules;
}

// ─── Apply learned rules ──────────────────────────────────────────────────────

let _cachedRules = null;

function getRules() {
  if (_cachedRules === null) {
    _cachedRules = loadRules();
  }
  return _cachedRules;
}

/**
 * Checks all learned rules against the given titles.
 * Only applies rules that have been triggered at least once by a real rejection.
 *
 * @param {string} vintedTitle - Vinted listing title
 * @param {string} ebayTitle - Best eBay match title
 * @returns {number} Penalty (0 to -50, negative)
 */
function applyLearnedRules(vintedTitle, ebayTitle) {
  const rules = getRules();
  if (!rules || rules.length === 0) return 0;

  let totalPenalty = 0;

  for (const rule of rules) {
    // Only apply rules seen at least once in real rejections
    if ((rule.count || 0) < 1) continue;

    const detector = PATTERN_DETECTORS.find((d) => d.rule === rule.rule);
    if (!detector) continue;

    if (detector.test(vintedTitle || '', ebayTitle || '')) {
      totalPenalty += rule.penalty;
    }
  }

  // Cap total penalty at -50
  return Math.max(-50, totalPenalty);
}

/**
 * Invalidates the in-memory rules cache (call after rebuildRules).
 */
function invalidateRulesCache() {
  _cachedRules = null;
}

// ─── Auto-learn on startup ────────────────────────────────────────────────────
// Rebuild rules when this module is first loaded
try {
  rebuildRules();
} catch { /* non-bloquant */ }

module.exports = { rebuildRules, applyLearnedRules, invalidateRulesCache, loadRules };
