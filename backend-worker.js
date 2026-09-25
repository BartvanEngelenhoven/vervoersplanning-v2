/**
 * Vervoersplanning V2 backend template for Cloudflare Workers.
 *
 * Purpose:
 * - receive Shopify order webhooks on /webhooks/shopify/orders
 * - verify the Shopify HMAC signature
 * - store only the fields needed by the public dashboard
 * - expose sanitized planning data on /orders
 *
 * Required Worker bindings / secrets:
 * - SHOPIFY_WEBHOOK_SECRET: fallback Shopify webhook signing secret
 * - SHOPIFY_WEBHOOK_SECRET_<SHOP_DOMAIN>: optional per-shop secret, for example SHOPIFY_WEBHOOK_SECRET_SLOWFEEDER_SPECIALIST_MYSHOPIFY_COM
 * - PLANNING_ORDERS: Cloudflare KV namespace
 * - CORS_ORIGIN: optional, for example https://bartvanengelenhoven.github.io
 * - OPERATOR_KEY: the planner's code; opens everything
 * - DRIVER_KEY: optional driver's code; opens the day's routes, reporting deliveries,
 *   taking a parcel along and breaking a route off, but no planning
 * - SHOPIFY_CLIENT_ID: Shopify app client ID, required for OAuth install
 * - SHOPIFY_CLIENT_SECRET: Shopify app secret, required for OAuth install
 * - SHOPIFY_CLIENT_ID_<SHOP_DOMAIN>: optional per-shop Shopify app client ID
 * - SHOPIFY_CLIENT_SECRET_<SHOP_DOMAIN>: optional per-shop Shopify app secret
 * - SHOPIFY_ADMIN_TOKEN_<SHOP_DOMAIN>: optional legacy per-shop Admin API token for marking orders fulfilled
 * - GOOGLE_MAPS_API_KEY: leave unset. Google's routing is paid; the planning uses PDOK
 *   and its own fitted estimate, which are free.
 * - AUTO_FULFILL: "aan" to announce routes in Shopify at 16:00 the day before, with the
 *   customer's shipping mail. Anything else, or unset, runs it as a trial that only reports.
 *   Set it as a secret (wrangler secret put), which survives deploys; a dashboard
 *   variable is wiped by the next deploy.
 *
 * What is kept, and for how long:
 * - order:<shop>:<id>      open orders, while open. A cancelled one stays 14 days so a
 *                          planned route can say "geannuleerd" instead of "not found".
 * - delivered:<shop>:<id>  60 days, without phone or customer note, for undo and the
 *                          driver's "bezorgd" ticks.
 * - plan:<date>:<id>       until 60 days after the route's date.
 * - geo:<address>          90 days (a point), 7 days (a miss).
 */

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const SHOPIFY_API_VERSION = "2026-07";
const DAY_SECONDS = 24 * 3600;
const DELIVERED_TTL = 60 * DAY_SECONDS;
const CANCELLED_TTL = 14 * DAY_SECONDS;
const PLAN_KEEP_DAYS = 60;
// Orders due before the planning went live were cleared from sight once; the
// frontend hides them for the planner, and a driver is never sent them at all.
const HIDE_ORDERS_DUE_BEFORE = "2026-09-24";
// The two shops this planning serves. Installing the Shopify app is only ever
// offered for these, so a stranger cannot start an install for a shop of theirs.
const KNOWN_SHOPS = ["de-rijplaten-specialist.myshopify.com", "slowfeeder-specialist.myshopify.com"];
// Set for a minute while the Bezorgd button reports an order, so Shopify's own
// webhook for that fulfillment does not write over the report.
const REPORTING_PREFIX = "reporting:";
// The same drive-time model as the planning in app.js, for the one check the
// Worker makes itself: a stop the driver adds must keep the day within 5:45.
const DEPOT_POINT = { lat: 52.07309, lon: 5.63884 };
const DAY_LIMIT_MINUTES = 345;

export default {
  // The announcement at 16:00 the day before a route. Cron runs in UTC, so it
  // fires at 14:00 and 15:00 UTC and only the one that is 16:00 in Amsterdam
  // goes ahead: 14:00 in summer time, 15:00 in winter time. A second trigger ten
  // minutes later picks up whatever the first could not finish or got refused.
  async scheduled(event, env) {
    const now = amsterdamNow(new Date(event.scheduledTime));
    if (now.hour !== ANNOUNCE_HOUR) return;
    const date = nextDay(now.day);
    const logKey = `${ANNOUNCE_LOG_PREFIX}${date}`;
    const report = { date, ranAt: new Date().toISOString(), mode: announceLive(env) ? "echt" : "proef", routes: [] };
    try {
      await runAnnouncement(env, date, { report });
    } catch (error) {
      report.error = String(error?.message || error).slice(0, 200);
    } finally {
      // Written whatever happened, so the agenda never shows a silent gap.
      const earlier = now.minute >= 10 ? await env.PLANNING_ORDERS.get(logKey, "json").catch(() => null) : null;
      await env.PLANNING_ORDERS.put(logKey, JSON.stringify(mergeAnnounceReports(earlier, report)), { expirationTtl: 60 * DAY_SECONDS });
    }
  },

  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      // Without this a thrown error comes back as a bare 500 with no CORS
      // headers, and the browser reports only "Failed to fetch" instead of
      // anything the planner could act on.
      console.error(error);
      return json({ error: "Er ging iets mis op de server. Probeer het zo opnieuw." }, 500, env);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  if (request.method === "GET" && url.pathname === "/orders") {
    return getOrders(request, env);
  }

  if (request.method === "GET" && url.pathname === "/history") {
    return getHistory(request, env);
  }

  if (request.method === "GET" && url.pathname === "/auth/shopify") {
    return startShopifyOAuth(request, env);
  }

  if (request.method === "GET" && url.pathname === "/auth/shopify/callback") {
    return finishShopifyOAuth(request, env);
  }

  if (request.method === "POST" && url.pathname === "/webhooks/shopify/orders") {
    return receiveShopifyOrder(request, env);
  }

  if (request.method === "POST" && url.pathname === "/actions/mark-delivered") {
    return markDelivered(request, env);
  }

  if (request.method === "POST" && url.pathname === "/actions/undo-delivered") {
    return undoDelivered(request, env);
  }

  if (request.method === "POST" && url.pathname === "/actions/set-own-delivery") {
    return setOwnDelivery(request, env);
  }

  if (request.method === "POST" && url.pathname === "/actions/sync-shopify") {
    return syncShopify(request, env);
  }

  if (request.method === "POST" && url.pathname === "/routes/estimate") {
    return estimateRoute(request, env);
  }

  if (request.method === "POST" && url.pathname === "/geo") {
    return geocodeAddresses(request, env);
  }

  if (request.method === "GET" && url.pathname === "/plan") {
    return getPlan(request, env);
  }

  if (request.method === "POST" && url.pathname === "/plan/assign") {
    return assignPlanRoute(request, env);
  }

  if (request.method === "POST" && url.pathname === "/plan/remove") {
    return removePlanRoute(request, env);
  }

  if (request.method === "GET" && url.pathname === "/announce/preview") {
    const denied = plannerOnly(request, env);
    if (denied) return denied;
    const date = url.searchParams.get("date");
    if (!isPlanDate(date)) return json({ error: "date moet JJJJ-MM-DD zijn" }, 400, env);
    const report = { date, ranAt: new Date().toISOString(), mode: "proef", routes: [] };
    await runAnnouncement(env, date, { preview: true, report });
    return json({ report, live: announceLive(env) }, 200, env);
  }

  if (request.method === "POST" && url.pathname === "/concepts/save") {
    return saveConcept(request, env);
  }

  if (request.method === "POST" && url.pathname === "/concepts/remove") {
    return removeConcept(request, env);
  }

  if (request.method === "POST" && url.pathname === "/plan/remove-stop") {
    return removePlanStop(request, env);
  }

  if (request.method === "GET" && url.pathname === "/whoami") {
    const role = roleFor(request, env);
    return role ? json({ role }, 200, env) : json({ error: "Unauthorized" }, 401, env);
  }

  if (request.method === "POST" && url.pathname === "/plan/add-stop") {
    return addPlanStop(request, env);
  }

  if (request.method === "POST" && url.pathname === "/plan/abort") {
    return abortPlanRoute(request, env);
  }

  if (request.method === "POST" && url.pathname === "/plan/note") {
    return setPlanNote(request, env);
  }

  if (request.method === "POST" && url.pathname === "/plan/day-note") {
    return setDayNote(request, env);
  }

  return json({ error: "Not found" }, 404, env);
}

// Every key under a prefix. One list call returns at most 1,000 keys; without
// following the cursor the newest routes and deliveries, which sort last, were
// the first to silently fall off. Past 1,000 this costs one more list call.
async function listAll(env, prefix) {
  const keys = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const result = await env.PLANNING_ORDERS.list({ prefix, cursor });
    keys.push(...result.keys);
    if (result.list_complete || !result.cursor) break;
    cursor = result.cursor;
  }
  return keys;
}

// What the driver's phone needs of an order that is not one of their stops: enough
// to weigh "can it come along", nothing to identify the customer by. Name, street,
// phone and note only reach the phone for stops of their own routes, via /plan.
const DRIVER_ORDER_FIELDS = ["id", "shopifyOrderId", "shopDomain", "webshop", "city", "dueDate", "paid", "paymentStatus", "refunded", "cancelled", "fulfilled", "deliveryMethod", "addressComplete", "deliveryAppointmentLocked", "weightKg", "products", "announced", "ownDeliveryTagged"];

function orderCountry(order) {
  if (order.country) return String(order.country);
  const last = String(order.fullAddress || "").split(",").pop().trim();
  return /^(nl|netherlands|nederland)$/i.test(last) ? "NL" : /^(be|belgium|belgi[eë])$/i.test(last) ? "BE" : last;
}

function geoKeyForOrder(order) {
  return `${GEO_PREFIX}${normalizeAddress(order.fullAddress || `${order.postcode || ""} ${order.city || ""}`).toLowerCase()}`;
}

async function getOrders(request, env) {
  const role = roleFor(request, env);
  if (!role) return unauthorized(env);

  const keys = await listAll(env, "order:");
  // A key listed a moment ago can be gone by the time it is read, when a
  // webhook deletes a delivered order in between. That reads as null, and one
  // null used to take the whole list down with it.
  let orders = (await Promise.all(
    keys.map((key) => env.PLANNING_ORDERS.get(key.name, "json"))
  )).filter(Boolean);
  orders.sort((a, b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31"));

  if (role === "driver") {
    // Cancelled ones stay in (without anything personal), so a stop in the
    // driver's route can say "geannuleerd, niet afleveren" within one refresh.
    orders = orders.filter((order) => !order.fulfilled);
    orders = await Promise.all(orders.map(async (order) => {
      const slim = Object.fromEntries(DRIVER_ORDER_FIELDS.filter((field) => field in order).map((field) => [field, order[field]]));
      slim.postcode = String(order.postcode || "").replace(/\s+/g, "").slice(0, 4);
      slim.country = orderCountry(order);
      // The point from the address cache, so the phone can weigh the detour
      // without holding the address. Rounded to about a kilometre: a point to
      // eight decimals is a house, and PDOK turns a house back into an address.
      // A kilometre costs the detour sum a minute or two, no more.
      const point = await env.PLANNING_ORDERS.get(geoKeyForOrder(order), "json").catch(() => null);
      if (point && !point.miss) slim.point = { lat: Math.round(point.lat * 100) / 100, lon: Math.round(point.lon * 100) / 100 };
      return slim;
    }));
  }
  return json(orders, 200, env);
}

// The history screen shows the fifty newest deliveries. The newest are found from
// the key listing alone (each key carries its delivery time as metadata), so only
// those fifty are read, not every delivery on record. Planned stops asked for by
// key come back as a key-to-time map, so a stop delivered a week ago still shows
// as delivered and not as "not found".
async function getHistory(request, env) {
  const role = roleFor(request, env);
  if (!role) return unauthorized(env);

  const url = new URL(request.url);
  const asked = new Set(String(url.searchParams.get("keys") || "").split(",").map((key) => key.trim()).filter(Boolean).slice(0, 200));
  const listed = await listAll(env, "delivered:");
  const delivered = {};
  for (const key of listed) {
    const orderKey = key.name.slice("delivered:".length);
    if (asked.has(orderKey)) delivered[orderKey] = key.metadata?.deliveredAt || "";
  }
  const legacy = !url.searchParams.has("keys");
  if (role === "driver") return json(legacy ? [] : { entries: [], delivered }, 200, env);

  const withTime = listed.filter((key) => key.metadata?.deliveredAt);
  const newest = withTime
    .sort((a, b) => String(b.metadata.deliveredAt).localeCompare(String(a.metadata.deliveredAt)))
    .slice(0, 50);
  let entries = (await Promise.all(newest.map((key) => env.PLANNING_ORDERS.get(key.name, "json")))).filter(Boolean);
  // Deliveries written before the time went into the metadata have to be read
  // to be placed. Only while the newer ones do not fill the screen yet.
  if (newest.length < 50) {
    const older = listed.filter((key) => !key.metadata?.deliveredAt).slice(0, 200);
    entries = [...entries, ...(await Promise.all(older.map((key) => env.PLANNING_ORDERS.get(key.name, "json")))).filter(Boolean)];
  }
  entries.sort((a, b) => String(b.deliveredAt || "").localeCompare(String(a.deliveredAt || "")));
  return json(legacy ? entries.slice(0, 50) : { entries: entries.slice(0, 50), delivered }, 200, env);
}

// A delivery on record: sixty days, with the time in the key's metadata so the
// history can find the newest without reading everything. Phone and customer note
// are left out; they served the driver at the door and nobody after.
async function putDelivered(env, key, record) {
  const order = record.order ? { ...record.order } : null;
  if (order) {
    delete order.phone;
    delete order.customerNote;
  }
  // One clock for everything: Shopify writes "+02:00", the Worker "Z", and as
  // text the two sort up to two hours wrong in the history.
  const deliveredAt = shopifyTime(record.deliveredAt) || new Date().toISOString();
  const value = JSON.stringify({ ...record, deliveredAt, order });
  const options = { expirationTtl: DELIVERED_TTL, metadata: { deliveredAt } };
  try {
    await env.PLANNING_ORDERS.put(`delivered:${key}`, value, options);
  } catch {
    // KV takes one write per key per second, and Shopify's webhook for the
    // same order can land in that second.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await env.PLANNING_ORDERS.put(`delivered:${key}`, value, options);
  }
}

// What is kept of an order Shopify shipped that never went with the van (a DHL
// parcel, a pickup): enough for the history line and the out-of-order check,
// no name or address. Those stay in Shopify, where they belong.
function shippedElsewhere(order) {
  return { id: order.id, webshop: order.webshop, city: order.city, products: order.products };
}

async function receiveShopifyOrder(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-shopify-hmac-sha256") || "";
  const shopDomain = normalizeShopDomain(request.headers.get("x-shopify-shop-domain"));
  const webhookSecret = shopifyWebhookSecret(env, shopDomain);

  if (!(await verifyShopifyWebhook(rawBody, signature, webhookSecret))) {
    return json({ error: "Invalid Shopify signature" }, 401, env);
  }

  const shopifyOrder = JSON.parse(rawBody);
  const planningOrder = await storeShopifyOrder(env, shopifyOrder, shopDomain);

  return json({ ok: true, id: planningOrder.id }, 200, env);
}

async function storeShopifyOrder(env, shopifyOrder, shopDomain) {
  const planningOrder = mapShopifyOrder(shopifyOrder, shopDomain);
  const storageKey = orderStorageKey(planningOrder);
  const key = `${shopDomain}:${planningOrder.id}`;
  const historyKey = `delivered:${key}`;
  const announcedKey = `${ANNOUNCED_PREFIX}${key}`;
  const [storedOrder, history, announced, reporting] = await Promise.all([
    env.PLANNING_ORDERS.get(storageKey, "json"),
    env.PLANNING_ORDERS.get(historyKey, "json"),
    env.PLANNING_ORDERS.get(announcedKey, "json"),
    env.PLANNING_ORDERS.get(`${REPORTING_PREFIX}${key}`),
  ]);

  // Shopify does not promise webhooks arrive in order, and one that failed is
  // sent again hours later with its old contents. Whatever is on record from a
  // later moment wins; an older payload changes nothing.
  const incoming = planningOrder.shopifyUpdatedAt || "";
  const onRecord = storedOrder?.shopifyUpdatedAt || history?.shopifyUpdatedAt || "";
  if (incoming && onRecord && incoming < onRecord) return planningOrder;

  if (planningOrder.fulfilled) {
    // Shopify answers the Bezorgd button's fulfillment with this webhook, often
    // before the button's own record is written. That record, with the
    // fulfillment undo needs, is on its way: this one steps aside.
    if (reporting) return planningOrder;
    // Fulfilled by our own announcement the day before is not delivered: the
    // order stays on the planning, marked, until the driver reports it.
    if (announced) {
      await env.PLANNING_ORDERS.put(storageKey, JSON.stringify({ ...planningOrder, fulfilled: false, announced: true, announcedAt: announced.at }));
      return planningOrder;
    }
    // Reported through the planning already: that record holds the fulfillment
    // it made, which undo needs, and the real time of delivery. The webhook that
    // follows the report only refreshes the order details.
    if (history && history.source !== "shopify") {
      await putDelivered(env, key, { ...history, order: { ...(history.order || {}), ...planningOrder }, shopifyUpdatedAt: incoming || history.shopifyUpdatedAt });
      if (storedOrder) await env.PLANNING_ORDERS.delete(storageKey);
      return planningOrder;
    }
    const merged = storedOrder ? { ...storedOrder, ...planningOrder } : planningOrder;
    // Went with the van: rijplaten always do, and a slowfeeder order only when
    // it carries the own-delivery tag or was announced. (The shipping line says
    // "Bezorgen" for DHL parcels too, so it says nothing here.)
    const ownDelivery = shopDomain.includes("rijplaten") || merged.ownDeliveryTagged || merged.announced;
    await putDelivered(env, key, {
      id: planningOrder.id,
      shopDomain,
      shopifyOrderId: planningOrder.shopifyOrderId,
      order: ownDelivery ? merged : shippedElsewhere(merged),
      fulfillment: null,
      deliveredAt: history?.deliveredAt || shopifyFulfilledAt(shopifyOrder) || new Date().toISOString(),
      source: "shopify",
      shopifyUpdatedAt: incoming,
    });
    if (storedOrder) await env.PLANNING_ORDERS.delete(storageKey);
    return planningOrder;
  }

  // Not (or no longer fully) fulfilled while an announcement marker stands: the
  // fulfillment was undone in Shopify, or items were added since. The marker no
  // longer tells the truth, so it goes, and the order is open like any other.
  if (announced) await env.PLANNING_ORDERS.delete(announcedKey);

  if (planningOrder.cancelled) {
    // Kept a fortnight, so a route it sat in says "geannuleerd, niet afleveren".
    await env.PLANNING_ORDERS.put(storageKey, JSON.stringify(planningOrder), { expirationTtl: CANCELLED_TTL });
  } else {
    await env.PLANNING_ORDERS.put(storageKey, JSON.stringify(planningOrder));
  }
  if (history) await env.PLANNING_ORDERS.delete(historyKey);
  return planningOrder;
}

// Puts an order on fulfilled in Shopify. Shared by the Bezorgd button, which
// never mails the customer, and the announcement the day before, which does.
//
// Shopify prices a query before running it and refuses anything over 1,000
// points. Twenty fulfillment orders of a hundred lines each came to 2,063, so
// every call was turned away; ten of fifty is about 530, and no order of these
// shops comes near either number.
//
// The result says how sure it is: `ambiguous` means the fulfillment request went
// out and no answer came back, so Shopify may or may not have made it (and mailed
// the customer). Everything else is certain either way.
const SHOPIFY_FULFILLMENT_ERRORS = {
  "no-lines": "Deze order heeft in Shopify geen open regels meer.",
  "user": "Shopify weigerde de order op verzonden te zetten.",
};

async function createShopifyFulfillment(shopDomain, token, shopifyOrderId, notifyCustomer) {
  const lookup = await shopifyGraphql(shopDomain, token, `
    query FulfillmentOrders($id: ID!) {
      order(id: $id) {
        displayFulfillmentStatus
        fulfillmentOrders(first: 10) {
          nodes {
            id
            status
            lineItems(first: 50) {
              nodes { id remainingQuantity }
            }
          }
        }
      }
    }
  `, { id: shopifyOrderId });

  const order = lookup.data?.order;
  const nodes = order?.fulfillmentOrders?.nodes || [];
  const lineItemsByFulfillmentOrder = nodes
    .filter((node) => !["CLOSED", "CANCELLED"].includes(node.status))
    .map((node) => ({
      fulfillmentOrderId: node.id,
      fulfillmentOrderLineItems: (node.lineItems?.nodes || [])
        .filter((item) => Number(item.remainingQuantity) > 0)
        .map((item) => ({ id: item.id, quantity: Number(item.remainingQuantity) })),
    }))
    .filter((item) => item.fulfillmentOrderLineItems.length);

  if (!lineItemsByFulfillmentOrder.length) {
    // Nothing left to fulfill because it already is: someone did it in Shopify,
    // or the announcement did. That is the outcome asked for, not an error.
    if (order?.displayFulfillmentStatus === "FULFILLED") return { fulfillment: null, alreadyFulfilled: true };
    return { error: SHOPIFY_FULFILLMENT_ERRORS["no-lines"], status: 409 };
  }

  let result;
  try {
    result = await shopifyGraphql(shopDomain, token, `
      mutation Fulfill($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          fulfillment { id status }
          userErrors { field message }
        }
      }
    `, { fulfillment: { lineItemsByFulfillmentOrder, notifyCustomer: Boolean(notifyCustomer) } });
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 200), status: 502, ambiguous: true };
  }

  const userErrors = result.data?.fulfillmentCreate?.userErrors || [];
  if (userErrors.length) {
    const detail = userErrors.map((item) => item.message).filter(Boolean).join("; ");
    return { error: `${SHOPIFY_FULFILLMENT_ERRORS.user}${detail ? ` (${detail})` : ""}`, userErrors, status: 422 };
  }
  return { fulfillment: result.data?.fulfillmentCreate?.fulfillment || null };
}

// Planned stops from `from` to `to` (inclusive), as order key -> route. Used to
// hold the driver to their own routes and to keep one order out of two routes.
// Orders held by a concept, as order key -> concept.
async function conceptStops(env) {
  const names = (await listAll(env, CONCEPT_PREFIX)).map((key) => key.name);
  const concepts = (await Promise.all(names.map((name) => env.PLANNING_ORDERS.get(name, "json")))).filter(Boolean);
  const stops = new Map();
  for (const concept of concepts) for (const key of concept.orderKeys || []) stops.set(key, concept);
  return stops;
}

async function plannedStops(env, from, to) {
  const keys = (await listAll(env, PLAN_PREFIX)).map((key) => key.name)
    .filter((name) => {
      const date = name.slice(PLAN_PREFIX.length, PLAN_PREFIX.length + 10);
      return date >= from && date <= to;
    });
  const routes = (await Promise.all(keys.map((name) => env.PLANNING_ORDERS.get(name, "json")))).filter(Boolean);
  const stops = new Map();
  for (const route of routes) {
    if (route.abortedAt) continue;
    for (const key of route.orderKeys || []) stops.set(key, route);
  }
  return stops;
}

function driverWindow() {
  const today = amsterdamNow().day;
  return { from: shiftDay(today, -7), to: shiftDay(today, 7), today };
}

async function markDelivered(request, env) {
  const role = roleFor(request, env);
  if (!role) return unauthorized(env);

  const payload = await request.json().catch(() => ({}));
  const shopDomain = normalizeShopDomain(payload.shopDomain);
  const displayOrderId = String(payload.id || "");
  if (!shopDomain || !displayOrderId) return json({ error: "Order ontbreekt in het verzoek." }, 400, env);
  const key = `${shopDomain}:${displayOrderId}`;

  // Reported twice (a double tap, or a first try whose answer was lost in a
  // dead spot): the first one stands and the second is simply told so.
  const history = await env.PLANNING_ORDERS.get(`delivered:${key}`, "json");
  if (history) return json({ ok: true, already: true, id: displayOrderId }, 200, env);

  const storedOrder = await env.PLANNING_ORDERS.get(`order:${key}`, "json");
  if (!storedOrder) return json({ error: "Deze order staat niet meer open in de planning. Ververs het scherm." }, 404, env);
  if (storedOrder.cancelled) return json({ error: "Deze order is geannuleerd. Niet afleveren." }, 409, env);
  if (storedOrder.refunded) return json({ error: "Deze order is terugbetaald. Niet afleveren; bel de planner." }, 409, env);

  // The driver reports deliveries of their own routes only.
  if (role === "driver") {
    const window = driverWindow();
    const stops = await plannedStops(env, window.from, window.to);
    if (!stops.has(key)) return json({ error: "Deze order staat niet in een van jouw ritten." }, 403, env);
  }

  const shopifyOrderId = storedOrder.shopifyOrderId || payload.shopifyOrderId;
  const token = await shopifyAdminToken(env, shopDomain);
  if (!token || !shopifyOrderId) return json({ error: "Er is geen Shopify-koppeling voor deze winkel. Bel de planner." }, 501, env);

  // Always asked of Shopify, never taken on trust from the announcement marker:
  // an announced order is already fulfilled and comes back as such, customer
  // not mailed again (notifyCustomer false). If the marker was wrong (the
  // announcement failed, or its fulfillment was undone) this still fulfills it.
  const announcedKey = `${ANNOUNCED_PREFIX}${key}`;
  const announced = await env.PLANNING_ORDERS.get(announcedKey, "json");
  // While this report runs, Shopify's own webhook for the fulfillment leaves
  // the order alone (see storeShopifyOrder). Sixty seconds is KV's shortest life.
  const reportingKey = `${REPORTING_PREFIX}${key}`;
  await env.PLANNING_ORDERS.put(reportingKey, new Date().toISOString(), { expirationTtl: 60 });
  const created = await createShopifyFulfillment(shopDomain, token, shopifyOrderId, false);
  if (created.error) {
    if (!created.ambiguous) await env.PLANNING_ORDERS.delete(reportingKey).catch(() => {});
    return json({ error: created.ambiguous
      ? "Geen antwoord van Shopify. Wacht een minuut, ververs en kijk of de stop als bezorgd staat voor je het opnieuw probeert."
      : created.error, userErrors: created.userErrors }, created.status, env);
  }
  const fulfillment = created.fulfillment || (announced?.fulfillmentId ? { id: announced.fulfillmentId, status: "SUCCESS" } : null);

  // Written the moment Shopify said yes; the note, which is only context, last.
  const now = new Date().toISOString();
  await putDelivered(env, key, {
    id: displayOrderId,
    shopDomain,
    shopifyOrderId,
    order: storedOrder,
    fulfillment,
    deliveredAt: now,
    source: role === "driver" ? "bezorger" : "planner",
    shopifyUpdatedAt: now,
  });
  await env.PLANNING_ORDERS.delete(`order:${key}`);
  if (announced) await env.PLANNING_ORDERS.delete(announcedKey);
  await appendOrderPlanningNote(shopDomain, token, shopifyOrderId, [
    announced ? `Bezorgd gemeld via Vervoersplanning (aangekondigd op ${announced.at})` : "Bezorgd gemeld via Vervoersplanning",
    `Tijd: ${new Date().toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })}`,
  ]);
  return json({ ok: true, id: displayOrderId, fulfillment }, 200, env);
}

async function undoDelivered(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;

  const payload = await request.json().catch(() => ({}));
  const shopDomain = normalizeShopDomain(payload.shopDomain);
  const displayOrderId = String(payload.id || "");
  if (!shopDomain || !displayOrderId) return json({ error: "Order ontbreekt in het verzoek." }, 400, env);

  const historyKey = `delivered:${shopDomain}:${displayOrderId}`;
  const history = await env.PLANNING_ORDERS.get(historyKey, "json");
  if (!history) return json({ error: "Deze bezorging staat niet (meer) in de historie." }, 404, env);

  // Only a fulfillment the planning made itself is undone from here. One made
  // in Shopify (a DHL label, a colleague) is not ours to cancel, and reopening
  // the order here while Shopify still says shipped would leave the two apart.
  const fulfillmentId = history.fulfillment?.id;
  if (!fulfillmentId) {
    return json({ error: "Deze order is in Shopify zelf op verzonden gezet, niet via de planning. Draai het in Shopify terug; daarna komt hij vanzelf weer in de planning." }, 409, env);
  }
  const token = await shopifyAdminToken(env, shopDomain);
  if (!token) return json({ error: "Er is geen Shopify-koppeling voor deze winkel." }, 501, env);
  const result = await shopifyGraphql(shopDomain, token, `
    mutation CancelFulfillment($id: ID!) {
      fulfillmentCancel(id: $id) {
        fulfillment { id status }
        userErrors { field message }
      }
    }
  `, { id: fulfillmentId });
  const userErrors = result.data?.fulfillmentCancel?.userErrors || [];
  if (userErrors.length) {
    return json({ error: `Shopify kon de verzending niet terugdraaien (${userErrors.map((item) => item.message).join("; ")}).`, userErrors }, 422, env);
  }

  if (history.order) {
    await env.PLANNING_ORDERS.put(`order:${shopDomain}:${displayOrderId}`, JSON.stringify({ ...history.order, fulfilled: false, announced: false, shopifyUpdatedAt: history.shopifyUpdatedAt || "" }));
  }
  await env.PLANNING_ORDERS.delete(historyKey);
  return json({ ok: true, id: displayOrderId }, 200, env);
}

async function tagOwnDelivery(env, shopDomain, token, order) {
  const result = await shopifyGraphql(shopDomain, token, `
    mutation AddOwnDeliveryTag($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }
  `, { id: order.shopifyOrderId, tags: ["eigen bezorging"] });
  if ((result.data?.tagsAdd?.userErrors || []).length) return false;
  await appendOrderPlanningNote(shopDomain, token, order.shopifyOrderId, [
    "Eigen bezorging via Vervoersplanning",
    order.dueDate ? `Uiterste leverdatum: ${order.dueDate}` : "",
  ]);
  await env.PLANNING_ORDERS.put(`order:${shopDomain}:${order.id}`, JSON.stringify({ ...order, ownDeliveryTagged: true }));
  return true;
}

async function untagOwnDelivery(shopDomain, token, order) {
  try {
    await shopifyGraphql(shopDomain, token, `
      mutation RemoveOwnDeliveryTag($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
      }
    `, { id: order.shopifyOrderId, tags: ["eigen bezorging"] });
  } catch {
    // The route did not change; a tag left behind shows up under Controleren.
  }
}

// Tags parcels as own delivery in Shopify, so whoever prints the DHL labels
// skips them. Returns the keys that failed.
async function tagKeysOwnDelivery(env, keys) {
  const failed = [];
  const tagged = [];
  for (const key of keys) {
    const order = await env.PLANNING_ORDERS.get(`order:${key}`, "json");
    if (!order || order.ownDeliveryTagged) continue;
    const token = await shopifyAdminToken(env, order.shopDomain);
    try {
      if (!token || !order.shopifyOrderId || !(await tagOwnDelivery(env, order.shopDomain, token, order))) failed.push(order.id);
      else tagged.push(order);
    } catch {
      failed.push(order.id);
    }
  }
  return { failed, tagged };
}

// Takes back tags set in a request that then did not go through: a parcel
// tagged "eigen bezorging" in no route is skipped by DHL and by the van alike.
async function untagOrders(env, orders) {
  for (const order of orders) {
    const token = await shopifyAdminToken(env, order.shopDomain);
    if (token) await untagOwnDelivery(order.shopDomain, token, order);
    await env.PLANNING_ORDERS.put(`order:${order.shopDomain}:${order.id}`, JSON.stringify({ ...order, ownDeliveryTagged: false })).catch(() => {});
  }
}

async function setOwnDelivery(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;

  const payload = await request.json().catch(() => ({}));
  const shopDomain = normalizeShopDomain(payload.shopDomain);
  const displayOrderId = String(payload.id || "");
  if (!shopDomain || !displayOrderId) return json({ error: "Order ontbreekt in het verzoek." }, 400, env);
  const { failed } = await tagKeysOwnDelivery(env, [`${shopDomain}:${displayOrderId}`]);
  if (failed.length) return json({ error: "Shopify kon de tag 'eigen bezorging' niet zetten. Probeer het opnieuw." }, 502, env);
  return json({ ok: true, id: displayOrderId, tag: "eigen bezorging" }, 200, env);
}

async function appendOrderPlanningNote(shopDomain, token, shopifyOrderId, lines) {
  try {
    const noteLine = lines.filter(Boolean).join("\n");
    const result = await shopifyGraphql(shopDomain, token, `
      query OrderNote($id: ID!) {
        order(id: $id) { id note }
      }
    `, { id: shopifyOrderId });
    const currentNote = result.data?.order?.note || "";
    const planningBlock = `[Vervoersplanning]\n${noteLine}`;
    const nextNote = currentNote ? `${currentNote}\n\n${planningBlock}` : planningBlock;
    await shopifyGraphql(shopDomain, token, `
      mutation UpdateOrderNote($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id note }
          userErrors { field message }
        }
      }
    `, { input: { id: shopifyOrderId, note: nextNote } });
  } catch {
    // Planning notes are useful context, but should not block delivery actions.
  }
}

async function syncShopify(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const payload = await request.json().catch(() => ({}));
  // One request may touch KV at most 1,000 times, three or four per order: two
  // weeks of orders fits, sixty days broke off halfway with half written.
  const days = Math.min(Math.max(Number(payload.days || 7), 1), 14);
  const requestedShop = normalizeShopDomain(payload.shopDomain);
  const shops = requestedShop ? [requestedShop] : await installedShopDomains(env);
  const updatedAtMin = new Date(Date.now() - days * 86_400_000).toISOString();
  const results = [];

  for (const shopDomain of shops) {
    const token = await shopifyAdminToken(env, shopDomain);
    if (!token) {
      results.push({ shopDomain, ok: false, error: "Geen Shopify token gevonden" });
      continue;
    }

    await registerShopifyWebhooks(shopDomain, token, url.origin);
    const orders = await fetchRecentShopifyOrders(shopDomain, token, updatedAtMin);
    let open = 0;
    let delivered = 0;
    for (const order of orders) {
      const planningOrder = await storeShopifyOrder(env, order, shopDomain);
      if (planningOrder.fulfilled) delivered += 1;
      else if (!planningOrder.cancelled) open += 1;
    }
    results.push({ shopDomain, ok: true, checked: orders.length, open, delivered });
  }

  return json({ ok: true, days, results }, 200, env);
}

async function installedShopDomains(env) {
  const list = await env.PLANNING_ORDERS.list({ prefix: "shop-install:" });
  return list.keys.map((key) => key.name.replace("shop-install:", "")).filter(Boolean);
}

async function fetchRecentShopifyOrders(shopDomain, token, updatedAtMin) {
  const orders = [];
  let url = new URL(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders.json`);
  url.searchParams.set("status", "any");
  url.searchParams.set("limit", "250");
  url.searchParams.set("updated_at_min", updatedAtMin);

  for (let page = 0; page < 5 && url; page += 1) {
    const response = await fetch(url.toString(), {
      headers: {
        "content-type": "application/json",
        "x-shopify-access-token": token,
      },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    orders.push(...(Array.isArray(data.orders) ? data.orders : []));
    url = nextShopifyPageUrl(response.headers.get("link"));
  }

  return orders;
}

function nextShopifyPageUrl(linkHeader) {
  if (!linkHeader) return null;
  const next = linkHeader.split(",").find((part) => part.includes('rel="next"'));
  const match = next?.match(/<([^>]+)>/);
  return match ? new URL(match[1]) : null;
}

// Real coordinates for Dutch addresses from PDOK, the government's own address
// service: free, no key, and it knows every address in the BAG. Without this the
// planning placed each order on one of eleven points for the whole country, so a
// customer in Ede counted as a drive to Arnhem.
//
// Each address is looked up once and kept: geo:<address> holds the point, or a
// miss that is tried again after a week in case the address was since fixed.
// Addresses outside the Netherlands are not sent anywhere; the planning keeps
// its own estimate for those.
const GEO_PREFIX = "geo:";
const GEO_MISS_TTL = 7 * 24 * 3600;
// A point is kept 90 days, then looked up afresh; an address is personal data
// and is not kept longer than the planning needs it.
const GEO_HIT_TTL = 90 * 24 * 3600;
// The Workers free plan allows 50 outbound fetches per request. Forty lookups
// leaves room; anything past it is simply looked up on the next refresh.
const GEO_BATCH_LIMIT = 40;

function looksDutch(address) {
  return /\b\d{4}\s?[A-Z]{2}\b/i.test(address) && !/(belgi|belgium|deutschland|germany|czech|france|luxemb)/i.test(address);
}

function postcodeOf(address) {
  const match = String(address).match(/\b(\d{4})\s?([A-Z]{2})\b/i);
  return match ? { digits: match[1], full: `${match[1]}${match[2].toUpperCase()}` } : null;
}

async function pdokQuery(q, fq) {
  const url = new URL("https://api.pdok.nl/bzk/locatieserver/search/v3_1/free");
  url.searchParams.set("q", q);
  url.searchParams.set("rows", "1");
  url.searchParams.set("fl", "centroide_ll,type,postcode");
  url.searchParams.set("fq", fq);
  // PDOK stalling must not stall the planning: three seconds, then give up on
  // this address and let the next refresh try again.
  const response = await fetch(url, {
    headers: { "user-agent": "vervoersplanning-de-specialisten" },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`PDOK ${response.status}`);
  const doc = (await response.json())?.response?.docs?.[0];
  const point = String(doc?.centroide_ll || "").match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
  if (!point) return null;
  return { lat: Number(point[2]), lon: Number(point[1]), precision: doc.type, postcode: String(doc.postcode || "") };
}

// PDOK matches loosely and nearly always answers something. A farm name in the
// address ("Manege De Hoeve") came back as a street of that name in Friesland,
// 112 km off, and was kept for good. A hit now only counts when its postcode
// has the same four digits as the order's. Otherwise the postcode alone is
// looked up, which always lands in the right place, and failing that the
// address is left to the planning's own estimate.
async function pdokLookup(address) {
  const postcode = postcodeOf(address);
  if (!postcode) return null;
  const cleaned = address.replace(/["\u201c\u201d]/g, " ");
  const hit = await pdokQuery(cleaned, "type:(adres OR postcode OR weg)");
  if (hit && hit.postcode.slice(0, 4) === postcode.digits) return hit;
  const area = await pdokQuery(postcode.full, "type:postcode");
  if (area && area.postcode.slice(0, 4) === postcode.digits) return { ...area, precision: "postcode" };
  return null;
}

// A lookup may call PDOK twice (the address, then the postcode alone), and the
// free plan allows 50 outbound fetches per request: twenty new addresses at
// most, and none started after eight seconds. What is left over is simply
// asked for again on the next refresh, which the page does on its own.
const GEO_LOOKUPS_PER_REQUEST = 20;
const GEO_TIME_BUDGET_MS = 8000;

async function geocodeAddresses(request, env) {
  if (!anyRoleAllowed(request, env)) return unauthorized(env);

  const payload = await request.json().catch(() => ({}));
  const addresses = [...new Set((Array.isArray(payload.addresses) ? payload.addresses : [])
    .map(normalizeAddress).filter(Boolean))].slice(0, GEO_BATCH_LIMIT);

  const results = {};
  const dutch = addresses.filter(looksDutch);
  for (const address of addresses) if (!looksDutch(address)) results[address] = null;

  const keyFor = (address) => `${GEO_PREFIX}${address.toLowerCase()}`;
  const cached = await Promise.all(dutch.map((address) => env.PLANNING_ORDERS.get(keyFor(address), "json")));
  const todo = [];
  dutch.forEach((address, index) => {
    if (cached[index]) results[address] = cached[index].miss ? null : cached[index];
    else todo.push(address);
  });

  const deadline = Date.now() + GEO_TIME_BUDGET_MS;
  let looked = 0;
  for (const address of todo) {
    if (looked >= GEO_LOOKUPS_PER_REQUEST || Date.now() > deadline) {
      results[address] = null;
      continue;
    }
    looked += 1;
    try {
      const point = await pdokLookup(address);
      results[address] = point;
      await env.PLANNING_ORDERS.put(keyFor(address), JSON.stringify(point || { miss: true }), { expirationTtl: point ? GEO_HIT_TTL : GEO_MISS_TTL });
    } catch {
      // PDOK down or slow: leave this one out and let the planning estimate it.
      // Nothing is cached, so the next refresh simply tries again.
      results[address] = null;
    }
  }

  return json({ results, looked, pending: Math.max(0, todo.length - looked) }, 200, env);
}

// ---------------------------------------------------------------------------
// Announcement. At 16:00 the day before a planned route its orders go on
// fulfilled in Shopify with the shipping mail, so customers hear it is coming.
//
// It is OFF unless the secret or variable AUTO_FULFILL is exactly "aan". Off,
// it walks every step except the Shopify call and only writes down what it
// would have done: nothing reaches Shopify, and nothing reaches any customer.
// ---------------------------------------------------------------------------
const ANNOUNCED_PREFIX = "announced:";
const ANNOUNCE_LOG_PREFIX = "plan-announce:";
const ANNOUNCE_HOUR = 16;

function announceLive(env) {
  return String(env.AUTO_FULFILL || "").trim().toLowerCase() === "aan";
}

function amsterdamNow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

function shiftDay(isoDay, days) {
  const date = new Date(`${isoDay}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextDay(isoDay) {
  return shiftDay(isoDay, 1);
}

// Each announced order costs two calls to Shopify (look up, fulfill), and one
// run of the Worker may make 50 on the free plan. Past this many the rest waits
// for the second run ten minutes later instead of failing at random.
const ANNOUNCE_FETCH_BUDGET = 44;

async function deleteWithRetry(env, key) {
  for (let poging = 0; poging < 2; poging += 1) {
    try {
      await env.PLANNING_ORDERS.delete(key);
      return true;
    } catch {
      // KV allows one write per key per second; the marker was written a moment ago.
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }
  return false;
}

async function runAnnouncement(env, date, { preview = false, report }) {
  const live = !preview && announceLive(env);
  const list = await env.PLANNING_ORDERS.list({ prefix: `${PLAN_PREFIX}${date}:` });
  const routes = (await Promise.all(list.keys.map((key) => env.PLANNING_ORDERS.get(key.name, "json")))).filter(Boolean);
  let fetches = 0;

  for (const route of routes) {
    const entry = { id: route.id, number: route.number, name: route.name, results: [] };
    report.routes.push(entry);
    if (route.abortedAt) {
      entry.skipped = "afgebroken";
      continue;
    }

    for (const key of route.orderKeys || []) {
      const split = key.indexOf(":");
      const shopDomain = key.slice(0, split);
      const id = key.slice(split + 1);
      const result = { key, id };
      entry.results.push(result);

      if (await env.PLANNING_ORDERS.get(`${ANNOUNCED_PREFIX}${key}`)) {
        result.status = "al aangekondigd";
        continue;
      }
      const order = await env.PLANNING_ORDERS.get(`order:${key}`, "json");
      if (!order) {
        result.status = (await env.PLANNING_ORDERS.get(`delivered:${key}`)) ? "al bezorgd" : "niet meer open";
        continue;
      }
      if (order.cancelled || order.deliveryMethod === "pickup") {
        result.status = order.cancelled ? "geannuleerd" : "wordt opgehaald";
        continue;
      }
      // "Your order is on its way" to someone who has their money back, or who
      // has not paid yet, is wrong either way. The planner decides; not this.
      if (order.refunded) {
        result.status = "terugbetaald, niet aangekondigd";
        continue;
      }
      if (!order.paid) {
        result.status = "niet betaald, niet aangekondigd";
        continue;
      }
      if (!live) {
        result.status = "zou aangekondigd worden";
        continue;
      }

      const token = await shopifyAdminToken(env, shopDomain);
      if (!token || !order.shopifyOrderId) {
        result.status = "mislukt: geen Shopify-toegang voor deze winkel";
        continue;
      }
      if (fetches + 2 > ANNOUNCE_FETCH_BUDGET) {
        result.status = "uitgesteld: volgt om 16:10";
        continue;
      }

      // Live from here on. The marker goes in BEFORE Shopify is told: Shopify
      // answers a fulfillment with a webhook straight away, and if that came
      // in first the order would be filed as delivered and leave the route.
      const markerKey = `${ANNOUNCED_PREFIX}${key}`;
      const marker = { at: new Date().toISOString(), routeId: route.id, number: route.number, date };
      try {
        // A year: Bezorgd clears it, and an announced order must never fall back
        // to "delivered" just because a route was broken off for a while.
        await env.PLANNING_ORDERS.put(markerKey, JSON.stringify(marker), { expirationTtl: 365 * DAY_SECONDS });
        fetches += 2;
        const created = await createShopifyFulfillment(shopDomain, token, order.shopifyOrderId, true);
        if (created.error && created.ambiguous) {
          // The request went out and no answer came: Shopify may have fulfilled
          // it and mailed the customer. The marker stays, so the order stays on
          // the route and is not mailed twice; a person looks in Shopify.
          result.status = "onzeker: kijk in Shopify of de mail is verstuurd";
          continue;
        }
        if (created.error) throw new Error(created.error);
        if (created.fulfillment?.id) await env.PLANNING_ORDERS.put(markerKey, JSON.stringify({ ...marker, fulfillmentId: created.fulfillment.id }), { expirationTtl: 365 * DAY_SECONDS }).catch(() => {});
        result.status = created.alreadyFulfilled ? "stond al op verzonden in Shopify, geen mail" : "aangekondigd";
      } catch (error) {
        // Certain that nothing was made: the lookup failed, or Shopify said no.
        const cleared = await deleteWithRetry(env, markerKey);
        result.status = `mislukt${cleared ? "" : " (markering bleef staan, meld het)"}: ${String(error?.message || error).slice(0, 120)}`;
      }
    }
  }

  return report;
}

// The run at 16:10 does the same walk again: orders announced at 16:00 answer
// "al aangekondigd" and keep the result they had; anything that failed or had to
// wait gets its second chance, and its new outcome replaces the old.
function mergeAnnounceReports(earlier, later) {
  if (!earlier) return later;
  const merged = { ...earlier, retriedAt: later.ranAt, routes: [...(earlier.routes || [])] };
  if (later.error) merged.error = later.error;
  for (const route of later.routes || []) {
    const existing = merged.routes.find((entry) => entry.id === route.id);
    if (!existing) {
      merged.routes.push(route);
      continue;
    }
    for (const result of route.results || []) {
      const index = existing.results.findIndex((entry) => entry.key === result.key);
      if (index === -1) existing.results.push(result);
      else if (result.status !== "al aangekondigd") existing.results[index] = result;
    }
  }
  return merged;
}

// A planned route is its own record, plan:<date>:<id>, never one record per day.
// The planner on a laptop and the driver on a phone both write here, and KV has
// no transactions: a shared per-day record would let one silently overwrite the
// other's route. The date is whatever the browser calls today in Dutch local
// time and is only ever compared as text, so the worker's UTC clock cannot shift
// a route onto the wrong day.
//
// Records expire 60 days after their date, day notes too. Everything under
// "plan" is read in one listing on each refresh, so what lies there has to stay
// bounded: before this, about 470 routes in, the listing would have been full
// and the newest routes, which sort last, would have dropped out of sight.
const PLAN_PREFIX = "plan:";
const PLAN_NOTE_PREFIX = "plan-note:";
const ORDER_KEY_PATTERN = /^[a-z0-9-]+\.myshopify\.com:#?[A-Za-z0-9_-]{1,40}$/;

function isPlanDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function planExpiration(date) {
  const at = Math.floor(new Date(`${shiftDay(date, PLAN_KEEP_DAYS)}T12:00:00Z`).getTime() / 1000);
  return Math.max(at, Math.floor(Date.now() / 1000) + 3600);
}

// Order keys as the planning writes them, shop and order number. Anything else
// (markup, a made-up string) is refused before it reaches a record that the
// planner's screen will later show.
function cleanKeys(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter((key) => ORDER_KEY_PATTERN.test(key)))];
}

function cleanName(value, fallback = "Rit") {
  return String(value || fallback).replace(/[<>]/g, "").trim().slice(0, 60) || fallback;
}

async function getPlan(request, env) {
  const role = roleFor(request, env);
  if (!role) return unauthorized(env);

  const url = new URL(request.url);
  let from = url.searchParams.get("from");
  let to = null;
  // The driver sees the week behind and the week ahead, whatever is asked for.
  if (role === "driver") ({ from, to } = driverWindow());

  // One listing for routes, day notes and announcement reports together. The
  // free plan allows 1,000 list operations a day, and this runs on every
  // refresh of every open screen.
  const names = (await listAll(env, "plan")).map((key) => key.name);
  const inWindow = (name, prefix) => {
    const date = name.slice(prefix.length, prefix.length + 10);
    return (!isPlanDate(from) || date >= from) && (!to || date <= to);
  };
  const routeKeys = names.filter((name) => name.startsWith(PLAN_PREFIX) && inWindow(name, PLAN_PREFIX));
  const dayKeys = names.filter((name) => name.startsWith("plan-day:") && inWindow(name, "plan-day:"));
  const logKeys = names.filter((name) => name.startsWith(ANNOUNCE_LOG_PREFIX) && inWindow(name, ANNOUNCE_LOG_PREFIX));

  const [routes, dayNotes, announcements] = await Promise.all([
    Promise.all(routeKeys.map((name) => env.PLANNING_ORDERS.get(name, "json"))),
    Promise.all(dayKeys.map((name) => env.PLANNING_ORDERS.get(name, "json"))),
    Promise.all(logKeys.map((name) => env.PLANNING_ORDERS.get(name, "json"))),
  ]);
  // A note saved on its own wins over one still inside an older route record.
  const ids = new Set(routes.filter(Boolean).map((route) => route.id));
  const noteKeys = names.filter((name) => name.startsWith(PLAN_NOTE_PREFIX) && ids.has(name.slice(PLAN_NOTE_PREFIX.length)));
  const notes = new Map((await Promise.all(noteKeys.map((name) => env.PLANNING_ORDERS.get(name, "json")))).filter(Boolean).map((entry) => [entry.id, entry.note]));
  const planned = routes.filter(Boolean).map((route) => (notes.has(route.id) ? { ...route, note: notes.get(route.id) } : route));
  planned.sort((a, b) => `${a.date}${String(a.number || 0).padStart(6, "0")}`.localeCompare(`${b.date}${String(b.number || 0).padStart(6, "0")}`));

  const body = { routes: planned, dayNotes: dayNotes.filter(Boolean), announcements: announcements.filter(Boolean), announceLive: announceLive(env) };
  // Concepts come along in the same listing. The planner gets them whole; the
  // driver only learns which orders they hold, so "kan er nog bij" leaves those
  // alone.
  const concepts = (await Promise.all(names.filter((name) => name.startsWith(CONCEPT_PREFIX)).map((name) => env.PLANNING_ORDERS.get(name, "json")))).filter(Boolean);
  if (role === "driver") body.heldKeys = [...new Set(concepts.flatMap((concept) => concept.orderKeys || []))];
  else body.concepts = concepts.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (role === "driver") {
    // Name, address, phone and note of the stops on the driver's own routes: the
    // only customers whose details the phone is given.
    const stopKeys = [...new Set(planned.filter((route) => !route.abortedAt).flatMap((route) => route.orderKeys || []))];
    body.stops = (await Promise.all(stopKeys.map((key) => env.PLANNING_ORDERS.get(`order:${key}`, "json")))).filter(Boolean);
  }
  return json(body, 200, env);
}

async function assignPlanRoute(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;

  const payload = await request.json().catch(() => ({}));
  const date = String(payload.date || "");
  // A stop is identified by shop and order number together, the way the
  // planning keys orders everywhere else. The number alone is only unique
  // while the two shops keep their #DRS and #DSP prefixes apart.
  const orderKeys = cleanKeys(payload.orderKeys);
  if (!isPlanDate(date)) return json({ error: "Kies een geldige dag." }, 400, env);
  if (!orderKeys.length) return json({ error: "Deze rit heeft geen stops." }, 400, env);

  const id = /^[A-Za-z0-9-]{8,64}$/.test(String(payload.id || "")) ? String(payload.id) : crypto.randomUUID();
  let fromDate = isPlanDate(payload.fromDate) ? String(payload.fromDate) : null;
  let bestaand = await readPlanRecord(env, fromDate || date, id);

  // Sent twice for the same day (a double click, a retry after a lost answer):
  // the route that was made stands, and no second number is used up.
  if (bestaand && !fromDate && bestaand.orderKeys?.join("|") === orderKeys.join("|")) {
    // The first try may have saved the route and failed before clearing its
    // concept; a retry finishes that.
    if (payload.conceptId) await settleConcept(env, String(payload.conceptId), orderKeys);
    return json({ route: bestaand, already: true }, 200, env);
  }

  // One order, one route. The same van load planned on two days would have the
  // driver arrive at a door that was served the day before. A route of the last
  // week that was not broken off still holds its open stops: the driver sees it
  // as "nog open", so its orders are not free to plan again.
  const stops = await plannedStops(env, shiftDay(amsterdamNow().day, -7), "9999-12-31");
  // The same route, picked up once and placed again on another day (the answer
  // to the first try was lost, so it looked as if it failed): a move, keeping
  // its number, not a second route.
  if (!fromDate && !bestaand) {
    const elsewhere = [...stops.values()].find((route) => route.id === id && route.date !== date);
    if (elsewhere) {
      fromDate = elsewhere.date;
      bestaand = elsewhere;
    }
  }
  const sameRoute = (route) => route.id === id && (route.date === date || route.date === fromDate);
  const conflicts = orderKeys.filter((key) => stops.has(key) && !sameRoute(stops.get(key)));
  const conceptId = String(payload.conceptId || "");
  const held = await conceptStops(env);
  const heldElsewhere = orderKeys.filter((key) => held.has(key) && held.get(key).id !== conceptId);
  if (heldElsewhere.length) {
    const first = held.get(heldElsewhere[0]);
    return json({ error: `${heldElsewhere.map((key) => key.split(":").pop()).join(", ")} ${heldElsewhere.length === 1 ? "staat" : "staan"} in het concept ${first.name}. Haal ${heldElsewhere.length === 1 ? "die" : "ze"} daar eerst uit.`, conflicts: heldElsewhere }, 409, env);
  }
  if (conflicts.length) {
    const first = stops.get(conflicts[0]);
    return json({
      error: `${conflicts.map((key) => key.split(":").pop()).join(", ")} ${conflicts.length === 1 ? "staat" : "staan"} al in rit ${first.number || "?"} op ${first.date}. Haal ${conflicts.length === 1 ? "die" : "ze"} daar eerst uit.`,
      conflicts,
    }, 409, env);
  }

  // Parcels in the route are tagged "eigen bezorging" in Shopify before the
  // route is saved, so whoever prints the DHL labels leaves them be. If Shopify
  // says no, nothing is planned: a parcel in a route but still on DHL's pile
  // would go out twice.
  const { failed, tagged } = await tagKeysOwnDelivery(env, cleanKeys(payload.tagKeys).filter((key) => orderKeys.includes(key)));
  if (failed.length) {
    await untagOrders(env, tagged);
    return json({ error: `Shopify kon ${failed.join(", ")} niet als eigen bezorging taggen. Er is niets ingepland; probeer het opnieuw.` }, 502, env);
  }

  const record = {
    ...(bestaand || {}),
    id,
    // A route keeps the number it was given, whatever day it is moved to.
    number: bestaand?.number || await claimRouteNumber(env),
    date,
    name: cleanName(payload.name),
    orderKeys,
    assignedAt: bestaand?.assignedAt || new Date().toISOString(),
  };

  try {
    await writePlanRecord(env, record);
  } catch (error) {
    await untagOrders(env, tagged);
    throw error;
  }
  // Moving a route to another day writes the new record and drops the old one,
  // so the same route can never sit on two days at once.
  if (fromDate && fromDate !== date) await env.PLANNING_ORDERS.delete(`${PLAN_PREFIX}${fromDate}:${id}`);
  // A concept that is planned is a route now; the draft goes. Orders added to
  // it meanwhile (on another screen) are not dropped: they stay in the concept.
  const conceptLeft = conceptId ? await settleConcept(env, conceptId, orderKeys) : [];
  return json({ route: record, conceptLeft }, 200, env);
}

// After a concept is planned: remove it when the route took all its open orders,
// otherwise keep it with what is left. Only a concept that held at least one of
// the planned orders is touched. Returns the keys it kept.
async function settleConcept(env, conceptId, plannedKeys) {
  const concept = await env.PLANNING_ORDERS.get(`${CONCEPT_PREFIX}${conceptId}`, "json");
  if (!concept || !(concept.orderKeys || []).some((key) => plannedKeys.includes(key))) return [];
  const rest = (concept.orderKeys || []).filter((key) => !plannedKeys.includes(key));
  const open = (await Promise.all(rest.map(async (key) => {
    const order = await env.PLANNING_ORDERS.get(`order:${key}`, "json");
    return order && !order.cancelled && !order.fulfilled && !order.refunded ? key : null;
  }))).filter(Boolean);
  if (!open.length) {
    await env.PLANNING_ORDERS.delete(`${CONCEPT_PREFIX}${conceptId}`);
    return [];
  }
  await env.PLANNING_ORDERS.put(`${CONCEPT_PREFIX}${conceptId}`, JSON.stringify({ ...concept, orderKeys: open, updatedAt: new Date().toISOString() }));
  return open;
}

// A concept: a route put together and kept for later, not yet on a day and
// without a number. It holds its orders, so they are not proposed or planned a
// second time. Only the planner makes, changes or removes one. Kept under the
// "plan" prefix so the one listing each refresh already does picks it up.
const CONCEPT_PREFIX = "plan-concept:";

async function saveConcept(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  const orderKeys = cleanKeys(payload.orderKeys);
  const id = /^[A-Za-z0-9-]{8,64}$/.test(String(payload.id || "")) ? String(payload.id) : crypto.randomUUID();
  if (!orderKeys.length) return json({ error: "Een concept heeft minstens één stop nodig." }, 400, env);
  const existing = await env.PLANNING_ORDERS.get(`${CONCEPT_PREFIX}${id}`, "json");
  if (payload.update && !existing) return json({ error: "Dit concept bestaat niet meer: het is intussen ingepland of verwijderd." }, 404, env);

  const stops = await plannedStops(env, shiftDay(amsterdamNow().day, -7), "9999-12-31");
  const planned = orderKeys.filter((key) => stops.has(key));
  if (planned.length) {
    const first = stops.get(planned[0]);
    return json({ error: `${planned.map((key) => key.split(":").pop()).join(", ")} ${planned.length === 1 ? "staat" : "staan"} al in rit ${first.number || "?"} op ${first.date}.`, conflicts: planned }, 409, env);
  }
  const held = await conceptStops(env);
  const elsewhere = orderKeys.filter((key) => held.has(key) && held.get(key).id !== id);
  if (elsewhere.length) {
    const first = held.get(elsewhere[0]);
    return json({ error: `${elsewhere.map((key) => key.split(":").pop()).join(", ")} ${elsewhere.length === 1 ? "staat" : "staan"} al in het concept ${first.name}.`, conflicts: elsewhere }, 409, env);
  }

  const now = new Date().toISOString();
  const concept = { id, name: cleanName(payload.name, "Concept"), orderKeys, createdAt: existing?.createdAt || now, updatedAt: now };
  await env.PLANNING_ORDERS.put(`${CONCEPT_PREFIX}${id}`, JSON.stringify(concept));
  return json({ concept }, 200, env);
}

async function removeConcept(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  const id = String(payload.id || "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return json({ error: "Concept ontbreekt in het verzoek." }, 400, env);
  await env.PLANNING_ORDERS.delete(`${CONCEPT_PREFIX}${id}`);
  return json({ removed: true }, 200, env);
}

// Route numbers run on for good: rit 1 today, rit 500 in a year or two. The
// driver is told a number, so it has to mean one route and never come round
// again. The counter only goes up. KV cannot increment atomically, so a number is
// also claimed with a short-lived marker: two routes assigned in the same second
// would otherwise both be told 137. Markers live outside the "plan" listing.
async function claimRouteNumber(env) {
  const teller = (await env.PLANNING_ORDERS.get("plan-counter", "json")) || { next: 1 };
  let nummer = Number(teller.next) || 1;

  for (let poging = 0; poging < 8; poging += 1) {
    const marker = `ritnummer:${nummer}`;
    const taken = (await env.PLANNING_ORDERS.get(marker)) || (await env.PLANNING_ORDERS.get(`plan-number:${nummer}`));
    if (!taken) {
      await env.PLANNING_ORDERS.put(marker, new Date().toISOString(), { expirationTtl: 7 * DAY_SECONDS });
      await env.PLANNING_ORDERS.put("plan-counter", JSON.stringify({ next: nummer + 1 }));
      return nummer;
    }
    nummer += 1;
  }

  // Eight taken in a row means the counter drifted behind reality; skip past it.
  await env.PLANNING_ORDERS.put("plan-counter", JSON.stringify({ next: nummer + 1 }));
  return nummer;
}

async function readPlanRecord(env, date, id) {
  if (!isPlanDate(date) || !id) return null;
  return env.PLANNING_ORDERS.get(`${PLAN_PREFIX}${date}:${id}`, "json");
}

async function writePlanRecord(env, record) {
  record.updatedAt = new Date().toISOString();
  await env.PLANNING_ORDERS.put(`${PLAN_PREFIX}${record.date}:${record.id}`, JSON.stringify(record), { expiration: planExpiration(record.date) });
  return record;
}

// One more stop onto a route, by the driver ("kan er nog bij") or the planner
// opening a planned route. Kept apart from /plan/assign, which rewrites a whole
// route and is the planner's alone. A parcel is tagged in Shopify in the same
// request, and untagged again if the route cannot be saved: the step between the
// two no longer depends on the phone's signal.
//
// The driver is held to what the planning itself would offer them: a route they
// are driving (today, or an unfinished one of the last week), an order that is
// paid, addressed, due and not agreed for another moment, and a day that still
// ends within 5:45. Without this, adding any order to an old route was a way to
// read any customer's details and ship it without the van.
async function addPlanStop(request, env) {
  const role = roleFor(request, env);
  if (!role) return unauthorized(env);
  const payload = await request.json().catch(() => ({}));
  const [key] = cleanKeys([payload.orderKey]);
  if (!key) return json({ error: "Onbekende order." }, 400, env);
  const date = String(payload.date || "");
  const id = String(payload.id || "");
  let record = await readPlanRecord(env, date, id);
  if (!record) return json({ error: "Deze rit staat niet meer in de agenda." }, 404, env);
  if (record.abortedAt) return json({ error: "Deze rit is afgebroken." }, 409, env);
  if ((record.orderKeys || []).includes(key)) return json({ route: record, already: true }, 200, env);

  const order = await env.PLANNING_ORDERS.get(`order:${key}`, "json");
  if (!order || order.cancelled || order.fulfilled) return json({ error: "Deze order staat niet meer open." }, 404, env);

  if (role === "driver") {
    const today = amsterdamNow().day;
    if (record.date > today || record.date < shiftDay(today, -7)) return json({ error: "Onderweg iets meenemen kan alleen in de rit die je nu rijdt." }, 403, env);
    const eligible = order.paid && !order.refunded && order.addressComplete && order.deliveryMethod !== "pickup"
      && !order.deliveryAppointmentLocked && !(order.dueDate && order.dueDate < HIDE_ORDERS_DUE_BEFORE);
    if (!eligible) return json({ error: "Deze order kan niet zomaar mee. Bel de planner." }, 403, env);
    const minutes = await routeMinutesWith(env, record, order);
    if (minutes === null) return json({ error: "Van deze order is geen locatie bekend. Bel de planner." }, 403, env);
    if (minutes > DAY_LIMIT_MINUTES) return json({ error: "Met deze stop wordt de rit langer dan 5:45. Bel de planner." }, 403, env);
  }

  const stops = await plannedStops(env, shiftDay(amsterdamNow().day, -7), "9999-12-31");
  const other = stops.get(key);
  if (other && other.id !== record.id) return json({ error: `Deze order staat al in rit ${other.number || "?"} op ${other.date}.` }, 409, env);
  const concept = (await conceptStops(env)).get(key);
  if (concept) return json({ error: `Deze order staat in het concept ${concept.name} van de planner.` }, 409, env);

  let tagged = [];
  if (payload.tag && !order.ownDeliveryTagged) {
    const result = await tagKeysOwnDelivery(env, [key]);
    if (result.failed.length) return json({ error: "Shopify kon de tag 'eigen bezorging' niet zetten. De stop is niet toegevoegd." }, 502, env);
    tagged = result.tagged;
  }

  // Read again after the seconds Shopify took: a note, a removed stop or the
  // route being broken off in the meantime is not written over.
  record = await readPlanRecord(env, date, id);
  if (!record || record.abortedAt) {
    await untagOrders(env, tagged);
    return json({ error: record ? "Deze rit is intussen afgebroken." : "Deze rit staat niet meer in de agenda." }, 409, env);
  }
  const keys = [...(record.orderKeys || [])];
  const position = Number.isInteger(payload.position) ? Math.max(0, Math.min(keys.length, payload.position)) : keys.length;
  keys.splice(position, 0, key);
  record.orderKeys = [...new Set(keys)];
  if (payload.name) record.name = cleanName(payload.name, record.name);
  record.addedBy = [...(record.addedBy || []), { key, by: role === "driver" ? "bezorger" : "planner", at: new Date().toISOString() }].slice(-20);
  try {
    await writePlanRecord(env, record);
  } catch (error) {
    await untagOrders(env, tagged);
    throw error;
  }
  return json({ route: record }, 200, env);
}

// How long the route takes with this order added where it costs least, by the
// planning's own estimate (see app.js), from the points PDOK gave the addresses.
// null when an address has no point: then nothing sensible can be said.
async function routeMinutesWith(env, record, extra) {
  const open = (await Promise.all((record.orderKeys || []).map((key) => env.PLANNING_ORDERS.get(`order:${key}`, "json")))).filter((order) => order && !order.fulfilled && !order.cancelled);
  const orders = [...open, extra];
  const points = await Promise.all(orders.map(async (order) => {
    const point = await env.PLANNING_ORDERS.get(geoKeyForOrder(order), "json").catch(() => null);
    return point && !point.miss ? point : null;
  }));
  if (points.some((point) => !point)) return null;
  const km = (a, b) => Math.sqrt(((a.lat - b.lat) * 111) ** 2 + ((a.lon - b.lon) * 70) ** 2);
  const loop = (list) => list.reduce((sum, point, index) => sum + km(index ? list[index - 1] : DEPOT_POINT, point), 0) + km(list[list.length - 1], DEPOT_POINT);
  const route = points.slice(0, -1);
  let best = Infinity;
  for (let index = 0; index <= route.length; index += 1) best = Math.min(best, loop([...route.slice(0, index), points[points.length - 1], ...route.slice(index)]));
  const unloading = orders.reduce((sum, order) => sum + (/hooihuisje|hoihuisje/.test((order.products || []).join(" ").toLowerCase()) ? 90 : 20), 0);
  return Math.round(20.2 + 5 * (orders.length - 1) + 0.975 * best) + unloading;
}

// The planner taking a stop out of a planned route. Before this existed the
// "−" on an opened route changed only the screen, and the driver still went.
async function removePlanStop(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  const key = String(payload.orderKey || "");
  const record = await readPlanRecord(env, String(payload.date || ""), String(payload.id || ""));
  if (!record) return json({ error: "Deze rit staat niet meer in de agenda." }, 404, env);
  if (record.abortedAt) return json({ error: "Deze rit is afgebroken." }, 409, env);
  record.orderKeys = (record.orderKeys || []).filter((entry) => entry !== key);
  if (payload.name) record.name = cleanName(payload.name, record.name);
  if (!record.orderKeys.length) {
    await env.PLANNING_ORDERS.delete(`${PLAN_PREFIX}${record.date}:${record.id}`);
    return json({ removed: true }, 200, env);
  }
  return json({ route: await writePlanRecord(env, record) }, 200, env);
}

// Breaking a route off halfway. Which stops were delivered is decided here from
// the delivered records, not from whatever the driver's phone last loaded: the
// phone may have been offline for the last three drops. Delivered stops stay on
// the route as its record; the rest are released so the planning offers them
// again, and are kept apart so the planner can see what came back and why.
async function abortPlanRoute(request, env) {
  const role = roleFor(request, env);
  if (!role) return unauthorized(env);
  const payload = await request.json().catch(() => ({}));
  const record = await readPlanRecord(env, String(payload.date || ""), String(payload.id || ""));
  if (!record) return json({ error: "Deze rit staat niet meer in de agenda." }, 404, env);
  if (record.abortedAt) return json({ route: record }, 200, env);
  if (role === "driver") {
    const window = driverWindow();
    if (record.date < window.from || record.date > window.to) return json({ error: "Deze rit valt buiten jouw week." }, 403, env);
  }

  const keys = record.orderKeys || [];
  const delivered = await Promise.all(keys.map(async (key) =>
    key.includes(":") && !key.startsWith("?:") && Boolean(await env.PLANNING_ORDERS.get(`delivered:${key}`))
  ));

  record.orderKeys = keys.filter((_, index) => delivered[index]);
  record.droppedKeys = keys.filter((_, index) => !delivered[index]);
  record.abortedAt = new Date().toISOString();
  record.abortedBy = role === "driver" ? "bezorger" : "planner";
  record.abortReason = String(payload.reason || "").slice(0, 300);
  return json({ route: await writePlanRecord(env, record) }, 200, env);
}

// The planner's note lives in its own record, so a note saved while the driver
// breaks the route off (or adds a stop) cannot write the old route back over it.
async function setPlanNote(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  const record = await readPlanRecord(env, String(payload.date || ""), String(payload.id || ""));
  if (!record) return json({ error: "Deze rit staat niet meer in de agenda." }, 404, env);
  const note = String(payload.note || "").trim().slice(0, 1000);
  await env.PLANNING_ORDERS.put(`${PLAN_NOTE_PREFIX}${record.id}`, JSON.stringify({ id: record.id, note, updatedAt: new Date().toISOString() }), { expiration: planExpiration(record.date) });
  return json({ route: { ...record, note } }, 200, env);
}

// A note for a whole day, "bus in onderhoud", apart from any one route.
async function setDayNote(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  const date = String(payload.date || "");
  if (!isPlanDate(date)) return json({ error: "Kies een geldige dag." }, 400, env);
  const note = String(payload.note || "").trim().slice(0, 1000);
  if (note) {
    await env.PLANNING_ORDERS.put(`plan-day:${date}`, JSON.stringify({ date, note, updatedAt: new Date().toISOString() }), { expiration: planExpiration(date) });
  } else {
    await env.PLANNING_ORDERS.delete(`plan-day:${date}`);
  }
  return json({ date, note }, 200, env);
}

async function removePlanRoute(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;

  const payload = await request.json().catch(() => ({}));
  const date = String(payload.date || "");
  const id = String(payload.id || "");
  if (!isPlanDate(date) || !id) return json({ error: "Rit ontbreekt in het verzoek." }, 400, env);

  await env.PLANNING_ORDERS.delete(`${PLAN_PREFIX}${date}:${id}`);
  return json({ removed: true }, 200, env);
}

const DEPOT_ADDRESS = "Goorsteeg 46, 6718 TA Ede, Netherlands";
// Google allows 625 origin x destination pairs per call; staying under it leaves
// room for a stop list that grew between the cache read and the request.
const MATRIX_PAIR_LIMIT = 600;
const MAX_STOPS = 40;

function normalizeAddress(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function driveCacheKey(from) {
  return `drive:${from.toLowerCase()}`;
}

// Real driving minutes between the depot and every stop, and between the stops
// themselves, so a route with several stops can be costed leg by leg. Journeys
// are cached per origin: one record holding that origin's minutes to everywhere
// it has been measured, which keeps a refresh to a handful of KV reads and only
// writes when an address is new.
async function estimateRoute(request, env) {
  if (!anyRoleAllowed(request, env)) return unauthorized(env);
  if (!env.GOOGLE_MAPS_API_KEY) return json({ error: "Google Maps API key is not configured" }, 501, env);

  const payload = await request.json().catch(() => ({}));
  const requested = Array.isArray(payload.stops) ? payload.stops : [];
  const stops = [...new Set(requested.map(normalizeAddress).filter(Boolean))].slice(0, MAX_STOPS);
  if (!stops.length) return json({ error: "stops are required" }, 400, env);

  const points = [DEPOT_ADDRESS, ...stops.filter((stop) => stop !== DEPOT_ADDRESS)];
  const known = {};
  await Promise.all(points.map(async (from) => {
    known[from] = (await env.PLANNING_ORDERS.get(driveCacheKey(from), "json")) || {};
  }));

  const missingFor = new Map();
  for (const from of points) {
    const missing = points.filter((to) => to !== from && typeof known[from][to] !== "number");
    if (missing.length) missingFor.set(from, missing);
  }

  let measured = 0;
  let failed = null;
  if (missingFor.size) {
    try {
      measured = await fillDriveMatrix(env, known, missingFor);
      await Promise.all([...missingFor.keys()].map((from) =>
        env.PLANNING_ORDERS.put(driveCacheKey(from), JSON.stringify(known[from]))
      ));
    } catch (error) {
      // A Google outage must not take the planning down: the frontend falls back
      // to its own estimate for whatever is missing.
      failed = String(error.message || error);
    }
  }

  return json({ depot: DEPOT_ADDRESS, minutes: known, measured, cached: !missingFor.size, error: failed }, 200, env);
}

async function fillDriveMatrix(env, known, missingFor) {
  const origins = [...missingFor.keys()];
  const destinations = [...new Set([...missingFor.values()].flat())];
  const perCall = Math.max(1, Math.floor(MATRIX_PAIR_LIMIT / origins.length));
  let measured = 0;

  for (let start = 0; start < destinations.length; start += perCall) {
    const chunk = destinations.slice(start, start + perCall);
    // GOOGLE_ROUTES_URL exists so the parsing can be exercised against a stand-in
    // before anyone pays for a key. Production leaves it unset.
    const endpoint = env.GOOGLE_ROUTES_URL || "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
      },
      body: JSON.stringify({
        origins: origins.map((address) => ({ waypoint: { address } })),
        destinations: chunk.map((address) => ({ waypoint: { address } })),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
      }),
    });

    if (!response.ok) throw new Error(`Google Routes ${response.status}: ${(await response.text()).slice(0, 200)}`);

    for (const row of await response.json()) {
      if (row.condition !== "ROUTE_EXISTS" || !row.duration) continue;
      const from = origins[row.originIndex];
      const to = chunk[row.destinationIndex];
      if (!from || !to || from === to) continue;
      known[from][to] = Math.round(Number(String(row.duration).replace("s", "")) / 60);
      measured += 1;
    }
  }

  return measured;
}

// The version is bumped once a year: Shopify supports each for twelve months,
// then quietly answers with the oldest one it still has.
async function shopifyGraphql(shopDomain, token, query, variables) {
  const response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-access-token": token,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok || data.errors) throw new Error(JSON.stringify(data.errors || data).slice(0, 300));
  return data;
}

function unauthorized(env) {
  return json({ error: "Unauthorized" }, 401, env);
}

// 401 means the code is wrong, and makes the page ask for it again. A right code
// that may not do this gets 403, so the driver's phone keeps its code.
function plannerOnly(request, env) {
  const role = roleFor(request, env);
  if (!role) return unauthorized(env);
  if (role !== "planner") return json({ error: "Dit mag alleen de planner." }, 403, env);
  return null;
}

// Two codes, two roles. The planner's code opens everything. The driver's code,
// DRIVER_KEY, opens what is needed on the road: reading the day, reporting a
// delivery, taking a parcel along, breaking a route off. It cannot plan, delete
// or undo. Without DRIVER_KEY set there is simply no driver role.
function roleFor(request, env) {
  const provided = request.headers.get("x-operator-key") || "";
  if (!provided) return null;
  const planner = String(env.OPERATOR_KEY || "");
  if (planner && timingSafeEqual(planner, provided)) return "planner";
  const driver = String(env.DRIVER_KEY || "");
  if (driver && timingSafeEqual(driver, provided)) return "driver";
  return null;
}

function anyRoleAllowed(request, env) {
  return roleFor(request, env) !== null;
}

// Installing is only offered for the two shops of this planning, and the state
// that ties the callback to its start is signed rather than stored: starting an
// install costs no KV write, so opening this link a thousand times cannot use
// up the day's write budget and stop webhooks and deliveries being saved.
function allowedShop(shopDomain, env) {
  const extra = String(env.SHOPIFY_SHOPS || "").split(",").map(normalizeShopDomain).filter(Boolean);
  return /^[a-z0-9-]+\.myshopify\.com$/.test(shopDomain) && [...KNOWN_SHOPS, ...extra].includes(shopDomain);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedOAuthState(secret, shopDomain) {
  const at = String(Date.now());
  return `${at}.${await hmacHex(secret, `${shopDomain}|${at}`)}`;
}

async function oauthStateValid(secret, shopDomain, state) {
  const [at, signature] = String(state || "").split(".");
  if (!at || !signature || Date.now() - Number(at) > 10 * 60 * 1000) return false;
  return timingSafeEqual(await hmacHex(secret, `${shopDomain}|${at}`), signature);
}

async function startShopifyOAuth(request, env) {
  const url = new URL(request.url);
  const shopDomain = normalizeShopDomain(url.searchParams.get("shop"));
  const appCredentials = shopifyAppCredentials(env, shopDomain);

  if (!allowedShop(shopDomain, env)) {
    return html("Deze koppeling is alleen voor de winkels van De Specialisten.", 400);
  }
  if (!appCredentials.clientId || !appCredentials.clientSecret) {
    return html("Shopify Client ID en Secret staan nog niet in Cloudflare voor deze shop.", 501);
  }

  const state = await signedOAuthState(appCredentials.clientSecret, shopDomain);

  const redirectUri = `${url.origin}/auth/shopify/callback`;
  const scopes = env.SHOPIFY_ADMIN_SCOPES || [
    "read_orders",
    "write_orders",
    "read_fulfillments",
    "write_fulfillments",
    "read_assigned_fulfillment_orders",
    "write_assigned_fulfillment_orders",
    "read_merchant_managed_fulfillment_orders",
    "write_merchant_managed_fulfillment_orders",
  ].join(",");

  const installUrl = new URL(`https://${shopDomain}/admin/oauth/authorize`);
  installUrl.searchParams.set("client_id", appCredentials.clientId);
  installUrl.searchParams.set("scope", scopes);
  installUrl.searchParams.set("redirect_uri", redirectUri);
  installUrl.searchParams.set("state", state);

  return Response.redirect(installUrl.toString(), 302);
}

async function finishShopifyOAuth(request, env) {
  const url = new URL(request.url);
  const shopDomain = normalizeShopDomain(url.searchParams.get("shop"));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const appCredentials = shopifyAppCredentials(env, shopDomain);

  if (!allowedShop(shopDomain, env) || !(await verifyShopifyOAuthCallback(url, appCredentials.clientSecret))) {
    return html("Ongeldige Shopify OAuth callback.", 401);
  }

  if (!code || !(await oauthStateValid(appCredentials.clientSecret, shopDomain, state))) {
    return html("OAuth sessie verlopen of ongeldig. Start de installatie opnieuw.", 400);
  }

  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: appCredentials.clientId,
      client_secret: appCredentials.clientSecret,
      code,
    }),
  });
  const data = await response.json();

  if (!response.ok || !data.access_token) {
    return html(`Shopify token ophalen mislukt: ${escapeHtml(JSON.stringify(data))}`, 502);
  }

  await env.PLANNING_ORDERS.put(adminTokenStorageKey(shopDomain), data.access_token);
  await env.PLANNING_ORDERS.put(`shop-install:${shopDomain}`, JSON.stringify({
    shopDomain,
    scope: data.scope || "",
    installedAt: new Date().toISOString(),
  }));
  await registerShopifyWebhooks(shopDomain, data.access_token, url.origin);

  return html(`Shopify koppeling is actief voor ${escapeHtml(shopDomain)}. Je kunt dit tabblad sluiten.`, 200);
}

async function registerShopifyWebhooks(shopDomain, token, origin) {
  const address = `${origin}/webhooks/shopify/orders`;
  await Promise.all(["orders/create", "orders/updated", "orders/fulfilled"].map((topic) => createShopifyWebhook(shopDomain, token, topic, address)));
}

async function createShopifyWebhook(shopDomain, token, topic, address) {
  try {
    const response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-access-token": token,
      },
      body: JSON.stringify({ webhook: { topic, address, format: "json" } }),
    });
    if (response.ok || response.status === 422) return;
    throw new Error(await response.text());
  } catch {
    // Manual webhook setup still works; registration failure should not break OAuth installation.
  }
}

async function verifyShopifyOAuthCallback(url, secret) {
  const hmac = url.searchParams.get("hmac") || "";
  if (!secret || !hmac) return false;

  const pairs = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (key !== "hmac" && key !== "signature") pairs.push(`${key}=${value}`);
  }
  pairs.sort();

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(pairs.join("&")));
  const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, hmac);
}

async function shopifyAdminToken(env, shopDomain) {
  const perShopKey = `SHOPIFY_ADMIN_TOKEN_${secretSuffix(shopDomain)}`;
  return env[perShopKey] || env.SHOPIFY_ADMIN_TOKEN || await env.PLANNING_ORDERS.get(adminTokenStorageKey(shopDomain)) || "";
}

function adminTokenStorageKey(shopDomain) {
  return `shop-admin-token:${shopDomain}`;
}

function shopifyAppCredentials(env, shopDomain) {
  const suffix = secretSuffix(shopDomain);
  return {
    clientId: env[`SHOPIFY_CLIENT_ID_${suffix}`] || env.SHOPIFY_CLIENT_ID || "",
    clientSecret: env[`SHOPIFY_CLIENT_SECRET_${suffix}`] || env.SHOPIFY_CLIENT_SECRET || "",
  };
}

// Lines still on the order. An order edit leaves a removed line in line_items
// with current_quantity 0: counted anyway, a swapped-out XXL bak kept an order
// on the van and a removed hay house still booked 90 minutes of unloading.
function orderedLines(order) {
  return (Array.isArray(order.line_items) ? order.line_items : [])
    .map((item) => ({ ...item, quantity: Number(item.current_quantity ?? item.quantity ?? 1) }))
    .filter((item) => item.quantity > 0);
}

// Whatever the planning appended to the order note, "[Vervoersplanning] ...",
// is its own text and not the customer's: cut off before the driver reads it.
function customerNoteOf(order) {
  return String(order.note || "").split(/\n*\[Vervoersplanning\]/)[0].trim().slice(0, 500);
}

function shopifyTime(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function mapShopifyOrder(order, shopDomain = "") {
  const shipping = order.shipping_address || {};
  const lineItems = orderedLines(order);
  const tags = String(order.tags || "").toLowerCase();
  const deliveryMethod = inferDeliveryMethod(order, tags);

  return {
    id: order.name || String(order.id),
    shopifyOrderId: order.admin_graphql_api_id || (order.id ? `gid://shopify/Order/${order.id}` : null),
    shopDomain,
    webshop: webshopName(shopDomain),
    customer: customerName(order, shipping),
    addressLine: [shipping.address1, shipping.address2].filter(Boolean).join(" "),
    fullAddress: fullAddress(shipping),
    city: shipping.city || "",
    postcode: normalizePostcode(shipping.zip),
    orderDate: extractOrderDate(order),
    dueDate: extractDueDate(order) || defaultDueDate(order, shopDomain),
    paid: order.financial_status === "paid" || order.financial_status === "partially_refunded",
    paymentStatus: paymentStatus(order),
    refunded: ["refunded", "voided"].includes(order.financial_status),
    cancelled: Boolean(order.cancelled_at),
    fulfilled: order.fulfillment_status === "fulfilled",
    deliveryMethod,
    requiresVanRoekelDelivery: deliveryMethod === "delivery" && requiresOwnDelivery(order, tags, shopDomain),
    addressComplete: Boolean(shipping.address1 && shipping.city && shipping.zip && shipping.country_code),
    deliveryAppointmentLocked: deliveryAppointmentLocked(order),
    deliveryMinutes: deliveryMinutes(lineItems),
    weightKg: totalWeightKg(lineItems),
    products: lineItems.map(productLabel).filter(Boolean),
    // What the driver needs at the door: a number to ring when nobody answers,
    // and whatever the customer wrote at checkout ("achterom, hond los").
    phone: String(shipping.phone || order.phone || order.customer?.phone || "").trim(),
    customerNote: customerNoteOf(order),
    country: String(shipping.country_code || "").toUpperCase(),
    // Tagged in Shopify as delivered by the van, by the planning or by hand. A
    // parcel tagged so is skipped by whoever prints the DHL labels.
    ownDeliveryTagged: /(^|,)\s*eigen bezorging\s*(,|$)/.test(tags),
    shopifyUpdatedAt: shopifyTime(order.updated_at),
  };
}

function productLabel(item) {
  const title = item.title || item.name || "";
  if (!title) return "";
  const quantity = Number(item.quantity || 1);
  return `${quantity || 1}x ${title}`;
}

function webshopName(shopDomain) {
  if (shopDomain.includes("rijplaten")) return "De Rijplaten Specialist";
  if (shopDomain.includes("slowfeeder")) return "De Slowfeeder Specialist";
  return shopDomain || "Onbekende webshop";
}

function extractOrderDate(order) {
  const raw = order.created_at || order.processed_at;
  return raw ? String(raw).slice(0, 10) : null;
}

function defaultDueDate(order, shopDomain) {
  if (!shopDomain.includes("rijplaten")) return null;
  const orderDate = extractOrderDate(order);
  return orderDate ? addBusinessDays(orderDate, 5) : null;
}

function addBusinessDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00`);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6 && !isDutchHoliday(date)) added += 1;
  }
  return date.toISOString().slice(0, 10);
}

function isDutchHoliday(date) {
  const fixed = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  if (["01-01", "04-27", "12-25", "12-26"].includes(fixed)) return true;
  const easter = easterDate(date.getFullYear());
  const offsets = [1, 39, 50];
  return offsets.some((offset) => sameDate(date, addDays(easter, offset)));
}

function easterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day, 12);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function paymentStatus(order) {
  const status = order.financial_status;
  if (status === "paid" || status === "partially_refunded") return "Betaald";
  if (status === "refunded") return "Terugbetaald";
  if (status === "voided") return "Betaling vervallen";
  if (status === "authorized") return "Betaling gereserveerd";
  return "In afwachting van betaling";
}

function shopifyFulfilledAt(order) {
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  const dates = fulfillments.map((item) => item.created_at || item.updated_at).filter(Boolean).sort();
  return dates.at(-1) || order.updated_at || null;
}

function deliveryAppointmentLocked(order) {
  const attributes = Array.isArray(order.note_attributes) ? order.note_attributes : [];
  const text = [customerNoteOf(order), order.tags, ...attributes.map((item) => `${item.name}: ${item.value}`)].join(" ").toLowerCase();
  return text.includes("aflevermoment afgestemd") || text.includes("afgesproken") || text.includes("klant geïnformeerd");
}

// Kept in line with deliveryMinutes in app.js, which decides. The Shopify title
// reads "Slowfeeder hooihuisje voor paarden", never "houten hooihuisje".
function deliveryMinutes(lineItems) {
  const text = lineItems.map((item) => item.title).join(" ").toLowerCase();
  return text.includes("hooihuisje") || text.includes("hoihuisje") ? 90 : 20;
}

function inferDeliveryMethod(order, tags) {
  const shippingTitle = String(order.shipping_lines?.[0]?.title || "").toLowerCase();
  if (tags.includes("afhalen") || shippingTitle.includes("afhalen") || shippingTitle.includes("pickup")) return "pickup";
  return "delivery";
}

function requiresOwnDelivery(order, tags, shopDomain = "") {
  const shippingTitle = String(order.shipping_lines?.[0]?.title || "").toLowerCase();
  if (shopDomain.includes("rijplaten")) return true;
  return tags.includes("eigen bezorging") || tags.includes("van roekel") || shippingTitle.includes("van roekel") || shippingTitle.includes("bezorg");
}

// A cart attribute can be set by anyone visiting the shop, and "2026-13-01"
// used to take the whole planning down. Only a date that exists is taken.
function extractDueDate(order) {
  const attributes = Array.isArray(order.note_attributes) ? order.note_attributes : [];
  const dateAttribute = attributes.find((item) => /bezorg|lever|delivery|date|datum/i.test(String(item.name || "")));
  const value = dateAttribute?.value || order.metafields?.delivery_date;
  const match = String(value || "").match(/\d{4}-\d{2}-\d{2}/);
  return match && isPlanDate(match[0]) ? match[0] : null;
}

function totalWeightKg(lineItems) {
  const grams = lineItems.reduce((sum, item) => sum + Number(item.grams || 0) * Number(item.quantity || 1), 0);
  return grams ? Math.round(grams / 100) / 10 : null;
}

function customerName(order, shipping) {
  const name = [shipping.first_name, shipping.last_name].filter(Boolean).join(" ").trim();
  return name || order.customer?.default_address?.name || order.customer?.email || "Onbekende klant";
}

function fullAddress(shipping) {
  return [
    [shipping.address1, shipping.address2].filter(Boolean).join(" "),
    [shipping.zip, shipping.city].filter(Boolean).join(" "),
    shipping.country || shipping.country_code,
  ].filter(Boolean).join(", ");
}

function normalizePostcode(value) {
  return String(value || "").trim().toUpperCase();
}

function orderStorageKey(order) {
  const shopPart = order.shopDomain || "unknown-shop";
  return `order:${shopPart}:${order.id}`;
}

function shopifyWebhookSecret(env, shopDomain) {
  const perShopKey = `SHOPIFY_WEBHOOK_SECRET_${secretSuffix(shopDomain)}`;
  return env[perShopKey] || env.SHOPIFY_WEBHOOK_SECRET || "";
}

function normalizeShopDomain(value) {
  return String(value || "").trim().toLowerCase();
}

function secretSuffix(shopDomain) {
  return normalizeShopDomain(shopDomain).replace(/[^a-z0-9]/g, "_").toUpperCase();
}

async function verifyShopifyWebhook(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

function json(payload, status, env) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(env) },
  });
}

function html(message, status = 200) {
  return new Response(`<!doctype html><html lang="nl"><meta charset="utf-8"><title>Vervoersplanning Shopify</title><body style="font-family: system-ui, sans-serif; max-width: 720px; margin: 48px auto; line-height: 1.5;"><h1>Vervoersplanning V2</h1><p>${message}</p></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function corsHeaders(env) {
  const origin = env.CORS_ORIGIN || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-shopify-hmac-sha256, x-operator-key",
  };
}
