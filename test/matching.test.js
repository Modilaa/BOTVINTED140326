const assert = require('assert');
const {
  extractCardSignature,
  scoreSoldListing,
  chooseBestSoldListings,
  translateFrToEn
} = require('../src/matching');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. extractCardSignature — détection des variantes
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── extractCardSignature ──');

test('Détecte une carte numérotée /50', () => {
  const sig = extractCardSignature('Declan Rice Topps Chrome 2024 /50');
  assert.strictEqual(sig.cardCategory, 'numbered');
  assert.strictEqual(sig.printRun, '50');
  assert.strictEqual(sig.autograph, false);
});

test('Détecte une carte signée (signed)', () => {
  const sig = extractCardSignature('Declan Rice Topps Chrome 2024 Signed Auto');
  assert.strictEqual(sig.cardCategory, 'signed');
  assert.strictEqual(sig.autograph, true);
});

test('Détecte "signature" comme autographe', () => {
  const sig = extractCardSignature('Lamine Yamal Signature Card 2024');
  assert.strictEqual(sig.autograph, true);
  assert.strictEqual(sig.cardCategory, 'signed');
});

test('Détecte "signé" (français) comme autographe', () => {
  const sig = extractCardSignature('Carte Mbappé signé Topps 2024');
  assert.strictEqual(sig.autograph, true);
});

test('Détecte un lot (mot "lot")', () => {
  const sig = extractCardSignature('Pikachu lot x5 cartes Pokemon');
  assert.strictEqual(sig.isLot, true);
});

test('Détecte un lot (mot "bundle")', () => {
  const sig = extractCardSignature('Pokemon cards bundle x10');
  assert.strictEqual(sig.isLot, true);
});

test('Détecte x3 comme lot', () => {
  const sig = extractCardSignature('Pikachu VMAX x3');
  assert.strictEqual(sig.isLot, true);
});

test('Ne détecte PAS x1 comme lot', () => {
  const sig = extractCardSignature('Pikachu VMAX x1');
  assert.strictEqual(sig.isLot, false);
});

test('Carte de base = category "base"', () => {
  const sig = extractCardSignature('Declan Rice Topps Chrome 2024');
  assert.strictEqual(sig.cardCategory, 'base');
  assert.strictEqual(sig.autograph, false);
  assert.strictEqual(sig.printRun, null);
});

test('Carte gradée PSA = category "graded"', () => {
  const sig = extractCardSignature('Declan Rice PSA 10 Topps Chrome 2024');
  assert.strictEqual(sig.graded, true);
  assert.strictEqual(sig.cardCategory, 'graded');
});

test('Numérotée a priorité sur signée si les deux sont présents', () => {
  const sig = extractCardSignature('Declan Rice Auto /25 Topps Chrome 2024');
  assert.strictEqual(sig.cardCategory, 'numbered');
  assert.strictEqual(sig.autograph, true);
  assert.strictEqual(sig.printRun, '25');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. scoreSoldListing — pénalités de catégorie
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── scoreSoldListing ──');

test('Declan Rice /50 vs Declan Rice signed = missingCritical', () => {
  const result = scoreSoldListing(
    { title: 'Declan Rice Topps Chrome 2024 /50' },
    { title: 'Declan Rice Topps Chrome 2024 Signed Autograph' }
  );
  assert.strictEqual(result.missingCritical, true,
    `missingCritical devrait être true, hardCategoryConflict=${result.hardCategoryConflict}`);
});

test('Declan Rice /50 vs Declan Rice /50 = pas de missingCritical', () => {
  const result = scoreSoldListing(
    { title: 'Declan Rice Topps Chrome 2024 /50' },
    { title: 'Declan Rice Topps Chrome 2024 Numbered /50' }
  );
  assert.strictEqual(result.missingCritical, false);
  assert.strictEqual(result.hardCategoryConflict, false);
});

test('Lamine Yamal /25 vs Yamal Numbered /25 = même catégorie, pas de conflit dur', () => {
  const result = scoreSoldListing(
    { title: 'Lamine Yamal Topps Chrome 2024 /25' },
    { title: 'Yamal Topps Chrome 2024 Numbered /25' }
  );
  // identityPartialOnly peut être true (prénom manquant) mais pas de hardCategoryConflict
  assert.strictEqual(result.hardCategoryConflict, false);
  assert.strictEqual(result.categoryMismatch, false);
  assert.strictEqual(result.lotMismatch, false);
  assert.ok(result.score > 0, `Score devrait être > 0, got ${result.score}`);
});

test('Lot vs non-lot = lotMismatch', () => {
  const result = scoreSoldListing(
    { title: 'Pikachu VMAX' },
    { title: 'Pikachu VMAX lot x5' }
  );
  assert.strictEqual(result.lotMismatch, true);
  assert.strictEqual(result.missingCritical, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. chooseBestSoldListings — cas concrets
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── chooseBestSoldListings ──');

test('Declan Rice /50 NE DOIT PAS matcher avec Declan Rice signed', () => {
  const results = chooseBestSoldListings(
    { title: 'Declan Rice Topps Chrome 2024 /50', price: 15 },
    [
      { title: 'Declan Rice Topps Chrome 2024 Signed Autograph', soldPrice: 150, soldAtTs: Date.now(), itemKey: 'ebay1' },
      { title: 'Declan Rice Signed Auto Topps 2024', soldPrice: 200, soldAtTs: Date.now() - 1000, itemKey: 'ebay2' }
    ]
  );
  assert.strictEqual(results.length, 0,
    `Aucun match attendu pour /50 vs signed, mais ${results.length} trouvé(s)`);
});

test('Lamine Yamal Topps Chrome 2024 /25 DOIT matcher avec Yamal Topps Chrome 2024 Numbered /25', () => {
  const results = chooseBestSoldListings(
    { title: 'Lamine Yamal Topps Chrome 2024 /25', price: 50 },
    [
      { title: 'Yamal Topps Chrome 2024 Numbered /25', soldPrice: 80, soldAtTs: Date.now(), itemKey: 'ebay1' },
      { title: 'Lamine Yamal Topps Chrome 2024 /25', soldPrice: 75, soldAtTs: Date.now() - 5000, itemKey: 'ebay2' }
    ]
  );
  assert.ok(results.length > 0,
    'Au moins un match attendu pour Yamal /25');
});

test('Pikachu VMAX NE DOIT PAS matcher avec Pikachu lot x5', () => {
  const results = chooseBestSoldListings(
    { title: 'Pikachu VMAX', price: 10 },
    [
      { title: 'Pikachu lot x5 cards Pokemon', soldPrice: 25, soldAtTs: Date.now(), itemKey: 'ebay1' }
    ]
  );
  assert.strictEqual(results.length, 0,
    `Aucun match attendu pour single vs lot, mais ${results.length} trouvé(s)`);
});

test('Carte non-gradée NE DOIT PAS matcher avec PSA 10', () => {
  const results = chooseBestSoldListings(
    { title: 'Declan Rice Topps Chrome 2024', price: 5 },
    [
      { title: 'Declan Rice Topps Chrome 2024 PSA 10', soldPrice: 80, soldAtTs: Date.now(), itemKey: 'ebay1' }
    ]
  );
  assert.strictEqual(results.length, 0,
    `Aucun match attendu pour non-gradée vs PSA 10, mais ${results.length} trouvé(s)`);
});

test('Prix eBay 10x+ avec catégorie différente = filtré', () => {
  const results = chooseBestSoldListings(
    { title: 'Declan Rice Topps Chrome 2024 /50', price: 10 },
    [
      { title: 'Declan Rice Topps Chrome 2024 Base', soldPrice: 120, soldAtTs: Date.now(), itemKey: 'ebay1' }
    ]
  );
  // Le /50 Vinted (numbered) vs base eBay: printRunMismatch devrait bloquer de toute façon
  // mais le price ratio check ajoute une couche de sécurité
  assert.strictEqual(results.length, 0,
    `Aucun match pour prix 10x+ avec catégorie différente`);
});

test('Traduction FR→EN: "autographe" doit être détecté', () => {
  const translated = translateFrToEn('Carte autographe Mbappé');
  assert.ok(translated.includes('autograph'),
    `"autographe" devrait être traduit en "autograph", got: ${translated}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Résumé
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n══ Résultats: ${passed} passé(s), ${failed} échoué(s) ══\n`);
process.exit(failed > 0 ? 1 : 0);
