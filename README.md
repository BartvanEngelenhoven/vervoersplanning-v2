# Vervoersplanning V2

De planning voor eigen bezorging van De Rijplaten Specialist en De Slowfeeder Specialist.

- Site: https://specialistenplanning.pages.dev (het oude adres, bartvanengelenhoven.github.io/vervoersplanning-v2, stuurt door)
- Handleiding voor planners en bezorgers: https://specialistenplanning.pages.dev/handleiding

## Wat de site doet

- Leest de open orders van beide winkels, die Shopify via webhooks doorgeeft.
- Deelt elke order in: **Meenemen**, **Ingepland**, **In concept**, **Controleren**, **FVR** (rijplaten die niet met de bus gaan), **DHL** (slowfeeders die niet met de bus gaan) of **Niet meenemen**. Met het min-teken in een voorstel zet de planner een order op FVR of DHL; dat bewaart de Worker (`shipping:`), los van Shopify. De regels staan in de site onder *Regels* en worden rechtstreeks uit de code opgebouwd.
- Maakt ritvoorstellen (A, B, C…). Een voorstel dat je inplant, krijgt een vast ritnummer dat nooit terugkomt.
- Laat de bezorger op de telefoon zijn ritten zien, met per stop naam, adres, telefoon, producten en opmerking, en een knop *Bezorgd*.
- Ververst elke 2 minuten zolang het scherm zichtbaar is; ritten en historie elke 10 minuten en na elke actie.

Wat de site in Shopify verandert:

- **Bezorgd**: zet de order op verzonden (fulfilled), **zonder** mail aan de klant, en schrijft een regel in de ordernotitie. Krijgt Bezorgd geen antwoord van Shopify, dan boekt de Worker de bezorging alsnog zodra Shopify zelf meldt dat de order verzonden is.
- **Terugdraaien**: annuleert die verzending weer. Alleen voor verzendingen die de planning zelf maakte. De historie geeft naast de 50 nieuwste verzendingen (meestal DHL-pakketten) ook de nieuwste 200 bezorgingen van de planning zelf, zodat die niet uit beeld raken.
- Een **pakket in een ingeplande rit** en **Toch zelf bezorgen** krijgen de tag `eigen bezorging`, zodat wie de DHL-labels print ze overslaat.
- De **aankondiging om 16:00** staat op proef: zie hieronder.

## Codes en rollen

Er zijn twee codes, allebei Worker-secrets:

- `OPERATOR_KEY`: de planner. Opent alles.
- `DRIVER_KEY`: de bezorger. Ziet alleen de ritten van de week ervoor tot de week erna, mag daarvan bezorgd melden en een rit afbreken, en mag onderweg een order meenemen in de rit die hij nu rijdt, maar alleen een order die de planning zelf zou aanbieden (betaald, adres compleet, geen afspraak, de dag blijft binnen 5:45, waarbij wat vandaag al bezorgd is meetelt). Van andere orders krijgt de telefoon alleen plaats, postcodecijfers, product en een punt op ongeveer een kilometer nauwkeurig; geen naam, straat of telefoon.

Er zit geen rem op verkeerde pogingen. Kies daarom lange codes, minstens twaalf tekens. De browser onthoudt de code; *Uitloggen* (in het menu, en onderaan het bezorgersscherm) vergeet hem op dat apparaat. Een code wijzigen doe je met `npx wrangler secret put OPERATOR_KEY` (of `DRIVER_KEY`); iedereen moet daarna de nieuwe code invullen.

## Privacy (AVG)

Wat de Worker bewaart (sinds 28 september 2026 in één Durable Object met een eigen SQLite-database bij Cloudflare, zie *Opslag*) en hoe lang:

| Wat | Inhoud | Bewaard |
| --- | --- | --- |
| `order:` | open order: naam, adres, telefoon, klantopmerking, producten | zolang de order open is; geannuleerd tot 14 dagen na de annulering |
| `delivered:` | bezorgde order, **zonder** telefoon en klantopmerking; van een pakket dat niet met de bus ging alleen ordernummer, plaats en product | tot 60 dagen na de bezorging; een latere wijziging in Shopify (terugbetaling, tag) verlengt dat niet (voor records van vóór 25 september 2026 pas na het eenmalige opruimscript, zie hieronder) |
| `plan:` | ingeplande rit: ordernummers, notities | tot 60 dagen na de ritdatum |
| `plan-announce:` | verslag van de aankondiging | 60 dagen |
| `geo:` | adres met coördinaat | 90 dagen (een adres dat niet gevonden werd: 7 dagen) |

Wie gegevens te zien krijgt:

- **Cloudflare** draait de Worker en de opslag.
- **Cloudflare Pages** host de site zelf, zonder klantgegevens. **GitHub Pages** stuurt het oude adres door.
- **PDOK** (de overheid) krijgt de adressen van Nederlandse orders, om ze op de kaart te zetten. Buitenlandse adressen gaan nergens heen.
- **Google Maps**: de kaart op *Vandaag* laadt de adressen van de gekozen rit. De Maps-links gaan pas open als je erop tikt.
- **OpenStreetMap** levert de kaarttegels voor *Kaart*; **unpkg** levert de kaartbibliotheek Leaflet, vastgezet op één versie met een controle-hash.

**Eenmalig opruimen.** De bezorgd-records van vóór 25 september 2026 hebben nog geen bewaartermijn en bevatten soms een telefoonnummer. Draai daarom één keer vanuit deze map:

```bash
node scripts/historie-bewaartermijn.mjs
```

Het script vraagt de plannerscode, laat zien wat het gaat doen en vraagt eerst om "ja". Het werk gebeurt in de Worker; het script werkt dus ook na de verhuizing van de opslag.

**Een klant laten wissen.** Vraagt een klant om verwijdering, wis dan in Shopify de klant, en daarna hier elke kopie van de order, met het kaartpunt van het adres:

```bash
node scripts/klant-wissen.mjs
```

Het script vraagt de plannerscode, de winkel en het ordernummer, en eerst om "ja". Ritten bewaren alleen ordernummers.

Oude versies van de Worker zijn niet bereikbaar: `preview_urls = false` staat bovenaan `wrangler.toml`. Die regel moet boven de eerste `[sectie]` staan; eronder is het een gewone variabele en doet hij niets.

## Rijtijden

Gratis, zonder Google: PDOK zoekt de coördinaten van elk adres op, en de rijtijd wordt geschat als 20,2 minuten op- en afrijden per rit, 5 minuten per extra stop en 0,975 minuut per kilometer hemelsbreed (gemeten op 25 echte adressen, gemiddeld 3,7 minuten mis per enkele reis). Lossen: 20 minuten per stop, 90 voor een hooihuisje.

Zet **geen** `GOOGLE_MAPS_API_KEY`: Google rekent daarvoor.

## Ritregels van september 2026

Sinds 28 september 2026 knipt de planning de orders van één windrichting in ritten van hooguit 5:45: eerst gaan de twee orders samen die het meeste omrijden besparen, dan de volgende, zolang de rit binnen de dag en de bus past. Elke rit moet passen binnen de budgetten van zijn eigen orders (niet meer die van de hele richting). Daardoor komen er zoveel voorstellen als er werk is, in plaats van één per windrichting. Een adres buiten Nederland en België wordt nooit meer op een Nederlandse postcode geschat: het staat onder Controleren, en als je het toch meeneemt, wordt het een eigen rit met *Rijtijd onbekend*. Dit geldt met beide instellingen hieronder.

De controle van september 2026 vond daarnaast een paar plekken waar de planning afweek van de afgesproken regels: een hooihuisje gaf alle orders in dezelfde rit een onbeperkt budget, buren aan weerszijden van een windrichting telden niet samen, en een groep net boven budget kreeg geen ritvoorstel. Die verbeteringen staan achter `ritregelsV3` in `CONFIG` bovenaan `app.js`. `test-planning.mjs` laat per regel zien wat er verandert.

## De aankondiging om 16:00

Om 16:00 de dag vóór een ingeplande rit zet de Worker de betaalde orders van die rit in Shopify op verzonden, **met** de verzendmail aan de klant. Om 16:10 volgt een tweede ronde voor wat de eerste niet kon afmaken. Die gaat zoals de ronde van 16:00 ging: was dat een proef, dan is 16:10 ook een proef. Zolang `AUTO_FULFILL` niet `aan` is, is dit een proef: er gaat niets naar Shopify of klanten, en de agenda toont wat er zou gebeuren.

Voordat je hem aanzet:

1. Test in beide winkels welke verzendmail Shopify stuurt zonder vervoerder, en pas de template aan ("wij bezorgen morgen met onze eigen bus").
2. Kijk of er apps of Flows reageren op *fulfilled* (een reviewverzoek, een factuur): die gaan dan een dag vóór de bezorging af.
3. Loop de agenda van de komende dagen na en haal proefritten weg.
4. Zet hem aan ná 16:10, zodat de eerste echte ronde pas de volgende dag is: `npx wrangler secret put AUTO_FULFILL` met de waarde `aan`. Een secret blijft staan bij een deploy; een variabele in het dashboard niet.

## Lokale checks

```bash
npm install
npm run check
```

Dat controleert de syntax, de vertaling van Shopify-orders, alle Worker-stromen tegen een nagebootste Shopify (`test-backend-flows.mjs`) en de ritregels op verzonnen orders (`test-planning.mjs`).

## De Worker live zetten

De site is statisch (Cloudflare Pages, project `specialistenplanning`). Zet een nieuwe versie online met `npm run site:deploy`; dat plaatst alleen de bestanden die de browser nodig heeft. Een push naar GitHub zet alleen de doorverwijzing op het oude adres neer. De Worker in `backend-worker.js` (Cloudflare Workers, gratis plan) ontvangt de Shopify-webhooks, bewaart de orders en praat met Shopify.

Eenmalig:

```bash
npm install
npx wrangler login
```

Kopieer `wrangler.example.toml` naar `wrangler.toml`. `wrangler.toml` staat bewust in `.gitignore`. De opslag (het Durable Object) maakt Cloudflare bij de eerste deploy zelf aan. Het blok `[[kv_namespaces]]` was alleen nodig voor de verhuizing uit KV van september 2026; bij een nieuwe installatie kan het weg.

Secrets:

```bash
npx wrangler secret put OPERATOR_KEY
npx wrangler secret put DRIVER_KEY
npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
npx wrangler secret put SHOPIFY_CLIENT_ID
npx wrangler secret put SHOPIFY_CLIENT_SECRET
```

Deploy:

```bash
npm run worker:deploy
```

`config.js` bevat alleen de publieke Worker-URL, nooit een sleutel of code.

## Opslag

Alles staat in één Durable Object met een eigen SQLite-database (`PlanningStore` in `backend-worker.js`, de opslag zelf in `planning-store.js`). Elk verzoek aan de Worker gaat daar naartoe, dus elke lezing ziet elke schrijfactie ervoor meteen.

Tot 28 september 2026 stond alles in Cloudflare KV. Het gratis plan van KV staat maar 1.000 keer per dag een lijst opvragen toe, en twee schermen die de hele dag openstonden, gebruikten dat op. Het gratis plan van deze opslag staat per dag 5 miljoen gelezen rijen en 100.000 geschreven rijen toe, en 100.000 verzoeken. Dat is ruim honderd keer wat de planning gebruikt.

- **De verhuizing.** Het object kopieert alles uit KV, met vervaldatum en metadata, in één keer en daarna nooit meer. Tot dat gelukt is, werkt de site gewoon op KV; lukt het niet (KV geeft een fout), dan probeert het object het vijf minuten later opnieuw. Bij de verhuizing is gedeployd met `--var STORE_COPY_AFTER:<tijd>`, een paar minuten na de deploy: KV heeft tot een minuut nodig om een schrijfactie van elders te laten zien. KV zelf blijft staan zoals het die dag was, als reservekopie. *Klant wissen* wist ook daarin.
- **De reservekopie weggooien.** Werkt de nieuwe opslag een week goed, gooi de KV-kopie dan weg: er staan klantgegevens in die anders nooit verlopen. `npx wrangler kv namespace delete --binding PLANNING_ORDERS`, en haal daarna het blok `[[kv_namespaces]]` uit `wrangler.toml`.
- **Nakijken.** `GET /store/status` (met de plannerscode) geeft per soort het aantal sleutels en wanneer de kopie uit KV is gemaakt. Geen klantgegevens.
- **Verlopen gegevens** zijn meteen onzichtbaar en worden elke dag na de run van 16:00 echt verwijderd.
- **Als het dagtegoed toch op is**, meldt de site: *Het gratis dagtegoed van Cloudflare is op. Vanaf 02:00 werkt alles weer; bel tot die tijd de planner.*

## Shopify-koppeling

De Worker krijgt toegang tot Shopify via een eigen app (Shopify Dev Dashboard) en een installatie per winkel. Installeren kan alleen voor de twee eigen winkels:

```text
https://<worker-url>/auth/shopify?shop=de-rijplaten-specialist.myshopify.com
https://<worker-url>/auth/shopify?shop=slowfeeder-specialist.myshopify.com
```

Zet bij de app als App URL `https://<worker-url>/auth/shopify?shop=<winkel>.myshopify.com` en als redirect `https://<worker-url>/auth/shopify/callback`. De Worker registreert zelf de webhooks voor order aangemaakt, gewijzigd en verzonden.

De Shopify API-versie staat op één plek bovenaan `backend-worker.js` (`SHOPIFY_API_VERSION`). Shopify ondersteunt een versie een jaar; zet hem jaarlijks een stap verder en draai `npm run check`.
