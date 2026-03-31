'use strict';

const OpenAI = require('openai');
const { checkAndAlert } = require('./api-monitor');

const VISION_PROMPT = `Tu es un expert en ARBITRAGE e-commerce. Ta mission : vérifier si deux annonces concernent LE MÊME PRODUIT EXACT pour valider une opportunité d'achat (Vinted) - revente (eBay).

Image 1 = Annonce Vinted (article à acheter, photo maison aléatoire).
Image 2 = Annonce eBay (référence de prix, photo pro ou maison).

RÈGLE FONDAMENTALE : Compare L'OBJET physique, PAS l'image. Ignore complètement le fond, l'angle, l'éclairage, la mise en scène. Ils seront TOUJOURS différents entre Vinted et eBay — c'est normal.

Vérifie ces 3 critères :

1. MÊME PRODUIT EXACT
   - Cartes TCG : même joueur/personnage + même numéro de carte + même set + même année/édition
   - LEGO : même numéro de set exact (ex: 75192 ≠ 75330)
   - Tech : même modèle exact + même capacité/coloris (iPhone 13 ≠ 13 Pro, 128Go ≠ 256Go)
   - Autre : même modèle/édition exact
   → Si une différence est CLAIRE et CERTAINE = false. Si tu ne peux pas lire ou distinguer = "uncertain"

2. MÊME VARIANTE
   - Cartes TCG : base ≠ holo ≠ refractor ≠ prizm ≠ gold ≠ rainbow ≠ full art ≠ alt art ≠ prismatic ≠ galaxy
   - LEGO : scellé ≠ ouvert ≠ incomplet
   - Si la variante est CLAIREMENT différente = false. Si tu ne peux pas confirmer (qualité image, angle) = "uncertain"

3. CONDITION COMPARABLE
   - Mint/scellé ≠ très endommagé/incomplet = false
   - Légère usure, pas de sleeve = true (acceptable pour l'arbitrage)

RÈGLES CRITIQUES :
- Le fond sera TOUJOURS différent (Vinted = maison, eBay = studio). JAMAIS une raison de rejeter.
- Lis les textes/numéros visibles sur les objets pour confirmer (numéro de carte, numéro de set LEGO, etc.)
- Si les descriptions sont visibles dans l'image, lis-les pour confirmer l'édition et la variante.
- Utilise "uncertain" quand l'image ne permet pas de trancher (flou, angle, qualité). Ne rejette PAS sur un doute d'image.
- Rejette (false) UNIQUEMENT quand tu vois une VRAIE différence (numéro différent, couleur clairement différente, modèle différent).

Les 3 verdicts possibles :
- "match" = les 3 critères sont true. Tu es sûr que c'est le même produit.
- "uncertain" = au moins 1 critère est "uncertain" mais AUCUN n'est false. Pourrait être le même produit.
- "no_match" = au moins 1 critère est CLAIREMENT false. Produit différent confirmé.

Évalue aussi ta CONFIANCE GLOBALE dans le match (0-100) :
- 90-100 : tu es certain que c'est exactement le même produit, même variante, même condition
- 70-89 : très probable, tu vois les mêmes marquages/numéros mais un petit doute subsiste (angle, flou)
- 50-69 : probable mais plusieurs éléments ne sont pas vérifiables sur les images
- 30-49 : possible mais trop de doutes pour confirmer
- 0-29 : peu probable ou clairement différent

Réponds UNIQUEMENT avec du JSON valide, sans markdown, sans texte supplémentaire :
{
  "sameProduct": true or false or "uncertain",
  "sameVariant": true or false or "uncertain",
  "conditionComparable": true or false,
  "confidenceScore": 0-100,
  "verdict": "match" or "uncertain" or "no_match",
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

const VISION_RETRY_DELAYS = [2000, 5000, 12000]; // backoff agressif on 429

// ─── Throttle global : empêche d'envoyer plus d'1 requête toutes les 2s ────
let _lastVisionCall = 0;
const VISION_MIN_INTERVAL_MS = 2000;

async function compareCardImages(vintedImageUrl, ebayImageUrl) {
  if (!vintedImageUrl || !ebayImageUrl) return null;
  ebayImageUrl = toHdEbayUrl(ebayImageUrl);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[vision-verify] OPENAI_API_KEY manquante, vision désactivée');
    return null;
  }

  // Throttle : attendre si le dernier appel est trop récent
  const now = Date.now();
  const elapsed = now - _lastVisionCall;
  if (elapsed < VISION_MIN_INTERVAL_MS) {
    const wait = VISION_MIN_INTERVAL_MS - elapsed;
    console.log(`[vision-verify] Throttle: attente ${wait}ms avant l'appel`);
    await new Promise(r => setTimeout(r, wait));
  }
  _lastVisionCall = Date.now();

  const client = new OpenAI({ apiKey, timeout: 30000 });

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

      // Nettoyer les caractères de contrôle que GPT insère parfois dans les strings JSON
      const cleanJson = match[0].replace(/[\x00-\x1F\x7F]/g, (ch) => {
        if (ch === '\n' || ch === '\r' || ch === '\t') return ' ';
        return '';
      });

      let parsed;
      try {
        parsed = JSON.parse(cleanJson);
      } catch (parseErr) {
        console.warn('[vision-verify] JSON invalide après nettoyage:', cleanJson.slice(0, 300));
        return null;
      }

      // Normalize: GPT can return true, false, or "uncertain" for product/variant
      const productTrue = parsed.sameProduct === true;
      const productFalse = parsed.sameProduct === false;
      const variantTrue = parsed.sameVariant === true;
      const variantFalse = parsed.sameVariant === false;
      const conditionOk = parsed.conditionComparable !== false;

      // Récupérer le confidenceScore granulaire de GPT (0-100), fallback sur ancienne logique
      const gptScore = (typeof parsed.confidenceScore === 'number' && parsed.confidenceScore >= 0 && parsed.confidenceScore <= 100)
        ? parsed.confidenceScore
        : null;

      // Any CLEAR rejection (false) → no_match
      const hasHardReject = productFalse || variantFalse;
      // All confirmed → match
      const allConfirmed = productTrue && variantTrue && conditionOk;
      // Product+variant confirmed but condition issue
      const productVariantMatch = productTrue && variantTrue;

      if (hasHardReject) {
        parsed.verdict = 'no_match';
        parsed.sameCard = false;
        parsed.confidence = 0;
      } else if (allConfirmed) {
        parsed.verdict = 'match';
        parsed.sameCard = true;
        // Utiliser le score GPT granulaire, borné à [60, 100] pour un match confirmé
        parsed.confidence = gptScore !== null ? Math.max(60, Math.min(100, gptScore)) : 90;
      } else if (productVariantMatch && !conditionOk) {
        parsed.verdict = 'match_condition_diff';
        parsed.sameCard = true;
        parsed.confidence = gptScore !== null ? Math.max(40, Math.min(70, gptScore)) : 60;
      } else {
        // At least one "uncertain", no hard reject → uncertain
        parsed.verdict = 'uncertain';
        parsed.sameCard = 'uncertain';
        parsed.confidence = gptScore !== null ? Math.max(20, Math.min(55, gptScore)) : 45;
      }

      parsed.summary = parsed.reason || '';
      parsed.visionReason = (parsed.report && parsed.report.suggestion) || parsed.reason || '';

      return parsed;
    } catch (err) {
      const is429 = err.status === 429 || (err.message && err.message.includes('429'));
      const isTimeout = err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED' || (err.message && err.message.includes('timeout'));
      if ((is429 || isTimeout) && attempt < VISION_RETRY_DELAYS.length) {
        const delay = VISION_RETRY_DELAYS[attempt];
        const reason = is429 ? 'Rate limit 429' : 'Timeout';
        console.warn(`[vision-verify] ${reason}, retry ${attempt + 1}/${VISION_RETRY_DELAYS.length} dans ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        _lastVisionCall = Date.now(); // reset throttle après attente
        continue;
      }
      console.error('[vision-verify] Erreur API:', err.message);
      checkAndAlert('openai-vision', true, `GPT-4o mini erreur: ${err.message}`);
      // Retourner une erreur structurée au lieu de null pour différencier "indisponible" de "pas d'images"
      const error = new Error(is429 ? 'Rate limit OpenAI — réessaye dans 1 minute' : err.message);
      error.isVisionError = true;
      error.isRateLimit = is429;
      throw error;
    }
  }
}

module.exports = { compareCardImages };
