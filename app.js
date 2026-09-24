const CONFIG = {
  dataUrl: window.VERVOERSPLANNING_CONFIG?.dataUrl || "data/demo-orders.json",
  refreshMs: 60_000,
  depot: "Goorsteeg 46, Ede",
  vehicleCapacityKg: 3_500,
  apiBaseUrl: new URL(window.VERVOERSPLANNING_CONFIG?.dataUrl || "data/demo-orders.json", window.location.href).origin,
  // Drive times are straight-line estimates, so a trip that lands just over
  // budget is within the noise. Up to this much over, the planner decides.
  budgetTolerance: 0.2,
  // A DHL parcel rides along when a planned route grows no more than this,
  // unloading included. It never justifies a trip of its own.
  packageDetourMinutes: 60,
  maxRouteMinutes: 330,
  nearlyOverMinutes: 15,
  farRouteCombineMinutes: 75,
  exceptionRouteMinutes: 480,
};

const state = { orders: [], decisions: [], routes: [], history: [], selected: new Set(), manualRoute: null, suggestions: [], plan: [], allOrders: [], geo: {}, openPlan: null, routeInHand: null, lastFetchOk: false, driveMinutes: null, driveDepot: "" };
const decisionLabels = { include: "Meenemen", review: "Controleren", dhl: "DHL", far: "Te ver", exclude: "Niet meenemen" };

// Every order brings its own travel budget to the trip and the budgets pool, so
// two rijplaten may share a 240 minute drive although neither pays for 120 on
// its own. Minutes are round trips, because routeDriveMinutes drives out and
// back. Hay houses go whatever the distance, so they carry no ceiling.
const transportRules = {
  rijplaten: { label: "Rijplaten", budgetMinutes: 120, overflow: "far" },
  alwaysOwn: { label: "Altijd eigen bezorging", budgetMinutes: Infinity, overflow: "far" },
  xxl: { label: "XXL bak", budgetMinutes: 60, overflow: "dhl" },
};

// The Slowfeeder collection that always goes by own transport, whatever the
// distance, matched on the distinctive start of each title. Seven entries cover
// eight products: both round feeders begin the same way. Renaming one of these
// in Shopify quietly drops it to DHL, so this list and that collection have to
// be kept in step.
const alwaysOwnTransportProducts = [
  "vierkante slowfeeder ruif",
  "slowfeeder hooihuisje",
  "haybell hooistolp",
  "vierkante slowfeeder hooiruif",
  "ronde ruif met slowfeedernet",
  "compacte vierkante slowfeeder hooiruif",
  "patura klima",
];
const forcedIncludeKey = "vervoersplanning.forceInclude.v1";
const operatorKeyStorageKey = "vervoersplanning.operatorKey.v1";
// One-off clean-up of leftovers from before the planning went live: orders due
// before this date stay out of sight here. Shopify is untouched and the records
// are still in the store, so this is undone by removing the date. An order due
// on or after it is never hidden, however far past its deadline it runs.
const hideOrdersDueBefore = "2026-09-24";
const usesBackend = Boolean(window.VERVOERSPLANNING_CONFIG?.dataUrl);
let operatorPromptDeclined = false;
const businessClasses = {
  "De Rijplaten Specialist": "rijplaten",
  "De Slowfeeder Specialist": "slowfeeder",
};
const businessLogos = {
  "De Rijplaten Specialist": "assets/rijplaten-logo.svg",
  "De Slowfeeder Specialist": "assets/slowfeeder-logo.png",
};
const forcedIncludes = new Set(JSON.parse(localStorage.getItem(forcedIncludeKey) || "[]"));
// Goorsteeg 46 as PDOK places it. The old point sat 3.5 km off, south-east of Ede.
const DEPOT_POINT = { lat: 52.07309, lon: 5.63884 };
// Fitted on real depot-to-customer drive times for 25 Dutch addresses from the
// live orders (OpenStreetMap routing, 24 September 2026): one way is about ten
// minutes of getting on and off the main roads plus 0.975 minutes per km as the
// crow flies. Average error 3.7 minutes one way, against 6.8 for the flat 52 km/h
// it replaces. The fixed part is paid once out and once back, not at every stop.
const TRIP_OVERHEAD_MINUTES = 20.2;
const MINUTES_PER_KM = 0.975;
let planningView = "map";
let activeMapRouteIndex = 0;
let activeLooseOrderKey = "";
let allOrdersLeafletMap = null;

function productText(order) {
  return String((order.products || []).join(" ")).toLowerCase();
}

function isRijplatenOrder(order) {
  return `${order.shopDomain || ""} ${order.webshop || ""}`.toLowerCase().includes("rijplaten");
}

function isAlwaysOwnTransport(order) {
  const text = productText(order);
  return alwaysOwnTransportProducts.some((name) => text.includes(name));
}

// Only the hay house needs the long unloading slot; the feeders are a drop.
function isHooihuisje(order) {
  const text = productText(order);
  return text.includes("hooihuisje") || text.includes("hoihuisje");
}

// "Slowfeeder XXL Pony Edition", "Slowfeeder XXL (1 kuub) GRIJS". The double X
// keeps "Slowfeed Plus XL hooiruif" out, which ships through DHL.
function isXxlBak(order) {
  return productText(order).includes("xxl");
}

function transportPlan(order) {
  if (isRijplatenOrder(order)) return transportRules.rijplaten;
  if (isAlwaysOwnTransport(order)) return transportRules.alwaysOwn;
  if (isXxlBak(order)) return transportRules.xxl;
  return null;
}

function decide(order) {
  if (order.cancelled) return { decision: "exclude", reason: "Order is geannuleerd" };
  if (order.fulfilled) return { decision: "exclude", reason: "Order is al volledig bezorgd" };
  if (order.deliveryMethod === "pickup") return { decision: "exclude", reason: "Klant haalt de bestelling af" };

  const plan = transportPlan(order);
  if (!plan) return { decision: "dhl", reason: "Staat niet in de vaste eigen-bezorgingslijst en is geen XXL bak; gaat als pakket via DHL" };

  if (!order.addressComplete) return { decision: "review", reason: "Bezorgadres is onvolledig" };
  if (order.deliveryAppointmentLocked) return { decision: "review", reason: "Aflevermoment is afgestemd; niet verplaatsen zonder toestemming" };
  if (!order.paid) return { decision: "review", reason: "Betaling nog niet binnen; alleen optioneel meenemen als dit logisch op de route ligt" };

  // Settled in qualifyCandidates, which weighs the whole region's trip at once.
  return { decision: "candidate", plan, reason: `${plan.label}, wacht op ritberekening` };
}

function applyManualDecision(order, automatic) {
  if (!forcedIncludes.has(orderKey(order))) return automatic;
  if (order.cancelled || order.fulfilled || order.deliveryMethod === "pickup") return automatic;
  return { decision: "include", reason: `Handmatig meegenomen. Systeemadvies: ${automatic.reason}` };
}

function dueDateReason(order) {
  if (!order.dueDate) return "Geldige bezorgorder; uiterste leverdatum ontbreekt";
  const today = startOfDay(new Date());
  const due = dateFromIso(order.dueDate);
  const days = Math.ceil((due - today) / 86_400_000);
  if (days < 0) return `Te laat: uiterste leverdatum was ${formatDate(order.dueDate)}`;
  if (days <= 2) return `Urgent: uiterlijk ${formatDate(order.dueDate)}`;
  return `Bezorgorder, uiterlijk ${formatDate(order.dueDate)}`;
}

function regionFor(order) {
  const point = orderPoint(order);
  const bearing = bearingFromDepot(point);
  if (countryName(order) === "BE") return point.lon < 4.7 ? "België west" : "België oost";
  if (bearing >= 315 || bearing < 45) return "Noord";
  if (bearing >= 45 && bearing < 135) return "Oost";
  if (bearing >= 135 && bearing < 225) return "Zuid";
  return "West";
}

function buildRoutes(included) {
  if (state.manualRoute?.orders?.length) {
    return [routeSummary("Handmatige selectie", optimizedStopOrder(state.manualRoute.orders))];
  }
  const groups = new Map();
  for (const item of included) {
    const region = regionFor(item.order);
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push(item.order);
  }

  const routes = [];
  for (const [region, orders] of groups) {
    orders.sort((a, b) => routeSortScore(a) - routeSortScore(b));
    let current = [];
    for (const order of orders) {
      const candidate = optimizedStopOrder([...current, order]);
      const candidateSummary = routeSummary(region, candidate);
      const currentSummary = current.length ? routeSummary(region, current) : null;
      const addedMinutes = currentSummary ? candidateSummary.totalMinutes - currentSummary.totalMinutes : candidateSummary.totalMinutes;
      const loadTooHigh = candidateSummary.load > CONFIG.vehicleCapacityKg;
      const routeTooLong = candidateSummary.totalMinutes > CONFIG.maxRouteMinutes + CONFIG.nearlyOverMinutes;
      const usefulFarCombination = sameRouteCorridor(current, order)
        && candidateSummary.totalMinutes <= CONFIG.exceptionRouteMinutes
        && (currentSummary?.overByMinutes || addedMinutes <= CONFIG.farRouteCombineMinutes || countryName(order) === "BE");
      if (current.length && (loadTooHigh || (routeTooLong && !usefulFarCombination))) {
        routes.push(routeSummary(region, optimizedStopOrder(current)));
        current = [order];
      } else {
        current = candidate;
      }
    }
    if (current.length) routes.push(routeSummary(region, optimizedStopOrder(current)));
  }
  return routes;
}

function routeSummary(region, orders) {
  const deliveryMinutesTotal = orders.reduce((sum, order) => sum + deliveryMinutes(order), 0);
  const load = orders.reduce((sum, order) => sum + Number(order.weightKg || 0), 0);
  const driveEstimate = routeDriveMinutes(orders);
  const totalMinutes = driveEstimate + deliveryMinutesTotal;
  return {
    region,
    orders,
    load,
    deliveryMinutes: deliveryMinutesTotal,
    driveMinutes: driveEstimate,
    totalMinutes,
    overByMinutes: Math.max(0, totalMinutes - CONFIG.maxRouteMinutes),
  };
}

// The address as the backend keyed it, so both sides agree on what a stop is.
function orderAddress(order) {
  return String(order.fullAddress || `${order.postcode || ""} ${order.city || ""}`).replace(/\s+/g, " ").trim();
}

// Real minutes for the whole trip, depot out and back, leg by leg. Returns null
// the moment one leg is unknown, because half a route in real minutes and half
// in straight-line guesses would read as one number and be neither.
function measuredDriveMinutes(orders) {
  if (!state.driveMinutes || !state.driveDepot) return null;
  const legs = [state.driveDepot, ...orders.map(orderAddress), state.driveDepot];
  let total = 0;
  for (let index = 1; index < legs.length; index += 1) {
    const from = legs[index - 1];
    const to = legs[index];
    if (from === to) continue;
    const minutes = state.driveMinutes[from]?.[to];
    if (typeof minutes !== "number") return null;
    total += minutes;
  }
  return Math.max(20, Math.round(total));
}

function routeDriveMinutes(orders) {
  if (!orders.length) return 0;
  const measured = measuredDriveMinutes(orders);
  if (measured !== null) return measured;

  // Fallback while Google is unreachable or an address is new: straight-line
  // distance at a flat speed, which runs pessimistic on long motorway trips.
  const points = orders.map(orderPoint);
  const legs = [DEPOT_POINT, ...points, DEPOT_POINT];
  const km = legs.slice(1).reduce((sum, point, index) => sum + distanceKm(legs[index], point), 0);
  return Math.max(20, Math.round(TRIP_OVERHEAD_MINUTES + km * MINUTES_PER_KM));
}

function optimizedStopOrder(orders) {
  const remaining = [...orders];
  const ordered = [];
  let currentPoint = DEPOT_POINT;
  while (remaining.length) {
    remaining.sort((a, b) => distanceKm(currentPoint, orderPoint(a)) - distanceKm(currentPoint, orderPoint(b)));
    const next = remaining.shift();
    ordered.push(next);
    currentPoint = orderPoint(next);
  }
  return ordered;
}

function routeSortScore(order) {
  const point = orderPoint(order);
  return bearingFromDepot(point) * 10 + distanceKm(DEPOT_POINT, point) / 10;
}

function deliveryMinutes(order) {
  // Worked out here from the products, never taken from order.deliveryMinutes.
  // The backend stamps that field with its own copy of the rule, and when it
  // matched "houten hooihuisje", which no Shopify title says, its 20 minutes
  // quietly won over the 90 a hay house needs.
  if (isHooihuisje(order)) return 90;
  return 20;
}

function routeWarning(route) {
  if (route.load > CONFIG.vehicleCapacityKg) return `Let op laadcapaciteit: ${route.load.toLocaleString("nl-NL")} kg`;
  if (!route.overByMinutes) return "Binnen 5:30 uur op basis van ruwe schatting";
  if (route.overByMinutes <= CONFIG.nearlyOverMinutes) return `Bijna passend: ${route.overByMinutes} min boven 5:30 uur`;
  return `Te lang: ${route.overByMinutes} min boven 5:30 uur; apart plannen of uitzondering bespreken`;
}

function routeMinutesFromDepot(order) {
  return `heen/terug ca. ${formatMinutes(routeDriveMinutes([order]))}`;
}

function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}:${String(rest).padStart(2, "0")} uur`;
}

function formatDate(value) {
  if (!value) return "Niet ingevuld";
  return new Intl.DateTimeFormat("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function dateFromIso(value) {
  return startOfDay(new Date(`${value}T12:00:00`));
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Three counters the planner acts on, as buttons that filter the order list.
// Everything that needs no decision today is named once in a quiet line below,
// so it is accounted for without competing for attention.
function renderSummary() {
  const count = (key) => state.decisions.filter((item) => item.decision === key).length;
  const stops = state.routes.reduce((sum, route) => sum + route.orders.length, 0);
  const urgent = state.decisions.filter((item) => {
    if (item.decision !== "include" && item.decision !== "review") return false;
    if (!item.order.dueDate) return false;
    return Math.ceil((dateFromIso(item.order.dueDate) - startOfDay(new Date())) / 86_400_000) <= 0;
  }).length;

  const dagLine = document.querySelector("#dayLine");
  if (dagLine) {
    const dag = new Intl.DateTimeFormat("nl-NL", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
    const rit = state.routes.length === 1 ? "1 rit" : `${state.routes.length} ritten`;
    dagLine.textContent = state.routes.length
      ? `${dag} · ${rit} met ${stops} ${stops === 1 ? "stop" : "stops"}`
      : `${dag} · nog geen rit gepland`;
  }

  const vandaag = document.querySelector("#todayLabel");
  if (vandaag) vandaag.textContent = new Intl.DateTimeFormat("nl-NL", { day: "numeric", month: "long" }).format(new Date());

  const tellers = [
    { key: "include", label: "Meenemen", value: count("include"), sub: "gaan met de bus" },
    { key: "review", label: "Controleren", value: count("review"), sub: "wachten op jou" },
    { key: "urgent", label: "Vandaag of te laat", value: urgent, sub: "deadline verstreken of nu" },
  ];
  document.querySelector("#summary").innerHTML = tellers.map((t) => `
    <button class="metric ${t.key}${t.value ? "" : " leeg"}" type="button" data-filter="${t.key}">
      <strong>${t.value}</strong><span>${t.label}</span><small>${t.sub}</small>
    </button>`).join("");

  document.querySelectorAll("#summary .metric").forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.dataset.filter;
      const select = document.querySelector("#decisionFilter");
      if (select) select.value = filter === "urgent" ? "all" : filter;
      renderOrders();
      document.querySelector(".orders-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  const rest = document.querySelector("#summaryRest");
  if (rest) {
    const delen = [
      count("dhl") ? `${count("dhl")} via DHL` : "",
      count("far") ? `${count("far")} te ver` : "",
      count("exclude") ? `${count("exclude")} vervallen of opgehaald` : "",
      state.selected.size ? `${state.selected.size} geselecteerd` : "",
    ].filter(Boolean);
    rest.textContent = delen.length ? `Verder: ${delen.join(" · ")}.` : "";
  }
}

// The reference block is built from the rules themselves, so it cannot drift
// away from what the planning actually does the way a written list did.
function renderRules() {
  const holder = document.querySelector("#rulesBody");
  if (!holder) return;
  const budget = (rule) => rule.budgetMinutes === Infinity ? "hoe ver ook" : `tot ${formatMinutes(rule.budgetMinutes)} heen/terug`;
  const kaarten = [
    ["Rijplaten", `Altijd eigen bezorging ${budget(transportRules.rijplaten)}. Orders dezelfde kant op tellen hun tijd bij elkaar op, dus samen mogen ze verder.`],
    ["Grote slowfeeders", `${alwaysOwnTransportProducts.length} producttitels uit de vaste lijst gaan altijd zelf, ${budget(transportRules.alwaysOwn)}.`],
    ["XXL bakken", `Eigen bezorging ${budget(transportRules.xxl)}, ook weer met de tijd van andere orders erbij opgeteld.`],
    ["Al het andere", "Gaat als pakket via DHL, tenzij er een rit vlak langs rijdt: dan mag de rit er hooguit " + formatMinutes(CONFIG.packageDetourMinutes) + " langer van worden."],
    ["Net erover", `Zit een rit tot ${Math.round(CONFIG.budgetTolerance * 100)}% boven het budget, dan komt hij bij Controleren te staan in plaats van dat hij afvalt.`],
    ["Lengte van een dag", `Ritten starten en eindigen op ${CONFIG.depot}. Boven ${formatMinutes(CONFIG.maxRouteMinutes)} volgt een waarschuwing, en er liften geen pakketten meer bij.`],
  ];
  holder.innerHTML = kaarten.map(([titel, tekst]) => `<article><b>${titel}</b><p>${tekst}</p></article>`).join("");
}

// A route is named for where it goes, not for the compass sector it was grouped
// into: two routes out of one direction would otherwise carry the same name.
function routeLabel(route) {
  const steden = [...new Set(route.orders.map((order) => order.city).filter(Boolean))];
  if (!steden.length) return route.region;
  if (steden.length === 1) return steden[0];
  if (steden.length === 2) return `${steden[0]} en ${steden[1]}`;
  if (steden.length === 3) return `${steden[0]}, ${steden[1]} en ${steden[2]}`;
  return `${steden[0]}, ${steden[1]} en ${steden.length - 2} meer`;
}

// The planned route an order already sits in, from today on, if any.
function plannedFor(order) {
  const key = orderKey(order);
  const vandaag = isoDay(new Date());
  return state.plan.find((planned) => planned.date >= vandaag && planKeys(planned).includes(key)) || null;
}

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => { view.hidden = view.dataset.view !== name; });
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));

  // One map, moved rather than duplicated: beside the routes on Vandaag, on its
  // own full screen under Kaart, where it opens on every open order.
  const panel = document.querySelector(".map-panel");
  const target = document.querySelector(name === "kaart" ? "#mapAway" : "#mapHome");
  if (panel && target && panel.parentElement !== target) target.appendChild(panel);
  if (name === "kaart") planningView = "all-orders";
  if (name === "vandaag") planningView = "map";
  if (name === "vandaag" || name === "kaart") renderPlanningOverview();
  if (name !== "agenda" && state.routeInHand) {
    state.routeInHand = null;
    renderRouteInHand();
  }
  window.scrollTo({ top: 0 });
}

function putRouteInHand(route) {
  state.routeInHand = route;
  showView("agenda");
  renderRouteInHand();
  renderAgenda();
}

function renderRouteInHand() {
  const bar = document.querySelector("#routeInHand");
  if (!bar) return;
  const route = state.routeInHand;
  bar.hidden = !route;
  if (!route) {
    bar.innerHTML = "";
    return;
  }
  bar.innerHTML = `<p><strong>Kies een dag</strong> voor de rit naar ${routeLabel(route)} (${route.orders.length} stops).</p>
    <button id="dropRouteInHand" class="button subtle-action" type="button">Annuleren</button>`;
  bar.querySelector("#dropRouteInHand").addEventListener("click", () => {
    state.routeInHand = null;
    renderRouteInHand();
    renderAgenda();
  });
}

async function placeRouteOnDay(date) {
  const route = state.routeInHand;
  if (!route) return;
  const saved = await savePlan({ date, name: routeLabel(route), keys: route.orders.map(orderKey) });
  if (!saved) {
    window.alert("Inplannen is niet gelukt. Probeer het opnieuw.");
    return;
  }
  state.routeInHand = null;
  state.plan = await fetchPlan();
  renderRouteInHand();
  rebuildPlanning();
}

function renderAgenda() {
  const holder = document.querySelector("#agendaDays");
  const teller = document.querySelector("#agendaCount");
  if (!holder) return;

  const vandaag = isoDay(new Date());
  const komend = state.plan.filter((planned) => planned.date >= vandaag);
  if (teller) {
    teller.textContent = komend.length;
    teller.hidden = !komend.length;
  }

  const dagen = [];
  for (let stap = 0; stap < 14; stap += 1) dagen.push(daysFromToday(stap));
  // A route left on a past day was never driven; it stays until someone deals
  // with it rather than quietly disappearing.
  const achterstallig = [...new Set(state.plan.filter((planned) => planned.date < vandaag).map((planned) => planned.date))].sort();
  const inHand = Boolean(state.routeInHand);

  holder.innerHTML = [...achterstallig, ...dagen].map((dag) => {
    const ritten = state.plan.filter((planned) => planned.date === dag);
    const naam = new Intl.DateTimeFormat("nl-NL", { weekday: "long", day: "numeric", month: "long" }).format(dateFromIso(dag));
    const label = dag === vandaag ? `${naam} · vandaag` : dag < vandaag ? `${naam} · niet gereden` : naam;
    const kiesbaar = inHand && dag >= vandaag;
    return `<article class="agenda-day${dag === vandaag ? " vandaag" : ""}${dag < vandaag ? " achterstallig" : ""}${ritten.length ? "" : " leeg"}${kiesbaar ? " kiesbaar" : ""}" data-day="${dag}">
      <h3>${label}</h3>
      ${kiesbaar ? `<button class="button primary place-here" type="button" data-day="${dag}">Rit hier inplannen</button>` : ""}
      ${ritten.map((planned) => {
        const status = plannedRouteStatus(planned);
        const weg = status.stops.length - status.open.length;
        return `<div class="agenda-route">
          <b><span class="rit-nummer">Rit ${planned.number || "?"}</span> ${planned.name}</b>
          <span>${status.open.length} ${status.open.length === 1 ? "stop" : "stops"}${weg ? ` · ${weg} al afgehandeld of niet gevonden` : ""}</span>
          <div class="agenda-route-actions">
            <button class="button primary open-planned" type="button" data-planned="${planned.id}">Rit openen</button>
            <button class="button subtle-action drop-planned" type="button" data-planned="${planned.id}">Uit agenda</button>
          </div>
        </div>`;
      }).join("")}
      ${!ritten.length && !kiesbaar ? '<p class="empty">Niets ingepland.</p>' : ""}
    </article>`;
  }).join("");

  holder.querySelectorAll(".place-here").forEach((button) => {
    button.addEventListener("click", () => placeRouteOnDay(button.dataset.day));
  });
  holder.querySelectorAll(".open-planned").forEach((button) => {
    button.addEventListener("click", () => openPlannedRoute(state.plan.find((planned) => planned.id === button.dataset.planned)));
  });
  holder.querySelectorAll(".drop-planned").forEach((button) => {
    button.addEventListener("click", () => removePlannedRoute(state.plan.find((planned) => planned.id === button.dataset.planned)));
  });
}

// Opening a planned route is the moment it is checked: fetch first, so what is
// judged is what Shopify says now and not what this phone had this morning.
async function openPlannedRoute(planned) {
  if (!planned) return;
  await refreshData();
  state.openPlan = state.plan.find((entry) => entry.id === planned.id) || planned;
  applyOpenPlan();
  showView("vandaag");
}

// The planned route drives the screen through manualRoute and nothing else. It
// used to be pushed into forcedIncludes as well, which left every order ever
// opened this way stuck on "Meenemen" on that phone for good.
function applyOpenPlan() {
  const planned = state.openPlan;
  if (!planned) return;
  const status = plannedRouteStatus(planned);
  state.manualRoute = status.open.length ? { orders: optimizedStopOrder(status.open) } : null;
  activeMapRouteIndex = 0;
  rebuildPlanning();
}

function closeOpenPlan() {
  state.openPlan = null;
  state.manualRoute = null;
  activeMapRouteIndex = 0;
  rebuildPlanning();
}

function renderOpenPlan() {
  const holder = document.querySelector("#openPlan");
  if (!holder) return;
  const planned = state.openPlan;
  if (!planned) {
    holder.hidden = true;
    holder.innerHTML = "";
    return;
  }

  const status = plannedRouteStatus(planned);
  const bijzonder = status.stops.filter((stop) => stop.status !== "open");
  const erbij = state.lastFetchOk ? nearbyAdditions(status.open) : [];
  const huidig = status.open.length ? routeSummary("Rit", optimizedStopOrder(status.open)) : null;

  const regel = (stop) => {
    if (stop.status === "bezorgd") return `<li class="plan-stop klaar"><s>${stop.id}</s> al bezorgd${stop.at ? ` op ${formatDateTime(stop.at)}` : ""}</li>`;
    if (stop.status === "geannuleerd") return `<li class="plan-stop fout">${stop.id} is geannuleerd, niet afleveren</li>`;
    return `<li class="plan-stop fout">${stop.id} niet gevonden. Overleg met de planner voor je gaat.</li>`;
  };

  holder.hidden = false;
  holder.innerHTML = `
    <div class="panel-heading compact">
      <div>
        <h2><span class="rit-nummer">Rit ${planned.number || "?"}</span> ${planned.name}</h2>
        <p class="open-plan-meta">${formatDate(planned.date)} · ${status.open.length} ${status.open.length === 1 ? "stop" : "stops"}${huidig ? ` · ongeveer ${formatMinutes(huidig.totalMinutes)} onderweg` : ""}</p>
      </div>
      <button id="closeOpenPlan" class="button subtle-action" type="button">Sluiten</button>
    </div>
    ${state.lastFetchOk ? "" : '<p class="plan-offline">Geen verbinding. Je ziet de rit zoals hij bij het laatste verversen was; of er iets bij kan, valt nu niet na te gaan.</p>'}
    ${bijzonder.length ? `<ul class="plan-stops">${bijzonder.map(regel).join("")}</ul>` : ""}
    ${state.lastFetchOk ? `<div class="plan-additions">
      <h3>${erbij.length ? "Sinds het inplannen binnengekomen, kan er makkelijk bij" : "Niets nieuws dat er makkelijk bij kan"}</h3>
      ${erbij.map((kandidaat) => {
        const o = kandidaat.item.order;
        const dhl = kandidaat.item.decision !== "include";
        return `<div class="plan-addition">
          <div>
            <b>${o.id} · ${o.city || "plaats onbekend"}</b>
            <span>${productSummary(o)}</span>
            <span>+${formatMinutes(kandidaat.extra)}, rit wordt dan ${formatMinutes(kandidaat.totaal)}${dhl ? " · gaat in Shopify van DHL naar eigen bezorging" : ""}</span>
          </div>
          <button class="button primary accept-addition" type="button" data-key="${orderKey(o)}">Meenemen</button>
        </div>`;
      }).join("")}
    </div>` : ""}`;

  holder.querySelector("#closeOpenPlan").addEventListener("click", closeOpenPlan);
  holder.querySelectorAll(".accept-addition").forEach((button) => {
    const kandidaat = erbij.find((k) => orderKey(k.item.order) === button.dataset.key);
    button.addEventListener("click", () => acceptAddition(kandidaat.item.order, button));
  });
}

function renderManualRouteBar() {
  const bar = document.querySelector("#manualRouteBar");
  if (bar) bar.hidden = !state.manualRoute?.orders?.length;
}

function renderPlanningOverview() {
  renderPlanningMap();
  renderRoutesOverview();
  const mapView = document.querySelector("#mapView");
  const routesOverview = document.querySelector("#routesOverview");
  const showMapButton = document.querySelector("#showMapButton");
  const showAllOrdersMapButton = document.querySelector("#showAllOrdersMapButton");
  const showRoutesButton = document.querySelector("#showRoutesButton");
  if (!mapView || !routesOverview || !showMapButton || !showAllOrdersMapButton || !showRoutesButton) return;
  mapView.hidden = planningView !== "map" && planningView !== "all-orders";
  routesOverview.hidden = planningView !== "routes";
  showMapButton.classList.toggle("active", planningView === "map");
  showAllOrdersMapButton.classList.toggle("active", planningView === "all-orders");
  showRoutesButton.classList.toggle("active", planningView === "routes");
}

function renderPlanningMap() {
  const holder = document.querySelector("#mapView");
  if (!holder) return;
  if (planningView === "all-orders") {
    renderAllOrdersMap(holder);
    return;
  }
  if (!state.routes.length) {
    holder.innerHTML = '<p class="empty">Nog geen rit om op Google Maps te tonen.</p>';
    return;
  }
  activeMapRouteIndex = Math.min(activeMapRouteIndex, state.routes.length - 1);
  const route = state.routes[activeMapRouteIndex];
  const routeButtons = state.routes.map((item, index) => `<button class="${index === activeMapRouteIndex ? "active" : ""}" type="button" data-route-index="${index}">
    Rit ${index + 1}: ${routeLabel(item)} · ${formatMinutes(item.totalMinutes)}
  </button>`).join("");
  const stops = route.orders.map((order, index) => `<li>
    <div>
      <b>${index + 1}. ${order.city || "Plaats onbekend"} · ${order.id}</b>
      <span>${productSummary(order)}</span>
      <small>${addressSummary(order)}</small>
    </div>
    <button class="button subtle-action remove-from-active-route" type="button" data-order-key="${orderKey(order)}">Uit rit halen</button>
  </li>`).join("");
  const routeKeys = new Set(route.orders.map(orderKey));
  const addableOrders = state.decisions
    .filter((item) => !routeKeys.has(orderKey(item.order)) && !item.order.cancelled && !item.order.fulfilled && item.order.deliveryMethod !== "pickup")
    .map((item) => item.order)
    .map((order) => {
      const nextRoute = routeSummary(route.region, optimizedStopOrder([...route.orders, order]));
      return { ...order, extraMinutes: Math.max(0, nextRoute.totalMinutes - route.totalMinutes), routeWouldBeMinutes: nextRoute.totalMinutes };
    })
    .sort((a, b) => a.extraMinutes - b.extraMinutes)
    .slice(0, 6);
  const addableList = addableOrders.length
    ? `<div class="route-add-box compact-add">
        <label><span>Toevoegen aan deze rit</span><select id="addToRouteSelect">
          ${addableOrders.map((order) => `<option value="${orderKey(order)}">${order.id} · ${order.city || "Plaats onbekend"} · +${order.extraMinutes} min · route ${formatMinutes(order.routeWouldBeMinutes)}</option>`).join("")}
        </select></label>
        <button class="button manual-action add-to-active-route" type="button">Toevoegen aan rit</button>
      </div>`
    : "";
  holder.innerHTML = `<div class="google-map-card">
    <iframe title="Google Maps route ${routeLabel(route)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${googleMapsEmbedUrl(route.orders)}"></iframe>
  </div>
  <div class="map-side">
    <div class="map-route-picker">${routeButtons}</div>
    <div class="map-route-summary">
      <b>Rit ${activeMapRouteIndex + 1}: ${routeLabel(route)}</b>
      <span>${route.orders.length} stops · rijden ${formatMinutes(route.driveMinutes)} · afleveren ${formatMinutes(route.deliveryMinutes)} · totaal ${formatMinutes(route.totalMinutes)}</span>
      <a class="button ghost" href="${googleMapsUrl(route.orders)}" target="_blank" rel="noreferrer">Open groot in Google Maps</a>
    </div>
    ${addableList}
    <ol class="map-order-list">${stops}</ol>
  </div>`;
  holder.querySelectorAll(".map-route-picker button").forEach((button) => {
    button.addEventListener("click", () => {
      activeMapRouteIndex = Number(button.dataset.routeIndex);
      renderPlanningOverview();
    });
  });
  holder.querySelectorAll(".add-to-active-route").forEach((button) => {
    button.addEventListener("click", () => {
      const select = holder.querySelector("#addToRouteSelect");
      const order = state.orders.find((item) => orderKey(item) === select?.value);
      addOrderToRoute(order, activeMapRouteIndex);
    });
  });
  holder.querySelectorAll(".remove-from-active-route").forEach((button) => {
    button.addEventListener("click", () => removeOrderFromRoute(button.dataset.orderKey, activeMapRouteIndex));
  });
}

function renderAllOrdersMap(holder) {
  const openOrders = state.decisions
    .filter((item) => !item.order.cancelled && !item.order.fulfilled)
    .map((item) => item.order);
  if (!openOrders.length) {
    holder.innerHTML = '<p class="empty">Geen losse open orders om op Google Maps te tonen.</p>';
    return;
  }
  holder.innerHTML = `<div id="allOrdersMap" class="real-orders-map" aria-label="Echte kaart met open orders"></div>
  <div class="map-side">
    <div class="map-route-summary">
      <b>Alle open orders op kaart</b>
      <span>${openOrders.length} losse punten. Hover over een punt voor de bestelling.</span>
      <a class="button ghost" href="${googleMapsUrl(openOrders)}" target="_blank" rel="noreferrer">Open alle orders in Google Maps</a>
    </div>
    <div class="map-legend">
      <span><i class="map-dot include"></i> Meenemen</span>
      <span><i class="map-dot review"></i> Controleren</span>
      <span><i class="map-dot dhl"></i> DHL</span>
      <span><i class="map-dot far"></i> Te ver</span>
      <span><i class="map-dot exclude"></i> Niet meenemen</span>
    </div>
  </div>`;
  renderLeafletOrderMap(openOrders);
}

function renderLeafletOrderMap(openOrders) {
  const mapElement = document.querySelector("#allOrdersMap");
  if (!mapElement || !window.L) {
    mapElement.innerHTML = '<p class="empty">Kaart wordt geladen. Ververs als hij niet verschijnt.</p>';
    return;
  }
  if (allOrdersLeafletMap) {
    allOrdersLeafletMap.remove();
    allOrdersLeafletMap = null;
  }
  allOrdersLeafletMap = L.map(mapElement, { scrollWheelZoom: false });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap",
  }).addTo(allOrdersLeafletMap);

  const markerPoints = [[DEPOT_POINT.lat, DEPOT_POINT.lon]];
  L.circleMarker([DEPOT_POINT.lat, DEPOT_POINT.lon], {
    radius: 7,
    color: "#ffffff",
    weight: 2,
    fillColor: "#0d3029",
    fillOpacity: 1,
  }).addTo(allOrdersLeafletMap).bindTooltip("Goorsteeg 46, Ede");

  openOrders.forEach((order) => {
    const point = orderPoint(order);
    const decision = state.decisions.find((item) => item.order === order)?.decision || "exclude";
    markerPoints.push([point.lat, point.lon]);
    L.circleMarker([point.lat, point.lon], {
      radius: 7,
      color: "#ffffff",
      weight: 2,
      fillColor: markerColor(decision),
      fillOpacity: 1,
    }).addTo(allOrdersLeafletMap).bindTooltip(orderTooltip(order), {
      direction: "top",
      opacity: 1,
      sticky: true,
    });
  });

  allOrdersLeafletMap.fitBounds(markerPoints, { padding: [32, 32], maxZoom: 8 });
  setTimeout(() => allOrdersLeafletMap?.invalidateSize(), 0);
}

function markerColor(decision) {
  if (decision === "include") return "#168a54";
  if (decision === "review") return "#c7810c";
  if (decision === "dhl") return "#2f6fb3";
  if (decision === "far") return "#6b5b95";
  return "#b94a3f";
}

function orderTooltip(order) {
  return `<div class="map-tooltip-content">
    <b>${order.id} · ${order.customer || "Onbekende klant"}</b>
    <span>${productSummary(order)}</span>
    <span>${addressSummary(order)}</span>
    <small>${order.paymentStatus || (order.paid ? "Betaald" : "In afwachting")} · uiterlijk ${formatDate(order.dueDate)}</small>
  </div>`;
}

function renderRoutesOverview() {
  const holder = document.querySelector("#routesOverview");
  if (!holder) return;
  if (!state.routes.length) {
    holder.innerHTML = '<p class="empty">Nog geen ritten om te tonen.</p>';
    return;
  }
  holder.innerHTML = state.routes.map((route, index) => `<article class="route-overview-card">
    <div><b>${index + 1}. ${routeLabel(route)}</b><span>${route.orders.length} stops · rijden ${formatMinutes(route.driveMinutes)} · afleveren ${formatMinutes(route.deliveryMinutes)} · totaal ${formatMinutes(route.totalMinutes)}</span></div>
    <ol>${route.orders.map((order) => `<li>${order.city || "Plaats onbekend"} · ${order.id} · ${productSummary(order)}</li>`).join("")}</ol>
    <div class="route-overview-actions">
      <button class="button manual-action show-route-map" type="button" data-route-index="${index}">Toon op kaart</button>
      <a class="button ghost" href="${googleMapsUrl(route.orders)}" target="_blank" rel="noreferrer">Open in Maps</a>
    </div>
  </article>`).join("");
  holder.querySelectorAll(".show-route-map").forEach((button) => {
    button.addEventListener("click", () => {
      activeMapRouteIndex = Number(button.dataset.routeIndex);
      planningView = "map";
      renderPlanningOverview();
    });
  });
}

function renderOrders() {
  const term = document.querySelector("#searchInput").value.trim().toLowerCase();
  const filter = document.querySelector("#decisionFilter").value;
  const visible = state.decisions.filter((item) => {
    const haystack = [item.order.id, item.order.webshop, item.order.customer, item.order.city, item.order.postcode, item.order.products.join(" ")].join(" ").toLowerCase();
    return (!term || haystack.includes(term)) && (filter === "all" || item.decision === filter);
  });

  document.querySelector("#ordersBody").innerHTML = groupedOrderSections(visible);
  renderSelectionBar();
  document.querySelectorAll(".order-select").forEach((input) => {
    input.addEventListener("change", () => toggleSelected(input.dataset.orderKey, input.checked));
  });
  document.querySelectorAll(".force-include").forEach((button) => {
    const order = state.orders.find((item) => orderKey(item) === button.dataset.orderKey);
    button.addEventListener("click", () => forceInclude(order));
  });
  document.querySelectorAll(".clear-force-include").forEach((button) => {
    const order = state.orders.find((item) => orderKey(item) === button.dataset.orderKey);
    button.addEventListener("click", () => clearForceInclude(order));
  });
  document.querySelector("#emptyState").hidden = visible.length > 0;
}

function groupedOrderSections(items) {
  const groups = [
    ["include", "Meenemen", "Orders die automatisch of handmatig mee kunnen"],
    ["review", "Controleren", "Orders met betaling, afspraak of ontbrekende info om te beoordelen"],
    ["dhl", "DHL", "Slowfeeder-orders zonder hooihuisje of XXL bak, en XXL bakken die te ver liggen"],
    ["far", "Te ver voor eigen vervoer", "Rijplaten buiten het bereik die op geen enkele rit passen"],
    ["exclude", "Niet meenemen", "Orders die nu niet voor eigen bezorging of ritplanning gelden"],
  ];
  return groups
    .map(([key, title, subtitle]) => {
      const groupItems = items.filter((item) => item.decision === key);
      if (!groupItems.length) return "";
      return `<section class="order-group ${key}">
        <div class="order-group-heading">
          <div><h3>${title}</h3><p>${subtitle}</p></div>
          <strong>${groupItems.length}</strong>
        </div>
        <div class="order-group-list">${groupItems.map((item) => orderCard(item)).join("")}</div>
      </section>`;
    })
    .join("");
}

function orderCard(item) {
  const order = item.order;
  const key = orderKey(order);
  const isForced = forcedIncludes.has(key);
  return `<article class="order-card">
    <div class="order-main">
      <div class="order-title-row">
        <label class="select-order"><input class="order-select" type="checkbox" data-order-key="${key}" ${state.selected.has(key) ? "checked" : ""} /><span>Selecteer</span></label>
        <span class="shop-chip ${businessClass(order)}">${businessLogo(order)}</span>
        <span class="badge ${item.decision}">${decisionLabels[item.decision]}</span>
      </div>
      <h3>${order.id} · ${order.customer}</h3>
      <p class="product-line">${productSummary(order)}</p>
      <p class="address-line">${addressSummary(order)}</p>
      <p class="reason">${item.reason}</p>
    </div>
    <div class="order-side">
      <span><b>Uiterlijk</b>${formatDate(order.dueDate)}</span>
      <span><b>Betaling</b>${order.paymentStatus || (order.paid ? "Betaald" : "In afwachting")}</span>
      <a class="button ghost" href="${singleOrderMapsUrl(order)}" target="_blank" rel="noreferrer">Maps</a>
      ${manualActionButton(item, key, isForced)}
    </div>
  </article>`;
}

function renderSelectionBar() {
  const bar = document.querySelector("#selectionBar");
  if (!bar) return;
  const selectedOrders = selectedOrdersList();
  bar.hidden = selectedOrders.length === 0;
  if (!selectedOrders.length) return;
  bar.querySelector(".selection-count").textContent = `${selectedOrders.length} geselecteerd`;
}

function selectedOrdersList() {
  return state.orders.filter((order) => state.selected.has(orderKey(order)));
}

function manualActionButton(item, key, isForced) {
  if (item.order.cancelled || item.order.fulfilled || item.order.deliveryMethod === "pickup") return "";
  if (isForced) return `<button class="button subtle-action clear-force-include" type="button" data-order-key="${key}">Automatisch advies</button>`;
  if (item.decision === "include") return "";
  return `<button class="button manual-action force-include" type="button" data-order-key="${key}">Toch zelf bezorgen</button>`;
}

function renderRoutes() {
  const holder = document.querySelector("#routes");
  const template = document.querySelector("#routeTemplate");
  renderSuggestions();
  holder.innerHTML = "";
  if (!state.routes.length) {
    holder.innerHTML = '<p class="empty">Nog geen geschikte orders voor een rit.</p>';
    return;
  }
  state.routes.forEach((route, index) => {
    const fragment = template.content.cloneNode(true);
    fragment.querySelector(".route-number").textContent = index + 1;
    fragment.querySelector(".route-name").textContent = routeLabel(route);
    fragment.querySelector(".route-meta").textContent = `${CONFIG.depot} · ${route.orders.length} stops · ruwe rijtijd ${formatMinutes(route.driveMinutes)}`;
    fragment.querySelector(".route-load").textContent = `${route.load.toLocaleString("nl-NL")} kg · afleveren ${formatMinutes(route.deliveryMinutes)} · totaal ${formatMinutes(route.totalMinutes)} · ${routeWarning(route)}`;
    fragment.querySelector(".route-map").href = googleMapsUrl(route.orders);
    // A computed route whose every stop already sits in a planned route says so,
    // so the planner does not put the same van load on the calendar twice.
    const alGepland = route.orders.length ? plannedFor(route.orders[0]) : null;
    const helemaalGepland = alGepland && route.orders.every((order) => plannedFor(order)?.id === alGepland.id);
    if (!state.openPlan) {
      if (helemaalGepland) {
        const label = document.createElement("span");
        label.className = "al-gepland";
        label.innerHTML = `<span class="rit-nummer">Rit ${alGepland.number || "?"}</span> ${formatDate(alGepland.date)}`;
        fragment.querySelector(".route-footer").appendChild(label);
      } else {
        const planKnop = document.createElement("button");
        planKnop.type = "button";
        planKnop.className = "button primary plan-route";
        planKnop.textContent = "Inplannen";
        planKnop.addEventListener("click", () => putRouteInHand(route));
        fragment.querySelector(".route-footer").appendChild(planKnop);
      }
    }
    // Buttons carry shop and number together: the number alone is only unique
    // for as long as the two shops keep different prefixes.
    fragment.querySelector(".route-stops").innerHTML = route.orders.map((order) => `<li><button class="remove-route-stop" type="button" data-order-key="${orderKey(order)}" aria-label="${order.id} uit deze rit halen">−</button><b>${order.city} · ${order.id}</b><span>${productSummary(order)} · ${deliveryMinutes(order)} min lossen/laden</span><span>${addressSummary(order)} · <a href="${singleOrderMapsUrl(order)}" target="_blank" rel="noreferrer">Maps</a> <button class="mark-delivered" type="button" data-order-key="${orderKey(order)}">Bezorgd</button></span></li>`).join("");
    fragment.querySelectorAll(".remove-route-stop").forEach((button) => {
      button.addEventListener("click", () => removeOrderFromRoute(button.dataset.orderKey, index));
    });
    fragment.querySelectorAll(".mark-delivered").forEach((button) => {
      const order = route.orders.find((item) => orderKey(item) === button.dataset.orderKey);
      button.addEventListener("click", () => markDelivered(order, button));
    });
    holder.appendChild(fragment);
  });
}

function renderSuggestions() {
  const holder = document.querySelector("#suggestions");
  if (!holder) return;
  const suggestions = nearbySuggestions();
  state.suggestions = suggestions;
  if (!suggestions.length) {
    holder.innerHTML = "";
    return;
  }
  holder.innerHTML = `<div class="suggestion-box"><b>Mogelijk combineren</b><p>Deze orders liggen logisch bij je handmatige selectie of route.</p>${suggestions.map((order) => `
    <article>
      <span>${order.id} · ${order.city}</span>
      <small>${productSummary(order)}</small>
      <em>+${order.extraMinutes} min geschat · route wordt ${formatMinutes(order.routeWouldBeMinutes)}</em>
      <button class="button subtle-action add-suggestion" type="button" data-order-key="${orderKey(order)}">Voeg toe</button>
    </article>`).join("")}</div>`;
  holder.querySelectorAll(".add-suggestion").forEach((button) => {
    const order = state.orders.find((item) => orderKey(item) === button.dataset.orderKey);
    button.addEventListener("click", () => forceInclude(order));
  });
}

function nearbySuggestions() {
  const routeOrders = state.manualRoute?.orders?.length
    ? state.manualRoute.orders
    : selectedOrdersList().length
      ? selectedOrdersList()
      : state.orders.filter((order) => forcedIncludes.has(orderKey(order))).length
        ? state.orders.filter((order) => forcedIncludes.has(orderKey(order)))
        : state.routes.flatMap((route) => route.orders);
  if (!routeOrders.length) return [];
  const routeKeys = new Set(routeOrders.map(orderKey));
  const currentRouteMinutes = routeSummary("huidige route", optimizedStopOrder(routeOrders)).totalMinutes;
  return state.decisions
    .filter((item) => suggestionCandidate(item, routeKeys))
    .map((item) => item.order)
    .map((order) => {
      const nextRoute = routeSummary("suggestie", optimizedStopOrder([...routeOrders, order]));
      return {
        ...order,
        extraMinutes: Math.max(0, nextRoute.totalMinutes - currentRouteMinutes),
        routeWouldBeMinutes: nextRoute.totalMinutes,
      };
    })
    .filter((order) => order.extraMinutes <= 120)
    .sort((a, b) => a.extraMinutes - b.extraMinutes)
    .slice(0, 3);
}

function suggestionCandidate(item, routeKeys) {
  const order = item.order;
  if (routeKeys.has(orderKey(order)) || state.selected.has(orderKey(order))) return false;
  if (order.cancelled || order.fulfilled || order.deliveryMethod === "pickup") return false;
  if (!order.addressComplete || !order.paid) return false;
  return item.decision === "include" || item.decision === "review" || item.decision === "exclude";
}

function sameRouteCorridor(routeOrders, candidate) {
  return routeOrders.some((order) => regionFor(order) === regionFor(candidate) || countryName(order) && countryName(order) === countryName(candidate));
}

function countryName(order) {
  const text = [order.country, order.fullAddress].filter(Boolean).join(" ");
  if (/belg|\bbe\b/i.test(text)) return "BE";
  if (/nederland|netherlands|\bnl\b/i.test(text)) return "NL";
  return "";
}

// The real point when PDOK knows the address; otherwise the old estimate, which
// puts the whole of a postcode region on a single spot. Only Dutch addresses are
// looked up, so orders abroad and ones with an incomplete address stay estimated.
function orderPoint(order) {
  const known = state.geo[orderAddress(order)];
  if (known) return known;
  return estimatedPoint(order);
}

function estimatedPoint(order) {
  const postcode = String(order.postcode || "").replace(/\s+/g, "").toUpperCase();
  const country = countryName(order);
  const number = Number((postcode.match(/\d+/) || [0])[0]);
  if (country === "BE" || number < 1000) return belgiumPoint(number, order);
  return netherlandsPoint(number, order);
}

function netherlandsPoint(number, order) {
  const prefix = Math.floor(number / 100);
  if (prefix >= 10 && prefix <= 29) return { lat: 52.25, lon: 4.75 };
  if (prefix >= 30 && prefix <= 33) return { lat: 51.92, lon: 4.45 };
  if (prefix >= 34 && prefix <= 39) return { lat: 52.08, lon: 5.18 };
  if (prefix >= 40 && prefix <= 49) return { lat: 51.75, lon: 5.15 };
  if (prefix >= 50 && prefix <= 59) return { lat: 51.48, lon: 5.35 };
  if (prefix >= 60 && prefix <= 64) return { lat: 51.05, lon: 5.85 };
  if (prefix >= 65 && prefix <= 69) return { lat: 51.93, lon: 5.90 };
  if (prefix >= 70 && prefix <= 75) return { lat: 52.12, lon: 6.35 };
  if (prefix >= 76 && prefix <= 79) return { lat: 52.45, lon: 6.55 };
  if (prefix >= 80 && prefix <= 83) return { lat: 52.55, lon: 5.70 };
  if (prefix >= 84 && prefix <= 99) return { lat: 53.05, lon: 6.35 };
  if (/ede/i.test(order.city || "")) return DEPOT_POINT;
  return DEPOT_POINT;
}

function belgiumPoint(number, order) {
  if (number >= 1000 && number <= 1299) return { lat: 50.85, lon: 4.35 };
  if (number >= 1300 && number <= 1499) return { lat: 50.70, lon: 4.50 };
  if (number >= 1500 && number <= 1999) return { lat: 50.80, lon: 4.05 };
  if (number >= 2000 && number <= 2999) return { lat: 51.22, lon: 4.40 };
  if (number >= 3000 && number <= 3499) return { lat: 50.90, lon: 4.80 };
  if (number >= 3500 && number <= 3999) return { lat: 50.95, lon: 5.35 };
  if (number >= 4000 && number <= 4999) return { lat: 50.60, lon: 5.55 };
  if (number >= 5000 && number <= 5999) return { lat: 50.35, lon: 4.85 };
  if (number >= 6000 && number <= 6599) return { lat: 50.40, lon: 4.45 };
  if (number >= 6600 && number <= 6999) return { lat: 50.15, lon: 5.60 };
  if (number >= 7000 && number <= 7999) return { lat: 50.45, lon: 3.90 };
  if (number >= 8000 && number <= 8999) return { lat: 51.05, lon: 3.20 };
  if (number >= 9000 && number <= 9999) return { lat: 51.05, lon: 3.75 };
  if (/antwerpen/i.test(order.city || "")) return { lat: 51.22, lon: 4.40 };
  if (/tollembeek|tollenbeek/i.test(order.city || "")) return { lat: 50.75, lon: 4.00 };
  return { lat: 50.85, lon: 4.35 };
}

function distanceKm(a, b) {
  const latKm = (a.lat - b.lat) * 111;
  const lonKm = (a.lon - b.lon) * 70;
  return Math.sqrt(latKm ** 2 + lonKm ** 2);
}

function mapPosition(order) {
  return mapPositionFromPoint(orderPoint(order));
}

function mapPositionFromPoint(point) {
  const bounds = { minLat: 50.0, maxLat: 53.6, minLon: 2.8, maxLon: 7.3 };
  const x = clamp(((point.lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * 100, 4, 96);
  const y = clamp((1 - ((point.lat - bounds.minLat) / (bounds.maxLat - bounds.minLat))) * 100, 4, 96);
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pinLabel(order) {
  return order.webshop === "De Rijplaten Specialist" ? "DR" : "SF";
}

function bearingFromDepot(point) {
  const y = Math.sin(toRad(point.lon - DEPOT_POINT.lon)) * Math.cos(toRad(point.lat));
  const x = Math.cos(toRad(DEPOT_POINT.lat)) * Math.sin(toRad(point.lat))
    - Math.sin(toRad(DEPOT_POINT.lat)) * Math.cos(toRad(point.lat)) * Math.cos(toRad(point.lon - DEPOT_POINT.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function toRad(value) {
  return value * Math.PI / 180;
}

function toDeg(value) {
  return value * 180 / Math.PI;
}

function toggleSelected(key, checked) {
  if (checked) state.selected.add(key);
  else state.selected.delete(key);
  renderSelectionBar();
}

function clearSelection() {
  state.selected.clear();
  state.manualRoute = null;
  rebuildPlanning();
}

function makeRouteFromSelection() {
  const orders = selectedOrdersList();
  if (!orders.length) return;
  const load = orders.reduce((sum, order) => sum + Number(order.weightKg || 0), 0);
  const deliveryTotal = orders.reduce((sum, order) => sum + deliveryMinutes(order), 0);
  for (const order of orders) forcedIncludes.add(orderKey(order));
  saveForcedIncludes();
  state.manualRoute = { orders, load, deliveryMinutes: deliveryTotal };
  rebuildPlanning();
}

// routeIndex says which route the button belongs to. It used to be implicit, and
// every route's buttons acted on whichever route the map had selected.
async function addOrderToRoute(order, routeIndex) {
  if (!order || !state.routes[routeIndex]) return;
  // Anything the rules did not already put on own transport gets tagged as own
  // delivery in Shopify first, so the webshop and the planning agree.
  if (state.decisions.find((item) => item.order === order)?.decision !== "include") {
    const tagged = await forceInclude(order);
    if (!tagged) return;
    order.deliveryMethod = "delivery";
  }
  const route = state.routes[routeIndex];
  const nextOrders = optimizedStopOrder([...route.orders.filter((item) => orderKey(item) !== orderKey(order)), order]);
  for (const item of nextOrders) forcedIncludes.add(orderKey(item));
  saveForcedIncludes();
  state.manualRoute = { orders: nextOrders };
  activeMapRouteIndex = 0;
  planningView = "map";
  rebuildPlanning();
}

function removeOrderFromRoute(key, routeIndex) {
  if (!key || !state.routes[routeIndex]) return;
  const route = state.routes[routeIndex];
  const stop = route.orders.find((order) => orderKey(order) === key);
  if (!stop) return;
  // Taking a stop out cannot be undone, and it drops the planning into manual
  // mode where the other routes are hidden. Both deserve saying out loud.
  if (!window.confirm(`${stop.id} uit deze rit halen? Dit kan niet ongedaan gemaakt worden. De andere ritten verdwijnen zolang van het scherm.`)) return;
  const nextOrders = route.orders.filter((order) => orderKey(order) !== key);
  if (!nextOrders.length) {
    state.manualRoute = null;
    forcedIncludes.delete(key);
    saveForcedIncludes();
    activeMapRouteIndex = 0;
    rebuildPlanning();
    return;
  }
  state.manualRoute = { orders: optimizedStopOrder(nextOrders) };
  forcedIncludes.delete(key);
  saveForcedIncludes();
  activeMapRouteIndex = 0;
  planningView = "map";
  rebuildPlanning();
}

async function markSelectedDelivered() {
  const orders = selectedOrdersList();
  if (!orders.length) return;
  if (!ensureOperatorKey()) return;
  if (!window.confirm(`${orders.length} geselecteerde orders als bezorgd melden?`)) return;

  for (const order of orders) {
    const response = await backendFetch(`${CONFIG.apiBaseUrl}/actions/mark-delivered`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: order.id, shopDomain: order.shopDomain, shopifyOrderId: order.shopifyOrderId }),
    });
    const payload = await response.json();
    if (!response.ok) {
      window.alert(`${order.id}: ${payload.error || "Bezorgd melden mislukt"}`);
      break;
    }
  }
  state.selected.clear();
  state.manualRoute = null;
  await refreshData();
}

function renderHistory() {
  const holder = document.querySelector("#history");
  if (!holder) return;

  const counter = document.querySelector("#historyCount");
  if (counter) counter.textContent = state.history.length ? `${state.history.length} bezorgd` : "leeg";

  if (!state.history.length) {
    holder.innerHTML = '<p class="empty">Nog geen bezorgde orders in de historie.</p>';
    return;
  }
  holder.innerHTML = state.history.map((item) => `<article class="history-item">
    <div><b>${item.id}</b><span>${item.order?.customer || "Onbekende klant"} · ${item.order?.webshop || item.shopDomain}</span><small>${historySourceLabel(item)}: ${formatDateTime(item.deliveredAt)}</small></div>
    <button class="button ghost undo-delivered" type="button" data-order-id="${encodeURIComponent(item.id)}" data-shop-domain="${encodeURIComponent(item.shopDomain)}">Terugdraaien</button>
  </article>`).join("");
  holder.querySelectorAll(".undo-delivered").forEach((button) => {
    button.addEventListener("click", () => undoDelivered(decodeURIComponent(button.dataset.orderId), decodeURIComponent(button.dataset.shopDomain), button));
  });
}

function historySourceLabel(item) {
  return item.source === "shopify" ? "Fulfilled via Shopify" : "Bezorgd gemeld";
}

function googleMapsUrl(orders) {
  const stops = [CONFIG.depot, ...orders.map((order) => order.fullAddress || `${order.postcode} ${order.city}`), CONFIG.depot];
  return `https://www.google.com/maps/dir/${stops.map((stop) => encodeURIComponent(stop)).join("/")}`;
}

function googleMapsEmbedUrl(orders) {
  const stops = [CONFIG.depot, ...orders.map((order) => order.fullAddress || `${order.postcode} ${order.city}`), CONFIG.depot];
  const url = new URL("https://maps.google.com/maps");
  url.searchParams.set("f", "d");
  url.searchParams.set("source", "s_d");
  url.searchParams.set("hl", "nl");
  url.searchParams.set("saddr", stops[0]);
  url.searchParams.set("daddr", stops.slice(1).join(" to: "));
  url.searchParams.set("output", "embed");
  return url.toString();
}

function singleOrderEmbedUrl(order) {
  const url = new URL("https://maps.google.com/maps");
  url.searchParams.set("q", mapsAddress(order));
  url.searchParams.set("hl", "nl");
  url.searchParams.set("output", "embed");
  return url.toString();
}

function singleOrderMapsUrl(order) {
  const destination = mapsAddress(order);
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destination || order.city || "")}`;
}

function addressSummary(order) {
  return mapsAddress(order) || "Adres onbekend";
}

function mapsAddress(order) {
  return order.fullAddress
    || [order.addressLine, [order.postcode, order.city].filter(Boolean).join(" "), order.country || "Nederland"].filter(Boolean).join(", ")
    || [order.postcode, order.city, "Nederland"].filter(Boolean).join(", ");
}

function productSummary(order) {
  const products = Array.isArray(order.products) ? order.products.filter(Boolean) : [];
  return products.length ? products.join(", ") : "Product onbekend";
}

function businessClass(order) {
  return businessClasses[order.webshop] || "";
}

function businessLogo(order) {
  const label = order.webshop || "Webshop";
  const logo = businessLogos[order.webshop];
  return logo ? `<img src="${logo}" alt="${label}" />` : `<span>${label}</span>`;
}

function orderKey(order) {
  return `${order.shopDomain || ""}:${order.id}`;
}

function saveForcedIncludes() {
  localStorage.setItem(forcedIncludeKey, JSON.stringify([...forcedIncludes]));
}

async function forceInclude(order) {
  if (!order) return;
  if (!ensureOperatorKey()) return false;
  if (!window.confirm(`${order.id} als eigen bezorging taggen in Shopify?`)) return false;
  try {
    const response = await backendFetch(`${CONFIG.apiBaseUrl}/actions/set-own-delivery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: order.id, shopDomain: order.shopDomain, shopifyOrderId: order.shopifyOrderId }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Shopify tag toevoegen mislukt");
    forcedIncludes.add(orderKey(order));
    saveForcedIncludes();
    await refreshData();
    return true;
  } catch (error) {
    window.alert(error.message);
    return false;
  }
}

function clearForceInclude(order) {
  if (!order) return;
  forcedIncludes.delete(orderKey(order));
  saveForcedIncludes();
  rebuildPlanning();
}

// Orders heading the same way share one trip, so they are weighed together: the
// drive has to fit inside the budgets they bring between them. When it does not,
// the order paying least for the detour it causes drops out and the rest is
// weighed again, because losing it may well bring the trip back within budget.
function qualifyCandidates() {
  const byRegion = new Map();
  for (const item of state.decisions.filter((entry) => entry.decision === "candidate")) {
    const region = regionFor(item.order);
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(item);
  }

  for (const [region, candidates] of byRegion) {
    const kept = [...candidates];
    let verdict = "include";
    while (kept.length) {
      const drive = routeDriveMinutes(kept.map((item) => item.order));
      const budget = kept.reduce((sum, item) => sum + item.plan.budgetMinutes, 0);
      if (drive <= budget) {
        verdict = "include";
        break;
      }
      if (drive <= budget * (1 + CONFIG.budgetTolerance)) {
        verdict = "review";
        break;
      }

      let worst = null;
      for (const item of kept) {
        const others = kept.filter((entry) => entry !== item).map((entry) => entry.order);
        const causes = drive - routeDriveMinutes(others);
        const overspend = causes - item.plan.budgetMinutes;
        if (!worst || overspend > worst.overspend) worst = { item, overspend };
      }

      kept.splice(kept.indexOf(worst.item), 1);
      worst.item.decision = worst.item.plan.overflow;
      worst.item.reason = worst.item.plan.overflow === "dhl"
        ? `${worst.item.plan.label} kost meer omrijden dan de ${formatMinutes(worst.item.plan.budgetMinutes)} die deze order meebrengt; gaat als pakket via DHL`
        : `${worst.item.plan.label} kost meer omrijden dan de ${formatMinutes(worst.item.plan.budgetMinutes)} die deze order meebrengt, ook samen met de andere orders richting ${region}`;
    }

    if (!kept.length) continue;
    const drive = routeDriveMinutes(kept.map((item) => item.order));
    const budget = kept.reduce((sum, item) => sum + item.plan.budgetMinutes, 0);
    const samen = kept.length > 1 ? `${kept.length} orders richting ${region} samen ` : "";
    const shared = budget === Infinity
      ? `${formatMinutes(drive)} rijden richting ${region}; deze slowfeeders gaan altijd zelf, hoe ver ook`
      : verdict === "review"
        ? `${samen}${formatMinutes(drive)} rijden, ${formatMinutes(drive - budget)} over de ${kept.length > 1 ? "gezamenlijke " : ""}${formatMinutes(budget)}; net erover, zelf beoordelen`
        : `${samen}${formatMinutes(drive)} rijden, binnen de ${kept.length > 1 ? "gezamenlijke " : ""}${formatMinutes(budget)}`;
    for (const item of kept) {
      item.decision = verdict;
      item.reason = `${item.plan.label}: ${shared}. ${dueDateReason(item.order)}`;
    }
  }
}

// A parcel that happens to sit next to a planned route is cheaper to drop off
// than to ship, so it joins the route the trip grows least by. Parcels never
// start a route: without one nearby they stay with DHL. Routes update as each
// parcel joins, so the next one is measured against what the van really drives.
function addNearbyPackages() {
  // A planned route that is open belongs to the driver: parcels are offered to
  // them one by one and saved when accepted. Slipping them in here would put
  // them on screen but in neither the saved route nor Shopify.
  if (state.openPlan) return;
  for (const item of state.decisions.filter((entry) => entry.decision === "dhl")) {
    const order = item.order;
    if (!order.addressComplete || !order.paid || order.deliveryAppointmentLocked) continue;

    // Routes are packed to the edge of a day before parcels are offered them,
    // so without this a couple of parcels would quietly turn 5:30 into 7:30.
    const dayLimit = CONFIG.maxRouteMinutes + CONFIG.nearlyOverMinutes;
    let best = null;
    state.routes.forEach((route, index) => {
      const merged = routeSummary(route.region, optimizedStopOrder([...route.orders, order]));
      const grows = merged.totalMinutes - route.totalMinutes;
      if (grows > CONFIG.packageDetourMinutes || merged.totalMinutes > dayLimit) return;
      if (!best || grows < best.grows) best = { index, grows, merged };
    });
    if (!best) continue;

    state.routes[best.index] = best.merged;
    item.decision = "include";
    item.reason = `Pakketorder, maar rit ${best.merged.region} wordt er maar ${formatMinutes(best.grows)} langer van; goedkoper zelf meenemen. ${dueDateReason(order)}`;
  }
}

function rebuildPlanning() {
  state.decisions = state.orders.map((order) => ({ order, ...applyManualDecision(order, decide(order)) }));
  qualifyCandidates();
  state.routes = buildRoutes(state.decisions.filter((item) => item.decision === "include"));
  addNearbyPackages();
  renderSummary();
  renderAgenda();
  renderOpenPlan();
  renderManualRouteBar();
  renderPlanningOverview();
  renderOrders();
  renderRoutes();
}

function formatDateTime(value) {
  if (!value) return "Onbekend";
  return new Intl.DateTimeFormat("nl-NL", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

async function markDelivered(order, button) {
  if (!ensureOperatorKey()) return;
  if (!window.confirm(`${order.id} als bezorgd melden?`)) return;
  button.disabled = true;
  button.textContent = "Bezig…";
  try {
    const response = await backendFetch(`${CONFIG.apiBaseUrl}/actions/mark-delivered`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: order.id, shopDomain: order.shopDomain, shopifyOrderId: order.shopifyOrderId }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Bezorgd melden mislukt");
    await refreshData();
  } catch (error) {
    window.alert(error.message);
    button.disabled = false;
    button.textContent = "Bezorgd";
  }
}

async function undoDelivered(id, shopDomain, button) {
  if (!ensureOperatorKey()) return;
  if (!window.confirm(`${id} terugzetten naar open en Shopify fulfillment proberen te annuleren?`)) return;
  button.disabled = true;
  button.textContent = "Bezig…";
  try {
    const response = await backendFetch(`${CONFIG.apiBaseUrl}/actions/undo-delivered`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, shopDomain }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Terugdraaien mislukt");
    await refreshData();
  } catch (error) {
    window.alert(error.message);
    button.disabled = false;
    button.textContent = "Terugdraaien";
  }
}

function storedOperatorKey() {
  return localStorage.getItem(operatorKeyStorageKey) || "";
}

function askOperatorKey(message) {
  // A blocked prompt throws instead of returning null. Browsers block it once the
  // planner ticks "prevent additional dialogs", so this must never break the page.
  let entered = null;
  try {
    entered = window.prompt(message);
  } catch {
    entered = null;
  }

  if (!entered) {
    // Cancelling must not make the minute timer pop up a prompt over and over.
    operatorPromptDeclined = true;
    return "";
  }
  operatorPromptDeclined = false;
  localStorage.setItem(operatorKeyStorageKey, entered.trim());
  return entered.trim();
}

function ensureOperatorKey() {
  if (!usesBackend) return "";
  const stored = storedOperatorKey();
  if (stored) return stored;
  if (operatorPromptDeclined) return "";
  return askOperatorKey("Operatorcode om de planning te openen");
}

// Every backend call carries the operator code. On a rejected code the planner
// gets one chance to retype it, so a changed code does not need a page reload.
async function backendFetch(url, options = {}) {
  const send = () =>
    fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), "x-operator-key": storedOperatorKey() },
    });

  let response = await send();
  if (response.status === 401 && usesBackend && !operatorPromptDeclined) {
    localStorage.removeItem(operatorKeyStorageKey);
    if (!askOperatorKey("Operatorcode klopt niet. Probeer het opnieuw:")) return response;
    response = await send();
  }
  return response;
}

async function refreshData() {
  const button = document.querySelector("#refreshButton");
  button.disabled = true;
  button.textContent = "Bezig…";
  try {
    const separator = CONFIG.dataUrl.includes("?") ? "&" : "?";
    const response = await backendFetch(`${CONFIG.dataUrl}${separator}t=${Date.now()}`, { cache: "no-store" });
    if (response.status === 401) throw new Error("Operatorcode ontbreekt of klopt niet");
    if (!response.ok) throw new Error("Data kon niet worden geladen");
    const loaded = await response.json();
    state.allOrders = loaded;
    state.lastFetchOk = true;
    state.orders = loaded.filter((order) => !(order.dueDate && order.dueDate < hideOrdersDueBefore));
    // Before rebuildPlanning, because the travel budgets are judged against these.
    await fetchGeo(state.allOrders);
    state.driveMinutes = await fetchDriveMinutes(state.orders);
    state.history = await fetchHistory();
    state.plan = await fetchPlan();
    rebuildPlanning();
    renderHistory();
    const klok = new Intl.DateTimeFormat("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
    const bron = state.driveMinutes ? "echte rijtijden" : "geschatte rijtijden";
    document.querySelector("#syncText").textContent = `Laatst ververst om ${klok} · ${bron}`;
  } catch (error) {
    state.lastFetchOk = false;
    document.querySelector("#syncText").textContent = `${error.message} — bestaande gegevens blijven staan`;
  } finally {
    button.disabled = false;
    button.textContent = "Ververs";
  }
}

// Real driving times from the backend, which holds the Google key and caches a
// measured journey so an address is only ever looked up once. Any failure here
// leaves state.driveMinutes null and the planning falls back to its estimate.
async function fetchDriveMinutes(orders) {
  if (!usesBackend) return null;
  const stops = [...new Set(orders.map(orderAddress).filter(Boolean))];
  if (!stops.length) return null;
  try {
    const response = await backendFetch(`${CONFIG.apiBaseUrl}/routes/estimate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stops }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    state.driveDepot = payload.depot || "";
    return payload.minutes || null;
  } catch {
    return null;
  }
}

// A day as the planner's own calendar reads it. Never toISOString(), which would
// call a route planned for tomorrow evening today whenever the clock is ahead.
function isoDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function daysFromToday(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return isoDay(date);
}

// A week back as well, so a route that was planned and never driven stays in
// sight instead of dropping off the calendar the morning after.
async function fetchPlan() {
  if (!usesBackend) return [];
  try {
    const response = await backendFetch(`${CONFIG.apiBaseUrl}/plan?from=${daysFromToday(-7)}&t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return state.plan;
    return (await response.json()).routes || [];
  } catch {
    return state.plan;
  }
}

// Stops are shop and order number together. Records saved before that change
// hold bare numbers; those are matched on number as a last resort.
function planKeys(planned) {
  if (Array.isArray(planned.orderKeys)) return planned.orderKeys;
  return (planned.orderIds || []).map((id) => {
    const match = state.allOrders.find((order) => order.id === id);
    return match ? orderKey(match) : `?:${id}`;
  });
}

async function savePlan({ id, date, fromDate, name, keys }) {
  try {
    const response = await backendFetch(`${CONFIG.apiBaseUrl}/plan/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, date, fromDate, name, orderKeys: keys }),
    });
    if (!response.ok) return null;
    return (await response.json()).route || null;
  } catch {
    return null;
  }
}

async function removePlannedRoute(planned) {
  if (!window.confirm(`Rit ${planned.number || "?"} naar ${planned.name} van ${formatDate(planned.date)} uit de agenda halen?`)) return;
  const response = await backendFetch(`${CONFIG.apiBaseUrl}/plan/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: planned.id, date: planned.date }),
  }).catch(() => null);
  if (!response?.ok) {
    window.alert("Uit de agenda halen is niet gelukt. Probeer het opnieuw.");
    return;
  }
  if (state.openPlan?.id === planned.id) closeOpenPlan();
  state.plan = await fetchPlan();
  rebuildPlanning();
}

// Each stored stop, matched against everything the backend returned, not just
// what the planning shows: an order whose date moved back in Shopify is hidden
// from the planning but very much alive. Only what can be shown is claimed:
// delivered when the history says so, otherwise just not found.
function plannedRouteStatus(planned) {
  const byKey = new Map(state.allOrders.map((order) => [orderKey(order), order]));
  const delivered = new Map(state.history.map((entry) => [`${entry.shopDomain}:${entry.id}`, entry]));
  const stops = planKeys(planned).map((key) => {
    const order = byKey.get(key);
    if (order) return { key, id: order.id, order, status: order.cancelled ? "geannuleerd" : "open" };
    const done = delivered.get(key);
    if (done) return { key, id: done.id, status: "bezorgd", at: done.deliveredAt };
    return { key, id: key.split(":").pop(), status: "onbekend" };
  });
  return { stops, open: stops.filter((stop) => stop.status === "open").map((stop) => stop.order) };
}

// The same bar the planning applies before a parcel rides along: paid, fully
// addressed, no slot agreed with the customer. The driver's offer used to skip
// it, which made it the one door an unpaid order could walk through into the van.
function additionAllowed(item) {
  const order = item.order;
  if (item.decision === "exclude") return false;
  return Boolean(order.addressComplete && order.paid && !order.deliveryAppointmentLocked);
}

// Measured against the route as it stands right now. After every acceptance the
// list is rebuilt against the grown route, so five offers of "+25 min" can never
// add up to two hours unnoticed.
function nearbyAdditions(orders) {
  if (!orders.length) return [];
  const inRoute = new Set(orders.map(orderKey));
  const basis = routeSummary("Rit", optimizedStopOrder(orders));
  const dayLimit = CONFIG.maxRouteMinutes + CONFIG.nearlyOverMinutes;

  return state.decisions
    .filter((item) => !inRoute.has(orderKey(item.order)) && additionAllowed(item))
    .map((item) => {
      const merged = routeSummary("Rit", optimizedStopOrder([...orders, item.order]));
      return { item, extra: merged.totalMinutes - basis.totalMinutes, totaal: merged.totalMinutes, load: merged.load };
    })
    .filter((kandidaat) => kandidaat.extra <= CONFIG.packageDetourMinutes
      && kandidaat.totaal <= dayLimit
      && kandidaat.load <= CONFIG.vehicleCapacityKg)
    .sort((a, b) => a.extra - b.extra)
    .slice(0, 5);
}

// A parcel the rules had on DHL is tagged as own delivery in Shopify before it
// joins, so whoever prints the DHL labels that morning does not ship it twice.
async function tagOwnDelivery(order) {
  try {
    const response = await backendFetch(`${CONFIG.apiBaseUrl}/actions/set-own-delivery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: order.id, shopDomain: order.shopDomain, shopifyOrderId: order.shopifyOrderId }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// The screen only changes once both the Shopify tag and the saved route have
// gone through. Poor signal at a van is the normal case, and a driver told a
// stop was added when it was not is worse off than one told it failed.
async function acceptAddition(order, button) {
  const planned = state.openPlan;
  if (!planned) return;
  if (button) {
    button.disabled = true;
    button.textContent = "Bezig…";
  }

  const decision = state.decisions.find((item) => orderKey(item.order) === orderKey(order))?.decision;
  if (decision !== "include" && !(await tagOwnDelivery(order))) {
    window.alert("Toevoegen is niet gelukt, je rijdt de oorspronkelijke rit. Probeer het opnieuw als je bereik hebt.");
    renderOpenPlan();
    return;
  }

  const saved = await savePlan({
    id: planned.id,
    date: planned.date,
    fromDate: planned.date,
    name: planned.name,
    keys: [...planKeys(planned), orderKey(order)],
  });
  if (!saved) {
    window.alert("Toevoegen is niet gelukt, je rijdt de oorspronkelijke rit. Probeer het opnieuw als je bereik hebt.");
    renderOpenPlan();
    return;
  }

  state.openPlan = saved;
  state.plan = await fetchPlan();
  applyOpenPlan();
}

// Coordinates for every address not yet known in this browser. The backend
// keeps what PDOK returned, so after the first time this costs one KV read per
// address and never another lookup.
async function fetchGeo(orders) {
  if (!usesBackend) return;
  const missing = [...new Set(orders.map(orderAddress).filter((address) => address && !(address in state.geo)))];
  // Forty at a time, matching the backend's limit per request.
  for (let start = 0; start < missing.length; start += 40) {
    try {
      const response = await backendFetch(`${CONFIG.apiBaseUrl}/geo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addresses: missing.slice(start, start + 40) }),
      });
      if (!response.ok) return;
      const { results } = await response.json();
      for (const [address, point] of Object.entries(results || {})) {
        if (point) state.geo[address] = { lat: point.lat, lon: point.lon };
      }
    } catch {
      return;
    }
  }
}

async function fetchHistory() {
  try {
    const response = await backendFetch(`${CONFIG.apiBaseUrl}/history?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

document.querySelector("#refreshButton").addEventListener("click", () => {
  // Verversen is the way back in after cancelling the code prompt.
  operatorPromptDeclined = false;
  ensureOperatorKey();
  refreshData();
});
document.querySelector("#searchInput").addEventListener("input", renderOrders);
document.querySelector("#decisionFilter").addEventListener("change", renderOrders);
document.querySelector("#makeRouteButton")?.addEventListener("click", makeRouteFromSelection);
document.querySelector("#markSelectedDeliveredButton")?.addEventListener("click", markSelectedDelivered);
document.querySelector("#clearSelectionButton")?.addEventListener("click", clearSelection);
document.querySelector("#showMapButton")?.addEventListener("click", () => {
  planningView = "map";
  renderPlanningOverview();
});
document.querySelector("#showAllOrdersMapButton")?.addEventListener("click", () => {
  planningView = "all-orders";
  renderPlanningOverview();
});
document.querySelector("#showRoutesButton")?.addEventListener("click", () => {
  planningView = "routes";
  renderPlanningOverview();
});
document.querySelector("#backToAutoButton")?.addEventListener("click", () => {
  state.openPlan = null;
  state.manualRoute = null;
  state.selected.clear();
  activeMapRouteIndex = 0;
  rebuildPlanning();
});

document.querySelector("#refreshMobile")?.addEventListener("click", () => {
  operatorPromptDeclined = false;
  ensureOperatorKey();
  refreshData();
});

// The menu on the left switches views; the page always opens on Vandaag.
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => showView(item.dataset.view));
});

renderRules();
ensureOperatorKey();
refreshData();
setInterval(refreshData, CONFIG.refreshMs);
