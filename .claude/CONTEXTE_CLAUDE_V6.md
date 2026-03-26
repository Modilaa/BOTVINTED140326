# CONTEXTE_CLAUDE_V6.md — BOTVINTEDCODEX

## Derniere mise a jour : 2026-03-24

---

## PROJET

Bot d'arbitrage multi-marketplace. Scanne Vinted (BE/FR/DE/ES/IT/NL/PL/UK) pour trouver des articles sous-evalues et les revendre sur eBay. Dashboard temps reel, alertes Telegram, verification GPT Vision.

**Utilisateur** : Justin (francophone, Belgique). Pas developpeur. Guide les priorites, teste le dashboard comme un client. Communiquer en francais.

**Objectif** : 5000 EUR/mois net via arbitrage. Capital de depart : 500 EUR.

---

## VPS & DEPLOIEMENT

- **VPS** : root@76.13.148.209 (Hostinger, Ubuntu 24.04)
- **Projet VPS** : /root/botvintedcodex
- **Dashboard** : http://76.13.148.209:3000
- **PM2** : bot-scanner (scan toutes les 15min via --loop --interval=15)
- **Deployer** : `./deploy-vps.sh` (rsync + npm install + PM2 restart)
- **Deployer fichiers seuls** : `./deploy-vps.sh --files-only`
- **Restart seul** : `./deploy-vps.sh --restart`
- **Deploy rapide** : `scp -r src/* root@76.13.148.209:/root/botvintedcodex/src/ && ssh root@76.13.148.209 "cd /root/botvintedcodex && pm2 restart bot-scanner"`

---

## CODE LOCAL

- **Chemin** : C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX
- **IMPORTANT** : Toujours travailler sur cette copie (pas d'autre dossier)
- **Node.js** : v24.13.0
- **Package manager** : npm

---

## ARCHITECTURE

```
src/
  index.js           — Scanner principal (boucle PM2, rotation pays)
  server.js           — Dashboard Express (port 3000, SSE temps reel)
  dashboard.html      — UI complete (dark theme, Chart.js, RESPONSIVE mobile)
  config.js           — Configuration (searches, seuils, pays)
  scoring.js          — Confiance (0-100, 3 tiers + Chemin B) + Liquidite (0-100)
  matching.js         — Matching titre Vinted <-> eBay (fuzzy, zero-padding, V-Max)
  image-match.js      — pHash, OCR Tesseract, border detection, grid brightness
  vision-verify.js    — GPT-4o mini Vision (verification images auto)
  notifier.js         — Alertes Telegram (opportunites + digest quotidien)
  telegram-handler.js — Callbacks boutons inline Telegram
  profit.js           — Calcul profit (fees eBay 13%, shipping)
  http.js             — HTTP avec proxy (Decodo, ScraperAPI, PROXY_URL)
  price-database.js   — Base de prix persistante (output/price-database.json)
  price-router.js     — Multi-source prix (APIs niche -> eBay -> Apify)
  seen-listings.js    — Cache annonces vues (24h TTL)
  seller-score.js     — Score vendeur Vinted
  api-monitor.js      — Monitoring erreurs API
  scheduler.js        — DESACTIVE (spammait Discovery)

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
    supervisor.js     — Verification disponibilite Vinted
    diagnostic.js     — Diagnostic systeme
    discovery.js      — Decouverte nouvelles categories
    product-explorer.js — Exploration produits
    strategist.js     — Portfolio + strategie
    liquidity.js      — Analyse liquidite
    orchestrator.js   — Pipeline multi-agents

  scanners/
    reverse-scanner.js    — Scan eBay -> Vinted (reverse)
    cardmarket-scanner.js — Scan Cardmarket -> eBay
```

---

## CATEGORIES ACTIVES (9)

Pokemon, Yu-Gi-Oh, LEGO, Topps F1, One Piece, Topps Football, Topps UFC, Topps Tennis, Topps Sport General

---

## SCORING (scoring.js) — VERSION V6

### Confiance (0-100) — Systeme ADDITIF, 4 chemins possibles :

**Tier 1 : Qualite du matching texte (0-40 pts)**
- match.score >= 12 → 40 pts
- match.score >= 8 + source eBay → 40 pts
- match.score >= 8 → 30 pts
- match.score >= 4 + source eBay → 25 pts
- match.score >= 4 → 20 pts
- Sinon → 10 pts
- API niche (pokemon-tcg, ygoprodeck) sans matchedSales → 30 pts de base

**Tier 2 : Fiabilite de la source (0-20 pts)**
- pokemon-tcg-api, ygoprodeck → 20 pts
- local-database (scanCount >= 10) → 20 pts
- ebay-browse-api (3+ ventes) → 20 pts
- ebay-html/ebay (3+ ventes) → 15 pts
- apify-ebay (3+ ventes) → 15 pts
- rebrickable → 10 pts
- default → 5 pts

**Tier 3 : Vision GPT-4o mini (0-40 pts)**
- GPT confirme (sameCard=true) → +40 pts
- GPT rejette (sameCard=false) → SCORE 0 IMMEDIAT (rejet)
- Hash image local >= 0.85 → 25 pts (substitut)
- Hash image local >= 0.75 → 15 pts
- local-database sans image → 15 pts (benefice du doute)

**CHEMIN B : Prix tres en dessous de la moyenne Vinted en base (NEW V6)**
- Necessite >= 3 observations dans price-database.json
- Prix actuel <= 60% de la moyenne → score plancher 95
- Prix actuel <= 70% de la moyenne → score plancher 90
- Prix actuel <= 80% de la moyenne → score plancher 75
- Independant des autres tiers — bonne affaire sans eBay ni GPT

**Hard gate assoupli (V6)**
- GPT rejette → 0 (inchange)
- Sans GPT ET sans signal fort → plafond 49
- "Signal fort" = Chemin B >= 75 OU (textScore>=30 AND sourceScore>=15 AND visionScore>=15)
- Avant V6 : tout etait plafonne a 49 sans GPT (trop restrictif)

**Seuil d'opportunite : confidence >= 50**

### Liquidite (0-100) — 4 facteurs :
- Volume ventes (35%), Vitesse (30%), Stabilite prix (20%), Turnover (15%)

---

## MATCHING (matching.js) — VERSION V6

### Ameliorations V6 :
1. **Zero-padding normalise** : "044" = "44", "044/185" = "44/185" (normalizeComparableToken)
2. **Variantes typographiques Pokemon** : "V-Max" = "vmax", "V-Star" = "vstar", "V-Union" = "vunion" (preprocessing extractCardSignature)
3. **FR->EN translations** : carte/card, booster, coffret/box, etc.
4. **Matching flexible** : 60% des identity tokens suffisent (pas 100%)
5. **Reverse mismatch** : detecte les cartes eBay avec trop de tokens extra

### Scoring match (scoreSoldListing) :
- Chaque token commun = +1 pt
- Token specifique commun = +2 pts
- Token identite commun = +3 pts
- Annee = +3, Numero carte = +4, Print run = +3
- Couverture >= 80% = +3, >= 60% = +1
- missingCritical (annee differente, num carte different, grading different, lot mismatch) = rejet

---

## GPT VISION (vision-verify.js)

- Modele : gpt-4o-mini
- Verifie 3 criteres : sameProduct, sameVariant, conditionComparable
- Champs compat : sameCard (bool), confidence (number), summary (string)
- Auto-verification pendant le scan (index.js ligne ~363)
- Verification manuelle via dashboard (POST /api/verify-image)
- Titre override : si GPT dit variant different mais titres partagent le meme mot-cle de variante -> force match
- Layout fix : plus de conflit de concurrence (une seule verification a la fois par item)

---

## PIPELINE DE PRIX (price-router.js)

1. Cache local (price-database.json, 2h TTL)
2. APIs niche (PokemonTCG, YGOPRODeck, Rebrickable)
3. eBay Browse API officielle
4. eBay scraping (multi-domaines UK/DE/FR/IT/ES)
5. Apify (fallback payant, budget 100 req/scan)

---

## TELEGRAM

- Alertes par opportunite (photo + boutons inline : Acheter/Ignorer/Details)
- Filtre confiance minimum : TELEGRAM_MIN_CONFIDENCE (defaut 50)
- Resume scan : envoye si >= 1 opportunite trouvee
- Digest quotidien : envoye une fois par jour a 20h+ (top 3, stats, categories)
- Callbacks : buy_XXX, ignore_XXX, verify_XXX
- DISCOVERY filtre : messages "DISCOVERY MULTI-CATEGORIES" ignores

---

## PORTFOLIO

- Premier achat : LEGO Star Wars 9676, 16.45 EUR investi, valeur marche ~64 EUR
- Fichier : output/portfolio-items.json
- Dashboard : section portfolio avec bouton "Vendu"

---

## DASHBOARD (server.js + dashboard.html)

- Port 3000, Express, SSE temps reel
- Dark theme, Chart.js (line chart profit/jour + doughnut categories)
- **Responsive mobile** (V6) : media queries < 768px et < 480px
- Sections : Opportunites, Ignorees, Base de prix, Portfolio, Agents, Graphiques
- Filtres dynamiques : categorie, confiance min, statut
- Expiration annonces : tous les 3 scans, verifie 5 opportunites sur Vinted
- Archivage automatique apres 7 jours

---

## BUGS CORRIGES

### Session 23 mars (Dispatch) :
1. Portfolio vide (conflit routes Express) -> CORRIGE
2. Filtre Ignorees casse (API ignorait le parametre status) -> CORRIGE
3. Profit chute pendant scan (calcul sur donnees partielles) -> CORRIGE
4. Bouton loupe sans feedback (pas de loader/toast) -> CORRIGE (spinner + toast)
5. Filtres Base de prix hardcodes -> CORRIGE (dynamiques)
6. Images Vinted cassees (hotlink protection CDN) -> CORRIGE (proxy server-side)
7. GPT Vision auto-dismiss -> IMPLEMENTE
8. Titre override (faux negatifs thumbnails) -> IMPLEMENTE
9. Prompt GPT strict (3 criteres) -> IMPLEMENTE
10. Mini-rapport GPT -> SAUVEGARDE dans historique

### Session 23-24 mars (Claude Code V6) :
11. Source 'ebay'/'ebay-html' non reconnue dans scoring -> CORRIGE (cas 'ebay' ajoute)
12. Rebrickable score trop faible (0 pts) -> CORRIGE (10 pts fixes)
13. Seuils scoring releves -> CORRIGE (ms>=12 = 40pts, ms>=8+ebay = 40pts)
14. Filtre confiance min = 0 par defaut -> CORRIGE (slider dynamique)
15. Expiration annonces 30j -> CORRIGE (7 jours)
16. Agents guards manquants -> AJOUTE (protection double-run)
17. Sections masquees quand vides -> IMPLEMENTE
18. Layout GPT Vision concurrent -> CORRIGE (queue sequentielle)
19. 3 categories ajoutees : Topps UFC, Topps Tennis, Topps Sport General (config.js)
20. Zero-padding matching : "044" = "44" -> CORRIGE (normalizeComparableToken)
21. Variantes typographiques : "V-Max" = "vmax" -> CORRIGE (preprocessing)
22. Hard gate assoupli : Chemin B (prix en dessous moyenne) peut atteindre 90-95 sans GPT
23. Dashboard responsive mobile (iPhone) -> CSS media queries ajoutes

---

## AMELIORATIONS IMPLEMENTEES

### Session 23 mars (Claude Code) :
1. **Images eBay HD** : thumbnails 225px -> 1600px automatiquement (ebay.js)
2. **Confiance GPT boost** : +40pts quand GPT confirme (scoring.js) — BUG CRITIQUE corrige : champ sameCard manquant dans reponse
3. **Auto-verify au scan** : GPT Vision tourne automatiquement pendant chaque scan (index.js)
4. **Enrichissement prix proactif** : tous les 2 scans, enrichit 5 produits avec peu de donnees marche
5. **Expiration annonces** : tous les 3 scans, verifie 5 opportunites actives sur Vinted
6. **Graphiques Chart.js** : line chart profit/jour + doughnut categories
7. **Digest quotidien Telegram** : resume envoye 1x/jour a 20h+
8. **Fix SSL VPS** : NODE_OPTIONS=--use-openssl-ca dans ecosystem.config.js

### Session 24 mars (Claude Code V6) :
9. **Refonte scoring additif** : 4 chemins, hard gate assoupli, Chemin B (moyenne Vinted)
10. **Fuzzy matching** : zero-padding, variantes typographiques, tolerance accents
11. **Dashboard mobile** : responsive iPhone, media queries, tableaux scrollables

---

## REGLES DE TRAVAIL

- **Matching strict** : pas de faux positifs, mieux vaut rater une opportunite que d'en montrer une fausse
- **Une tache a la fois** : ne pas tout changer en meme temps
- **Bonne copie** : toujours Desktop/Dispatch/BOTVINTEDCODEX
- **Deployer apres chaque modif** : `scp -r src/* root@76.13.148.209:/root/botvintedcodex/src/ && ssh root@76.13.148.209 "cd /root/botvintedcodex && pm2 restart bot-scanner"`
- **Verifier la syntaxe** : `node --check src/index.js && node --check src/server.js` avant deploy
- **Scheduler desactive** : les agents ne tournent que manuellement via le dashboard
- **Pas de Discovery auto** : les messages "DISCOVERY MULTI-CATEGORIES" sont filtres dans notifier.js

---

## COMMANDES UTILES

```bash
# Verifier syntaxe
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

# Verifier dashboard
curl http://76.13.148.209:3000

# Voir les opportunites en JSON
curl http://76.13.148.209:3000/api/opportunities | head -c 500
```

---

## POUR REPRENDRE UNE SESSION

1. Lire ce fichier CONTEXTE_CLAUDE_V6.md (charge automatiquement si renomme CLAUDE.md)
2. `git status` pour voir les changements locaux en cours
3. `ssh root@76.13.148.209 "pm2 list"` pour verifier que le bot tourne
4. `ssh root@76.13.148.209 "pm2 logs bot-scanner --lines 20"` pour voir les derniers logs
5. Ouvrir le dashboard : http://76.13.148.209:3000
6. Verifier le scoring en cours : chercher `[vision-auto]` et `[no-opportunity]` dans les logs

### Etat du projet au 24/03/2026 :
- Bot tourne sur VPS, scan toutes les 15 min
- 9 categories actives
- Scoring V6 : 4 chemins, hard gate assoupli
- Matching V6 : fuzzy, zero-padding, variantes Pokémon
- Dashboard : responsive mobile, graphiques, filtres dynamiques
- Portfolio : 1 item (LEGO 9676)
- Base de prix : accumule des donnees Vinted et marche a chaque scan

### Prochaines priorites (todo) :
- Revente assistee (cross-post eBay/Vinted/Marketplace)
- Facebook Marketplace comme source d'achat
- Analyser le ratio d'opportunites trouves apres refonte scoring V6
