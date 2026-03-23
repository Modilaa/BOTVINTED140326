'use strict';

const OpenAI = require('openai');
const { checkAndAlert } = require('./api-monitor');

const VISION_PROMPT = `You are a strict trading card authentication expert. Compare these two trading card images.

Image 1 = Vinted listing (card being sold).
Image 2 = eBay reference (price benchmark).

Your task: verify 3 things STRICTLY:

1. SAME PRODUCT: exact same player/character, same card number, same set/year. Even minor differences (wrong year, wrong team) = NOT same product.

2. SAME VARIANT/RARITY: base card ≠ holo ≠ refractor ≠ cracked ice ≠ silver ≠ gold ≠ prizm ≠ optic. Different border color or finish = different variant. If you cannot confirm they are the SAME variant, mark false.

3. COMPARABLE CONDITION: mint/PSA ≠ damaged, sealed ≠ opened, bent corners (played) ≠ near-mint. If condition difference affects value significantly, mark false.

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
 * Compare two card images using GPT-4o mini Vision.
 * Returns structured verdict with sameProduct/sameVariant/conditionComparable + detailed report.
 * @param {string} vintedImageUrl - Image URL from Vinted listing
 * @param {string} ebayImageUrl   - Image URL from eBay reference
 * @returns {Promise<object|null>} Parsed JSON result or null on failure
 */
async function compareCardImages(vintedImageUrl, ebayImageUrl) {
  if (!vintedImageUrl || !ebayImageUrl) return null;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[vision-verify] OPENAI_API_KEY manquante, vision désactivée');
    return null;
  }

  const client = new OpenAI({ apiKey });

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

    // Enforce strict verdict: "match" only if all 3 are true
    const allTrue = parsed.sameProduct === true && parsed.sameVariant === true && parsed.conditionComparable === true;
    parsed.verdict = allTrue ? 'match' : 'no_match';

    // Compat fields — consumed by scoring.js, index.js, notifier.js, server.js
    parsed.sameCard = allTrue;
    parsed.confidence = allTrue ? 90 : 0;
    parsed.summary = parsed.reason || '';

    return parsed;
  } catch (err) {
    console.error('[vision-verify] Erreur API:', err.message);
    checkAndAlert('openai-vision', true, `GPT-4o mini erreur: ${err.message}`);
    return null;
  }
}

module.exports = { compareCardImages };
