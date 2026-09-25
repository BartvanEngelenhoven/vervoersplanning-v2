// One-off: gives the delivery records written before 25 September 2026 the same
// terms as new ones: phone and customer note removed, no name or address for
// parcels that never went with the van, deleted automatically 60 days after
// delivery (records already older than that go within a day), and the delivery
// time in the key's metadata so the history screen finds them.
//
// Run it yourself, once, from this folder:  node scripts/historie-bewaartermijn.mjs
// It prints what it will do and asks before changing anything.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const wrangler = (...args) => execFileSync("npx", ["wrangler", "kv", ...args, "--binding", "PLANNING_ORDERS", "--remote"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const firstJson = (text, open) => JSON.parse(text.slice(text.indexOf(`\n${open}`) >= 0 ? text.indexOf(`\n${open}`) + 1 : text.indexOf(open)));

const keys = firstJson(wrangler("key", "list", "--prefix", "delivered:"), "[");
const old = keys.filter((key) => !key.metadata?.deliveredAt);
console.log(`${keys.length} bezorgd-records, waarvan ${old.length} van vóór de bewaartermijn.`);
if (!old.length) process.exit(0);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "historie-"));
const records = {};
for (let start = 0; start < old.length; start += 90) {
  const list = path.join(dir, "keys.json");
  fs.writeFileSync(list, JSON.stringify(old.slice(start, start + 90).map((key) => key.name)));
  Object.assign(records, firstJson(wrangler("bulk", "get", list), "{"));
}

const now = Math.floor(Date.now() / 1000);
const put = [];
let gaanWeg = 0;
for (const [name, raw] of Object.entries(records)) {
  const record = JSON.parse(typeof raw === "string" ? raw : raw?.value ?? "null");
  if (!record) continue;
  if (record.order) {
    delete record.order.phone;
    delete record.order.customerNote;
    // A parcel Shopify shipped that never went with the van keeps no name or
    // address, the same as the Worker now does for new ones.
    const ownDelivery = String(record.shopDomain || "").includes("rijplaten") || record.order.ownDeliveryTagged || record.order.announced || record.source !== "shopify";
    if (!ownDelivery) record.order = { id: record.order.id, webshop: record.order.webshop, city: record.order.city, products: record.order.products };
  }
  const parsed = Date.parse(record.deliveredAt || "");
  // One clock (UTC) for sorting, as the Worker writes it.
  if (!Number.isNaN(parsed)) record.deliveredAt = new Date(parsed).toISOString();
  const delivered = Number.isNaN(parsed) ? now : parsed / 1000;
  const expiration = Math.max(Math.floor(delivered + 60 * 86400), now + 86400);
  if (expiration <= now + 86400) gaanWeg += 1;
  put.push({ key: name, value: JSON.stringify(record), expiration, metadata: { deliveredAt: record.deliveredAt || "" } });
}

console.log(`Zonder telefoon en klantopmerking opnieuw opslaan: ${put.length}. Daarvan ouder dan 60 dagen, en dus binnen een dag weg: ${gaanWeg}.`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const antwoord = (await rl.question("Doorgaan? Typ ja: ")).trim().toLowerCase();
rl.close();
if (antwoord !== "ja") {
  console.log("Niets veranderd.");
  process.exit(0);
}
const file = path.join(dir, "put.json");
fs.writeFileSync(file, JSON.stringify(put));
wrangler("bulk", "put", file);
fs.rmSync(dir, { recursive: true, force: true });
console.log("Klaar.");
