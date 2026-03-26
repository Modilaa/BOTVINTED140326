# CONTEXTE CLAUDE V3 — Session Arbitrage Justin
## Date : 2026-03-21
## Objectif : Reprendre exactement où on en est

---

## QUI EST JUSTIN
- Entrepreneur tech français basé en Belgique
- Email : chapelle1511@gmail.com
- Capital de départ : 500-1000€
- Objectif : 5000€/mois avec l'arbitrage achat-revente
- PC : Windows, RTX 4050 Laptop 6 Go VRAM, 24 Go RAM
- Projets : BOTVINTEDCODEX (arbitrage TCG + multi-produits), Rusé le Renard (vidéos IA)

## VPS HOSTINGER
- IP : 76.13.148.209
- SSH : root@76.13.148.209
- Ubuntu 24.04, PM2, Docker, Node v20.20.1
- Ports ouverts : 22, 80, 443, 3000, 4200, 5000
- Le bot n'est PAS encore déployé sur le VPS (tout est en local)

---

## PROJET : BOTVINTEDCODEX

### Chemins
- **Local** : C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX
- **VPS** : /root/botvintedcodex (pas à jour)
- **Archive** : C:\Users\chape\Desktop\Dispatch\Archive\ (contient ARBITRAGE-V2 et vinted-extension, plus utilisés)
- **Scrap** : C:\Users\chape\Desktop\Dispatch\scrap\ (script Python de référence, code utile déjà intégré)

### Stack
- Node.js CommonJS, Express, PM2
- Dashboard : http://localhost:3000
- 12 catégories configurées
- 7 agents (supervisor, discovery, diagnostic, product-explorer, strategist, liquidity, orchestrator)
- Scheduler : src/scheduler.js

### Clés API (dans .env)
- **eBay** : EBAY_APP_ID=***REDACTED*** / EBAY_CLIENT_SECRET=***REDACTED*** / Dev ID=***REDACTED***
- **Apify** : APIFY_API_TOKEN=***REDACTED*** (5$ crédit gratuit, FONCTIONNE)
- **Decodo** : Proxy résidentiel ÉPUISÉ (2.1/2.1 GB), Web Scraping API 1$ crédit (non utilisé). Username: ***REDACTED***, Port: 10001. Le scraping eBay via Decodo NE FONCTIONNE PAS (bloqué/timeout à chaque fois)
- **Rebrickable** : REBRICKABLE_API_KEY=***REDACTED***
- **PokemonTCG.io** : pas de clé requise (mais timeout fréquent)
- **YGOPRODeck** : pas de clé requise
- **Discogs** : pas de clé requise (60 req/min)

### Config .env importantes
```
EBAY_MARKETPLACES=EBAY_GB
MAX_ITEMS_PER_SEARCH=10
HTTP_MIN_DELAY_MS=2000
HTTP_MAX_DELAY_MS=3500
DECODO_SCRAPING_API=true
DECODO_AUTH_TOKEN=***REDACTED***
SEARCH_SNEAKERS=true
SEARCH_LEGO=true
SEARCH_VINTAGE=true
SEARCH_TECH=true
SEARCH_RETRO=true
SEARCH_VINYLES=true
SOURCING_PLATFORMS=vinted
CARDMARKET_ENABLED=false
LEBONCOIN_ENABLED=false
```

---

## ÉTAT DU BOT — CE QUI FONCTIONNE

### Scraping Vinted ✅
- Fonctionne sans proxy
- 10 annonces par catégorie (cap MAX_ITEMS_PER_SEARCH=10)
- Enrichissement des titres via descriptions Vinted (src/description-enricher.js)
- Tri par prix croissant (les moins chers d'abord)

### API eBay Browse ✅ (avec limitations)
- Fonctionne avec token OAuth2
- Quota : 5000 appels/jour (reset à minuit UTC / 1h Belgique)
- **DEMANDE D'UPGRADE EN COURS** : Ticket #0651000-000695 soumis le 21/03/2026, en attente d'approbation (3-5 jours ouvrés). Quota attendu : 1.5 million/jour.
- Badge quota affiché sur le dashboard en temps réel (vert/orange/rouge)
- Cache 7 jours des résultats (output/http-cache/)
- 1 seul marketplace (EBAY_GB)
- Délai 2-3s entre requêtes

### Apify eBay Sold Listings ✅ (NOUVEAU, TESTÉ, FONCTIONNE)
- Scrape les pages "Sold listings" d'eBay via le cloud Apify
- Acteur : caffein.dev~ebay-sold-listings
- Input : { "keyword": "query", "maxItems": 10 }
- Retourne les vrais prix de ventes complétées
- 5$ crédit gratuit/mois (~5000 requêtes)
- Branché comme fallback après l'API Browse : Browse API → Apify → Decodo HTML → Keyword Estimator
- Test réussi : 100 résultats pour "topps chrome f1 2025 bearman", prix médian 17.75€

### PokemonTCG.io ✅ (instable)
- API officielle pour prix TCGPlayer
- Timeout fréquent ("The operation was aborted due to timeout")
- Fallback vers TCGdex (traduction FR→EN des noms) + eBay

### YGOPRODeck ✅ (problème de langue)
- API officielle pour prix Cardmarket Yu-Gi-Oh
- Problème : les noms français des cartes Vinted ne sont pas traduits → 0 résultat
- Besoin d'un traducteur FR→EN pour les noms de cartes Yu-Gi-Oh

### Discogs ✅ (intégré, pas encore testé en production)
- API gratuite pour prix vinyles (lowest, median, highest)
- src/marketplaces/discogs-api.js créé
- Branché dans price-router pour la catégorie Vinyles

### Rebrickable ✅ (intégré, pas encore testé en production)
- API gratuite pour identifier les sets LEGO
- src/marketplaces/lego-api.js créé
- Enrichit les queries avec le numéro de set officiel

### Dashboard ✅
- Dark mode, interactif
- Boutons feedback ✓/✗ avec notes + base de données feedback-reports.json
- Bouton supprimer (dismiss)
- Modal de feedback en overlay (survit au refresh)
- Protection anti-refresh pendant interaction (oppInteracting flag)
- Feedbacks persistants (relus depuis feedback-reports.json au re-render)
- Anti multi-clic sur les boutons
- Profit total dynamique (se met à jour au dismiss/reject)
- Badge quota eBay en temps réel
- Badge progression scan (X/Y traités)
- Images Vinted + eBay côte à côte avec % similarité
- Titre du comparable eBay affiché
- Badge "⚠ Vérifier" pour profit > 500%
- Badge "⚠ Douteux" pour confiance < 50
- Filtre confiance min (défaut 30)
- Déduplication des opportunités
- Lien recherche eBay cliquable
- Stats par niche
- Discovery Multi-Catégories (suggestions de niches)
- 5 agents avec boutons "Lancer"

### 5 Agents ✅ (tous fonctionnels)
- **Diagnostic** (3/3) : vérifie santé des APIs, requêtes HTTP live
- **Stratégie** (3/3) : gère portfolio, paliers d'investissement, verdict acheter/skip
- **Discovery** (2/3) : suggestions de niches, KB hardcodée + historique
- **Explorateur** (2/3) : recherche de marché, configs Vinted prêtes
- **Liquidité** (2/3) : analyse temps de vente, marge ajustée
- Scheduler séparé (node src/scheduler.js) pour exécution automatique

---

## CE QUI NE FONCTIONNE PAS / PROBLÈMES CONNUS

### Scraping eBay HTML via Decodo ❌
- Le proxy résidentiel est ÉPUISÉ (2.1/2.1 GB)
- Le Web Scraping API retourne "bloqué/timeout" sur CHAQUE requête eBay
- Même avec proxies premium, eBay bloque le scraping HTML
- **INUTILE pour eBay** — consomme le crédit Decodo pour 0 résultat
- Potentiellement utile pour Cardmarket (non testé)

### Sneaks API ❌ (désactivé)
- Package npm sneaks-api crashe le bot ("Cannot read properties of undefined")
- StockX a changé leur site, le package est cassé
- Désactivé dans sneaks-api.js (retourne null immédiatement)
- Catégorie Sneakers redirigée vers eBay

### Matching cartes — PROBLÈME MAJEUR ⚠️
- Le bot matche des cartes du même joueur mais de variantes DIFFÉRENTES
- Ex: "Antonelli #256 base" matchée avec "Antonelli Lights Out /25" à 290€
- Règles de matching par numéro/sous-set/tirage implémentées MAIS dans un worktree, pas sûr qu'elles soient dans le repo principal
- Le matching par image (hash perceptuel) est implémenté mais les scores sont trop permissifs (63-75% pour des cartes visuellement différentes)
- **Le scoring image strict est en place** : <75% similarité → confiance capée à 40/100 max

### Worktree Git — PROBLÈME RÉCURRENT ⚠️
- Les tâches Claude Code modifient des copies (worktrees) au lieu du vrai repo
- Certains fixes n'ont JAMAIS pris effet dans le code réel
- **SOLUTION** : toujours spécifier "modifier DIRECTEMENT dans C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX\" et vérifier que le fichier réel est modifié

### Estimateur mots-clés ⚠️
- Fallback quand toutes les APIs échouent
- Multiplicateurs réduits + cap 50€ max
- NE CRÉE PLUS D'OPPORTUNITÉS (juste logué comme info)
- Toujours trop imprécis pour être fiable

### Rate limit eBay Browse API ⚠️
- 5000 appels/jour consommés très vite (~1200 en 5 minutes)
- En attente d'upgrade à 1.5M/jour (ticket soumis)
- Apify comme fallback fonctionne maintenant

---

## ERREURS FAITES ET LEÇONS APPRISES

### 1. Trop de tâches en parallèle
- **Erreur** : lancer 5-8 tâches simultanées sur les mêmes fichiers
- **Conséquence** : les worktrees se marchent dessus, les merges écrasent les modifications
- **Leçon** : UNE tâche à la fois, vérifier que chaque fix prend effet avant le suivant

### 2. Worktrees non mergés
- **Erreur** : les tâches Claude Code créent des worktrees git isolés, les modifications ne se retrouvent pas dans le repo principal
- **Conséquence** : le .env, http.js, matching.js, scoring.js modifiés "en worktree" mais le bot utilise les anciennes versions
- **Leçon** : toujours utiliser le chemin ABSOLU C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX\ et vérifier les fichiers après modification

### 3. Score de confiance trop généreux
- **Erreur** : confiance à 100% sur des faux matchs (même joueur, carte différente)
- **Conséquence** : Justin voit des opportunités qui n'en sont pas, perd confiance dans le bot
- **Fix** : scoring image strict (cap 40/100 si image < 75%)

### 4. Proxy Decodo mal configuré
- **Erreur** : mauvais port (7000 au lieu de 10001), mauvais username, proxy résidentiel épuisé
- **Fix** : credentials corrigés, mais le scraping eBay via Decodo reste bloqué
- **Leçon** : Decodo ne sert à rien pour eBay. Utiliser Apify à la place.

### 5. MAX_ITEMS_PER_SEARCH=150 au lieu de 10-30
- **Erreur** : le .env avait 150, donc le bot traitait 106 cartes F1 et consommait tout le quota
- **Fix** : passé à 10

### 6. Estimations mots-clés créaient de fausses opportunités
- **Erreur** : "John Terry autograph /25" estimé à 359€, "Bellingham sapphire /99 BGS 9.5" à 627€
- **Fix** : multiplicateurs réduits, cap 50€, les estimations ne créent plus d'opportunités

### 7. Sneaks API crashe le bot
- **Erreur** : le package npm sneaks-api est cassé (StockX changé)
- **Fix** : désactivé, retourne null immédiatement

---

## ARCHITECTURE DU BOT — CASCADE DE PRIX PAR CATÉGORIE

```
Vinted listing (scraping OK)
    │
    ├── Pokémon → eBay Browse API → Apify → PokemonTCG.io → TCGdex+eBay → Keyword est.
    ├── Yu-Gi-Oh → eBay Browse API → Apify → YGOPRODeck → Keyword est.
    ├── Vinyles → Discogs API → eBay Browse API → Apify → Keyword est.
    ├── LEGO → Rebrickable (enrichit) → eBay Browse API → Apify → Estimation pièces
    ├── Sneakers → eBay Browse API → Apify → Keyword est. (Sneaks API désactivé)
    └── Tout le reste → eBay Browse API → Apify → eBay HTML (Decodo, souvent échoue) → Keyword est.
```

---

## FICHIERS CLÉS DU BOT

| Fichier | Rôle |
|---------|------|
| src/index.js | Point d'entrée, boucle de scan, gestion des catégories |
| src/config.js | Configuration des 12 catégories, .env parsing |
| src/server.js | Express server, API REST, SSE, dashboard |
| src/dashboard.html | Interface web complète |
| src/price-router.js | Routage vers la bonne source de prix par catégorie |
| src/matching.js | Matching texte entre titres Vinted et eBay |
| src/scoring.js | Calcul confiance (0-100) et liquidité (0-100) |
| src/profit.js | Calcul profit net, frais, seuils |
| src/utils.js | Utilitaires (toSlugTokens, etc.) |
| src/http.js | Requêtes HTTP, proxy, Decodo Scraping API |
| src/description-enricher.js | Enrichit titres Vinted avec la description |
| src/keyword-estimator.js | Estimation par mots-clés (fallback, désactivé pour opportunités) |
| src/marketplaces/ebay-api.js | eBay Browse API + OAuth2 + cache |
| src/marketplaces/apify-ebay.js | Apify eBay Sold Listings (NOUVEAU, FONCTIONNE) |
| src/marketplaces/discogs-api.js | Discogs API vinyles |
| src/marketplaces/lego-api.js | Rebrickable API LEGO |
| src/marketplaces/sneaks-api.js | Sneaks API (DÉSACTIVÉ) |
| src/marketplaces/pokemon-tcg.js | PokemonTCG.io + TCGdex |
| src/marketplaces/ygoprodeck.js | YGOPRODeck API |
| src/agents/diagnostic.js | Agent diagnostic santé |
| src/agents/discovery.js | Agent discovery niches |
| src/agents/product-explorer.js | Agent explorateur |
| src/agents/strategist.js | Agent stratégie |
| src/agents/liquidity.js | Agent liquidité |
| src/scheduler.js | Planification des agents |
| output/opportunities-history.json | Historique des opportunités |
| output/feedback-reports.json | Rapports de feedback Justin |
| output/portfolio.json | Portfolio stratégie |
| .env | Configuration (NE PAS COMMITER) |

---

## PROCHAINES ÉTAPES — PAR PRIORITÉ

### PRIORITÉ 1 — Vérifier que le matching amélioré est dans le repo principal
Les règles de matching par numéro de carte, sous-set et tirage ont été implémentées dans un worktree. Vérifier qu'elles sont dans le vrai fichier src/matching.js. Si non, les appliquer.

### PRIORITÉ 2 — Attendre l'upgrade quota eBay (3-5 jours)
Ticket #0651000-000695 en cours. Une fois approuvé, passer à 1.5M appels/jour et augmenter MAX_ITEMS_PER_SEARCH à 30-50.

### PRIORITÉ 3 — Optimiser l'utilisation d'Apify
- Le cache des résultats Apify doit être ajouté (comme le cache eBay 7 jours)
- Ne pas appeler Apify si la query est déjà en cache
- Monitorer la consommation du crédit 5$/mois

### PRIORITÉ 4 — Corriger le matching Yu-Gi-Oh
Les noms français ne sont pas traduits → YGOPRODeck retourne 0 résultat. Implémenter un traducteur FR→EN pour les noms de cartes (ex: "Charmeuse du Grand Cercle" → "Enchantress of the Grand Cercle").

### PRIORITÉ 5 — Tester Discogs et Rebrickable en production
Ces APIs sont intégrées mais pas encore testées dans un scan réel. Vérifier qu'elles retournent des prix et que le matching fonctionne.

### PRIORITÉ 6 — Déployer sur le VPS
Une fois le bot stable en local, déployer sur le VPS Hostinger via deploy_final.ps1.

### PRIORITÉ 7 — Améliorer le matching image
Le hash perceptuel actuel ne distingue pas les variantes de cartes du même joueur. Options :
- Comparer uniquement le cadre/bord de la carte (pas le visage)
- Utiliser une API de reconnaissance de cartes (TCGPlayer, CollX)
- Matching par numéro de carte + sous-set (déjà implémenté, à vérifier)

---

## FEEDBACKS IMPORTANTS DE JUSTIN

1. **Ne pas inventer de prix** — toujours utiliser les VRAIS prix des VRAIS produits
2. **Toujours modifier la BONNE copie** : Desktop/Dispatch/BOTVINTEDCODEX (PAS un worktree)
3. **Le matching strict est prioritaire** — Justin préfère RATER des opportunités que montrer des faux positifs
4. **Le dashboard ne doit pas "flasher"** — le refresh pendant un scan doit être discret
5. **Les boutons feedback doivent fonctionner** même pendant un scan
6. **Comparer exactement le même produit** : même variante, même état, même numéro
7. **Purger l'historique** quand les données sont obsolètes
8. **Vérifier en LOCAL d'abord** avant de déployer sur le VPS
9. **UNE tâche à la fois** — pas 5 en parallèle sur les mêmes fichiers
10. **Le proxy Decodo ne sert à rien pour eBay** — utiliser Apify à la place

---

## POUR REPRENDRE

1. Copier ce fichier dans une nouvelle conversation Claude Dispatch
2. Dire "Reprends le travail sur l'arbitrage"
3. Donner accès au dossier Desktop/Dispatch
4. Priorités : vérifier le matching, attendre l'upgrade eBay, optimiser Apify, tester les nouvelles APIs
