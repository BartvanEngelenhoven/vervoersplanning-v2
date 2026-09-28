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

await test("een stop uit een voorstel halen bewaart het voorstel als concept, zonder die stop", async () => {
  realClock();
  const doorn = order("Doorn", 52.03, 5.32);
  const zeist = order("Zeist", 52.09, 5.23);
  const leersum = order("Leersum", 52.01, 5.43);
  scene({ orders: [doorn, zeist, leersum] });
  assert.equal(fn.allRoutes().length, 1);
  let stored = null;
  const calls = worker({
    "/concepts/save": async (body) => {
      stored = { id: body.id, name: body.name, orderKeys: body.orderKeys, createdAt: new RealDate().toISOString() };
      return [200, { ok: true, concept: stored }];
    },
    "/plan": () => [200, { routes: [], dayNotes: [], announcements: [], concepts: stored ? [stored] : [] }],
  });
  await fn.removeOrderFromRoute(key(zeist), 0);
  const save = calls.find((call) => call.path === "/concepts/save").body;
  assert.deepEqual([...save.orderKeys].sort(), [key(doorn), key(leersum)].sort());
  assert.equal(state.openConcept?.id, save.id, "het concept staat open");
  const decision = (item) => state.decisions.find((entry) => entry.order === item).decision;
  assert.equal(decision(zeist), "include", "Zeist is terug in de planning");
  assert.equal(decision(doorn), "concept");
  state.openConcept = null;
  state.manualRoute = null;
  state.concepts = [];
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
  const eerste = order("Doorn", 52.03, 5.32, { announced: true });
  const later = order("Zeist", 52.09, 5.23);
  const rit = { id: "rit-doorn-7", number: 7, date: fn.daysFromToday(1), name: "Doorn en Zeist", orderKeys: [key(eerste), key(later)] };
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
