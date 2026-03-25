# CONTEXTE CLAUDE V10 — BOTVINTEDCODEX

> Dernière mise à jour : 2026-03-26
> Généré automatiquement par Claude Sonnet 4.6 pour transmission de contexte entre sessions.

---

## 1. PRÉSENTATION PROJET

**Objectif** : Bot d'arbitrage multi-marketplace. Scanne Vinted (BE/FR/DE/ES/IT/NL/PL/UK) pour trouver des articles sous-évalués et les revendre sur eBay. Dashboard temps réel, alertes Telegram, vérification GPT Vision.

**Utilisateur** : Justin (francophone, Belgique). Pas développeur. Guide les priorités, teste le dashboard comme un client. **Communiquer en français.**

**Objectif financier** : 5000 EUR/mois net via arbitrage. Capital de départ : 500 EUR.

**Stack technique** :
- Node.js v24.13.0
- npm (package manager)
- Express.js (dashboard port 3000)
- PM2 (process manager sur VPS)
- OpenAI API (GPT-4o mini Vision)
- Sharp + Tesseract.js (traitement images)
- Chart.js (graphiques dashboard)
- Telegram Bot API (alertes)

---

## 2. VPS & DÉPLOIEMENT

| Paramètre | Valeur |
|-----------|--------|
| IP | `76.13.148.209` |
| Hébergeur | Hostinger |
| OS | Ubuntu 24.04 |
| Chemin projet | `/root/botvintedcodex` |
| Dashboard | `http://76.13.148.209:3000` |
| Process PM2 | `bot-scanner` |
| Boucle scan | toutes les 15 min (`--loop --interval=15`) |

### Commandes deploy

```bash
# Deploy complet (rsync + npm install + PM2 restart)
./deploy-vps.sh

# Deploy fichiers seulement (sans npm install ni restart)
./deploy-vps.sh --files-only

# Restart seul
./deploy-vps.sh --restart

# Deploy dashboard.html seul (fichier statique — pas besoin de restart PM2)
scp src/dashboard.html root@76.13.148.209:/root/botvintedcodex/src/

# Deploy fichiers spécifiques
scp src/scoring.js src/agents/evaluator.js root@76.13.148.209:/root/botvintedcodex/src/
```

### SSH & PM2

```bash
# SSH
ssh root@76.13.148.209

# Logs PM2 (50 dernières lignes)
ssh root@76.13.148.209 "pm2 logs bot-scanner --lines 50"

# Status PM2
ssh root@76.13.148.209 "pm2 list"

# Restart PM2
ssh root@76.13.148.209 "cd /root/botvintedcodex && pm2 restart bot-scanner"
```

---

## 3. CODE LOCAL

- **Chemin** : `C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX`
- **IMPORTANT** : Toujours travailler sur cette copie (pas d'autre dossier)
- **Node.js** : v24.13.0
- **Package manager** : npm
- **GitHub** : https://github.com/Modilaa/BOTVINTED140326.git

### Vérification syntaxe avant deploy

```bash
node --check src/index.js && node --check src/server.js
```

---

## 4. ARCHITECTURE V10 — ARBORESCENCE COMPLÈTE

```
src/
  index.js               — Scanner principal (boucle PM2, rotation pays)
  server.js              — Dashboard Express (port 3000, SSE temps réel)
  dashboard.html         — UI complète (dark theme, Chart.js, mobile responsive)
  config.js              — Configuration (searches, seuils, pays, .env loader)
  scoring.js             — Confiance (0-100, 3 tiers) + Liquidité (0-100)
  matching.js            — Matching titre Vinted ↔ eBay (fuzzy, FR→EN, variantes)
  image-match.js         — pHash v3, OCR Tesseract, crop 65%, histogramme couleur
  vision-verify.js       — GPT-4o mini Vision (3 critères stricts, prompt détaillé)
  notifier.js            — Alertes Telegram (opportunités + digest quotidien)
  telegram-handler.js    — Callbacks boutons inline Telegram
  profit.js              — Calcul profit (fees eBay 13%, shipping Vinted 3.5€, eBay 4.5€)
  http.js                — HTTP avec proxy (Decodo, ScraperAPI, PROXY_URL)
  price-database.js      — Base de prix persistante (output/price-database.json, 2h TTL)
  price-router.js        — Multi-source prix (APIs niche → eBay → Apify)
  seen-listings.js       — Cache annonces vues (24h TTL)
  seller-score.js        — Score vendeur Vinted
  api-monitor.js         — Monitoring erreurs API
  feedback-learner.js    — Règles apprises via feedbacks utilisateur (pénalités)
  description-enricher.js — Enrichissement titre depuis description Vinted
  underpriced.js         — Détection sous-évaluation par rapport à base locale
  utils.js               — Helpers (normalizeSpaces, toSlugTokens, sleep...)

  marketplaces/
    vinted.js             — Scraper Vinted (multi-pays, pagination, proxy)
    ebay.js               — Scraper eBay sold listings (multi-domaines, images HD)
    pokemon-tcg.js        — API PokemonTCG.io + TCGdex
    ygoprodeck.js         — API YGOPRODeck (Yu-Gi-Oh)
    pokemontcg-api.js     — API PokemonTCG.io directe (clé API optionnelle)
    ebay-api.js           — eBay Browse API officielle (OAuth)
    cardmarket.js         — Scraper Cardmarket
    leboncoin.js          — Scraper Leboncoin
    lego-api.js           — Rebrickable API (LEGO) + eBay
    facebook.js           — Facebook Marketplace (expérimental)
    apify-ebay.js         — Apify fallback payant (budget 100 req/scan)
    discogs-api.js        — API Discogs (vinyles)
    sneaks-api.js         — API sneakers market

  agents/
    supervisor.js         — Vérification disponibilité Vinted + extraction langue carte
    diagnostic.js         — Diagnostic système
    discovery.js          — Découverte nouvelles catégories (DÉSACTIVÉ en auto)
    product-explorer.js   — Exploration produits
    strategist.js         — Portfolio + stratégie
    liquidity.js          — Analyse liquidité
    orchestrator.js       — Pipeline multi-agents + Sprint Contracts + health check
    scanner.js            — Agent Scanner (scrape sources, price-router, candidats bruts)
    evaluator.js          — Agent Évaluateur (scoring, vision GPT, décision finale)

  scanners/
    reverse-scanner.js    — Scan eBay → Vinted (reverse arbitrage)
    cardmarket-scanner.js — Scan Cardmarket → eBay
```

---

## 5. ARCHITECTURE MULTI-AGENTS V10

### Vue d'ensemble

```
Orchestrateur
     │
     ├─ écrit sprint-contract.json (critères du scan)
     │
     ├─→ Agent Scanner (scanner.js)
     │        │  lit sprint-contract.json
     │        │  scrape Vinted/Cardmarket/Leboncoin/Facebook
     │        │  price-router pour chaque listing
     │        └─→ écrit scanner-results.json (candidats bruts)
     │
     ├─→ Agent Évaluateur (evaluator.js)
     │        │  lit scanner-results.json + sprint-contract.json
     │        │  scoring complet (texte + vision + liquidité)
     │        │  seuils durs par critère
     │        │  vision GPT si profit > 10€ et budget restant
     │        ├─→ écrit evaluated-opportunities.json
     │        ├─→ écrit evaluator-health.json
     │        ├─→ écrit evaluator-feedback.json (rejets → feedback Scanner)
     │        └─→ écrit vision-budget.json
     │
     └─ health check → met à jour orchestrator-decisions.json
```

### Fichiers de communication inter-agents

| Fichier | Écrit par | Lu par |
|---------|-----------|--------|
| `output/sprint-contract.json` | Orchestrateur | Scanner + Évaluateur |
| `output/scanner-results.json` | Scanner | Évaluateur |
| `output/evaluated-opportunities.json` | Évaluateur | Orchestrateur + Dashboard |
| `output/evaluator-health.json` | Évaluateur | Orchestrateur + Dashboard |
| `output/evaluator-feedback.json` | Évaluateur | Scanner (Pattern 4) |
| `output/query-corrections.json` | Scanner | Scanner (historique) |
| `output/orchestrator-decisions.json` | Orchestrateur | Évaluateur (disable_vision, etc.) |
| `output/vision-budget.json` | Évaluateur | Évaluateur (reset quotidien) |
| `output/latest-scan.json` | index.js | Dashboard (SSE) |
| `output/price-database.json` | price-database.js | price-router + scoring |
| `output/portfolio-items.json` | server.js | Dashboard |
| `output/feedback-log.json` | Dashboard/Telegram | Orchestrateur (Pattern 3) |

### Scheduler

**DÉSACTIVÉ** : les agents (Discovery, Strategist, etc.) ne tournent que manuellement via le dashboard. L'auto-exécution spammait Telegram.

---

## 6. PATTERNS ANTHROPIC V10

### Pattern 1 — Sprint Contracts (Orchestrateur → Scanner + Évaluateur)

Avant chaque cycle, l'Orchestrateur génère `output/sprint-contract.json` avec :
```json
{
  "sprintId": "sprint-2026-03-26-1430",
  "generatedAt": "ISO string",
  "criteria": {
    "minMatchScore": 4,
    "requiredFields": ["ebayMatchImageUrl"],
    "legoRequiresSetNumber": true,
    "cardsRequireVariantMatch": true,
    "minProfitLego": 50,
    "minProfitOther": 15,
    "maxAcceptableVisionErrorRate": 0.5
  },
  "queryAdjustments": [...]
}
```

Scanner et Évaluateur lisent ce contrat et adaptent leur comportement.

### Pattern 2 — Feedback Loop Évaluateur → Scanner

Pour chaque rejet, l'Évaluateur écrit dans `output/evaluator-feedback.json` :
```json
{
  "feedbacks": [
    {
      "timestamp": "ISO string",
      "title": "titre listing",
      "category": "Pokemon",
      "reason": "variant_mismatch",
      "suggestion": "query_should_add_variant_tokens"
    }
  ]
}
```
Max 200 feedbacks. Le Scanner lit les feedbacks des 48 dernières heures pour adapter ses queries.

### Pattern 3 — Confidence Tuning

L'Orchestrateur analyse `output/feedback-log.json` :
- Si > 70% rejets pour la même raison dans une catégorie → ajustement du contrat sprint
- `variant_mismatch` → `cardsRequireVariantMatch: true` + token rareté dans queries
- `prix_non_fiable` → `minObservations: 2` requis

### Pattern 4 — Query Corrections

Le Scanner applique les corrections des `queryAdjustments` du sprint contract :
- `add_rarity_tokens` : ajouter tokens de rareté aux queries
- `require_min_observations` : ignorer prix avec < 2 observations
- `force_set_number_search` : recherche LEGO par numéro de set
- `add_variant_tokens` : ajouter tokens variante (refractor, holo, etc.)

Historique sauvegardé dans `output/query-corrections.json`.

### Pattern 5 — Hard Criteria (Seuils durs)

L'Évaluateur applique des seuils durs par critère. **Un seul échec = rejet immédiat** (pas de score partiel) :

| Critère | Condition de passage | Valeur par défaut |
|---------|---------------------|-------------------|
| `profitMinCategory` | Profit >= sprint.minProfitLego (LEGO) ou sprint.minProfitOther | LEGO: 50€, Autres: 15€ |
| `profitEur` | Profit >= config.minProfitEur | 5€ |
| `profitPct` | Marge >= config.minProfitPercent | 20% |
| `priceReliable` | isPriceFromApi OU observations >= 2 | — |
| `confidence` | confidence >= minConfidence | 50 |
| `liquidity` | liquidityScore >= minLiq | 0 |
| `noVariantMismatch` | !row.variantMismatch (si cardsRequireVariantMatch) | true |
| `legoSetNumber` | Pas de conflit numéro set (si legoRequiresSetNumber) | true |

---

## 7. CATÉGORIES ACTIVES

### Toujours actives (4 TCG)

| Catégorie | Source prix | maxPrice | Queries actives |
|-----------|-------------|----------|-----------------|
| Topps F1 | eBay | 120€ | topps chrome f1, topps formula 1, turbo attax, etc. |
| Pokemon | PokemonTCG API | 150€ | carte rare, PSA, illustration rare, japonaise, gold, etc. |
| One Piece TCG | eBay | 100€ | card game, tcg carte, rare, alt art, OP13, etc. |
| Yu-Gi-Oh | YGOPRODeck | 100€ | starlight rare, quarter century secret, ghost rare, etc. |

### Activables via .env

| Variable | Catégorie | minProfit | maxPrice |
|----------|-----------|-----------|----------|
| `SEARCH_TOPPS_FOOTBALL=true` | Topps Chrome Football | — | 120€ |
| `SEARCH_PANINI=true` | Panini Football | — | 120€ |
| `SEARCH_TOPPS_UFC=true` | Topps UFC | — | 120€ |
| `SEARCH_TOPPS_TENNIS=true` | Topps Tennis | — | 120€ |
| `SEARCH_TOPPS_SPORT_GENERAL=true` | Topps Sport General | — | 120€ |
| `SEARCH_SNEAKERS=true` | Sneakers | 15€ | 150€ |
| `SEARCH_LEGO=true` | LEGO | 10€ | 120€ |
| `SEARCH_VINTAGE=true` | Vêtements Vintage | 10€ | 100€ |
| `SEARCH_TECH=true` | Tech | 20€ | 200€ |
| `SEARCH_RETRO=true` | Consoles Retro | 10€ | 120€ |
| `SEARCH_VINYLES=true` | Vinyles | 5€ | 60€ |

---

## 8. PIPELINE COMPLET (Scan → Opportunité)

```
1. index.js : boucle principale
   ├── writeSprintContract() — génère le contrat sprint
   ├── runScanner() — Agent Scanner
   │   ├── Pour chaque catégorie active :
   │   │   ├── getVintedListings(query, pays) × N queries
   │   │   ├── Filtre doublons + manga/livre
   │   │   ├── enrichTitleFromDescription() si possible
   │   │   └── getPriceViaRouter(listing) — multi-source
   │   │       ├── Cache local (2h TTL)
   │   │       ├── API niche (PokemonTCG / YGOPRODeck / Rebrickable)
   │   │       ├── eBay Browse API officielle
   │   │       ├── eBay scraping HTML (multi-domaines)
   │   │       └── Apify (fallback, 100 req/scan max)
   │   ├── Calcul profit + marge (profit.js)
   │   ├── Score vendeur (seller-score.js)
   │   └── Écriture scanner-results.json
   │
   ├── runEvaluator() — Agent Évaluateur
   │   ├── Lit scanner-results.json
   │   ├── Lit sprint-contract.json
   │   ├── Lit orchestrator-decisions.json (disable_vision ?)
   │   ├── Pour chaque candidat :
   │   │   ├── computeConfidence(opp) — scoring 3 tiers
   │   │   ├── computeLiquidity(opp) — liquidité 4 facteurs
   │   │   ├── Vision GPT si :
   │   │   │   ├── profit > 10€ (VISION_MIN_PROFIT_FOR_CHECK)
   │   │   │   ├── budget non dépassé (< 100 cents/jour)
   │   │   │   └── pas de décision disable_vision active
   │   │   ├── evaluateCriteria() — seuils durs Pattern 5
   │   │   ├── Si tous critères OK → opportunité validée
   │   │   └── Sinon → writeEvaluatorFeedback(raison)
   │   ├── Écriture evaluated-opportunities.json
   │   └── Écriture evaluator-health.json + vision-budget.json
   │
   ├── Merge evaluated-opportunities + latest-scan.json
   ├── Alertes Telegram pour nouvelles opportunités
   ├── Tous les 2 scans : enrichissement prix 5 produits
   └── Tous les 3 scans : vérification expiration 5 opportunités
```

---

## 9. SCORING V10 (scoring.js)

### Score de Confiance (0-100)

#### Tier 1 — Qualité matching texte (0-40)

| Score match | Source eBay | Tier 1 points |
|-------------|-------------|---------------|
| >= 12 | any | 40 pts |
| >= 8 | eBay | 40 pts |
| >= 8 | autre | 30 pts |
| >= 4 | eBay | 25 pts |
| >= 4 | autre | 20 pts |
| < 4 | any | 10 pts |
| 0 ventes | API niche/local-db | 30 pts |

#### Tier 2 — Fiabilité source (0-20)

| Source | Points |
|--------|--------|
| pokemon-tcg-api, ygoprodeck | 20 |
| local-database (>= 10 scans) | 20 |
| local-database (5-9 scans) | 15 |
| local-database (3-4 scans) | 10 |
| ebay-browse-api (>= 3 ventes) | 20 |
| ebay-html / ebay (>= 3 ventes) | 15 |
| apify-ebay (>= 3 ventes) | 15 |
| rebrickable | 10 |
| autres | 5 |

#### Tier 3 — Vision / Hash image (0-40)

| Condition | Points |
|-----------|--------|
| GPT confirme (sameCard=true) | 40 |
| GPT rejette (sameCard=false) | **score = 0 immédiat** |
| Hash local >= 0.85 (ou 0.60 si budget skip) | 25 |
| Hash local >= 0.75 (ou 0.40 si budget skip) | 15 |
| local-database (bénéfice du doute) | 15 |
| Pas d'image | 0 |

#### Chemin B — Prix sous la moyenne Vinted (boost plancher)

Si ≥ 3 observations Vinted en base et prix actuel très bas :

| Ratio prix / moyenne | Boost plancher |
|----------------------|----------------|
| <= 0.60 (40%+ en dessous) | **95** |
| <= 0.70 (30%+ en dessous) | **90** |
| <= 0.80 (20%+ en dessous) | **75** |

#### Hard Gate

Sans GPT confirmé ET sans signal fort → **plafond = 59**

Signal fort = Chemin B >= 75 OU (textScore>=30 + sourceScore>=15 + visionScore>=15) OU (local-db + textScore>=30 + visionScore>=15)

#### Pénalités

- Règles apprises via `feedback-learner.js` (pénalité variable)
- Vendeur score < 20 → plafond 40 (ou 60 si Chemin B >= 90)

### Score de Liquidité (0-100)

| Facteur | Poids | Calcul |
|---------|-------|--------|
| Volume ventes (soldCount) | 35% | 0→0, 1-2→15, 3-5→30, 6-10→60, 11-20→80, >20→100 |
| Vitesse (intervalle moyen entre ventes) | 30% | <1j→100, <3j→80, <7j→60, <14j→40, sinon→20 |
| Stabilité prix (CV) | 20% | <0.1→100, <0.2→80, <0.3→60, <0.5→40, sinon→20 |
| Turnover annonces (expired ratio) | 15% | >=0.7→100, >=0.5→80, >=0.3→60, >=0.1→40, sinon→20 |

Classification liquidité : flash (>=80), rapide (>=60), normal (>=40), lent (>=20), très lent (>=0)

---

## 10. MATCHING V10 (matching.js)

### Algorithme général

1. **Tokenisation** : normalisation unicode, NFD, suppression accents, lowercase
2. **Traduction FR→EN** : map 80+ termes (carte→card, rare→rare, etc.)
3. **Stop words** : suppression mots génériques (card, rare, fr, topps, etc.)
4. **Score = Σ poids tokens** :
   - Token identité (joueur, set, numéro) : poids fort
   - Token variante (refractor, holo, gold) : poids moyen
   - Token condition (mint, graded) : poids faible

### Zéro-padding

Les numéros de cartes sont normalisés : `25` → `025`, `025` → `025`

### Variantes TCG reconnues

Tokens de rareté qui influencent le matching : starlight, ghost, prismatic, quarter century, collector, ultimate, gold, silver, refractor, prizm, holo, SIR, AR, IR, etc.

### LEGO

- Extraction numéro de set via regex `\b\d{4,6}\b` dans titre
- `extractLegoSetNumber()` prioritise les numéros entre 4 et 6 chiffres
- Match strict sur numéro de set si disponible

### Traductions FR→EN (liste non-exhaustive)

```
carte → card          rare → rare           secrete → secret
holographique → holo  doree → gold          numerotee → numbered
autographe → autograph refracteur → refractor debutant → rookie
recrue → rookie       complet → complete    boite → box
```

---

## 11. COMPARAISON IMAGES V4 (image-match.js)

### Pipeline compareImages

```
Image A (Vinted) + Image B (eBay)
    │
    ├─ Crop center 65% des deux (supprime fond)
    │   fraction = 0.65, retire ~17.5% chaque bord
    │
    ├─ pHash (FINGERPRINT_VERSION = 3)
    │   ├─ averageHash : 16×16 pixels → threshold → bitstring 256 bits
    │   ├─ differenceHash : 17×16 → gradient horizontal → 256 bits
    │   └─ averageColor : 4×4 RGB → couleur dominante
    │
    ├─ OCR Tesseract.js (lazy init, singleton)
    │   └─ Si OCR disponible + texte trouvé → override score si texte donne sameProduct clair
    │
    ├─ Histogramme couleur (colorSimilarity)
    │   └─ distance Manhattan normalisée
    │
    └─ Score final : pondération hammingSimilarity + colorSimilarity
```

### Seuils de confiance image

| Score | Label |
|-------|-------|
| >= 0.78 | high |
| >= 0.64 | medium |
| < 0.64 | low |

### Cache fingerprints

- Chemin : `output/img-cache/<sha1-url>.json`
- TTL : `cacheTtlSeconds` (3600s = 1h par défaut)
- Invalidation : si `FINGERPRINT_VERSION` change → re-calcul forcé

---

## 12. GPT VISION V10 (vision-verify.js)

### Configuration

| Paramètre | Valeur |
|-----------|--------|
| Modèle | `gpt-4o-mini` |
| `detail` | `auto` |
| Retry backoff | 1s, 3s, 8s (sur 429) |
| Timeout | 30s |

### Prompt strict (3 critères)

1. **SAME PRODUCT** : même joueur/personnage, même numéro de carte, même set/année. Différence mineure = NOT same product.
2. **SAME VARIANT/EDITION** : base ≠ holo ≠ refractor ≠ prizm ≠ gold. Incertitude → false.
3. **COMPARABLE CONDITION** : différence condition significative → false.

**IMPORTANT** : Le fond Vinted est toujours différent du fond eBay. IGNORER LE FOND COMPLÈTEMENT.

### Format de réponse JSON

```json
{
  "sameProduct": true,
  "sameVariant": true,
  "conditionComparable": true,
  "verdict": "match",
  "reason": "explication courte",
  "report": {
    "vintedObservation": "description image Vinted",
    "referenceObservation": "description image eBay",
    "differences": ["liste différences détectées"],
    "suggestion": "suggestion amélioration programme"
  }
}
```

### Champs de compatibilité

Le champ `sameCard` est un alias calculé :
```js
visionResult.sameCard = (result.sameProduct && result.sameVariant && result.conditionComparable) === true
```

### Images eBay HD

Les URLs eBay sont upgradées automatiquement :
```
s-l225.jpg → s-l1600.jpg  (ebay.js toHdEbayUrl)
s-l500.jpg → s-l1600.jpg  (vision-verify.js toHdEbayUrl)
```

---

## 13. BUDGET CAP VISION (evaluator.js)

### Fichier output/vision-budget.json

```json
{
  "date": "2026-03-26",
  "callsToday": 12,
  "estimatedCostCents": 36
}
```

Reset automatique chaque jour (comparaison date ISO).

### Logique skip

```
shouldSkipVisionBudget(row, budget) :
  - profit < VISION_MIN_PROFIT_FOR_CHECK (10€) → skip, reason: 'profit_too_low'
  - budget.estimatedCostCents + VISION_COST_PER_CALL_CENTS > VISION_DAILY_BUDGET_CENTS → skip, reason: 'budget_exceeded'
```

### Variables .env

| Variable | Défaut | Description |
|----------|--------|-------------|
| `VISION_DAILY_BUDGET_CENTS` | 100 | Budget max journalier (100 = 1$/jour) |
| `VISION_MIN_PROFIT_FOR_CHECK` | 10 | Profit minimum pour déclencher Vision |
| `VISION_COST_PER_CALL_CENTS` | 3 | Coût estimé par appel GPT (~2 images) |

**Important** : Un skip budgétaire n'est PAS une erreur Vision. L'Orchestrateur ne le compte pas dans `visionErrorRate`. L'item reçoit `visionSkippedBudget: true` et le scoring utilise le hash local avec seuils assouplis (0.60 au lieu de 0.85).

---

## 14. PIPELINE DE PRIX (price-router.js)

### Chaîne de priorité

```
Pokémon  : PokemonTCG.io → TCGdex → eBay Browse API → eBay HTML → Apify
Yu-Gi-Oh : YGOPRODeck → eBay Browse API → eBay HTML → Apify
LEGO     : Rebrickable + eBay Browse API → eBay HTML → Apify
Autres   : eBay Browse API → eBay HTML → Apify
```

### Cache en mémoire

- TTL : 2 heures (`PRICE_CACHE_TTL_MS = 2h`)
- Max size : 500 entrées (clear complet si dépassé)
- Clé : titre normalisé (lowercase, espaces normalisés, 120 chars max)
- Si `enrichedTitle` disponible → priorité sur `title` pour la clé de cache

### eBay URLs multi-domaines

```
https://www.ebay.co.uk  (principal)
https://www.ebay.de
https://www.ebay.fr
https://www.ebay.it
https://www.ebay.es
```

### Apify

- Fallback payant uniquement
- Budget : 100 req/scan max
- `getApifyEbaySoldPrices()` dans `marketplaces/apify-ebay.js`

### Taux de change

- USD → EUR : 0.865 (config)
- GBP → EUR : 1.153 (config)

---

## 15. TELEGRAM

### Alertes opportunités

- Photo Vinted + description + prix achat/revente/profit
- Boutons inline : Acheter (💰) / Ignorer (❌) / Détails (📊)
- Filtre confiance minimum : `TELEGRAM_MIN_CONFIDENCE` (défaut 50)

### Digest quotidien

- Envoyé 1x/jour après 20h
- Top 3 opportunités + stats catégories
- Déclenché dans `index.js` si `lastDigestDate != aujourd'hui` et `hour >= 20`

### Résumé scan

- Envoyé après chaque scan si >= 1 opportunité trouvée

### Callbacks Telegram (telegram-handler.js)

| Callback | Action |
|----------|--------|
| `buy_XXX` | Marque comme achetée, ajoute au portfolio |
| `ignore_XXX` | Ignore l'opportunité |
| `verify_XXX` | Déclenche vérification GPT Vision manuelle |

### Filtres anti-spam

- Messages "DISCOVERY MULTI-CATEGORIES" filtrés dans `notifier.js`
- Scheduler désactivé

---

## 16. DASHBOARD V10 (dashboard.html + server.js)

### Sections du dashboard

| Section | Description |
|---------|-------------|
| **Header** | Logo, status badge (online/scanning/offline), bouton Scanner, badges quotas |
| **KPI Cards** | Profit estimé total, Opportunités actives, Annonces scannées, Taux de réussite |
| **Charts** | Line chart profit/jour + Doughnut répartition catégories (Chart.js 4.4.1) |
| **Agents manuels** | Cartes pour chaque agent (Superviseur, Discovery, Diagnostic, etc.) |
| **Opportunités** | Tableau filtrable (En attente / Acceptées / Ignorées / Expirées) |
| **Orchestrateur V10** | Collapsible : métriques Scanner/Évaluateur, budget Vision, décisions actives |
| **Portfolio** | Items achetés, valeur actuelle, profit latent, bouton Vendu |
| **Base de prix** | Collapsible : table produits avec spread, obs, tendances |
| **Apprentissage** | Collapsible : feedbacks, rapport auto-amélioration, ajustements |
| **Stats par niche** | Barres de profit par catégorie |
| **Historique scans** | Timeline des scans récents |

### Colonnes tableau opportunités

`Image | Titre | Niche* | Source* | Prix achat | Prix revente | Profit net | Liquidité* | Confiance | Statut* | Liens* | Actions`

*colonnes cachées sur mobile (≤768px) via CSS nth-child

### Mobile responsive

- Viewport : `<meta name="viewport" content="width=device-width, initial-scale=1">`
- KPI : 2x2 grid sur mobile (≤768px), 1 colonne sur très petit (≤480px)
- Tableau : scroll horizontal `-webkit-overflow-scrolling: touch`, colonnes non-essentielles cachées sur mobile
- Boutons action : 44px min (tactile)
- Charts : `responsive: true, maintainAspectRatio: false`
- Orchestrateur health grid : 1 colonne sur mobile
- Feedback modal : `max-width: 92vw`
- Media queries : `@media (max-width: 768px)` et `@media (max-width: 480px)`

### SSE (Server-Sent Events)

Le dashboard reçoit les mises à jour en temps réel via `/events` (SSE).
Events : `scan-progress`, `scan-complete`, `new-opportunity`

### Endpoints API (server.js)

```
GET  /api/stats               — Statistiques globales
GET  /api/opportunities       — Liste opportunités (avec filtres)
POST /api/scan                — Déclenche un scan
POST /api/accept/:id          — Accepter opportunité
POST /api/ignore/:id          — Ignorer opportunité
POST /api/verify-image        — Vérification GPT Vision manuelle
GET  /api/price-database      — Base de prix
GET  /api/scan-history        — Historique scans
GET  /api/portfolio           — Portfolio items
POST /api/portfolio           — Ajouter au portfolio
POST /api/portfolio/:id/sold  — Marquer comme vendu
GET  /api/orchestrator-health — Santé orchestrateur (Scanner + Évaluateur)
GET  /api/vision-budget       — Budget Vision du jour
GET  /api/feedback-log        — Log feedbacks
POST /api/feedback-analysis   — Relancer analyse feedbacks
GET  /image-proxy             — Proxy images Vinted (contourne hotlink protection)
```

---

## 17. SYSTÈME AUTO-AMÉLIORATION

### feedback-learner.js

- Lit `output/feedback-log.json` (actions utilisateur + Telegram)
- Génère des règles de pénalité sur les patterns de rejet récurrents
- `applyLearnedRules(vintedTitle, ebayTitle)` → renvoie pénalité (0 à -20)

### Rapport auto-amélioration

- Sauvegardé dans `output/feedback-analysis.json`
- Visible dans le dashboard section "Apprentissage"
- Déclenché manuellement via dashboard ou POST /api/feedback-analysis

---

## 18. PORTFOLIO

- **Fichier** : `output/portfolio-items.json`
- **Premier achat** : LEGO Star Wars 9676, 16.45 EUR investi, valeur marché ~64 EUR

### Structure item portfolio

```json
{
  "id": "uuid",
  "title": "LEGO Star Wars 9676",
  "category": "LEGO",
  "boughtAt": 16.45,
  "boughtDate": "2026-03-XX",
  "platform": "vinted",
  "estimatedSale": 64.0,
  "currentMarketPrice": 64.0,
  "status": "in_stock",
  "profit": null,
  "soldAt": null
}
```

---

## 19. BUGS CORRIGÉS — HISTORIQUE COMPLET

### Session V9 (Dispatch / pré-V10)

1. **Portfolio vide** : conflit routes Express → corrigé
2. **Filtre Ignorées cassé** : API ignorait le paramètre status → corrigé
3. **Profit chute pendant scan** : calcul sur données partielles → corrigé
4. **Bouton loupe sans feedback** : pas de loader/toast → corrigé (spinner + toast)
5. **Filtres Base de prix hardcodés** → corrigés (dynamiques)
6. **Images Vinted cassées** (hotlink protection CDN) → corrigé (proxy server-side `/image-proxy`)
7. **GPT Vision auto-dismiss** → implémenté
8. **Titre override** (faux négatifs thumbnails) → implémenté
9. **Prompt GPT strict** (3 critères) → implémenté
10. **Mini-rapport GPT** → sauvegardé dans historique

### Session V10 (Claude Code — Dispatch)

11. **Images eBay HD** : thumbnails 225px → 1600px automatiquement (ebay.js + vision-verify.js)
12. **BUG CRITIQUE : champ `sameCard` jamais présent** dans réponse GPT → scores jamais boostés par Vision. Fix : ajout champs compat (sameCard calculé depuis sameProduct+sameVariant+conditionComparable) dans vision-verify.js
13. **Auto-verify au scan** : GPT Vision tourne automatiquement pendant chaque scan (index.js)
14. **Enrichissement prix proactif** : tous les 2 scans, enrichit 5 produits avec peu de données marché
15. **Expiration annonces** : tous les 3 scans, vérifie 5 opportunités actives sur Vinted
16. **Graphiques Chart.js** : line chart profit/jour + doughnut catégories
17. **Digest quotidien Telegram** : résumé 1x/jour à 20h+ (top 3, stats, catégories)
18. **Fix SSL VPS** : `NODE_OPTIONS=--use-openssl-ca` dans ecosystem.config.js
19. **Scoring V10** : hard gate assoupli (plafond 59 au lieu de rejet), Chemin B (prix sous moyenne Vinted), pénalités feedback-learner
20. **Budget cap Vision** : 1$/jour max, skip transparent (pas compté comme erreur)
21. **Dashboard Orchestrateur V10** : section collapsible avec métriques health Scanner/Évaluateur
22. **Dashboard responsive mobile** : media queries 768px + 480px, boutons action 44px, colonnes cachées

---

## 20. DÉPLOIEMENT — COMMANDES EXACTES

### Workflow standard

```bash
# 1. Vérifier syntaxe
node --check src/index.js && node --check src/server.js

# 2. Déployer (rsync + npm install + PM2 restart)
./deploy-vps.sh

# 3. Vérifier que le bot tourne
ssh root@76.13.148.209 "pm2 list"

# 4. Vérifier les logs
ssh root@76.13.148.209 "pm2 logs bot-scanner --lines 30"
```

### Déploiement dashboard.html uniquement

```bash
scp src/dashboard.html root@76.13.148.209:/root/botvintedcodex/src/
# Pas de restart PM2 — fichier statique servi par Express
```

### Comparaison local vs VPS

```bash
for f in src/scoring.js src/agents/evaluator.js src/index.js src/server.js src/dashboard.html src/agents/scanner.js src/agents/orchestrator.js src/matching.js src/config.js src/image-match.js src/price-router.js; do
  local_lines=$(wc -l < "$f" 2>/dev/null || echo "MISSING")
  remote_lines=$(ssh root@76.13.148.209 "wc -l < /root/botvintedcodex/$f 2>/dev/null || echo MISSING")
  if [ "$local_lines" != "$remote_lines" ]; then echo "DIFF $f local=$local_lines vps=$remote_lines"; fi
done
```

---

## 21. RÈGLES DE TRAVAIL

1. **Matching strict** : pas de faux positifs, mieux vaut rater une opportunité que d'en montrer une fausse
2. **Une tâche à la fois** : ne pas tout changer en même temps
3. **Bonne copie** : toujours `C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX`
4. **Déployer après chaque modif** : `deploy-vps.sh`
5. **Vérifier la syntaxe** : `node --check src/index.js && node --check src/server.js` avant deploy
6. **Scheduler désactivé** : les agents tournent uniquement manuellement via le dashboard
7. **Pas de Discovery auto** : les messages "DISCOVERY MULTI-CATEGORIES" sont filtrés dans notifier.js
8. **Communiquer en français** avec Justin

---

## 22. POUR REPRENDRE UNE SESSION

### Checklist de démarrage

1. Lire ce fichier CONTEXTE_CLAUDE_V10.md (ou CLAUDE.md)
2. Vérifier git status : `cd /c/Users/chape/Desktop/Dispatch/BOTVINTEDCODEX && git status`
3. Vérifier si le bot tourne : `ssh root@76.13.148.209 "pm2 list"`
4. Ouvrir le dashboard : http://76.13.148.209:3000
5. Lire les derniers logs : `ssh root@76.13.148.209 "pm2 logs bot-scanner --lines 30"`

### Variables d'environnement clés (.env — ne jamais committer)

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
OPENAI_API_KEY=...
EBAY_APP_ID=...
EBAY_CLIENT_SECRET=...
POKEMON_TCG_API_KEY=... (optionnel)
PROXY_URL=... (Decodo ou ScraperAPI)
VINTED_COUNTRIES=be,fr,de
MIN_PROFIT_EUR=5
MIN_PROFIT_PERCENT=20
VISION_DAILY_BUDGET_CENTS=100
VISION_MIN_PROFIT_FOR_CHECK=10
SEARCH_LEGO=true
SEARCH_TOPPS_UFC=true
SEARCH_TOPPS_TENNIS=true
SEARCH_TOPPS_SPORT_GENERAL=true
```

### Fichiers output importants

| Fichier | Contenu |
|---------|---------|
| `output/latest-scan.json` | Dernier état du scan (dashboard) |
| `output/price-database.json` | Base de prix locale (Vinted + marché) |
| `output/portfolio-items.json` | Articles achetés |
| `output/feedback-log.json` | Feedbacks utilisateur (actions dashboard) |
| `output/sprint-contract.json` | Contrat sprint actuel |
| `output/evaluator-feedback.json` | Rejets récents Évaluateur |
| `output/vision-budget.json` | Budget Vision GPT du jour |

---

## 23. GITHUB

| Paramètre | Valeur |
|-----------|--------|
| Repository | https://github.com/Modilaa/BOTVINTED140326.git |
| Branche principale | `main` |
| Branches actives | `main` + branche session courante Claude Code |
| Branches à nettoyer | Toutes les `claude/` sauf la session courante |

### Workflow git standard

```bash
# Push complet
git add -A -- ':!.env' ':!.env.bak' ':!output/' ':!node_modules/'
git commit -m "message de commit"
git push origin main

# Nettoyer worktrees
git worktree prune
git worktree list

# Supprimer branches orphelines locales
git branch -d claude/nom-branche

# Supprimer branches orphelines remote
git push origin --delete claude/nom-branche
```

---

*Ce fichier a été généré le 2026-03-26. Pour toute session future, le relire en premier pour avoir tout le contexte V10.*
