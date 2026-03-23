/**
 * Seller Reputation Score — évalue la fiabilité d'un vendeur Vinted (0-100).
 *
 * Données utilisées (issues de l'objet listing ou listing.user) :
 *   feedback_count      — nombre d'avis reçus
 *   feedback_reputation — score 0-1 (1 = 100% positif)
 *   given_item_count    — nombre d'articles vendus
 *
 * Score final = reputation_weight(40%) + feedback_count_weight(30%) + items_sold_weight(30%)
 *
 * Flag "suspect" : score < 20 ET profit > 200% → warning "⚠️ Vendeur suspect"
 */

/**
 * Évalue la réputation d'un vendeur Vinted depuis les données du listing.
 *
 * @param {object} vintedListing - Listing Vinted (peut contenir .user ou champs directs)
 * @returns {{ score, feedbackCount, feedbackReputation, givenItemCount, isSuspect, warning } | null}
 *   null si aucune donnée vendeur disponible
 */
function evaluateSeller(vintedListing) {
  if (!vintedListing) return null;

  // Les données vendeur peuvent être imbriquées dans .user, ou directement sur le listing
  const seller = vintedListing.user || vintedListing.seller || {};

  const feedbackCount      = seller.feedback_count      ?? vintedListing.feedback_count      ?? null;
  const feedbackReputation = seller.feedback_reputation ?? vintedListing.feedback_reputation ?? null;
  const givenItemCount     = seller.given_item_count    ?? vintedListing.given_item_count    ?? seller.items_count ?? null;

  // Si aucune donnée vendeur disponible, on ne peut pas scorer
  if (feedbackCount === null && feedbackReputation === null && givenItemCount === null) {
    return null;
  }

  // ── Composante 1 : feedback_count (0-100) ─────────────────────────────────
  const fc = feedbackCount ?? 0;
  let fcScore;
  if (fc === 0)      fcScore = 10;
  else if (fc <= 5)  fcScore = 30;
  else if (fc <= 20) fcScore = 50;
  else if (fc <= 50) fcScore = 70;
  else               fcScore = 90;

  // ── Composante 2 : feedback_reputation (0-1 → 0-100) ────────────────────
  const rep = feedbackReputation ?? 0.5; // neutre si inconnu
  const repScore = Math.round(rep * 100);

  // ── Composante 3 : given_item_count (0-100) ───────────────────────────────
  const gic = givenItemCount ?? 0;
  let itemScore;
  if (gic === 0)      itemScore = 10;
  else if (gic <= 5)  itemScore = 30;
  else if (gic <= 20) itemScore = 60;
  else                itemScore = 90;

  // ── Score final pondéré ───────────────────────────────────────────────────
  const score = Math.round(repScore * 0.40 + fcScore * 0.30 + itemScore * 0.30);

  const isSuspect = score < 20;

  return {
    score,
    feedbackCount: fc,
    feedbackReputation: feedbackReputation ?? null,
    givenItemCount: gic,
    isSuspect
  };
}

module.exports = { evaluateSeller };
