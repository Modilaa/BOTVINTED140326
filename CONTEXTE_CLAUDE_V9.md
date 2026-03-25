# CONTEXTE_CLAUDE_V9.md — BOTVINTEDCODEX

## Derniere mise a jour : 2026-03-26 (session finale journée)

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
  vision-verify.js    — GPT-4o mini Vision (detail:auto, prompt "ignore fond", retry 429)
  notifier.js         — Alertes Telegram (opportunités + digest quotidien)
  telegram-handler.js — Callbacks boutons inline Telegram
  profit.js           — Calcul profit (fees eBay 13%, shipping)
  http.js             — HTTP avec proxy (Decodo, ScraperAPI, PROXY_URL)
  price-database.js   — Base de prix persistante (output/price-database.json, dédoublonnage URL)
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
   h. Sauvegarder en opportunité active (manualOverride préservé si acceptée)
3. Tous les 2 scans : enrichissement prix (5 produits peu de données)
4. Tous les 3 scans : expiration annonces (5 opportunités actives sur Vinted)
5. Auto-verify GPT Vision : pour opportunités avec imageUrl + ebayMatchImageUrl
6. Digest quotidien Telegram si >= 20h et pas encore envoyé aujourd'hui
7. Tous les 7 scans (approximatif) : runAnalysis() du feedback-analyzer
```

---

## 7. SCORING V9 (scoring.js)

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

## 10. GPT VISION (vision-verify.js) — VERSION V9

### Caractéristiques V9
- **Modèle** : gpt-4o-mini
- **detail: 'auto'** (V9 — adaptatif selon la taille de l'image, remplace 'high' de V8)
  - 'auto' laisse OpenAI choisir le niveau de détail optimal (coût réduit vs 'high')
- **Images HD** : URL eBay transformées s-l225 → s-l1600 automatiquement (`toHdEbayUrl`)
- **3 critères stricts** : sameProduct, sameVariant, conditionComparable
- **Retry backoff 429** : délais [1s, 3s, 8s] sur rate limit (V9)

### Prompt V9 — IGNORE LE FOND
Le prompt inclut désormais un bloc `IMPORTANT CONTEXT` :
```
- Image 1 is from Vinted. The seller took the photo at home,
  so the BACKGROUND will be random (desk, table, bed, floor, etc.).
  IGNORE THE BACKGROUND COMPLETELY.
- Image 2 is from eBay. It usually has a clean/white background.
- The backgrounds will ALWAYS be different. This is NORMAL and NOT a reason to reject.
- A card photographed on a wooden desk is THE SAME CARD as one on white background.
- Physical condition differences (slight wear, no sleeve vs sleeved) should NOT cause
  rejection. Mark as match_condition_diff instead.
```
**Pourquoi** : Sans cette instruction, GPT confondait le fond du bureau Vinted avec une
différence de produit. Mensik et d'autres cartes étaient rejetées à tort.

### Retry backoff 429 (V9)
```javascript
const VISION_RETRY_DELAYS = [1000, 3000, 8000];
// Sur 429 : attend 1s, puis 3s, puis 8s avant abandon
```

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

### Intégration
- Auto-verify pendant le scan (`[vision-auto]` dans logs)
- Vérification manuelle via dashboard (POST /api/verify-image)
- Titre override : si GPT dit variante différente mais titres partagent le même mot-clé → force match
- Réponse complète sauvegardée : `visionFullResponse` + `visionReason` dans l'opportunité

---

## 11. PIPELINE DE PRIX (price-router.js)

1. Cache local (price-database.json, 2h TTL)
2. APIs niche (PokemonTCG, YGOPRODeck, Rebrickable)
3. eBay Browse API officielle
4. eBay scraping (multi-domaines UK/DE/FR/IT/ES)
5. Apify (fallback payant, budget 100 req/scan)

### Stockage dans price-database.json (V9)
- Chaque observation sauvegarde : URL du listing eBay, titre, image
- **Dédoublonnage par URL** au stockage (V9) : `if (existing URL) skip`
- **538 doublons supprimés** lors du nettoyage du 26/03 (même listing eBay stocké plusieurs fois)
- Accessible via `priceDetails.listings[]` avec lien direct cliquable dans le dashboard

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

## 13. DASHBOARD (server.js + dashboard.html) — VERSION V9

### Sections principales
- **Opportunités** : 2 onglets — "En attente" (actives) + "Acceptées" (acceptées)
- **Base de prix** : historique des observations marché, colonne "Liens" avec dropdown
- **Portfolio** : items achetés, bouton "Vendu"
- **Agents** : diagnostic, discovery, strategist, orchestrator (manuels seulement)
- **Graphiques** : line chart profit/jour + doughnut catégories
- **Apprentissage** : rapport feedback-analyzer, score de santé GPT, ajustements actifs

### Onglets Opportunités
- **En attente** : opportunités actives, boutons ✅ (accepter) ❌ (rejeter avec raison) 🔍 (vérifier GPT)
- **Acceptées** : opportunités acceptées par Justin (protégées par manualOverride)
- Les refusées disparaissent immédiatement du dashboard → sauvées dans feedback-log.json

### manualOverride (V9)
Quand Justin accepte une opportunité :
- `opp.manualOverride = true` est posé sur l'entrée
- Le scanner ne peut plus écraser le statut/confidence/vision de cet item
- Les règles d'expiration (7 jours, confidence < 50) ne s'appliquent pas
- **Pourquoi** : un item manuellement validé ne doit pas être rejeté automatiquement au prochain scan

### Badge "⚠ Sans photo eBay" (V9)
- Affiché à la place de l'image eBay quand elle est introuvable
- Couleur orange, tooltip : "Image eBay introuvable — vérification visuelle impossible"
- Apparaît aussi en statique si `ebayMatchImageUrl` est absent au chargement
- **Pourquoi** : sans image eBay, GPT Vision ne peut pas vérifier → information critique pour Justin

### Base de prix — Liens
- Colonne "Liens" avec dropdown "📎 N liens" par produit
- Chaque observation est cliquable (lien direct eBay si disponible, sinon recherche eBay)
- Badge source :
  - Vert = API officielle (fiable)
  - Orange = scraping eBay (à vérifier)
  - Rouge = 1 seule vente (badge "⚠ 1 vente")

### Transparence scoring
- Popup breakdown score au clic : barres de progression Tier1/Tier2/Tier3 + CheminB
- Tooltips CSS custom (au lieu des tooltips natifs navigateur)
- Badge similarité image avec seuils 60/40 (vert/orange/rouge)

### Liens eBay dans opportunités
- **Bleu** = lien vers listing spécifique (URL exacte du listing trouvé)
- **Orange** = lien vers recherche générique eBay (quand pas de lien direct disponible)

### Responsive mobile (V9 — fix overflow)
- Media queries < 768px et < 480px (iPhone SE)
- `.table-container { overflow-x: auto; -webkit-overflow-scrolling: touch; }` appliqué à tous les tableaux
- Fix spécifique : colonnes Actions et Liens ne débordent plus sur mobile
- `overflow-x: auto` sur les conteneurs de tableaux (fix 26/03)

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
14. KPIs contradictoires : profit/taux toujours 0 pendant scan → CORRIGÉ
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

### Session 26 mars (Claude Code V9) :
52. **GPT Vision detail: auto** : remplace 'high' → adaptatif OpenAI (coût optimisé, même qualité)
53. **Prompt GPT "ignore le fond"** : bloque enrichi IMPORTANT CONTEXT — fond Vinted ≠ raison de rejet
54. **Retry backoff 429** : VISION_RETRY_DELAYS = [1000, 3000, 8000] ms — évite les crashs silencieux
55. **manualOverride** : items acceptés manuellement protégés contre l'écrasement par le scanner
56. **Badge "⚠ Sans photo eBay"** : affiché quand image eBay absente — alerte visuelle pour Justin
57. **Fix tableau mobile overflow** : overflow-x: auto sur tous les .table-container (fin débordement colonne)
58. **Dédoublonnage URLs price-database** : skip si URL déjà présente pour ce produit
59. **538 doublons nettoyés** : nettoyage rétroactif de price-database.json sur VPS (même listing stocké N fois)
60. **Audit complet 20/20** : vérification VPS — tous les points critiques confirmés opérationnels

---

## 17. AUDIT COMPLET V9 — 20/20 POINTS CONFIRMÉS SUR VPS

Vérification effectuée le 26/03/2026 sur http://76.13.148.209:3000 et via SSH.

| # | Point vérifié | Statut |
|---|--------------|--------|
| 1 | Bot tourne (PM2 bot-scanner, status online) | ✅ |
| 2 | Scan toutes les 15 min (logs PM2) | ✅ |
| 3 | Dashboard accessible http://76.13.148.209:3000 | ✅ |
| 4 | SSE temps réel (events push) | ✅ |
| 5 | GPT Vision auto-verify pendant scan | ✅ |
| 6 | Retry 429 dans vision-verify.js | ✅ |
| 7 | detail: 'auto' dans vision-verify.js | ✅ |
| 8 | Prompt "ignore le fond" dans vision-verify.js | ✅ |
| 9 | manualOverride dans server.js (accept + expiry) | ✅ |
| 10 | Badge "⚠ Sans photo eBay" dans dashboard.html | ✅ |
| 11 | Tableau mobile overflow-x: auto | ✅ |
| 12 | Dédoublonnage URL dans price-database.js | ✅ |
| 13 | FINGERPRINT_VERSION 3 (crop 65%) dans image-match.js | ✅ |
| 14 | Popup breakdown score au clic | ✅ |
| 15 | Liens eBay bleu=listing / orange=recherche | ✅ |
| 16 | Section Apprentissage dashboard | ✅ |
| 17 | feedback-analyzer.js opérationnel | ✅ |
| 18 | Digest quotidien Telegram (20h+) | ✅ |
| 19 | Chemin B scoring (indépendant GPT) | ✅ |
| 20 | Portfolio LEGO 9676 visible | ✅ |

---

## 18. DÉPLOIEMENT

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
  price-database.json         — base de prix persistante (538 doublons nettoyés)
  portfolio-items.json        — portefeuille
```

---

## 19. RÈGLES DE TRAVAIL

- **Matching strict** : pas de faux positifs, mieux vaut rater une opportunité que d'en montrer une fausse
- **Une tâche à la fois** : ne pas tout changer en même temps
- **Bonne copie** : toujours Desktop/Dispatch/BOTVINTEDCODEX
- **Déployer après chaque modif** : deploy-vps.sh
- **Vérifier la syntaxe** : `node --check src/index.js && node --check src/server.js` avant deploy
- **Scheduler désactivé** : les agents ne tournent que manuellement via le dashboard
- **Pas de Discovery auto** : les messages "DISCOVERY MULTI-CATEGORIES" sont filtrés dans notifier.js

---

## 20. POUR REPRENDRE UNE SESSION

1. Lire ce fichier CONTEXTE_CLAUDE_V9.md
2. `git status` pour voir les changements locaux en cours
3. `ssh root@76.13.148.209 "pm2 list"` pour vérifier que le bot tourne
4. `ssh root@76.13.148.209 "pm2 logs bot-scanner --lines 20"` pour voir les derniers logs
5. Ouvrir le dashboard : http://76.13.148.209:3000
6. Vérifier les feedbacks : onglet "Apprentissage" du dashboard

### État du projet au 26/03/2026 (session finale) :
- Bot tourne sur VPS, scan toutes les 15 min — **20/20 points audit confirmés**
- 9 catégories actives (aucune désactivée par l'analyseur à ce stade)
- **Scoring V9** : identique V8, ajusté par feedback-analyzer si patterns détectés
- **Matching V6** : fuzzy, zero-padding, variantes Pokemon (V-Max, V-Star, etc.)
- **Vision GPT V9** : detail: auto, prompt "ignore le fond", retry 429, sameCard = productVariantMatch
- **Image matching V3** : crop central 65% avant pHash, minImageSimilarity = 0.40
- **Dashboard V9** : manualOverride, badge "Sans photo eBay", mobile overflow fixé, liens eBay bleu/orange
- **Auto-amélioration** : feedback-analyzer opérationnel, GPT analyse 1x/jour
- **Base de prix** : dédoublonnage URL au stockage, 538 doublons nettoyés sur VPS
- **Portfolio** : 1 item (LEGO 9676, 16.45 EUR → valeur ~64 EUR)
- **Git** : synchronisé local = VPS = GitHub (main branch)

### Prochaines priorités (todo) :
- Observer le taux d'opportunités sur 24-48h après les fixes des 25-26/03
- Analyser les premiers feedbacks via section Apprentissage
- Revente assistée (cross-post eBay/Vinted/Marketplace)
- Facebook Marketplace comme source d'achat
- Augmenter le capital déployé si les opportunités confirment la plus-value

---

## 21. AUDIT DES HEURES DE TRAVAIL

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
| 26/03/2026 | ~4 | GPT prompt fond, retry 429, manualOverride, badge sans photo, mobile overflow, V9 |
| **TOTAL** | **~56** | (quelques commits dupliqués dans branches) |

**Worktrees Claude Code** : ~135 worktrees = ~135 sessions Claude Code

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
| Phase V9 26/03 | 26/03 | ~4 | ~5 | ~800 | 3h | 1h |
| **TOTAL** | | **~58** | **~135** | **~31 600** | **60h** | **21h** |

### Résumé

- **Sessions Claude Code** : ~135 (un worktree = une session)
- **Durée moyenne par session** : 20-30 minutes
- **Total heures Claude Code** : ~60 heures
- **Total heures supervision Justin** : ~21 heures (tests, feedback, décisions)
- **TOTAL PROJET** : **~81 heures de travail**
- **Lignes de code** (src/) : ~31 600 lignes (estimation — fichiers clés : 9305 lignes)
- **Fichiers** : 60+ fichiers (src, agents, scanners, marketplaces)
- **Valeur produite** : bot complet, déployé sur VPS, opérationnel 24/7 avec auto-amélioration

### Contexte de vitesse

Un développeur solo aurait besoin de 4 à 7 mois pour produire ce projet. En travaillant avec Claude Code :
- 15 jours calendaires (12 au 26 mars)
- ~81 heures effectives
- De l'idée au bot avec dashboard, Telegram, GPT Vision V9, auto-amélioration, 9 catégories, scoring V9, image matching v3, prompt "ignore le fond", retry 429, manualOverride, audit 20/20 confirmé
