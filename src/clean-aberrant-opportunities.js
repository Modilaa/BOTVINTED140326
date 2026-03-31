/**
 * Script one-shot : purge les opportunités avec ratio prix_revente/prix_achat > 15x
 * dans output/latest-scan.json et output/opportunities-history.json
 *
 * Usage : node scripts/clean-aberrant-opportunities.js
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const RATIO_MAX = 15;

function cleanOpportunities(opps) {
  if (!Array.isArray(opps)) return opps;
  const before = opps.length;
  const cleaned = opps.filter((opp) => {
    const salePrice = opp.estimatedSalePrice || opp.ebayPrice || 0;
    const buyPrice = opp.vintedPrice || opp.price || 1;
    const ratio = salePrice / buyPrice;
    if (ratio > RATIO_MAX) {
      console.log(`  SUPPRIMÉ ratio ${Math.round(ratio)}x : "${(opp.title || '').slice(0, 60)}" — achat ${buyPrice}€, vente ${salePrice}€`);
      return false;
    }
    return true;
  });
  console.log(`  ${before - cleaned.length} supprimé(s), ${cleaned.length} conservé(s)`);
  return cleaned;
}

// --- latest-scan.json ---
const scanPath = path.join(OUTPUT_DIR, 'latest-scan.json');
if (fs.existsSync(scanPath)) {
  console.log('\n[latest-scan.json]');
  const scan = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
  if (scan.opportunities) {
    scan.opportunities = cleanOpportunities(scan.opportunities);
    fs.writeFileSync(scanPath, JSON.stringify(scan, null, 2), 'utf8');
    console.log('  → Fichier mis à jour.');
  } else {
    console.log('  → Aucune opportunité trouvée.');
  }
} else {
  console.log('\n[latest-scan.json] → Fichier absent, rien à faire.');
}

// --- opportunities-history.json ---
const histPath = path.join(OUTPUT_DIR, 'opportunities-history.json');
if (fs.existsSync(histPath)) {
  console.log('\n[opportunities-history.json]');
  const history = JSON.parse(fs.readFileSync(histPath, 'utf8'));
  const cleaned = cleanOpportunities(history);
  fs.writeFileSync(histPath, JSON.stringify(cleaned, null, 2), 'utf8');
  console.log('  → Fichier mis à jour.');
} else {
  console.log('\n[opportunities-history.json] → Fichier absent, rien à faire.');
}

console.log('\nNettoyage terminé.');
