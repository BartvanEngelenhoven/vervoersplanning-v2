const CONFIG = {
  dataUrl: window.VERVOERSPLANNING_CONFIG?.dataUrl || "data/demo-orders.json",
  // Every open screen costs list operations on each refresh, and the Workers
  // free plan allows 1,000 of those a day before everything fails until
  // midnight UTC. Two minutes, and only while the screen is in view.
  refreshMs: 120_000,
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
  // Orders on either side of a compass line pool their budgets when they lie
  // this close together: Dalfsen and Ommen, 12 km apart, fell into two sectors
  // and were each too far alone, although together they fit.
  neighbourPoolKm: 30,
  // The route rules checked in September 2026: a hay house no longer lends an
  // endless budget to its whole sector, addresses abroad are not guessed onto
  // the depot, routes either side of a sector line are merged when that is
  // shorter, stops are put in the shortest order, and a group just over budget
  // is shown as a route to check. Off, the planning decides as before.
  ritregelsV3: false,
};

const state = { concepts: [], heldKeys: new Set(), openConcept: null, routeInHandConcept: null, orders: [], decisions: [], routes: [], reviewRoutes: [], history: [], deliveredKeys: new Map(), historyLoaded: false, selected: new Set(), manualRoute: null, suggestions: [], plan: [], planStops: [], dayNotes: [], announcements: [], announceLive: false, allOrders: [], geo: {}, role: null, driverRouteId: null, openPlan: null, routeInHand: null, placing: false, lastFetchOk: false, driveMinutes: null, driveDepot: "", driveEstimateUnavailable: false };
const decisionLabels = { include: "Meenemen", planned: "Ingepland", concept: "In concept", review: "Controleren", dhl: "DHL", far: "Te ver", exclude: "Niet meenemen" };

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
// v1 also collected every order ever put in a manual route, which then stayed on
// "Meenemen" in that browser for good. Only "Toch zelf bezorgen" writes here now,
// so the old list is left behind rather than carried over.
const forcedIncludeKey = "vervoersplanning.forceInclude.v2";
const operatorKeyStorageKey = "vervoersplanning.operatorKey.v1";
// The role that code opened last time, so a phone that loses its signal before
// asking again keeps showing the driver's screen and not the planner's portal.
const roleStorageKey = "vervoersplanning.role.v1";
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
const forcedIncludes = new Set(readStored(forcedIncludeKey, []));
// Goorsteeg 46 as PDOK places it. The old point sat 3.5 km off, south-east of Ede.
const DEPOT_POINT = { lat: 52.07309, lon: 5.63884 };
// Fitted on real depot-to-customer drive times for 25 Dutch addresses from the
// live orders (OpenStreetMap routing, 24 September 2026): one way is about ten
// minutes of getting on and off the main roads plus 0.975 minutes per km as the
// crow flies. Average error 3.7 minutes one way, against 6.8 for the flat 52 km/h
// it replaces. The fixed part is paid once out and once back, not at every stop.
const TRIP_OVERHEAD_MINUTES = 20.2;
const MINUTES_PER_KM = 0.975;
// Each further stop costs about five minutes of leaving and rejoining the main
// road that straight-line km do not see: routes of several stops came out 225
// minutes short over 46 extra stops against the same OpenStreetMap routing.
const STOP_MINUTES = 5;
// Stop orders worked out during one rebuild, by the set of stops. The same few
// sets are asked for hundreds of times while budgets and parcels are weighed.
let stopOrderCache = new Map();
let planningView = "map";
let activeMapRouteIndex = 0;
let activeLooseOrderKey = "";
let allOrdersLeafletMap = null;
let allOrdersMarkers = null;
let allOrdersFitted = false;
let refreshSeq = 0;

function productText(order) {
  return String((order.products || []).join(" ")).toLowerCase();
}

function isRijplatenOrder(order) {
  return `${escapeHtml(order.shopDomain || "")} ${escapeHtml(order.webshop || "")}`.toLowerCase().includes("rijplaten");
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
  if (order.refunded) return { decision: "exclude", reason: "Order is terugbetaald" };
  if (order.deliveryMethod === "pickup") return { decision: "exclude", reason: "Klant haalt de bestelling af" };

  const plan = transportPlan(order);
  if (!plan) {
    // Tagged "eigen bezorging" in Shopify (by hand, or it rode along in a route
    // that was later broken off) and in no route now: DHL skips it because of
    // the tag, so leaving it under DHL would mean nobody delivers it.
    if (order.ownDeliveryTagged) {
      return { decision: "review", taggedParcel: true, reason: "In Shopify getagd als eigen bezorging, maar zit in geen rit. Neem hem mee in een rit, of haal de tag in Shopify weg zodat hij met DHL gaat" };
    }
    return { decision: "dhl", reason: "Staat niet in de vaste eigen-bezorgingslijst en is geen XXL bak; gaat als pakket via DHL" };
  }

  if (!order.addressComplete) return { decision: "review", reason: "Bezorgadres is onvolledig" };
  if (CONFIG.ritregelsV3 && !hasKnownPoint(order)) {
    return { decision: "review", reason: "Adres buiten Nederland en België of zonder geldige postcode: de rijtijd is niet te schatten, zelf beoordelen" };
  }
  if (order.deliveryAppointmentLocked) return { decision: "review", reason: "Aflevermoment is afgestemd; niet verplaatsen zonder toestemming" };
  if (!order.paid) return { decision: "review", reason: "Betaling nog niet binnen; alleen optioneel meenemen als dit logisch op de route ligt" };

  // Settled in qualifyCandidates, which weighs the whole region's trip at once.
  return { decision: "candidate", plan, reason: `${plan.label}, wacht op ritberekening` };
}

function applyManualDecision(order, automatic) {
  if (!forcedIncludes.has(orderKey(order))) return automatic;
  if (order.cancelled || order.fulfilled || order.refunded || order.deliveryMethod === "pickup") return automatic;
  // Chosen by hand, but not without an address to drive to.
  if (!order.addressComplete) return automatic;
  return { decision: "include", forced: true, reason: "Handmatig meegenomen (Toch zelf bezorgen)" };
}

function dueDateReason(order) {
  if (!order.dueDate) return "Geldige bezorgorder; uiterste leverdatum ontbreekt";
  const days = daysUntil(order.dueDate);
  if (days === null) return "Uiterste leverdatum is onleesbaar";
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
  if (state.manualRoute || state.openPlan) {
    const orders = manualRouteOrders();
    if (!orders.length) return [];
    const inOrder = state.manualRoute.keepOrder ? orders : optimizedStopOrder(orders);
    return [routeSummary(state.openPlan ? `Rit ${state.openPlan.number || "?"}` : "Handmatige selectie", inOrder)];
  }
  const groups = new Map();
  for (const item of included) {
    // An order pooled with a neighbour across a sector line drives with that
    // neighbour, so it is grouped with it.
    const region = item.poolRegion || regionFor(item.order);
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
      const loadTooHigh = candidateSummary.loadKnown && candidateSummary.load > CONFIG.vehicleCapacityKg;
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
  return CONFIG.ritregelsV3 ? mergeNeighbourRoutes(routes) : routes;
}

function routeSummary(region, orders) {
  const deliveryMinutesTotal = orders.reduce((sum, order) => sum + deliveryMinutes(order), 0);
  // Shopify has no weights for most products, so an unknown weight is not a 0.
  const loadKnown = orders.some((order) => Number(order.weightKg) > 0);
  const load = orders.reduce((sum, order) => sum + Number(order.weightKg || 0), 0);
  const driveEstimate = routeDriveMinutes(orders);
  const totalMinutes = driveEstimate + deliveryMinutesTotal;
  return {
    region,
    orders,
    load,
    loadKnown,
    deliveryMinutes: deliveryMinutesTotal,
    driveMinutes: driveEstimate,
    totalMinutes,
    overByMinutes: Math.max(0, totalMinutes - CONFIG.maxRouteMinutes),
  };
}

// The address as the backend keyed it, so both sides agree on what a stop is.
function orderAddress(order) {
  return String(order.fullAddress || `${escapeHtml(order.postcode || "")} ${escapeHtml(order.city || "")}`).replace(/\s+/g, " ").trim();
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
  return Math.max(20, Math.round(TRIP_OVERHEAD_MINUTES + STOP_MINUTES * (orders.length - 1) + km * MINUTES_PER_KM));
}

// The stop order the van drives. Closest-first alone left routes of three or
// four stops more than ten minutes long in one case in six; up to seven stops
// every order is tried, beyond that closest-first is straightened out by
// swapping legs (2-opt) until no swap shortens it.
function optimizedStopOrder(orders) {
  if (orders.length < 2) return [...orders];
  const cacheKey = `${CONFIG.ritregelsV3 ? 3 : 2}|${orders.map(orderKey).sort().join("|")}`;
  const cached = stopOrderCache.get(cacheKey);
  if (cached) {
    const byKey = new Map(orders.map((order) => [orderKey(order), order]));
    return cached.map((key) => byKey.get(key));
  }

  const remaining = [...orders];
  let ordered = [];
  let currentPoint = DEPOT_POINT;
  while (remaining.length) {
    remaining.sort((a, b) => distanceKm(currentPoint, orderPoint(a)) - distanceKm(currentPoint, orderPoint(b)));
    const next = remaining.shift();
    ordered.push(next);
    currentPoint = orderPoint(next);
  }

  if (CONFIG.ritregelsV3 && ordered.length <= 7) {
    let best = ordered;
    let bestKm = loopKm(ordered);
    const permute = (prefix, rest) => {
      if (!rest.length) {
        const km = loopKm(prefix);
        if (km < bestKm - 1e-9) {
          best = prefix;
          bestKm = km;
        }
        return;
      }
      for (let index = 0; index < rest.length; index += 1) {
        permute([...prefix, rest[index]], [...rest.slice(0, index), ...rest.slice(index + 1)]);
      }
    };
    permute([], ordered);
    ordered = best;
  } else if (CONFIG.ritregelsV3) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < ordered.length - 1; i += 1) {
        for (let j = i + 1; j < ordered.length; j += 1) {
          const trial = [...ordered.slice(0, i), ...ordered.slice(i, j + 1).reverse(), ...ordered.slice(j + 1)];
          if (loopKm(trial) < loopKm(ordered) - 1e-9) {
            ordered = trial;
            improved = true;
          }
        }
      }
    }
  }

  stopOrderCache.set(cacheKey, ordered.map(orderKey));
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
  if (route.loadKnown && route.load > CONFIG.vehicleCapacityKg) return `Let op laadcapaciteit: ${route.load.toLocaleString("nl-NL")} kg`;
  if (!route.overByMinutes) return "Binnen 5:30 uur op basis van de schatting";
  if (route.overByMinutes <= CONFIG.nearlyOverMinutes) return `Bijna passend: ${route.overByMinutes} min boven 5:30 uur`;
  return `Te lang: ${route.overByMinutes} min boven 5:30 uur; apart plannen of uitzondering bespreken`;
}

function routeMinutesFromDepot(order) {
  return `heen/terug ca. ${formatMinutes(routeDriveMinutes([order]))}`;
}

// A detour that turns out shorter than nothing (a stop that lies on the way)
// reads as 0:00, not "-1:-24".
function formatMinutes(minutes) {
  const whole = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${hours}:${String(rest).padStart(2, "0")} uur`;
}

// A date that does not exist ("2026-13-01") reads as "Onbekend" instead of
// throwing, which used to stop the whole planning from drawing.
function formatDate(value) {
  if (!value) return "Niet ingevuld";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "Onbekend";
  return new Intl.DateTimeFormat("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function dateFromIso(value) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return startOfDay(date);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Three counters the planner acts on, as buttons that open the order list on
// that group. Everything that needs no decision today is named once in a quiet
// line below, so it is accounted for without competing for attention.
function renderSummary() {
  const count = (key) => state.decisions.filter((item) => item.decision === key).length;
  const urgent = urgentDecisions().length;

  const dagLine = document.querySelector("#dayLine");
  if (dagLine) {
    const dag = new Intl.DateTimeFormat("nl-NL", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
    const vandaag = isoDay(new Date());
    const vandaagGepland = state.plan.filter((planned) => planned.date === vandaag && !planned.abortedAt).length;
    const voorstellen = state.routes.length + state.reviewRoutes.length;
    const delen = state.openPlan
      ? [`Rit ${state.openPlan.number || "?"} geopend`]
      : state.openConcept
      ? [`Concept ${state.openConcept.name} geopend`]
      : [
        voorstellen ? `${voorstellen} ${voorstellen === 1 ? "voorstel" : "voorstellen"}` : "geen nieuwe voorstellen",
        vandaagGepland ? `${vandaagGepland} ${vandaagGepland === 1 ? "rit" : "ritten"} vandaag in de agenda` : "",
      ].filter(Boolean);
    dagLine.textContent = `${capitalize(dag)} · ${delen.join(" · ")}`;
  }

  const vandaagLabel = document.querySelector("#todayLabel");
  if (vandaagLabel) vandaagLabel.textContent = new Intl.DateTimeFormat("nl-NL", { day: "numeric", month: "long" }).format(new Date());

  const tellers = [
    { key: "include", label: "Meenemen", value: count("include"), sub: "nog niet ingepland" },
    { key: "review", label: "Controleren", value: count("review"), sub: "wachten op jou" },
    { key: "urgent", label: "Vandaag of te laat", value: urgent, sub: "deadline verstreken of nu" },
  ];
  document.querySelector("#summary").innerHTML = tellers.map((t) => `
    <button class="metric ${t.key}${t.value ? "" : " leeg"}" type="button" data-filter="${t.key}">
      <strong>${t.value}</strong><span>${t.label}</span><small>${t.sub}</small>
    </button>`).join("");

  document.querySelectorAll("#summary .metric").forEach((button) => {
    button.addEventListener("click", () => {
      const select = document.querySelector("#decisionFilter");
      if (select) select.value = button.dataset.filter;
      showView("orders");
      renderOrders();
    });
  });

  const rest = document.querySelector("#summaryRest");
  if (rest) {
    const delen = [
      count("planned") ? `${count("planned")} ingepland` : "",
      count("concept") ? `${count("concept")} in een concept` : "",
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
  const v3 = CONFIG.ritregelsV3;
  const budget = (rule) => rule.budgetMinutes === Infinity ? "hoe ver ook" : `tot ${formatMinutes(rule.budgetMinutes)} heen/terug`;
  const dagGrens = formatMinutes(CONFIG.maxRouteMinutes + CONFIG.nearlyOverMinutes);
  const kaarten = [
    ["Rijplaten", `Altijd eigen bezorging ${budget(transportRules.rijplaten)}. Orders dezelfde kant op tellen hun tijd bij elkaar op, dus samen mogen ze verder${v3 ? `. Liggen twee orders vlak bij elkaar maar net aan weerszijden van een windrichting (binnen ${CONFIG.neighbourPoolKm} km), dan tellen ze toch samen` : ""}.`],
    ["Grote slowfeeders", `${alwaysOwnTransportProducts.length} producttitels uit de vaste lijst gaan altijd zelf, ${budget(transportRules.alwaysOwn)}.${v3 ? " Rijplaten en XXL bakken dezelfde kant op rijden mee als de extra rijtijd binnen hun eigen budget past; het hooihuisje maakt hun budget niet groter." : ""}`],
    ["XXL bakken", `Eigen bezorging ${budget(transportRules.xxl)}, ook weer met de tijd van andere orders erbij opgeteld. Anders via DHL.`],
    ["Al het andere", `Gaat als pakket via DHL, tenzij er een rit vlak langs rijdt: dan mag de rit er hooguit ${formatMinutes(CONFIG.packageDetourMinutes)} langer van worden. Zo'n pakket krijgt bij het inplannen in Shopify de tag 'eigen bezorging', zodat het niet ook met DHL meegaat.`],
    ["Net erover", v3
      ? `Zit een groep orders tot ${Math.round(CONFIG.budgetTolerance * 100)}% boven het budget, dan staat hij als rit onder Controleren: met één klik inplannen, of eerst een order eruit halen.`
      : `Zit een rit tot ${Math.round(CONFIG.budgetTolerance * 100)}% boven het budget, dan komen de orders bij Controleren te staan in plaats van dat ze afvallen.`],
    ["Concepten", "Een rit die je wilt bewaren maar nog geen dag geeft: Opslaan als concept. Het concept houdt zijn orders vast, zodat ze niet nog eens worden voorgesteld. Onder Concepten open je hem om stops te veranderen, plan je hem in of verwijder je hem."],
    ["Al ingepland", "Een order die al in een rit in de agenda staat, ook een rit van eerder deze week die nog niet af is, wordt niet nog eens voorgesteld. Nieuwe orders komen bij een ingeplande rit via Rit openen → Kan er makkelijk bij, met dezelfde budgetten als hierboven. Een order die alleen te ver is maar in een ingeplande rit past, staat onder Controleren met het ritnummer erbij."],
    ["Rijtijd", `Geschat uit de afstand hemelsbreed tussen de echte adressen (via PDOK, gratis): ${Math.round(TRIP_OVERHEAD_MINUTES)} minuten op- en afrijden per rit, ${STOP_MINUTES} minuten per extra stop en ${String(MINUTES_PER_KM).replace(".", ",")} minuut per kilometer. Lossen: 20 minuten per stop, 90 voor een hooihuisje.`],
    ["Aankondiging", state.announceLive
      ? "Om 16:00 de dag voor een ingeplande rit gaan de betaalde orders in Shopify op verzonden, met de verzendmail aan de klant. Bezorgd melden stuurt daarna geen tweede mail."
      : "Staat op proef. Om 16:00 de dag voor een ingeplande rit schrijft het systeem in de agenda op welke orders het zou aankondigen, maar er gaat niets naar Shopify en niets naar klanten."],
    ["Lengte van een dag", `Ritten starten en eindigen op ${CONFIG.depot}. Boven ${formatMinutes(CONFIG.maxRouteMinutes)} volgt een waarschuwing. Pakketten liften mee zolang de rit onder ${dagGrens} blijft.`],
  ];
  holder.innerHTML = kaarten.map(([titel, tekst]) => `<article><b>${titel}</b><p>${escapeHtml(tekst)}</p></article>`).join("");
}

// ---------------------------------------------------------------------------
// Roles. Which screen opens depends on the code typed in, not on the link: the
// planner's code shows the whole portal, the driver's code only their routes.
// ---------------------------------------------------------------------------
async function fetchRole() {
  if (!usesBackend) return "planner";
  try {
    const response = await backendFetch(`${CONFIG.apiBaseUrl}/whoami`, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()).role || null;
  } catch {
    return null;
  }
}

function applyRole(role) {
  if (role) {
    try {
      localStorage.setItem(roleStorageKey, role);
    } catch {
      // Not remembered; asked again next time.
    }
  }
  state.role = role;
  document.body.classList.toggle("role-driver", role === "driver");
  if (role === "driver") showView("bezorger");
}

// While the driver or the planner is typing in one of the inline panels, the
// refresh must not redraw it away under their thumbs. Only a panel that can be
// seen counts: one left open on another screen used to block the agenda.
function isEditing() {
  return [...document.querySelectorAll(".inline-editor[data-open='1'], .inline-editor textarea:focus")]
    .some((element) => !element.closest(".view")?.hidden);
}

// The driver's week, plus any route of the last seven days that still has stops
// open: a delivery that could not be reported yesterday is reported this morning.
function driverRoutes() {
  const vandaag = isoDay(new Date());
  const tot = daysFromToday(7);
  const van = daysFromToday(-7);
  return state.plan
    .filter((planned) => planned.date <= tot && (planned.date >= vandaag
      || (planned.date >= van && !planned.abortedAt && plannedRouteStatus(planned).open.length)))
    .sort((a, b) => a.date.localeCompare(b.date) || (Number(a.number) || 0) - (Number(b.number) || 0));
}

function dayNoteFor(date) {
  return state.dayNotes.find((entry) => entry.date === date)?.note || "";
}

function renderDriver() {
  const holder = document.querySelector("#driverView");
  if (!holder || state.role !== "driver" || isEditing()) return;
  const open = state.plan.find((planned) => planned.id === state.driverRouteId);
  if (open) renderDriverRoute(holder, open);
  else renderDriverList(holder);
}

function renderDriverList(holder) {
  const ritten = driverRoutes();
  const vandaag = isoDay(new Date());
  const perDag = [...new Set(ritten.map((planned) => planned.date))];

  const geladen = state.planLoaded || !usesBackend;
  holder.innerHTML = `
    <div class="view-head"><h1>Jouw ritten</h1>
      <p>${!geladen ? "De ritten zijn nog niet geladen." : ritten.length ? "Tik op een rit om de stops te zien." : "Er staat deze week nog geen rit voor je klaar."}</p></div>
    ${state.lastFetchOk ? "" : '<p class="plan-offline">Geen verbinding. Je ziet de ritten zoals ze bij het laatste verversen waren; ververs als je bereik hebt.</p>'}
    ${perDag.map((dag) => {
      const naam = capitalize(new Intl.DateTimeFormat("nl-NL", { weekday: "long", day: "numeric", month: "long" }).format(dateFromIso(dag)));
      const dagnotitie = dayNoteFor(dag);
      const kop = dag === vandaag ? `Vandaag · ${naam}` : dag < vandaag ? `Nog open van ${naam.toLowerCase()}` : naam;
      return `<section class="driver-day${dag === vandaag ? " vandaag" : ""}${dag < vandaag ? " eerder" : ""}">
        <h2>${kop}</h2>
        ${dagnotitie ? `<p class="note-box">${escapeHtml(dagnotitie)}</p>` : ""}
        ${ritten.filter((planned) => planned.date === dag).map((planned) => {
          const status = plannedRouteStatus(planned);
          const klaar = status.stops.filter((stop) => stop.status === "bezorgd").length;
          return `<button class="driver-route${planned.abortedAt ? " afgebroken" : ""}" type="button" data-planned="${escapeHtml(planned.id)}">
            <span class="rit-nummer">Rit ${escapeHtml(planned.number || "?")}</span>
            <b>${escapeHtml(planned.name)}</b>
            <span>${planned.abortedAt ? "Afgebroken" : `${status.open.length} te gaan${klaar ? ` · ${klaar} bezorgd` : ""}`}</span>
            ${planned.note ? `<em>${escapeHtml(planned.note)}</em>` : ""}
          </button>`;
        }).join("")}
      </section>`;
    }).join("")}
    <div class="driver-foot"><button class="button subtle-action logout-button" type="button">Uitloggen op deze telefoon</button>
    <a class="button subtle-action" href="handleiding.html#bezorger">Handleiding</a></div>`;

  holder.querySelectorAll(".driver-route").forEach((button) => {
    button.addEventListener("click", async () => {
      state.driverRouteId = button.dataset.planned;
      // Opening is the moment to check: what Shopify says now, not this morning.
      // The route counts as open while that check runs, so what it offers is
      // weighed against this route and not against suggestions of the day.
      state.openPlan = state.plan.find((planned) => planned.id === state.driverRouteId) || null;
      await refreshData();
      renderDriver();
      window.scrollTo({ top: 0 });
    });
  });
  holder.querySelector(".logout-button")?.addEventListener("click", logout);
}

function renderDriverRoute(holder, planned) {
  const status = plannedRouteStatus(planned);
  // The order the route was planned in, which is the order it is driven in.
  // Worked out again from the depot after every stop, it sent the driver back
  // west from Arnhem before going on east.
  const volgorde = status.open;
  // Taking something along is for the route being driven, not one for later in
  // the week: that is the planner's to change.
  const rijdtNu = planned.date <= isoDay(new Date());
  const erbij = state.lastFetchOk && !planned.abortedAt && rijdtNu ? nearbyAdditions(status.open) : [];
  const dagnotitie = dayNoteFor(planned.date);

  holder.innerHTML = `
    <button id="driverBack" class="button subtle-action driver-back" type="button">‹ Alle ritten</button>
    <div class="driver-route-head">
      <h1><span class="rit-nummer">Rit ${escapeHtml(planned.number || "?")}</span> ${escapeHtml(planned.name)}</h1>
      <p>${formatDate(planned.date)} · ${status.open.length} te gaan</p>
    </div>
    ${planned.note ? `<p class="note-box"><b>Van de planner:</b> ${escapeHtml(planned.note)}</p>` : ""}
    ${dagnotitie ? `<p class="note-box"><b>Deze dag:</b> ${escapeHtml(dagnotitie)}</p>` : ""}
    ${state.lastFetchOk ? "" : '<p class="plan-offline">Geen verbinding. Je ziet de rit zoals hij bij het laatste verversen was.</p>'}
    ${planned.abortedAt ? `<p class="note-box afgebroken">Deze rit is afgebroken${planned.abortReason ? `: ${escapeHtml(planned.abortReason)}` : ""}.</p>` : ""}
    ${volgorde.length ? `<a class="button primary driver-maps" href="${driverMapsUrl(volgorde)}" target="_blank" rel="noreferrer">Rit openen in Google Maps</a>` : ""}

    <ol class="driver-stops">
      ${volgorde.map((order, index) => `<li class="driver-stop">
        <div class="driver-stop-nr">${index + 1}</div>
        <div class="driver-stop-body">
          <b>${escapeHtml(order.customer || "Onbekende klant")}${order.announced ? '<span class="badge-announced">aangekondigd</span>' : ""}</b>
          <a class="driver-address" href="${singleOrderMapsUrl(order)}" target="_blank" rel="noreferrer">${addressSummary(order)}</a>
          ${order.phone ? `<a class="driver-phone" href="${telHref(order.phone)}">Bel ${escapeHtml(order.phone)}</a>` : ""}
          <span class="driver-products">${productSummary(order)}</span>
          ${order.customerNote ? `<span class="driver-customer-note">Klant schreef: ${escapeHtml(order.customerNote)}</span>` : ""}
          <span class="driver-meta">${escapeHtml(order.id)} · ${escapeHtml(order.webshop || "")} · ${deliveryMinutes(order)} min lossen</span>
          ${planned.abortedAt ? "" : `<button class="button primary mark-delivered driver-deliver" type="button" data-order-key="${orderKey(order)}">Bezorgd</button>`}
        </div>
      </li>`).join("")}
    </ol>

    ${status.stops.filter((stop) => stop.status !== "open").length ? `<ul class="plan-stops">${status.stops.filter((stop) => stop.status !== "open").map(stopStatusLine).join("")}</ul>` : ""}

    ${erbij.length ? `<div class="plan-additions"><h3>Kan er nog bij</h3>${erbij.map((kandidaat) => {
      const o = kandidaat.item.order;
      return `<div class="plan-addition"><div><b>${escapeHtml(o.id)} · ${escapeHtml(o.city || "")}</b>
        <span>${productSummary(o)}</span>
        <span>+${formatMinutes(kandidaat.extra)}, rit wordt dan ${formatMinutes(kandidaat.totaal)}</span></div>
        <button class="button primary accept-addition" type="button" data-key="${orderKey(o)}">Meenemen</button></div>`;
    }).join("")}</div>` : ""}

    ${planned.abortedAt ? "" : `<div class="inline-editor abort-box" id="abortBox">
      <button id="abortOpen" class="button danger" type="button">Rit afbreken</button>
      <div class="abort-form" hidden>
        <p>Wat nog niet bezorgd is, gaat terug naar de planning. Wat al bezorgd is, blijft bezorgd.</p>
        <label>Waarom? (mag leeg)<textarea id="abortReason" rows="2" maxlength="300" placeholder="Bijvoorbeeld: bus kapot, klant niet thuis"></textarea></label>
        <div class="abort-actions">
          <button id="abortConfirm" class="button danger" type="button">Ja, rit afbreken</button>
          <button id="abortCancel" class="button subtle-action" type="button">Toch niet</button>
        </div>
      </div>
    </div>`}`;

  holder.querySelector("#driverBack").addEventListener("click", () => {
    state.driverRouteId = null;
    state.openPlan = null;
    state.manualRoute = null;
    rebuildPlanning();
    window.scrollTo({ top: 0 });
  });
  holder.querySelectorAll(".driver-deliver").forEach((button) => {
    const order = volgorde.find((item) => orderKey(item) === button.dataset.orderKey);
    button.addEventListener("click", () => markDelivered(order, button));
  });
  holder.querySelectorAll(".accept-addition").forEach((button) => {
    const kandidaat = erbij.find((k) => orderKey(k.item.order) === button.dataset.key);
    button.addEventListener("click", () => acceptAddition(kandidaat, button));
  });

  const box = holder.querySelector("#abortBox");
  if (box) {
    const form = box.querySelector(".abort-form");
    box.querySelector("#abortOpen").addEventListener("click", () => {
      form.hidden = false;
      box.dataset.open = "1";
      box.querySelector("#abortOpen").hidden = true;
      box.querySelector("#abortReason").focus();
    });
    box.querySelector("#abortCancel").addEventListener("click", () => {
      form.hidden = true;
      delete box.dataset.open;
      box.querySelector("#abortOpen").hidden = false;
    });
    box.querySelector("#abortConfirm").addEventListener("click", (event) => {
      abortRoute(planned, box.querySelector("#abortReason").value, event.currentTarget);
    });
  }
}

async function abortRoute(planned, reden, button) {
  button.disabled = true;
  button.textContent = "Bezig…";
  let response = null;
  try {
    response = await backendFetch(`${CONFIG.apiBaseUrl}/plan/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: planned.id, date: planned.date, reason: reden }),
    });
  } catch {
    response = null;
  }
  if (!response?.ok) {
    window.alert("Afbreken is niet gelukt. Probeer het opnieuw als je bereik hebt; de rit staat nog zoals hij stond.");
    button.disabled = false;
    button.textContent = "Ja, rit afbreken";
    return;
  }
  const { route } = await response.json();
  const terug = (route.droppedKeys || []).length;
  const klaar = (route.orderKeys || []).length;
  // Done typing: let go of the reason field, or the redraw that follows would
  // still think someone is busy in it and leave the old route on screen.
  document.querySelector("#abortBox")?.removeAttribute("data-open");
  document.activeElement?.blur?.();
  window.alert(`Rit ${route.number || "?"} is afgebroken. ${klaar} bezorgd, ${terug} ${terug === 1 ? "order gaat" : "orders gaan"} terug naar de planning.`);
  state.driverRouteId = null;
  state.openPlan = null;
  await refreshData();
}

// Text typed by people (notes, reasons, customer notes) goes into the page as
// text, never as markup.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (teken) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[teken]);
}

// ---------------------------------------------------------------------------
// The planner's notes: one on a route, one on a day, both edited in place.
// ---------------------------------------------------------------------------
async function saveRouteNote(planned, note) {
  const response = await backendFetch(`${CONFIG.apiBaseUrl}/plan/note`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: planned.id, date: planned.date, note }),
  }).catch(() => null);
  return Boolean(response?.ok);
}

async function saveDayNote(date, note) {
  const response = await backendFetch(`${CONFIG.apiBaseUrl}/plan/day-note`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ date, note }),
  }).catch(() => null);
  return Boolean(response?.ok);
}

function noteEditor({ label, value, onSave }) {
  const wrap = document.createElement("div");
  wrap.className = "inline-editor note-editor";
  wrap.innerHTML = `<button class="note-toggle" type="button">${value ? "Opmerking wijzigen" : label}</button>
    <div class="note-form" hidden>
      <textarea rows="2" maxlength="1000" placeholder="Bijvoorbeeld: eerst Doorn, klant wil voor 10 uur">${escapeHtml(value)}</textarea>
      <div class="note-actions"><button class="button primary note-save" type="button">Opslaan</button>
      <button class="button subtle-action note-cancel" type="button">Annuleren</button></div>
    </div>`;
  const form = wrap.querySelector(".note-form");
  const toggle = wrap.querySelector(".note-toggle");
  toggle.addEventListener("click", () => {
    form.hidden = false;
    toggle.hidden = true;
    wrap.dataset.open = "1";
    wrap.querySelector("textarea").focus();
  });
  wrap.querySelector(".note-cancel").addEventListener("click", () => {
    form.hidden = true;
    toggle.hidden = false;
    wrap.querySelector("textarea").value = value;
    delete wrap.dataset.open;
    document.activeElement?.blur?.();
    // Whatever was held back while typing (a route placed, a refresh) shows now.
    renderAgenda();
  });
  wrap.querySelector(".note-save").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Bezig…";
    const gelukt = await onSave(wrap.querySelector("textarea").value);
    delete wrap.dataset.open;
    document.activeElement?.blur?.();
    if (!gelukt) window.alert("Opslaan is niet gelukt. Probeer het opnieuw.");
    state.plan = (await fetchPlan()) || state.plan;
    renderAgenda();
  });
  return wrap;
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

// The planned route an order sits in and still waits for: from today on, or an
// unfinished one of the last week that was not broken off. The driver sees that
// last one as "nog open", so its orders are not free to plan again until the
// driver delivers them or breaks the route off.
function plannedFor(order) {
  const key = orderKey(order);
  const weekTerug = daysFromToday(-7);
  return state.plan.find((planned) => planned.date >= weekTerug && !planned.abortedAt && planKeys(planned).includes(key)) || null;
}

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => {
    // Leaving a screen closes what was being typed there: an editor left open on
    // the agenda used to keep the agenda from ever redrawing.
    if (view.dataset.view !== name) view.querySelectorAll(".inline-editor[data-open='1']").forEach((editor) => { delete editor.dataset.open; });
    view.hidden = view.dataset.view !== name;
  });
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));

  // One map, moved rather than duplicated: beside the routes on Vandaag, on its
  // own full screen under Kaart, where it opens on every open order.
  const panel = document.querySelector(".map-panel");
  const target = document.querySelector(name === "kaart" ? "#mapAway" : "#mapHome");
  if (panel && target && panel.parentElement !== target) target.appendChild(panel);
  if (name === "kaart") planningView = "all-orders";
  if (name === "vandaag") planningView = "map";
  if (name === "vandaag" || name === "kaart") renderPlanningOverview();
  if (name === "agenda") renderAgenda();
  if (name !== "agenda" && state.routeInHand) {
    state.routeInHand = null;
    renderRouteInHand();
  }
  window.scrollTo({ top: 0 });
}

function putRouteInHand(route, conceptId = null) {
  state.routeInHand = route;
  state.routeInHandConcept = conceptId;
  // One id for this route from the moment it is picked up: sent twice (a double
  // click, a retry), the backend knows it is the same route.
  state.routeInHandId = newId("rit");
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
  bar.innerHTML = `<p><strong>Kies een dag</strong> voor de rit naar ${escapeHtml(routeLabel(route))} (${route.orders.length} stops).</p>
    <button id="dropRouteInHand" class="button subtle-action" type="button">Annuleren</button>`;
  bar.querySelector("#dropRouteInHand").addEventListener("click", () => {
    state.routeInHand = null;
    renderRouteInHand();
    renderAgenda();
  });
}

async function placeRouteOnDay(date) {
  const route = state.routeInHand;
  if (!route || state.placing) return;
  state.placing = true;
  document.querySelectorAll(".place-here").forEach((button) => {
    button.disabled = true;
    button.textContent = "Bezig…";
  });
  const conceptId = state.routeInHandConcept || null;
  const result = await savePlan({
    id: state.routeInHandId,
    date,
    name: routeLabel(route),
    keys: route.orders.map(orderKey),
    tagKeys: route.orders.filter(needsOwnDeliveryTag).map(orderKey),
    conceptId,
  });
  state.placing = false;
  if (!result.route) {
    window.alert(result.error || "Inplannen is niet gelukt. Probeer het opnieuw.");
    renderAgenda();
    return;
  }
  state.routeInHand = null;
  state.routeInHandConcept = null;
  // A concept that is planned is a route now; an opened one closes. Orders
  // added to it meanwhile on another screen stay behind in the concept.
  if (conceptId && state.openConcept?.id === conceptId) {
    state.openConcept = null;
    state.manualRoute = null;
  }
  if (conceptId && result.conceptLeft?.length) {
    window.alert(`Ingepland. ${result.conceptLeft.map((key) => key.split(":").pop()).join(", ")} ${result.conceptLeft.length === 1 ? "kwam" : "kwamen"} er intussen bij en ${result.conceptLeft.length === 1 ? "staat" : "staan"} nog in het concept.`);
  }
  // A route of the planner's own making is planned now: it leaves Vandaag, and
  // its orders leave the selection, rather than stay with a live Inplannen.
  if (!conceptId && state.manualRoute && !state.openPlan) {
    route.orders.forEach((order) => state.selected.delete(orderKey(order)));
    state.manualRoute = null;
    activeMapRouteIndex = 0;
    renderSelectionBar();
  }
  state.plan = (await fetchPlan()) || state.plan;
  renderRouteInHand();
  rebuildPlanning();
}

function previousDay(isoDate) {
  const date = dateFromIso(isoDate);
  date.setDate(date.getDate() - 1);
  return isoDay(date);
}

// What the 16:00 announcement did for this route, or will do. The worker writes
// a report per day; before that the planner sees when it is due, and whether
// it is still the trial that sends nothing to customers.
function announceLine(planned) {
  if (planned.abortedAt) return "";
  const status = plannedRouteStatus(planned);
  const eerder = status.open.filter((order) => order.announced).length;
  const eerderTekst = eerder
    ? `<p class="agenda-announce laat">${eerder} ${eerder === 1 ? "order is" : "orders zijn"} al eerder aangekondigd: ${eerder === 1 ? "die klant krijgt" : "die klanten krijgen"} geen nieuwe mail. Laat ze zelf weten welke dag het wordt.</p>`
    : "";

  const log = state.announcements.find((entry) => entry.date === planned.date);
  const routeLog = log?.routes?.find((entry) => entry.id === planned.id);
  if (routeLog) {
    const telling = {};
    (routeLog.results || []).forEach((result) => {
      const soort = String(result.status || "").split(":")[0];
      telling[soort] = (telling[soort] || 0) + 1;
    });
    const tekst = Object.entries(telling).map(([soort, aantal]) => `${aantal} ${soort}`).join(", ") || "geen orders";
    const probleem = (routeLog.results || []).some((result) => /^(mislukt|onzeker)/.test(result.status || ""));
    const soort = log.mode === "echt" ? "Aangekondigd" : "Proef";
    return `<p class="agenda-announce ${probleem ? "fout" : log.mode === "echt" ? "echt" : "proef"}">${soort} ${formatDateTime(log.retriedAt || log.ranAt)}: ${escapeHtml(tekst)}${probleem ? ". Kijk in Shopify bij deze orders." : ""}</p>`;
  }
  const vandaag = isoDay(new Date());
  if (planned.date <= vandaag) return eerderTekst;
  const dagErvoor = previousDay(planned.date);
  const nu = new Date();
  if (dagErvoor === vandaag && nu.getHours() >= 16) {
    const zestienUur = new Date(nu);
    zestienUur.setHours(16, 0, 0, 0);
    const wasErOp = planned.assignedAt && new Date(planned.assignedAt) < zestienUur;
    if (!wasErOp) return `<p class="agenda-announce laat">Na 16:00 ingepland, dus niet aangekondigd.</p>${eerderTekst}`;
    if (nu.getHours() === 16 && nu.getMinutes() < 30) return `<p class="agenda-announce gepland">Aankondiging van 16:00 loopt; het verslag verschijnt hier zo.</p>${eerderTekst}`;
    return `<p class="agenda-announce fout">Geen verslag van de aankondiging van 16:00 gevonden. Kijk in Shopify of de klanten bericht kregen.</p>${eerderTekst}`;
  }
  return `<p class="agenda-announce gepland">Aankondiging ${formatDate(dagErvoor)} om 16:00${state.announceLive ? "" : " · proef, er gaat niets naar klanten"}</p>${eerderTekst}`;
}

function renderAgenda() {
  const holder = document.querySelector("#agendaDays");
  const teller = document.querySelector("#agendaCount");
  if (!holder) return;

  const vandaag = isoDay(new Date());
  const komend = state.plan.filter((planned) => planned.date >= vandaag && !planned.abortedAt);
  if (teller) {
    teller.textContent = komend.length;
    teller.hidden = !komend.length;
  }
  if (isEditing()) return;

  const dagen = [];
  for (let stap = 0; stap < 14; stap += 1) dagen.push(daysFromToday(stap));
  // A past route with stops still open was not (fully) driven: it stays in sight
  // until someone deals with it. Routes that were driven, or broken off with
  // their stops handed back, have nothing left to do here.
  const openVanEerder = (planned) => !planned.abortedAt && plannedRouteStatus(planned).open.length > 0;
  const achterstallig = [...new Set(state.plan.filter((planned) => planned.date < vandaag && openVanEerder(planned)).map((planned) => planned.date))].sort();
  const inHand = Boolean(state.routeInHand);

  holder.innerHTML = [...achterstallig, ...dagen].map((dag) => {
    const verleden = dag < vandaag;
    const ritten = state.plan.filter((planned) => planned.date === dag && (!verleden || openVanEerder(planned)));
    const naam = capitalize(new Intl.DateTimeFormat("nl-NL", { weekday: "long", day: "numeric", month: "long" }).format(dateFromIso(dag)));
    const label = dag === vandaag ? `${naam} · vandaag` : verleden ? `${naam} · niet (helemaal) gereden` : naam;
    const kiesbaar = inHand && !verleden;
    return `<article class="agenda-day${dag === vandaag ? " vandaag" : ""}${verleden ? " achterstallig" : ""}${ritten.length ? "" : " leeg"}${kiesbaar ? " kiesbaar" : ""}" data-day="${dag}">
      <h3>${label}</h3>
      ${dayNoteFor(dag) ? `<p class="agenda-day-note">${escapeHtml(dayNoteFor(dag))}</p>` : ""}
      ${verleden ? "" : `<div class="day-note-slot" data-day="${dag}"></div>`}
      ${kiesbaar ? `<button class="button primary place-here" type="button" data-day="${dag}"${state.placing ? " disabled" : ""}>Rit hier inplannen</button>` : ""}
      ${ritten.map((planned) => {
        const status = plannedRouteStatus(planned);
        const bezorgd = status.stops.filter((stop) => stop.status === "bezorgd").length;
        const anders = status.stops.length - status.open.length - bezorgd;
        const terug = (planned.droppedKeys || []).map((key) => escapeHtml(key.split(":").pop())).join(", ") || "geen";
        const afgebroken = planned.abortedAt
          ? `<p class="agenda-aborted">Afgebroken door ${escapeHtml(planned.abortedBy || "iemand")} om ${formatDateTime(planned.abortedAt)}${planned.abortReason ? `: ${escapeHtml(planned.abortReason)}` : ""}. ${(planned.droppedKeys || []).length} terug naar de planning: ${terug}.</p>`
          : "";
        const telling = planned.abortedAt
          ? `${bezorgd} bezorgd`
          : [`${status.open.length} ${status.open.length === 1 ? "stop" : "stops"} te gaan`, bezorgd ? `${bezorgd} bezorgd` : "", anders ? `${anders} geannuleerd of onbekend` : ""].filter(Boolean).join(" · ");
        return `<div class="agenda-route${planned.abortedAt ? " afgebroken" : ""}">
          <b><span class="rit-nummer">Rit ${escapeHtml(planned.number || "?")}</span> ${escapeHtml(planned.name)}</b>
          <span>${telling}</span>
          ${planned.note ? `<p class="agenda-note">${escapeHtml(planned.note)}</p>` : ""}
          ${announceLine(planned)}
          ${afgebroken}
          ${planned.abortedAt || verleden ? "" : `<div class="note-slot" data-planned="${escapeHtml(planned.id)}"></div>`}
          ${planned.abortedAt ? "" : `<div class="agenda-route-actions">
            <button class="button primary open-planned" type="button" data-planned="${escapeHtml(planned.id)}">Rit openen</button>
            <button class="button subtle-action drop-planned" type="button" data-planned="${escapeHtml(planned.id)}">Uit agenda</button>
          </div>`}
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
  holder.querySelectorAll(".note-slot").forEach((slot) => {
    const planned = state.plan.find((entry) => entry.id === slot.dataset.planned);
    if (planned) slot.appendChild(noteEditor({ label: "Opmerking voor de bezorger", value: planned.note || "", onSave: (note) => saveRouteNote(planned, note) }));
  });
  holder.querySelectorAll(".day-note-slot").forEach((slot) => {
    const dag = slot.dataset.day;
    slot.appendChild(noteEditor({ label: "Opmerking bij deze dag", value: dayNoteFor(dag), onSave: (note) => saveDayNote(dag, note) }));
  });
}

// Opening a planned route is the moment it is checked: fetch first, so what is
// judged is what Shopify says now and not what this phone had this morning.
async function openPlannedRoute(planned) {
  if (!planned) return;
  state.openPlan = planned;
  state.openConcept = null;
  state.manualRoute = null;
  await refreshData();
  applyOpenPlan();
  showView("vandaag");
}

// The planned route drives the screen through manualRoute and nothing else. It
// used to be pushed into forcedIncludes as well, which left every order ever
// opened this way stuck on "Meenemen" on that phone for good.
function applyOpenPlan() {
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
  if (!planned || state.role === "driver") {
    holder.hidden = true;
    holder.innerHTML = "";
    return;
  }

  const status = plannedRouteStatus(planned);
  const bijzonder = status.stops.filter((stop) => stop.status !== "open");
  const erbij = state.lastFetchOk ? nearbyAdditions(status.open) : [];
  const huidig = status.open.length ? routeSummary("Rit", status.open) : null;

  holder.hidden = false;
  holder.innerHTML = `
    <div class="panel-heading compact">
      <div>
        <h2><span class="rit-nummer">Rit ${escapeHtml(planned.number || "?")}</span> ${escapeHtml(planned.name)}</h2>
        <p class="open-plan-meta">${formatDate(planned.date)} · ${status.open.length} ${status.open.length === 1 ? "stop" : "stops"}${huidig ? ` · ongeveer ${formatMinutes(huidig.totalMinutes)} onderweg` : ""}</p>
      </div>
      <button id="closeOpenPlan" class="button subtle-action" type="button">Sluiten</button>
    </div>
    <p class="open-plan-hint">Wat je hier verandert, wordt meteen opgeslagen en ziet de bezorger ook: een stop eruit met − bij de rit, een order erbij met Meenemen hieronder.</p>
    ${state.lastFetchOk ? "" : '<p class="plan-offline">Geen verbinding. Je ziet de rit zoals hij bij het laatste verversen was; of er iets bij kan, valt nu niet na te gaan.</p>'}
    ${bijzonder.length ? `<ul class="plan-stops">${bijzonder.map(stopStatusLine).join("")}</ul>` : ""}
    ${state.lastFetchOk ? `<div class="plan-additions">
      <h3>${erbij.length ? "Kan er makkelijk bij" : "Niets dat er makkelijk bij kan"}</h3>
      ${erbij.map((kandidaat) => {
        const o = kandidaat.item.order;
        return `<div class="plan-addition">
          <div>
            <b>${escapeHtml(o.id)} · ${escapeHtml(o.city || "plaats onbekend")}</b>
            <span>${productSummary(o)}</span>
            <span>+${formatMinutes(kandidaat.extra)}, rit wordt dan ${formatMinutes(kandidaat.totaal)}${needsOwnDeliveryTag(o) ? " · krijgt in Shopify de tag eigen bezorging" : ""}</span>
          </div>
          <button class="button primary accept-addition" type="button" data-key="${orderKey(o)}">Meenemen</button>
        </div>`;
      }).join("")}
    </div>` : ""}`;

  holder.querySelector("#closeOpenPlan").addEventListener("click", closeOpenPlan);
  holder.querySelectorAll(".accept-addition").forEach((button) => {
    const kandidaat = erbij.find((k) => orderKey(k.item.order) === button.dataset.key);
    button.addEventListener("click", () => acceptAddition(kandidaat, button));
  });
}

function renderManualRouteBar() {
  const bar = document.querySelector("#manualRouteBar");
  if (bar) bar.hidden = !state.manualRoute || Boolean(state.openPlan) || Boolean(state.openConcept);
  renderConceptBar();
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
  const routes = allRoutes();
  if (!routes.length) {
    holder.innerHTML = '<p class="empty">Nog geen rit om op Google Maps te tonen.</p>';
    return;
  }
  activeMapRouteIndex = Math.min(activeMapRouteIndex, routes.length - 1);
  const route = routes[activeMapRouteIndex];
  const routeButtons = routes.map((item, index) => `<button class="${index === activeMapRouteIndex ? "active" : ""}" type="button" data-route-index="${index}">
    ${escapeHtml(routeTitle(item, index))}: ${escapeHtml(routeLabel(item))} · ${formatMinutes(item.totalMinutes)}
  </button>`).join("");
  const stops = route.orders.map((order, index) => `<li>
    <div>
      <b>${index + 1}. ${escapeHtml(order.city || "Plaats onbekend")} · ${escapeHtml(order.id)}</b>
      <span>${productSummary(order)}</span>
      <small>${addressSummary(order)}</small>
    </div>
    <button class="button subtle-action remove-from-active-route" type="button" data-order-key="${orderKey(order)}">Uit rit halen</button>
  </li>`).join("");
  // Adding from this list builds a route of the planner's own. On an opened
  // planned route that would change the screen and not the saved route, so
  // there the panel above, which saves, is the way to add.
  const routeKeys = new Set(route.orders.map(orderKey));
  const addableOrders = state.openPlan ? [] : state.decisions
    .filter((item) => !routeKeys.has(orderKey(item.order)) && !["exclude", "planned", "concept"].includes(item.decision))
    .filter((item) => !CONFIG.ritregelsV3 || hasKnownPoint(item.order))
    .map((item) => item.order)
    .map((order) => {
      const nextRoute = routeSummary(route.region, optimizedStopOrder([...route.orders, order]));
      return { order, extraMinutes: Math.max(0, nextRoute.totalMinutes - route.totalMinutes), routeWouldBeMinutes: nextRoute.totalMinutes };
    })
    .sort((a, b) => a.extraMinutes - b.extraMinutes)
    .slice(0, 6);
  const addableList = addableOrders.length
    ? `<div class="route-add-box compact-add">
        <label><span>Toevoegen aan deze rit</span><select id="addToRouteSelect">
          ${addableOrders.map(({ order, extraMinutes, routeWouldBeMinutes }) => `<option value="${orderKey(order)}">${escapeHtml(order.id)} · ${escapeHtml(order.city || "Plaats onbekend")} · +${extraMinutes} min · rit ${formatMinutes(routeWouldBeMinutes)}</option>`).join("")}
        </select></label>
        <button class="button manual-action add-to-active-route" type="button">Toevoegen aan rit</button>
      </div>`
    : "";

  // The map itself stays put while its route is the same: rebuilding it on
  // every refresh threw away the planner's zoom every two minutes.
  const src = googleMapsEmbedUrl(route.orders);
  if (holder.querySelector(".google-map-card iframe")?.getAttribute("src") !== src) {
    holder.innerHTML = `<div class="google-map-card"><iframe title="Google Maps route" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${src}"></iframe></div><div class="map-side"></div>`;
  }
  holder.querySelector(".google-map-card iframe").title = `Google Maps route ${routeLabel(route)}`;
  holder.querySelector(".map-side").innerHTML = `
    <div class="map-route-picker">${routeButtons}</div>
    <div class="map-route-summary">
      <b>${escapeHtml(routeTitle(route, activeMapRouteIndex))}: ${escapeHtml(routeLabel(route))}</b>
      <span>${route.orders.length} stops · rijden ${formatMinutes(route.driveMinutes)} · afleveren ${formatMinutes(route.deliveryMinutes)} · totaal ${formatMinutes(route.totalMinutes)}</span>
      <a class="button ghost" href="${googleMapsUrl(route.orders)}" target="_blank" rel="noreferrer">Open groot in Google Maps</a>
    </div>
    ${addableList}
    <ol class="map-order-list">${stops}</ol>`;
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
    .filter((item) => !CONFIG.ritregelsV3 || hasKnownPoint(item.order));
  if (!openOrders.length) {
    holder.innerHTML = '<p class="empty">Geen open orders om op de kaart te tonen.</p>';
    return;
  }
  if (!holder.querySelector("#allOrdersMap")) {
    allOrdersLeafletMap?.remove();
    allOrdersLeafletMap = null;
    holder.innerHTML = `<div id="allOrdersMap" class="real-orders-map" aria-label="Kaart met open orders"></div><div class="map-side"></div>`;
  }
  holder.querySelector(".map-side").innerHTML = `
    <div class="map-route-summary">
      <b>Alle open orders op de kaart</b>
      <span>${openOrders.length} punten. Tik op een punt, of wijs het aan, voor de bestelling.</span>
      <a class="button ghost" href="${googleMapsUrl(openOrders.map((item) => item.order))}" target="_blank" rel="noreferrer">Open alle orders in Google Maps</a>
    </div>
    <div class="map-legend">
      <span><i class="map-dot include"></i> Meenemen</span>
      <span><i class="map-dot planned"></i> Ingepland</span>
      <span><i class="map-dot concept"></i> In concept</span>
      <span><i class="map-dot review"></i> Controleren</span>
      <span><i class="map-dot dhl"></i> DHL</span>
      <span><i class="map-dot far"></i> Te ver</span>
      <span><i class="map-dot exclude"></i> Niet meenemen</span>
    </div>`;
  renderLeafletOrderMap(openOrders);
}

// One map for as long as its screen is up; a refresh only swaps the markers.
// Made anew each time, it jumped back to the whole country every two minutes.
function renderLeafletOrderMap(items) {
  const mapElement = document.querySelector("#allOrdersMap");
  if (!mapElement) return;
  if (!window.L) {
    mapElement.innerHTML = '<p class="empty">Kaart wordt geladen. Ververs als hij niet verschijnt.</p>';
    return;
  }
  if (!allOrdersLeafletMap) {
    allOrdersLeafletMap = L.map(mapElement, { scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap",
    }).addTo(allOrdersLeafletMap);
    allOrdersMarkers = L.layerGroup().addTo(allOrdersLeafletMap);
    allOrdersFitted = false;
  }
  allOrdersMarkers.clearLayers();

  const markerPoints = [[DEPOT_POINT.lat, DEPOT_POINT.lon]];
  L.circleMarker([DEPOT_POINT.lat, DEPOT_POINT.lon], {
    radius: 7,
    color: "#ffffff",
    weight: 2,
    fillColor: "#0d3029",
    fillOpacity: 1,
  }).addTo(allOrdersMarkers).bindTooltip("Goorsteeg 46, Ede");

  items.forEach(({ order, decision }) => {
    const point = orderPoint(order);
    markerPoints.push([point.lat, point.lon]);
    L.circleMarker([point.lat, point.lon], {
      radius: 7,
      color: "#ffffff",
      weight: 2,
      fillColor: markerColor(decision),
      fillOpacity: 1,
    }).addTo(allOrdersMarkers).bindTooltip(orderTooltip(order), {
      direction: "top",
      opacity: 1,
      sticky: true,
    });
  });

  if (!allOrdersFitted) {
    allOrdersLeafletMap.fitBounds(markerPoints, { padding: [32, 32], maxZoom: 8 });
    allOrdersFitted = true;
  }
  setTimeout(() => allOrdersLeafletMap?.invalidateSize(), 0);
}

function markerColor(decision) {
  if (decision === "include") return "#168a54";
  if (decision === "planned") return "#1f6f78";
  if (decision === "concept") return "#7a5c2e";
  if (decision === "review") return "#c7810c";
  if (decision === "dhl") return "#2f6fb3";
  if (decision === "far") return "#6b5b95";
  return "#b94a3f";
}

function orderTooltip(order) {
  return `<div class="map-tooltip-content">
    <b>${escapeHtml(order.id)} · ${escapeHtml(order.customer || "Onbekende klant")}</b>
    <span>${productSummary(order)}</span>
    <span>${addressSummary(order)}</span>
    <small>${escapeHtml(order.paymentStatus || (order.paid ? "Betaald" : "In afwachting"))} · uiterlijk ${formatDate(order.dueDate)}</small>
  </div>`;
}

function renderRoutesOverview() {
  const holder = document.querySelector("#routesOverview");
  if (!holder) return;
  const routes = allRoutes();
  if (!routes.length) {
    holder.innerHTML = '<p class="empty">Nog geen ritten om te tonen.</p>';
    return;
  }
  holder.innerHTML = routes.map((route, index) => `<article class="route-overview-card${route.review ? " review" : ""}">
    <div><b>${escapeHtml(routeTitle(route, index))}: ${escapeHtml(routeLabel(route))}</b><span>${route.orders.length} stops · rijden ${formatMinutes(route.driveMinutes)} · afleveren ${formatMinutes(route.deliveryMinutes)} · totaal ${formatMinutes(route.totalMinutes)}</span></div>
    <ol>${route.orders.map((order) => `<li>${escapeHtml(order.city || "Plaats onbekend")} · ${escapeHtml(order.id)} · ${productSummary(order)}</li>`).join("")}</ol>
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
  const urgent = new Set(urgentDecisions());
  const visible = state.decisions.filter((item) => {
    const haystack = [item.order.id, item.order.webshop, item.order.customer, item.order.city, item.order.postcode, (item.order.products || []).join(" ")].join(" ").toLowerCase();
    const matches = filter === "all" || (filter === "urgent" ? urgent.has(item) : item.decision === filter);
    return (!term || haystack.includes(term)) && matches;
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
    ["include", "Meenemen", "Gaan met de bus en staan nog niet in de agenda"],
    ["planned", "Ingepland", "Staan al in een rit in de agenda"],
    ["concept", "In concept", "Staan in een concept dat nog geen dag heeft"],
    ["review", "Controleren", "Betaling, afspraak, adres of net boven het budget: jij beslist"],
    ["dhl", "DHL", "Niet in de vaste eigen-bezorgingslijst en geen XXL bak, of een XXL bak die te ver ligt"],
    ["far", "Te ver voor eigen vervoer", "Rijplaten buiten het bereik die op geen enkele rit passen"],
    ["exclude", "Niet meenemen", "Geannuleerd, terugbetaald, afgehaald of al verzonden"],
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
  const planned = item.decision === "planned" ? item.planned : null;
  const held = item.decision === "concept";
  return `<article class="order-card">
    <div class="order-main">
      <div class="order-title-row">
        <label class="select-order"><input class="order-select" type="checkbox" data-order-key="${key}" ${state.selected.has(key) ? "checked" : ""}${planned || held ? " disabled" : ""} /><span>Selecteer</span></label>
        <span class="shop-chip ${businessClass(order)}">${businessLogo(order)}</span>
        <span class="badge ${item.decision}">${decisionLabels[item.decision]}</span>
        ${planned ? `<span class="badge-planned"><span class="rit-nummer">Rit ${escapeHtml(planned.number || "?")}</span> ${formatDate(planned.date)}</span>` : ""}
        ${held && item.concept ? `<span class="badge-planned">Concept: ${escapeHtml(item.concept.name)}</span>` : ""}
      </div>
      <h3>${escapeHtml(order.id)} · ${escapeHtml(order.customer)}${order.announced ? '<span class="badge-announced">aangekondigd</span>' : ""}</h3>
      <p class="product-line">${productSummary(order)}</p>
      <p class="address-line">${addressSummary(order)}</p>
      <p class="reason">${escapeHtml(item.reason)}</p>
    </div>
    <div class="order-side">
      <span><b>Uiterlijk</b>${formatDate(order.dueDate)}</span>
      <span><b>Betaling</b>${escapeHtml(order.paymentStatus || (order.paid ? "Betaald" : "In afwachting"))}</span>
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
  if (item.decision === "planned" || item.decision === "concept") return "";
  if (item.order.cancelled || item.order.fulfilled || item.order.refunded || item.order.deliveryMethod === "pickup") return "";
  if (isForced) return `<button class="button subtle-action clear-force-include" type="button" data-order-key="${key}">Automatisch advies</button>`;
  if (item.decision === "include") return "";
  return `<button class="button manual-action force-include" type="button" data-order-key="${key}">Toch zelf bezorgen</button>`;
}

function renderRoutes() {
  const holder = document.querySelector("#routes");
  const template = document.querySelector("#routeTemplate");
  renderSuggestions();
  holder.innerHTML = "";
  const routes = allRoutes();
  if (!routes.length) {
    holder.innerHTML = state.openPlan
      ? '<p class="empty">Alle stops van deze rit zijn afgehandeld.</p>'
      : '<p class="empty">Geen nieuwe orders voor een rit. Wat al ingepland is, staat in de Agenda.</p>';
    return;
  }
  routes.forEach((route, index) => {
    const fragment = template.content.cloneNode(true);
    const card = fragment.querySelector(".route-card");
    if (route.review) card.classList.add("review");
    fragment.querySelector(".route-number").textContent = state.openPlan ? String(state.openPlan.number || "?") : state.manualRoute ? "✓" : routeLetter(index);
    fragment.querySelector(".route-name").textContent = `${routeTitle(route, index)} · ${routeLabel(route)}`;
    fragment.querySelector(".route-meta").textContent = `${CONFIG.depot} · ${route.orders.length} ${route.orders.length === 1 ? "stop" : "stops"} · rijtijd ${formatMinutes(route.driveMinutes)}`;
    fragment.querySelector(".route-load").textContent = [
      route.loadKnown ? `${route.load.toLocaleString("nl-NL")} kg` : "",
      `afleveren ${formatMinutes(route.deliveryMinutes)}`,
      `totaal ${formatMinutes(route.totalMinutes)}`,
      route.review ? "net boven het budget, zelf beoordelen" : routeWarning(route),
    ].filter(Boolean).join(" · ");
    fragment.querySelector(".route-map").href = googleMapsUrl(route.orders);
    if (!state.openPlan && state.role !== "driver") {
      if (!state.openConcept) {
        const conceptKnop = document.createElement("button");
        conceptKnop.type = "button";
        conceptKnop.className = "button subtle-action save-concept";
        conceptKnop.textContent = "Opslaan als concept";
        conceptKnop.addEventListener("click", () => saveRouteAsConcept(route, conceptKnop));
        fragment.querySelector(".route-footer").appendChild(conceptKnop);
      }
      const planKnop = document.createElement("button");
      planKnop.type = "button";
      planKnop.className = "button primary plan-route";
      planKnop.textContent = "Inplannen";
      planKnop.addEventListener("click", () => putRouteInHand(route, state.openConcept?.id || null));
      fragment.querySelector(".route-footer").appendChild(planKnop);
    }
    // Buttons carry shop and number together: the number alone is only unique
    // for as long as the two shops keep different prefixes.
    fragment.querySelector(".route-stops").innerHTML = route.orders.map((order) => `<li><button class="remove-route-stop" type="button" data-order-key="${orderKey(order)}" aria-label="${escapeHtml(order.id)} uit deze rit halen">−</button><b>${escapeHtml(order.city)} · ${escapeHtml(order.id)}</b><span>${productSummary(order)} · ${deliveryMinutes(order)} min lossen/laden</span><span>${addressSummary(order)} · <a href="${singleOrderMapsUrl(order)}" target="_blank" rel="noreferrer">Maps</a> <button class="mark-delivered" type="button" data-order-key="${orderKey(order)}">Bezorgd</button></span></li>`).join("");
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

// Orders that fit with a route the planner is putting together by hand. Only
// then: against all proposals at once the minutes it showed were for a route
// that did not exist, and "Voeg toe" did something else than it said.
function renderSuggestions() {
  const holder = document.querySelector("#suggestions");
  if (!holder) return;
  const suggestions = nearbySuggestions();
  state.suggestions = suggestions;
  if (!suggestions.length) {
    holder.innerHTML = "";
    return;
  }
  holder.innerHTML = `<div class="suggestion-box"><b>Kan er makkelijk bij</b><p>Deze orders liggen bij de rit die je samenstelt.</p>${suggestions.map(({ order, extraMinutes, routeWouldBeMinutes }) => `
    <article>
      <span>${escapeHtml(order.id)} · ${escapeHtml(order.city)}</span>
      <small>${productSummary(order)}</small>
      <em>+${extraMinutes} min · rit wordt ${formatMinutes(routeWouldBeMinutes)}</em>
      <button class="button subtle-action add-suggestion" type="button" data-order-key="${orderKey(order)}">Voeg toe</button>
    </article>`).join("")}</div>`;
  holder.querySelectorAll(".add-suggestion").forEach((button) => {
    const order = state.orders.find((item) => orderKey(item) === button.dataset.orderKey);
    button.addEventListener("click", () => addOrderToRoute(order, 0));
  });
}

function nearbySuggestions() {
  if (!state.manualRoute || state.openPlan) return [];
  const routeOrders = manualRouteOrders();
  if (!routeOrders.length) return [];
  const routeKeys = new Set(routeOrders.map(orderKey));
  const currentRouteMinutes = routeSummary("rit", optimizedStopOrder(routeOrders)).totalMinutes;
  return state.decisions
    .filter((item) => suggestionCandidate(item, routeKeys))
    .map((item) => {
      const nextRoute = routeSummary("rit", optimizedStopOrder([...routeOrders, item.order]));
      return { order: item.order, extraMinutes: Math.max(0, nextRoute.totalMinutes - currentRouteMinutes), routeWouldBeMinutes: nextRoute.totalMinutes };
    })
    .filter((entry) => entry.extraMinutes <= 120 && entry.routeWouldBeMinutes <= CONFIG.maxRouteMinutes + CONFIG.nearlyOverMinutes)
    .sort((a, b) => a.extraMinutes - b.extraMinutes)
    .slice(0, 3);
}

function suggestionCandidate(item, routeKeys) {
  const order = item.order;
  if (routeKeys.has(orderKey(order)) || state.manualRoute?.removed?.has(orderKey(order))) return false;
  if (["exclude", "planned", "concept"].includes(item.decision)) return false;
  if (!order.addressComplete || !order.paid || order.deliveryAppointmentLocked) return false;
  return !CONFIG.ritregelsV3 || hasKnownPoint(order);
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

// Where an order is: the point the backend sent (the driver's phone gets no
// addresses), else the real point from PDOK, else the rough estimate.
function orderPoint(order) {
  if (order.point) return order.point;
  const known = state.geo[orderAddress(order)];
  if (known) return known;
  return estimatedPoint(order) || DEPOT_POINT;
}

function estimatedPoint(order) {
  const postcode = String(order.postcode || "").replace(/\s+/g, "").toUpperCase();
  const country = countryName(order);
  const number = Number((postcode.match(/\d+/) || [0])[0]);
  if (CONFIG.ritregelsV3) {
    // Only a Dutch or Belgian postcode says where an order is. A German or Czech
    // one used to land on the depot itself: 0:20 to Velké Březno.
    if (country === "BE") return /^\d{4}$/.test(postcode) ? belgiumPoint(number, order) : null;
    if ((country === "NL" || !country) && /^\d{4}([A-Z]{2})?$/.test(postcode) && number >= 1000) return netherlandsPoint(number, order);
    return null;
  }
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

// A route of the planner's own choosing, shown on its own until "Toon weer alle
// ritten". It lives on this screen only: nothing is remembered or tagged until
// it is planned, so trying something out leaves no trace.
function makeRouteFromSelection() {
  const orders = selectedOrdersList().filter((order) => !plannedFor(order) && !conceptFor(order));
  if (!orders.length) return;
  state.openPlan = null;
  state.openConcept = null;
  state.manualRoute = { keys: orders.map(orderKey), removed: new Set() };
  activeMapRouteIndex = 0;
  showView("vandaag");
  rebuildPlanning();
}

// The chosen route plus one order, as a route of the planner's own, or saved
// into the concept that is open. The route is taken by its stops, not by its
// place in the list: the list is rebuilt, and a place can then hold another route.
async function addOrderToRoute(order, routeIndex) {
  const route = allRoutes()[routeIndex];
  if (!order || !route || state.openPlan) return;
  const key = orderKey(order);
  const keys = [...route.orders.map(orderKey).filter((entry) => entry !== key), key];
  if (state.openConcept) {
    await saveOpenConcept((saved) => [...saved.filter((entry) => entry !== key), key]);
    rebuildPlanning();
    return;
  }
  const removed = new Set(state.manualRoute?.removed || []);
  removed.delete(key);
  state.manualRoute = { keys, removed };
  activeMapRouteIndex = 0;
  planningView = "map";
  rebuildPlanning();
}

async function removeOrderFromRoute(key, routeIndex) {
  // On an opened planned route a stop comes out of the saved route itself.
  if (state.openPlan) {
    removePlannedStop(key);
    return;
  }
  const route = allRoutes()[routeIndex];
  if (!key || !route) return;
  const stop = route.orders.find((order) => orderKey(order) === key);
  if (!stop) return;
  const keys = route.orders.map(orderKey).filter((entry) => entry !== key);
  if (state.openConcept) {
    if (state.conceptSaving) return;
    if (!state.openConcept.orderKeys.some((entry) => entry !== key)) {
      if (window.confirm(`${stop.id} is de laatste stop. Het concept verwijderen? De order komt terug in de planning.`)) await removeConcept(state.openConcept, { ask: false });
      return;
    }
    const removed = new Set(state.manualRoute?.removed || []);
    removed.add(key);
    if (await saveOpenConcept((saved) => saved.filter((entry) => entry !== key))) state.manualRoute = { ...(state.manualRoute || {}), removed, concept: true };
    rebuildPlanning();
    return;
  }
  if (!state.manualRoute && !window.confirm(`${stop.id} uit deze rit halen? Je ziet dan alleen deze rit; met "Toon weer alle ritten" komen de andere voorstellen terug.`)) return;
  // Remembered, so a parcel taken out is not slipped straight back in.
  const removed = new Set(state.manualRoute?.removed || []);
  removed.add(key);
  state.manualRoute = keys.length ? { keys, removed } : null;
  activeMapRouteIndex = 0;
  planningView = "map";
  rebuildPlanning();
}

// Every selected order is tried. What failed stays selected and is named; the
// rest is reported. It used to stop at the first failure and clear the selection,
// so the orders after it were silently never reported.
async function markSelectedDelivered() {
  const orders = selectedOrdersList();
  if (!orders.length) return;
  if (!ensureOperatorKey()) return;
  if (!window.confirm(`${orders.length} geselecteerde orders als bezorgd melden?`)) return;
  const button = document.querySelector("#markSelectedDeliveredButton");
  if (button) button.disabled = true;

  const failed = [];
  let done = 0;
  for (const order of orders) {
    let response = null;
    try {
      response = await backendFetch(`${CONFIG.apiBaseUrl}/actions/mark-delivered`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: order.id, shopDomain: order.shopDomain, shopifyOrderId: order.shopifyOrderId }),
      });
    } catch {
      response = null;
    }
    if (response?.ok) {
      done += 1;
      state.selected.delete(orderKey(order));
    } else {
      failed.push(`${order.id}: ${response ? await errorText(response, "niet gelukt") : "geen verbinding"}`);
    }
  }
  if (button) button.disabled = false;
  if (failed.length) window.alert(`${done} gemeld als bezorgd. Niet gelukt:\n${failed.join("\n")}\n\nDie staan nog geselecteerd.`);
  if (!state.selected.size) state.manualRoute = null;
  await refreshData();
}

function renderHistory() {
  const holder = document.querySelector("#history");
  if (!holder) return;

  const counter = document.querySelector("#historyCount");
  if (counter) counter.textContent = state.history.length ? `${state.history.length} bezorgd` : "leeg";

  if (!state.history.length) {
    holder.innerHTML = `<p class="empty">${state.historyLoaded ? "Nog geen bezorgde orders in de historie." : "De historie is nog niet geladen."}</p>`;
    return;
  }
  // A parcel that never went with the van is kept without a name: its place
  // stands in for it.
  holder.innerHTML = state.history.map((item) => `<article class="history-item">
    <div><b>${escapeHtml(item.id)}</b><span>${escapeHtml(item.order?.customer || item.order?.city || "Onbekend")} · ${escapeHtml(item.order?.webshop || item.shopDomain)}</span><small>${historySourceLabel(item)}: ${formatDateTime(item.deliveredAt)}</small></div>
    ${item.fulfillment?.id
      ? `<button class="button ghost undo-delivered" type="button" data-order-id="${encodeURIComponent(item.id)}" data-shop-domain="${encodeURIComponent(item.shopDomain)}">Terugdraaien</button>`
      : '<small class="history-note">Terugdraaien kan alleen in Shopify</small>'}
  </article>`).join("");
  holder.querySelectorAll(".undo-delivered").forEach((button) => {
    button.addEventListener("click", () => undoDelivered(decodeURIComponent(button.dataset.orderId), decodeURIComponent(button.dataset.shopDomain), button));
  });
}

function historySourceLabel(item) {
  if (item.source === "shopify") return "In Shopify verzonden";
  if (item.source === "bezorger") return "Bezorgd gemeld door de bezorger";
  return "Bezorgd gemeld";
}

function googleMapsUrl(orders) {
  const stops = [CONFIG.depot, ...orders.map((order) => order.fullAddress || `${escapeHtml(order.postcode)} ${escapeHtml(order.city)}`), CONFIG.depot];
  return `https://www.google.com/maps/dir/${stops.map((stop) => encodeURIComponent(stop)).join("/")}`;
}

function googleMapsEmbedUrl(orders) {
  const stops = [CONFIG.depot, ...orders.map((order) => order.fullAddress || `${escapeHtml(order.postcode)} ${escapeHtml(order.city)}`), CONFIG.depot];
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

// For HTML only, so escaped here. Links use mapsAddress, which stays raw
// because URL encoding takes care of it there.
function addressSummary(order) {
  return escapeHtml(mapsAddress(order) || "Adres onbekend");
}

function mapsAddress(order) {
  return order.fullAddress
    || [order.addressLine, [order.postcode, order.city].filter(Boolean).join(" "), order.country || "Nederland"].filter(Boolean).join(", ")
    || [order.postcode, order.city, "Nederland"].filter(Boolean).join(", ");
}

function productSummary(order) {
  const products = Array.isArray(order.products) ? order.products.filter(Boolean) : [];
  return escapeHtml(products.length ? products.join(", ") : "Product onbekend");
}

function businessClass(order) {
  return businessClasses[order.webshop] || "";
}

function businessLogo(order) {
  const label = escapeHtml(order.webshop || "Webshop");
  const logo = businessLogos[order.webshop];
  return logo ? `<img src="${logo}" alt="${label}" />` : `<span>${label}</span>`;
}

function orderKey(order) {
  return `${escapeHtml(order.shopDomain || "")}:${escapeHtml(order.id)}`;
}

function saveForcedIncludes() {
  try {
    localStorage.setItem(forcedIncludeKey, JSON.stringify([...forcedIncludes]));
  } catch {
    // Kept for this visit only.
  }
}

// "Toch zelf bezorgen". A parcel or XXL bak is tagged as own delivery in
// Shopify, so the DHL pile leaves it alone; rijplaten go by van anyway.
async function forceInclude(order) {
  if (!order) return false;
  if (!ensureOperatorKey()) return false;
  const tag = needsOwnDeliveryTag(order);
  if (!window.confirm(tag
    ? `${order.id} toch zelf bezorgen? Hij krijgt in Shopify de tag 'eigen bezorging', zodat hij niet ook met DHL meegaat.`
    : `${order.id} toch zelf bezorgen?`)) return false;
  if (tag) {
    let response = null;
    try {
      response = await backendFetch(`${CONFIG.apiBaseUrl}/actions/set-own-delivery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: order.id, shopDomain: order.shopDomain, shopifyOrderId: order.shopifyOrderId }),
      });
    } catch {
      response = null;
    }
    if (!response?.ok) {
      window.alert(response ? await errorText(response, "Shopify tag toevoegen is niet gelukt.") : "Geen verbinding. Probeer het opnieuw.");
      return false;
    }
  }
  forcedIncludes.add(orderKey(order));
  saveForcedIncludes();
  await refreshData();
  return true;
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
  for (const [region, candidates] of byRegion) applyPool(region, candidates, evaluatePool(candidates));
  if (CONFIG.ritregelsV3) poolAcrossSectorLines();
}

// A parcel that happens to sit next to a planned route is cheaper to drop off
// than to ship, so it joins the route the trip grows least by. Parcels never
// start a route: without one nearby they stay with DHL. Routes update as each
// parcel joins, so the next one is measured against what the van really drives.
function addNearbyPackages() {
  // A planned route that is open belongs to the driver: parcels are offered to
  // them one by one and saved when accepted. Slipping them in here would put
  // them on screen but in neither the saved route nor Shopify.
  if (state.openPlan || state.openConcept) return;
  const removed = state.manualRoute?.removed || new Set();
  const parcels = state.decisions.filter((entry) => entry.decision === "dhl" || entry.taggedParcel);
  for (const item of parcels) {
    const order = item.order;
    if (!order.addressComplete || !order.paid || order.deliveryAppointmentLocked) continue;
    // Taken out of this route by the planner: it stays out.
    if (removed.has(orderKey(order))) continue;
    if (CONFIG.ritregelsV3 && !hasKnownPoint(order)) continue;

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
    item.parcel = true;
    item.reason = `Pakketorder, maar de rit naar ${routeLabel(best.merged)} wordt er maar ${formatMinutes(best.grows)} langer van; goedkoper zelf meenemen. ${dueDateReason(order)}`;
  }
}

function rebuildPlanning() {
  stopOrderCache = new Map();
  syncOpenPlan();
  syncOpenConcept();
  state.decisions = state.orders.map((order) => {
    // Already in a route: planned, and out of the weighing, so it is neither
    // offered as a new route nor lends its budget to one.
    const planned = plannedFor(order);
    if (planned) return { order, decision: "planned", planned, reason: plannedReason(planned) };
    // Held by a concept: the same, until the concept is planned or removed.
    const concept = conceptFor(order);
    if (concept) return { order, decision: "concept", concept, reason: `In het concept ${concept.name}` };
    if (state.heldKeys.has(orderKey(order))) return { order, decision: "concept", reason: "In een concept van de planner" };
    return { order, ...applyManualDecision(order, decide(order)) };
  });
  qualifyCandidates();
  offerPlannedRoutes();
  state.routes = buildRoutes(state.decisions.filter((item) => item.decision === "include"));
  // A group just over its budget is still a route to consider, shown apart so
  // the planner can plan it with one click or take an order out first.
  state.reviewRoutes = CONFIG.ritregelsV3 && !state.manualRoute && !state.openPlan
    ? buildRoutes(state.decisions.filter((item) => item.decision === "review" && item.poolReview)).map((route) => ({ ...route, review: true }))
    : [];
  addNearbyPackages();
  renderSummary();
  renderConcepts();
  renderAgenda();
  renderOpenPlan();
  renderDriver();
  renderRules();
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
  if (!order) return;
  if (!ensureOperatorKey()) return;
  if (!window.confirm(`${order.id} als bezorgd melden?`)) return;
  const reset = () => {
    button.disabled = false;
    button.textContent = "Bezorgd";
  };
  button.disabled = true;
  button.textContent = "Bezig…";
  let response = null;
  try {
    response = await backendFetch(`${CONFIG.apiBaseUrl}/actions/mark-delivered`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: order.id, shopDomain: order.shopDomain, shopifyOrderId: order.shopifyOrderId }),
    });
  } catch {
    response = null;
  }
  if (!response) {
    window.alert("Bezorgd melden is niet gelukt: geen verbinding. Probeer het opnieuw als je bereik hebt; twee keer melden kan geen kwaad.");
    reset();
    return;
  }
  if (!response.ok) {
    window.alert(await errorText(response, "Bezorgd melden is niet gelukt. Probeer het opnieuw."));
    reset();
    // Cancelled, refunded or no longer open: show the stop as it now stands.
    if ([404, 409].includes(response.status)) await refreshData();
    return;
  }
  await refreshData();
}

async function undoDelivered(id, shopDomain, button) {
  if (!ensureOperatorKey()) return;
  if (!window.confirm(`${id} terugzetten naar open? De verzending in Shopify wordt dan geannuleerd.`)) return;
  button.disabled = true;
  button.textContent = "Bezig…";
  let response = null;
  try {
    response = await backendFetch(`${CONFIG.apiBaseUrl}/actions/undo-delivered`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, shopDomain }),
    });
  } catch {
    response = null;
  }
  if (!response?.ok) {
    window.alert(response ? await errorText(response, "Terugdraaien is niet gelukt.") : "Geen verbinding. Probeer het opnieuw.");
    button.disabled = false;
    button.textContent = "Terugdraaien";
    return;
  }
  await refreshData();
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
  return askOperatorKey("Code om de planning te openen");
}

// Every backend call carries the operator code. On a rejected code the planner
// gets one chance to retype it, so a changed code does not need a page reload.
// A right code that may not do something (403) is not a wrong code: the code
// stays, and the caller shows why.
async function backendFetch(url, options = {}) {
  const send = () =>
    fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), "x-operator-key": storedOperatorKey() },
    });

  let response = await send();
  if (response.status === 401 && usesBackend && !operatorPromptDeclined) {
    try {
      localStorage.removeItem(operatorKeyStorageKey);
      localStorage.removeItem(roleStorageKey);
    } catch {
      // Nothing stored to forget.
    }
    state.role = null;
    if (!askOperatorKey("Die code klopt niet. Probeer het opnieuw:")) return response;
    response = await send();
  }
  return response;
}

// full: also fetch the planned routes and the deliveries. Each costs a list
// operation, so the timer only asks for them every fifth tick; anything the
// planner or driver does, and opening a route, always asks for everything.
//
// Refreshes can overlap (the timer, a button, coming back to the tab). Each one
// is numbered, and an answer that arrives after a newer refresh has started is
// dropped, so an old list can never put a just-delivered order back on screen.
async function refreshData(full = true) {
  const seq = ++refreshSeq;
  const buttons = [document.querySelector("#refreshButton"), document.querySelector("#refreshMobile")].filter(Boolean);
  buttons.forEach((button) => {
    button.disabled = true;
    button.textContent = "Bezig…";
  });
  try {
    const separator = CONFIG.dataUrl.includes("?") ? "&" : "?";
    const response = await backendFetch(`${CONFIG.dataUrl}${separator}t=${Date.now()}`, { cache: "no-store" });
    if (response.status === 401) throw new Error("Code ontbreekt of klopt niet");
    if (!response.ok) throw new Error("Data kon niet worden geladen");
    const loaded = await response.json();
    if (seq !== refreshSeq) return;

    if (full) {
      const plan = await fetchPlan();
      if (seq !== refreshSeq) return;
      if (plan === null) throw new Error("De ritten konden niet worden geladen");
      state.plan = plan;
      const history = await fetchHistory([...new Set(state.plan.flatMap(planKeys))]);
      if (seq !== refreshSeq) return;
      if (history) {
        state.history = history.entries;
        state.deliveredKeys = new Map([
          ...history.entries.map((entry) => [`${entry.shopDomain}:${entry.id}`, entry.deliveredAt]),
          ...Object.entries(history.delivered).filter(([, at]) => at),
          ...Object.entries(history.delivered).filter(([key, at]) => !at && !history.entries.some((entry) => `${entry.shopDomain}:${entry.id}` === key)),
        ]);
        state.historyLoaded = true;
        state.historyRound = seq;
      }
      state.lastFullAt = Date.now();
    }

    // The driver's phone gets orders without names or addresses, and the full
    // details of its own stops alongside the routes: the two are put together,
    // the fresh order's flags (cancelled, announced) over the stop's details.
    // A stop missing from the fresh orders has been delivered or shipped since;
    // it is not put back from the older copy.
    const byKey = new Map(loaded.map((order) => [orderKey(order), order]));
    for (const stop of state.planStops) {
      const fresh = byKey.get(orderKey(stop));
      if (fresh) byKey.set(orderKey(stop), { ...stop, ...fresh, postcode: stop.postcode || fresh.postcode });
    }
    state.allOrders = [...byKey.values()];
    state.ordersRound = seq;
    state.lastFetchOk = true;
    state.orders = state.allOrders.filter((order) => !(order.dueDate && order.dueDate < hideOrdersDueBefore));
    // Before rebuildPlanning, because the travel budgets are judged against these.
    await fetchGeo(state.allOrders);
    state.driveMinutes = await fetchDriveMinutes(state.orders);
    if (seq !== refreshSeq) return;
    if (!state.role) applyRole(await fetchRole());
    rebuildPlanning();
    renderHistory();
    state.lastRefreshAt = Date.now();
    const klok = new Intl.DateTimeFormat("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
    const bron = state.driveMinutes ? "gemeten rijtijden" : "geschatte rijtijden";
    document.querySelector("#syncText").textContent = `Laatst ververst om ${klok} · ${bron}`;
  } catch (error) {
    if (seq !== refreshSeq) return;
    state.lastFetchOk = false;
    const offline = error instanceof TypeError ? "Geen verbinding" : error.message;
    document.querySelector("#syncText").textContent = `${offline} — bestaande gegevens blijven staan`;
    // Redrawn without new data, so screens that depend on the connection say so.
    renderDriver();
    renderOpenPlan();
  } finally {
    if (seq === refreshSeq) {
      buttons.forEach((button) => {
        button.disabled = false;
        button.textContent = "Ververs";
      });
    }
  }
}

// Measured driving times, only when a Google key is set in the backend, which
// it is not: the planning runs on its own estimate. Once the backend has said
// so, it is not asked again.
async function fetchDriveMinutes(orders) {
  if (!usesBackend || state.driveEstimateUnavailable || state.role === "driver") return null;
  const stops = [...new Set(orders.map(orderAddress).filter(Boolean))];
  if (!stops.length) return null;
  try {
    const response = await backendFetch(`${CONFIG.apiBaseUrl}/routes/estimate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stops }),
    });
    if (response.status === 501) state.driveEstimateUnavailable = true;
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
    // Never loaded yet and failing now: say so. An empty agenda would read as
    // "nothing planned", and every planned order would be proposed again.
    if (!response.ok) return state.planLoaded ? state.plan : null;
    const payload = await response.json();
    state.dayNotes = payload.dayNotes || [];
    state.announcements = payload.announcements || [];
    state.announceLive = Boolean(payload.announceLive);
    state.planStops = payload.stops || [];
    state.concepts = payload.concepts || [];
    state.heldKeys = new Set(payload.heldKeys || []);
    state.planLoaded = true;
    return payload.routes || [];
  } catch {
    return state.planLoaded ? state.plan : null;
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

async function savePlan({ id, date, fromDate, name, keys, tagKeys = [], conceptId = null }) {
  let response = null;
  try {
    response = await backendFetch(`${CONFIG.apiBaseUrl}/plan/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, date, fromDate, name, orderKeys: keys, tagKeys, conceptId }),
    });
  } catch {
    return { error: "Inplannen is niet gelukt: geen verbinding. Probeer het opnieuw." };
  }
  if (!response.ok) return { error: await errorText(response, "Inplannen is niet gelukt. Probeer het opnieuw.") };
  const payload = await response.json();
  return { route: payload.route || null, conceptLeft: payload.conceptLeft || [] };
}

async function removePlannedRoute(planned) {
  if (!planned) return;
  if (!window.confirm(`Rit ${planned.number || "?"} naar ${planned.name} van ${formatDate(planned.date)} uit de agenda halen? De orders komen terug in de planning.`)) return;
  const response = await backendFetch(`${CONFIG.apiBaseUrl}/plan/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: planned.id, date: planned.date }),
  }).catch(() => null);
  if (!response?.ok) {
    window.alert(response ? await errorText(response, "Uit de agenda halen is niet gelukt.") : "Geen verbinding. Probeer het opnieuw.");
    return;
  }
  if (state.openPlan?.id === planned.id) {
    state.openPlan = null;
    state.manualRoute = null;
  }
  state.plan = (await fetchPlan()) || state.plan;
  rebuildPlanning();
}

// Each stored stop, matched against everything the backend returned, not just
// what the planning shows: an order whose date moved back in Shopify is hidden
// from the planning but very much alive. Delivered is taken from the delivery
// records asked for by key. A stop that has left the open orders is only called
// "not found" when the delivery records came in the same refresh; otherwise it
// may simply have been delivered a minute ago, so it is "not yet confirmed".
function plannedRouteStatus(planned) {
  const byKey = new Map(state.allOrders.map((order) => [orderKey(order), order]));
  const zeker = state.historyLoaded && state.historyRound === state.ordersRound;
  const stops = planKeys(planned).map((key) => {
    const order = byKey.get(key);
    if (order && !order.fulfilled) {
      const status = order.cancelled ? "geannuleerd" : order.refunded ? "terugbetaald" : "open";
      return { key, id: order.id, order, status };
    }
    if (state.deliveredKeys.has(key)) return { key, id: key.split(":").pop(), status: "bezorgd", at: state.deliveredKeys.get(key) };
    return { key, id: key.split(":").pop(), status: zeker ? "onbekend" : "onbevestigd" };
  });
  return { stops, open: stops.filter((stop) => stop.status === "open").map((stop) => stop.order) };
}

// The same bar the planning applies before a parcel rides along: paid, fully
// addressed, no slot agreed with the customer. Never an order that is already in
// a route or a concept, or it would end up in two.
function additionAllowed(item) {
  const order = item.order;
  if (["exclude", "planned", "concept"].includes(item.decision)) return false;
  if (order.refunded || order.cancelled) return false;
  if (CONFIG.ritregelsV3 && !hasKnownPoint(order)) return false;
  return Boolean(order.addressComplete && order.paid && !order.deliveryAppointmentLocked);
}

// Measured against the route as it is driven now, stops in their saved order,
// with the new stop slotted in where it costs least. After every acceptance the
// list is rebuilt against the grown route, so five offers of "+25 min" can never
// add up to two hours unnoticed.
function nearbyAdditions(orders) {
  if (!orders.length) return [];
  const inRoute = new Set(orders.map(orderKey));
  return state.decisions
    .filter((item) => !inRoute.has(orderKey(item.order)) && additionAllowed(item))
    .map((item) => ({ item, ...additionFor(orders, item.order) }))
    .filter((kandidaat) => fitsAsAddition(kandidaat, kandidaat.item.order, kandidaat.item.decision))
    .sort((a, b) => a.extra - b.extra)
    .slice(0, 5);
}


// One stop onto a planned route, by the driver or the planner: saved, tagged in
// Shopify when it is a parcel, and put where it costs the least driving, all in
// one request. The screen only changes once that has gone through.
async function acceptAddition(kandidaat, button) {
  const planned = state.openPlan;
  if (!planned || !kandidaat) return;
  const order = kandidaat.item.order;
  if (button) {
    button.disabled = true;
    button.textContent = "Bezig…";
  }
  const open = plannedRouteStatus(planned).open;
  const keys = planKeys(planned);
  const volgende = open[kandidaat.position];
  const position = volgende ? Math.max(0, keys.indexOf(orderKey(volgende))) : keys.length;
  const nieuw = [...open.slice(0, kandidaat.position), order, ...open.slice(kandidaat.position)];

  let response = null;
  try {
    response = await backendFetch(`${CONFIG.apiBaseUrl}/plan/add-stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: planned.id, date: planned.date, orderKey: orderKey(order), tag: needsOwnDeliveryTag(order), position, name: routeLabel({ orders: nieuw, region: planned.name }) }),
    });
  } catch {
    response = null;
  }
  if (!response) {
    // The request may have gone through with the answer lost on the way back:
    // look before saying anything for certain. Asking again is harmless.
    window.alert("Geen antwoord. Misschien is de stop toch toegevoegd; het scherm wordt nu ververst. Staat hij erbij, dan is het gelukt. Nog eens Meenemen kan geen kwaad.");
    await refreshData();
    return;
  }
  if (!response.ok) {
    window.alert(`${await errorText(response, "Toevoegen is niet gelukt.")} Je rijdt de oorspronkelijke rit.`);
    renderOpenPlan();
    renderDriver();
    return;
  }
  await refreshData();
}

// Coordinates for every address not yet known in this browser. The backend
// keeps what PDOK returned, so after the first time this costs one KV read per
// address and never another lookup. The driver's phone holds no addresses but
// those of its own stops; the other orders arrive with their point.
async function fetchGeo(orders) {
  if (!usesBackend) return;
  const missing = [...new Set(orders.filter((order) => order.fullAddress && !order.point).map(orderAddress).filter((address) => address && !(address in state.geo)))];
  // Forty at a time, matching the backend's limit per request.
  for (let start = 0; start < missing.length; start += 40) {
    try {
      const response = await backendFetch(`${CONFIG.apiBaseUrl}/geo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addresses: missing.slice(start, start + 40) }),
        // The planning waits for this before drawing; it must not wait forever.
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) continue;
      const { results } = await response.json();
      for (const [address, point] of Object.entries(results || {})) {
        if (point) state.geo[address] = { lat: point.lat, lon: point.lon };
      }
    } catch {
      // Timed out or offline: carry on with the next batch, estimate the rest.
      continue;
    }
  }
}

// The newest deliveries for the history screen, and for each stop of the
// routes in view whether and when it was delivered. null on failure: what was
// known stays, rather than every delivered stop turning into "not found".
async function fetchHistory(keys = []) {
  if (!usesBackend) return { entries: [], delivered: {} };
  try {
    // Always with keys=, even empty: that asks for the answer with delivery
    // times per stop. Without it the Worker answers the way older screens expect.
    const query = `&keys=${encodeURIComponent(keys.slice(0, 200).join(","))}`;
    const response = await backendFetch(`${CONFIG.apiBaseUrl}/history?t=${Date.now()}${query}`, { cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json();
    if (Array.isArray(payload)) return { entries: payload, delivered: {} };
    return { entries: payload.entries || [], delivered: payload.delivered || {} };
  } catch {
    return null;
  }
}

// localStorage can be empty, blocked, or hold something unreadable (a private
// window, cleared site data). Anything but a clean read falls back quietly.
function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// Whole days from today to a date, counted on the calendar. Midnight to midnight
// is 23 or 25 hours around the clock change, and rounding up 49 hours called a
// delivery two days out "three days" once a year.
function daysUntil(isoDate) {
  const due = dateFromIso(isoDate);
  if (!due) return null;
  return Math.round((due - startOfDay(new Date())) / 86_400_000);
}

// Two routes either side of a sector line, with stops close to each other, are
// one drive: Elst and Huissen, 7 km apart, came out as two trips of 1:24 and
// 1:31 against one of 1:59. Merged only when the stops lie near each other and
// the day still fits, so routes that merely share a depot stay apart.
function mergeNeighbourRoutes(routes) {
  const dayLimit = CONFIG.maxRouteMinutes + CONFIG.nearlyOverMinutes;
  const close = (a, b) => a.orders.some((x) => b.orders.some((y) => distanceKm(orderPoint(x), orderPoint(y)) <= CONFIG.neighbourPoolKm));
  const list = [...routes];
  for (;;) {
    let best = null;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (!close(list[i], list[j])) continue;
        const combined = routeSummary(list[i].region, optimizedStopOrder([...list[i].orders, ...list[j].orders]));
        if (combined.totalMinutes > dayLimit) continue;
        if (combined.loadKnown && combined.load > CONFIG.vehicleCapacityKg) continue;
        const saving = list[i].totalMinutes + list[j].totalMinutes - combined.totalMinutes;
        if (saving > 0 && (!best || saving > best.saving)) best = { i, j, combined, saving };
      }
    }
    if (!best) return list;
    list.splice(best.j, 1);
    list[best.i] = best.combined;
  }
}

// Kilometres as the crow flies, depot out, every stop in this order, depot back.
function loopKm(orders) {
  let km = 0;
  let from = DEPOT_POINT;
  for (const order of orders) {
    const point = orderPoint(order);
    km += distanceKm(from, point);
    from = point;
  }
  return km + distanceKm(from, DEPOT_POINT);
}

function hasKnownPoint(order) {
  return Boolean(order.point || state.geo[orderAddress(order)] || estimatedPoint(order));
}

// Weighs one group without touching it. Orders that go whatever the distance (a
// hay house) always go; they are the trip's backbone, and every other order is
// weighed on what it adds to that trip against its own finite budget. Summing
// their budgets instead made the pool endless, and a single hay house in
// Hensbroek turned a rijplaten order in Groningen into a 5-hour route of its own.
function evaluatePool(candidates) {
  const v3 = CONFIG.ritregelsV3;
  const fixed = v3 ? candidates.filter((item) => item.plan.budgetMinutes === Infinity) : [];
  const fixedOrders = fixed.map((item) => item.order);
  const basis = fixedOrders.length ? routeDriveMinutes(optimizedStopOrder(fixedOrders)) : 0;
  // In driving order, as buildRoutes will show it. The order list's own
  // sequence can zigzag: Maastricht, Nijmegen, Geleen read as 476 minutes
  // against 292 for the route actually driven.
  const cost = (items) => (items.length ? routeDriveMinutes(optimizedStopOrder([...fixedOrders, ...items.map((item) => item.order)])) - basis : 0);

  const kept = candidates.filter((item) => !fixed.includes(item));
  const dropped = [];
  let verdict = "include";
  while (kept.length) {
    const drive = cost(kept);
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
      const causes = drive - cost(kept.filter((entry) => entry !== item));
      const overspend = causes - item.plan.budgetMinutes;
      if (!worst || overspend > worst.overspend) worst = { item, overspend };
    }
    kept.splice(kept.indexOf(worst.item), 1);
    dropped.push(worst.item);
  }
  const drive = cost(kept);
  const budget = kept.reduce((sum, item) => sum + item.plan.budgetMinutes, 0);
  return { fixed, kept, dropped, verdict, drive, budget, basis, size: candidates.length };
}

function applyPool(region, candidates, result) {
  const { fixed, kept, dropped, verdict, drive, budget } = result;
  for (const item of candidates) {
    item.poolRegion = region;
    item.droppedFromPool = false;
    item.poolReview = false;
  }
  for (const item of dropped) {
    item.droppedFromPool = true;
    item.decision = item.plan.overflow;
    const samen = result.size > 1 ? `, ook samen met de andere orders richting ${region}` : "";
    item.reason = item.plan.overflow === "dhl"
      ? `${item.plan.label} kost meer omrijden dan de ${formatMinutes(item.plan.budgetMinutes)} die deze order meebrengt; gaat als pakket via DHL`
      : `${item.plan.label} kost meer omrijden dan de ${formatMinutes(item.plan.budgetMinutes)} die deze order meebrengt${samen}`;
    // Tagged "eigen bezorging" in Shopify, the DHL pile skips it: back under
    // DHL here, nobody would deliver it.
    if (item.plan.overflow === "dhl" && item.order.ownDeliveryTagged) {
      item.decision = "review";
      item.taggedParcel = true;
      item.reason = "In Shopify getagd als eigen bezorging, maar zit in geen rit. Neem hem mee in een rit, of haal de tag in Shopify weg zodat hij met DHL gaat";
    }
  }
  for (const item of fixed) {
    item.decision = "include";
    item.reason = `${item.plan.label}: ${routeMinutesFromDepot(item.order)}; gaat altijd zelf, hoe ver ook. ${dueDateReason(item.order)}`;
  }
  if (!kept.length) return;

  const samen = kept.length > 1 ? `${kept.length} orders richting ${region} samen ` : "";
  const gezamenlijk = kept.length > 1 ? "gezamenlijke " : "";
  let shared;
  if (budget === Infinity) {
    shared = `${formatMinutes(drive)} rijden richting ${region}; deze slowfeeders gaan altijd zelf, hoe ver ook`;
  } else if (fixed.length) {
    const along = verdict === "review"
      ? `${formatMinutes(drive - budget)} over de ${gezamenlijk}${formatMinutes(budget)}; net erover, zelf beoordelen`
      : `binnen de ${gezamenlijk}${formatMinutes(budget)}`;
    shared = `rijdt mee met ${fixed.length === 1 ? "de altijd-eigen order" : "de altijd-eigen orders"} richting ${region}, ${formatMinutes(drive)} extra rijden, ${along}`;
  } else if (verdict === "review") {
    shared = `${samen}${formatMinutes(drive)} rijden, ${formatMinutes(drive - budget)} over de ${gezamenlijk}${formatMinutes(budget)}; net erover, zelf beoordelen`;
  } else {
    shared = `${samen}${formatMinutes(drive)} rijden, binnen de ${gezamenlijk}${formatMinutes(budget)}`;
  }
  for (const item of kept) {
    item.decision = verdict;
    item.poolReview = verdict === "review";
    item.reason = `${item.plan.label}: ${shared}. ${dueDateReason(item.order)}`;
  }
}

// The four compass sectors keep the weighing simple, but their lines run through
// busy country: between Arnhem and Nijmegen, past Zwolle. An order left over in
// its own sector gets a second try in a neighbouring sector's pool when it lies
// close to an order there. It is only moved when nobody already in that pool
// comes off worse for it.
function poolAcrossSectorLines() {
  const pooled = state.decisions.filter((item) => item.poolRegion);
  for (const item of pooled.filter((entry) => entry.droppedFromPool)) {
    if (!item.droppedFromPool) continue;
    const point = orderPoint(item.order);
    const near = (other) => distanceKm(point, orderPoint(other.order)) <= CONFIG.neighbourPoolKm;
    const regions = [...new Set(pooled.filter((other) => other !== item && other.poolRegion !== item.poolRegion && near(other)).map((other) => other.poolRegion))];
    for (const region of regions) {
      const members = pooled.filter((other) => other.poolRegion === region && !other.droppedFromPool);
      const looseThere = pooled.filter((other) => other.poolRegion === region && other.droppedFromPool && near(other));
      const group = [...members, ...looseThere, item];
      const trial = evaluatePool(group);
      const everyoneKept = members.every((member) => trial.kept.includes(member) || trial.fixed.includes(member));
      const noneWorse = members.every((member) => member.decision !== "include" || trial.verdict === "include" || trial.fixed.includes(member));
      if (trial.kept.includes(item) && everyoneKept && noneWorse) {
        applyPool(region, group, trial);
        break;
      }
    }
  }
}

// The orders of a hand-made or opened route, as they stand now. Only keys are
// kept, so a stop that was delivered or cancelled meanwhile drops out instead of
// lingering with a live Bezorgd button.
function manualRouteOrders() {
  const route = state.manualRoute;
  if (!route) return [];
  const byKey = new Map(state.allOrders.map((order) => [orderKey(order), order]));
  return route.keys.map((key) => byKey.get(key)).filter((order) => order && !order.cancelled && !order.fulfilled && !order.refunded);
}

// An opened planned route follows its saved record on every refresh: the stops
// the driver has left, in the order the driver drives them.
function syncOpenPlan() {
  if (!state.openPlan) return;
  const fresh = state.plan.find((planned) => planned.id === state.openPlan.id);
  if (!fresh) {
    state.openPlan = null;
    state.manualRoute = null;
    return;
  }
  state.openPlan = fresh;
  const status = plannedRouteStatus(fresh);
  state.manualRoute = { keys: status.open.map(orderKey), keepOrder: true, removed: new Set() };
}

// Parcels (and XXL bakken, which go either way) are tagged "eigen bezorging" in
// Shopify when they go into a route, so whoever prints the DHL labels skips them.
// Rijplaten and the fixed-list slowfeeders always go by van and need no tag.
function needsOwnDeliveryTag(order) {
  if (order.ownDeliveryTagged) return false;
  const plan = transportPlan(order);
  return !plan || plan === transportRules.xxl;
}

// Due today or earlier, and still to be driven or decided on.
function urgentDecisions() {
  return state.decisions.filter((item) => {
    if (!["include", "review", "planned", "concept"].includes(item.decision)) return false;
    if (item.order.cancelled || item.order.refunded || item.order.fulfilled) return false;
    const days = item.order.dueDate ? daysUntil(item.order.dueDate) : null;
    return days !== null && days <= 0;
  });
}

function capitalize(text) {
  const value = String(text || "");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// One line per stop that is no longer to be driven, the same for planner and
// driver. "Not yet confirmed" while the delivery records have not loaded, so a
// stop delivered this morning is never called "not found" over a lost signal.
function stopStatusLine(stop) {
  const id = escapeHtml(stop.id);
  if (stop.status === "bezorgd") return `<li class="plan-stop klaar"><s>${id}</s> bezorgd${stop.at ? ` op ${formatDateTime(stop.at)}` : ""}</li>`;
  if (stop.status === "geannuleerd") return `<li class="plan-stop fout">${id} is geannuleerd, niet afleveren</li>`;
  if (stop.status === "terugbetaald") return `<li class="plan-stop fout">${id} is terugbetaald, niet afleveren</li>`;
  if (stop.status === "onbevestigd") return `<li class="plan-stop">${id}: status nog niet bevestigd, ververs zo even</li>`;
  return `<li class="plan-stop fout">${id} staat niet meer open. Bel de planner voor je gaat.</li>`;
}

// Navigation from wherever the van is now, through the stops that are left, in
// their planned order. No starting point: halfway through a route the depot is
// the wrong place to start from.
function driverMapsUrl(orders) {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("travelmode", "driving");
  url.searchParams.set("destination", mapsAddress(orders[orders.length - 1]));
  if (orders.length > 1) url.searchParams.set("waypoints", orders.slice(0, -1).map(mapsAddress).join("|"));
  return url.toString();
}

// "+31 (0)6 1234 5678" is how people write it; the (0) has to go, or the phone
// dials +3106.
function telHref(number) {
  const cleaned = String(number).replace(/^\s*\+(\d{1,3})\s*\(0\)\s*/, "+$1").replace(/[^\d+]/g, "");
  return `tel:${cleaned}`;
}

function logout() {
  if (!window.confirm("Uitloggen op dit apparaat? De code wordt hier vergeten; op andere apparaten blijft alles zoals het is.")) return;
  try {
    localStorage.removeItem(operatorKeyStorageKey);
    localStorage.removeItem(roleStorageKey);
  } catch {
    // Nothing stored to forget.
  }
  window.location.reload();
}

// Taking a stop out of an opened planned route, saved at once. The stop comes
// back into the planning; the driver no longer sees it.
async function removePlannedStop(key) {
  const planned = state.openPlan;
  if (!planned) return;
  const order = state.allOrders.find((item) => orderKey(item) === key);
  const naam = order?.id || key.split(":").pop();
  if (!window.confirm(`${naam} uit rit ${planned.number || "?"} halen? De bezorger ziet deze stop dan niet meer en de order komt terug in de planning.`)) return;
  const over = plannedRouteStatus(planned).open.filter((item) => orderKey(item) !== key);
  const response = await backendFetch(`${CONFIG.apiBaseUrl}/plan/remove-stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: planned.id, date: planned.date, orderKey: key, name: over.length ? routeLabel({ orders: over, region: planned.name }) : planned.name }),
  }).catch(() => null);
  if (!response?.ok) {
    window.alert(await errorText(response, "Uit de rit halen is niet gelukt. Probeer het opnieuw."));
    return;
  }
  const payload = await response.json();
  state.plan = (await fetchPlan()) || state.plan;
  if (payload.removed) {
    closeOpenPlan();
    return;
  }
  applyOpenPlan();
}

// The error the backend gave, in its own words, or a fallback when there was
// no answer at all.
async function errorText(response, fallback) {
  if (!response) return fallback;
  try {
    const payload = await response.json();
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

// The routes on screen: the proposals that fit, then the ones just over budget.
function allRoutes() {
  return [...state.routes, ...state.reviewRoutes];
}

// Proposals are lettered, planned routes numbered. A proposal called "Rit 2"
// next to the planned rit 2 of last week read as the same route.
function routeTitle(route, index) {
  if (state.openPlan) return `Rit ${state.openPlan.number || "?"}`;
  if (state.openConcept) return "Concept";
  if (state.manualRoute) return "Eigen selectie";
  return `${route.review ? "Controleren" : "Voorstel"} ${routeLetter(index)}`;
}

function routeLetter(index) {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

function plannedReason(planned) {
  const vandaag = isoDay(new Date());
  return planned.date < vandaag
    ? `Staat nog open in rit ${planned.number || "?"} van ${formatDate(planned.date)}: rij hem alsnog, of breek die rit af zodat de orders terugkomen`
    : `Ingepland in rit ${planned.number || "?"} op ${formatDate(planned.date)}`;
}

// An order too far for a trip of its own can still fit a route that is already
// planned that way. It is not added by itself (that changes a route the driver
// may already have seen); it goes to Controleren with the route it fits, so the
// planner opens that route and takes it along with one tap.
function offerPlannedRoutes() {
  const vandaag = isoDay(new Date());
  const komend = state.plan.filter((planned) => planned.date >= vandaag && !planned.abortedAt);
  if (!komend.length) return;
  for (const item of state.decisions) {
    const tooFar = item.decision === "far" || (item.decision === "dhl" && item.plan);
    if (!tooFar || !additionAllowed({ ...item, decision: "review" })) continue;
    let best = null;
    for (const planned of komend) {
      const open = plannedRouteStatus(planned).open;
      if (!open.length) continue;
      const fit = additionFor(open, item.order);
      if (!fitsAsAddition(fit, item.order, item.decision)) continue;
      if (!best || fit.extra < best.fit.extra) best = { planned, fit };
    }
    if (!best) continue;
    item.decision = "review";
    item.fitsPlanned = best.planned;
    item.reason = `Past bij rit ${best.planned.number || "?"} op ${formatDate(best.planned.date)} (+${formatMinutes(best.fit.extra)}): open die rit in de Agenda en kies Meenemen`;
  }
}

// One order slotted into a route in its saved order, where it costs the least.
function additionFor(orders, order) {
  let position = orders.length;
  let bestKm = Infinity;
  for (let index = 0; index <= orders.length; index += 1) {
    const km = loopKm([...orders.slice(0, index), order, ...orders.slice(index)]);
    if (km < bestKm) {
      bestKm = km;
      position = index;
    }
  }
  const basis = routeSummary("Rit", orders);
  const merged = routeSummary("Rit", [...orders.slice(0, position), order, ...orders.slice(position)]);
  return { position, extra: merged.totalMinutes - basis.totalMinutes, extraDrive: merged.driveMinutes - basis.driveMinutes, totaal: merged.totalMinutes, load: merged.load, loadKnown: merged.loadKnown };
}

// What may join is what the rules would let join: a parcel when the route grows
// by at most an hour, unloading included; a rijplaten order or XXL bak when the
// extra driving stays within its own budget, as in a new route; a hay house
// always. Every order used to be held to the parcel's hour, and a rijplaten
// order an hour and a half's drive away was never offered.
function fitsAsAddition(fit, order, decision) {
  if (fit.totaal > CONFIG.maxRouteMinutes + CONFIG.nearlyOverMinutes) return false;
  if (fit.loadKnown && fit.load > CONFIG.vehicleCapacityKg) return false;
  const plan = transportPlan(order);
  if (plan && decision !== "dhl") return fit.extraDrive <= plan.budgetMinutes;
  return fit.extra <= CONFIG.packageDetourMinutes;
}

// ---------------------------------------------------------------------------
// Concepts: a route put together and kept for later, without a day or number
// yet. It holds its orders: they are not proposed or planned elsewhere. Only
// the planner sees concepts; the driver's phone only knows which orders they hold.
// ---------------------------------------------------------------------------
function conceptFor(order) {
  const key = orderKey(order);
  return state.concepts.find((concept) => (concept.orderKeys || []).includes(key)) || null;
}

function newId(prefix) {
  return globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// An opened concept follows its saved record: its stops that are still open.
function syncOpenConcept() {
  if (!state.openConcept) return;
  if (state.openPlan) {
    state.openConcept = null;
    return;
  }
  const fresh = state.concepts.find((concept) => concept.id === state.openConcept.id);
  if (!fresh) {
    state.openConcept = null;
    state.manualRoute = null;
    return;
  }
  state.openConcept = fresh;
  state.manualRoute = { keys: [...fresh.orderKeys], removed: state.manualRoute?.removed || new Set(), concept: true };
}

async function postConcept(path, body) {
  let response = null;
  try {
    response = await backendFetch(`${CONFIG.apiBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { error: "Geen verbinding. Probeer het opnieuw." };
  }
  if (!response.ok) return { error: await errorText(response, "Opslaan is niet gelukt. Probeer het opnieuw.") };
  return response.json();
}

// "Opslaan als concept" on any route card: a proposal, one of the planner's own,
// or one just over budget. It then shows under Concepten.
async function saveRouteAsConcept(route, button) {
  if (!route?.orders?.length) return;
  if (button) {
    button.disabled = true;
    button.textContent = "Bezig…";
  }
  const result = await postConcept("/concepts/save", { id: newId("concept"), name: routeLabel(route), orderKeys: route.orders.map(orderKey) });
  if (result.error) {
    window.alert(result.error);
    if (button) {
      button.disabled = false;
      button.textContent = "Opslaan als concept";
    }
    return;
  }
  if (state.manualRoute && !state.openPlan && !state.openConcept) {
    route.orders.forEach((order) => state.selected.delete(orderKey(order)));
    state.manualRoute = null;
    activeMapRouteIndex = 0;
  }
  state.plan = (await fetchPlan()) || state.plan;
  rebuildPlanning();
  showView("concepten");
}

// Every change to an opened concept is saved at once, like a planned route. One
// at a time: a second tap while the first is still on its way would start from
// the old stops and quietly undo the first. `change` gets the stops as last
// saved and returns the new list.
async function saveOpenConcept(change) {
  const concept = state.openConcept;
  if (!concept || state.conceptSaving) return false;
  state.conceptSaving = true;
  document.querySelectorAll("#routes .remove-route-stop, #mapView .remove-from-active-route, #mapView .add-to-active-route, #suggestions .add-suggestion").forEach((button) => { button.disabled = true; });
  try {
    const keys = change([...concept.orderKeys]);
    const byKey = new Map(state.allOrders.map((order) => [orderKey(order), order]));
    const orders = keys.map((key) => byKey.get(key)).filter(Boolean);
    let response = null;
    try {
      response = await backendFetch(`${CONFIG.apiBaseUrl}/concepts/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: concept.id, name: routeLabel({ orders, region: concept.name }), orderKeys: keys, update: true }),
      });
    } catch {
      response = null;
    }
    if (!response?.ok) {
      window.alert(response ? await errorText(response, "Opslaan is niet gelukt. Probeer het opnieuw.") : "Geen verbinding. Probeer het opnieuw.");
      // Removed or planned elsewhere: there is nothing left to edit here.
      if (response?.status === 404) {
        state.openConcept = null;
        state.manualRoute = null;
        state.plan = (await fetchPlan()) || state.plan;
      }
      return false;
    }
    const saved = (await response.json()).concept;
    if (saved) {
      state.openConcept = saved;
      state.concepts = state.concepts.map((entry) => (entry.id === saved.id ? saved : entry));
    }
    state.plan = (await fetchPlan()) || state.plan;
    return true;
  } finally {
    state.conceptSaving = false;
  }
}

async function removeConcept(concept, { ask = true } = {}) {
  if (!concept) return;
  if (ask && !window.confirm(`Het concept ${concept.name} verwijderen? De orders komen terug in de planning.`)) return;
  const result = await postConcept("/concepts/remove", { id: concept.id });
  if (result.error) {
    window.alert(result.error);
    return;
  }
  if (state.openConcept?.id === concept.id) {
    state.openConcept = null;
    state.manualRoute = null;
  }
  state.plan = (await fetchPlan()) || state.plan;
  rebuildPlanning();
}

function openConcept(concept) {
  if (!concept) return;
  state.openPlan = null;
  state.openConcept = concept;
  state.manualRoute = null;
  activeMapRouteIndex = 0;
  showView("vandaag");
  rebuildPlanning();
}

function closeConcept() {
  state.openConcept = null;
  state.manualRoute = null;
  activeMapRouteIndex = 0;
  rebuildPlanning();
}

// The concept's stops as they stand now: open ones in the route, the rest named.
function conceptRoute(concept) {
  const byKey = new Map(state.allOrders.map((order) => [orderKey(order), order]));
  const open = (concept.orderKeys || []).map((key) => byKey.get(key)).filter((order) => order && !order.cancelled && !order.fulfilled && !order.refunded);
  const gone = (concept.orderKeys || []).filter((key) => !open.some((order) => orderKey(order) === key));
  return { route: open.length ? routeSummary("Concept", optimizedStopOrder(open)) : null, gone };
}

function renderConcepts() {
  const holder = document.querySelector("#conceptList");
  const teller = document.querySelector("#conceptCount");
  if (teller) {
    teller.textContent = state.concepts.length;
    teller.hidden = !state.concepts.length;
  }
  if (!holder) return;
  if (!state.concepts.length) {
    holder.innerHTML = '<p class="empty">Nog geen concepten. Kies bij een rit op Vandaag <b>Opslaan als concept</b>.</p>';
    return;
  }
  const vandaag = startOfDay(new Date());
  holder.innerHTML = state.concepts.map((concept) => {
    const { route, gone } = conceptRoute(concept);
    const gemaakt = new Date(concept.createdAt);
    const dagen = Math.round((vandaag - startOfDay(gemaakt)) / 86_400_000);
    const leeftijd = dagen >= 7 ? `<span class="concept-age">al ${dagen} dagen oud</span>` : "";
    // Two screens at once can put an order in a concept and a route: say so,
    // so it can be taken out of one of them.
    const stops = route ? route.orders.map((order) => {
      const ook = plannedFor(order);
      return `<li><b>${escapeHtml(order.city || "Plaats onbekend")} · ${escapeHtml(order.id)}</b><span>${productSummary(order)}</span>${ook ? `<span class="concept-also">Staat ook in rit ${escapeHtml(ook.number || "?")} op ${formatDate(ook.date)}: haal hem uit een van de twee.</span>` : ""}</li>`;
    }).join("") : "";
    return `<article class="concept-card">
      <div class="concept-head">
        <div><h2>${escapeHtml(concept.name)}</h2>
          <p>${route ? `${route.orders.length} ${route.orders.length === 1 ? "stop" : "stops"} · rijden ${formatMinutes(route.driveMinutes)} · totaal ${formatMinutes(route.totalMinutes)}` : "Geen open stops meer"} · gemaakt ${formatDateTime(concept.createdAt)} ${leeftijd}</p></div>
      </div>
      ${stops ? `<ol class="concept-stops">${stops}</ol>` : ""}
      ${gone.length ? `<p class="concept-gone">${gone.length} ${gone.length === 1 ? "order staat" : "orders staan"} niet meer open (bezorgd, geannuleerd of verzonden): ${gone.map((key) => escapeHtml(key.split(":").pop())).join(", ")}</p>` : ""}
      <div class="concept-actions">
        ${route ? `<button class="button primary concept-open" type="button" data-concept="${escapeHtml(concept.id)}">Openen</button>
        <button class="button manual-action concept-plan" type="button" data-concept="${escapeHtml(concept.id)}">Inplannen</button>` : ""}
        <button class="button subtle-action concept-remove" type="button" data-concept="${escapeHtml(concept.id)}">Verwijderen</button>
      </div>
    </article>`;
  }).join("");
  const find = (button) => state.concepts.find((concept) => concept.id === button.dataset.concept);
  holder.querySelectorAll(".concept-open").forEach((button) => button.addEventListener("click", () => openConcept(find(button))));
  holder.querySelectorAll(".concept-plan").forEach((button) => button.addEventListener("click", () => {
    const concept = find(button);
    const { route } = conceptRoute(concept);
    if (route) putRouteInHand(route, concept.id);
  }));
  holder.querySelectorAll(".concept-remove").forEach((button) => button.addEventListener("click", () => removeConcept(find(button))));
}

// While a concept is open on Vandaag: what it is, and the ways out.
function renderConceptBar() {
  const bar = document.querySelector("#conceptBar");
  if (!bar) return;
  const concept = state.openConcept;
  bar.hidden = !concept;
  if (!concept) {
    bar.innerHTML = "";
    return;
  }
  const route = allRoutes()[0];
  bar.innerHTML = route
    ? `<p><strong>Concept: ${escapeHtml(concept.name)}</strong> Wat je hier verandert, wordt meteen in het concept opgeslagen.</p>
    <div class="concept-bar-actions">
      <button id="conceptBarPlan" class="button primary" type="button">Inplannen</button>
      <button id="conceptBarClose" class="button subtle-action" type="button">Sluiten</button>
    </div>`
    : `<p><strong>Concept: ${escapeHtml(concept.name)}</strong> Geen van de orders staat nog open: ze zijn bezorgd, geannuleerd of verzonden.</p>
    <div class="concept-bar-actions">
      <button id="conceptBarRemove" class="button primary" type="button">Concept verwijderen</button>
      <button id="conceptBarClose" class="button subtle-action" type="button">Sluiten</button>
    </div>`;
  bar.querySelector("#conceptBarPlan")?.addEventListener("click", () => putRouteInHand(route, concept.id));
  bar.querySelector("#conceptBarRemove")?.addEventListener("click", () => removeConcept(concept));
  bar.querySelector("#conceptBarClose").addEventListener("click", closeConcept);
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
document.querySelectorAll(".logout-button").forEach((button) => button.addEventListener("click", logout));

document.querySelector("#refreshMobile")?.addEventListener("click", () => {
  operatorPromptDeclined = false;
  ensureOperatorKey();
  refreshData();
});

// The menu on the left switches views; the page always opens on Vandaag.
document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
  item.addEventListener("click", () => showView(item.dataset.view));
});

renderRules();
// The role this code had last time, straight away: a driver's phone opens on the
// driver's screen even before, or without, a connection to ask again.
try {
  const knownRole = storedOperatorKey() ? localStorage.getItem(roleStorageKey) : null;
  if (knownRole === "driver" || knownRole === "planner") applyRole(knownRole);
} catch {
  // Asked on the first refresh instead.
}
ensureOperatorKey();
refreshData();
// A screen out of view (a phone in a pocket, a tab behind another) asks for
// nothing. Coming back into view catches up, but not more than once a minute,
// and the full refresh (three list operations) at most every ten: someone
// switching between Shopify and this tab all day would otherwise use up the
// free plan's 1,000 list operations on tab switches alone.
let refreshTick = 0;
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  refreshTick += 1;
  // Until the routes have loaded once, every tick asks for them again.
  refreshData(refreshTick % 5 === 0 || !state.planLoaded);
}, CONFIG.refreshMs);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (Date.now() - (state.lastRefreshAt || 0) < 60_000) return;
  refreshData(!state.planLoaded || Date.now() - (state.lastFullAt || 0) > 10 * 60_000);
});
