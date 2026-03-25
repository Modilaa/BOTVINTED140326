# CONTEXTE CLAUDE — Session BOTVINTEDCODEX + Arbitrage
## Dernière mise à jour : 2026-03-19 10:39 UTC (12:39 heure belge)

---

## OBJECTIFS
- **23-24 mars** : Premiers euros générés via l'arbitrage
- **1er-30 avril** : 5000€/mois net minimum
- Capital de départ : 500€
- Fonctionner au maximum en gratuit (APIs, outils)

---

## ÉTAT DU VPS (76.13.148.209)
- **Bot** : PM2 online, scan toutes les 10 min, 6 niches TCG
- **Dashboard** : http://76.13.148.209:3000
- **Scheduler** : tourne en background (diagnostic 6h, discovery 12h, explorateur 24h)
- **Problème critique** : eBay bloquait 100% des requêtes → FIX EN COURS (proxy Decodo activé dans le code)
- **Ce qui marche** : PokemonTCG.io API, YGOPRODeck API
- **Proxy Decodo** : code corrigé pour router eBay + Cardmarket via proxy. undici ajouté. Besoin de vérifier les credentials dans .env

---

## CODE LOCAL (PC Justin)
- **Chemin** : C:\Users\chape\Desktop\Dispatch\BOTVINTEDCODEX
- **Agents codés** : supervisor, discovery, diagnostic, product-explorer, strategist, liquidity, orchestrator
- **Scheduler** : src/scheduler.js + ecosystem.config.js
- **Dashboard** : interactif, boutons agents, historique persistant, filtres, portefeuille
- **APIs intégrées** : PokemonTCG.io, YGOPRODeck, eBay Browse API (besoin EBAY_CLIENT_SECRET), Cardmarket, Leboncoin
- **Matching** : amélioré avec détection variantes (/50 vs signed), 21 tests passent
- **Liens source** : PokéTCG, YGO, Cardmarket, eBay dans dashboard + Telegram

---

## TÂCHES EN COURS
1. **Proxy Decodo activé** ✅ — Code corrigé, besoin redéployer + vérifier credentials
2. **Refonte Discovery multi-catégories** — En cours (sneakers, LEGO, vinyles, tech, etc.)
3. **Exploration fichiers stratégie Dispatch** — En cours

---

## CE QUI A ÉTÉ FAIT (18-19 mars)
- Audit PC complet (disque, programmes, réseau, sécurité)
- Exploration projet Rusé le Renard + guide ComfyUI Wan 2.2
- Script .bat téléchargement modèles + workflow JSON
- Fix scraper (matching, dictionnaire FR→EN, User-Agents, purge cache)
- Dashboard web dark mode complet
- 7 agents codés et intégrés
- Liens eBay + liens source pricing APIs dans dashboard/Telegram
- Matching précis (Declan Rice /50 ≠ signed, lots filtrés)
- APIs gratuites (PokemonTCG.io, YGOPRODeck, eBay Browse API)
- Cardmarket + Leboncoin scrapers
- Historique persistant + dashboard interactif
- Agent liquidité (marge ajustée)
- Scheduler + ecosystem PM2
- Déploiement VPS (4 déploiements)
- Veille scraping gratuit (rapport complet)

---

## PROCHAINES ÉTAPES
1. Redéployer avec proxy activé → débloquer eBay
2. Refonte Discovery → catégories multi-produits
3. Ajouter queries Vinted pour sneakers, LEGO, vinyles, etc.
4. Obtenir EBAY_CLIENT_SECRET pour l'API Browse officielle
5. Tester un premier achat réel sur Vinted
6. Configurer les alertes Telegram pour notifier des bonnes affaires en temps réel
7. Premier flip avant le 23-24 mars

---

## ACCÈS
- VPS : root@76.13.148.209 (Ubuntu 24.04, PM2, Docker)
- API Hostinger : token configuré
- Terminal web : via hpanel.hostinger.com > VPS > Terminal
- Telegram : bot configuré pour les alertes

---

## POUR REPRENDRE SI SESSION COUPÉE
1. Ouvrir ce fichier CONTEXTE_CLAUDE.md
2. Le copier dans une nouvelle conversation Claude
3. Dire "reprends où on en était"
4. Donner accès au dossier Desktop/Dispatch/BOTVINTEDCODEX
