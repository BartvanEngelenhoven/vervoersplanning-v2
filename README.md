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

## Operatorcode beschermt ook het lezen

`/orders` en `/history` geven klantnamen en adressen terug. Beide eisen daarom de
`OPERATOR_KEY` in de header `x-operator-key`, net als de schrijfacties. De site
vraagt de code eenmalig en onthoudt hem in de browser.

Twee dingen die hierbij horen:

- **Preview URLs staan uit.** Cloudflare zet standaard elke uitgerolde versie op
  een eigen adres, bijvoorbeeld `https://<versie>-vervoersplanning-v2-backend...`.
  Oudere versies van vóór deze beveiliging gaven daar de klantgegevens zonder code
  vrij. `preview_urls = false` staat daarom in `wrangler.toml`, en de instelling is
  ook op de Worker zelf uitgezet.
- **Er zit geen rem op verkeerde pogingen.** Kies daarom een lange code, minstens
  twaalf tekens. Een korte code is binnen een minuut te raden.

## Volgende fase

De Shopify-koppeling heeft een beveiligde backend nodig. GitHub Pages blijft het dashboard hosten; de backend bewaart de Shopify-sleutel, verifieert webhooks en geeft alleen de benodigde planninggegevens door.

De regelset moet samen met de planner worden vastgesteld voordat V2 echte beslissingen mag nemen.


## Lokale checks

Controleer de frontend en Shopify mapping lokaal met:

```bash
npm install
npm run check
```

## Backend live zetten met Cloudflare Workers

De V2-site is een statische GitHub Pages-site. Shopify webhooks kunnen daar niet rechtstreeks heen, omdat Shopify een veilige server nodig heeft die secrets bewaart en webhook-handtekeningen controleert. Gebruik daarom de Worker uit `backend-worker.js`.

Eenmalige setup:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create PLANNING_ORDERS
```

Kopieer daarna `wrangler.example.toml` naar `wrangler.toml` en vul de KV namespace-id in. `wrangler.toml` staat bewust in `.gitignore`, omdat dit lokale deploy-config is.

Zet daarna de Shopify webhook secret als Worker secret:

```bash
npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
```

Deploy de Worker:

```bash
npm run worker:deploy
```

Vul daarna in `config.js` de publieke Worker URL in, bijvoorbeeld:

```js
window.VERVOERSPLANNING_CONFIG = {
  dataUrl: "https://vervoersplanning-v2-backend.<cloudflare-subdomain>.workers.dev/orders",
};
```

Shopify webhooks:

- maak in Shopify een webhook secret aan;
- voeg order create/update/cancel/fulfilled webhooks toe;
- gebruik als webhook URL: `https://<worker-url>/webhooks/shopify/orders`;
- zet formaat op JSON.

Na een nieuwe order schrijft Shopify naar de Worker. De Worker bewaart alleen het planningformaat. De V2-site leest elke minuut `/orders`.

## Shopify app toegang voor "Bezorgd"

De V2-site kan een order pas als bezorgd markeren als de Worker Shopify Admin API toegang heeft. In de nieuwe Shopify Dev Dashboard-flow wordt die token niet meer los getoond. De Worker heeft daarom een OAuth-installatiestap.

Benodigd per omgeving:

- `OPERATOR_KEY`: korte interne code die de planner invult wanneer op **Bezorgd** wordt geklikt.
- `SHOPIFY_CLIENT_ID`: Client ID uit Shopify Dev Dashboard.
- `SHOPIFY_CLIENT_SECRET`: Secret uit Shopify Dev Dashboard.
- `SHOPIFY_ADMIN_SCOPES`: optioneel, komma-gescheiden scopes. Zonder deze variabele gebruikt de Worker de standaard order/fulfillment scopes.

Standaard gebruikt de Worker deze scopes:

```text
read_orders,write_orders,read_fulfillments,write_fulfillments,read_assigned_fulfillment_orders,write_assigned_fulfillment_orders,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders
```

Zet in Shopify Dev Dashboard bij de app:

- App URL: `https://<worker-url>/auth/shopify?shop=<shop>.myshopify.com`
- Allowed redirection URL: `https://<worker-url>/auth/shopify/callback`

Installeer daarna per shop via:

```text
https://<worker-url>/auth/shopify?shop=slowfeeder-specialist.myshopify.com
https://<worker-url>/auth/shopify?shop=de-rijplaten-specialist.myshopify.com
```

De Worker bewaart de verkregen Admin API token veilig in `PLANNING_ORDERS`.

Flow:

1. Planner klikt op **Bezorgd** bij een order in V2.
2. V2 vraagt om de operatorcode.
3. Worker controleert `OPERATOR_KEY`.
4. Worker gebruikt de opgeslagen Shopify Admin token voor de shop.
5. Worker maakt de fulfillment aan in Shopify.
6. Worker verwijdert de order uit `PLANNING_ORDERS`.

## Google Maps routes

V2 maakt nu per rit alvast een klikbare Google Maps route met start en einde `Goorsteeg 46, Ede`. Exacte rijtijd, afstand en optimale stopvolgorde vragen een Google Maps API key in Cloudflare:

```text
GOOGLE_MAPS_API_KEY
```

De API key hoort in Cloudflare als secret/env var, niet in `config.js`. De huidige ritduur is daarom nog een ruwe schatting: 35 minuten rijtijd per stop, minimaal 60 minuten, plus 20 minuten afleveringstijd of 90 minuten voor houten hooihuisjes.
