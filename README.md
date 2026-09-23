# Vervoersplanning V2 — experiment

Deze map bevat een losstaande proefversie. De bestaande GPT en V1-site worden niet gewijzigd.

Live proefversie: https://bartvanengelenhoven.github.io/vervoersplanning-v2/

## Wat deze eerste versie doet

- laadt automatisch ordergegevens uit een JSON-bron;
- beoordeelt orders met vaste, uitlegbare regels;
- toont `Meenemen`, `Controleren` of `Niet meenemen`;
- groepeert geschikte orders tot eenvoudige ritvoorstellen;
- ververst automatisch iedere minuut;
- schrijft niets terug.

De meegeleverde gegevens zijn fictief. Plaats nooit Shopify-sleutels of echte klantgegevens in deze openbare map.

## Gratis publiceren via GitHub Pages

1. Maak een gratis GitHub-account en een lege repository aan.
2. Zet de inhoud van deze map in de repository.
3. Kies in GitHub onder **Settings → Pages → Source** voor **GitHub Actions**.
4. Een push naar `main` publiceert de site automatisch.

## Eerste automatische koppeling

Deze repo bevat nu ook een backend-template in `backend-worker.js`. Die is bedoeld voor Cloudflare Workers of een vergelijkbare veilige backend. De openbare GitHub Pages-site mag alleen opgeschoonde ordergegevens lezen. Shopify secrets blijven in de backend.

Stroom:

1. Shopify stuurt een order-webhook naar `/webhooks/shopify/orders`.
2. De backend controleert de Shopify HMAC-handtekening.
3. De backend vertaalt de Shopify order naar het simpele planningformaat dat `app.js` al gebruikt.
4. De backend bewaart alleen de planningvelden.
5. De V2-site leest `/orders` en ververst automatisch.

Voor live gebruik:

1. Maak een KV namespace `PLANNING_ORDERS`.
2. Kopieer `wrangler.example.toml` naar `wrangler.toml` en vul de KV namespace-id in.
3. Deploy `backend-worker.js` als Worker.
4. Zet `SHOPIFY_WEBHOOK_SECRET` als secret in de Worker.
5. Zet optioneel `CORS_ORIGIN=https://bartvanengelenhoven.github.io`.
6. Vul in `config.js` de Worker `/orders` URL in.
7. Voeg in Shopify webhooks toe voor order create/update/cancel/fulfilled naar `/webhooks/shopify/orders`.

`config.js` bevat geen geheimen. Publiceer nooit Shopify API keys, webhook secrets of ruwe klantgegevens in deze repo.

## Volgende fase

De Shopify-koppeling heeft een beveiligde backend nodig. GitHub Pages blijft het dashboard hosten; de backend bewaart de Shopify-sleutel, verifieert webhooks en geeft alleen de benodigde planninggegevens door.

De regelset moet samen met de planner worden vastgesteld voordat V2 echte beslissingen mag nemen.


## Lokale checks

Controleer de frontend en Shopify mapping lokaal met:

```bash
node --check app.js
node --check backend-worker.js
node --check config.js
node test-backend-mapping.mjs
```
