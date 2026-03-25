'use strict';

const OpenAI = require('openai');
const { checkAndAlert } = require('./api-monitor');

const VISION_PROMPT = `You are a strict product authentication expert. Compare these two product images.

Image 1 = Vinted listing (item being sold).
Image 2 = eBay reference (price benchmark).

The items may be trading cards (Pokémon, Yu-Gi-Oh, Topps, sports cards), LEGO sets, or other collectibles.

Your task: verify 3 things STRICTLY:

1. SAME PRODUCT: exact same item — for cards: same player/character, card number, set/year; for LEGO: same set number and name; for other items: same model/edition. Even minor differences (wrong year, wrong set, wrong model) = NOT same product.

2. SAME VARIANT/EDITION: for cards: base ≠ holo ≠ refractor ≠ prizm ≠ gold; for LEGO: sealed ≠ opened ≠ incomplete; for other items: same size/color/edition. If you cannot confirm they are the SAME variant, mark false.

3. COMPARABLE CONDITION: mint/sealed ≠ damaged/opened, significant wear ≠ near-mint. If condition difference affects value significantly, mark false.

verdict = "match" ONLY if ALL THREE are true. Otherwise "no_match".

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "sameProduct": true or false,
  "sameVariant": true or false,
  "conditionComparable": true or false,
  "verdict": "match" or "no_match",
  "reason": "short one-line explanation",
  "report": {
    "vintedObservation": "description of what is visible on the Vinted image (condition, variant, markings)",
    "referenceObservation": "description of what is visible on the eBay image (condition, variant, markings)",
    "differences": ["list each detected difference"],
    "suggestion": "one suggestion to improve the scanning program based on what you observed"
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
              { type: 'image_url', image_url: { url: vintedImageUrl, detail: 'low' } },
              { type: 'image_url', image_url: { url: ebayImageUrl, detail: 'low' } }
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
