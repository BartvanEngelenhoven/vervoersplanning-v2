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

## Volgende fase

De Shopify-koppeling heeft een beveiligde backend nodig. GitHub Pages blijft het dashboard hosten; de backend bewaart de Shopify-sleutel, verifieert webhooks en geeft alleen de benodigde planninggegevens door.

De regelset moet samen met de planner worden vastgesteld voordat V2 echte beslissingen mag nemen.
