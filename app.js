const CONFIG = {
  dataUrl: window.VERVOERSPLANNING_CONFIG?.dataUrl || "data/demo-orders.json",
  refreshMs: 60_000,
  depot: "Goorsteeg 46, Ede",
  vehicleCapacityKg: 3_500,
  apiBaseUrl: new URL(window.VERVOERSPLANNING_CONFIG?.dataUrl || "data/demo-orders.json", window.location.href).origin,
  maxRouteMinutes: 330,
  nearlyOverMinutes: 15,
};

const state = { orders: [], decisions: [], routes: [], history: [] };
const decisionLabels = { include: "Meenemen", review: "Controleren", exclude: "Niet meenemen" };

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
    ["Ritvoorstellen", state.routes.length, `${state.routes.reduce((sum, route) => sum + route.orders.length, 0)} stops verdeeld`],
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

  document.querySelector("#ordersBody").innerHTML = visible.map((item) => `<tr>
    <td><span class="order-id">${item.order.id}</span><span class="subtle">${item.order.customer}${item.order.webshop ? ` · ${item.order.webshop}` : ""}</span></td>
    <td>${item.order.city}<span class="subtle">${item.order.postcode}</span></td>
    <td>${formatDate(item.order.dueDate)}</td>
    <td><span class="badge ${item.decision}">${decisionLabels[item.decision]}</span></td>
    <td class="reason">${item.reason}</td>
  </tr>`).join("");
  document.querySelector("#emptyState").hidden = visible.length > 0;
}

function renderRoutes() {
  const holder = document.querySelector("#routes");
  const template = document.querySelector("#routeTemplate");
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
    fragment.querySelector(".route-stops").innerHTML = route.orders.map((order) => `<li><b>${order.city} · ${order.id}</b><span>${order.customer} · ${deliveryMinutes(order)} min lossen/laden <button class="mark-delivered" type="button" data-order-id="${encodeURIComponent(order.id)}">Bezorgd</button></span></li>`).join("");
    fragment.querySelectorAll(".mark-delivered").forEach((button) => {
      const order = route.orders.find((item) => encodeURIComponent(item.id) === button.dataset.orderId);
      button.addEventListener("click", () => markDelivered(order, button));
    });
    holder.appendChild(fragment);
  });
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
  const stops = [CONFIG.depot, ...orders.map((order) => `${order.postcode} ${order.city}`), CONFIG.depot];
  return `https://www.google.com/maps/dir/${stops.map((stop) => encodeURIComponent(stop)).join("/")}`;
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
    state.decisions = state.orders.map((order) => ({ order, ...decide(order) }));
    state.routes = buildRoutes(state.decisions.filter((item) => item.decision === "include"));
    renderSummary();
    renderOrders();
    renderRoutes();
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
refreshData();
setInterval(refreshData, CONFIG.refreshMs);
