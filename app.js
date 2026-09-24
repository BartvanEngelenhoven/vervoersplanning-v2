const CONFIG = {
  dataUrl: window.VERVOERSPLANNING_CONFIG?.dataUrl || "data/demo-orders.json",
  refreshMs: 60_000,
  depot: "Goorsteeg 46, Ede",
  vehicleCapacityKg: 3_500,
  apiBaseUrl: new URL(window.VERVOERSPLANNING_CONFIG?.dataUrl || "data/demo-orders.json", window.location.href).origin,
  maxRouteMinutes: 330,
  nearlyOverMinutes: 15,
  farRouteCombineMinutes: 75,
  exceptionRouteMinutes: 480,
};

const state = { orders: [], decisions: [], routes: [], history: [], selected: new Set(), manualRoute: null, suggestions: [] };
const decisionLabels = { include: "Meenemen", review: "Controleren", exclude: "Niet meenemen" };
const forcedIncludeKey = "vervoersplanning.forceInclude.v1";
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

function decide(order) {
  if (order.cancelled) return { decision: "exclude", reason: "Order is geannuleerd" };
  if (order.fulfilled) return { decision: "exclude", reason: "Order is al volledig bezorgd" };
  if (order.deliveryMethod === "pickup") return { decision: "exclude", reason: "Klant haalt de bestelling af" };
  if (!order.requiresVanRoekelDelivery) return { decision: "exclude", reason: "Geen eigen bezorging nodig" };
  if (!order.addressComplete) return { decision: "review", reason: "Bezorgadres is onvolledig" };
  if (order.deliveryAppointmentLocked) return { decision: "review", reason: "Aflevermoment is afgestemd; niet verplaatsen zonder toestemming" };
  if (!order.paid) return { decision: "review", reason: "Betaling nog niet binnen; alleen optioneel meenemen als dit logisch op de route ligt" };
  return { decision: "include", reason: dueDateReason(order) };
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

function routeDriveMinutes(orders) {
  if (!orders.length) return 0;
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
  const products = String((order.products || []).join(" ")).toLowerCase();
  if (products.includes("houten hooihuisje") || products.includes("houten hoihuisje")) return 90;
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
    ["Meenemen", count("include"), "Automatisch geschikt"],
    ["Controleren", count("review"), "Menselijke beoordeling of optioneel"],
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
      addOrderToActiveRoute(order);
    });
  });
  holder.querySelectorAll(".remove-from-active-route").forEach((button) => {
    button.addEventListener("click", () => removeOrderFromActiveRoute(button.dataset.orderKey));
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
      button.addEventListener("click", () => removeOrderFromActiveRoute(button.dataset.orderKey));
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

async function addOrderToActiveRoute(order) {
  if (!order || !state.routes[activeMapRouteIndex]) return;
  if (!order.requiresVanRoekelDelivery) {
    const tagged = await forceInclude(order);
    if (!tagged) return;
    order.requiresVanRoekelDelivery = true;
    order.deliveryMethod = "delivery";
  }
  const route = state.routes[activeMapRouteIndex];
  const nextOrders = optimizedStopOrder([...route.orders.filter((item) => orderKey(item) !== orderKey(order)), order]);
  for (const item of nextOrders) forcedIncludes.add(orderKey(item));
  saveForcedIncludes();
  state.manualRoute = { orders: nextOrders };
  activeMapRouteIndex = 0;
  planningView = "map";
  rebuildPlanning();
}

function removeOrderFromActiveRoute(key) {
  if (!key || !state.routes[activeMapRouteIndex]) return;
  const route = state.routes[activeMapRouteIndex];
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
  const operatorKey = window.prompt(`Operatorcode voor ${orders.length} geselecteerde orders`);
  if (!operatorKey) return;
  if (!window.confirm(`${orders.length} geselecteerde orders als bezorgd melden?`)) return;

  for (const order of orders) {
    const response = await fetch(`${CONFIG.apiBaseUrl}/actions/mark-delivered`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-operator-key": operatorKey,
      },
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
  const operatorKey = window.prompt(`Operatorcode om ${order.id} als eigen bezorging te taggen in Shopify`);
  if (!operatorKey) return false;
  try {
    const response = await fetch(`${CONFIG.apiBaseUrl}/actions/set-own-delivery`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-operator-key": operatorKey,
      },
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

function rebuildPlanning() {
  state.decisions = state.orders.map((order) => ({ order, ...applyManualDecision(order, decide(order)) }));
  state.routes = buildRoutes(state.decisions.filter((item) => item.decision === "include"));
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
  const operatorKey = window.prompt(`Operatorcode voor ${order.id}`);
  if (!operatorKey) return;
  button.disabled = true;
  button.textContent = "Bezig…";
  try {
    const response = await fetch(`${CONFIG.apiBaseUrl}/actions/mark-delivered`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-operator-key": operatorKey,
      },
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
  const operatorKey = window.prompt(`Terugdraaien voor ${id}. Operatorcode:`);
  if (!operatorKey) return;
  if (!window.confirm(`${id} terugzetten naar open en Shopify fulfillment proberen te annuleren?`)) return;
  button.disabled = true;
  button.textContent = "Bezig…";
  try {
    const response = await fetch(`${CONFIG.apiBaseUrl}/actions/undo-delivered`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-operator-key": operatorKey,
      },
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

async function refreshData() {
  const button = document.querySelector("#refreshButton");
  button.disabled = true;
  button.textContent = "Verversen…";
  try {
    const separator = CONFIG.dataUrl.includes("?") ? "&" : "?";
    const response = await fetch(`${CONFIG.dataUrl}${separator}t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Data kon niet worden geladen");
    state.orders = await response.json();
    state.history = await fetchHistory();
    rebuildPlanning();
    renderHistory();
    document.querySelector("#syncText").textContent = `Laatst ververst om ${new Intl.DateTimeFormat("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date())}`;
  } catch (error) {
    document.querySelector("#syncText").textContent = "Verversen mislukt — bestaande gegevens blijven staan";
  } finally {
    button.disabled = false;
    button.textContent = "Nu verversen";
  }
}

async function fetchHistory() {
  try {
    const response = await fetch(`${CONFIG.apiBaseUrl}/history?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

document.querySelector("#refreshButton").addEventListener("click", refreshData);
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
refreshData();
setInterval(refreshData, CONFIG.refreshMs);
