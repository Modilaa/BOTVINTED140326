// test-apify.js — Vérifie que l'intégration Apify eBay fonctionne
// Usage: node test-apify.js
require('dotenv').config();

const { getApifyEbaySoldPrices } = require('./src/marketplaces/apify-ebay');

getApifyEbaySoldPrices('topps chrome f1 2025 bearman', {})
  .then(r => {
    if (!r) {
      console.log('Résultat: null (aucun résultat ou erreur)');
      process.exit(1);
    }
    console.log('Résultat Apify:');
    console.log(`  Source       : ${r.source}`);
    console.log(`  Nb résultats : ${r.resultCount}`);
    console.log(`  Prix médian  : ${r.medianPrice.toFixed(2)}€`);
    console.log(`  Tous les prix: ${r.prices.map(p => p.toFixed(2) + '€').join(', ')}`);
    console.log('\nPremier résultat:');
    if (r.soldListings[0]) {
      console.log(`  Titre : ${r.soldListings[0].title}`);
      console.log(`  Prix  : ${r.soldListings[0].price}€`);
      console.log(`  URL   : ${r.soldListings[0].url}`);
    }
  })
  .catch(err => {
    console.error('Erreur:', err.message);
    process.exit(1);
  });
