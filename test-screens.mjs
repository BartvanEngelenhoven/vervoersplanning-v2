// The screens: what the driver's phone and the planner's screen offer, show and
// send to the Worker, on made-up orders. app.js runs in the same stand-in page
// as the planning tests; the clock, the time zone and the Worker's answers are
// faked here per test.
import assert from "node:assert/strict";
import { loadPlanning } from "./test-planning.mjs";

const DRS = "de-rijplaten-specialist.myshopify.com";
const RealDate = Date;
const realTz = process.env.TZ;

const planning = loadPlanning({ v3: false });
const { state, fn, element } = planning;
fn.localStorage.setItem("vervoersplanning.operatorKey.v1", "testcode");
const originalRefresh = fn.refreshData;
const originalQueryAll = fn.document.querySelectorAll;

let counter = 0;
function order(city, lat, lon, { point = true, slim = false, ...rest } = {}) {
  counter += 1;
  const full = {
    id: `#S${counter}`, shopifyOrderId: `gid://shopify/Order/${counter}`, shopDomain: DRS, webshop: "De Rijplaten Specialist",
    city, postcode: "1234", country: "NL", paid: true, cancelled: false, fulfilled: false, deliveryMethod: "delivery",
    addressComplete: true, deliveryAppointmentLocked: false, products: ["4x Kunststof rijplaat 240x120x2 cm"], dueDate: "2026-12-01",
    ...(point ? { point: { lat, lon } } : {}),
    ...rest,
  };
  // What the driver's phone gets of an order that is not one of its stops.
  if (!slim) Object.assign(full, { customer: `Klant ${counter}`, fullAddress: `Weg ${counter}, 1234 AB ${city}, Nederland` });
  return full;
}
const key = (item) => `${item.shopDomain}:${item.id}`;

// The clock at one moment, and the device in some time zone.
function clockAt(iso, tz) {
  const fixed = RealDate.parse(iso);
  fn.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed]));
    }
    static now() {
      return fixed;
    }
  };
  setTz(tz);
}
function setTz(tz) {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
}
function realClock() {
  fn.Date = RealDate;
  setTz(realTz);
}

// A Worker that answers from a table of paths; everything it was asked is kept.
function worker(answers = {}) {
  const calls = [];
  fn.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, body });
    const answer = answers[path];
    const [status, payload] = typeof answer === "function" ? await answer(body) : answer || defaults(path);
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  return calls;
}
function defaults(path) {
  if (path === "/orders") return [200, []];
  if (path === "/plan") return [200, { routes: [], dayNotes: [], announcements: [], concepts: [] }];
  if (path === "/history") return [200, { entries: [], delivered: {} }];
  if (path === "/geo") return [200, { results: {} }];
  return [404, { error: "Onbekend" }];
}

function scene({ role = null, orders = [], plan = [], doneToday = null, heldKeys = [], delivered = [] }) {
  state.role = role;
  state.geo = {};
  state.orders = orders;
  state.allOrders = orders;
  state.plan = plan;
  state.concepts = [];
  state.openConcept = null;
  state.openPlan = null;
  state.manualRoute = null;
  state.driverRouteId = null;
  state.doneToday = doneToday;
  state.heldKeys = new Set(heldKeys);
  state.deliveredKeys = new Map(delivered);
  state.lastFetchOk = true;
  fn.rebuildPlanning();
}

const results = [];
async function test(name, body) {
  try {
    await body();
    results.push(["ok", name]);
  } catch (error) {
    results.push(["FOUT", name, error]);
  } finally {
    realClock();
    fn.refreshData = originalRefresh;
    fn.document.querySelectorAll = originalQueryAll;
    fn.document.visibilityState = "hidden";
    fn.window.alert = () => {};
    fn.fetch = () => new Promise(() => {});
  }
}

// The day from the finding: Kampen, Zwolle and Meppel delivered, Hoogeveen still
// to go, and Assen asked for. Driven in full the day is 6:30; from Hoogeveen
// alone it looked like 5:03.
function kampenDay({ hoogeveenPoint = true, assenPoint = true, date = fn.daysFromToday(0) } = {}) {
  const kampen = order("Kampen", 52.555, 5.911);
  const zwolle = order("Zwolle", 52.516, 6.083);
  const meppel = order("Meppel", 52.696, 6.194);
  const hoogeveen = order("Hoogeveen", 52.723, 6.476, { point: hoogeveenPoint });
  const assen = order("Assen", 52.993, 6.562, { slim: true, point: assenPoint });
  const route = { id: "rit-kampen-1", number: 1, date, name: "Kampen, Zwolle en 2 meer", orderKeys: [kampen, zwolle, meppel, hoogeveen].map(key) };
  const doneToday = [kampen, zwolle, meppel].map((stop) => ({ key: key(stop), point: stop.point, products: stop.products }));
  return { kampen, zwolle, meppel, hoogeveen, assen, route, doneToday };
}
// Array.from: a list made inside app.js is an array of its page, and would not
// compare equal to one made here.
const offered = (list) => Array.from(list, (kandidaat) => kandidaat.item.order.city);

await test("vandaag bezorgde stops tellen mee in de 5:45 van de bezorger", () => {
  const dag = kampenDay();
  scene({ role: "driver", orders: [dag.hoogeveen, dag.assen], plan: [dag.route] });
  const open = fn.plannedRouteStatus(dag.route).open;
  // An older Worker sends no deliveries of today: weighed as before.
  const zonder = fn.nearbyAdditions(open, fn.routeDayStops(dag.route));
  assert.deepEqual(offered(zonder), ["Assen"]);
  assert.ok(zonder[0].totaal <= 345);

  scene({ role: "driver", orders: [dag.hoogeveen, dag.assen], plan: [dag.route], doneToday: dag.doneToday });
  const dagStops = fn.routeDayStops(dag.route);
  assert.equal(dagStops.length, 4, "drie bezorgd en één open");
  assert.deepEqual(offered(fn.nearbyAdditions(open, dagStops)), [], "de hele dag wordt langer dan 5:45");
  // The same on the planner's screen with the route opened.
  scene({ orders: [dag.hoogeveen, { ...dag.assen, fullAddress: "Weg 9, 9401 AB Assen, Nederland" }], plan: [dag.route], doneToday: dag.doneToday });
  assert.deepEqual(offered(fn.nearbyAdditions(fn.plannedRouteStatus(dag.route).open, fn.routeDayStops(dag.route))), []);
});

await test("de bezorger krijgt geen order aangeboden waarvan de Worker geen punt heeft", () => {
  const dag = kampenDay({ assenPoint: false });
  scene({ role: "driver", orders: [dag.hoogeveen, dag.assen], plan: [dag.route] });
  assert.deepEqual(offered(fn.nearbyAdditions(fn.plannedRouteStatus(dag.route).open)), []);
});

await test("de bezorger krijgt niets aangeboden als een stop van de rit geen punt heeft", () => {
  const dag = kampenDay({ hoogeveenPoint: false });
  scene({ role: "driver", orders: [dag.hoogeveen, dag.assen], plan: [dag.route] });
  assert.deepEqual(offered(fn.nearbyAdditions(fn.plannedRouteStatus(dag.route).open)), []);
  // A delivered stop the phone cannot place counts the same.
  const tweede = kampenDay();
  const zonderPunt = tweede.doneToday.map((entry, index) => (index === 0 ? { ...entry, point: null } : entry));
  scene({ role: "driver", orders: [tweede.hoogeveen, tweede.assen], plan: [tweede.route], doneToday: zonderPunt });
  assert.deepEqual(offered(fn.nearbyAdditions(fn.plannedRouteStatus(tweede.route).open, fn.routeDayStops(tweede.route))), []);
});

await test("een stop vandaag bezorgd in een rit van gisteren: de bezorger krijgt dan niets aangeboden", () => {
  const dag = kampenDay({ date: fn.daysFromToday(-1) });
  const nu = new RealDate().toISOString();
  scene({ role: "driver", orders: [dag.hoogeveen, dag.assen], plan: [dag.route], doneToday: [], delivered: [[key(dag.kampen), nu], [key(dag.zwolle), nu], [key(dag.meppel), nu]] });
  assert.deepEqual(offered(fn.nearbyAdditions(fn.plannedRouteStatus(dag.route).open, fn.routeDayStops(dag.route))), []);
});

await test("een order in een rit verder dan de week van de bezorger wordt niet aangeboden", () => {
  const dag = kampenDay();
  const dichtbij = order("Beilen", 52.86, 6.51, { slim: true });
  scene({ role: "driver", orders: [dag.hoogeveen, dichtbij], plan: [dag.route] });
  assert.deepEqual(offered(fn.nearbyAdditions(fn.plannedRouteStatus(dag.route).open)), ["Beilen"]);
  scene({ role: "driver", orders: [dag.hoogeveen, dichtbij], plan: [dag.route], heldKeys: [key(dichtbij)] });
  assert.deepEqual(offered(fn.nearbyAdditions(fn.plannedRouteStatus(dag.route).open)), []);
});

await test("het scherm van de bezorger toont Kan er nog bij alleen als het past", () => {
  const dag = kampenDay();
  scene({ role: "driver", orders: [dag.hoogeveen, dag.assen], plan: [dag.route] });
  const holder = element("#driverView");
  fn.renderDriverRoute(holder, dag.route);
  assert.match(holder.innerHTML, /Kan er nog bij/);
  scene({ role: "driver", orders: [dag.hoogeveen, dag.assen], plan: [dag.route], doneToday: dag.doneToday });
  fn.renderDriverRoute(holder, dag.route);
  assert.doesNotMatch(holder.innerHTML, /Kan er nog bij/);
});

await test("Bezorgd van de bezorger stuurt rit en datum mee, en sluit een open afbreekformulier", async () => {
  const dag = kampenDay();
  scene({ role: "driver", orders: [dag.hoogeveen], plan: [dag.route] });
  const calls = worker({ "/actions/mark-delivered": [200, { ok: true }] });
  const box = { dataset: { open: "1" } };
  fn.document.querySelectorAll = (selector) => (selector === ".inline-editor[data-open]" ? [box] : []);
  await fn.markDelivered(dag.hoogeveen, { disabled: false, textContent: "Bezorgd" }, dag.route);
  const melding = calls.find((call) => call.path === "/actions/mark-delivered");
  assert.equal(melding.body.routeId, dag.route.id);
  assert.equal(melding.body.routeDate, dag.route.date);
  assert.equal(box.dataset.open, undefined, "het formulier houdt het scherm niet meer vast");
});

await test("een datum is die van Ede, ook op een computer in New York of Sydney", () => {
  // 00:30 on the 29th in Ede, 18:30 on the 28th in New York.
  clockAt("2026-09-28T22:30:00Z", "America/New_York");
  assert.equal(new fn.Date().getDate(), 28, "de computer zelf denkt nog de 28e");
  assert.equal(fn.isoDay(new fn.Date()), "2026-09-29");
  assert.equal(fn.daysFromToday(0), "2026-09-29");
  assert.equal(fn.daysFromToday(-7), "2026-09-22");
  assert.equal(fn.daysUntil("2026-09-29"), 0);
  assert.match(fn.formatDateTime("2026-09-28T14:00:00Z"), /16:00/);
  clockAt("2026-09-28T13:30:00Z", "Australia/Sydney");
  assert.equal(fn.previousDay("2026-09-29"), "2026-09-28");
  assert.equal(fn.daysFromToday(1), "2026-09-29");
});

await test("na 16:10 in Ede ingepland is niet aangekondigd, ook op een laptop in Londen", () => {
  const stop = order("Doorn", 52.03, 5.32);
  const rit = { id: "rit-doorn-9", number: 9, date: "2026-09-29", name: "Doorn", orderKeys: [key(stop)], assignedAt: "2026-09-28T14:29:00Z" };
  clockAt("2026-09-28T14:30:00Z", "Europe/London");
  scene({ orders: [stop], plan: [rit] });
  state.announcements = [];
  assert.match(fn.announceLine(rit), /Na 16:10 ingepland, dus niet aangekondigd/);
  // Between 16:00 and 16:10 the second run still takes it.
  assert.doesNotMatch(fn.announceLine({ ...rit, assignedAt: "2026-09-28T14:05:00Z" }), /niet aangekondigd/);
  clockAt("2026-09-28T14:20:00Z", "Europe/London");
  assert.match(fn.announceLine({ ...rit, assignedAt: "2026-09-28T13:59:00Z" }), /Aankondiging van 16:00 loopt/);
  clockAt("2026-09-28T13:50:00Z", "Europe/London");
  assert.match(fn.announceLine(rit), /Aankondiging 28-09-2026 om 16:00/);
});

await test("de opmerking uit Shopify (Notities) staat bij de order, veilig ge-escaped, en ingekort waar het krap is", () => {
  assert.equal(fn.orderNote({}), "");
  const html = fn.orderNote({ customerNote: "Woensdag leveren. <img src=x onerror=alert(1)>" });
  assert.match(html, /^<span class="order-note">Opmerking: Woensdag leveren\. &lt;img/);
  assert.ok(!html.includes("<img"));
  const kort = fn.orderNote({ customerNote: "x".repeat(300) }, { short: true });
  assert.ok(kort.length < 200 && kort.includes("…"));
});

await test("het min-teken in een voorstel zet de order op DHL/FVR, bewaard, en hij komt in geen voorstel meer", async () => {
  realClock();
  const doorn = order("Doorn", 52.03, 5.32);
  const zeist = order("Zeist", 52.09, 5.23);
  const leersum = order("Leersum", 52.01, 5.43);
  scene({ orders: [doorn, zeist, leersum] });
  assert.equal(fn.allRoutes().length, 1);
  const calls = worker({ "/orders/shipping": (body) => [200, { ok: true, orderKey: body.orderKey, extern: body.extern }] });
  await fn.removeOrderFromRoute(key(zeist), 0);
  assert.deepEqual(calls.find((call) => call.path === "/orders/shipping").body, { orderKey: key(zeist), extern: true });
  assert.ok(!calls.some((call) => call.path === "/concepts/save"), "geen concept");
  const decision = (item) => state.decisions.find((entry) => entry.order === item);
  assert.equal(decision(zeist).decision, "dhl");
  assert.equal(fn.allRoutes().length, 1, "geen aparte rit");
  assert.ok(!fn.allRoutes()[0].orders.includes(zeist));
  assert.equal(state.openConcept, null);
  // Put back under Orders: in the proposal again.
  await fn.setExternal(zeist, false);
  assert.equal(decision(zeist).decision, "include");
  assert.ok(fn.allRoutes()[0].orders.includes(zeist));
});

await test("een pakket dat op DHL/FVR is gezet, rijdt niet stiekem weer mee", async () => {
  realClock();
  const doorn = order("Doorn", 52.03, 5.32);
  const pakket = order("Driebergen", 52.05, 5.28, { shopDomain: "slowfeeder-specialist.myshopify.com", webshop: "De Slowfeeder Specialist", products: ["1x Slowfeeder hooinet"], extern: true });
  scene({ orders: [doorn, pakket] });
  assert.ok(!fn.allRoutes().some((route) => route.orders.includes(pakket)));
  assert.equal(state.decisions.find((entry) => entry.order === pakket).decision, "dhl");
});

await test("na Bezorgd staat de stop meteen als bezorgd, ook als verversen daarna mislukt", () => {
  realClock();
  const a = order("Doorn", 52.03, 5.32);
  const b = order("Zeist", 52.09, 5.23);
  const rit = { id: "rit-bezorgd", number: 3, date: fn.daysFromToday(0), name: "Doorn en Zeist", orderKeys: [key(a), key(b)] };
  scene({ orders: [a, b], plan: [rit] });
  fn.bookedHere([a]);
  const status = fn.plannedRouteStatus(rit);
  assert.equal(status.stops.find((stop) => stop.key === key(a)).status, "bezorgd");
  assert.equal(status.open.length, 1);
});

await test("een stop die tussen 16:00 en 16:10 bij de rit kwam, gaat mee met de ronde van 16:10", () => {
  const eerste = order("Doorn", 52.03, 5.32, { announced: true });
  const later = order("Zeist", 52.09, 5.23);
  const rit = { id: "rit-doorn-8", number: 8, date: "2026-09-29", name: "Doorn en Zeist", orderKeys: [key(eerste), key(later)] };
  clockAt("2026-09-28T14:05:00Z", "Europe/Amsterdam");
  scene({ orders: [eerste, later], plan: [rit] });
  state.announcements = [{ date: rit.date, mode: "echt", ranAt: "2026-09-28T14:00:20Z", routes: [{ id: rit.id, results: [{ key: key(eerste), id: eerste.id, status: "aangekondigd" }] }] }];
  assert.match(fn.announceLine(rit), /gaat mee met de ronde van 16:10/);
  clockAt("2026-09-28T14:12:00Z", "Europe/Amsterdam");
  state.announcements[0].retriedAt = "2026-09-28T14:10:05Z";
  assert.match(fn.announceLine(rit), /bel de klant/);
});

await test("een stop die na de aankondiging bij de rit kwam, wordt genoemd: bel de klant", () => {
  // Evening, after both runs: whatever the time the test itself runs at.
  clockAt("2026-09-28T17:30:00Z", "Europe/Amsterdam");
  const eerste = order("Doorn", 52.03, 5.32, { announced: true });
  const later = order("Zeist", 52.09, 5.23);
  const rit = { id: "rit-doorn-7", number: 7, date: "2026-09-29", name: "Doorn en Zeist", orderKeys: [key(eerste), key(later)] };
  scene({ orders: [eerste, later], plan: [rit] });
  const verslag = (mode) => [{ date: rit.date, mode, ranAt: new RealDate().toISOString(), routes: [{ id: rit.id, results: [{ key: key(eerste), id: eerste.id, status: "aangekondigd" }] }] }];
  state.announcements = verslag("echt");
  const regel = fn.announceLine(rit);
  assert.match(regel, new RegExp(`${later.id} na de aankondiging toegevoegd, niet aangekondigd: bel de klant`));
  assert.doesNotMatch(regel, new RegExp(`${eerste.id} na`));
  state.announcements = verslag("proef");
  assert.match(fn.announceLine(rit), /na de proef toegevoegd/);
  // Everything in the report: nothing extra.
  state.announcements = verslag("echt");
  assert.doesNotMatch(fn.announceLine({ ...rit, orderKeys: [key(eerste)] }), /toegevoegd/);
  realClock();
});

function conceptScene() {
  const a = order("Doorn", 52.03, 5.32);
  const b = order("Zeist", 52.09, 5.23);
  const c = order("Leersum", 52.01, 5.43);
  const concept = { id: "concept-test-0001", name: "Doorn en Zeist", orderKeys: [key(a), key(b)], createdAt: "2026-09-27T10:00:00Z" };
  scene({ orders: [a, b, c] });
  state.concepts = [concept];
  state.openConcept = concept;
  fn.rebuildPlanning();
  return { a, b, c, concept };
}

// A Worker that keeps the concept and applies changes the way the contract
// says. `gate` holds the save back until the test lets it through.
function conceptWorker(concept, { gate = null } = {}) {
  let stored = { ...concept };
  return worker({
    "/concepts/save": async (body) => {
      if (gate) await gate;
      const kept = stored.orderKeys.filter((entry) => !(body.remove || []).includes(entry));
      stored = { ...stored, orderKeys: [...kept, ...(body.add || []).filter((entry) => !kept.includes(entry))] };
      return [200, { ok: true, concept: stored }];
    },
    "/plan": () => [200, { routes: [], dayNotes: [], announcements: [], concepts: [stored] }],
  });
}

await test("concept: alleen de wijziging gaat naar de Worker, niet de hele lijst", async () => {
  const { a, c, concept } = conceptScene();
  const calls = conceptWorker(concept);
  await fn.addOrderToRoute(c, 0);
  const erbij = calls.find((call) => call.path === "/concepts/save").body;
  assert.equal(erbij.id, concept.id);
  assert.equal(erbij.update, true);
  assert.deepEqual(erbij.add, [key(c)]);
  assert.equal("orderKeys" in erbij, false);
  await fn.removeOrderFromRoute(key(a), 0);
  const eruit = calls.filter((call) => call.path === "/concepts/save")[1].body;
  assert.deepEqual(eruit.remove, [key(a)]);
  assert.equal("orderKeys" in eruit, false);
});

await test("concept: tijdens het opslaan kan Inplannen, Sluiten, een ander concept of Maak rit niet", async () => {
  const { c, concept } = conceptScene();
  let doorlaten;
  conceptWorker(concept, { gate: new Promise((resolve) => { doorlaten = resolve; }) });
  const bezig = fn.addOrderToRoute(c, 0);
  assert.equal(state.conceptSaving, true);
  fn.putRouteInHand(fn.allRoutes()[0], concept.id);
  assert.equal(state.routeInHand, null, "Inplannen wacht op het opslaan");
  fn.closeConcept();
  assert.equal(state.openConcept?.id, concept.id, "Sluiten wacht op het opslaan");
  fn.openConcept({ ...concept, id: "concept-ander-0002" });
  assert.equal(state.openConcept?.id, concept.id);
  state.selected = new Set([key(c)]);
  const voor = state.manualRoute;
  fn.makeRouteFromSelection();
  assert.equal(state.manualRoute, voor, "Maak rit wacht op het opslaan");
  state.selected = new Set();
  doorlaten();
  await bezig;
  assert.equal(state.conceptSaving, false);
  assert.deepEqual(state.openConcept?.orderKeys, [...concept.orderKeys, key(c)]);
  fn.closeConcept();
  assert.equal(state.openConcept, null, "daarna gaat Sluiten gewoon");
});

await test("concept: een concept dat tijdens het opslaan dichtging, gaat niet weer open", async () => {
  const { c, concept } = conceptScene();
  let doorlaten;
  conceptWorker(concept, { gate: new Promise((resolve) => { doorlaten = resolve; }) });
  const bezig = fn.addOrderToRoute(c, 0);
  state.openConcept = null;
  state.manualRoute = null;
  doorlaten();
  await bezig;
  assert.equal(state.openConcept, null);
});

await test("concept: na een 409 wordt de planning opnieuw geladen", async () => {
  const { c } = conceptScene();
  const meldingen = [];
  fn.window.alert = (tekst) => meldingen.push(tekst);
  const calls = worker({ "/concepts/save": [409, { error: "#S9 staat al in rit 3 op 2026-09-30." }] });
  await fn.addOrderToRoute(c, 0);
  assert.deepEqual(meldingen, ["#S9 staat al in rit 3 op 2026-09-30."]);
  assert.ok(calls.some((call) => call.path === "/plan"), "het scherm haalt de stand opnieuw op");
});

await test("Bezorgd toont ook eigen bezorgingen die buiten de nieuwste 50 vallen", async () => {
  scene({ role: "planner" });
  const bij = (index, extra = {}) => ({ id: `#S${900 + index}`, shopDomain: DRS, source: "shopify", deliveredAt: new RealDate(RealDate.UTC(2026, 8, 27, 12, 0) - index * 60_000).toISOString(), ...extra });
  const entries = Array.from({ length: 50 }, (_, index) => bij(index));
  const ouder = bij(500, { source: "bezorger", fulfillment: { id: "gid://shopify/Fulfillment/1" } });
  worker({ "/history": [200, { entries, delivered: {}, own: [ouder, entries[3]] }] });
  await fn.refreshData();
  assert.equal(state.history.length, 51, "dubbele regel één keer");
  assert.equal(state.history.at(-1).id, ouder.id, "nieuwste bovenaan");
  assert.equal(element("#historyCount").textContent, "nieuwste 50 + 1 eigen");
  assert.match(element("#history").innerHTML, /Terugdraaien/);
  // An older Worker without "own": as before.
  worker({ "/history": [200, { entries: entries.slice(0, 3), delivered: {} }] });
  await fn.refreshData();
  assert.equal(element("#historyCount").textContent, "3 bezorgd");
});

await test("als het dagtegoed van Cloudflare op is, staat dat er, ook op de telefoon", async () => {
  scene({ role: "planner" });
  const tekst = "Het gratis dagtegoed van Cloudflare is op. Vanaf 02:00 werkt alles weer; bel tot die tijd de planner.";
  worker({ "/orders": [503, { error: tekst }] });
  await fn.refreshData();
  assert.match(element("#syncText").textContent, /dagtegoed van Cloudflare is op/);
  assert.match(element("#syncMobile").textContent, /dagtegoed van Cloudflare is op/);
  // The driver's banner says the same, not "Geen verbinding".
  scene({ role: "driver" });
  await fn.refreshData();
  assert.match(element("#driverView").innerHTML, /dagtegoed van Cloudflare is op\. .*bel tot die tijd de planner\. Je ziet de ritten/);
  assert.doesNotMatch(element("#driverView").innerHTML, /Geen verbinding/);
});

await test("een scherm waar een kwartier niemand aan zit, ververst alleen elke tien minuten", () => {
  const gevraagd = [];
  fn.refreshData = (full) => gevraagd.push(full);
  fn.document.visibilityState = "visible";
  state.planLoaded = true;
  scene({ role: "planner" });
  clockAt(new RealDate(RealDate.now() + 20 * 60_000).toISOString(), realTz);
  for (let tik = 0; tik < 5; tik += 1) fn.timerRefresh();
  assert.deepEqual(gevraagd, [true], "alleen de volledige verversing");
  gevraagd.length = 0;
  clockAt(new RealDate(RealDate.now() + 60_000).toISOString(), realTz);
  for (let tik = 0; tik < 5; tik += 1) fn.timerRefresh();
  assert.equal(gevraagd.length, 5, "in gebruik: elke twee minuten");
  gevraagd.length = 0;
  // The driver with a route open leaves the phone alone between stops.
  clockAt(new RealDate(RealDate.now() + 20 * 60_000).toISOString(), realTz);
  state.role = "driver";
  state.driverRouteId = "rit-kampen-1";
  for (let tik = 0; tik < 5; tik += 1) fn.timerRefresh();
  assert.equal(gevraagd.length, 5);
});

// ---------------------------------------------------------------------------
// Drivers: a name on the phone, a driver picked when planning, and the list.
// ---------------------------------------------------------------------------
function driversOnRecord() {
  return [{ id: "d-sanne", name: "Sanne", codeSetAt: "2026-09-29T10:00:00Z" }, { id: "d-joost", name: "Joost", codeSetAt: "2026-09-29T10:00:00Z" }];
}

await test("de telefoon zegt Welkom met de naam; wie nog de oude code heeft, hoort hoe het verder moet", async () => {
  scene({ role: "driver" });
  state.planLoaded = true;
  state.driver = { id: "d-sanne", name: "Sanne" };
  fn.renderDriver();
  assert.match(element("#driverView").innerHTML, /<h1 class="driver-welcome">Welkom Sanne<\/h1>/);
  assert.doesNotMatch(element("#driverView").innerHTML, /oude code/);
  state.driver = null;
  state.ownCodes = false;
  fn.renderDriver();
  assert.match(element("#driverView").innerHTML, /<h1 class="driver-welcome">Welkom<\/h1>/);
  assert.doesNotMatch(element("#driverView").innerHTML, /oude code/, "zolang er geen eigen codes zijn, niets te vragen");
  state.ownCodes = true;
  fn.renderDriver();
  assert.match(element("#driverView").innerHTML, /oude code voor alle bezorgers/);
  state.driver = { id: "d-x", name: "<b>Joost</b>" };
  fn.renderDriver();
  assert.match(element("#driverView").innerHTML, /Welkom &lt;b&gt;Joost/, "een naam is tekst, geen opmaak");

  // The name comes with the routes, and is kept for when the phone opens offline.
  worker({ "/plan": [200, { routes: [], dayNotes: [], announcements: [], heldKeys: [], driver: { id: "d-daan", name: "Daan" } }] });
  await fn.refreshData();
  assert.equal(state.driver.name, "Daan");
  assert.deepEqual(fn.storedDriver(), { id: "d-daan", name: "Daan", lang: "nl" });
  worker({ "/plan": [200, { routes: [], dayNotes: [], announcements: [], heldKeys: [], driver: null }] });
  await fn.refreshData();
  assert.equal(fn.storedDriver(), null, "de oude code heeft geen naam");
  state.driver = undefined;
});

await test("inplannen: met bezorgers eerst kiezen wie de rit rijdt, en die gaat mee naar de Worker", async () => {
  const stop = order("Doorn", 52.03, 5.32);
  scene({ role: "planner", orders: [stop] });
  state.drivers = driversOnRecord();
  const calls = worker({ "/plan/assign": [200, { route: { id: "r", number: 1, date: fn.daysFromToday(1) } }] });
  const assigns = () => calls.filter((call) => call.path === "/plan/assign");
  const meldingen = [];
  fn.window.alert = (tekst) => meldingen.push(tekst);

  fn.putRouteInHand({ orders: [stop], region: "Doorn" });
  assert.match(element("#routeInHand").innerHTML, /Kies wie hem rijdt en een dag/);
  assert.match(element("#routeInHand").innerHTML, /data-driver="d-sanne" aria-pressed="false">Sanne</);
  assert.match(element("#routeInHand").innerHTML, />Later kiezen</);
  assert.doesNotMatch(element("#agendaDays").innerHTML, /place-here/, "de dagen gaan pas open als er iemand gekozen is");
  await fn.placeRouteOnDay(fn.daysFromToday(1));
  assert.equal(assigns().length, 0, "zonder keuze gaat er niets naar de Worker");
  assert.match(meldingen[0], /Kies eerst wie de rit rijdt/);

  state.routeInHandDriver = "d-joost";
  fn.renderAgenda();
  assert.match(element("#agendaDays").innerHTML, />Inplannen voor Joost</);
  await fn.placeRouteOnDay(fn.daysFromToday(1));
  assert.equal(assigns()[0].body.driverId, "d-joost");

  fn.putRouteInHand({ orders: [stop], region: "Doorn" });
  assert.equal(state.routeInHandDriver, undefined, "de keuze van de vorige rit gaat niet mee");
  state.routeInHandDriver = "";
  await fn.placeRouteOnDay(fn.daysFromToday(2));
  assert.equal(assigns()[1].body.driverId, "", "later kiezen: nog niemand");

  // A driver removed on another screen meanwhile is no choice any more.
  fn.putRouteInHand({ orders: [stop], region: "Doorn" });
  state.routeInHandDriver = "d-weg";
  await fn.placeRouteOnDay(fn.daysFromToday(2));
  assert.equal(assigns().length, 2);

  // Without drivers on record there is nobody to choose, as before.
  state.drivers = [];
  fn.putRouteInHand({ orders: [stop], region: "Doorn" });
  assert.doesNotMatch(element("#routeInHand").innerHTML, /driver-chip/);
  assert.match(element("#agendaDays").innerHTML, />Rit hier inplannen</);
  await fn.placeRouteOnDay(fn.daysFromToday(3));
  assert.equal(assigns().length, 3);
});

await test("agenda: per rit wie hem rijdt, meteen te veranderen; zonder bezorger een waarschuwing", async () => {
  const a = order("Doorn", 52.03, 5.32);
  const b = order("Zeist", 52.09, 5.23);
  const morgen = fn.daysFromToday(1);
  const vanSanne = { id: "rit-a", number: 11, date: morgen, name: "Doorn", orderKeys: [key(a)], driverId: "d-sanne" };
  const zonder = { id: "rit-b", number: 12, date: morgen, name: "Zeist", orderKeys: [key(b)] };
  scene({ role: "planner", orders: [a, b], plan: [vanSanne, zonder] });
  state.drivers = driversOnRecord();
  fn.renderAgenda();
  const html = element("#agendaDays").innerHTML;
  assert.match(html, /<option value="d-sanne" selected>Sanne<\/option>/);
  assert.equal((html.match(/Nog geen bezorger: kies wie deze rit rijdt/g) || []).length, 1);
  const calls = worker({ "/plan/driver": [200, { route: { ...zonder, driverId: "d-joost" } }] });
  await fn.setRouteDriver(zonder, { value: "d-joost", disabled: false });
  assert.deepEqual(calls.find((call) => call.path === "/plan/driver").body, { id: "rit-b", date: morgen, driverId: "d-joost" });

  state.plan = [vanSanne];
  state.drivers = [];
  fn.renderAgenda();
  assert.doesNotMatch(element("#agendaDays").innerHTML, /route-driver|Nog geen bezorger/, "zonder bezorgers ziet de agenda eruit als voorheen");
});

await test("Bezorgers: elke bezorger met ritten, een nieuwe code één keer te zien, en wie bezorgde", async () => {
  const a = order("Doorn", 52.03, 5.32);
  scene({ role: "planner", orders: [a], plan: [{ id: "rit-a", number: 11, date: fn.daysFromToday(1), name: "Doorn", orderKeys: [key(a)], driverId: "d-sanne" }] });
  state.drivers = [...driversOnRecord(), { id: "d-x", name: "<i>Kees</i>", codeSetAt: null }];
  fn.renderDriversPage();
  const html = element("#driverList").innerHTML;
  assert.match(html, /Sanne<\/h2>\s*<p>1 rit in de agenda · code gemaakt/);
  assert.match(html, /Joost<\/h2>\s*<p>Geen ritten in de agenda/);
  assert.match(html, /&lt;i&gt;Kees/);

  const calls = worker({ "/drivers/add": [200, { driver: { id: "d-daan", name: "Daan" }, code: "abcd-efgh-jkmn", drivers: [...driversOnRecord(), { id: "d-daan", name: "Daan", codeSetAt: "2026-09-29T11:00:00Z" }] }] });
  const input = { value: " Daan ", focus() {} };
  const button = { disabled: false };
  await fn.addDriverFromForm({ querySelector: (selector) => (selector === "#driverAddName" ? input : button) });
  assert.deepEqual(calls.find((call) => call.path === "/drivers/add").body, { name: "Daan" });
  assert.equal(input.value, "", "het veld is weer leeg");
  assert.equal(button.disabled, false);
  assert.match(element("#driverCode").innerHTML, /De code voor <b>Daan<\/b>/);
  assert.match(element("#driverCode").innerHTML, /abcd-efgh-jkmn/);
  assert.equal(element("#driverCode").hidden, false);
  assert.deepEqual(state.drivers.map((driver) => driver.name), ["Sanne", "Joost", "Daan"]);
  fn.showView("agenda");
  fn.showView("bezorgers");
  assert.equal(element("#driverCode").hidden, true, "weg van de pagina, dan is de code weg");
  assert.doesNotMatch(element("#driverCode").innerHTML, /abcd/);

  assert.equal(fn.historySourceLabel({ source: "bezorger", by: "Sanne" }), "Bezorgd gemeld door Sanne");
  assert.equal(fn.historySourceLabel({ source: "bezorger" }), "Bezorgd gemeld door de bezorger");
  assert.equal(fn.historySourceLabel({ source: "bezorger", by: "<b>" }), "Bezorgd gemeld door &lt;b&gt;");
  state.drivers = [];
});

// ---------------------------------------------------------------------------
// The day from the note (the Worker reads it; here as it arrives).
// ---------------------------------------------------------------------------
function opDag(stad, lat, lon, dag, extra = {}) {
  return order(stad, lat, lon, { earliestDate: dag, dueDate: dag, noteDates: { earliest: dag, latest: dag, avoid: [] }, customerNote: `Bezorging ${dag}`, ...extra });
}
function vanafDag(stad, lat, lon, dag, extra = {}) {
  return order(stad, lat, lon, { earliestDate: dag, dueDate: dag, noteDates: { earliest: dag, latest: null, avoid: [] }, customerNote: `Vanaf ${dag}`, ...extra });
}
const besluit = (item) => state.decisions.find((entry) => entry.order.id === item.id);

await test("een order die volgens de opmerking pas vanaf een dag mag, wacht, en komt de werkdag ervoor in de voorstellen", () => {
  clockAt("2026-09-29T08:00:00Z", "Europe/Amsterdam"); // dinsdag 29 september
  const woensdag = vanafDag("Doorn", 52.03, 5.32, "2026-10-07");
  const maandag = vanafDag("Leersum", 52.01, 5.43, "2026-10-12");
  const nu = order("Zeist", 52.09, 5.23);
  scene({ role: "planner", orders: [woensdag, maandag, nu] });
  assert.equal(besluit(woensdag).decision, "wait");
  assert.match(besluit(woensdag).reason, /Volgens de opmerking vanaf wo 7 okt; komt di 6 okt in de voorstellen/);
  assert.equal(besluit(maandag).decision, "wait");
  assert.match(besluit(maandag).reason, /komt vr 9 okt in de voorstellen/, "voor een maandag de vrijdag ervoor");
  assert.notEqual(besluit(nu).decision, "wait");
  assert.ok(!state.routes.some((route) => route.orders.some((item) => item.id === woensdag.id)), "niet in een voorstel");
  assert.match(fn.dueLabel(woensdag), /vanaf wo 7 okt \(opmerking\)/);

  clockAt("2026-10-06T08:00:00Z", "Europe/Amsterdam"); // dinsdag 6 oktober
  scene({ role: "planner", orders: [woensdag, maandag, nu] });
  assert.notEqual(besluit(woensdag).decision, "wait", "de dag ervoor mag hij in een voorstel");
  assert.equal(besluit(maandag).decision, "wait");
  clockAt("2026-10-09T08:00:00Z", "Europe/Amsterdam"); // vrijdag 9 oktober
  scene({ role: "planner", orders: [maandag] });
  assert.notEqual(besluit(maandag).decision, "wait");
});

await test("inplannen op een dag die de opmerking niet toestaat, vraagt het eerst", async () => {
  clockAt("2026-10-06T08:00:00Z", "Europe/Amsterdam");
  const woensdag = opDag("Doorn", 52.03, 5.32, "2026-10-07");
  const nietWoensdag = order("Leersum", 52.01, 5.43, { avoidDates: ["2026-10-07"], noteDates: { earliest: null, latest: null, avoid: ["2026-10-07"] } });
  scene({ role: "planner", orders: [woensdag, nietWoensdag] });
  state.drivers = [];
  const calls = worker({ "/plan/assign": [200, { route: { id: "r", number: 1, date: "2026-10-06" } }] });
  const gevraagd = [];
  fn.window.confirm = (tekst) => { gevraagd.push(tekst); return false; };
  fn.putRouteInHand({ orders: [woensdag, nietWoensdag], region: "Doorn" });
  await fn.placeRouteOnDay("2026-10-06");
  assert.match(gevraagd[0], new RegExp(`${woensdag.id} mag volgens de opmerking pas vanaf wo 7 okt`));
  assert.ok(!calls.some((call) => call.path === "/plan/assign"), "nee is nee");
  gevraagd.length = 0;
  await fn.placeRouteOnDay("2026-10-07");
  assert.match(gevraagd[0], new RegExp(`${nietWoensdag.id} kan volgens de opmerking niet op wo 7 okt`));
  assert.doesNotMatch(gevraagd[0], /pas vanaf/, "op de dag zelf is de eerste order goed");
  fn.window.confirm = () => true;
});

await test("een dag in de opmerking die de planning niet zeker kan plaatsen: Controleren, en nooit onderweg aangeboden", () => {
  clockAt("2026-09-29T08:00:00Z", "Europe/Amsterdam");
  const vaag = order("Doorn", 52.03, 5.32, { dateUnclear: true, noteDates: { earliest: null, latest: null, avoid: [], unclear: "dinsdag" }, customerNote: "Graag op dinsdag" });
  const botsend = order("Leersum", 52.01, 5.43, { dateUnclear: true, noteDates: { earliest: "2026-10-08", latest: "2026-10-07", avoid: [], conflict: "De opmerking noemt dagen die niet samengaan" } });
  scene({ role: "planner", orders: [vaag, botsend] });
  assert.equal(besluit(vaag).decision, "review");
  assert.match(besluit(vaag).reason, /niet zeker kan plaatsen \("dinsdag"\)/);
  assert.match(besluit(botsend).reason, /dagen die niet samengaan: kijk zelf/);
  assert.equal(fn.windowText(botsend), "", "botsende dagen worden niet als dag getoond");
  assert.equal(fn.additionAllowed(besluit(vaag), "2026-09-29"), false);
});

await test("Kan er nog bij: een order met een dag uit de opmerking, alleen voor een rit op een dag die mag", () => {
  clockAt("2026-09-29T08:00:00Z", "Europe/Amsterdam");
  const vast = opDag("Doorn", 52.03, 5.32, "2026-10-07");
  const vanaf = vanafDag("Driebergen", 52.05, 5.28, "2026-10-07");
  scene({ role: "planner", orders: [vast, vanaf] });
  for (const item of [besluit(vast), besluit(vanaf)]) {
    assert.equal(fn.additionAllowed(item, "2026-10-07"), true, `${item.order.customerNote}: een rit op die dag`);
    assert.equal(fn.additionAllowed(item, "2026-10-06"), false, `${item.order.customerNote}: een dag te vroeg`);
    assert.equal(fn.additionAllowed(item, null), false, `${item.order.customerNote}: een voorstel zonder dag`);
  }
  // A route already planned on that day: the concept, and the waiting order, say which.
  const leersum = order("Leersum", 52.01, 5.43);
  const rit = { id: "rit-wo", number: 4, date: "2026-10-07", name: "Leersum", orderKeys: [key(leersum)] };
  scene({ role: "planner", orders: [vast, vanaf, leersum], plan: [rit] });
  assert.equal(besluit(vast).decision, "concept");
  assert.equal(besluit(vast).concept.fits[0].planned.number, 4);
  fn.renderAgenda();
  assert.match(element("#agendaDays").innerHTML, new RegExp(`${vast.id} past bij rit 4 \\(\\+`));
  assert.equal(besluit(vanaf).decision, "wait");
  assert.match(besluit(vanaf).reason, /Past bij rit 4 op 07-10-2026/);
});

await test("een vaste dag in de opmerking staat meteen als concept op die dag in de agenda, per richting", () => {
  clockAt("2026-09-29T08:00:00Z", "Europe/Amsterdam");
  const doorn = opDag("Doorn", 52.03, 5.32, "2026-10-07");
  const leersum = opDag("Leersum", 52.01, 5.43, "2026-10-07");
  const zwolle = opDag("Zwolle", 52.51, 6.08, "2026-10-07", { paid: false });
  const periode = vanafDag("Zeist", 52.09, 5.23, "2026-10-05");
  const gewoon = order("Utrecht", 52.09, 5.12);
  scene({ role: "planner", orders: [doorn, leersum, zwolle, periode, gewoon] });
  assert.equal(state.noteConcepts.length, 2, "twee richtingen, twee concepten");
  const west = state.noteConcepts.find((concept) => concept.orders.includes(doorn));
  assert.ok(west.orders.includes(leersum), "dezelfde dag en richting samen");
  assert.equal(west.date, "2026-10-07");
  for (const item of [doorn, leersum, zwolle]) {
    assert.equal(besluit(item).decision, "concept");
    assert.match(besluit(item).reason, /op wo 7 okt: staat als concept op die dag in de agenda/);
  }
  assert.equal(besluit(periode).decision, "wait", "een periode wacht, zoals voorheen");
  assert.ok(!state.routes.some((route) => route.orders.some((item) => [doorn, leersum, zwolle].includes(item))), "niet ook nog in een voorstel");

  fn.renderAgenda();
  const agenda = element("#agendaDays").innerHTML;
  const woensdag = agenda.slice(agenda.indexOf('data-day="2026-10-07"'));
  assert.match(woensdag, /<span class="concept-tag">Concept<\/span>/);
  assert.match(woensdag, /de dag uit de opmerking/);
  assert.match(woensdag, /Nog geen ritnummer; de bezorger ziet dit niet/);
  assert.match(woensdag, new RegExp(`Zwolle · ${zwolle.id} <em>nog niet betaald</em>`));

  fn.putRouteInHand(west.route, null, west.date);
  assert.equal(state.routeInHandDay, "2026-10-07");
  assert.match(element("#routeInHand").innerHTML, /volgens de opmerking op wo 7 okt/);
  assert.equal(state.routeInHand.orders.length, 2);

  // The Concepten page lists them too, and counts them.
  fn.renderConcepts();
  assert.match(element("#conceptList").innerHTML, /Uit de opmerkingen/);
  assert.equal(element("#conceptCount").textContent, 2);

  // The driver's phone makes none: it gets no notes, and weighs by the days.
  scene({ role: "driver", orders: [doorn] });
  assert.equal(state.noteConcepts.length, 0);
});

await test("een concept uit de opmerking op een voorbije dag blijft in de agenda, en bewaarde concepten staan bovenaan", () => {
  clockAt("2026-10-08T08:00:00Z", "Europe/Amsterdam"); // donderdag 8 oktober
  const gemist = opDag("Doorn", 52.03, 5.32, "2026-10-07");
  const bewaard = order("Utrecht", 52.09, 5.12);
  scene({ role: "planner", orders: [gemist, bewaard] });
  state.concepts = [{ id: "concept-1", name: "Utrecht", orderKeys: [key(bewaard)], createdAt: "2026-10-06T10:00:00Z" }];
  fn.rebuildPlanning();
  const agenda = element("#agendaDays").innerHTML;
  assert.match(agenda, /Woensdag 7 oktober · niet ingepland/);
  assert.ok(agenda.indexOf('data-day="2026-10-07"') < agenda.indexOf('data-day="2026-10-08"'), "bovenaan, voor vandaag");
  assert.equal(element("#agendaConcepts").hidden, false);
  assert.match(element("#agendaConcepts").innerHTML, /Concepten, nog zonder dag/);
  assert.match(element("#agendaConcepts").innerHTML, /<span class="concept-tag">Concept<\/span> Utrecht/);
  state.concepts = [];
});

await test("Rit afronden: onder een rit van vandaag, noemt wat nog open staat, en daarna staat de rit als afgerond", async () => {
  clockAt("2026-09-29T12:00:00Z", "Europe/Amsterdam");
  const klaar = order("Doorn", 52.03, 5.32);
  const open = order("Leersum", 52.01, 5.43);
  const vandaag = { id: "rit-af", number: 7, date: "2026-09-29", name: "Doorn en Leersum", orderKeys: [key(klaar), key(open)], driverId: "d-sanne" };
  const morgen = { id: "rit-morgen", number: 8, date: "2026-09-30", name: "Zeist", orderKeys: [key(order("Zeist", 52.09, 5.23))], driverId: "d-sanne" };
  scene({ role: "driver", orders: [open], plan: [vandaag, morgen], delivered: [[key(klaar), "2026-09-29T10:00:00Z"]] });
  state.planLoaded = true;
  state.driverRouteId = vandaag.id;
  fn.renderDriver();
  let html = element("#driverView").innerHTML;
  assert.match(html, /id="finishOpen" class="button primary" type="button">Rit afronden</);
  assert.match(html, new RegExp(`Nog niet als bezorgd gemeld: <b>${open.id} Leersum</b>`));
  assert.ok(html.indexOf("finishBox") < html.indexOf("abortBox"), "afronden boven afbreken");
  state.driverRouteId = morgen.id;
  fn.renderDriver();
  assert.doesNotMatch(element("#driverView").innerHTML, /Rit afronden/, "een rit van morgen rond je nog niet af");

  const calls = worker({ "/plan/finish": [200, { route: { ...vandaag, finished: true, abortedAt: "2026-09-29T14:00:00Z", abortedBy: "Sanne", orderKeys: [key(klaar)], droppedKeys: [key(open)] } }] });
  const meldingen = [];
  fn.window.alert = (tekst) => meldingen.push(tekst);
  await fn.closeRoute(vandaag, "niet thuis", { disabled: false, textContent: "" }, { finish: true });
  assert.deepEqual(calls.find((call) => call.path === "/plan/finish").body, { id: "rit-af", date: "2026-09-29", reason: "niet thuis" });
  assert.match(meldingen[0], /Rit 7 is afgerond\. 1 bezorgd, 1 order gaat terug naar de planning\./);

  // Finished: the list says so, and so does the agenda.
  const afgerond = { ...vandaag, finished: true, abortedAt: "2026-09-29T14:00:00Z", abortedBy: "Sanne", abortReason: "niet thuis", orderKeys: [key(klaar)], droppedKeys: [key(open)] };
  scene({ role: "driver", orders: [], plan: [afgerond], delivered: [[key(klaar), "2026-09-29T10:00:00Z"]] });
  state.planLoaded = true;
  fn.renderDriver();
  html = element("#driverView").innerHTML;
  assert.match(html, /driver-route afgerond/);
  assert.match(html, /Afgerond · 1 bezorgd/);
  scene({ role: "planner", orders: [], plan: [afgerond], delivered: [[key(klaar), "2026-09-29T10:00:00Z"]] });
  state.routeInHand = null;
  fn.renderAgenda();
  assert.match(element("#agendaDays").innerHTML, /<p class="agenda-finished">Afgerond door Sanne om .*1 niet bezorgd, terug naar de planning: #S\d+ \(niet thuis\)\.<\/p>/);
});

await test("Afwijzen bij een concept uit de opmerking: de orders gaan met FVR of DHL en verdwijnen uit de agenda; een te lange dag staat erbij", async () => {
  clockAt("2026-09-29T08:00:00Z", "Europe/Amsterdam");
  const ver = opDag("Eemshaven", 53.44, 6.83, "2026-10-07");
  scene({ role: "planner", orders: [ver] });
  state.routeInHand = null;
  fn.renderAgenda();
  const html = element("#agendaDays").innerHTML;
  assert.match(html, /class="button subtle-action reject-note-concept"[^>]*>Afwijzen</);
  assert.match(html, /<p class="agenda-concept-warning">Te lang: \d+ min boven 5:30 uur/);
  const calls = worker({ "/orders/shipping": [200, { ok: true }] });
  const gevraagd = [];
  fn.window.confirm = (tekst) => { gevraagd.push(tekst); return true; };
  await fn.rejectNoteConcept(state.noteConcepts[0], { disabled: false });
  assert.match(gevraagd[0], new RegExp(`${ver.id} gaat dan met FVR in plaats van met de bus`));
  assert.deepEqual(calls.find((call) => call.path === "/orders/shipping").body, { orderKey: key(ver), extern: true });
  assert.equal(state.noteConcepts.length, 0, "uit de agenda");
  assert.equal(besluit(ver).decision, "dhl");
  fn.window.confirm = () => true;
});

await test("Afgehandeld bij een order in de lijst: gaat als afgehandeld naar de Worker en meteen uit de planning", async () => {
  const stop = order("Doorn", 52.03, 5.32);
  scene({ role: "planner", orders: [stop] });
  fn.renderOrders();
  assert.match(element("#ordersBody").innerHTML, /class="button subtle-action mark-handled"[^>]*>Afgehandeld</);
  const calls = worker({ "/actions/mark-delivered": [200, { ok: true }] });
  await fn.markHandled(stop, { disabled: false, textContent: "" });
  assert.equal(calls.find((call) => call.path === "/actions/mark-delivered").body.handled, true);
  assert.ok(!state.orders.some((item) => item.id === stop.id), "meteen uit de planning");
  assert.equal(fn.historySourceLabel({ source: "afgehandeld" }), "Afgehandeld, niet met de bus");
});

await test("de app van een Bulgaarse bezorger is in het Bulgaars; de planner en andere bezorgers houden Nederlands", async () => {
  clockAt("2026-09-29T08:00:00Z", "Europe/Amsterdam");
  const stop = order("Doorn", 52.03, 5.32, { phone: "06 1234 5678", customerNote: "Graag achterom" });
  const rit = { id: "rit-bg", number: 5, date: "2026-09-29", name: "Doorn", orderKeys: [key(stop)], driverId: "d-joost" };
  scene({ role: "driver", orders: [stop], plan: [rit] });
  state.planLoaded = true;
  state.driver = { id: "d-joost", name: "Joost", lang: "bg" };
  fn.renderDriver();
  let html = element("#driverView").innerHTML;
  assert.match(html, /<h1 class="driver-welcome">Здравей, Joost<\/h1>/);
  assert.match(html, /Това са твоите маршрути/);
  assert.match(html, /Днес · Вторник, 29 септември/);
  assert.match(html, /Маршрут 5/);
  assert.match(html, /остават 1/);
  assert.match(html, /Изход от този телефон/);

  state.driverRouteId = rit.id;
  fn.renderDriver();
  html = element("#driverView").innerHTML;
  for (const woord of ["‹ Всички маршрути", "Отвори маршрута в Google Maps", "Обади се на 06 1234 5678", "Бележка: Graag achterom", "мин разтоварване", ">Доставено<", "Приключи маршрута", "Прекрати маршрута", "Да, приключи маршрута", "Отказ"]) {
    assert.ok(html.includes(woord), `ontbreekt: ${woord}`);
  }
  assert.equal(fn.formatMinutes(90), "1:30 ч.");
  const gevraagd = [];
  fn.window.confirm = (tekst) => { gevraagd.push(tekst); return false; };
  await fn.markDelivered(stop, { disabled: false, textContent: "" }, rit);
  assert.equal(gevraagd[0], `Да отбележа ли ${stop.id} като доставена?`);
  fn.window.confirm = () => true;

  // The same phone for a Dutch driver, and the planner: Dutch.
  state.driver = { id: "d-sanne", name: "Sanne", lang: "nl" };
  state.driverRouteId = null;
  fn.renderDriver();
  assert.match(element("#driverView").innerHTML, /Welkom Sanne/);
  state.role = "planner";
  assert.equal(fn.formatMinutes(90), "1:30 uur");
  state.driver = undefined;
});

await test("Bezorgers: per bezorger een taal voor de telefoon", async () => {
  scene({ role: "planner" });
  state.drivers = [{ id: "d-sanne", name: "Sanne", lang: "nl" }, { id: "d-joost", name: "Joost", lang: "bg" }];
  fn.renderDriversPage();
  const html = element("#driverList").innerHTML;
  assert.match(html, /<option value="bg" selected>Български \(Bulgaars\)<\/option>/);
  const calls = worker({ "/drivers/lang": [200, { drivers: [{ id: "d-sanne", name: "Sanne", lang: "bg" }, { id: "d-joost", name: "Joost", lang: "bg" }] }] });
  state.driverCode = { name: "Sanne", code: "abcd-efgh-jkmn" };
  await fn.driverAction("/drivers/lang", { id: "d-sanne", lang: "bg" });
  assert.deepEqual(calls.find((call) => call.path === "/drivers/lang").body, { id: "d-sanne", lang: "bg" });
  assert.equal(state.drivers[0].lang, "bg");
  assert.equal(state.driverCode?.code, "abcd-efgh-jkmn", "een code op het scherm blijft staan");
  state.drivers = [];
  state.driverCode = null;
});

let failed = 0;
for (const [status, name, error] of results) {
  console.log(`${status === "ok" ? "✓" : "✗"} ${name}`);
  if (error) {
    failed += 1;
    console.log(`   ${String(error.stack || error).split("\n").slice(0, 4).join("\n   ")}`);
  }
}
console.log(`${results.length - failed}/${results.length} schermen goed`);
process.exit(failed ? 1 : 0);
