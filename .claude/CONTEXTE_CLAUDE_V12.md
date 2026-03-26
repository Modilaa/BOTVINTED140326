# CONTEXTE_CLAUDE_V12.md — BOTVINTEDCODEX
## Dernière mise à jour : 2026-03-27

> **Document de reprise de session.** Suffit à une conversation Claude VIERGE pour reprendre le projet exactement où il en est.

---

## 1. PRÉSENTATION PROJET

**Objectif** : Bot d'arbitrage multi-marketplace. Scanne Vinted (BE/FR/DE/ES/IT/NL) pour trouver des articles sous-évalués et les revendre sur eBay. Dashboard temps réel, alertes Telegram, vérification GPT-4o mini Vision.

**Utilisateur** : Justin (francophone, Belgique). Pas développeur. Guide les priorités, teste le dashboard comme un client.

**Objectif financier** : 5 000 EUR/mois net via arbitrage. Capital de départ : 500 EUR.

**Stack** : Node.js v24.13.0 · Express · PM2 · GPT-4o mini · Tesseract OCR · Chart.js

---

## 2. VPS & DÉPLOIEMENT

| Paramètre | Valeur |
|-----------|--------|
| VPS | root@76.13.148.209 (Hostinger, Ubuntu 24.04) |
| Projet VPS | /root/botvintedcodex |
| Dashboard | http://76.13.148.209:3000 |
| Process PM2 | bot-scanner (mode fork, --loop --interval=15) |
| Redémarrages | ~93 (bot stable, redémarrages PM2 normaux) |

### Commandes de déploiement
```bash
# Deploy complet (scp + PM2 restart) — depuis le dossier local
cd C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX

# Copier des fichiers spécifiques (rsync absent sur Windows)
scp src/fichier.js root@76.13.148.209:/root/botvintedcodex/src/
scp src/agents/evaluator.js root@76.13.148.209:/root/botvintedcodex/src/agents/

# Restart PM2
ssh root@76.13.148.209 "pm2 restart bot-scanner"

# Logs PM2
ssh root@76.13.148.209 "pm2 logs bot-scanner --lines 50"

# Status PM2
ssh root@76.13.148.209 "pm2 list"

# SSH direct
ssh root@76.13.148.209
```

### Notes déploiement
- `rsync` absent sur le shell Windows → utiliser `scp` pour copier les fichiers
- Vérifier la syntaxe AVANT deploy : `node --check src/index.js && node --check src/server.js`
- `ecosystem.config.js` : contient `NODE_OPTIONS=--use-openssl-ca` (fix SSL VPS)

---

## 3. CODE LOCAL & GITHUB

| Paramètre | Valeur |
|-----------|--------|
| Chemin local | C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX |
| GitHub | branche `main` |
| .claude/ | Sous-dossier contenant contextes, skills, configs (migré depuis racine) |

### Organisation .claude/ (depuis V12)
Justin a déplacé tous les fichiers de configuration/contexte dans `.claude/` :
- `CLAUDE.md` — Instructions principales Claude Code
- `CONTEXTE_CLAUDE_V*.md` — Historiques de sessions
- `ecosystem.config.js` — Config PM2
- `deploy-vps.sh` — Script de déploiement
- `.env` — Variables d'environnement (NON pushé sur GitHub)
- `.env.example` — Template variables (pushé)
- `SKILL CLAUDE/` — Dossier avec collections de skills téléchargés

**IMPORTANT** : Le code source reste dans `src/`. Le `.claude/` ne contient QUE de la documentation/config.

---

## 4. ARBORESCENCE COMPLÈTE (V12)

```
BOTVINTEDCODEX/
├── .claude/                    ← Fichiers contexte/config (migré depuis racine)
│   ├── CLAUDE.md               ← Instructions principales Claude Code
│   ├── CONTEXTE_CLAUDE_V*.md   ← Historiques sessions V1→V12
│   ├── .env                    ← Variables d'environnement (non pushé)
│   ├── .env.example            ← Template variables
│   ├── ecosystem.config.js     ← Config PM2 (NODE_OPTIONS SSL)
│   ├── deploy-vps.sh           ← Script déploiement VPS
│   ├── package.json            ← Dépendances npm
│   ├── SKILL CLAUDE/           ← Collections skills téléchargés
│   │   ├── superpowers-main/   ← SuperPowers skills pack
│   │   ├── skills-main/        ← Skills pack standard
│   │   ├── Agent-Skills-for-Context-Engineering-main/
│   │   ├── claude-code-owasp-main/
│   │   ├── claude-seo-main/
│   │   ├── marketingskills-main/
│   │   ├── SKILL Canva Design.md
│   │   ├── SKILL Debuging.md
│   │   └── SKILL frontenddesign.md
│   └── worktrees/              ← Worktrees Claude Code (non pushé)
│
├── src/
│   ├── index.js                ← Scanner principal (boucle PM2, rotation pays)
│   ├── server.js               ← Dashboard Express (port 3000, SSE temps réel)
│   ├── dashboard.html          ← UI complète (dark theme, Chart.js)
│   ├── config.js               ← Configuration (searches, seuils, pays, Vision budget)
│   ├── scoring.js              ← Confiance (0-100, 3 tiers) + Liquidité (0-100)
│   ├── matching.js             ← Matching titre Vinted ↔ eBay (hard cap 15x, extractTechSpecs)
│   ├── image-match.js          ← pHash, OCR Tesseract, border detection, grid brightness
│   ├── vision-verify.js        ← GPT-4o mini Vision (3 critères, rapport détaillé)
│   ├── notifier.js             ← Alertes Telegram (opportunités + digest quotidien)
│   ├── telegram-handler.js     ← Callbacks boutons inline Telegram
│   ├── profit.js               ← Calcul profit (fees eBay 13%, shipping)
│   ├── http.js                 ← HTTP avec proxy (Decodo, ScraperAPI, PROXY_URL)
│   ├── price-database.js       ← Base de prix persistante (historique temporel)
│   ├── price-router.js         ← Multi-source prix (APIs niche → eBay → Apify)
│   ├── seen-listings.js        ← Cache annonces vues (6h TTL)
│   ├── dismissed-listings.js   ← Blacklist PERMANENTE (5000 entrées max)
│   ├── seller-score.js         ← Score vendeur Vinted
│   ├── api-monitor.js          ← Monitoring erreurs API
│   ├── scheduler.js            ← DÉSACTIVÉ (spammait Discovery)
│   ├── message-bus.js          ← Bus inter-agents (output/agents/message-bus.jsonl)
│   ├── opportunity-state.js    ← State machine par opportunité (output/opportunities/{id}.json)
│   ├── debug-protocol.js       ← Debug structuré root-cause (output/debug-log.jsonl)
│   ├── description-enricher.js ← Enrichissement descriptions
│   ├── feedback-analyzer.js    ← Analyse feedbacks utilisateur
│   ├── feedback-learner.js     ← Apprentissage à partir des feedbacks
│   ├── keyword-estimator.js    ← Estimation mots-clés
│   ├── portfolio.js            ← Gestion portefeuille
│   ├── run-agents.js           ← Lancement manuel des agents
│   ├── underpriced.js          ← Détection sous-évaluation
│   ├── utils.js                ← Utilitaires
│   ├── debug-ebay.js           ← Debug eBay
│   │
│   ├── agents/
│   │   ├── index.js            ← Exports agents
│   │   ├── scanner.js          ← Agent Scanner (lit evaluator-feedback.json)
│   │   ├── evaluator.js        ← Agent Évaluateur (Vision GPT, feedback détaillé V12)
│   │   ├── supervisor.js       ← Vérification disponibilité Vinted
│   │   ├── diagnostic.js       ← Diagnostic système
│   │   ├── discovery.js        ← Découverte nouvelles catégories
│   │   ├── product-explorer.js ← Exploration produits
│   │   ├── strategist.js       ← Portfolio + stratégie
│   │   ├── liquidity.js        ← Analyse liquidité
│   │   └── orchestrator.js     ← Pipeline multi-agents + Sprint Contract
│   │
│   ├── marketplaces/
│   │   ├── vinted.js           ← Scraper Vinted (multi-pays, pagination)
│   │   ├── ebay.js             ← Scraper eBay sold listings (HD 1600px)
│   │   ├── ebay-api.js         ← eBay Browse API officielle
│   │   ├── pokemon-tcg.js      ← API PokemonTCG.io + TCGdex
│   │   ├── pokemontcg-api.js   ← API PokemonTCG.io directe
│   │   ├── pokemon-unified.js  ← Source unifiée Pokemon (fusion TCG + TCGdex)
│   │   ├── ygoprodeck.js       ← API YGOPRODeck
│   │   ├── lego-api.js         ← Rebrickable API (LEGO)
│   │   ├── cardmarket.js       ← Scraper Cardmarket
│   │   ├── leboncoin.js        ← Scraper Leboncoin
│   │   ├── facebook.js         ← Facebook Marketplace (en développement)
│   │   ├── discogs-api.js      ← API Discogs (vinyles)
│   │   ├── sneaks-api.js       ← API sneakers
│   │   └── apify-ebay.js       ← Apify fallback eBay
│   │
│   └── scanners/
│       ├── reverse-scanner.js    ← Scan eBay → Vinted (reverse)
│       └── cardmarket-scanner.js ← Scan Cardmarket → eBay
│
├── scripts/
│   └── migrate-dismissed-blacklist.js ← Migration données seen → blacklist
│
├── output/                     ← Données runtime (non pushé sur GitHub)
│   ├── dismissed-listings.json ← Blacklist permanente
│   ├── evaluator-feedback.json ← Feedbacks Vision (boucle auto-amélioration)
│   ├── evaluated-opportunities.json ← Résultats évaluateur
│   ├── scanner-results.json    ← Candidats bruts du scanner
│   ├── vision-budget.json      ← Budget Vision journalier
│   ├── evaluator-health.json   ← Métriques santé évaluateur
│   ├── opportunities-history.json ← Historique toutes opportunités
│   ├── price-database.json     ← Base de prix (historique temporel)
│   ├── sprint-contract.json    ← Sprint contract actif
│   ├── orchestrator-decisions.json ← Décisions actives orchestrateur
│   ├── portfolio-items.json    ← Articles achetés (portefeuille)
│   ├── seen-listings.json      ← Cache annonces vues (6h TTL)
│   ├── debug-log.jsonl         ← Debug structuré JSONL
│   ├── agents/
│   │   ├── message-bus.jsonl   ← Messages inter-agents (24h TTL, 1000 max)
│   │   ├── diagnostic-latest.json
│   │   ├── discovery-latest.json
│   │   ├── liquidity-latest.json
│   │   ├── pipeline-latest.json
│   │   ├── supervisor-latest.json
│   │   └── strategist-latest.json
│   ├── opportunities/          ← State machine par opportunité (output/opportunities/{id}.json)
│   └── cache/
│       └── trends/
│
├── test/
│   └── matching.test.js
└── node_modules/               ← Non pushé
```

---

## 5. ARCHITECTURE MULTI-AGENTS V11

```
┌─────────────────────────────────────────────────────────┐
│                    ORCHESTRATEUR                         │
│   Sprint Contract · Décisions actives · Message Bus     │
└───────────────┬─────────────────────────────────────────┘
                │
        ┌───────▼────────┐
        │    SCANNER     │  ← Lit evaluator-feedback.json
        │  (scanner.js)  │     pour adapter ses queries
        └───────┬────────┘
                │ scanner-results.json (candidats bruts)
        ┌───────▼────────┐
        │  ÉVALUATEUR    │  ← Scoring texte + critères durs
        │ (evaluator.js) │     Vision GPT en parallèle (x3)
        └───────┬────────┘
                │
        ┌───────┴────────────────────────────┐
        │              SORTIE               │
        │  ✅ active     → Dashboard         │
        │  ⏳ candidate  → Retry scan suivant│
        │  ❌ rejected   → Feedback Scanner  │
        └────────────────────────────────────┘
                │
        ┌───────▼────────┐
        │  NOTIFIER      │  ← Alertes Telegram
        │ (notifier.js)  │
        └────────────────┘
```

**Agents disponibles (lancement manuel via dashboard) :**
- `scanner.js` — Scan Vinted, lit feedbacks, construit candidats
- `evaluator.js` — Évaluation complète (Vision + scoring + critères)
- `supervisor.js` — Vérifie disponibilité des opportunités actives
- `orchestrator.js` — Pipeline complet (scanner + evaluator + supervisor)
- `diagnostic.js` — Diagnostic système
- `discovery.js` — Découverte nouvelles catégories
- `strategist.js` — Stratégie portefeuille

**IMPORTANT** : Le scheduler est DÉSACTIVÉ. Les agents ne tournent que :
1. Automatiquement via le scanner principal (index.js, toutes les 15min)
2. Manuellement via les boutons du dashboard

---

## 6. PIPELINE COMPLET

### 6.1 Flux Scanner → Dashboard

```
1. index.js (toutes les 15min, rotation pays)
   └─ scanVinted() → liste annonces Vinted

2. matching.js → ebay.js / ebay-api.js
   └─ Pour chaque annonce Vinted :
      - Recherche prix eBay (sold listings)
      - Hard cap 15x : ratio Vinted/eBay > 15 → rejet systématique
      - extractTechSpecs, extractSmartphoneSpecs pour tech

3. profit.js
   └─ Calcul profit = eBay_avg - Vinted_price - fees_eBay(13%) - shipping(4.5€)

4. agents/evaluator.js (pre-pass Vision GPT en parallèle x3)
   ├─ shouldSkipVisionBudget() → skip si profit trop bas OU budget dépassé
   ├─ compareCardImages() → vision-verify.js → GPT-4o mini
   │   └─ Retourne : sameProduct, sameVariant, conditionComparable, report{}
   ├─ computeConfidence() → scoring.js (0-100)
   │   ├─ Tier 1 : Matching texte (0-40 pts)
   │   ├─ Tier 2 : Fiabilité source (0-20 pts)
   │   └─ Tier 3 : Vision (sameCard=true: +40, sameCard=false: score=0)
   ├─ computeLiquidity() → scoring.js (0-100)
   └─ evaluateCriteria() → Pattern 5 seuils durs par critère

5. Statuts résultants :
   ✅ active          → Vision confirmée → Dashboard "Validées GPT" + Telegram
   ⏳ candidate       → Vision non exécutée → Dashboard "Candidates" (retry)
   ❌ vision_rejected → Vision rejetée → feedback evaluator-feedback.json
   ❌ rejected        → Critères non remplis → feedback evaluator-feedback.json

6. server.js → history (opportunities-history.json)
   └─ Dashboard SSE temps réel
```

### 6.2 Pipeline de prix (price-router.js)

```
1. Cache local (price-database.json, 2h TTL, historique temporel)
2. APIs niche spécialisées :
   - PokemonTCG.io + TCGdex → pokemon-unified.js
   - YGOPRODeck → ygoprodeck.js
   - Rebrickable API → lego-api.js
3. eBay Browse API officielle → ebay-api.js (quota: 5000/jour)
4. eBay scraping → ebay.js (multi-domaines UK/DE/FR/IT/ES)
5. Apify fallback payant → apify-ebay.js (budget: 100 req/scan)
```

---

## 7. GPT VISION — GARDIEN FINAL

### Rôle dans le pipeline
Vision GPT est le **gardien final** : un item ne peut devenir `active` QUE si Vision confirme (`sameCard === true`). Sans Vision = reste `candidate`.

### Prompt complet (vision-verify.js)
```
Tu es un expert en ARBITRAGE e-commerce. Ta mission : vérifier si deux annonces concernent
LE MÊME PRODUIT EXACT pour valider une opportunité d'achat (Vinted) - revente (eBay).

Image 1 = Annonce Vinted (article à acheter, photo maison aléatoire).
Image 2 = Annonce eBay (référence de prix, photo pro ou maison).

RÈGLE FONDAMENTALE : Compare L'OBJET physique, PAS l'image. Ignore complètement le fond,
l'angle, l'éclairage, la mise en scène. Ils seront TOUJOURS différents entre Vinted et eBay.

Vérifie ces 3 critères STRICTEMENT :
1. MÊME PRODUIT EXACT (numéro de carte, numéro de set LEGO, modèle exact, etc.)
2. MÊME VARIANTE (base ≠ holo ≠ refractor ≠ prismatic ≠ gold ≠ rainbow ≠ full art)
3. CONDITION COMPARABLE (Mint/scellé ≠ très endommagé = REJET)

EN CAS DE DOUTE → REJETER. Mieux vaut manquer une opportunité que valider un faux positif.

Répond UNIQUEMENT avec du JSON :
{
  "sameProduct": true/false,
  "sameVariant": true/false,
  "conditionComparable": true/false,
  "verdict": "match" / "no_match" / "match_condition_diff",
  "reason": "explication courte",
  "report": {
    "vintedObservation": "ce qui est visible sur l'image Vinted",
    "referenceObservation": "ce qui est visible sur l'image eBay",
    "differences": ["liste des différences détectées"],
    "suggestion": "suggestion pour améliorer le scan"
  }
}
```

### Logique de résultat (vision-verify.js)
- `sameProduct + sameVariant = true` → `verdict = "match"` → `sameCard = true` → +40 pts confiance
- `sameProduct + sameVariant = true` mais `conditionComparable = false` → `verdict = "match_condition_diff"` → `sameCard = true` (condition ≠ disqualifiant)
- `sameProduct = false` OU `sameVariant = false` → `verdict = "no_match"` → `sameCard = false` → score = 0

### Budget Vision (evaluator.js)
```
VISION_DAILY_BUDGET_CENTS = 200 (2$/jour max)
VISION_MIN_PROFIT_FOR_CHECK = 0 (vérifier TOUTES les candidates)
VISION_COST_PER_CALL_CENTS = 3 (~3 cents par appel, 2 images)
```
- Budget dépassé → item reste `candidate` (badge "⚠ Non vérifié GPT")
- Vision Rate limit 429 → retry avec backoff [1s, 3s, 8s]
- Vision timeout 400 → item reste `candidate` (retry prochain scan)

### Titre override (matching.js)
Si GPT dit variant différent MAIS les deux titres contiennent le même mot-clé de variante → force match (évite faux négatifs sur thumbnails flous).

---

## 8. BLACKLIST PERMANENTE (dismissed-listings.js)

**Fichier** : `output/dismissed-listings.json`

| Paramètre | Valeur |
|-----------|--------|
| Limite | 5000 entrées max (auto-pruning) |
| Lookup par ID Vinted | Permanent (tant que pas purgé) |
| Lookup par titre normalisé | Expire après 30 jours (repost possible) |

### Fonctionnement
```js
// Vérification au début du scan (index.js + scanner.js)
if (dismissedListings.isDismissed(listing.id, listing.title)) {
  // skip silencieux, jamais affiché
}

// Ajout quand utilisateur clique "Ignorer" dans le dashboard
dismissedListings.addDismissed(listing.id, listing.title);
```

### Normalisation titre
Lowercase, sans accents, sans ponctuation → 80 premiers caractères. Couvre les reposts avec nouvel ID mais même titre.

---

## 9. SCORING V11 (scoring.js)

### Confiance (0-100)

**Tier 1 — Matching texte (0-40 pts)**
- Tokens communs entre titre Vinted et titre eBay
- Bonus si titre précis (numéros, éditions)

**Tier 2 — Fiabilité source prix (0-20 pts)**
- API niche (PokemonTCG, YGOPRODeck, Rebrickable) = 20 pts
- eBay Browse API = 15 pts
- eBay scraping multi-domaines = 10-15 pts
- Local database cache = 5-10 pts

**Tier 3 — Vision GPT (0-40 pts)**
- `sameCard === true` → +40 pts
- `sameCard === false` → score forcé à 0 (rejet immédiat)
- Non exécuté → 0 pts (item reste candidate)
- Skip budget → pHash assoupli utilisé

**Seuil** : confidence >= 50 pour être opportunité

### Liquidité (0-100)
4 facteurs : Volume ventes (35%) + Vitesse (30%) + Stabilité prix (20%) + Turnover (15%)

---

## 10. MATCHING V11 (matching.js)

### Hard cap 15x
Ratio prix Vinted/eBay >= 15x → rejet systématique quelle que soit la catégorie.

### Fonctions spécialisées
- `extractTechSpecs(title)` → Extrait specs techniques (RAM, stockage, modèle)
- `extractSmartphoneSpecs(title)` → Spécifique smartphones (Pro/Max, capacité)
- `matchLegoSetNumber(vintedTitle, ebayTitle)` → Matching par numéro de set LEGO

### Logique tokens
1. Tokenisation des titres (stop-words exclus)
2. Score de matching (tokens communs / tokens totaux)
3. Malus si tokens bloquants présents (ex: "panini" dans une search Pokemon)
4. Titre override si même mot-clé variante dans les deux titres

---

## 11. COMPARAISON IMAGES (image-match.js)

Utilisé en complément de Vision GPT (quand Vision skip pour budget) :
- **pHash** : hash perceptuel, distance de Hamming < 15 = probable match
- **OCR Tesseract** : lecture texte sur l'image (numéros de cartes, etc.)
- **Border detection** : détection bordures de cartes TCG
- **Grid brightness** : analyse luminosité grille (holographique vs non-holographique)

---

## 12. PIPELINE DE PRIX DÉTAILLÉ (price-router.js)

### Sources de prix (ordre de priorité)
1. **Cache local** `price-database.json` : TTL 2h, historique temporel illimité
2. **APIs niche** :
   - PokemonTCG.io → `pokemon-unified.js` (fusion TCG + TCGdex, TTL 365j)
   - YGOPRODeck → `ygoprodeck.js` (TTL 24h)
   - Rebrickable → `lego-api.js` (TTL 48h)
3. **eBay Browse API** → `ebay-api.js` (officielle, quota 5000/jour, reset hebdomadaire)
4. **eBay scraping** → `ebay.js` (multi-domaines UK/DE/FR/IT/ES, images HD 1600px)
5. **Apify** → `apify-ebay.js` (fallback payant, budget 100 req/scan)

### Price database (price-database.js)
- Clés : titre normalisé (migration V11 depuis clés composites)
- Historique temporel : chaque update ajoute un point `{price, date, source, observations}`
- TTL par source : 2h cache, 24-365h selon API
- Enrichissement proactif : tous les 2 scans, enrichit 5 produits avec peu de données

---

## 13. TELEGRAM

### Alertes opportunités
- Photo Vinted + boutons inline : **Acheter** (✅ buy_XXX) / **Ignorer** (❌ ignore_XXX) / **Détails** (🔍 verify_XXX)
- Filtre minimum : `TELEGRAM_MIN_CONFIDENCE=50`
- Envoi uniquement pour items `active` (Vision confirmée)

### Résumé scan
- Envoyé après chaque scan si >= 1 opportunité trouvée
- Nombre de candidats, actifs, rejetés, budget Vision

### Digest quotidien
- 1 fois/jour à 20h+ (notifier.js)
- Top 3 opportunités actives + stats + catégories

### Callbacks Telegram
- `buy_XXX` → status = `accepted` (marque comme à acheter)
- `ignore_XXX` → status = `dismissed` + ajout blacklist permanente
- `verify_XXX` → relance Vision GPT manuelle

---

## 14. DASHBOARD V11

**URL** : http://76.13.148.209:3000

### Onglets opportunités (ordre exact)
| Onglet | Filter | Description |
|--------|--------|-------------|
| **Validées GPT** | `active` | Items confirmés par Vision → onglet principal |
| **Candidates** | `candidate` | En attente Vision (pas d'image eBay / budget épuisé) |
| **Acceptées** | `accepted` | Utilisateur a cliqué ✅ (va acheter) |
| **Ignorées** | `dismissed` | Utilisateur a cliqué ❌ |
| Badge **🚫 Blacklist** | — | Compteur entrées blacklist permanente |

### KPI Dashboard (header)
- Opportunités actives (Vision confirmées)
- Profit total estimé
- Confiance moyenne
- Budget Vision journalier (X¢/200¢)

### Graphiques
- Line chart : profit/jour (7 derniers jours)
- Doughnut : répartition par catégorie

### Sections dashboard
- **Opportunités** — Table triable (confiance, profit, prix)
- **Portfolio** — Articles achetés avec bouton "Vendu"
- **Base de prix** — Browse filtrable par catégorie/source
- **Agents** — Status + boutons lancement manuel
- **Décisions actives** — Décisions orchestrateur

### Endpoints API principaux
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/opportunities` | Liste opportunités (filtre: active/candidate/accepted/dismissed) |
| POST | `/api/opportunities/:id/status` | Changer statut (active/sold/expired/dismissed/bought) |
| POST | `/api/opportunity/:id/accept` | Accepter opportunité |
| POST | `/api/opportunity/:id/reject` | Rejeter (+ blacklist) |
| GET | `/api/opportunity/:id/history` | Historique transitions statut |
| POST | `/api/verify-image` | Vérification Vision manuelle |
| POST | `/api/verify-opportunity` | Vérification complète manuelle |
| GET | `/api/stats` | Statistiques globales |
| GET | `/api/vision-budget` | Budget Vision journalier |
| GET | `/api/price-database/browse` | Browse base de prix |
| GET | `/api/agents/status` | Status agents |
| POST | `/api/agents/:agentName` | Lancer un agent manuellement |
| GET | `/api/events` | SSE stream temps réel |
| GET | `/api/scans` | Historique des scans |
| GET | `/api/debug-log` | Logs debug structurés |
| GET | `/api/feedback-report` | Rapport feedbacks |
| POST | `/api/scan` | Lancer un scan manuel |
| GET | `/api/portfolio` | Portefeuille |
| POST | `/api/portfolio/purchase` | Ajouter achat |
| POST | `/api/portfolio/sold` | Marquer comme vendu |
| DELETE | `/api/opportunities/:id` | Supprimer opportunité |
| POST | `/api/claim` | Réclamer un item |
| POST | `/api/scan/reverse` | Scanner eBay → Vinted |
| GET | `/api/ebay-quota` | Quota eBay Browse API |

---

## 15. MESSAGE BUS (message-bus.js)

**Fichier** : `output/agents/message-bus.jsonl`

Communication directe entre agents sans reformulation. Format :
```json
{ "ts": "ISO", "from": "evaluator", "to": "notifier", "type": "opportunities", "payload": {...} }
```

- TTL : 24h
- Limite : 1000 messages (purge au démarrage)
- Purge automatique via `messageBus.purge()` dans `init()`

**Usage type** :
```js
messageBus.publish('evaluator', 'notifier', 'opportunities', { count: 3, opportunities: [...] });
messageBus.getMessages({ from: 'evaluator', to: 'notifier', type: 'opportunities' });
```

---

## 16. OPPORTUNITY STATE MACHINE (opportunity-state.js)

**Dossier** : `output/opportunities/{id}.json`

Statuts possibles :
```
discovered → evaluated → pending → accepted / rejected / dismissed / expired / sold
                                  ↑
                              candidate (Vision non exécutée)
                                  ↓
                              active (Vision confirmée)
```

Chaque transition est loggée dans `statusHistory` :
```json
{
  "from": "candidate",
  "to": "active",
  "at": "2026-03-27T...",
  "by": "evaluator",
  "details": "Vision GPT confirmé (confidence 90)"
}
```

---

## 17. DEBUG PROTOCOL (debug-protocol.js)

**Fichier** : `output/debug-log.jsonl`

Format structuré root-cause :
```json
{
  "phase": "vision",
  "module": "vision-verify.js",
  "symptom": "429 Rate limit",
  "cause": "Trop d'appels simultanés GPT",
  "hypothesis": "Réduire concurrence",
  "fix": "Retry backoff [1s, 3s, 8s]",
  "verified": true
}
```

Si 3+ fixes échoués sur un même module → signal `architectural_review_needed`.

---

## 18. FILESYSTEM CONTEXT (workspaces agents)

```
output/
├── agents/          ← Workspace inter-agents (message-bus.jsonl, résultats)
├── opportunities/   ← State machine individuelle par opportunité
└── cache/trends/    ← Tendances prix
```

Chaque agent a son propre fichier de résultats : `output/agents/{agent}-latest.json`

---

## 19. BOUCLE D'AUTO-AMÉLIORATION

### Flux complet
```
Vision GPT rejette/accepte
    ↓
evaluator.js écrit evaluator-feedback.json
{
  reason: "vision_rejected" | "vision_accepted" | critère échoué,
  vintedObservation: "...",       ← ce que Vision a vu sur Vinted
  referenceObservation: "...",    ← ce que Vision a vu sur eBay
  differences: ["diff1", "diff2"],← différences détectées
  suggestion: "query_should_exclude_variant" | "review_images_and_matching" | ...,
  imageUrls: { vinted: "...", ebay: "..." }
}
    ↓
scanner.js lit evaluator-feedback.json (48h)
    ↓
feedback-learner.js analyse patterns :
  - "query_should_add_variant_tokens" → ajoute tokens variante aux queries
  - "query_should_include_set_number" → force recherche par numéro LEGO
  - "require_more_observations" → demande plus d'observations eBay
  - "review_images_and_matching" → signale problème matching
    ↓
Sprint Contract (sprint-contract.json) :
  - queryAdjustments : modifications queries actives
  - criteria : seuils ajustés (cardsRequireVariantMatch, legoRequiresSetNumber)
```

### Fichier evaluator-feedback.json
Structure avec historique max 200 entrées (les plus récentes en tête) :
```json
{
  "feedbacks": [
    {
      "timestamp": "2026-03-27T...",
      "itemKey": "vinted_123456",
      "category": "POKEMON",
      "reason": "vision_rejected",
      "detail": "\"Pikachu VMAX\" vs \"Pikachu V\" — variante différente",
      "suggestion": "query_should_add_variant_tokens",
      "vintedTitle": "Pikachu VMAX 044/185",
      "ebayTitle": "Pikachu V 044/185 Vivid Voltage",
      "vintedObservation": "Carte Pikachu VMAX jaune, finition rainbow/dorée",
      "referenceObservation": "Carte Pikachu V standard, pas de finition spéciale",
      "differences": ["VMAX vs V", "finition rainbow vs standard"],
      "imageUrls": { "vinted": "https://...", "ebay": "https://..." }
    }
  ],
  "updatedAt": "2026-03-27T..."
}
```

---

## 20. SKILLS DISPONIBLES

Les skills sont dans `.claude/SKILL CLAUDE/`. Ils ne sont PAS des skills Claude Code natifs — ce sont des documents de référence/prompts.

| Dossier/Fichier | Contenu |
|----------------|---------|
| `superpowers-main/` | Pack skills avancés (agents, analyse) |
| `skills-main/` | Skills standards |
| `Agent-Skills-for-Context-Engineering-main/` | Skills context engineering |
| `claude-code-owasp-main/` | Skills sécurité OWASP |
| `claude-seo-main/` | Skills SEO |
| `marketingskills-main/` | Skills marketing |
| `SKILL Canva Design.md` | Prompts design Canva |
| `SKILL Debuging.md` | Protocole debugging |
| `SKILL frontenddesign.md` | Design frontend |

**Comment utiliser** : Référencer le contenu du skill dans ta conversation pour guider Claude.

---

## 21. CATÉGORIES ACTIVES (config.js + .env)

### Toujours actives (dans le tableau `searches` de base)
- Pokemon TCG (cartes rares, PSA, illustration rare, full art, holo)
- Yu-Gi-Oh (cartes rares)
- One Piece TCG (cartes)
- Topps F1 (cartes Chrome)

### Activées via flags .env (tous `=true` sur le VPS)
```env
SEARCH_LEGO=true              ← LEGO sets (par numéro de set)
SEARCH_TOPPS_FOOTBALL=true    ← Topps Chrome Football
SEARCH_PANINI=true            ← Panini Football (Prizm, etc.)
SEARCH_TOPPS_UFC=false        ← Non actif
SEARCH_TOPPS_TENNIS=false     ← Non actif
SEARCH_TOPPS_SPORT_GENERAL=false ← Non actif
SEARCH_SNEAKERS=true          ← Sneakers (Jordan, Yeezy, etc.)
SEARCH_VINTAGE=true           ← Vintage/Retro
SEARCH_TECH=true              ← Tech (smartphones, consoles)
SEARCH_RETRO=true             ← Retro gaming
SEARCH_VINYLES=true           ← Vinyles
```

**Pays actifs** : `VINTED_COUNTRIES=be,fr,de,es,it,nl`

---

## 22. SEUILS PAR CATÉGORIE (config.js)

| Catégorie | Min profit EUR | Min profit % |
|-----------|---------------|--------------|
| LEGO | 10€ | 20% |
| Tech/Smartphones | 20€ | 20% |
| Sneakers | 15€ | 25% |
| TCG (Pokemon, Yu-Gi-Oh) | 5€ | 20% |
| Autres | 5€ | 20% |
| Évaluateur (override sprint) | 15€ LEGO, 50€ hors LEGO | — |

---

## 23. PORTFOLIO

- Premier achat : LEGO Star Wars 9676, 16.45 EUR investi, valeur marché ~64 EUR
- Fichier : `output/portfolio-items.json`
- Dashboard : section Portfolio avec bouton "Vendu" + rapport hebdomadaire

---

## 24. HISTORIQUE BUGS CORRIGÉS

### Session 23 mars (Dispatch — V9→V10)
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

### Session 23 mars (Claude Code — V10)
1. Images eBay HD : thumbnails 225px → 1600px (ebay.js)
2. BUG CRITIQUE : champ `sameCard` n'existait jamais dans réponse GPT → scores jamais boostés → CORRIGÉ (ajout champs compat vision-verify.js)
3. Auto-verify au scan : GPT Vision automatique pendant chaque scan (index.js)
4. Enrichissement prix proactif : tous les 2 scans, 5 produits enrichis
5. Expiration annonces : tous les 3 scans, 5 opportunités vérifiées
6. Graphiques Chart.js : line chart profit/jour + doughnut catégories
7. Digest quotidien Telegram : 1x/jour à 20h+
8. Fix SSL VPS : NODE_OPTIONS=--use-openssl-ca dans ecosystem.config.js

### Session 26-27 mars (V11)
1. Skills 6-7-8 : message-bus.js, vision parallèle (x3), dashboard terminal
2. Blacklist permanente : dismissed-listings.js (5000 entrées, TTL titre 30j)
3. Migration données seen → blacklist : scripts/migrate-dismissed-blacklist.js
4. GPT Vision gardien final : pipeline candidate → active (V11 refonte)
5. Feedback Vision détaillé : rapport complet dans evaluator-feedback.json (V12)
   - vintedObservation, referenceObservation, differences, suggestion
   - Feedback aussi pour les acceptations Vision (boucle positive)
6. Sync VPS : matching.js, price-database.js, scoring.js, server.js, evaluator.js

---

## 25. DÉPLOIEMENT — COMMANDES EXACTES

```bash
# 1. Toujours vérifier la syntaxe avant deploy
cd C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX
node --check src/index.js && node --check src/server.js

# 2. Copier les fichiers modifiés sur le VPS (rsync absent sur Windows)
scp src/fichier_modifie.js root@76.13.148.209:/root/botvintedcodex/src/
scp src/agents/evaluator.js root@76.13.148.209:/root/botvintedcodex/src/agents/

# 3. Redémarrer PM2
ssh root@76.13.148.209 "pm2 restart bot-scanner"

# 4. Vérifier les logs (optionnel)
ssh root@76.13.148.209 "pm2 logs bot-scanner --lines 20 --nostream"

# 5. Push GitHub (exclure .env, output/, node_modules/)
cd C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX
git add src/ scripts/ .claude/CLAUDE.md .claude/CONTEXTE_CLAUDE_V12.md .claude/ecosystem.config.js .claude/.env.example .claude/deploy-vps.sh
git commit -m "feat: description"
git push origin main
```

---

## 26. RÈGLES DE TRAVAIL

1. **Matching strict** : pas de faux positifs, mieux vaut rater une opportunité que d'en montrer une fausse
2. **Une tâche à la fois** : ne pas tout changer en même temps
3. **Bonne copie** : toujours `C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX` (pas d'autre dossier)
4. **Vérifier la syntaxe** avant chaque deploy
5. **Scheduler désactivé** : agents UNIQUEMENT manuellement via dashboard
6. **Pas de Discovery auto** : les messages "DISCOVERY MULTI-CATEGORIES" sont filtrés dans notifier.js
7. **rsync absent sur Windows** → utiliser scp pour les déploiements
8. **V12 dans .claude/** : les contextes sont maintenant dans `.claude/` (pas à la racine)

---

## 27. CHECKLIST DE DÉMARRAGE SESSION

```bash
# 1. Vérifier que le bot tourne
ssh root@76.13.148.209 "pm2 list"

# 2. Voir les derniers logs
ssh root@76.13.148.209 "pm2 logs bot-scanner --lines 30 --nostream"

# 3. Ouvrir le dashboard
# → http://76.13.148.209:3000

# 4. Voir l'état des fichiers locaux
cd C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX
git status

# 5. Voir les opportunités actives
# → Dashboard onglet "Validées GPT"

# 6. Voir le budget Vision du jour
# → Dashboard KPI ou GET /api/vision-budget
```

---

## 28. VARIABLES .ENV COMPLÈTES (.claude/.env.example)

```env
# ─── Telegram ─────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=replace_me
TELEGRAM_CHAT_ID=replace_me
TELEGRAM_MIN_CONFIDENCE=50

# ─── Scan ─────────────────────────────────────────────────
MIN_PROFIT_EUR=8
MIN_PROFIT_PERCENT=25
MAX_ITEMS_PER_SEARCH=18
OUTPUT_DIR=output
REQUEST_TIMEOUT_MS=60000

# ─── Vinted ───────────────────────────────────────────────
VINTED_COUNTRIES=be,fr,de,es,it,nl
VINTED_SHIPPING_ESTIMATE=3.5
VINTED_PAGES_PER_SEARCH=5
VINTED_MAX_LISTINGS_PER_QUERY=36
VINTED_MAX_LISTINGS_PER_SEARCH=90

# ─── eBay ─────────────────────────────────────────────────
EBAY_OUTBOUND_SHIPPING_ESTIMATE=4.5
EBAY_PAGES_PER_QUERY=1
EBAY_BASE_URLS=https://www.ebay.co.uk,https://www.ebay.de,https://www.ebay.fr,https://www.ebay.it,https://www.ebay.es
EBAY_FINDING_API_ENABLED=false
EBAY_APP_ID=replace_me
EBAY_CLIENT_SECRET=replace_me
USD_TO_EUR_RATE=0.865
GBP_TO_EUR_RATE=1.153

# ─── HTTP / Proxy ─────────────────────────────────────────
HTTP_MIN_DELAY_MS=900
HTTP_MAX_DELAY_MS=1600
CACHE_TTL_SECONDS=3600
# PROXY_URL=http://user:pass@proxy:port

# ─── GPT Vision ───────────────────────────────────────────
OPENAI_API_KEY=replace_me
VISION_DAILY_BUDGET_CENTS=200    # 2$/jour max
VISION_MIN_PROFIT_FOR_CHECK=0    # vérifier TOUTES les candidates
VISION_COST_PER_CALL_CENTS=3     # ~3 cents/appel

# ─── Catégories (activer/désactiver) ──────────────────────
SEARCH_LEGO=true
SEARCH_SNEAKERS=true
SEARCH_VINTAGE=true
SEARCH_TECH=true
SEARCH_RETRO=true
SEARCH_VINYLES=true
SEARCH_TOPPS_FOOTBALL=true
SEARCH_PANINI=true
SEARCH_TOPPS_UFC=false
SEARCH_TOPPS_TENNIS=false
SEARCH_TOPPS_SPORT_GENERAL=false

# ─── Multi-Agent System ───────────────────────────────────
AGENTS_ENABLED=true
AGENTS_REVERIFY_PRICES=false
AGENTS_CHECK_AVAILABILITY=true
AGENTS_MIN_CONFIDENCE=30

# ─── Dashboard ────────────────────────────────────────────
DASHBOARD_PORT=3000
DASHBOARD_ENABLED=true

# ─── SSL (VPS uniquement) ─────────────────────────────────
# Dans ecosystem.config.js : NODE_OPTIONS=--use-openssl-ca
```

---

## 29. FICHIERS OUTPUT IMPORTANTS

| Fichier | Description | Taille typique |
|---------|-------------|----------------|
| `opportunities-history.json` | Toutes les opportunités vues | ~200-500 KB |
| `evaluated-opportunities.json` | Dernier batch évalué | ~100 KB |
| `scanner-results.json` | Candidats bruts dernier scan | ~200 KB |
| `price-database.json` | Base de prix persistante | ~5-50 KB |
| `dismissed-listings.json` | Blacklist permanente | ~50-500 KB |
| `evaluator-feedback.json` | Feedbacks Vision (auto-amélioration) | ~20-100 KB |
| `vision-budget.json` | Budget Vision journalier | < 1 KB |
| `evaluator-health.json` | Métriques santé évaluateur | < 1 KB |
| `sprint-contract.json` | Sprint contract actif | < 5 KB |
| `agents/message-bus.jsonl` | Messages inter-agents | ~10-50 KB |
| `portfolio-items.json` | Portefeuille d'articles | < 10 KB |

---

## 30. PROBLÈMES CONNUS RESTANTS

1. **Rate limit Vision 429** : Se produit quand plusieurs appels Vision simultanés et quota GPT atteint. Le retry backoff [1s, 3s, 8s] gère la plupart des cas. Les items non vérifiés restent `candidate` pour retry au scan suivant.

2. **Timeout Vision 400** : Les URLs d'images Vinted (.webp) sont parfois refusées par GPT avec erreur "400 Timeout while downloading". Item reste `candidate`.

3. **LEGO : items restent candidates** : Si pas d'image eBay disponible dans les sold listings, la Vision ne peut pas tourner. Amélioration possible : enrichir l'image eBay via une autre source.

4. **evaluator.js en src/ sur VPS** : Le VPS a un fichier `src/evaluator.js` (à la racine de src/) en plus de `src/agents/evaluator.js`. Ce double fichier est probablement une ancienne version — ne pas utiliser.

5. **clean-aberrant-opportunities.js sur VPS** : Présent sur le VPS mais pas en local. Ne pas supprimer sans vérifier son utilité.

6. **Topps F1 désactivé** (sprint contract) : La catégorie Topps F1 est désactivée par sprint contract actif. Normal, peut être réactivée.

---

## 31. PROCHAINES ÉTAPES RECOMMANDÉES

### Court terme (priorité haute)
1. **Corriger les timeout Vision 400** : Les images Vinted .webp sont refusées par GPT. Solution possible : re-encoder l'image en JPEG via le proxy server-side avant d'envoyer à GPT.
2. **Dashboard : afficher le rapport Vision** dans la fiche opportunité (vintedObservation, referenceObservation, differences) pour comprendre pourquoi Vision a accepté/rejeté.

### Moyen terme
3. **Scanner lit vraiment les feedbacks** : Vérifier que les suggestions du feedback sont effectivement appliquées aux queries Vinted (logique dans feedback-learner.js).
4. **Enrichissement image eBay** : Si pas d'image eBay, chercher via scraping Google Images ou eBay API.
5. **Revente assistée** : Cross-post automatique eBay/Vinted/Marketplace pour les articles achetés.

### Long terme
6. **Facebook Marketplace comme source d'achat** : marketplace.js est déjà en développement.
7. **Auto-scaling catégories** : Activer/désactiver catégories automatiquement selon ROI.

---

## 32. POUR REPRENDRE UNE SESSION

1. Lire ce fichier (CONTEXTE_CLAUDE_V12.md)
2. Vérifier état du bot : `ssh root@76.13.148.209 "pm2 list"`
3. Vérifier git status : `cd C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX && git status`
4. Ouvrir dashboard : http://76.13.148.209:3000
5. Demander à Justin ses priorités pour la session

---

*Fichier généré automatiquement le 2026-03-27 par Claude Code (claude-sonnet-4-6)*
