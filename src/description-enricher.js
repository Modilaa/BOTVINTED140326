/**
 * Description Enricher — Extrait les mots-clés importants de la description
 * d'une annonce Vinted pour enrichir le titre avant le matching eBay.
 *
 * Problème résolu: le titre Vinted est souvent trop court/vague.
 * La description contient souvent: type de carte (RC, Refractor, base),
 * numéro exact, tirage (/299), variante (Chrome, Prizm, etc.).
 */

const { toSlugTokens } = require('./utils');

// Variantes de cartes TCG/Sport à chercher dans la description
// Ordonnées par priorité (les plus discriminantes en premier)
const VARIANT_KEYWORDS = [
  // Topps F1 / Topps Chrome sets
  'chrome', 'sapphire', 'finest', 'turbo attax',
  // Parallels / finishes
  'refractor', 'prizm', 'prism', 'atomic', 'superfractor',
  'gold', 'rainbow', 'silver',
  // Types génériques
  'base', 'insert', 'holo',
  // Panini
  'mosaic', 'select', 'obsidian', 'spectra',
  // Topps F1 variantes spéciales
  'speed demons', 'helmet collection', 'portrait', 'flag bearer',
  'race class',
];

const AUTO_KEYWORDS = [
  'auto', 'autograph', 'autographe', 'signed', 'signe', 'signature', 'autographed'
];

const ROOKIE_KEYWORDS = [
  'rc', 'rookie', 'first edition', 'premiere edition', 'debut'
];

/**
 * Normalise un texte pour la recherche de mots-clés.
 * Minuscules, sans accents, sans ponctuation sauf / et #.
 */
function normalizeForSearch(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-z0-9\s/#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Enrichit le titre Vinted avec les informations extraites de la description.
 * N'ajoute que les mots-clés absents du titre, pour améliorer le matching eBay.
 *
 * Exemple:
 *   titre:       "Carte Topps F1 2025 Kimi Antonelli 256"
 *   description: "Carte base Topps Chrome F1 2025 numéro 256, bel état"
 *   résultat:    "Carte Topps F1 2025 Kimi Antonelli 256 chrome base"
 *
 * @param {string} title - Titre original de l'annonce
 * @param {string} description - Description de l'annonce Vinted
 * @returns {string} - Titre enrichi (ou titre original si rien à ajouter)
 */
function enrichTitleFromDescription(title, description) {
  if (!description || !description.trim()) return title;

  const titleNorm = normalizeForSearch(title);
  const descNorm = normalizeForSearch(description);
  const additions = [];

  // 1. Variantes de cartes (chrome, refractor, base, insert, etc.)
  //    On ajoute les keywords trouvés dans la description mais pas dans le titre
  //    (limité à 2 pour ne pas sur-spécifier la query eBay)
  let variantCount = 0;
  for (const keyword of VARIANT_KEYWORDS) {
    if (variantCount >= 2) break;
    const kw = normalizeForSearch(keyword);
    if (descNorm.includes(kw) && !titleNorm.includes(kw)) {
      // Pour les mots composés, ne garder que le premier token
      additions.push(keyword.split(' ')[0]);
      variantCount++;
    }
  }

  // 2. Autographe (auto/signed)
  const hasAutoTitle = AUTO_KEYWORDS.some((kw) => titleNorm.includes(normalizeForSearch(kw)));
  if (!hasAutoTitle) {
    const hasAutoDesc = AUTO_KEYWORDS.some((kw) => descNorm.includes(normalizeForSearch(kw)));
    if (hasAutoDesc) additions.push('auto');
  }

  // 3. Rookie / RC
  const hasRcTitle = ROOKIE_KEYWORDS.some((kw) => {
    const norm = normalizeForSearch(kw);
    // Pour "rc", matcher comme token isolé (pas dans "race", "refractor"…)
    if (norm === 'rc') return new RegExp(`\\brc\\b`).test(titleNorm);
    return titleNorm.includes(norm);
  });
  if (!hasRcTitle) {
    const hasRcDesc = ROOKIE_KEYWORDS.some((kw) => {
      const norm = normalizeForSearch(kw);
      if (norm === 'rc') return new RegExp(`\\brc\\b`).test(descNorm);
      return descNorm.includes(norm);
    });
    if (hasRcDesc) additions.push('RC');
  }

  // 4. Print run (/xxx) si absent du titre
  //    Exemples: /99, /150, /299 dans la description
  if (!/\/\d{1,4}\b/.test(titleNorm)) {
    const printRunMatch = descNorm.match(/\/(\d{1,4})\b/);
    if (printRunMatch) {
      const run = parseInt(printRunMatch[1], 10);
      // Sanity check: entre 1 et 9999, et pas une saison (ex: /25 dans 2024/25)
      if (run >= 1 && run <= 9999) {
        additions.push(`/${printRunMatch[1]}`);
      }
    }
  }

  if (additions.length === 0) return title;

  return `${title} ${additions.join(' ')}`.trim();
}

module.exports = { enrichTitleFromDescription };
