# CLAUDE.md — BOTVINTEDCODEX

## Derniere mise a jour : 2026-03-23

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
  dashboard.html      — UI complete (dark theme, Chart.js)
  config.js           — Configuration (searches, seuils, pays)
  scoring.js          — Confiance (0-100, 3 tiers) + Liquidite (0-100)
  matching.js         — Matching titre Vinted <-> eBay
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
    ebay.js           — Scraper eBay sold listings (multi-domaines)
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

## SCORING (scoring.js)

**Confiance (0-100)** — 3 tiers :
- Tier 1 : Matching texte (0-40 pts)
- Tier 2 : Fiabilite source (0-20 pts)
- Tier 3 : Vision GPT-4o mini (0-40 pts) — le facteur decisif
- GPT confirme = +40. GPT rejette = score 0 immediat.
- Seuil d'opportunite : confidence >= 50

**Liquidite (0-100)** — 4 facteurs :
- Volume ventes (35%), Vitesse (30%), Stabilite prix (20%), Turnover (15%)

---

## GPT VISION (vision-verify.js)

- Modele : gpt-4o-mini
- Verifie 3 criteres : sameProduct, sameVariant, conditionComparable
- Champs compat : sameCard (bool), confidence (number), summary (string)
- Auto-verification pendant le scan (index.js ligne ~363)
- Verification manuelle via dashboard (POST /api/verify-image)
- Titre override : si GPT dit variant different mais titres partagent le meme mot-cle de variante -> force match

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

---

## PORTFOLIO

- Premier achat : LEGO Star Wars 9676, 16.45 EUR investi, valeur marche ~64 EUR
- Fichier : output/portfolio-items.json
- Dashboard : section portfolio avec bouton "Vendu"

---

## BUGS CORRIGES (session 23 mars - Dispatch)

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

---

## AXES D'AMELIORATION (session 23 mars - Claude Code)

### Implementes :
1. **Images eBay HD** : thumbnails 225px -> 1600px automatiquement (ebay.js)
2. **Confiance GPT boost** : +40pts quand GPT confirme (scoring.js)
   - BUG CRITIQUE CORRIGE : le champ `sameCard` n'existait jamais dans la reponse GPT -> scores jamais boostes. Fix : ajout champs compat dans vision-verify.js
3. **Auto-verify au scan** : GPT Vision tourne automatiquement pendant chaque scan (index.js)
4. **Enrichissement prix proactif** : tous les 2 scans, enrichit 5 produits avec peu de donnees marche (index.js + price-database.js)
5. **Expiration annonces** : tous les 3 scans, verifie 5 opportunites actives sur Vinted (index.js)
6. **Graphiques Chart.js** : line chart profit/jour + doughnut categories (server.js + dashboard.html)
7. **Digest quotidien Telegram** : resume envoye 1x/jour a 20h+ (notifier.js + index.js)
8. **Fix SSL VPS** : NODE_OPTIONS=--use-openssl-ca dans ecosystem.config.js

### A faire plus tard :
- Revente assistee (cross-post eBay/Vinted/Marketplace)
- Facebook Marketplace comme source d'achat (en dernier)

---

## REGLES DE TRAVAIL

- **Matching strict** : pas de faux positifs, mieux vaut rater une opportunite que d'en montrer une fausse
- **Une tache a la fois** : ne pas tout changer en meme temps
- **Bonne copie** : toujours Desktop/Dispatch/BOTVINTEDCODEX
- **Deployer apres chaque modif** : deploy-vps.sh
- **Verifier la syntaxe** : node --check src/index.js && node --check src/server.js avant deploy
- **Scheduler desactive** : les agents ne tournent que manuellement via le dashboard (spammaient Telegram)
- **Pas de Discovery auto** : les messages "DISCOVERY MULTI-CATEGORIES" sont filtres dans notifier.js

---

## COMMANDES UTILES

```bash
# Verifier syntaxe
node --check src/index.js && node --check src/server.js

# Deployer
./deploy-vps.sh

# SSH sur le VPS
ssh root@76.13.148.209

# Logs PM2
ssh root@76.13.148.209 "pm2 logs bot-scanner --lines 50"

# Status PM2
ssh root@76.13.148.209 "pm2 list"

# Restart PM2
./deploy-vps.sh --restart
```

---

## POUR REPRENDRE UNE SESSION

1. Ce fichier CLAUDE.md est charge automatiquement par Claude Code
2. Verifier git status pour voir les changements en cours
3. Verifier si le bot tourne : ssh root@76.13.148.209 "pm2 list"
4. Ouvrir le dashboard : http://76.13.148.209:3000
