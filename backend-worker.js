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
 */

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method === "GET" && url.pathname === "/orders") {
      return getOrders(env);
    }

    if (request.method === "POST" && url.pathname === "/webhooks/shopify/orders") {
      return receiveShopifyOrder(request, env);
    }

    return json({ error: "Not found" }, 404, env);
  },
};

async function getOrders(env) {
  const list = await env.PLANNING_ORDERS.list({ prefix: "order:" });
  const orders = await Promise.all(
    list.keys.map(async (key) => JSON.parse(await env.PLANNING_ORDERS.get(key.name)))
  );
  orders.sort((a, b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31"));
  return json(orders, 200, env);
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
  const planningOrder = mapShopifyOrder(shopifyOrder, shopDomain);
  const storageKey = orderStorageKey(planningOrder);

  if (planningOrder.cancelled || planningOrder.fulfilled) {
    await env.PLANNING_ORDERS.delete(storageKey);
  } else {
    await env.PLANNING_ORDERS.put(storageKey, JSON.stringify(planningOrder));
  }

  return json({ ok: true, id: planningOrder.id }, 200, env);
}

export function mapShopifyOrder(order, shopDomain = "") {
  const shipping = order.shipping_address || {};
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  const tags = String(order.tags || "").toLowerCase();
  const deliveryMethod = inferDeliveryMethod(order, tags);

  return {
    id: order.name || String(order.id),
    shopDomain,
    customer: customerName(order, shipping),
    city: shipping.city || "",
    postcode: normalizePostcode(shipping.zip),
    dueDate: extractDueDate(order),
    paid: order.financial_status === "paid" || order.financial_status === "partially_refunded",
    cancelled: Boolean(order.cancelled_at),
    fulfilled: order.fulfillment_status === "fulfilled",
    deliveryMethod,
    requiresVanRoekelDelivery: deliveryMethod === "delivery" && requiresOwnDelivery(order, tags),
    addressComplete: Boolean(shipping.address1 && shipping.city && shipping.zip && shipping.country_code),
    weightKg: totalWeightKg(lineItems),
    products: lineItems.map((item) => item.title).filter(Boolean),
  };
}

function inferDeliveryMethod(order, tags) {
  const shippingTitle = String(order.shipping_lines?.[0]?.title || "").toLowerCase();
  if (tags.includes("afhalen") || shippingTitle.includes("afhalen") || shippingTitle.includes("pickup")) return "pickup";
  return "delivery";
}

function requiresOwnDelivery(order, tags) {
  const shippingTitle = String(order.shipping_lines?.[0]?.title || "").toLowerCase();
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

function corsHeaders(env) {
  const origin = env.CORS_ORIGIN || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-shopify-hmac-sha256",
  };
}
