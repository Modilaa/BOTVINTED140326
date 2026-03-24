# CONTEXTE_CLAUDE_V8.md — BOTVINTEDCODEX

## Derniere mise a jour : 2026-03-25 (soir)

---

## 1. PRÉSENTATION PROJET

Bot d'arbitrage multi-marketplace. Scanne Vinted (BE/FR/DE/ES/IT/NL/PL/UK) pour trouver des articles sous-évalués et les revendre sur eBay. Dashboard temps réel, alertes Telegram, vérification GPT-4o mini Vision, système d'auto-amélioration par feedback.

**Utilisateur** : Justin (francophone, Belgique). Pas développeur. Guide les priorités, teste le dashboard comme un client. Communiquer en français.

**Objectif** : 5000 EUR/mois net via arbitrage. Capital de départ : 500 EUR.

**Stack technique** : Node.js v24.13.0, Express, PM2, OpenAI GPT-4o-mini, Telegram Bot API, Chart.js, sharp (image processing), Tesseract OCR, imghash (pHash).

---

## 2. VPS & DÉPLOIEMENT

- **VPS** : root@76.13.148.209 (Hostinger, Ubuntu 24.04)
- **Projet VPS** : /root/botvintedcodex
- **Dashboard** : http://76.13.148.209:3000
- **PM2** : bot-scanner (scan toutes les 15 min via --loop --interval=15)
- **Deployer** : `./deploy-vps.sh` (rsync + npm install + PM2 restart)
- **Deployer fichiers seuls** : `./deploy-vps.sh --files-only`
- **Restart seul** : `./deploy-vps.sh --restart`
- **Deploy rapide** : `scp -r src/* root@76.13.148.209:/root/botvintedcodex/src/ && ssh root@76.13.148.209 "cd /root/botvintedcodex && pm2 restart bot-scanner"`

---

## 3. CODE LOCAL

- **Chemin** : C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX
- **IMPORTANT** : Toujours travailler sur cette copie (pas d'autre dossier)
- **Node.js** : v24.13.0
- **Package manager** : npm

---

## 4. ARCHITECTURE

```
src/
  index.js           — Scanner principal (boucle PM2, rotation pays)
  server.js           — Dashboard Express (port 3000, SSE temps réel)
  dashboard.html      — UI complète (dark theme, Chart.js, RESPONSIVE mobile <= 480px)
  config.js           — Configuration (searches, seuils, pays)
  scoring.js          — Confiance (0-100, 3 tiers + Chemin B) + Liquidité (0-100)
  matching.js         — Matching titre Vinted <-> eBay (fuzzy, zero-padding, V-Max)
  image-match.js      — pHash v3 (crop central 65%), OCR Tesseract, border, grid
  vision-verify.js    — GPT-4o mini Vision (3 critères, condition≠rejet, HD)
  notifier.js         — Alertes Telegram (opportunités + digest quotidien)
  telegram-handler.js — Callbacks boutons inline Telegram
  profit.js           — Calcul profit (fees eBay 13%, shipping)
  http.js             — HTTP avec proxy (Decodo, ScraperAPI, PROXY_URL)
  price-database.js   — Base de prix persistante (output/price-database.json)
  price-router.js     — Multi-source prix (APIs niche -> eBay -> Apify)
  seen-listings.js    — Cache annonces vues (24h TTL)
  seller-score.js     — Score vendeur Vinted
  api-monitor.js      — Monitoring erreurs API
  feedback-analyzer.js — Auto-amélioration (patterns feedbacks + GPT analyse + ajustements)
  scheduler.js        — DÉSACTIVÉ (spammait Discovery)

  marketplaces/
    vinted.js         — Scraper Vinted (multi-pays, pagination)
    ebay.js           — Scraper eBay sold listings (multi-domaines, images HD 1600px)
    pokemon-tcg.js    — API PokemonTCG.io + TCGdex
    ygoprodeck.js     — API YGOPRODeck
    pokemontcg-api.js — API PokemonTCG.io directe
    ebay-api.js       — eBay Browse API officielle
    cardmarket.js     — Scraper Cardmarket
    leboncoin.js      — Scraper Leboncoin
    lego-api.js       — Rebrickable API (LEGO)

  agents/
    supervisor.js     — Vérification disponibilité Vinted
    diagnostic.js     — Diagnostic système
    discovery.js      — Découverte nouvelles catégories
    product-explorer.js — Exploration produits
    strategist.js     — Portfolio + stratégie
    liquidity.js      — Analyse liquidité
    orchestrator.js   — Pipeline multi-agents

  scanners/
    reverse-scanner.js    — Scan eBay -> Vinted (reverse)
    cardmarket-scanner.js — Scan Cardmarket -> eBay
```

---

## 5. CATÉGORIES ACTIVES (9)

| Catégorie | Marketplace cible |
|-----------|-------------------|
| Pokemon | eBay (PokemonTCG API + eBay sold) |
| Yu-Gi-Oh | eBay (YGOPRODeck API + eBay sold) |
| LEGO | eBay (Rebrickable API + eBay sold) |
| Topps F1 | eBay (sold listings) |
| One Piece | eBay (sold listings) |
| Topps Football | eBay (sold listings) |
| Topps UFC | eBay (sold listings) |
| Topps Tennis | eBay (sold listings) |
| Topps Sport General | eBay (sold listings) |

---

## 6. PIPELINE COMPLET (scan → opportunité)

```
index.js (boucle PM2, toutes les 15 min)
  ↓
1. Charger catégories désactivées (feedback-analyzer.getDisabledCategories)
2. Pour chaque pays × chaque search active :
   a. vinted.js → scrape annonces
   b. seen-listings.js → filtrer les déjà vues
   c. matching.js → tenter de matcher avec prix eBay
   d. price-router.js → obtenir prix de revente
      ├── Cache (price-database.json, 2h TTL)
      ├── APIs niche (PokemonTCG, YGOPRODeck, Rebrickable)
      ├── eBay Browse API officielle
      ├── eBay scraping (UK/DE/FR/IT/ES)
      └── Apify (fallback, budget 100 req/scan)
   e. profit.js → calculer profit net (fees eBay 13% + shipping)
   f. scoring.js → calculer score confiance (0-100) + liquidité (0-100)
   g. Filtre : confidence >= 50 ET liquidité >= 40 (ou 25 si local-database)
   h. Sauvegarder en opportunité active
3. Tous les 2 scans : enrichissement prix (5 produits peu de données)
4. Tous les 3 scans : expiration annonces (5 opportunités actives sur Vinted)
5. Auto-verify GPT Vision : pour opportunités avec imageUrl + ebayMatchImageUrl
6. Digest quotidien Telegram si >= 20h et pas encore envoyé aujourd'hui
7. Tous les 7 scans (approximatif) : runAnalysis() du feedback-analyzer
```

---

## 7. SCORING V8 (scoring.js)

### Confiance (0-100) — Système ADDITIF, 4 chemins possibles

**Tier 1 : Qualité du matching texte (0-40 pts)**
- match.score >= 12 → 40 pts
- match.score >= 8 + source eBay → 40 pts
- match.score >= 8 → 30 pts
- match.score >= 4 + source eBay → 25 pts
- match.score >= 4 → 20 pts
- Sinon → 10 pts
- API niche (pokemon-tcg, ygoprodeck) sans matchedSales → 30 pts de base

**Tier 2 : Fiabilité de la source (0-20 pts)**
- pokemon-tcg-api, ygoprodeck → 20 pts
- local-database (scanCount >= 10) → 20 pts
- ebay-browse-api (3+ ventes) → 20 pts
- ebay-html / ebay (3+ ventes) → 15 pts
- apify-ebay (3+ ventes) → 15 pts
- rebrickable → 10 pts
- default → 5 pts

**Tier 3 : Vision GPT-4o mini (0-40 pts)**
- GPT confirme (sameCard=true) → +40 pts
- GPT rejette (sameCard=false) → SCORE 0 IMMÉDIAT (rejet total)
- Hash image local >= 0.85 → 25 pts (substitut)
- Hash image local >= 0.75 → 15 pts
- local-database sans image → 15 pts (bénéfice du doute)

**CHEMIN B : Prix très en dessous de la moyenne Vinted en base**
- Nécessite >= 3 observations dans price-database.json
- Prix actuel <= 60% de la moyenne → score plancher 95
- Prix actuel <= 70% de la moyenne → score plancher 90
- Prix actuel <= 80% de la moyenne → score plancher 75
- Indépendant des autres tiers — bonne affaire sans eBay ni GPT

**Hard gate assoupli (V6)**
- GPT rejette → 0 (inchangé)
- Sans GPT ET sans signal fort → plafond 49
- "Signal fort" = Chemin B >= 75 OU (textScore>=30 AND sourceScore>=15 AND visionScore>=15)

**Seuil d'opportunité : confidence >= 50**

### Liquidité (0-100) — 4 facteurs
- Volume ventes (35%), Vitesse (30%), Stabilité prix (20%), Turnover (15%)
- Seuil minimum : 40 (sources externes) | 25 (local-database)

### Ajustements dynamiques (feedback-analyzer)
- `minObservations` : peut être augmenté de 1 à 5 par l'analyseur
- `variantWeightBoost` : 0 à 30 pts de bonus matching variantes

---

## 8. MATCHING (matching.js) — VERSION V6

### Améliorations V6
1. **Zero-padding normalisé** : "044" = "44", "044/185" = "44/185"
2. **Variantes typographiques Pokémon** : "V-Max" = "vmax", "V-Star" = "vstar", "V-Union" = "vunion"
3. **Traductions FR→EN** : carte/card, booster, coffret/box, etc.
4. **Matching flexible** : 60% des identity tokens suffisent (pas 100%)
5. **Reverse mismatch** : détecte les cartes eBay avec trop de tokens extra

### Scoring match (scoreSoldListing)
- Chaque token commun = +1 pt
- Token spécifique commun = +2 pts
- Token identité commun = +3 pts
- Année = +3, Numéro carte = +4, Print run = +3
- Couverture >= 80% = +3, >= 60% = +1
- missingCritical (année différente, num carte différent, grading différent, lot mismatch) = rejet

---

## 9. COMPARAISON IMAGES (image-match.js) — VERSION 3

### FINGERPRINT_VERSION 3 (nouveau 25/03)
Avant de calculer pHash/border/gridBrightness, l'image est **croppée au centre (65%)**.

**Pourquoi** : Sur Vinted, le vendeur photographie sur table/lit → fond occupe 60-70% de l'image. Sur eBay, fond blanc studio. Sans crop, le fond domine le hash et crée des faux positifs/négatifs.

**Implémentation** : `cropCenterBuffer(buffer, 0.65)` via sharp — extrait le rectangle central 65%×65%, applique `.rotate()` pour corriger l'orientation EXIF.

**Exception** : OCR Tesseract utilise l'image complète (crop bottom 22% pour le numéro de carte).

### Algorithmes
- **pHash** (perceptual hash) : hash 64-bit, distance Hamming
- **Border detection** : détecte la couleur du bord de carte
- **Grid brightness** : découpe l'image en grille, compare la luminosité par zone
- **OCR** : Tesseract anglais, cherche numéro de carte (format "XXX/YYY")

### Seuils similarité
- >= 60% → badge vert "✓ N%" (haute similarité)
- 40-59% → badge orange "~ N%" (moyenne)
- < 40% → badge rouge "! N%" (faible)
- `minImageSimilarity` : 0.40 (abaissé de 0.60 le 25/03 — fix pipeline 0 résultat)

---

## 10. GPT VISION (vision-verify.js)

### Caractéristiques V8
- **Modèle** : gpt-4o-mini
- **detail: 'high'** (remplacé 'low' le 25/03 — meilleure lecture des détails carte)
- **Images HD** : URL eBay transformées s-l225 → s-l1600 automatiquement (`toHdEbayUrl`)
- **3 critères stricts** : sameProduct, sameVariant, conditionComparable

### Logique de verdict (FIX critique 25/03)
```
productVariantMatch = sameProduct === true AND sameVariant === true
fullMatch = productVariantMatch AND conditionComparable === true

verdict = "match"              si fullMatch
        = "match_condition_diff" si productVariantMatch mais condition différente
        = "no_match"           si produit ou variante différent(e)

sameCard = productVariantMatch   ← CLEF : condition ≠ ne disqualifie PAS
confidence = 90 si fullMatch
           = 60 si match_condition_diff (même produit/variante, condition différente)
           = 0  si no_match
```

**Avant ce fix** : `sameCard = allTrue` → une condition différente = rejet total. Résultat : Mensik et d'autres cartes rejetées à tort alors que c'était le bon produit.

### Intégration
- Auto-verify pendant le scan (`[vision-auto]` dans logs)
- Vérification manuelle via dashboard (POST /api/verify-image)
- Titre override : si GPT dit variante différente mais titres partagent le même mot-clé → force match
- Réponse complète sauvegardée : `visionFullResponse` + `visionReason` dans l'opportunité

### Prompt GPT
- Vérifie EXACT same item (numéro carte, set, année, joueur/personnage)
- Variantes : base ≠ holo ≠ refractor ≠ prizm ≠ gold
- Condition : mint/sealed ≠ damaged/opened
- Inclut un champ `report` avec observations détaillées et suggestion d'amélioration

---

## 11. PIPELINE DE PRIX (price-router.js)

1. Cache local (price-database.json, 2h TTL)
2. APIs niche (PokemonTCG, YGOPRODeck, Rebrickable)
3. eBay Browse API officielle
4. eBay scraping (multi-domaines UK/DE/FR/IT/ES)
5. Apify (fallback payant, budget 100 req/scan)

### Stockage dans price-database.json (V8)
Chaque observation sauvegarde désormais : URL du listing eBay, titre, image. Accessible via `priceDetails.listings[]` avec lien direct cliquable dans le dashboard.

---

## 12. TELEGRAM

- Alertes par opportunité (photo + boutons inline : Acheter/Ignorer/Détails)
- Filtre confiance minimum : `TELEGRAM_MIN_CONFIDENCE` (défaut 50)
- Résumé scan : envoyé si >= 1 opportunité trouvée
- Digest quotidien : envoyé 1x/jour à 20h+ (top 3, stats, catégories)
- Rapport feedback-analyzer : envoyé après analyse (si changements ou >= 5 feedbacks)
- Callbacks : buy_XXX, ignore_XXX, verify_XXX
- DISCOVERY filtré : messages "DISCOVERY MULTI-CATEGORIES" ignorés dans notifier.js

---

## 13. DASHBOARD (server.js + dashboard.html) — VERSION V8

### Sections principales
- **Opportunités** : 2 onglets — "En attente" (actives) + "Acceptées" (acceptées)
- **Base de prix** : historique des observations marché, colonne "Liens" avec dropdown
- **Portfolio** : items achetés, bouton "Vendu"
- **Agents** : diagnostic, discovery, strategist, orchestrator (manuels seulement)
- **Graphiques** : line chart profit/jour + doughnut catégories
- **Apprentissage** : rapport feedback-analyzer, score de santé GPT, ajustements actifs

### Onglets Opportunités (V8)
- **En attente** : opportunités actives, boutons ✅ (accepter) ❌ (rejeter avec raison) 🔍 (vérifier GPT)
- **Acceptées** : opportunités acceptées par Justin
- Les refusées disparaissent immédiatement du dashboard → sauvées dans feedback-log.json
- Les ignorées (ancien statut) ne sont plus visibles

### Base de prix — Liens (V8)
- Colonne "Liens" avec dropdown "📎 N liens" par produit
- Chaque observation est cliquable (lien direct eBay si disponible, sinon recherche eBay)
- Badge source :
  - Vert = API officielle (fiable)
  - Orange = scraping eBay (à vérifier)
  - Rouge = 1 seule vente (badge "⚠ 1 vente")

### Transparence scoring (V8)
- Popup breakdown score au clic : barres de progression Tier1/Tier2/Tier3 + CheminB
- Tooltips CSS custom (au lieu des tooltips natifs navigateur)
- Badge similarité image avec seuils 60/40 (vert/orange/rouge)

### Liens eBay dans opportunités (V8)
- Bleu = lien vers listing spécifique (URL exacte du listing trouvé)
- Orange = lien vers recherche générique eBay (quand pas de lien direct disponible)

### Responsive mobile
- Media queries < 768px et < 480px (iPhone SE)
- Tableaux scrollables horizontalement

### API endpoints clés
```
GET  /api/opportunities?filter=active|accepted
POST /api/opportunity/:id/accept
POST /api/opportunity/:id/reject  { reason: "..." }
POST /api/verify-image            { id }
GET  /api/feedback-report
GET  /api/feedback-analyzer/report
GET  /api/feedback-analyzer/run   (déclenche analyse manuelle)
GET  /api/price-database
GET  /api/portfolio
GET  /events                      (SSE temps réel)
```

---

## 14. SYSTÈME D'AUTO-AMÉLIORATION (feedback-analyzer.js)

### Rôle
Analyse les décisions accept/reject de Justin, identifie les patterns, applique des ajustements automatiques conservatives, génère un rapport + appelle GPT pour une analyse intelligente.

### Sources analysées
- `output/feedback-log.json` : décisions accept/reject avec raisons et timestamps
- `output/opportunities-history.json` : historique complet des opportunités

### Sorties
- `output/auto-adjustments.json` : état courant des overrides actifs
- `output/auto-adjustments-log.json` : historique immuable des ajustements
- `output/last-analysis-report.json` : dernier rapport généré
- `output/gpt-analysis.json` : dernière analyse GPT

### Pipeline d'analyse
```
1. analyzePatterns()        → stats globales, par catégorie, top raisons rejet
2. computeAdjustments()     → calcule ajustements conservateurs (min 20 décisions pour désactiver)
3. applyAdjustments()       → applique dans auto-adjustments.json
4. callGptAnalysis()        → 1x/jour : envoie 20 rejets + 10 acceptations à GPT-4o-mini
5. applyGptActions()        → applique les actions suggérées par GPT (disable_category, etc.)
6. generateReport()         → texte Telegram avec résumé
7. sendReportToTelegram()   → envoie si changements ou >= 5 feedbacks
```

### Ajustements possibles
- **disable_category** : désactive une catégorie si <= 5% acceptation sur 20+ décisions
- **enable_category** : réactive une catégorie si GPT juge que c'est opportun
- **increase_min_observations** : augmente min observations de prix (1→2 ou 3)
- **boost_variant_weight** : +10 ou +20 pts sur matching variante

### Seuils conservateurs
- MIN_DECISIONS_FOR_DISABLE = 20 (au moins 20 décisions avant de désactiver)
- MIN_DECISIONS_FOR_ADJUST = 5
- DISABLE_THRESHOLD_PERCENT = 5 (<=5% acceptation = catégorie problématique)

### Patterns de rejet classifiés
- different_variant, different_product, price_unreliable, condition_mismatch, other

### Section dashboard "Apprentissage"
- Score de santé GPT (0/10)
- Analyse textuelle GPT en français
- Top 3 patterns de rejet
- Priorités de la semaine
- Catégories désactivées
- Historique des ajustements appliqués

---

## 15. PORTFOLIO

- Premier achat : LEGO Star Wars 9676, 16.45 EUR investi, valeur marché ~64 EUR
- Fichier : output/portfolio-items.json
- Dashboard : section portfolio avec bouton "Vendu"

---

## 16. BUGS CORRIGÉS — HISTORIQUE COMPLET

### Session 23 mars (Dispatch) :
1. Portfolio vide (conflit routes Express) → CORRIGÉ
2. Filtre Ignorées cassé (API ignorait le paramètre status) → CORRIGÉ
3. Profit chute pendant scan (calcul sur données partielles) → CORRIGÉ
4. Bouton loupe sans feedback (pas de loader/toast) → CORRIGÉ (spinner + toast)
5. Filtres Base de prix hardcodés → CORRIGÉ (dynamiques)
6. Images Vinted cassées (hotlink protection CDN) → CORRIGÉ (proxy server-side)
7. GPT Vision auto-dismiss → IMPLÉMENTÉ
8. Titre override (faux négatifs thumbnails) → IMPLÉMENTÉ
9. Prompt GPT strict (3 critères) → IMPLÉMENTÉ
10. Mini-rapport GPT → SAUVEGARDÉ dans historique

### Session 23-24 mars (Claude Code V6) :
11. Source 'ebay'/'ebay-html' non reconnue dans scoring → CORRIGÉ
12. Rebrickable score trop faible (0 pts) → CORRIGÉ (10 pts fixes)
13. Seuils scoring relevés → CORRIGÉ (ms>=12 = 40pts, ms>=8+ebay = 40pts)
14. KPIs contradictoires : profit/taux toujours 0 pendant scan → CORRIGÉ (calcul depuis historique)
15. Portfolio bloqué : filtre Actives montrait 0 → CORRIGÉ
16. Profits irréalistes : estimation Rebrickable bloquée, GPT Vision générique → CORRIGÉ
17. Expiration annonces 30j → CORRIGÉ (7 jours)
18. Agents guards manquants → AJOUTÉ (protection double-run)
19. Sections masquées quand vides → IMPLÉMENTÉ
20. Layout GPT Vision concurrent → CORRIGÉ (queue séquentielle)
21. 3 catégories ajoutées : Topps UFC, Topps Tennis, Topps Sport General
22. Zero-padding matching : "044" = "44" → CORRIGÉ
23. Variantes typographiques : "V-Max" = "vmax" → CORRIGÉ
24. Hard gate assoupli : Chemin B peut atteindre 90-95 sans GPT
25. Dashboard responsive mobile (iPhone < 768px et < 480px)

### Session 24 mars soir (Claude Code V7) :
26. Images eBay HD : thumbnails 225px → 1600px (ebay.js)
27. Confiance GPT boost : +40pts quand GPT confirme — BUG CRITIQUE corrigé (champ sameCard manquant)
28. Auto-verify au scan : GPT Vision tourne automatiquement
29. Enrichissement prix proactif : tous les 2 scans
30. Expiration annonces : tous les 3 scans
31. Graphiques Chart.js : line chart + doughnut
32. Digest quotidien Telegram : 1x/jour à 20h+
33. Fix SSL VPS : NODE_OPTIONS=--use-openssl-ca

### Session 25 mars (Claude Code V8) :
34. **Diagnostic pipeline 0 résultat** : 3 blocages en cascade identifiés et corrigés :
    - minImageSimilarity 0.60 → 0.40 (config.js)
    - GPT Vision jamais appelé (condition d'appel trop restrictive)
    - Seuil liquidité assoupli pour local-database : 25 au lieu de 40
35. **Fix condition≠rejet** : vision-verify.js — la condition physique ne disqualifie plus (`match_condition_diff` verdict). Seuls sameProduct=false ou sameVariant=false rejettent. Carte Mensik restaurée.
36. **GPT Vision HD** : detail: 'high' au lieu de 'low' pour meilleure lecture
37. **Liens eBay honnêtes** : bleu = lien listing spécifique, orange = recherche générique
38. **Transparence scoring** : popup breakdown au clic avec barres de progression Tier1/2/3
39. **Transparence prix de revente** : badges source (vert/orange/rouge), popup détail au clic
40. **Base de prix tous les liens** : colonne Liens avec dropdown "📎 N liens", toutes les observations cliquables
41. **Stockage URL/titre/image eBay** dans price-database.json → liens directs possibles
42. **Badge ⚠ 1 vente** rouge quand une seule observation disponible
43. **Tooltips CSS custom** au lieu des tooltips natifs navigateur
44. **Audit opportunités** : 54 analysées, 7 actives supprimées (non vérifiables)
45. **Refonte UX opportunités** : 5 onglets → 2 (En attente + Acceptées), refusées disparaissent
46. **feedback-log.json** : chaque accept/reject sauvegardé avec timestamp, raison, source
47. **feedback-analyzer.js** : analyse quotidienne automatique des patterns
48. **Section Apprentissage dashboard** : rapport, score santé, ajustements actifs
49. **GPT analyse intelligente** : appel GPT-4o-mini pour analyser patterns, actions auto-appliquées
50. **FINGERPRINT_VERSION 3** : crop central 65% avant pHash (ignore fond bureau/lit/table)
51. **Fix comparaison images fond** : produits recentrés, faux positifs réduits

---

## 17. DÉPLOIEMENT

### Commandes

```bash
# Vérifier syntaxe
node --check src/index.js && node --check src/server.js

# Deploy rapide (fichiers + restart)
scp -r src/* root@76.13.148.209:/root/botvintedcodex/src/ && ssh root@76.13.148.209 "cd /root/botvintedcodex && pm2 restart bot-scanner"

# Deploy complet (avec npm install)
./deploy-vps.sh

# SSH sur le VPS
ssh root@76.13.148.209

# Logs PM2
ssh root@76.13.148.209 "pm2 logs bot-scanner --lines 50"

# Status PM2
ssh root@76.13.148.209 "pm2 list"

# Vérifier dashboard
curl http://76.13.148.209:3000

# Voir les opportunités en JSON
curl http://76.13.148.209:3000/api/opportunities | head -c 500

# Vérifier sync local vs VPS (compter les lignes)
for f in src/index.js src/scoring.js src/matching.js src/config.js src/server.js src/dashboard.html src/price-router.js src/price-database.js src/vision-verify.js src/image-match.js src/feedback-analyzer.js; do echo "$f $(wc -l < $f 2>/dev/null || echo MISSING)"; done
```

### Fichiers output importants (VPS)
```
/root/botvintedcodex/output/
  opportunities.json          — opportunités actives (cache)
  opportunities-history.json  — historique complet
  feedback-log.json           — décisions accept/reject Justin
  auto-adjustments.json       — ajustements actifs
  auto-adjustments-log.json   — historique ajustements
  last-analysis-report.json   — dernier rapport feedback-analyzer
  gpt-analysis.json           — dernière analyse GPT
  price-database.json         — base de prix persistante
  portfolio-items.json        — portefeuille
```

---

## 18. RÈGLES DE TRAVAIL

- **Matching strict** : pas de faux positifs, mieux vaut rater une opportunité que d'en montrer une fausse
- **Une tâche à la fois** : ne pas tout changer en même temps
- **Bonne copie** : toujours Desktop/Dispatch/BOTVINTEDCODEX
- **Déployer après chaque modif** : deploy-vps.sh
- **Vérifier la syntaxe** : `node --check src/index.js && node --check src/server.js` avant deploy
- **Scheduler désactivé** : les agents ne tournent que manuellement via le dashboard
- **Pas de Discovery auto** : les messages "DISCOVERY MULTI-CATEGORIES" sont filtrés dans notifier.js

---

## 19. POUR REPRENDRE UNE SESSION

1. Lire ce fichier CONTEXTE_CLAUDE_V8.md
2. `git status` pour voir les changements locaux en cours
3. `ssh root@76.13.148.209 "pm2 list"` pour vérifier que le bot tourne
4. `ssh root@76.13.148.209 "pm2 logs bot-scanner --lines 20"` pour voir les derniers logs
5. Ouvrir le dashboard : http://76.13.148.209:3000
6. Vérifier les feedbacks : onglet "Apprentissage" du dashboard

### État du projet au 25/03/2026 soir :
- Bot tourne sur VPS, scan toutes les 15 min
- 9 catégories actives (aucune désactivée par l'analyseur à ce stade)
- **Scoring V8** : identique V6 mais ajusté par feedback-analyzer si patterns détectés
- **Matching V6** : fuzzy, zero-padding, variantes Pokemon (V-Max, V-Star, etc.)
- **Vision GPT V8** : detail: high, sameCard = productVariantMatch (condition≠rejet)
- **Image matching V3** : crop central 65% avant pHash, minImageSimilarity = 0.40
- **Dashboard V8** : 2 onglets opps (En attente / Acceptées), section Apprentissage, liens eBay directs
- **Auto-amélioration** : feedback-analyzer opérationnel, GPT analyse 1x/jour
- **Pipeline 0 résultat** : 3 blocages corrigés le 25/03 (minImageSimilarity, GPT call, liquidité)
- **Portfolio** : 1 item (LEGO 9676, 16.45 EUR → valeur ~64 EUR)
- **Git** : synchronisé local = VPS = GitHub (main branch)

### Prochaines priorités (todo) :
- Observer le taux d'opportunités trouvés après les 3 fixes du 25/03 (attendre 24-48h)
- Analyser les premiers feedbacks via section Apprentissage
- Revente assistée (cross-post eBay/Vinted/Marketplace)
- Facebook Marketplace comme source d'achat
- Augmenter le capital déployé si les opportunités confirment la plus-value

---

## 20. AUDIT DES HEURES DE TRAVAIL

### Données brutes (git log --all)

| Date | Commits | Description principale |
|------|---------|----------------------|
| 12/03/2026 | 1 | Initial bot (README, package.json, .env.example) |
| 13/03/2026 | 3 | Dashboard V1, image filter, catégories |
| 14/03/2026 | 1 | Dashboard temps réel, filtres, matching |
| 16/03/2026 | 20 | APIs Pokemon/YGO, matching qualité, proxy, Facebook |
| 20/03/2026 | 1 | Arbitrage multi-directionnel (eBay→Vinted, Cardmarket→eBay) |
| 23/03/2026 | 12 | Agents IA, price-router, scoring, dashboard fixes, 3 catégories |
| 24/03/2026 | 6 | GPT hard gate, gros fix dashboard, scoring V6, mobile, CONTEXTE |
| 25/03/2026 | ~8 | Diagnostic pipeline, fix vision, feedback-analyzer, image crop, UX |
| **TOTAL** | **~52** | (quelques commits dupliqués dans branches) |

**Worktrees Claude Code** : ~130 worktrees = ~130 sessions Claude Code

### Estimation par phase

| Phase | Période | Commits | Worktrees (~) | Lignes code | Heures Claude | Heures Justin |
|-------|---------|---------|---------------|-------------|---------------|---------------|
| Phase initiale | 12/03 | 1 | ~5 | ~2 500 | 2h | 1h |
| Phase V1 dashboard | 13-14/03 | 4 | ~15 | ~5 000 | 7h | 2h |
| Phase APIs & matching | 16/03 | 20 | ~35 | ~8 000 | 14h | 4h |
| Phase multi-directionnel | 20/03 | 1 | ~8 | ~1 500 | 3h | 1h |
| Phase agents & consolidation | 23/03 matin | 2 | ~20 | ~6 000 | 8h | 3h |
| Phase audit UX & fixes | 23/03 soir | 12 | ~25 | ~3 000 | 10h | 4h |
| Phase V6 24/03 | 24/03 | 6 | ~10 | ~1 800 | 5h | 2h |
| Phase V8 25/03 | 25/03 | ~8 | ~12 | ~3 000 | 8h | 3h |
| **TOTAL** | | **~54** | **~130** | **~30 800** | **57h** | **20h** |

### Résumé

- **Sessions Claude Code** : ~130 (un worktree = une session)
- **Durée moyenne par session** : 20-30 minutes
- **Total heures Claude Code** : ~57 heures
- **Total heures supervision Justin** : ~20 heures (tests, feedback, décisions)
- **TOTAL PROJET** : **~77 heures de travail**
- **Lignes de code** (src/) : ~23 000 lignes (estimation)
- **Fichiers** : 60+ fichiers (src, agents, scanners, marketplaces)
- **Valeur produite** : bot complet, déployé sur VPS, opérationnel 24/7 avec auto-amélioration

### Contexte de vitesse

Un développeur solo aurait besoin de 4 à 7 mois pour produire ce projet. En travaillant avec Claude Code :
- 13 jours calendaires (12 au 25 mars)
- ~77 heures effectives
- De l'idée au bot avec dashboard, Telegram, GPT Vision, auto-amélioration, 9 catégories, scoring V8, image matching v3
