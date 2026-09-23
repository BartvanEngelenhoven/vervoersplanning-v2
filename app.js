const CONFIG = {
  dataUrl: window.VERVOERSPLANNING_CONFIG?.dataUrl || "data/demo-orders.json",
  refreshMs: 60_000,
  depot: "Goorsteeg 46, Ede",
  vehicleCapacityKg: 3_500,
  apiBaseUrl: new URL(window.VERVOERSPLANNING_CONFIG?.dataUrl || "data/demo-orders.json", window.location.href).origin,
  maxRouteMinutes: 330,
  nearlyOverMinutes: 15,
};

const state = { orders: [], decisions: [], routes: [], history: [], selected: new Set(), manualRoute: null, suggestions: [] };
const decisionLabels = { include: "Meenemen", review: "Controleren", exclude: "Niet meenemen" };
const forcedIncludeKey = "vervoersplanning.forceInclude.v1";
const businessClasses = {
  "De Rijplaten Specialist": "rijplaten",
  "De Slowfeeder Specialist": "slowfeeder",
};
const forcedIncludes = new Set(JSON.parse(localStorage.getItem(forcedIncludeKey) || "[]"));

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
  const prefix = Number(String(order.postcode).slice(0, 2));
  if (prefix >= 10 && prefix <= 39) return "West & Midden";
  if (prefix >= 40 && prefix <= 59) return "Midden & Zuid";
  if (prefix >= 60 && prefix <= 79) return "Oost";
  return "Noord";
}

function buildRoutes(included) {
  if (state.manualRoute?.orders?.length) {
    return [routeSummary("Handmatige selectie", state.manualRoute.orders, state.manualRoute.load, state.manualRoute.deliveryMinutes)];
  }
  const groups = new Map();
  for (const item of included) {
    const region = regionFor(item.order);
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push(item.order);
  }

  const routes = [];
  for (const [region, orders] of groups) {
    orders.sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || deliveryMinutes(b) - deliveryMinutes(a));
    let current = [];
    let load = 0;
    let deliveryTotal = 0;
    for (const order of orders) {
      const weight = Number(order.weightKg || 0);
      if (current.length && load + weight > CONFIG.vehicleCapacityKg) {
        routes.push(routeSummary(region, current, load, deliveryTotal));
        current = [];
        load = 0;
        deliveryTotal = 0;
      }
      current.push(order);
      load += weight;
      deliveryTotal += deliveryMinutes(order);
    }
    if (current.length) routes.push(routeSummary(region, current, load, deliveryTotal));
  }
  return routes;
}

function routeSummary(region, orders, load, deliveryMinutesTotal) {
  const driveEstimate = Math.max(60, orders.length * 35);
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

function deliveryMinutes(order) {
  if (Number(order.deliveryMinutes)) return Number(order.deliveryMinutes);
  const products = String((order.products || []).join(" ")).toLowerCase();
  if (products.includes("houten hooihuisje") || products.includes("houten hoihuisje")) return 90;
  return 20;
}

function routeWarning(route) {
  if (!route.overByMinutes) return "Binnen 5:30 uur op basis van ruwe schatting";
  if (route.overByMinutes <= CONFIG.nearlyOverMinutes) return `Bijna passend: ${route.overByMinutes} min boven 5:30 uur`;
  return `Te lang: ${route.overByMinutes} min boven 5:30 uur; apart plannen of uitzondering bespreken`;
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

function renderOrders() {
  const term = document.querySelector("#searchInput").value.trim().toLowerCase();
  const filter = document.querySelector("#decisionFilter").value;
  const visible = state.decisions.filter((item) => {
    const haystack = [item.order.id, item.order.webshop, item.order.customer, item.order.city, item.order.postcode, item.order.products.join(" ")].join(" ").toLowerCase();
    return (!term || haystack.includes(term)) && (filter === "all" || item.decision === filter);
  });

  document.querySelector("#ordersBody").innerHTML = visible.map((item) => orderCard(item)).join("");
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

function orderCard(item) {
  const order = item.order;
  const key = orderKey(order);
  const isForced = forcedIncludes.has(key);
  return `<article class="order-card">
    <div class="order-main">
      <div class="order-title-row">
        <label class="select-order"><input class="order-select" type="checkbox" data-order-key="${key}" ${state.selected.has(key) ? "checked" : ""} /><span>Selecteer</span></label>
        <span class="shop-chip ${businessClass(order)}">${order.webshop || "Webshop"}</span>
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
    fragment.querySelector(".route-stops").innerHTML = route.orders.map((order) => `<li><b>${order.city} · ${order.id}</b><span>${productSummary(order)} · ${deliveryMinutes(order)} min lossen/laden</span><span>${addressSummary(order)} · <a href="${singleOrderMapsUrl(order)}" target="_blank" rel="noreferrer">Maps</a> <button class="mark-delivered" type="button" data-order-id="${encodeURIComponent(order.id)}">Bezorgd</button></span></li>`).join("");
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
  const routeRegions = new Set(routeOrders.map(regionFor));
  const routePrefixes = new Set(routeOrders.map((order) => String(order.postcode || "").slice(0, 2)).filter(Boolean));
  const routeKeys = new Set(routeOrders.map(orderKey));
  return state.decisions
    .filter((item) => !routeKeys.has(orderKey(item.order)) && item.decision !== "include" && !state.selected.has(orderKey(item.order)))
    .map((item) => item.order)
    .filter((order) => routeRegions.has(regionFor(order)) || routePrefixes.has(String(order.postcode || "").slice(0, 2)))
    .slice(0, 4);
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
    <div><b>${item.id}</b><span>${item.order?.customer || "Onbekende klant"} · ${item.order?.webshop || item.shopDomain}</span><small>Bezorgd gemeld: ${formatDateTime(item.deliveredAt)}</small></div>
    <button class="button ghost undo-delivered" type="button" data-order-id="${encodeURIComponent(item.id)}" data-shop-domain="${encodeURIComponent(item.shopDomain)}">Terugdraaien</button>
  </article>`).join("");
  holder.querySelectorAll(".undo-delivered").forEach((button) => {
    button.addEventListener("click", () => undoDelivered(decodeURIComponent(button.dataset.orderId), decodeURIComponent(button.dataset.shopDomain), button));
  });
}

function googleMapsUrl(orders) {
  const stops = [CONFIG.depot, ...orders.map((order) => order.fullAddress || `${order.postcode} ${order.city}`), CONFIG.depot];
  return `https://www.google.com/maps/dir/${stops.map((stop) => encodeURIComponent(stop)).join("/")}`;
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

function orderKey(order) {
  return `${order.shopDomain || ""}:${order.id}`;
}

function saveForcedIncludes() {
  localStorage.setItem(forcedIncludeKey, JSON.stringify([...forcedIncludes]));
}

async function forceInclude(order) {
  if (!order) return;
  const operatorKey = window.prompt(`Operatorcode om ${order.id} als eigen bezorging te taggen in Shopify`);
  if (!operatorKey) return;
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
  } catch (error) {
    window.alert(error.message);
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
refreshData();
setInterval(refreshData, CONFIG.refreshMs);
