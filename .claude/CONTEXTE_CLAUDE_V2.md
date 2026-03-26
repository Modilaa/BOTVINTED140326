# CONTEXTE CLAUDE — Session Arbitrage Justin
## Date : 2026-03-19

---

## QUI EST JUSTIN
- Entrepreneur tech français basé en Belgique
- Email : chapelle1511@gmail.com
- Capital de départ : 500-1000€
- Objectif : 5000€/mois avec l'arbitrage achat-revente
- Projets : BOTVINTEDCODEX (arbitrage TCG), ARBITRAGE-V2 (arbitrage multi-produits), Rusé le Renard (vidéos IA), Automaly (agence immo IA)
- PC : Windows, RTX 4050 Laptop 6 Go VRAM, 24 Go RAM

## VPS HOSTINGER
- IP : 76.13.148.209
- SSH : root@76.13.148.209
- Ubuntu 24.04, PM2, Docker, Node v20.20.1
- Ports ouverts : 22, 80, 443, 3000, 4200, 5000
- Dashboard CODEX : http://76.13.148.209:3000
- API Hostinger token configuré

## PROJET 1 : BOTVINTEDCODEX
- **Chemin local** : C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX
- **Chemin VPS** : /root/botvintedcodex
- **Stack** : Node.js CommonJS, Express, PM2
- **Scrape** : Vinted (OK), Cardmarket (bloqué captcha), Leboncoin (bloqué captcha)
- **Pricing** : eBay Browse API (OK avec rate limit), PokemonTCG.io (OK), YGOPRODeck (OK)
- **12 catégories** : Topps F1, Topps Chrome Football, Pokemon, One Piece TCG, Panini Football, Yu-Gi-Oh, Sneakers, LEGO, Vêtements Vintage, Tech, Consoles Rétro, Vinyles
- **7 agents** : supervisor, discovery, diagnostic, product-explorer, strategist, liquidity, orchestrator
- **Scheduler** : src/scheduler.js (diagnostic 6h, discovery 12h, explorateur 24h)
- **Dashboard** : dark mode, interactif, boutons agents, historique persistant, filtres, portefeuille
- **Matching** : détection variantes (/50 vs signed), lots filtrés, 21 tests passent
- **Liens source** : PokéTCG, YGO, Cardmarket, eBay dans dashboard + Telegram

### Clés API eBay
- EBAY_APP_ID : ***REDACTED***
- EBAY_CLIENT_SECRET : ***REDACTED***
- PRICING_STRATEGY : api
- Dev ID : ***REDACTED***

### Problèmes connus à corriger
- API eBay Browse rate limit : fix appliqué (2 marketplaces GB+DE, 1 query/carte, 500ms délai, retry 30s sur 429)
- Cardmarket et Leboncoin bloqués par captcha — pas de solution gratuite
- Le proxy Decodo dans le .env ne fonctionne pas (credentials invalides ou service expiré ce mois)
- Le superviseur ne vérifie pas les images (ex: carte japonaise vs titre français) — à faire : chercher le prix dans la bonne langue
- Déploiement VPS : deploy_final.ps1 fonctionne (archive → scp → SSH bash -s via HERE-STRING)
- Le terminal web Hostinger se déconnecte souvent — utiliser des commandes courtes

### Ce qui fonctionne confirmé
- Vinted scraping : OK
- eBay Browse API : OK (avec rate limiting prudent)
- PokemonTCG.io : OK (prix TCGPlayer directs)
- YGOPRODeck : OK (prix Cardmarket directs)
- Dashboard web : OK (localhost:3000)
- Historique persistant : OK (opportunities-history.json)
- Matching amélioré : OK (variantes, lots, gradées filtrés)
- 12 catégories configurées dans config.js : OK

## PROJET 2 : ARBITRAGE-V2 (NOUVEAU)
- **Chemin** : C:\Users\chape\Desktop\Dispatch\ARBITRAGE-V2
- **Dashboard** : http://localhost:4000
- **Stack** : Node.js
- **8 niches** : sneakers Nike Dunk/Jordan, iPhone reconditionné, AirPods, PS5 jeux, North Face, Dyson, Switch jeux, Canon objectifs
- Utilise eBay Browse API pour trouver des prix d'achat bas ET des prix de revente élevés
- Calcul profit net après frais eBay (13%)
- Dashboard dark theme, filtres par niche/profit
- Scan auto toutes les 5 minutes
- Lancer : `cd ARBITRAGE-V2 && npm start` → http://localhost:4000

## PROJET 3 : Rusé le Renard
- Pipeline vidéo IA éducative (personnage 3D Pixar)
- ComfyUI portable sur Bureau (~40 Go) avec Wan 2.2 GGUF
- Script installer_modeles_wan22.bat + workflow JSON sur le Bureau
- Coûts réels : Veo 3 = 25-30€/vidéo, Kling = 10€/abo
- Pipeline Python sur VPS : /root/renard-pipeline

## FEEDBACKS IMPORTANTS DE JUSTIN
1. **Ne pas inventer de prix ou de décotes** — toujours chercher le VRAI prix du VRAI produit dans la BONNE langue/état
2. **Toujours modifier la BONNE copie** : Desktop/Dispatch/BOTVINTEDCODEX (PAS Desktop/BOTVINTEDCODEX)
3. **Synchroniser local et VPS** après chaque modification
4. **Purger l'historique** quand les données sont obsolètes (opportunities-history.json → [])
5. **Le bot doit relancer pour charger le nouveau code** — les modifications de fichiers ne prennent effet qu'après restart
6. **Vérifier en LOCAL d'abord** avant de déployer sur le VPS
7. **Les boutons agents du dashboard** doivent montrer des résultats clairs et compréhensibles
8. **Comparer exactement le même produit** : même langue, même état, même variante

## ARCHITECTURE DE DÉPLOIEMENT
1. Modifier le code localement (tâches Cowork)
2. Tester en local : `cd BOTVINTEDCODEX && npm start` → http://localhost:3000
3. Vérifier que ça marche
4. Déployer : `deploy_final.ps1` (clic droit → Exécuter avec PowerShell)
5. Le script fait : tar.gz → scp → SSH bash -s (plus de problème CRLF)

## POUR REPRENDRE
1. Copier ce fichier dans une nouvelle conversation Claude
2. Dire "reprends le travail sur l'arbitrage"
3. Donner accès au dossier Desktop/Dispatch
4. Priorités : faire fonctionner les scans avec de vraies opportunités, premier achat, déployer sur VPS
