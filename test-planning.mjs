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
  // The old rules let it through. Weighed per day-trip, they no longer do:
  // Hensbroek and Groningen are no single day, so Groningen pays its own way.
  assert.equal(plan(v2, [huisje, groningen]).decision(groningen), "far");
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
  // Abroad is never guessed onto a Dutch postcode, whichever rules are on.
  assert.equal(plan(v2, [tsjechie]).decision(tsjechie), "review");
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

// Days as the planning counts them: in Amsterdam, whatever the machine's clock.
function isoOffset(days) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("een order die alleen te ver is maar in een ingeplande rit past, staat onder Controleren met die rit", () => {
  const doorn = order("Doorn", 52.03, 5.32);
  const haarlem = order("Haarlem", 52.38, 4.64);
  const uitkomst = plan(v2, [doorn, haarlem], { planned: [{ id: "r3", number: 3, date: isoOffset(2), name: "Doorn", orderKeys: [`${DRS}:${doorn.id}`] }] });
  assert.equal(uitkomst.decision(haarlem), "review");
  assert.match(uitkomst.reason(haarlem), /Past bij rit 3/);
  assert.ok(v2.fn.nearbyAdditions([doorn]).some((kandidaat) => kandidaat.item.order.id === haarlem.id), "en wordt daar aangeboden, ook met de oude regels");
});

test("een getagde XXL bak buiten zijn budget valt niet stil terug op DHL", () => {
  const xxl = order("Groningen", 53.22, 6.57, { shop: DSP, products: ["1x Slowfeeder XXL Pony Edition"], ownDeliveryTagged: true });
  const uitkomst = plan(v3, [xxl]);
  assert.equal(uitkomst.decision(xxl), "review");
  assert.match(uitkomst.reason(xxl), /getagd als eigen bezorging/);
});

test("een onafgemaakte rit van gisteren houdt zijn orders vast", () => {
  const doorn = order("Doorn", 52.03, 5.32);
  const uitkomst = plan(v3, [doorn], { planned: [{ id: "r4", number: 4, date: isoOffset(-1), name: "Doorn", orderKeys: [`${DRS}:${doorn.id}`] }] });
  assert.equal(uitkomst.decision(doorn), "planned");
  assert.match(uitkomst.reason(doorn), /nog open in rit 4/);
  const afgebroken = plan(v3, [doorn], { planned: [{ id: "r5", number: 5, date: isoOffset(-1), name: "Doorn", abortedAt: "x", orderKeys: [] , droppedKeys: [`${DRS}:${doorn.id}`] }] });
  assert.equal(afgebroken.decision(doorn), "include", "na afbreken is hij weer vrij");
});

test("een order in een concept wordt niet voorgesteld en niet aangeboden", () => {
  const doorn = order("Doorn", 52.03, 5.32);
  const woerden = order("Woerden", 52.09, 4.88);
  v3.state.concepts = [{ id: "c1", name: "Woerden", orderKeys: [`${DRS}:${woerden.id}`], createdAt: "2026-09-25T10:00:00Z" }];
  const uitkomst = plan(v3, [doorn, woerden]);
  v3.state.concepts = [];
  assert.equal(uitkomst.decision(woerden), "concept");
  assert.ok(uitkomst.routes.every((route) => route.orders.every((item) => item.id !== woerden.id)));
  assert.ok(!v3.fn.nearbyAdditions([doorn]).some((kandidaat) => kandidaat.item.order.id === woerden.id));
});

test("de bezorger krijgt een concept-order niet aangeboden", () => {
  const doorn = order("Doorn", 52.03, 5.32);
  const woerden = order("Woerden", 52.09, 4.88);
  v3.state.heldKeys = new Set([`${DRS}:${woerden.id}`]);
  const uitkomst = plan(v3, [doorn, woerden]);
  v3.state.heldKeys = new Set();
  assert.equal(uitkomst.decision(woerden), "concept");
});

const dagGrens = 345;
const ruif = ["1x Vierkante slowfeeder ruif 120 x 120 cm"];

test("een richting met meer dan een dag werk wordt meer dan één rit", () => {
  const geijsteren = order("Geijsteren", 51.56, 6.03);
  const arcen = order("Arcen", 51.48, 6.18);
  const geleen = order("Geleen", 50.97, 5.83);
  const oostWest = order("Oost West en Middelbeers", 51.46, 5.26, { shop: DSP, products: ruif });
  for (const regels of [v2, v3]) {
    const uitkomst = plan(regels, [geijsteren, arcen, geleen, oostWest]);
    assert.ok(uitkomst.routes.length >= 2, `${uitkomst.routes.length} rit(ten)`);
    for (const route of uitkomst.routes) {
      if (route.orders.length > 1) assert.ok(route.totalMinutes <= dagGrens, `${route.orders.map((item) => item.city).join(" > ")}: ${route.totalMinutes} min`);
    }
  }
});

test("orders in alle richtingen geven meer dan vier ritten, geen langer dan een dag", () => {
  const huisjes = [
    ["Groningen", 53.22, 6.57], ["Leeuwarden", 53.20, 5.80], ["Den Helder", 52.96, 4.76], ["Enschede", 52.22, 6.89],
    ["Winterswijk", 51.97, 6.72], ["Maastricht", 50.85, 5.69], ["Eindhoven", 51.44, 5.47], ["Middelburg", 51.50, 3.61], ["Den Haag", 52.07, 4.30],
  ].map(([plaats, lat, lon]) => order(plaats, lat, lon, { shop: DSP, products: ruif }));
  for (const regels of [v2, v3]) {
    const uitkomst = plan(regels, huisjes);
    assert.ok(uitkomst.routes.length > 4, `${uitkomst.routes.length} ritten`);
    for (const route of uitkomst.routes) {
      if (route.orders.length > 1) assert.ok(route.totalMinutes <= dagGrens, `${route.orders.map((item) => item.city).join(" > ")}: ${route.totalMinutes} min`);
    }
    assert.equal(uitkomst.routes.flatMap((route) => route.orders).length, huisjes.length, "elke order zit in precies één rit");
  }
});

test("Groningen, Drachten en Heerenveen: elke rit past binnen de budgetten van zijn eigen orders", () => {
  const groningen = order("Groningen", 53.22, 6.57);
  const drachten = order("Drachten", 53.11, 6.10);
  const heerenveen = order("Heerenveen", 52.96, 5.92);
  for (const regels of [v2, v3]) {
    const uitkomst = plan(regels, [groningen, drachten, heerenveen]);
    for (const route of uitkomst.routes) {
      const budget = route.orders.length * 120;
      assert.ok(route.driveMinutes <= budget * 1.2, `${route.orders.map((item) => item.city).join(" > ")}: ${route.driveMinutes} min rijden tegen ${budget}`);
    }
    // Whatever is proposed to drive is in a route; nothing include hangs loose.
    const inRoute = new Set(uitkomst.routes.flatMap((route) => route.orders.map((item) => item.id)));
    for (const item of [groningen, drachten, heerenveen]) {
      if (uitkomst.decision(item) === "include") assert.ok(inRoute.has(item.id), `${item.city} staat op Meenemen maar in geen rit`);
    }
  }
});

test("Zwitserland, Denemarken en Oostenrijk komen niet in Flevoland terecht", () => {
  const zurich = order("Zürich", null, null, { country: "CH", postcode: "8001" });
  const aarhus = order("Aarhus", null, null, { country: "DK", postcode: "8000" });
  const innsbruck = order("Innsbruck", null, null, { shop: DSP, products: hooihuisje, country: "AT", postcode: "6020" });
  const lelystad = order("Lelystad", 52.52, 5.47);
  for (const regels of [v2, v3]) {
    const uitkomst = plan(regels, [zurich, aarhus, innsbruck, lelystad]);
    for (const item of [zurich, aarhus, innsbruck]) assert.equal(uitkomst.decision(item), "review", `${item.city} (${regels === v2 ? "oude" : "nieuwe"} regels)`);
    assert.ok(uitkomst.routes.every((route) => route.orders.every((item) => item === lelystad)));
  }
});

test("een Nederlandse Belgiëlaan ligt niet in België", () => {
  const { fn } = v2;
  assert.equal(fn.countryName({ fullAddress: "Belgiëlaan 3, 3512 AB Utrecht" }), "");
  assert.equal(fn.countryName({ country: "NL", fullAddress: "Belgiëlaan 3, 3512 AB Utrecht, Netherlands" }), "NL");
  assert.equal(fn.countryName({ fullAddress: "Kerkstraat 1, 2000 Antwerpen, Belgium" }), "BE");
  assert.equal(fn.countryName({ fullAddress: "Bahnhofstrasse 1, 8001 Zürich, Switzerland" }), "SWITZERLAND");
});

test("een pakket dat al in een eigen rit zit, komt er niet nog een keer bij", () => {
  const doorn = order("Doorn", 52.03, 5.32);
  const zeist = order("Zeist", 52.09, 5.23);
  const driebergen = order("Driebergen", 52.05, 5.28, { shop: DSP, products: ["1x Slowfeeder hooinet"] });
  for (const regels of [v2, v3]) {
    const { state, fn } = regels;
    plan(regels, [doorn, zeist, driebergen]);
    state.manualRoute = { keys: [doorn, zeist, driebergen].map(fn.orderKey), keepOrder: false, removed: new Set() };
    fn.rebuildPlanning();
    const stops = state.routes[0].orders.map((item) => item.id);
    state.manualRoute = null;
    assert.equal(new Set(stops).size, stops.length, `dubbel: ${stops.join(", ")}`);
    assert.equal(stops.length, 3);
  }
});

test("Kan er makkelijk bij biedt een pakket alleen aan als de rit hooguit een uur langer wordt", () => {
  const veenendaal = order("Veenendaal", 52.03, 5.56);
  const utrecht = order("Utrecht", 52.09, 5.12, { shop: DSP, products: ["1x Slowfeeder hooinet"] });
  const renswoude = order("Renswoude", 52.07, 5.54, { shop: DSP, products: ["1x Slowfeeder hooinet"] });
  for (const regels of [v2, v3]) {
    const { state, fn } = regels;
    plan(regels, [veenendaal, utrecht, renswoude]);
    state.manualRoute = { keys: [fn.orderKey(veenendaal)], keepOrder: false, removed: new Set() };
    fn.rebuildPlanning();
    const aangeboden = fn.nearbySuggestions().map((entry) => entry.order.id);
    const opRit = state.routes[0].orders.map((item) => item.id);
    state.manualRoute = null;
    assert.ok(!aangeboden.includes(utrecht.id), "Utrecht kost meer dan een uur");
    assert.ok(!aangeboden.includes(renswoude.id) || !opRit.includes(renswoude.id), "wat al meerijdt, wordt niet nog eens aangeboden");
  }
});

test("een adres zonder plek wordt nooit bij een andere rit gevoegd", () => {
  const { fn } = v3;
  const kleve = order("Kleve", null, null, { country: "DE", postcode: "47533" });
  const veenendaal = order("Veenendaal", 52.03, 5.56);
  plan(v3, [kleve, veenendaal]);
  const ritten = fn.dayTrips([[kleve], [veenendaal]]);
  assert.equal(ritten.length, 2);
  assert.equal(fn.routeSummary("x", [kleve]).unknownPoint, true);
  assert.match(fn.routeWarning(fn.routeSummary("x", [kleve])), /Rijtijd onbekend/);
});

test("nieuwe regels: een buur over de windrichting die een ander eruit zou duwen, laat de planning niet vallen", () => {
  const dalfsen = order("Dalfsen", 52.524, 6.279);
  const hardenberg = order("Hardenberg", 52.569, 6.598);
  const hoogeveen = order("Hoogeveen", 52.72, 6.45, { shop: DSP, products: hooihuisje });
  const uitkomst = plan(v3, [dalfsen, hardenberg, hoogeveen]);
  assert.equal(uitkomst.decision(dalfsen), "include", "Dalfsen blijft staan");
  assert.equal(uitkomst.decision(hoogeveen), "include");
});

test("nieuwe regels: een rit net over budget staat heel onder Controleren, met de ruif waarmee hij gewogen is", () => {
  const zwolle = order("Zwolle", 52.51, 6.09, { shop: DSP, products: ruif });
  const drachten = order("Drachten", 53.11, 6.10);
  const uitkomst = plan(v3, [zwolle, drachten]);
  assert.equal(uitkomst.decision(drachten), "review");
  const controle = uitkomst.reviewRoutes.find((route) => route.orders.includes(drachten));
  assert.ok(controle, "Drachten staat in een rit onder Controleren");
  assert.ok(controle.orders.includes(zwolle), "met de ruif erbij");
  assert.ok(!uitkomst.routes.some((route) => route.orders.includes(zwolle)), "de ruif staat niet ook nog als los voorstel");
});

test("Kan er nog bij zet een nieuwe stop nooit tussen stops die vandaag al bezorgd zijn", () => {
  const { state, fn } = v2;
  const amsterdam = order("Amsterdam", 52.37, 4.90);
  const apeldoorn = order("Apeldoorn", 52.21, 5.97);
  const arnhem = order("Arnhem", 51.98, 5.91);
  const haarlem = order("Haarlem", 52.38, 4.64, { shop: DSP, products: ["1x Slowfeeder hooinet"] });
  const vandaag = isoOffset(0);
  const rit = { id: "r9", number: 9, date: vandaag, name: "Amsterdam", orderKeys: [amsterdam, apeldoorn, arnhem].map((item) => `${DRS}:${item.id}`) };
  state.doneToday = [
    { key: `${DRS}:${amsterdam.id}`, point: { lat: 52.37, lon: 4.90 }, products: amsterdam.products },
    { key: `${DRS}:${apeldoorn.id}`, point: { lat: 52.21, lon: 5.97 }, products: apeldoorn.products },
  ];
  plan(v2, [arnhem, haarlem], { planned: [rit] });
  state.deliveredKeys = new Map([[`${DRS}:${amsterdam.id}`, `${vandaag}T08:00:00Z`], [`${DRS}:${apeldoorn.id}`, `${vandaag}T09:30:00Z`]]);
  const dag = fn.routeDayStops(rit);
  const aangeboden = fn.nearbyAdditions(fn.plannedRouteStatus(rit).open, dag);
  state.doneToday = null;
  state.deliveredKeys = new Map();
  assert.deepEqual(Array.from(dag, (item) => item.id), [amsterdam.id, apeldoorn.id, arnhem.id], "bezorgd eerst, op volgorde");
  assert.ok(!aangeboden.some((kandidaat) => kandidaat.item.order.id === haarlem.id), "Haarlem ligt ver achter de bus");
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
