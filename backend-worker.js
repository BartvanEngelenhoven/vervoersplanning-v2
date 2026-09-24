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
 * - OPERATOR_KEY: shared operator key required for reading orders and for write actions
 * - SHOPIFY_CLIENT_ID: Shopify app client ID, required for OAuth install
 * - SHOPIFY_CLIENT_SECRET: Shopify app secret, required for OAuth install
 * - SHOPIFY_CLIENT_ID_<SHOP_DOMAIN>: optional per-shop Shopify app client ID
 * - SHOPIFY_CLIENT_SECRET_<SHOP_DOMAIN>: optional per-shop Shopify app secret
 * - SHOPIFY_ADMIN_TOKEN_<SHOP_DOMAIN>: optional legacy per-shop Admin API token for marking orders fulfilled
 * - GOOGLE_MAPS_API_KEY: optional Google Routes key; without it the planning falls back to estimates
 */

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export default {
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

  return json({ error: "Not found" }, 404, env);
}

async function getOrders(request, env) {
  if (!operatorAllowed(request, env)) return json({ error: "Unauthorized" }, 401, env);

  const list = await env.PLANNING_ORDERS.list({ prefix: "order:" });
  // A key listed a moment ago can be gone by the time it is read, when a
  // webhook deletes a delivered order in between. That reads as null, and one
  // null used to take the whole list down with it.
  const orders = (await Promise.all(
    list.keys.map((key) => env.PLANNING_ORDERS.get(key.name, "json"))
  )).filter(Boolean);
  orders.sort((a, b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31"));
  return json(orders, 200, env);
}

async function getHistory(request, env) {
  if (!operatorAllowed(request, env)) return json({ error: "Unauthorized" }, 401, env);

  const list = await env.PLANNING_ORDERS.list({ prefix: "delivered:" });
  const entries = (await Promise.all(
    list.keys.map((key) => env.PLANNING_ORDERS.get(key.name, "json"))
  )).filter(Boolean);
  entries.sort((a, b) => String(b.deliveredAt || "").localeCompare(String(a.deliveredAt || "")));
  return json(entries.slice(0, 50), 200, env);
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
  const historyKey = `delivered:${shopDomain}:${planningOrder.id}`;

  if (planningOrder.fulfilled) {
    const storedOrder = JSON.parse(await env.PLANNING_ORDERS.get(storageKey) || "null");
    await env.PLANNING_ORDERS.put(historyKey, JSON.stringify({
      id: planningOrder.id,
      shopDomain,
      shopifyOrderId: planningOrder.shopifyOrderId,
      order: storedOrder ? { ...planningOrder, ...storedOrder, products: planningOrder.products } : planningOrder,
      fulfillment: null,
      deliveredAt: shopifyFulfilledAt(shopifyOrder) || new Date().toISOString(),
      source: "shopify",
    }));
    await env.PLANNING_ORDERS.delete(storageKey);
  } else if (planningOrder.cancelled) {
    await env.PLANNING_ORDERS.delete(storageKey);
  } else {
    await env.PLANNING_ORDERS.put(storageKey, JSON.stringify(planningOrder));
    await env.PLANNING_ORDERS.delete(historyKey);
  }

  return planningOrder;
}

async function markDelivered(request, env) {
  if (!operatorAllowed(request, env)) return json({ error: "Unauthorized" }, 401, env);

  const payload = await request.json();
  const shopDomain = normalizeShopDomain(payload.shopDomain);
  const shopifyOrderId = payload.shopifyOrderId;
  const displayOrderId = payload.id;
  const token = await shopifyAdminToken(env, shopDomain);

  if (!shopDomain || !shopifyOrderId) return json({ error: "shopDomain and shopifyOrderId are required" }, 400, env);
  if (!token) return json({ error: "Shopify Admin API token is not configured for this shop" }, 501, env);

  const storageKey = `order:${shopDomain}:${displayOrderId}`;
  const storedOrder = JSON.parse(await env.PLANNING_ORDERS.get(storageKey) || "null");

  const fulfillmentOrders = await shopifyGraphql(shopDomain, token, `
    query FulfillmentOrders($id: ID!) {
      order(id: $id) {
        fulfillmentOrders(first: 20) {
          nodes {
            id
            status
            lineItems(first: 100) {
              nodes { id remainingQuantity }
            }
          }
        }
      }
    }
  `, { id: shopifyOrderId });

  const nodes = fulfillmentOrders.data?.order?.fulfillmentOrders?.nodes || [];
  const lineItemsByFulfillmentOrder = nodes
    .filter((node) => !["CLOSED", "CANCELLED"].includes(node.status))
    .map((node) => ({
      fulfillmentOrderId: node.id,
      fulfillmentOrderLineItems: (node.lineItems?.nodes || [])
        .filter((item) => Number(item.remainingQuantity) > 0)
        .map((item) => ({ id: item.id, quantity: Number(item.remainingQuantity) })),
    }))
    .filter((item) => item.fulfillmentOrderLineItems.length);

  if (!lineItemsByFulfillmentOrder.length) return json({ error: "No open fulfillment lines found" }, 409, env);

  const result = await shopifyGraphql(shopDomain, token, `
    mutation Fulfill($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment { id status }
        userErrors { field message }
      }
    }
  `, { fulfillment: { lineItemsByFulfillmentOrder, notifyCustomer: false } });

  const userErrors = result.data?.fulfillmentCreateV2?.userErrors || [];
  if (userErrors.length) return json({ error: "Shopify fulfillment failed", userErrors }, 422, env);

  const fulfillment = result.data?.fulfillmentCreateV2?.fulfillment;
  await appendOrderPlanningNote(shopDomain, token, shopifyOrderId, [
    `Bezorgd gemeld via Vervoersplanning V2`,
    `Tijd: ${new Date().toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })}`,
  ]);
  await env.PLANNING_ORDERS.put(`delivered:${shopDomain}:${displayOrderId}`, JSON.stringify({
    id: displayOrderId,
    shopDomain,
    shopifyOrderId,
    order: storedOrder,
    fulfillment,
    deliveredAt: new Date().toISOString(),
  }));
  await env.PLANNING_ORDERS.delete(storageKey);
  return json({ ok: true, id: displayOrderId, fulfillment }, 200, env);
}

async function undoDelivered(request, env) {
  if (!operatorAllowed(request, env)) return json({ error: "Unauthorized" }, 401, env);

  const payload = await request.json();
  const shopDomain = normalizeShopDomain(payload.shopDomain);
  const displayOrderId = payload.id;
  if (!shopDomain || !displayOrderId) return json({ error: "shopDomain and id are required" }, 400, env);

  const historyKey = `delivered:${shopDomain}:${displayOrderId}`;
  const history = JSON.parse(await env.PLANNING_ORDERS.get(historyKey) || "null");
  if (!history) return json({ error: "Historie-item niet gevonden" }, 404, env);

  const token = await shopifyAdminToken(env, shopDomain);
  const fulfillmentId = history.fulfillment?.id;
  if (token && fulfillmentId) {
    const result = await shopifyGraphql(shopDomain, token, `
      mutation CancelFulfillment($id: ID!) {
        fulfillmentCancel(id: $id) {
          fulfillment { id status }
          userErrors { field message }
        }
      }
    `, { id: fulfillmentId });
    const userErrors = result.data?.fulfillmentCancel?.userErrors || [];
    if (userErrors.length) return json({ error: "Shopify terugdraaien mislukt", userErrors }, 422, env);
  }

  if (history.order) {
    await env.PLANNING_ORDERS.put(`order:${shopDomain}:${displayOrderId}`, JSON.stringify({ ...history.order, fulfilled: false }));
  }
  await env.PLANNING_ORDERS.delete(historyKey);
  return json({ ok: true, id: displayOrderId }, 200, env);
}

async function setOwnDelivery(request, env) {
  if (!operatorAllowed(request, env)) return json({ error: "Unauthorized" }, 401, env);

  const payload = await request.json();
  const shopDomain = normalizeShopDomain(payload.shopDomain);
  const shopifyOrderId = payload.shopifyOrderId;
  const displayOrderId = payload.id;
  const token = await shopifyAdminToken(env, shopDomain);

  if (!shopDomain || !shopifyOrderId || !displayOrderId) return json({ error: "id, shopDomain and shopifyOrderId are required" }, 400, env);
  if (!token) return json({ error: "Shopify Admin API token is not configured for this shop" }, 501, env);

  const result = await shopifyGraphql(shopDomain, token, `
    mutation AddOwnDeliveryTag($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }
  `, { id: shopifyOrderId, tags: ["eigen bezorging"] });

  const userErrors = result.data?.tagsAdd?.userErrors || [];
  if (userErrors.length) return json({ error: "Shopify tag toevoegen mislukt", userErrors }, 422, env);

  const storageKey = `order:${shopDomain}:${displayOrderId}`;
  const storedOrder = JSON.parse(await env.PLANNING_ORDERS.get(storageKey) || "null");
  await appendOrderPlanningNote(shopDomain, token, shopifyOrderId, [
    `Handmatig gemarkeerd als eigen bezorging via Vervoersplanning V2`,
    `Order: ${displayOrderId}`,
    storedOrder?.dueDate ? `Uiterste leverdatum: ${storedOrder.dueDate}` : "",
    storedOrder?.fullAddress ? `Adres: ${storedOrder.fullAddress}` : "",
  ]);
  if (storedOrder) {
    await env.PLANNING_ORDERS.put(storageKey, JSON.stringify({
      ...storedOrder,
      requiresVanRoekelDelivery: true,
      deliveryMethod: storedOrder.deliveryMethod || "delivery",
      routeOverride: true,
    }));
  }

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
  if (!operatorAllowed(request, env)) return json({ error: "Unauthorized" }, 401, env);

  const url = new URL(request.url);
  const payload = await request.json().catch(() => ({}));
  const days = Math.min(Math.max(Number(payload.days || 7), 1), 60);
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
  let url = new URL(`https://${shopDomain}/admin/api/2026-07/orders.json`);
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
// The Workers free plan allows 50 outbound fetches per request. Forty lookups
// leaves room; anything past it is simply looked up on the next refresh.
const GEO_BATCH_LIMIT = 40;

function looksDutch(address) {
  return /\b\d{4}\s?[A-Z]{2}\b/i.test(address) && !/(belgi|belgium|deutschland|germany|czech|france|luxemb)/i.test(address);
}

async function pdokLookup(address) {
  const url = new URL("https://api.pdok.nl/bzk/locatieserver/search/v3_1/free");
  url.searchParams.set("q", address);
  url.searchParams.set("rows", "1");
  url.searchParams.set("fl", "centroide_ll,type,score");
  url.searchParams.set("fq", "type:(adres OR postcode OR weg)");
  const response = await fetch(url, { headers: { "user-agent": "vervoersplanning-de-specialisten" } });
  if (!response.ok) throw new Error(`PDOK ${response.status}`);
  const doc = (await response.json())?.response?.docs?.[0];
  const match = String(doc?.centroide_ll || "").match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
  if (!match) return null;
  return { lat: Number(match[2]), lon: Number(match[1]), precision: doc.type };
}

async function geocodeAddresses(request, env) {
  if (!operatorAllowed(request, env)) return json({ error: "Unauthorized" }, 401, env);

  const payload = await request.json().catch(() => ({}));
  const addresses = [...new Set((Array.isArray(payload.addresses) ? payload.addresses : [])
    .map(normalizeAddress).filter(Boolean))].slice(0, GEO_BATCH_LIMIT);

  const results = {};
  let looked = 0;
  for (const address of addresses) {
    if (!looksDutch(address)) {
      results[address] = null;
      continue;
    }
    const key = `${GEO_PREFIX}${address.toLowerCase()}`;
    const cached = await env.PLANNING_ORDERS.get(key, "json");
    if (cached) {
      results[address] = cached.miss ? null : cached;
      continue;
    }
    try {
      const point = await pdokLookup(address);
      looked += 1;
      results[address] = point;
      await env.PLANNING_ORDERS.put(key, JSON.stringify(point || { miss: true }), point ? {} : { expirationTtl: GEO_MISS_TTL });
    } catch {
      // PDOK down or slow: leave this one out and let the planning estimate it.
      // Nothing is cached, so the next refresh simply tries again.
      results[address] = null;
    }
  }

  return json({ results, looked }, 200, env);
}

// A planned route is its own record, plan:<date>:<id>, never one record per day.
// The planner on a laptop and the driver on a phone both write here, and KV has
// no transactions: a shared per-day record would let one silently overwrite the
// other's route. The date is whatever the browser calls today in Dutch local
// time and is only ever compared as text, so the worker's UTC clock cannot shift
// a route onto the wrong day.
const PLAN_PREFIX = "plan:";

function isPlanDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

async function getPlan(request, env) {
  if (!operatorAllowed(request, env)) return json({ error: "Unauthorized" }, 401, env);

  const from = new URL(request.url).searchParams.get("from");
  const list = await env.PLANNING_ORDERS.list({ prefix: PLAN_PREFIX });
  const wanted = list.keys
    .map((key) => key.name)
    .filter((name) => !isPlanDate(from) || name.slice(PLAN_PREFIX.length, PLAN_PREFIX.length + 10) >= from);

  const routes = (await Promise.all(wanted.map((name) => env.PLANNING_ORDERS.get(name, "json"))))
    .filter(Boolean)
    .sort((a, b) => `${a.date}${a.assignedAt}`.localeCompare(`${b.date}${b.assignedAt}`));

  return json({ routes }, 200, env);
}

async function assignPlanRoute(request, env) {
  if (!operatorAllowed(request, env)) return json({ error: "Unauthorized" }, 401, env);

  const payload = await request.json().catch(() => ({}));
  const date = String(payload.date || "");
  // A stop is identified by shop and order number together, the way the
  // planning keys orders everywhere else. The number alone is only unique
  // while the two shops keep their #DRS and #DSP prefixes apart.
  const orderKeys = [...new Set((Array.isArray(payload.orderKeys) ? payload.orderKeys : []).map(String).filter((key) => key.includes(":")))];
  if (!isPlanDate(date)) return json({ error: "date moet JJJJ-MM-DD zijn" }, 400, env);
  if (!orderKeys.length) return json({ error: "orderKeys zijn verplicht" }, 400, env);

  const id = String(payload.id || crypto.randomUUID());
  const bestaand = isPlanDate(payload.fromDate)
    ? await env.PLANNING_ORDERS.get(`${PLAN_PREFIX}${payload.fromDate}:${id}`, "json")
    : await env.PLANNING_ORDERS.get(`${PLAN_PREFIX}${date}:${id}`, "json");

  const record = {
    id,
    // A route keeps the number it was given, whatever day it is moved to.
    number: bestaand?.number || await claimRouteNumber(env),
    date,
    name: String(payload.name || "Rit").slice(0, 60),
    orderKeys,
    assignedAt: bestaand?.assignedAt || payload.assignedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Moving a route to another day writes the new record and drops the old one,
  // so the same route can never sit on two days at once.
  const previous = String(payload.fromDate || "");
  if (isPlanDate(previous) && previous !== date) {
    await env.PLANNING_ORDERS.delete(`${PLAN_PREFIX}${previous}:${id}`);
  }

  await env.PLANNING_ORDERS.put(`${PLAN_PREFIX}${date}:${id}`, JSON.stringify(record));
  return json({ route: record }, 200, env);
}

// Route numbers run on for good: rit 1 today, rit 500 in a year or two. The
// driver is told a number, so it has to mean one route and never come round
// again. KV cannot increment atomically, so the counter is read and written
// back, and the number is only kept once claiming its marker succeeds: two
// people assigning a route in the same second would otherwise both be told 137.
async function claimRouteNumber(env) {
  const teller = (await env.PLANNING_ORDERS.get("plan-counter", "json")) || { next: 1 };
  let nummer = Number(teller.next) || 1;

  for (let poging = 0; poging < 8; poging += 1) {
    const marker = `plan-number:${nummer}`;
    if (!(await env.PLANNING_ORDERS.get(marker))) {
      await env.PLANNING_ORDERS.put(marker, new Date().toISOString());
      await env.PLANNING_ORDERS.put("plan-counter", JSON.stringify({ next: nummer + 1 }));
      return nummer;
    }
    nummer += 1;
  }

  // Eight taken in a row means the counter drifted behind reality; skip past it.
  await env.PLANNING_ORDERS.put("plan-counter", JSON.stringify({ next: nummer + 1 }));
  return nummer;
}

async function removePlanRoute(request, env) {
  if (!operatorAllowed(request, env)) return json({ error: "Unauthorized" }, 401, env);

  const payload = await request.json().catch(() => ({}));
  const date = String(payload.date || "");
  const id = String(payload.id || "");
  if (!isPlanDate(date) || !id) return json({ error: "date en id zijn verplicht" }, 400, env);

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
  if (!operatorAllowed(request, env)) return json({ error: "Unauthorized" }, 401, env);
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

async function shopifyGraphql(shopDomain, token, query, variables) {
  const response = await fetch(`https://${shopDomain}/admin/api/2026-07/graphql.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-access-token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await response.json();
  if (!response.ok || data.errors) throw new Error(JSON.stringify(data.errors || data));
  return data;
}

function operatorAllowed(request, env) {
  const configured = String(env.OPERATOR_KEY || "");
  const provided = request.headers.get("x-operator-key") || "";
  return Boolean(configured) && timingSafeEqual(configured, provided);
}

async function startShopifyOAuth(request, env) {
  const url = new URL(request.url);
  const shopDomain = normalizeShopDomain(url.searchParams.get("shop"));
  const appCredentials = shopifyAppCredentials(env, shopDomain);

  if (!shopDomain.endsWith(".myshopify.com")) {
    return html("Shopify shop ontbreekt. Open deze link met ?shop=jouw-shop.myshopify.com", 400);
  }
  if (!appCredentials.clientId || !appCredentials.clientSecret) {
    return html("Shopify Client ID en Secret staan nog niet in Cloudflare voor deze shop.", 501);
  }

  const state = crypto.randomUUID();
  await env.PLANNING_ORDERS.put(`oauth-state:${state}`, shopDomain, { expirationTtl: 600 });

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

  if (!(await verifyShopifyOAuthCallback(url, appCredentials.clientSecret))) {
    return html("Ongeldige Shopify OAuth callback.", 401);
  }

  const expectedShop = await env.PLANNING_ORDERS.get(`oauth-state:${state}`);
  await env.PLANNING_ORDERS.delete(`oauth-state:${state}`);

  if (!expectedShop || expectedShop !== shopDomain || !code) {
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
    const response = await fetch(`https://${shopDomain}/admin/api/2026-07/webhooks.json`, {
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

export function mapShopifyOrder(order, shopDomain = "") {
  const shipping = order.shipping_address || {};
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
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
    cancelled: Boolean(order.cancelled_at),
    fulfilled: order.fulfillment_status === "fulfilled",
    deliveryMethod,
    requiresVanRoekelDelivery: deliveryMethod === "delivery" && requiresOwnDelivery(order, tags, shopDomain),
    addressComplete: Boolean(shipping.address1 && shipping.city && shipping.zip && shipping.country_code),
    deliveryAppointmentLocked: deliveryAppointmentLocked(order),
    deliveryMinutes: deliveryMinutes(lineItems),
    weightKg: totalWeightKg(lineItems),
    products: lineItems.map(productLabel).filter(Boolean),
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
  if (order.financial_status === "paid" || order.financial_status === "partially_refunded") return "Betaald";
  return "In afwachting van betaling";
}

function shopifyFulfilledAt(order) {
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  const dates = fulfillments.map((item) => item.created_at || item.updated_at).filter(Boolean).sort();
  return dates.at(-1) || order.updated_at || null;
}

function deliveryAppointmentLocked(order) {
  const attributes = Array.isArray(order.note_attributes) ? order.note_attributes : [];
  const text = [order.note, order.tags, ...attributes.map((item) => `${item.name}: ${item.value}`)].join(" ").toLowerCase();
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

function extractDueDate(order) {
  const attributes = Array.isArray(order.note_attributes) ? order.note_attributes : [];
  const dateAttribute = attributes.find((item) => /bezorg|lever|delivery|date|datum/i.test(String(item.name || "")));
  const value = dateAttribute?.value || order.metafields?.delivery_date;
  const match = String(value || "").match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
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
