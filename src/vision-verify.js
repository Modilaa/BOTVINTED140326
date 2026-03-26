'use strict';

const OpenAI = require('openai');
const { checkAndAlert } = require('./api-monitor');

const VISION_PROMPT = `Tu es un expert en ARBITRAGE e-commerce. Ta mission : vérifier si deux annonces concernent LE MÊME PRODUIT EXACT pour valider une opportunité d'achat (Vinted) - revente (eBay).

Image 1 = Annonce Vinted (article à acheter, photo maison aléatoire).
Image 2 = Annonce eBay (référence de prix, photo pro ou maison).

RÈGLE FONDAMENTALE : Compare L'OBJET physique, PAS l'image. Ignore complètement le fond, l'angle, l'éclairage, la mise en scène. Ils seront TOUJOURS différents entre Vinted et eBay — c'est normal.

Vérifie ces 3 critères STRICTEMENT :

1. MÊME PRODUIT EXACT
   - Cartes TCG : même joueur/personnage + même numéro de carte + même set + même année/édition
   - LEGO : même numéro de set exact (ex: 75192 ≠ 75330)
   - Tech : même modèle exact + même capacité/coloris (iPhone 13 ≠ 13 Pro, 128Go ≠ 256Go)
   - Autre : même modèle/édition exact
   → La moindre différence = REJET

2. MÊME VARIANTE
   - Cartes TCG : base ≠ holo ≠ refractor ≠ prizm ≠ gold ≠ rainbow ≠ full art ≠ alt art ≠ prismatic ≠ galaxy
   - LEGO : scellé ≠ ouvert ≠ incomplet
   - Si tu ne peux pas CONFIRMER avec certitude la même variante → REJET

3. CONDITION COMPARABLE
   - Mint/scellé ≠ très endommagé/incomplet = REJET
   - Légère usure, pas de sleeve = acceptable (mark match_condition_diff)

RÈGLES CRITIQUES :
- Le fond sera TOUJOURS différent (Vinted = maison, eBay = studio). JAMAIS une raison de rejeter.
- Lis les textes/numéros visibles sur les objets pour confirmer (numéro de carte, numéro de set LEGO, etc.)
- Si les descriptions sont visibles dans l'image, lis-les pour confirmer l'édition et la variante.
- EN CAS DE DOUTE → REJETER. Mieux vaut manquer une opportunité que valider un faux positif.

verdict = "match" UNIQUEMENT si les 3 critères sont vrais. Sinon "no_match".

Réponds UNIQUEMENT avec du JSON valide, sans markdown, sans texte supplémentaire :
{
  "sameProduct": true or false,
  "sameVariant": true or false,
  "conditionComparable": true or false,
  "verdict": "match" or "no_match",
  "reason": "explication courte en une ligne",
  "report": {
    "vintedObservation": "description de ce qui est visible sur l'image Vinted (condition, variante, marquages)",
    "referenceObservation": "description de ce qui est visible sur l'image eBay (condition, variante, marquages)",
    "differences": ["liste chaque différence détectée"],
    "suggestion": "une suggestion pour améliorer le programme de scan"
  }
}`;

/**
 * Compare two product images using GPT-4o mini Vision.
 * Works for trading cards, LEGO sets, or any other collectible.
 * Returns structured verdict with sameProduct/sameVariant/conditionComparable + detailed report.
 * @param {string} vintedImageUrl - Image URL from Vinted listing
 * @param {string} ebayImageUrl   - Image URL from eBay reference
 * @returns {Promise<object|null>} Parsed JSON result or null on failure
 */
function toHdEbayUrl(url) {
  if (!url) return url;
  return url.replace(/s-l\d+\.(jpg|png|webp)/i, 's-l1600.$1');
}

const VISION_RETRY_DELAYS = [1000, 3000, 8000]; // backoff on 429

async function compareCardImages(vintedImageUrl, ebayImageUrl) {
  if (!vintedImageUrl || !ebayImageUrl) return null;
  ebayImageUrl = toHdEbayUrl(ebayImageUrl);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[vision-verify] OPENAI_API_KEY manquante, vision désactivée');
    return null;
  }

  const client = new OpenAI({ apiKey });

  for (let attempt = 0; attempt <= VISION_RETRY_DELAYS.length; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 800,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              { type: 'image_url', image_url: { url: vintedImageUrl, detail: 'auto' } },
              { type: 'image_url', image_url: { url: ebayImageUrl, detail: 'auto' } }
            ]
          }
        ]
      });

      const text = response.choices[0]?.message?.content || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        console.warn('[vision-verify] Réponse non-JSON:', text.slice(0, 200));
        return null;
      }

      const parsed = JSON.parse(match[0]);

      // Product + variant match = what matters for arbitrage authenticity.
      // Condition differences affect the price estimate but don't disqualify the opportunity.
      // Only reject (confidence=0) if the product or variant is wrong.
      const productVariantMatch = parsed.sameProduct === true && parsed.sameVariant === true;
      const fullMatch = productVariantMatch && parsed.conditionComparable === true;

      parsed.verdict = fullMatch ? 'match' : (productVariantMatch ? 'match_condition_diff' : 'no_match');

      // Compat fields — consumed by scoring.js, index.js, notifier.js, server.js
      // sameCard=true if same product+variant (condition mismatch is not a disqualifier)
      parsed.sameCard = productVariantMatch;
      // 90 = full match, 60 = same product/variant but condition differs, 0 = wrong product/variant
      parsed.confidence = fullMatch ? 90 : (productVariantMatch ? 60 : 0);
      parsed.summary = parsed.reason || '';
      parsed.visionReason = (parsed.report && parsed.report.suggestion) || parsed.reason || '';

      return parsed;
    } catch (err) {
      const is429 = err.status === 429 || (err.message && err.message.includes('429'));
      if (is429 && attempt < VISION_RETRY_DELAYS.length) {
        const delay = VISION_RETRY_DELAYS[attempt];
        console.warn(`[vision-verify] Rate limit 429, retry ${attempt + 1}/${VISION_RETRY_DELAYS.length} dans ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.error('[vision-verify] Erreur API:', err.message);
      checkAndAlert('openai-vision', true, `GPT-4o mini erreur: ${err.message}`);
      return null;
    }
  }
}

module.exports = { compareCardImages };
