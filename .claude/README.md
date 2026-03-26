# BOTVINTEDCODEX

Base propre pour un bot d'arbitrage cartes `Vinted -> eBay sold -> Telegram`.

## Ce que fait cette version

- scrape des recherches Vinted configurables sans navigateur
- combine plusieurs requetes seed Vinted par theme pour elargir la couverture
- plafonne la collecte Vinted par requete et par scan pour rester plus propre
- cherche les ventes terminees eBay via le HTML public sur plusieurs marketplaces accessibles
- force le tri eBay sur les ventes terminees les plus recentes
- ne garde que les annonces qui ressemblent vraiment a la meme carte
- exige 2 ventes eBay coherentes et datees pour calculer une marge
- calcule un profit estime avec frais inclus
- ajoute du cache local et un rythme de requetes plus prudent
- parcourt plusieurs pages Vinted/eBay au lieu d'un seul bloc
- sort un JSON dans `output/latest-scan.json`
- envoie un resume Telegram si configure
- ajoute un signal visuel image-a-image comme aide de confiance, sans en faire un blocage dur

## Demarrage

```bash
npm install
cp .env.example .env
npm start
npm run debug:ebay -- "2023-24 Topps Chrome UEFA Club Competitions Lamine Yamal #64 PSA 9"
```

## Variables utiles

- `MIN_PROFIT_EUR`
- `MIN_PROFIT_PERCENT`
- `MAX_ITEMS_PER_SEARCH`
- `REQUEST_TIMEOUT_MS`
- `VINTED_SHIPPING_ESTIMATE`
- `EBAY_OUTBOUND_SHIPPING_ESTIMATE`
- `VINTED_PAGES_PER_SEARCH`
- `VINTED_MAX_LISTINGS_PER_QUERY`
- `VINTED_MAX_LISTINGS_PER_SEARCH`
- `EBAY_PAGES_PER_QUERY`
- `HTTP_MIN_DELAY_MS`
- `HTTP_MAX_DELAY_MS`
- `CACHE_TTL_SECONDS`
- `MIN_LISTING_SPECIFICITY`
- `MAX_EBAY_QUERY_VARIANTS`
- `EBAY_BASE_URLS`
- `EBAY_FINDING_API_ENABLED`
- `USD_TO_EUR_RATE`
- `GBP_TO_EUR_RATE`
- `EBAY_APP_ID`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Limites actuelles

- le matching "meme image" n'est pas encore un vrai matching visuel perceptuel
- les selecteurs Vinted/eBay devront peut-etre etre ajustes apres test reel
- il n'y a pas encore de dedoublonnage multi-scan ni de scheduler
- le vieux `Finding API` eBay n'est plus active par defaut pour les ventes terminees
- le matching "meme image" n'est toujours pas un vrai matching visuel

## Architecture

- [`src/index.js`](/C:/Users/chape/Desktop/BOTVINTEDCODEX/src/index.js)
- [`src/marketplaces/vinted.js`](/C:/Users/chape/Desktop/BOTVINTEDCODEX/src/marketplaces/vinted.js)
- [`src/marketplaces/ebay.js`](/C:/Users/chape/Desktop/BOTVINTEDCODEX/src/marketplaces/ebay.js)
- [`src/matching.js`](/C:/Users/chape/Desktop/BOTVINTEDCODEX/src/matching.js)
- [`src/profit.js`](/C:/Users/chape/Desktop/BOTVINTEDCODEX/src/profit.js)
- [`src/notifier.js`](/C:/Users/chape/Desktop/BOTVINTEDCODEX/src/notifier.js)
