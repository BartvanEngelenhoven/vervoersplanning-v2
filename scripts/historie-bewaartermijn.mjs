// One-off: gives the delivery records written before the terms of September 2026
// the same terms as new ones: phone and customer note removed, no name or
// address for parcels that never went with the van, deleted 60 days after
// delivery (records already older than that at once), and deliveries made
// through the planning marked as such, so the Bezorgd screen keeps them.
//
// Run it yourself, once, from this folder:  node scripts/historie-bewaartermijn.mjs
// It asks for the planner's code, shows what it will do and asks before
// changing anything. The work is done by the Worker (/store/tidy-history).
import { ask, callWorker } from "./planner-vraag.mjs";

const code = await ask("Plannerscode: ", { hidden: true });
const telling = await callWorker("/store/tidy-history", code, { apply: false });
console.log(`${telling.records} bezorgd-records.`);
console.log(`Zonder telefoon en klantopmerking opnieuw opslaan, met 60 dagen bewaren: ${telling.cleaned}.`);
console.log(`Ouder dan 60 dagen, en dus nu weg: ${telling.removed}.`);
console.log(`Als eigen bezorging gemarkeerd, zodat ze onder Bezorgd blijven staan: ${telling.marked}.`);
if (!telling.cleaned && !telling.removed && !telling.marked) {
  console.log("Er is niets te doen.");
  process.exit(0);
}
if ((await ask("Doorgaan? Typ ja: ")).toLowerCase() !== "ja") {
  console.log("Niets veranderd.");
  process.exit(0);
}
await callWorker("/store/tidy-history", code, { apply: true });
console.log("Klaar.");
