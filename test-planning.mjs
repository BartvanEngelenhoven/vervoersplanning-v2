// The route rules, run on made-up orders in places whose outcome is known by
// hand. app.js is a browser script; it is loaded here with a stand-in page so
// the planning can be asked what it decides without drawing anything.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

export function loadPlanning({ v3 = true } = {}) {
  let src = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
  src = src.replace("ritregelsV3: false", `ritregelsV3: ${v3}`).replace("ritregelsV3: true", `ritregelsV3: ${v3}`);
  src += "\n;globalThis.__planning = { state, CONFIG, transportRules };";

  const elements = new Map();
  const stub = () => {
    const target = { innerHTML: "", textContent: "", value: "", hidden: false, dataset: {}, style: {}, disabled: false };
    return new Proxy(target, {
      get(obj, prop) {
        if (prop in obj) return obj[prop];
        if (prop === Symbol.toPrimitive) return () => "";
        if (prop === "then") return undefined;
        if (prop === "querySelectorAll") return () => [];
        if (prop === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
        if (prop === "content") return { cloneNode: () => stub() };
        if (prop === "querySelector" || prop === "closest") return () => stub();
        return () => stub();
      },
      set(obj, prop, value) {
        obj[prop] = value;
        return true;
      },
    });
  };
  const element = (selector) => {
    if (!elements.has(selector)) {
      const created = stub();
      if (selector === "#decisionFilter") created.value = "all";
      elements.set(selector, created);
    }
    return elements.get(selector);
  };
  const store = {};
  const context = {
    window: { VERVOERSPLANNING_CONFIG: { dataUrl: "https://planning.test/orders" }, location: { href: "https://planning.test/", reload() {} }, alert() {}, confirm: () => true, prompt: () => "", scrollTo() {} },
    document: { querySelector: element, querySelectorAll: () => [], addEventListener() {}, createElement: () => stub(), body: stub(), visibilityState: "hidden", activeElement: null },
    localStorage: { getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = String(value); }, removeItem: (key) => { delete store[key]; } },
    fetch: () => new Promise(() => {}),
    setInterval() {}, setTimeout() {}, AbortSignal, URL, Intl, Math, Date, JSON, Set, Map, Number, String, Array, Object, Boolean, Infinity, console, crypto: globalThis.crypto,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(src, context);
  return { ...context.__planning, fn: context, element };
}

const DRS = "de-rijplaten-specialist.myshopify.com";
const DSP = "slowfeeder-specialist.myshopify.com";
let counter = 0;

function order(city, lat, lon, { shop = DRS, products = ["4x Kunststof rijplaat 240x120x2 cm"], country = "NL", postcode = "1234 AB", paid = true, dueDate = "2026-12-01", ...rest } = {}) {
  counter += 1;
  return {
    id: `#T${counter}`, shopifyOrderId: `gid://shopify/Order/${counter}`, shopDomain: shop,
    webshop: shop === DRS ? "De Rijplaten Specialist" : "De Slowfeeder Specialist",
    customer: `Voorbeeldklant ${counter}`, fullAddress: `Voorbeeldweg ${counter}, ${postcode} ${city}, ${country}`,
    city, postcode, country, paid, paymentStatus: paid ? "Betaald" : "In afwachting van betaling", cancelled: false, fulfilled: false,
    deliveryMethod: "delivery", addressComplete: true, deliveryAppointmentLocked: false, products, dueDate, weightKg: null,
    _point: lat === null ? null : { lat, lon }, ...rest,
  };
}

function plan(planning, orders, { planned = [] } = {}) {
  const { state, fn } = planning;
  state.geo = {};
  for (const item of orders) if (item._point) state.geo[fn.orderAddress(item)] = item._point;
  state.orders = orders;
  state.allOrders = orders;
  state.plan = planned;
  state.manualRoute = null;
  state.openPlan = null;
  fn.rebuildPlanning();
  const byId = Object.fromEntries(state.decisions.map((item) => [item.order.id, item]));
  return { decision: (o) => byId[o.id].decision, reason: (o) => byId[o.id].reason, routes: state.routes, reviewRoutes: state.reviewRoutes };
}

const hooihuisje = ["1x Slowfeeder hooihuisje voor paarden. Compleet geleverd"];
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(["ok", name]);
  } catch (error) {
    results.push(["FOUT", name, error]);
  }
}

const v3 = loadPlanning({ v3: true });
const v2 = loadPlanning({ v3: false });

test("een hooihuisje maakt het budget van een verre rijplatenorder niet oneindig", () => {
  const huisje = order("Hensbroek", 52.66, 4.87, { shop: DSP, products: hooihuisje });
  const groningen = order("Groningen", 53.22, 6.57);
  const nieuw = plan(v3, [huisje, groningen]);
  assert.equal(nieuw.decision(huisje), "include");
  assert.equal(nieuw.decision(groningen), "far");
  // The old rules let it through: this is what the change is about.
  assert.equal(plan(v2, [huisje, groningen]).decision(groningen), "include");
});

test("een rijplatenorder vlak bij een hooihuisje rijdt mee", () => {
  const huisje = order("Hensbroek", 52.66, 4.87, { shop: DSP, products: hooihuisje });
  const purmerend = order("Purmerend", 52.50, 4.95);
  const uitkomst = plan(v3, [huisje, purmerend]);
  assert.equal(uitkomst.decision(purmerend), "include");
  assert.match(uitkomst.reason(purmerend), /rijdt mee met de altijd-eigen order/);
  assert.equal(uitkomst.routes.length, 1);
});

test("twee rijplaten dezelfde kant op: samen 259 min tegen 240, dus Controleren, en als rit voorgesteld", () => {
  const dichtbij = order("Dichtbij", 52.073 - 0.36, 5.639);
  const ver = order("Ver", 52.073 - 1.08, 5.639);
  const uitkomst = plan(v3, [dichtbij, ver]);
  assert.equal(uitkomst.decision(dichtbij), "review");
  assert.equal(uitkomst.decision(ver), "review");
  assert.equal(uitkomst.routes.length, 0);
  assert.equal(uitkomst.reviewRoutes.length, 1, "net erover wordt als rit getoond");
  assert.equal(uitkomst.reviewRoutes[0].orders.length, 2);
});

test("een adres in Tsjechië staat niet op het depot maar op Controleren", () => {
  const tsjechie = order("Velké Březno", null, null, { country: "CZ", postcode: "403 23" });
  const uitkomst = plan(v3, [tsjechie]);
  assert.equal(uitkomst.decision(tsjechie), "review");
  assert.match(uitkomst.reason(tsjechie), /buiten Nederland/);
  assert.equal(plan(v2, [tsjechie]).decision(tsjechie), "include", "zo ging het mis");
});

test("buren aan weerszijden van een windrichting tellen samen (Dalfsen en Ommen)", () => {
  const dalfsen = order("Dalfsen", 52.51, 6.26);
  const ommen = order("Ommen", 52.52, 6.42);
  const nieuw = plan(v3, [dalfsen, ommen]);
  assert.equal(nieuw.decision(dalfsen), "include");
  assert.equal(nieuw.decision(ommen), "include");
  assert.equal(nieuw.routes.length, 1);
  const oud = plan(v2, [dalfsen, ommen]);
  assert.equal(oud.decision(dalfsen), "far");
  assert.equal(oud.decision(ommen), "far");
});

test("twee ritten vlak naast elkaar over een windrichting worden één rit (Elst en Huissen)", () => {
  const elst = order("Elst", 51.92, 5.85);
  const huissen = order("Huissen", 51.93, 5.94);
  assert.equal(plan(v2, [elst, huissen]).routes.length, 2);
  const nieuw = plan(v3, [elst, huissen]);
  assert.equal(nieuw.routes.length, 1);
  assert.equal(nieuw.routes[0].orders.length, 2);
});

test("ritten die alleen het depot delen blijven apart", () => {
  const oost = order("Apeldoorn", 52.21, 5.97);
  const zuid = order("Oss", 51.76, 5.52);
  const uitkomst = plan(v3, [oost, zuid]);
  assert.equal(uitkomst.decision(oost), "include");
  assert.equal(uitkomst.decision(zuid), "include");
  assert.equal(uitkomst.routes.length, 2);
});

test("een ingeplande order komt niet nog eens in een voorstel en leent geen budget", () => {
  const a = order("Doorn", 52.03, 5.32);
  const b = order("Woerden", 52.09, 4.88);
  const vandaag = new Date();
  const datum = `${vandaag.getFullYear()}-${String(vandaag.getMonth() + 1).padStart(2, "0")}-${String(vandaag.getDate()).padStart(2, "0")}`;
  const uitkomst = plan(v3, [a, b], { planned: [{ id: "r1", number: 7, date: datum, name: "Doorn", orderKeys: [`${DRS}:${a.id}`] }] });
  assert.equal(uitkomst.decision(a), "planned");
  assert.ok(uitkomst.routes.every((route) => route.orders.every((item) => item.id !== a.id)));
  // Woerden alone is 2:02 against 2:00; with Doorn's budget it used to pass as
  // part of a new route next to the planned one. Now it comes along with the
  // planned route itself, offered when that route is opened.
  assert.equal(uitkomst.decision(b), "review");
  const erbij = v3.fn.nearbyAdditions([a]);
  assert.ok(erbij.some((kandidaat) => kandidaat.item.order.id === b.id));
});

test("een pakket naast een rit gaat mee, maar nooit voorbij 5:45", () => {
  const plaat = order("Veenendaal", 52.03, 5.56);
  const pakket = order("Rhenen", 51.96, 5.57, { shop: DSP, products: ["1x Pure Psyllium - Vlozaad"] });
  const uitkomst = plan(v3, [plaat, pakket]);
  assert.equal(uitkomst.decision(pakket), "include");
  assert.equal(uitkomst.routes.length, 1);
  for (const route of plan(v3, [plaat, pakket]).routes) assert.ok(route.totalMinutes <= 345);
});

test("een getagd pakket in geen rit staat op Controleren, niet stil bij DHL", () => {
  const pakket = order("Enkhuizen", 52.70, 5.28, { shop: DSP, products: ["1x Pure Psyllium - Vlozaad"], ownDeliveryTagged: true });
  const uitkomst = plan(v3, [pakket]);
  assert.equal(uitkomst.decision(pakket), "review");
  assert.match(uitkomst.reason(pakket), /getagd als eigen bezorging/);
});

test("terugbetaald is niet meenemen", () => {
  const terug = order("Doorn", 52.03, 5.32, { refunded: true });
  assert.equal(plan(v3, [terug]).decision(terug), "exclude");
});

test("stopvolgorde is nooit langer dan dichtstbijzijnde-eerst", () => {
  const stops = [order("A", 51.80, 5.20), order("B", 51.70, 5.60), order("C", 51.95, 5.10), order("D", 51.60, 5.35), order("E", 51.85, 5.50)];
  plan(v3, stops);
  const beste = v3.fn.loopKm(v3.fn.optimizedStopOrder(stops));
  plan(v2, stops);
  const oud = v2.fn.loopKm(v2.fn.optimizedStopOrder(stops));
  assert.ok(beste <= oud + 1e-9, `${beste} > ${oud}`);
});

test("een onmogelijke leverdatum laat de planning niet vallen", () => {
  const raar = order("Doorn", 52.03, 5.32, { dueDate: "2026-13-01" });
  const uitkomst = plan(v3, [raar]);
  assert.equal(uitkomst.decision(raar), "include");
  assert.equal(v3.fn.formatDate("2026-13-01"), "Onbekend");
});

test("kleine dingen: negatieve minuten, telefoonnummers, wintertijd", () => {
  assert.equal(v3.fn.formatMinutes(-84), "0:00 uur");
  assert.equal(v3.fn.telHref("+31 (0)6 1234 5678"), "tel:+31612345678");
  assert.equal(v3.fn.telHref("06-12 34 56 78"), "tel:0612345678");
  assert.equal(v3.fn.routeLetter(0), "A");
});

let failed = 0;
for (const [status, name, error] of results) {
  console.log(`${status === "ok" ? "✓" : "✗"} ${name}`);
  if (error) {
    failed += 1;
    console.log(`   ${String(error.stack || error).split("\n").slice(0, 4).join("\n   ")}`);
  }
}
console.log(`${results.length - failed}/${results.length} planningsregels goed`);
if (failed) process.exit(1);
