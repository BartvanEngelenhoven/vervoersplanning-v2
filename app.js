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

const state = { orders: [], decisions: [], routes: [], history: [], selected: new Set(), manualRoute: null, suggestions: [], driveMinutes: null, driveDepot: "" };
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
const historyOpenKey = "vervoersplanning.historieOpen.v1";
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
const DEPOT_POINT = { lat: 52.05, lon: 5.67 };
const KM_TO_MINUTES = 1.15;
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
  return Math.max(20, Math.round(km * KM_TO_MINUTES));
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
  if (Number(order.deliveryMinutes)) return Number(order.deliveryMinutes);
  // Matched "houten hooihuisje" before, which the Shopify titles never say, so
  // every hay house was planned as a 20 minute drop.
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

function renderSummary() {
  const count = (key) => state.decisions.filter((item) => item.decision === key).length;
  const metrics = [
    ["Binnengekomen", state.orders.length, "Alle actuele orders"],
    ["Meenemen", count("include"), "Eigen vervoer"],
    ["Controleren", count("review"), "Menselijke beoordeling of optioneel"],
    ["DHL", count("dhl"), "Gaan als pakket"],
    ["Te ver", count("far"), "Passen op geen enkele rit"],
    ["Geselecteerd", state.selected.size, "Handmatig gekozen orders"],
  ];
  document.querySelector("#summary").innerHTML = metrics.map(([label, value, text]) => `<article class="metric"><span>${label}</span><strong>${value}</strong><small>${text}</small></article>`).join("");
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
    Rit ${index + 1}: ${item.region} · ${formatMinutes(item.totalMinutes)}
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
    <iframe title="Google Maps route ${route.region}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${googleMapsEmbedUrl(route.orders)}"></iframe>
  </div>
  <div class="map-side">
    <div class="map-route-picker">${routeButtons}</div>
    <div class="map-route-summary">
      <b>Rit ${activeMapRouteIndex + 1}: ${route.region}</b>
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
    <div><b>${index + 1}. ${route.region}</b><span>${route.orders.length} stops · rijden ${formatMinutes(route.driveMinutes)} · afleveren ${formatMinutes(route.deliveryMinutes)} · totaal ${formatMinutes(route.totalMinutes)}</span></div>
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
    fragment.querySelector(".route-name").textContent = route.region;
    fragment.querySelector(".route-meta").textContent = `${CONFIG.depot} · ${route.orders.length} stops · ruwe rijtijd ${formatMinutes(route.driveMinutes)}`;
    fragment.querySelector(".route-load").textContent = `${route.load.toLocaleString("nl-NL")} kg · afleveren ${formatMinutes(route.deliveryMinutes)} · totaal ${formatMinutes(route.totalMinutes)} · ${routeWarning(route)}`;
    fragment.querySelector(".route-map").href = googleMapsUrl(route.orders);
    fragment.querySelector(".route-stops").innerHTML = route.orders.map((order) => `<li><button class="remove-route-stop" type="button" data-order-key="${orderKey(order)}" aria-label="${order.id} uit deze rit halen">−</button><b>${order.city} · ${order.id}</b><span>${productSummary(order)} · ${deliveryMinutes(order)} min lossen/laden</span><span>${addressSummary(order)} · <a href="${singleOrderMapsUrl(order)}" target="_blank" rel="noreferrer">Maps</a> <button class="mark-delivered" type="button" data-order-id="${encodeURIComponent(order.id)}">Bezorgd</button></span></li>`).join("");
    fragment.querySelectorAll(".remove-route-stop").forEach((button) => {
      button.addEventListener("click", () => removeOrderFromRoute(button.dataset.orderKey, index));
    });
    fragment.querySelectorAll(".mark-delivered").forEach((button) => {
      const order = route.orders.find((item) => encodeURIComponent(item.id) === button.dataset.orderId);
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

function orderPoint(order) {
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
  button.textContent = "Verversen…";
  try {
    const separator = CONFIG.dataUrl.includes("?") ? "&" : "?";
    const response = await backendFetch(`${CONFIG.dataUrl}${separator}t=${Date.now()}`, { cache: "no-store" });
    if (response.status === 401) throw new Error("Operatorcode ontbreekt of klopt niet");
    if (!response.ok) throw new Error("Data kon niet worden geladen");
    const loaded = await response.json();
    state.orders = loaded.filter((order) => !(order.dueDate && order.dueDate < hideOrdersDueBefore));
    // Before rebuildPlanning, because the travel budgets are judged against these.
    state.driveMinutes = await fetchDriveMinutes(state.orders);
    state.history = await fetchHistory();
    rebuildPlanning();
    renderHistory();
    const klok = new Intl.DateTimeFormat("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
    const bron = state.driveMinutes ? "echte rijtijden" : "geschatte rijtijden";
    document.querySelector("#syncText").textContent = `Laatst ververst om ${klok} · ${bron}`;
  } catch (error) {
    document.querySelector("#syncText").textContent = `${error.message} — bestaande gegevens blijven staan`;
  } finally {
    button.disabled = false;
    button.textContent = "Nu verversen";
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
// The history is long and rarely the reason someone opens the planning, so it
// starts folded and then stays however this browser last left it.
const historyDetails = document.querySelector("#historyDetails");
if (historyDetails) {
  try {
    historyDetails.open = localStorage.getItem(historyOpenKey) === "open";
  } catch {
    historyDetails.open = false;
  }
  historyDetails.addEventListener("toggle", () => {
    try {
      localStorage.setItem(historyOpenKey, historyDetails.open ? "open" : "dicht");
    } catch {
      // A browser refusing storage just means the fold is not remembered.
    }
  });
}

ensureOperatorKey();
refreshData();
setInterval(refreshData, CONFIG.refreshMs);
