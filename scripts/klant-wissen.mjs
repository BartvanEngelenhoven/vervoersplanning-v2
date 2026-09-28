// A customer asks to be erased (AVG): every copy of one order in the planning
// goes, with the point of the address. Erase the customer in Shopify as well;
// that is done there, by hand.
//
// Run it from this folder:  node scripts/klant-wissen.mjs
import { ask, callWorker, stop } from "./planner-vraag.mjs";

const winkels = { r: "de-rijplaten-specialist.myshopify.com", s: "slowfeeder-specialist.myshopify.com" };
const code = await ask("Plannerscode: ", { hidden: true });
const winkel = winkels[(await ask("Winkel, r (rijplaten) of s (slowfeeder): ")).toLowerCase()];
if (!winkel) {
  console.log("Typ r of s.");
  stop(1);
}
const nummer = await ask("Ordernummer, bijvoorbeeld #DRS262533: ");
if ((await ask(`Alles van ${nummer} uit de planning wissen? Typ ja: `)).toLowerCase() !== "ja") {
  console.log("Niets gewist.");
  stop(0);
}
const uitkomst = await callWorker("/store/forget", code, { shopDomain: winkel, id: nummer });
if (!uitkomst.found) {
  console.log("Geen order met dit nummer gevonden. Kijk het nummer na. Klopt het, dan staat er niets meer van in de planning: na de bewaartermijn verdwijnt een order vanzelf.");
} else {
  console.log(`Gewist: ${uitkomst.removed.join(", ")}.`);
}
stop(0);
