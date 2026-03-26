# CONTEXTE CLAUDE V4 — Session Arbitrage Justin
## Date : 2026-03-23
## Objectif : Reprendre exactement où on en est après 2 jours de dev intensif

---

## QUI EST JUSTIN
- Entrepreneur tech francophone basé en Belgique
- Email : chapelle1511@gmail.com
- Capital de départ : 500-1000€
- Objectif : 5000€/mois avec l'arbitrage achat-revente
- PC : Windows, RTX 4050 Laptop 6 Go VRAM, 24 Go RAM
- Projets : BOTVINTEDCODEX (arbitrage TCG + multi-produits), Rusé le Renard (vidéos IA)
- Préfère les solutions gratuites/open source
- Communication directe, n'aime pas les faux positifs ni le spam

## VPS HOSTINGER
- IP : 76.13.148.209
- SSH : root@76.13.148.209
- Ubuntu 24.04, PM2, Node v20.20.1
- Datacenter : Frankfurt, Allemagne
- Expiration : 2026-04-07
- Ports ouverts : 22, 80, 443, 3000, 4200, 5000
- Disque : 40G/96G utilisés (3.1G pour le bot, dont 2.9G de cache HTTP)

---

## PROJET : BOTVINTEDCODEX

### Chemins
- **Local** : C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX (PAS Desktop/BOTVINTEDCODEX)
- **VPS** : /root/botvintedcodex (version ACTIVE, déployée le 22/03/2026)
- **Dashboard VPS** : http://76.13.148.209:3000
- **Dashboard local** : http://localhost:3000

### Stack
- Node.js CommonJS, Express, PM2
- Dashboard : port 3000 (intégré dans index.js via require('./server'))
- npm packages clés : sharp, tesseract.js, openai, docx

### Commandes
| Commande | Description |
|----------|------------|
| `npm start` | Un scan unique (tous les pays) |
| `npm run loop` | Boucle toutes les 15 min avec rotation pays |
| `npm run dashboard` | Dashboard seul (sans scan) |
| `pm2 start ecosystem.config.js` | Production VPS |
| `pm2 logs bot-scanner --lines 50` | Voir les logs |
| `pm2 restart bot-scanner` | Redémarrer |

### PM2 ecosystem.config.js
- `bot-scanner` : `node src/index.js --loop --interval=15`, autorestart, max_memory_restart 1536M
- `scheduler` : COMMENTÉ (désactivé, spammait Discovery toutes les 10 min)

---

## CATÉGORIES ACTIVES (9 au 23/03/2026)

### Catégories avec API niche (prioritaire, eBay en fallback)
| Catégorie | API niche | Cascade complète | Queries |
|-----------|-----------|-----------------|---------|
| **Pokémon** | PokemonTCG.io (20K req/jour, clé API) | PokemonTCG.io → TCGdex → eBay Browse → Apify → null | 30 |
| **Yu-Gi-Oh** | YGOPRODeck (gratuit, illimité) | YGOPRODeck → eBay Browse → Apify → null | 10 |
| **LEGO** | Rebrickable (enrichissement set) | Rebrickable+eBay Browse → Apify → null | 7 |

### Catégories eBay-only (dépendent du quota eBay)
| Catégorie | Queries | Note |
|-----------|---------|------|
| **Topps F1** | 7 | Pas d'API niche (SportsCardsPro payant) |
| **One Piece TCG** | 7 | Pas d'API niche |
| **Topps Football** | 15 | NOUVEAU 23/03 — Chrome, UEFA, Yamal, Bellingham, Prizm, Donruss |
| **Topps UFC** | 10 | NOUVEAU 23/03 |
| **Topps Tennis** | 8 | NOUVEAU 23/03 |
| **Topps Sport General** | 10 | NOUVEAU 23/03 — Sapphire, Gold Refractor, Bowman Chrome |

### Catégories DÉSACTIVÉES (matching structurel prêt dans matching.js)
- Sneakers (taille), Vêtements Vintage (marque+taille), Tech (état), Consoles Retro (modèle+état), Vinyles (pressage), Topps Chrome Football (ancien, remplacé par Topps Football)

### Gestion dynamique du quota eBay
- eBay > 500 appels restants → toutes les catégories tournent
- eBay < 500 → les catégories eBay-only sont automatiquement désactivées, focus sur Pokémon/Yu-Gi-Oh (APIs gratuites)

---

## CLÉS API (dans .env)

| Clé | Service | Quota | État |
|-----|---------|-------|------|
| EBAY_APP_ID + SECRET | eBay Browse API | 5000/jour (demande upgrade 1.5M en cours, ticket #0651000-000695) | ✅ Actif |
| APIFY_API_TOKEN | Apify eBay Sold Listings | 50 appels/jour (limite dans le code) + cache 7 jours | ⚠️ Budget mensuel souvent épuisé |
| POKEMON_TCG_API_KEY | PokemonTCG.io | 20 000/jour | ✅ Actif |
| OPENAI_API_KEY | GPT-4o mini Vision | Pay per use (~0.03¢/comparaison) | ✅ Actif |
| REBRICKABLE_API_KEY | Rebrickable LEGO | 5000/jour | ✅ Actif |
| TELEGRAM_BOT_TOKEN + CHAT_ID | Bot Telegram alertes | Illimité | ✅ Actif |
| DECODO_SCRAPING_API | Proxy résidentiel | DÉSACTIVÉ (false) — ne sert à rien pour eBay | ❌ Désactivé |

### Config .env importantes
```
EBAY_MARKETPLACES=EBAY_GB
MAX_ITEMS_PER_SEARCH=30
HTTP_MIN_DELAY_MS=2000
HTTP_MAX_DELAY_MS=3500
DECODO_SCRAPING_API=false
VINTED_COUNTRIES=be,fr
TELEGRAM_MIN_CONFIDENCE=50
APIFY_DAILY_LIMIT=50
SEARCH_SNEAKERS=false
SEARCH_LEGO=true
SEARCH_VINTAGE=false
SEARCH_TECH=false
SEARCH_RETRO=false
SEARCH_VINYLES=false
REVERSE_SCAN_ENABLED=false
CARDMARKET_SCAN_ENABLED=false
```

---

## ARCHITECTURE COMPLÈTE DU BOT

### Pipeline de scan (15 étapes)
```
1. Scraping Vinted (BE ou FR en rotation, 30 items/query)
2. Filtrage initial (prix > 2€, pas manga/livre/notice/boîte vide, pas déjà vu)
3. Enregistrement prix Vinted dans la base locale (dédupliqué par Vinted ID)
4. Base de données locale (si ≥3 observations → utilise prix local, sinon continue)
5. API niche (PokemonTCG.io / YGOPRODeck / Rebrickable)
6. eBay Browse API (fallback)
7. Apify eBay Sold (dernier recours, cache 7j, limite 50/jour)
8. Matching texte (numéro carte, print run, set code, graded vs raw, lot vs single)
9. Matching image local (border color + OCR Tesseract + grid brightness + pHash)
10. Calcul profit (prix marché - 13% eBay - 3% paiement - livraison - prix achat)
11. Score confiance (3 tiers : texte 0-40 + source 0-20 + vision 0-40)
12. Score liquidité (volume 35% + vitesse 30% + stabilité 20% + turnover 15%)
13. Gate qualité (confiance ≥50, profit >5€, marge >20%, liquidité ≥40)
14. GPT-4o mini Vision (compare les deux images, rejette si pas même carte)
15. Alerte Telegram + affichage dashboard
```

### Cascade de prix par catégorie
```
Pokémon     → PokemonTCG.io → TCGdex → eBay Browse → Apify → null
Yu-Gi-Oh    → YGOPRODeck → eBay Browse → Apify → null
LEGO        → Rebrickable+eBay Browse → Apify → null
Topps F1    → eBay Browse → Apify → null
One Piece   → eBay Browse → Apify → null
Topps Sport → eBay Browse → Apify → null
```

### Scoring de confiance (3 tiers, max 100)
```
TIER 1 — Match texte (0-40) :
  matchScore ≥12 → 40 | ≥8 → 30 | ≥4 → 20 | sinon → 10
  Pas de match mais API niche ou local-db → 30

TIER 2 — Source fiable (0-20) :
  PokemonTCG.io / YGOPRODeck → 20
  local-database (10+ scans) → 20 | 5+ → 15 | 3+ → 10
  eBay Browse (3+ ventes) → 10-15
  Apify → 10
  Fallback → 5

TIER 3 — Vision IA (0-40) :
  GPT confirme → +40
  GPT rejette → return 0 (REJET IMMÉDIAT)
  Hash local ≥0.85 → 25 | ≥0.75 → 15
  local-database → 15
  Pas d'image → 0

Pénalités : feedback-learner (jusqu'à -50), vendeur suspect (<20) → cap 40
```

### Scoring de liquidité (0-100)
```
Volume (35%) : 0-20 ventes → 0-100 pts
Vitesse (30%) : jours entre ventes → <1j=100, 1-3j=80, 3-7j=60, 7-14j=40, 14+j=20
Stabilité (20%) : CV des prix → <0.1=100, 0.1-0.2=80, etc.
Turnover Vinted (15%) : ratio annonces expirées par catégorie
Classification : flash (80+), rapide (60-79), normal (40-59), lent (20-39), très lent (<20)
```

---

## FICHIERS DU PROJET (src/)

### Fichiers principaux
| Fichier | Lignes | Rôle |
|---------|--------|------|
| src/index.js | 755 | Point d'entrée, boucle scan, filtres, gate qualité, vision auto |
| src/config.js | 565 | 9 catégories, .env parsing, queries Vinted |
| src/server.js | 1363 | Express, API REST, SSE, dashboard, endpoints verify/portfolio |
| src/dashboard.html | ~3000 | Interface web complète, dark mode |
| src/price-router.js | 567 | Routage cascade de prix par catégorie |
| src/matching.js | ~800 | Matching texte, card number, print run, structural matching |
| src/scoring.js | 371 | Confiance (3 tiers) + liquidité unifiée |
| src/profit.js | ~200 | Calcul profit net, frais, seuils |
| src/image-match.js | ~400 | Hash perceptuel amélioré : border color, OCR, grid brightness |
| src/price-database.js | ~500 | Base locale : prix Vinted (par ID unique) + prix marché |
| src/seen-listings.js | ~150 | Cache annonces déjà traitées (24h, skip sauf "no-price") |
| src/vision-verify.js | 74 | GPT-4o mini Vision compare deux images de cartes |
| src/notifier.js | 270 | Alertes Telegram (sendPhoto + sendMessage, MarkdownV2, boutons inline) |
| src/telegram-handler.js | ~200 | Polling Telegram 5s, actions 💰/❌/🔍 |
| src/api-monitor.js | 77 | Alertes API (quota eBay, Apify, PokemonTCG.io, etc.) |
| src/seller-score.js | ~100 | Score vendeur Vinted (réputation, avis, ventes) |
| src/feedback-learner.js | ~200 | Apprentissage des rejets ✗ → règles automatiques |
| src/portfolio.js | ~200 | Suivi achats/ventes, profit réalisé/latent |
| src/keyword-estimator.js | ~300 | DÉSACTIVÉ — retourne toujours null |
| src/description-enricher.js | ~150 | Enrichit titres Vinted avec descriptions |
| src/http.js | ~400 | Requêtes HTTP, proxy, cache disque |
| src/utils.js | ~100 | Utilitaires (toSlugTokens, etc.) |

### Marketplaces (src/marketplaces/)
| Fichier | Rôle | État |
|---------|------|------|
| vinted.js | Scraping Vinted (API JSON + HTML fallback) | ✅ Actif, extrait listing.id |
| ebay-api.js | eBay Browse API OAuth2, quota tracking, skip quand épuisé | ✅ Actif |
| apify-ebay.js | Apify eBay Sold, cache 7j, budget 50/jour, soldAtTs fix | ✅ Actif |
| pokemontcg-api.js | PokemonTCG.io, extractBestPrice par variante du titre | ✅ Actif, fix variante (normal vs reverse holo vs 1st edition) |
| pokemon-tcg.js | TCGdex (traduction FR→EN) | ✅ Actif |
| ygoprodeck.js | YGOPRODeck, lowest price fallback, 30x hard cap | ✅ Actif |
| lego-api.js | Rebrickable enrichissement set | ✅ Actif |
| discogs-api.js | Discogs vinyles | ⏸ Désactivé (catégorie inactive) |
| sneaks-api.js | Sneaks API | ❌ Hardcoded return null (StockX cassé) |
| ebay.js | eBay HTML scraping | ⏸ Decodo désactivé |
| cardmarket.js | Cardmarket | ⏸ API fermée aux nouvelles inscriptions |
| facebook.js | Facebook Marketplace | ⏸ Non implémenté |
| leboncoin.js | Leboncoin | ⏸ Non implémenté |

### Agents (src/agents/) — TOUS DÉSACTIVÉS en auto
| Agent | Rôle | État |
|-------|------|------|
| orchestrator.js | Coordonne tous les agents | ❌ Désactivé (spammait Telegram) |
| supervisor.js | Vérifie si annonces Vinted encore en ligne | ❌ Désactivé |
| discovery.js | Suggestions de niches | ❌ Désactivé (return null en ligne 1) |
| diagnostic.js | Santé des APIs | ❌ Désactivé |
| strategist.js | Portfolio théorique | ❌ Désactivé (remplacé par portfolio.js) |
| liquidity.js | Analyse liquidité | ❌ Désactivé (intégré dans scoring.js) |
| product-explorer.js | Exploration catégories | ❌ Désactivé |

Les boutons "Lancer" sont toujours sur le dashboard pour usage manuel si besoin.

### Scanners (src/scanners/)
| Fichier | Rôle | État |
|---------|------|------|
| reverse-scanner.js | Scan eBay→Vinted (arbitrage inversé) | ⏸ REVERSE_SCAN_ENABLED=false |
| cardmarket-scanner.js | Prix Cardmarket vs eBay | ⏸ CARDMARKET_SCAN_ENABLED=false |

---

## BASE DE DONNÉES DE PRIX (output/price-database.json)

### Structure par produit
```json
{
  "topps-chrome-f1-2025-lando-norris-#147-/140-wave": {
    "name": "Topps chrome f1 2025 Lando Norris award winners #147 /140 wave",
    "category": "topps-f1",
    "vintedPrices": [
      { "price": 3.85, "vintedId": "8234567890", "date": "2026-03-23", "country": "be" }
    ],
    "avgVintedPrice": 3.85,
    "minVintedPrice": 3.85,
    "maxVintedPrice": 3.85,
    "vintedObservations": 1,
    "marketPrices": [
      { "price": 6.27, "source": "ebay-browse-api", "date": "2026-03-22" }
    ],
    "avgMarketPrice": 6.27,
    "marketObservations": 1,
    "lastSeen": "2026-03-23",
    "firstSeen": "2026-03-22"
  }
}
```

### Stats actuelles (23/03/2026)
- **326 produits** : topps-f1 (35), pokemon (46), one-piece (48), yugioh (40), lego (55), topps-football (19), topps-ufc (30), topps-tennis (26), topps-sport-general (27)
- Clé basée sur le TITRE uniquement (pas la catégorie ni la source)
- Catégorie détectée automatiquement depuis le titre
- Prix Vinted dédupliqués par Vinted ID
- Max 30 observations Vinted, 20 observations marché par produit
- Pruning automatique > 90 jours
- Sauvegarde debounced 2s + flush sync sur SIGTERM/exit

---

## DASHBOARD (src/dashboard.html + src/server.js)

### Sections visibles
1. **Header** : statut, dernier scan (pays + timing), eBay quota, base produits, vus, bouton Scanner
2. **Stats** : profit estimé total, opportunités actives, annonces scannées, taux de réussite
3. **Contrôle agents** : 5 boutons "Lancer" (tous inactifs par défaut)
4. **Opportunités** : tabs Active/Toutes/Expirées/Archivées/Ignorées, filtres confiance/liquidité/plateforme/route
5. **Portfolio** : investi, valeur actuelle, profit latent, réalisé, bouton "Rafraîchir prix"
6. **Base de prix** : collapsible, 326 produits, recherche, filtres catégorie, tableau triable
7. **Tendances prix** : hausse/baisse >15% (nécessite 5+ observations)
8. **Historique scans** : timeline des derniers scans

### Sections SUPPRIMÉES (23/03)
- ❌ Discovery Multi-Catégories (projections fictives)
- ❌ Stats par niche (données fake)
- ❌ Ancien "Portefeuille & Stratégie" (doublon, ne chargeait jamais)

### Boutons par opportunité
- ✅ Valider | ✗ Rejeter (feedback-learner) | 🗑 Archiver | 🔍 Vérifier (GPT Vision) | 💰 Acheté (portfolio)

### Cycle de vie des opportunités
```
active → dismissed (✗) / archived (🗑) / bought (💰) / expired (auto)
- Active = dans le profit total + onglet Actives
- Dismissed = onglet Ignorées, permanent
- Bought = Portfolio, sorti des actives
- Archived = onglet Archivées
- Expired = onglet Expirées
```

---

## ALERTES TELEGRAM

### Format d'alerte opportunité (sendPhoto avec caption MarkdownV2)
```
🔥 OPPORTUNITÉ

📦 {category}
🏷 {title}

💰 Vinted: {vintedPrice}€
📈 Marché: {marketPrice}€ ({source})
💵 Profit: +{profit}€ (+{profitPercent}%)

📊 Confiance: {confidence}/100
🏷 Liquidité: {liquidityScore} ({classification})
✅ Vision IA: Confirmé ({visionConfidence}%)

🔗 Vinted: {url}
🔗 eBay: {searchUrl}
```

### Boutons inline
💰 Acheter | ❌ Ignorer | 🔍 Détails

### Telegram handler (polling 5s)
- `buy_XXX` → ajoute au portfolio
- `ignore_XXX` → marque dismissed
- `verify_XXX` → lance vérification GPT Vision

### Anti-spam
- Résumé scan envoyé UNIQUEMENT si ≥1 opportunité (plus de "0 opportunités" toutes les 15 min)
- Alerte API : cooldown fichier (alert-log.json), 24h pour Apify, 1h pour le reste
- Discovery : complètement tué (return null + filtre notifier)

---

## MATCHING IMAGE AVANCÉ (src/image-match.js)

### Composantes (scoring combiné)
| Feature | Poids | Description |
|---------|-------|------------|
| Border color | 25% | Détecte gold/blue/red/silver/black/green/purple. Mismatch → cap 35% |
| OCR card number | 30% | Tesseract sur le bas de la carte. Mismatch → cap 20% |
| Print run | 10% | /25, /50, /99 détectés. Mismatch → pénalité |
| Grid brightness | 15% | Grille 4x4, compare luminosité (refractor/holo patterns) |
| pHash | 20% | Hash perceptuel classique (average + difference) |

### GPT-4o mini Vision (src/vision-verify.js)
- Appelé AUTOMATIQUEMENT sur chaque match (pas seulement au bouton 🔍)
- Si GPT dit "pas même carte" → rejeté avant d'atteindre le dashboard
- Si GPT confirme → confiance +40 points
- Modèle : gpt-4o-mini, max_tokens 500
- Coût : ~0.03¢ par comparaison
- Prompt demande JSON structuré : sameCard, confidence, card1/card2 détails, differences

---

## ROTATION PAYS VINTED

- `VINTED_COUNTRIES=be,fr` (DE désactivé — captcha anti-bot)
- En mode loop : rotation BE→FR→BE→FR...
- En mode single (`npm start`) : scanne tous les pays configurés
- Dashboard affiche le dernier pays scanné + drapeau

---

## FILTRES AUTOMATIQUES

### Listings ignorés
- Prix < 2€
- Manga/livre : "tome", "manga", "livre", "roman", "volume", "coffret", "book"
- Junk : "notice", "instructions", "manuel", "boîte vide", "empty box", "box only"
- Déjà vu (seen-listings, 24h) sauf si résultat précédent = "no-price" (retry)

### Seuils qualité pour créer une opportunité
- Profit > 5€ (ou minimum catégorie si plus élevé)
- Marge > 20%
- Confiance ≥ 50/100
- Liquidité ≥ 40/100
- Vision IA ≠ "pas même carte"

---

## ERREURS CONNUES ET LEÇONS (23/03/2026)

### Problèmes actifs
1. **TG-Handler poll error** — erreurs vides récurrentes (~toutes les 15 min). Le bot continue, mais les commandes Telegram peuvent être ratées.
2. **Telegram sendPhoto 400** — caractères spéciaux non échappés dans certains titres (`.` dans MarkdownV2). Fix partiel déployé, peut encore arriver.
3. **Vinted BE captcha** — page 3 de certaines requêtes (ex: "topps tennis gold") bloquée par anti-bot. Les pages 1-2 passent.
4. **Rebrickable set ID mismatch** — `8403` résolu comme "Marvel Avengers" au lieu de "City Family House". Numéros courts (4 chiffres) sont ambigus.
5. **appendScanHistory scope bug** — l'import est au niveau module mais la variable est re-déclarée dans main(). Partiellement corrigé, peut revenir si le fichier est réécrit.
6. **Cache HTTP 2.9 Go** — les anciens caches eBay/Cardmarket/Leboncoin prennent beaucoup de place. Seuls les caches actifs (vinted, ebay-browse-api, pokemontcg-api, image-fingerprints) sont nécessaires.

### Erreurs passées et leçons
| Erreur | Conséquence | Leçon |
|--------|-------------|-------|
| Worktrees Git | Modifications perdues | TOUJOURS travailler dans le repo principal, PAS un worktree |
| Keyword estimator créait de faux prix | Dashboard pollué de faux positifs | Désactivé, retourne null |
| YGOPRODeck retournait la variante la plus chère | Dark Magician 3.84€ → 689€ | Lowest price fallback + 30x hard cap |
| PokemonTCG.io prenait Reverse Holo au lieu de Normal | Eevee 4.89€ → 55.79€ | extractBestPrice analyse le titre pour choisir la variante |
| eBay rate-limit boucle 30s | Scan bloqué 10+ min | Skip immédiat quand quota = 0 |
| Apify brûlait 5€ en 1h | Crédits épuisés | Cache 7j + limite 50/jour + budget tracking |
| Discovery spammait Telegram toutes les 10 min | 50+ messages/jour inutiles | Agents désactivés, Discovery return null, filtre notifier |
| Base de données perdait des produits | 72→62 à chaque restart | Flush sync sur SIGTERM + startup save immédiat |
| PM2 gardait .env en cache | Vinted DE actif malgré .env changé | `pm2 delete` + `pm2 start ecosystem.config.js` |
| Même annonce Vinted comptée 2x dans la base | Min=Max pour tous les produits | Déduplication par Vinted ID |

---

## FEEDBACKS IMPORTANTS DE JUSTIN

1. **Ne JAMAIS inventer de prix** — toujours utiliser les VRAIS prix des VRAIS produits
2. **Toujours modifier la BONNE copie** : Desktop/Dispatch/BOTVINTEDCODEX ET déployer sur VPS
3. **Le matching strict est prioritaire** — Justin préfère RATER des opportunités que voir des faux positifs
4. **Pas de spam Telegram** — uniquement les vraies opportunités (confiance ≥50)
5. **L'API niche en PREMIER** — PokemonTCG.io avant eBay pour Pokémon, YGOPRODeck avant eBay pour Yu-Gi-Oh
6. **La base de données doit S'ACCUMULER** — jamais perdre de données, jamais réinitialiser sans raison
7. **Les prix Vinted doivent être enregistrés** — chaque annonce Vinted vue = prix enregistré dans la base (dédupliqué par ID)
8. **Comparer exactement le même produit** — même variante, même état, même numéro
9. **UNE tâche à la fois** — pas 5 en parallèle sur les mêmes fichiers
10. **Vérifier sur le VPS** — toujours vérifier que les changements sont bien déployés

---

## PROCHAINES ÉTAPES / TODO

### Priorité haute
- Premier achat-revente réel pour valider le bot
- Surveiller les prix via le dashboard (profiter des quotas eBay frais chaque jour)
- Continuer à remplir la base de données locale (326 produits, objectif 1000+)

### Améliorations prévues
- Intégrer BrickLink API pour LEGO (quand Justin a le compte vendeur BrickLink)
- Facebook Marketplace comme source d'achat supplémentaire (scraping via Apify)
- Nettoyer les vieux caches HTTP (2.9 Go de fichiers obsolètes sur le VPS)
- Corriger le bug Rebrickable pour les sets à 4 chiffres
- Améliorer le Telegram handler (erreurs de polling récurrentes)

### Long terme
- Augmenter MAX_ITEMS_PER_SEARCH quand upgrade eBay approuvé
- Ajouter d'autres pays Vinted (NL, ES, IT) quand anti-bot le permet
- Envisager SportsCardsPro API (payant) pour les cartes Topps
- Développer le cross-country arbitrage (Vinted FR→DE)

---

## PORTFOLIO ACTUEL
```json
[
  {
    "title": "Lego Star Wars 9676 - Tie Interceptor & Death Star",
    "category": "LEGO",
    "boughtAt": 16.45,
    "boughtDate": "2026-03-22",
    "currentMarketPrice": 63.76,
    "status": "in_stock"
  }
]
```
Investi : 16.45€ | Valeur actuelle : 63.76€ | Profit latent : +47.31€

---

## POUR REPRENDRE

1. Copier ce fichier dans une nouvelle conversation Claude Dispatch
2. Dire "Reprends le travail sur l'arbitrage"
3. Donner accès au dossier Desktop/Dispatch si nécessaire
4. Le bot tourne sur le VPS (http://76.13.148.209:3000)
5. Priorités : surveiller les opportunités, valider avec un vrai achat, remplir la base de données
