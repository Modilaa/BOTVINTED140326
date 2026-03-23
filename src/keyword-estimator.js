/**
 * Keyword Estimator — Fallback de dernier recours quand eBay ne retourne rien.
 *
 * Adapté du script Python scanner.py (SCRAP/).
 * Estime le prix marché en appliquant des multiplicateurs par mots-clés
 * sur le prix de vente Vinted. Retourne un résultat au format price-router
 * avec confidence='low' et isKeywordEstimate=true.
 *
 * Utilisation : uniquement quand toutes les APIs ont échoué.
 * Le count=0 dans matchedSales signale que c'est une estimation, pas une vraie vente.
 */

const KEYWORD_CATEGORIES = {
  grading: {
    'psa 10': 2.0, 'bgs 10': 2.0, 'bgs 9.5': 2.0,
    'psa 9': 1.8,  'bgs 9': 1.6,  'cgc 10': 2.0,
  },
  rarity: {
    'first edition': 1.5, '1st edition': 1.5, '1ere edition': 1.5,
    'numbered': 1.3,
    '/10': 2.0, '/25': 1.8, '/50': 1.5, '/99': 1.3,
    'promo': 1.2,
  },
  character: {
    'charizard': 1.5, 'dracaufeu': 1.5,
    'pikachu': 1.4,
    'messi': 1.5,   'ronaldo': 1.5,
    'mbappe': 1.4,  'mbappé': 1.4,
    'verstappen': 1.4, 'hamilton': 1.3,
  },
  type: {
    'autograph': 1.5, 'auto': 1.4, 'dedicace': 1.4,
    'holo': 1.4,  'shiny': 1.3,
    'gold': 1.4,  'chrome': 1.2,
    'rookie': 1.5,
  },
};

/**
 * Estime le prix marché par mots-clés.
 *
 * @param {string} title       - Titre de l'annonce Vinted
 * @param {number} buyerPrice  - Prix de vente Vinted (base du calcul)
 * @returns {object|null}      - Résultat format price-router, ou null si aucun mot-clé trouvé
 */
/**
 * DISABLED — keyword estimation was producing fake prices that polluted the dashboard.
 * Keywords (rarity multipliers, etc.) are still used in matching.js for title comparison only.
 * This function now only logs for debug and always returns null.
 */
function estimateByKeywords(title, buyerPrice) {
  if (!title || !buyerPrice || buyerPrice <= 0) return null;

  // Normaliser: minuscules + strip accents
  const text = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  let totalMult = 1.0;
  for (const keywords of Object.values(KEYWORD_CATEGORIES)) {
    let best = 1.0;
    for (const [kw, mult] of Object.entries(keywords)) {
      if (text.includes(kw)) {
        best = Math.max(best, mult);
      }
    }
    totalMult *= best;
  }

  if (totalMult > 1.0) {
    const estimated = Math.round(buyerPrice * totalMult * 100) / 100;
    console.log(`    [keyword-estimator DEBUG] ×${totalMult.toFixed(2)} → ${estimated}€ (non utilisé)`);
  }

  return null;
}

module.exports = { estimateByKeywords };
