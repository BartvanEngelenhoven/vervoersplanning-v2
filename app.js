const CONFIG = {
  dataUrl: window.VERVOERSPLANNING_CONFIG?.dataUrl || "data/demo-orders.json",
  refreshMs: 60_000,
  depot: "Goorsteeg 46, Ede",
  vehicleCapacityKg: 3_500,
};

const state = { orders: [], decisions: [], routes: [] };
const decisionLabels = { include: "Meenemen", review: "Controleren", exclude: "Niet meenemen" };

function decide(order) {
  if (order.cancelled) return { decision: "exclude", reason: "Order is geannuleerd" };
  if (order.fulfilled) return { decision: "exclude", reason: "Order is al volledig bezorgd" };
  if (order.deliveryMethod === "pickup") return { decision: "exclude", reason: "Klant haalt de bestelling af" };
  if (!order.paid) return { decision: "exclude", reason: "Betaling ontbreekt" };
  if (!order.requiresVanRoekelDelivery) return { decision: "exclude", reason: "Geen eigen bezorging nodig" };
  if (!order.addressComplete) return { decision: "review", reason: "Bezorgadres is onvolledig" };
  if (!order.weightKg) return { decision: "review", reason: "Gewicht ontbreekt voor ritberekening" };
  return { decision: "include", reason: order.dueDate ? `Bezorgorder, uiterlijk ${formatDate(order.dueDate)}` : "Geldige bezorgorder" };
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
    orders.sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || b.weightKg - a.weightKg);
    let current = [];
    let load = 0;
    for (const order of orders) {
      if (current.length && load + order.weightKg > CONFIG.vehicleCapacityKg) {
        routes.push({ region, orders: current, load });
        current = [];
        load = 0;
      }
      current.push(order);
      load += order.weightKg;
    }
    if (current.length) routes.push({ region, orders: current, load });
  }
  return routes;
}

function formatDate(value) {
  if (!value) return "Niet ingevuld";
  return new Intl.DateTimeFormat("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function renderSummary() {
  const count = (key) => state.decisions.filter((item) => item.decision === key).length;
  const metrics = [
    ["Binnengekomen", state.orders.length, "Alle actuele orders"],
    ["Meenemen", count("include"), "Automatisch geschikt"],
    ["Controleren", count("review"), "Menselijke beoordeling"],
    ["Ritvoorstellen", state.routes.length, `${state.routes.reduce((sum, route) => sum + route.orders.length, 0)} stops verdeeld`],
  ];
  document.querySelector("#summary").innerHTML = metrics.map(([label, value, text]) => `<article class="metric"><span>${label}</span><strong>${value}</strong><small>${text}</small></article>`).join("");
}

function renderOrders() {
  const term = document.querySelector("#searchInput").value.trim().toLowerCase();
  const filter = document.querySelector("#decisionFilter").value;
  const visible = state.decisions.filter((item) => {
    const haystack = [item.order.id, item.order.customer, item.order.city, item.order.postcode, item.order.products.join(" ")].join(" ").toLowerCase();
    return (!term || haystack.includes(term)) && (filter === "all" || item.decision === filter);
  });

  document.querySelector("#ordersBody").innerHTML = visible.map((item) => `<tr>
    <td><span class="order-id">${item.order.id}</span><span class="subtle">${item.order.customer}</span></td>
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
    fragment.querySelector(".route-meta").textContent = `${CONFIG.depot} · ${route.orders.length} stops`;
    fragment.querySelector(".route-load").textContent = `${route.load.toLocaleString("nl-NL")} kg van ${CONFIG.vehicleCapacityKg.toLocaleString("nl-NL")} kg`;
    fragment.querySelector(".route-stops").innerHTML = route.orders.map((order) => `<li><b>${order.city} · ${order.id}</b><span>${order.customer} · ${order.weightKg.toLocaleString("nl-NL")} kg</span></li>`).join("");
    holder.appendChild(fragment);
  });
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
    state.decisions = state.orders.map((order) => ({ order, ...decide(order) }));
    state.routes = buildRoutes(state.decisions.filter((item) => item.decision === "include"));
    renderSummary();
    renderOrders();
    renderRoutes();
    document.querySelector("#syncText").textContent = `Laatst ververst om ${new Intl.DateTimeFormat("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date())}`;
  } catch (error) {
    document.querySelector("#syncText").textContent = "Verversen mislukt — bestaande gegevens blijven staan";
  } finally {
    button.disabled = false;
    button.textContent = "Nu verversen";
  }
}

document.querySelector("#refreshButton").addEventListener("click", refreshData);
document.querySelector("#searchInput").addEventListener("input", renderOrders);
document.querySelector("#decisionFilter").addEventListener("change", renderOrders);
refreshData();
setInterval(refreshData, CONFIG.refreshMs);
