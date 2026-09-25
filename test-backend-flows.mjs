// End-to-end checks of the Worker against an in-memory KV and a stand-in for
// Shopify. Nothing here reaches a real shop or a real customer: fetch is
// replaced before the Worker is loaded, and every order and name is made up.
import assert from "node:assert/strict";

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// A KV namespace in memory, with the parts of the real one the Worker leans on:
// sorted listings of at most 1,000 keys with a cursor, metadata, expiry.
// ---------------------------------------------------------------------------
class MemoryKV {
  constructor() {
    this.map = new Map();
    this.ops = { get: 0, put: 0, delete: 0, list: 0 };
  }
  alive(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiration && entry.expiration * 1000 < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry;
  }
  async get(key, type) {
    this.ops.get += 1;
    const entry = this.alive(key);
    if (!entry) return null;
    return type === "json" ? JSON.parse(entry.value) : entry.value;
  }
  async put(key, value, options = {}) {
    this.ops.put += 1;
    const now = Math.floor(Date.now() / 1000);
    const expiration = options.expiration || (options.expirationTtl ? now + options.expirationTtl : undefined);
    if (expiration && expiration < now + 60) throw new Error(`KV: expiration less than 60 s ahead for ${key}`);
    this.map.set(key, { value: String(value), expiration, metadata: options.metadata });
  }
  async delete(key) {
    this.ops.delete += 1;
    this.map.delete(key);
  }
  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    this.ops.list += 1;
    const names = [...this.map.keys()].filter((key) => key.startsWith(prefix) && this.alive(key)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = names.slice(start, start + limit);
    const complete = start + limit >= names.length;
    return {
      keys: page.map((name) => ({ name, metadata: this.map.get(name).metadata, expiration: this.map.get(name).expiration })),
      list_complete: complete,
      cursor: complete ? undefined : String(start + limit),
    };
  }
  entry(key) {
    return this.alive(key);
  }
}

// ---------------------------------------------------------------------------
// A stand-in Shopify: orders, fulfillments, tags, notes and the mails it would
// send, plus Shopify's own rule that a query costing over 1,000 points is
// refused before it runs.
// ---------------------------------------------------------------------------
const shop = {
  orders: new Map(),
  mails: [],
  calls: 0,
  failNext: null,
  reset() {
    this.orders.clear();
    this.mails = [];
    this.calls = 0;
    this.failNext = null;
  },
  add(gid, lines = 1) {
    this.orders.set(gid, { fulfilled: false, remaining: lines, tags: new Set(), note: "", fulfillments: [] });
  },
};

function queryCost(query) {
  const fo = Number(query.match(/fulfillmentOrders\(first:\s*(\d+)\)/)?.[1] || 0);
  const li = Number(query.match(/lineItems\(first:\s*(\d+)\)/)?.[1] || 0);
  return fo ? 1 + 2 + fo * (1 + 2 + li) : 1;
}

function fakeShopify(body) {
  shop.calls += 1;
  const { query, variables } = JSON.parse(body);
  if (shop.failNext === "network-before" ) {
    shop.failNext = null;
    throw new TypeError("fetch failed");
  }
  const cost = queryCost(query);
  if (cost > 1000) return { errors: [{ message: `Query cost is ${cost}, which exceeds the single query max cost limit (1000).` }] };

  if (/fulfillmentCreateV2/.test(query)) return { errors: [{ message: "fulfillmentCreateV2 is not used any more" }] };

  if (/fulfillmentOrders/.test(query)) {
    const order = shop.orders.get(variables.id);
    if (!order) return { data: { order: null } };
    return { data: { order: {
      displayFulfillmentStatus: order.fulfilled ? "FULFILLED" : "UNFULFILLED",
      fulfillmentOrders: { nodes: [{ id: `${variables.id}/fo`, status: order.fulfilled ? "CLOSED" : "OPEN", lineItems: { nodes: [{ id: `${variables.id}/li`, remainingQuantity: order.fulfilled ? 0 : order.remaining }] } }] },
    } } };
  }

  if (/fulfillmentCreate\(/.test(query)) {
    const target = variables.fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderId.replace(/\/fo$/, "");
    if (shop.failNext?.mode === "network-during" && shop.failNext.gid === target) {
      shop.failNext = null;
      // Shopify made it and mailed, but the answer never arrived.
      const gid = target;
      const order = shop.orders.get(gid);
      order.fulfilled = true;
      if (variables.fulfillment.notifyCustomer) shop.mails.push(gid);
      throw new TypeError("fetch failed");
    }
    if (shop.failNext === "user-error") {
      shop.failNext = null;
      return { data: { fulfillmentCreate: { fulfillment: null, userErrors: [{ field: null, message: "Fulfillment order is on hold" }] } } };
    }
    const gid = variables.fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderId.replace(/\/fo$/, "");
    const order = shop.orders.get(gid);
    order.fulfilled = true;
    const id = `gid://shopify/Fulfillment/${order.fulfillments.length + 1}${gid.split("/").pop()}`;
    order.fulfillments.push(id);
    if (variables.fulfillment.notifyCustomer) shop.mails.push(gid);
    return { data: { fulfillmentCreate: { fulfillment: { id, status: "SUCCESS" }, userErrors: [] } } };
  }

  if (/fulfillmentCancel/.test(query)) {
    for (const order of shop.orders.values()) {
      if (order.fulfillments.includes(variables.id)) order.fulfilled = false;
    }
    return { data: { fulfillmentCancel: { fulfillment: { id: variables.id, status: "CANCELLED" }, userErrors: [] } } };
  }

  if (/tagsAdd/.test(query)) {
    if (shop.failTagFor === variables.id) {
      return { data: { tagsAdd: { node: null, userErrors: [{ field: null, message: "nope" }] } } };
    }
    if (shop.failNext === "tag") {
      shop.failNext = null;
      return { data: { tagsAdd: { node: null, userErrors: [{ field: null, message: "nope" }] } } };
    }
    shop.orders.get(variables.id)?.tags.add(variables.tags[0]);
    return { data: { tagsAdd: { node: { id: variables.id }, userErrors: [] } } };
  }
  if (/tagsRemove/.test(query)) {
    shop.orders.get(variables.id)?.tags.delete(variables.tags[0]);
    return { data: { tagsRemove: { userErrors: [] } } };
  }
  if (/OrderNote/.test(query)) return { data: { order: { id: variables.id, note: shop.orders.get(variables.id)?.note || "" } } };
  if (/orderUpdate/.test(query)) {
    const order = shop.orders.get(variables.input.id);
    if (order) order.note = variables.input.note;
    return { data: { orderUpdate: { order: { id: variables.input.id }, userErrors: [] } } };
  }
  throw new Error(`fake Shopify: unexpected query ${query.slice(0, 80)}`);
}

let fetchesThisRequest = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  fetchesThisRequest += 1;
  if (url.includes(".myshopify.com/admin/api/") && url.endsWith("/graphql.json")) {
    const payload = fakeShopify(init.body);
    if (/fulfillmentCreate\(/.test(JSON.parse(init.body).query) && shop.onFulfilled) await shop.onFulfilled();
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.startsWith("https://api.pdok.nl/")) {
    return new Response(JSON.stringify({ response: { docs: [{ centroide_ll: "POINT(5.6 52.0)", type: "adres", postcode: new URL(url).searchParams.get("q").match(/\d{4}/)?.[0] + "AA" }] } }), { status: 200 });
  }
  throw new Error(`test: no network allowed, tried ${url}`);
};

const worker = (await import("./backend-worker.js")).default;
const { mapShopifyOrder } = await import("./backend-worker.js");

const DRS = "de-rijplaten-specialist.myshopify.com";
const DSP = "slowfeeder-specialist.myshopify.com";
const PLANNER = "planner-code-voor-tests";
const DRIVER = "bezorger-code-voor-tests";

function makeEnv(extra = {}) {
  return { PLANNING_ORDERS: new MemoryKV(), OPERATOR_KEY: PLANNER, DRIVER_KEY: DRIVER, SHOPIFY_ADMIN_TOKEN: "test-token", SHOPIFY_WEBHOOK_SECRET: "webhook-secret", SHOPIFY_CLIENT_ID: "client", SHOPIFY_CLIENT_SECRET: "client-secret", CORS_ORIGIN: "https://example.test", ...extra };
}

async function call(env, method, path, { key, body, headers = {} } = {}) {
  fetchesThisRequest = 0;
  const request = new Request(`https://worker.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { "x-operator-key": key } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const response = await worker.fetch(request, env);
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers, fetches: fetchesThisRequest };
}

function amsterdamDay(offset = 0) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

let nextShopifyId = 9000;
function shopifyOrder(shopDomain, name, overrides = {}) {
  nextShopifyId += 1;
  return {
    id: nextShopifyId,
    name,
    admin_graphql_api_id: `gid://shopify/Order/${nextShopifyId}`,
    financial_status: "paid",
    created_at: "2026-09-22T10:00:00+02:00",
    updated_at: "2026-09-22T10:00:00+02:00",
    fulfillment_status: null,
    cancelled_at: null,
    tags: "",
    note: "Graag achterom",
    shipping_address: { first_name: "Test", last_name: `Klant ${name}`, address1: "Voorbeeldweg 1", city: "Doorn", zip: "3941 BX", country_code: "NL", phone: "06 1234 5678" },
    shipping_lines: [{ title: "Bezorgen" }],
    note_attributes: [{ name: "Bezorgdatum", value: amsterdamDay(4) }],
    line_items: [{ title: "Kunststof rijplaat 240x120x2 cm", quantity: 4, grams: 0 }],
    ...overrides,
  };
}

async function seedOrder(env, shopDomain, name, overrides = {}) {
  const raw = shopifyOrder(shopDomain, name, overrides);
  const order = mapShopifyOrder(raw, shopDomain);
  await env.PLANNING_ORDERS.put(`order:${shopDomain}:${order.id}`, JSON.stringify(order));
  shop.add(order.shopifyOrderId);
  return { raw, order, key: `${shopDomain}:${order.id}` };
}

async function webhook(env, shopDomain, payload) {
  const body = JSON.stringify(payload);
  const keyData = await crypto.subtle.importKey("raw", new TextEncoder().encode("webhook-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", keyData, new TextEncoder().encode(body)))));
  return call(env, "POST", "/webhooks/shopify/orders", { body, headers: { "x-shopify-hmac-sha256": signature, "x-shopify-shop-domain": shopDomain } });
}

const results = [];
async function test(name, fn) {
  shop.reset();
  try {
    await fn();
    results.push(["ok", name]);
  } catch (error) {
    results.push(["FOUT", name, error]);
  }
}

// ---------------------------------------------------------------------------

await test("zonder code 401, bezorger op planner-actie 403, verkeerde code 401", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "GET", "/orders")).status, 401);
  assert.equal((await call(env, "GET", "/orders", { key: "fout" })).status, 401);
  assert.equal((await call(env, "POST", "/plan/assign", { key: DRIVER, body: {} })).status, 403);
  assert.equal((await call(env, "POST", "/actions/undo-delivered", { key: DRIVER, body: {} })).status, 403);
  assert.equal((await call(env, "POST", "/actions/set-own-delivery", { key: DRIVER, body: {} })).status, 403);
  assert.equal((await call(env, "POST", "/plan/remove-stop", { key: DRIVER, body: {} })).status, 403);
  assert.equal((await call(env, "GET", "/whoami", { key: DRIVER })).data.role, "driver");
});

await test("bezorger krijgt geen klantgegevens van orders buiten zijn ritten", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS1");
  const b = await seedOrder(env, DRS, "#DRS2");
  await seedOrder(env, DRS, "#DRS3", { note_attributes: [{ name: "Bezorgdatum", value: "2026-09-01" }] });
  await env.PLANNING_ORDERS.put("geo:voorbeeldweg 1, 3941 bx doorn, nl", JSON.stringify({ lat: 52.03, lon: 5.32 }));
  const planned = await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(1), name: "Doorn", orderKeys: [a.key] } });
  assert.equal(planned.status, 200);

  const orders = (await call(env, "GET", "/orders", { key: DRIVER })).data;
  assert.equal(orders.length, 3, "slank, dus ook de verborgen order, maar zonder persoonsgegevens");
  for (const order of orders) {
    for (const field of ["customer", "fullAddress", "addressLine", "phone", "customerNote"]) assert.ok(!(field in order), `${field} lekt naar de bezorger`);
    assert.equal(order.postcode, "3941");
    assert.deepEqual(order.point, { lat: 52.03, lon: 5.32 });
  }
  const plan = (await call(env, "GET", `/plan?from=${amsterdamDay(-7)}`, { key: DRIVER })).data;
  assert.equal(plan.stops.length, 1);
  assert.equal(plan.stops[0].id, a.order.id);
  assert.equal(plan.stops[0].phone, "06 1234 5678");
  assert.ok(!plan.stops.some((stop) => stop.id === b.order.id));

  const full = (await call(env, "GET", "/orders", { key: PLANNER })).data;
  assert.equal(full.length, 3);
  assert.ok(full[0].customer);
});

await test("inplannen: vast nummer, dubbelklik maakt geen tweede rit, dubbele order geweigerd, markup geweigerd", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS10");
  const b = await seedOrder(env, DRS, "#DRS11");
  const body = { id: "11111111-aaaa-bbbb-cccc-000000000001", date: amsterdamDay(2), name: "Doorn", orderKeys: [a.key, b.key] };
  const first = await call(env, "POST", "/plan/assign", { key: PLANNER, body });
  const again = await call(env, "POST", "/plan/assign", { key: PLANNER, body });
  assert.equal(first.data.route.number, 1);
  assert.equal(again.data.route.number, 1);
  assert.equal(again.data.already, true);
  const plan = (await call(env, "GET", "/plan", { key: PLANNER })).data;
  assert.equal(plan.routes.length, 1);

  const clash = await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(3), name: "Nog eens", orderKeys: [a.key] } });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /staat al in rit 1/);

  const markup = await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(3), orderKeys: ['x:<img src=x onerror=alert(1)>'] } });
  assert.equal(markup.status, 400);

  const record = env.PLANNING_ORDERS.entry(`plan:${amsterdamDay(2)}:${body.id}`);
  const expected = Date.parse(`${amsterdamDay(62)}T12:00:00Z`) / 1000;
  assert.equal(record.expiration, expected, "rit verloopt 60 dagen na zijn datum");
  assert.ok(env.PLANNING_ORDERS.entry("ritnummer:1"), "nummermarker buiten de plan-lijst");
  assert.equal(env.PLANNING_ORDERS.entry("plan-number:1"), null);
});

await test("pakket in een rit krijgt de tag eigen bezorging; mislukt de tag, dan wordt niets ingepland", async () => {
  const env = makeEnv();
  const plaat = await seedOrder(env, DRS, "#DRS20");
  const pakket = await seedOrder(env, DSP, "#DSP20", { line_items: [{ title: "Pure Psyllium - Vlozaad", quantity: 1 }] });
  shop.failNext = "tag";
  const failed = await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(1), orderKeys: [plaat.key, pakket.key], tagKeys: [pakket.key] } });
  assert.equal(failed.status, 502);
  assert.equal((await call(env, "GET", "/plan", { key: PLANNER })).data.routes.length, 0);

  const ok = await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(1), orderKeys: [plaat.key, pakket.key], tagKeys: [pakket.key] } });
  assert.equal(ok.status, 200);
  assert.ok(shop.orders.get(pakket.order.shopifyOrderId).tags.has("eigen bezorging"));
  assert.equal((await env.PLANNING_ORDERS.get(`order:${pakket.key}`, "json")).ownDeliveryTagged, true);
  assert.ok(!shop.orders.get(pakket.order.shopifyOrderId).note.includes("Voorbeeldweg"), "geen adres in de Shopify-notitie");
});

await test("stop erbij: bezorger mag in zijn week, tag en stop samen, geen order in twee ritten", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS30");
  const pakket = await seedOrder(env, DSP, "#DSP30", { line_items: [{ title: "Pure Psyllium - Vlozaad", quantity: 1 }] });
  const c = await seedOrder(env, DRS, "#DRS31");
  await env.PLANNING_ORDERS.put("geo:voorbeeldweg 1, 3941 bx doorn, nl", JSON.stringify({ lat: 52.03, lon: 5.32 }));
  const route = (await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(0), orderKeys: [a.key] } })).data.route;
  const other = (await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(1), orderKeys: [c.key] } })).data.route;

  // What the driver may not: add to a route they are not driving (tomorrow's),
  // or add an order the planning would never offer (unpaid, far past the day).
  const unpaid = await seedOrder(env, DSP, "#DSP31", { financial_status: "pending", line_items: [{ title: "Pure Psyllium - Vlozaad", quantity: 1 }] });
  assert.equal((await call(env, "POST", "/plan/add-stop", { key: DRIVER, body: { id: other.id, date: other.date, orderKey: pakket.key } })).status, 403, "rit van morgen");
  assert.equal((await call(env, "POST", "/plan/add-stop", { key: DRIVER, body: { id: route.id, date: route.date, orderKey: unpaid.key } })).status, 403, "onbetaald");
  const ver = await seedOrder(env, DRS, "#DRS32", { shipping_address: { first_name: "Ver", last_name: "Weg", address1: "Voorbeeldweg 2", city: "Maastricht", zip: "6211 AA", country_code: "NL" } });
  await env.PLANNING_ORDERS.put("geo:voorbeeldweg 2, 6211 aa maastricht, nl", JSON.stringify({ lat: 50.85, lon: 5.69 }));
  const teVer = await call(env, "POST", "/plan/add-stop", { key: DRIVER, body: { id: route.id, date: route.date, orderKey: ver.key } });
  assert.equal(teVer.status, 403, "voorbij 5:45");
  assert.match(teVer.data.error, /5:45/);
  const plan = (await call(env, "GET", "/plan", { key: DRIVER })).data;
  assert.ok(!plan.stops.some((stop) => stop.id === ver.order.id || stop.id === unpaid.order.id), "geen gegevens via een geweigerde stop");

  const added = await call(env, "POST", "/plan/add-stop", { key: DRIVER, body: { id: route.id, date: route.date, orderKey: pakket.key, tag: true, position: 0, name: "Doorn en Leersum" } });
  assert.equal(added.status, 200);
  assert.deepEqual(added.data.route.orderKeys, [pakket.key, a.key]);
  assert.equal(added.data.route.name, "Doorn en Leersum");
  assert.ok(shop.orders.get(pakket.order.shopifyOrderId).tags.has("eigen bezorging"));

  const twice = await call(env, "POST", "/plan/add-stop", { key: DRIVER, body: { id: route.id, date: route.date, orderKey: c.key } });
  assert.equal(twice.status, 409, "order uit een andere rit mag er niet bij");
  assert.equal(other.orderKeys[0], c.key);

  const fake = await call(env, "POST", "/plan/add-stop", { key: DRIVER, body: { id: route.id, date: route.date, orderKey: `${DRS}:#BESTAATNIET` } });
  assert.equal(fake.status, 404);
  const markup = await call(env, "POST", "/plan/add-stop", { key: DRIVER, body: { id: route.id, date: route.date, orderKey: "x:<img onerror=1>" } });
  assert.equal(markup.status, 400);

  const removed = await call(env, "POST", "/plan/remove-stop", { key: PLANNER, body: { id: route.id, date: route.date, orderKey: pakket.key } });
  assert.deepEqual(removed.data.route.orderKeys, [a.key]);
});

await test("bezorgd: geen klantmail, vraag onder 1000 punten, dubbel tikken veilig, bezorger alleen eigen stops", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS40");
  const b = await seedOrder(env, DRS, "#DRS41");
  await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(0), orderKeys: [a.key] } });

  const notMine = await call(env, "POST", "/actions/mark-delivered", { key: DRIVER, body: { id: b.order.id, shopDomain: DRS } });
  assert.equal(notMine.status, 403);

  const done = await call(env, "POST", "/actions/mark-delivered", { key: DRIVER, body: { id: a.order.id, shopDomain: DRS } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(shop.mails.length, 0, "Bezorgd mailt de klant niet");
  assert.ok(shop.orders.get(a.order.shopifyOrderId).fulfilled);
  assert.equal(await env.PLANNING_ORDERS.get(`order:${a.key}`), null);
  const record = env.PLANNING_ORDERS.entry(`delivered:${a.key}`);
  assert.ok(record.expiration > Date.now() / 1000 + 59 * 86400, "historie verloopt na 60 dagen");
  assert.ok(record.metadata.deliveredAt);
  const stored = JSON.parse(record.value);
  assert.ok(stored.fulfillment.id);
  assert.ok(!("phone" in stored.order) && !("customerNote" in stored.order));

  const again = await call(env, "POST", "/actions/mark-delivered", { key: DRIVER, body: { id: a.order.id, shopDomain: DRS } });
  assert.equal(again.status, 200);
  assert.equal(again.data.already, true);
});

await test("al in Shopify verzonden: Bezorgd lukt gewoon, zonder foutmelding", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS50");
  shop.orders.get(a.order.shopifyOrderId).fulfilled = true;
  const done = await call(env, "POST", "/actions/mark-delivered", { key: PLANNER, body: { id: a.order.id, shopDomain: DRS } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
});

await test("webhook na Bezorgd laat het record heel, zodat Terugdraaien Shopify echt terugdraait", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS60");
  await call(env, "POST", "/actions/mark-delivered", { key: PLANNER, body: { id: a.order.id, shopDomain: DRS } });
  const fulfilledPayload = { ...a.raw, fulfillment_status: "fulfilled", updated_at: new Date(Date.now() + 5000).toISOString(), fulfillments: [{ created_at: new Date().toISOString() }] };
  assert.equal((await webhook(env, DRS, fulfilledPayload)).status, 200);
  const record = await env.PLANNING_ORDERS.get(`delivered:${a.key}`, "json");
  assert.notEqual(record.source, "shopify");
  assert.ok(record.fulfillment?.id);

  const undo = await call(env, "POST", "/actions/undo-delivered", { key: PLANNER, body: { id: a.order.id, shopDomain: DRS } });
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  assert.equal(shop.orders.get(a.order.shopifyOrderId).fulfilled, false);
  assert.ok(await env.PLANNING_ORDERS.get(`order:${a.key}`));
});

await test("Terugdraaien van een order die in Shopify zelf verzonden is: weigert met uitleg", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DSP, "#DSP70", { line_items: [{ title: "Pure Psyllium - Vlozaad", quantity: 1 }] });
  await webhook(env, DSP, { ...a.raw, fulfillment_status: "fulfilled", updated_at: new Date().toISOString() });
  const undo = await call(env, "POST", "/actions/undo-delivered", { key: PLANNER, body: { id: a.order.id, shopDomain: DSP } });
  assert.equal(undo.status, 409);
  assert.match(undo.data.error, /in Shopify zelf/);
});

await test("oude webhook na een nieuwere verandert niets", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS80");
  await webhook(env, DRS, { ...a.raw, fulfillment_status: "fulfilled", updated_at: "2026-09-25T12:00:00+02:00" });
  const late = await webhook(env, DRS, { ...a.raw, tags: "iets", updated_at: "2026-09-25T11:59:00+02:00" });
  assert.equal(late.status, 200);
  assert.equal(await env.PLANNING_ORDERS.get(`order:${a.key}`), null, "oude payload zette de order weer open");
  assert.ok(await env.PLANNING_ORDERS.get(`delivered:${a.key}`));
});

await test("webhook: geannuleerd blijft 14 dagen, notitie van de planning geknipt, verwijderde regels tellen niet, terugbetaald herkend", async () => {
  const env = makeEnv();
  const raw = shopifyOrder(DSP, "#DSP90", {
    note: "Achterom a.u.b.\n\n[Vervoersplanning]\nEigen bezorging via Vervoersplanning",
    line_items: [{ title: "Slowfeeder XXL Pony Edition", quantity: 1, current_quantity: 0 }, { title: "Pure Psyllium - Vlozaad", quantity: 1, current_quantity: 1 }],
    financial_status: "refunded",
    tags: "Eigen bezorging, iets",
  });
  await webhook(env, DSP, raw);
  const stored = await env.PLANNING_ORDERS.get(`order:${DSP}:#DSP90`, "json");
  assert.equal(stored.customerNote, "Achterom a.u.b.");
  assert.deepEqual(stored.products, ["1x Pure Psyllium - Vlozaad"]);
  assert.equal(stored.refunded, true);
  assert.equal(stored.paymentStatus, "Terugbetaald");
  assert.equal(stored.ownDeliveryTagged, true);

  await webhook(env, DSP, { ...raw, cancelled_at: "2026-09-25T10:00:00Z", updated_at: new Date().toISOString() });
  const entry = env.PLANNING_ORDERS.entry(`order:${DSP}:#DSP90`);
  assert.ok(entry, "geannuleerde order blijft even staan");
  assert.equal(JSON.parse(entry.value).cancelled, true);
  assert.ok(entry.expiration < Date.now() / 1000 + 15 * 86400);
});

await test("onmogelijke leverdatum wordt niet overgenomen", async () => {
  const order = mapShopifyOrder(shopifyOrder(DRS, "#DRS99", { note_attributes: [{ name: "Leverdatum", value: "2026-13-01" }] }), DRS);
  assert.notEqual(order.dueDate, "2026-13-01");
  assert.match(order.dueDate, /^\d{4}-\d{2}-\d{2}$/);
});

await test("historie: de 50 nieuwste zonder alles te lezen, en bezorgde ritstops per sleutel", async () => {
  const env = makeEnv();
  for (let index = 0; index < 120; index += 1) {
    const at = new Date(Date.UTC(2026, 8, 1, 8, index)).toISOString();
    await env.PLANNING_ORDERS.put(`delivered:${DRS}:#H${index}`, JSON.stringify({ id: `#H${index}`, shopDomain: DRS, deliveredAt: at }), { expirationTtl: 86400, metadata: { deliveredAt: at } });
  }
  env.PLANNING_ORDERS.ops.get = 0;
  const history = await call(env, "GET", `/history?keys=${encodeURIComponent(`${DRS}:#H3`)}`, { key: PLANNER });
  assert.equal(history.data.entries.length, 50);
  assert.equal(history.data.entries[0].id, "#H119");
  assert.ok(env.PLANNING_ORDERS.ops.get <= 50, `las ${env.PLANNING_ORDERS.ops.get} records`);
  assert.ok(history.data.delivered[`${DRS}:#H3`]);
  const driver = await call(env, "GET", `/history?keys=${encodeURIComponent(`${DRS}:#H3`)}`, { key: DRIVER });
  assert.equal(driver.data.entries.length, 0);
  assert.ok(driver.data.delivered[`${DRS}:#H3`]);
});

await test("agenda blijft compleet boven 1000 sleutels", async () => {
  const env = makeEnv();
  for (let index = 0; index < 1100; index += 1) {
    await env.PLANNING_ORDERS.put(`plan-announce:2026-01-01-${String(index).padStart(4, "0")}`, "{}", { expirationTtl: 86400 });
  }
  const a = await seedOrder(env, DRS, "#DRS100");
  await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(1), orderKeys: [a.key] } });
  const plan = (await call(env, "GET", `/plan?from=${amsterdamDay(-7)}`, { key: PLANNER })).data;
  assert.equal(plan.routes.length, 1);
});

await test("Shopify-installatie alleen voor de eigen winkels, zonder KV-schrijfactie", async () => {
  const env = makeEnv();
  const vreemd = await call(env, "GET", "/auth/shopify?shop=example.org/x.myshopify.com");
  assert.equal(vreemd.status, 400);
  const anders = await call(env, "GET", "/auth/shopify?shop=iemand-anders.myshopify.com");
  assert.equal(anders.status, 400);
  const eigen = await call(env, "GET", `/auth/shopify?shop=${DRS}`);
  assert.equal(eigen.status, 302);
  assert.match(eigen.headers.get("location"), /^https:\/\/de-rijplaten-specialist\.myshopify\.com\/admin\/oauth\/authorize/);
  assert.equal(env.PLANNING_ORDERS.ops.put, 0);
});

await test("Shopify's webhook midden in Bezorgd overschrijft het record niet", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS600");
  // Shopify answers the fulfillment with a webhook before the Worker is done.
  const original = fakeShopify;
  let fired = false;
  shop.onFulfilled = async () => {
    if (fired) return;
    fired = true;
    await webhook(env, DRS, { ...a.raw, fulfillment_status: "fulfilled", updated_at: new Date(Date.now() + 500).toISOString() });
  };
  const done = await call(env, "POST", "/actions/mark-delivered", { key: PLANNER, body: { id: a.order.id, shopDomain: DRS } });
  shop.onFulfilled = null;
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.ok(fired, "webhook kwam tussendoor");
  const record = await env.PLANNING_ORDERS.get(`delivered:${a.key}`, "json");
  assert.equal(record.source, "planner");
  assert.ok(record.fulfillment?.id, "Terugdraaien kent de fulfillment nog");
  assert.equal(typeof original, "function");
});

await test("zelfde rit nog eens op een andere dag gezet: verplaatst, geen tweede rit", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS610");
  const body = { id: "22222222-aaaa-bbbb-cccc-000000000002", name: "Doorn", orderKeys: [a.key] };
  assert.equal((await call(env, "POST", "/plan/assign", { key: PLANNER, body: { ...body, date: amsterdamDay(2) } })).status, 200);
  const again = await call(env, "POST", "/plan/assign", { key: PLANNER, body: { ...body, date: amsterdamDay(3) } });
  assert.equal(again.status, 200);
  assert.equal(again.data.route.number, 1, "zelfde nummer");
  const routes = (await call(env, "GET", "/plan", { key: PLANNER })).data.routes;
  assert.deepEqual(routes.map((route) => route.date), [amsterdamDay(3)]);
});

await test("een onafgemaakte rit van gisteren houdt zijn orders vast", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS620");
  await env.PLANNING_ORDERS.put(`plan:${amsterdamDay(-1)}:gisteren`, JSON.stringify({ id: "gisteren", number: 4, date: amsterdamDay(-1), name: "Doorn", orderKeys: [a.key] }), { expirationTtl: 86400 * 30 });
  const clash = await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(1), orderKeys: [a.key] } });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /rit 4/);
});

await test("mislukt inplannen haalt de al gezette tags weer weg", async () => {
  const env = makeEnv();
  const een = await seedOrder(env, DSP, "#DSP630", { line_items: [{ title: "Pure Psyllium - Vlozaad", quantity: 1 }] });
  const twee = await seedOrder(env, DSP, "#DSP631", { line_items: [{ title: "Pure Psyllium - Vlozaad", quantity: 1 }] });
  shop.failTagFor = twee.order.shopifyOrderId;
  const result = await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(1), orderKeys: [een.key, twee.key], tagKeys: [een.key, twee.key] } });
  shop.failTagFor = null;
  assert.equal(result.status, 502);
  assert.ok(!shop.orders.get(een.order.shopifyOrderId).tags.has("eigen bezorging"), "tag van de eerste is teruggedraaid");
  assert.equal((await env.PLANNING_ORDERS.get(`order:${een.key}`, "json")).ownDeliveryTagged, false);
});

await test("Bezorgd op een geannuleerde order wordt geweigerd", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS640");
  await webhook(env, DRS, { ...a.raw, cancelled_at: "2026-09-25T10:00:00Z", updated_at: new Date().toISOString() });
  const done = await call(env, "POST", "/actions/mark-delivered", { key: PLANNER, body: { id: a.order.id, shopDomain: DRS } });
  assert.equal(done.status, 409);
  assert.match(done.data.error, /geannuleerd/);
  assert.equal(shop.orders.get(a.order.shopifyOrderId).fulfilled, false);
});

await test("bezorgtijden in één tijdzone, en DHL-pakketten zonder naam en adres in de historie", async () => {
  const env = makeEnv();
  const pakket = await seedOrder(env, DSP, "#DSP650", { line_items: [{ title: "Pure Psyllium - Vlozaad", quantity: 1 }] });
  await webhook(env, DSP, { ...pakket.raw, fulfillment_status: "fulfilled", updated_at: new Date().toISOString(), fulfillments: [{ created_at: "2026-09-25T09:14:51+02:00" }] });
  const entry = env.PLANNING_ORDERS.entry(`delivered:${pakket.key}`);
  assert.equal(entry.metadata.deliveredAt, "2026-09-25T07:14:51.000Z");
  const record = JSON.parse(entry.value);
  assert.ok(!record.order.customer && !record.order.fullAddress, "geen naam of adres van een DHL-pakket");
  assert.equal(record.order.city, "Doorn");
});

await test("oude schermen krijgen de historie nog als lijst", async () => {
  const env = makeEnv();
  const legacy = await call(env, "GET", "/history", { key: PLANNER });
  assert.ok(Array.isArray(legacy.data));
  const nieuw = await call(env, "GET", "/history?keys=", { key: PLANNER });
  assert.ok(!Array.isArray(nieuw.data) && Array.isArray(nieuw.data.entries));
});

await test("een notitie van de planner overschrijft een afgebroken rit niet", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS660");
  const route = (await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(0), orderKeys: [a.key] } })).data.route;
  await call(env, "POST", "/plan/abort", { key: DRIVER, body: { id: route.id, date: route.date, reason: "bus kapot" } });
  await call(env, "POST", "/plan/note", { key: PLANNER, body: { id: route.id, date: route.date, note: "Bel de klant" } });
  const plan = (await call(env, "GET", "/plan", { key: PLANNER })).data.routes[0];
  assert.ok(plan.abortedAt, "afbreken bleef staan");
  assert.equal(plan.note, "Bel de klant");
});

await test("concept: opslaan, houdt orders vast, inplannen haalt het concept weg", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS700");
  const b = await seedOrder(env, DRS, "#DRS701");
  const c = await seedOrder(env, DRS, "#DRS702");
  const id = "33333333-aaaa-bbbb-cccc-000000000003";
  assert.equal((await call(env, "POST", "/concepts/save", { key: DRIVER, body: { id, orderKeys: [a.key] } })).status, 403, "alleen de planner");
  const saved = await call(env, "POST", "/concepts/save", { key: PLANNER, body: { id, name: "Doorn", orderKeys: [a.key, b.key] } });
  assert.equal(saved.status, 200);
  const plan = (await call(env, "GET", "/plan", { key: PLANNER })).data;
  assert.equal(plan.concepts.length, 1);
  assert.deepEqual(plan.concepts[0].orderKeys, [a.key, b.key]);
  const driverPlan = (await call(env, "GET", "/plan", { key: DRIVER })).data;
  assert.ok(!driverPlan.concepts, "de bezorger krijgt geen concepten");
  assert.deepEqual(driverPlan.heldKeys.sort(), [a.key, b.key].sort());

  const second = await call(env, "POST", "/concepts/save", { key: PLANNER, body: { name: "Anders", orderKeys: [b.key, c.key] } });
  assert.equal(second.status, 409, "een order in twee concepten");
  const planWithHeld = await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(1), orderKeys: [a.key] } });
  assert.equal(planWithHeld.status, 409, "een order uit een concept los inplannen");
  assert.match(planWithHeld.data.error, /concept Doorn/);

  // Changing the concept keeps its creation date.
  const changed = await call(env, "POST", "/concepts/save", { key: PLANNER, body: { id, name: "Doorn en meer", orderKeys: [a.key, b.key, c.key] } });
  assert.equal(changed.data.concept.createdAt, saved.data.concept.createdAt);

  const planned = await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(1), name: "Doorn en meer", orderKeys: [a.key, b.key, c.key], conceptId: id } });
  assert.equal(planned.status, 200, JSON.stringify(planned.data));
  const after = (await call(env, "GET", "/plan", { key: PLANNER })).data;
  assert.equal(after.concepts.length, 0, "het concept is een rit geworden");
  assert.equal(after.routes.length, 1);
  const again = await call(env, "POST", "/concepts/save", { key: PLANNER, body: { orderKeys: [a.key] } });
  assert.equal(again.status, 409, "een ingeplande order kan niet in een concept");
});

await test("concept: de bezorger kan een concept-order niet meenemen, verwijderen geeft hem vrij", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS710");
  const b = await seedOrder(env, DRS, "#DRS711");
  await env.PLANNING_ORDERS.put("geo:voorbeeldweg 1, 3941 bx doorn, nl", JSON.stringify({ lat: 52.03, lon: 5.32 }));
  const route = (await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(0), orderKeys: [a.key] } })).data.route;
  const id = "44444444-aaaa-bbbb-cccc-000000000004";
  await call(env, "POST", "/concepts/save", { key: PLANNER, body: { id, name: "Later", orderKeys: [b.key] } });
  const blocked = await call(env, "POST", "/plan/add-stop", { key: DRIVER, body: { id: route.id, date: route.date, orderKey: b.key } });
  assert.equal(blocked.status, 409);
  assert.equal((await call(env, "POST", "/concepts/remove", { key: PLANNER, body: { id } })).status, 200);
  const free = await call(env, "POST", "/plan/add-stop", { key: DRIVER, body: { id: route.id, date: route.date, orderKey: b.key } });
  assert.equal(free.status, 200, JSON.stringify(free.data));
});

await test("concept: wat er intussen bij kwam blijft staan, en een nieuwe poging ruimt het concept alsnog op", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS720");
  const b = await seedOrder(env, DRS, "#DRS721");
  const id = "55555555-aaaa-bbbb-cccc-000000000005";
  await call(env, "POST", "/concepts/save", { key: PLANNER, body: { id, name: "Doorn", orderKeys: [a.key, b.key] } });
  const planned = await call(env, "POST", "/plan/assign", { key: PLANNER, body: { id: "66666666-aaaa-bbbb-cccc-000000000006", date: amsterdamDay(1), orderKeys: [a.key], conceptId: id } });
  assert.equal(planned.status, 200, JSON.stringify(planned.data));
  assert.deepEqual(planned.data.conceptLeft, [b.key]);
  const left = (await call(env, "GET", "/plan", { key: PLANNER })).data.concepts;
  assert.deepEqual(left.map((concept) => concept.orderKeys), [[b.key]]);

  // A concept that is not about these orders is left alone.
  const other = "77777777-aaaa-bbbb-cccc-000000000007";
  const c = await seedOrder(env, DRS, "#DRS722");
  const d = await seedOrder(env, DRS, "#DRS723");
  await call(env, "POST", "/concepts/save", { key: PLANNER, body: { id: other, name: "Anders", orderKeys: [d.key] } });
  await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(2), orderKeys: [c.key], conceptId: other } });
  assert.ok((await call(env, "GET", "/plan", { key: PLANNER })).data.concepts.some((concept) => concept.id === other));

  // Half finished: the route saved, the concept not cleared. The retry clears it.
  const third = "88888888-aaaa-bbbb-cccc-000000000008";
  const routeId = "99999999-aaaa-bbbb-cccc-000000000009";
  await env.PLANNING_ORDERS.delete(`plan-concept:${id}`);
  await call(env, "POST", "/concepts/save", { key: PLANNER, body: { id: third, name: "Doorn", orderKeys: [b.key] } });
  await env.PLANNING_ORDERS.put(`plan:${amsterdamDay(3)}:${routeId}`, JSON.stringify({ id: routeId, number: 9, date: amsterdamDay(3), name: "Doorn", orderKeys: [b.key] }), { expirationTtl: 86400 * 30 });
  const retry = await call(env, "POST", "/plan/assign", { key: PLANNER, body: { id: routeId, date: amsterdamDay(3), orderKeys: [b.key], conceptId: third } });
  assert.equal(retry.data.already, true);
  assert.ok(!(await call(env, "GET", "/plan", { key: PLANNER })).data.concepts.some((concept) => concept.id === third));

  // A change to a concept removed elsewhere does not bring it back.
  const gone = await call(env, "POST", "/concepts/save", { key: PLANNER, body: { id: third, orderKeys: [b.key], update: true } });
  assert.equal(gone.status, 404);
});

// --- The announcement --------------------------------------------------------

function scheduledAt(iso) {
  return { scheduledTime: Date.parse(iso) };
}

// The cron's own clock: it announces "tomorrow" as seen from its trigger time.
const cronDay = "2026-10-06";
const cronRouteDay = "2026-10-07";

await test("aankondiging op proef: niets naar Shopify, onbetaald en terugbetaald overgeslagen", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS200");
  const unpaid = await seedOrder(env, DRS, "#DRS201", { financial_status: "pending" });
  const refunded = await seedOrder(env, DRS, "#DRS202", { financial_status: "refunded" });
  await env.PLANNING_ORDERS.put(`plan:${cronRouteDay}:r1`, JSON.stringify({ id: "r1", number: 1, date: cronRouteDay, name: "Doorn", orderKeys: [a.key, unpaid.key, refunded.key] }));
  await worker.scheduled(scheduledAt(`${cronDay}T14:00:00Z`), env);
  const log = await env.PLANNING_ORDERS.get(`plan-announce:${cronRouteDay}`, "json");
  assert.equal(log.mode, "proef");
  assert.deepEqual(log.routes[0].results.map((result) => result.status), ["zou aangekondigd worden", "niet betaald, niet aangekondigd", "terugbetaald, niet aangekondigd"]);
  assert.equal(shop.calls, 0);
  assert.equal((await env.PLANNING_ORDERS.list({ prefix: "announced:" })).keys.length, 0);
});

await test("aankondiging om 15:00 en om 17:00 doet niets, in winter- en zomertijd", async () => {
  const env = makeEnv();
  await worker.scheduled(scheduledAt(`${cronDay}T15:00:00Z`), env);
  await worker.scheduled(scheduledAt("2026-12-01T14:00:00Z"), env);
  assert.equal((await env.PLANNING_ORDERS.list({ prefix: "plan-announce:" })).keys.length, 0);
  await worker.scheduled(scheduledAt("2026-12-01T15:00:00Z"), env);
  assert.equal((await env.PLANNING_ORDERS.list({ prefix: "plan-announce:" })).keys.length, 1);
});

await test("aankondiging echt: mail, order blijft op de rit, Bezorgd stuurt geen tweede mail en kan terug", async () => {
  const env = makeEnv({ AUTO_FULFILL: "aan" });
  const a = await seedOrder(env, DRS, "#DRS210");
  await env.PLANNING_ORDERS.put(`plan:${cronRouteDay}:r1`, JSON.stringify({ id: "r1", number: 1, date: cronRouteDay, name: "Doorn", orderKeys: [a.key] }));
  await worker.scheduled(scheduledAt(`${cronDay}T14:00:00Z`), env);
  assert.deepEqual(shop.mails, [a.order.shopifyOrderId]);
  const marker = await env.PLANNING_ORDERS.get(`announced:${a.key}`, "json");
  assert.ok(marker.fulfillmentId);

  await webhook(env, DRS, { ...a.raw, fulfillment_status: "fulfilled", updated_at: new Date(Date.now() + 1000).toISOString() });
  const stillOpen = await env.PLANNING_ORDERS.get(`order:${a.key}`, "json");
  assert.equal(stillOpen.announced, true);
  assert.equal(stillOpen.fulfilled, false);

  const done = await call(env, "POST", "/actions/mark-delivered", { key: PLANNER, body: { id: a.order.id, shopDomain: DRS } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(shop.mails.length, 1, "geen tweede mail");
  assert.equal(await env.PLANNING_ORDERS.get(`announced:${a.key}`), null);
  const record = await env.PLANNING_ORDERS.get(`delivered:${a.key}`, "json");
  assert.equal(record.fulfillment.id, marker.fulfillmentId, "Terugdraaien kent de fulfillment van de aankondiging");
});

await test("aankondiging: Shopify weigert (markering weg), geen antwoord (markering blijft), onterechte markering wordt opgeruimd", async () => {
  const env = makeEnv({ AUTO_FULFILL: "aan" });
  const refused = await seedOrder(env, DRS, "#DRS220");
  const lost = await seedOrder(env, DRS, "#DRS221");
  await env.PLANNING_ORDERS.put(`plan:${cronRouteDay}:r1`, JSON.stringify({ id: "r1", number: 1, date: cronRouteDay, name: "Doorn", orderKeys: [refused.key] }));
  shop.failNext = "user-error";
  await worker.scheduled(scheduledAt(`${cronDay}T14:00:00Z`), env);
  let log = await env.PLANNING_ORDERS.get(`plan-announce:${cronRouteDay}`, "json");
  assert.match(log.routes[0].results[0].status, /^mislukt: Shopify weigerde/);
  assert.equal(await env.PLANNING_ORDERS.get(`announced:${refused.key}`), null);

  await env.PLANNING_ORDERS.put(`plan:${cronRouteDay}:r2`, JSON.stringify({ id: "r2", number: 2, date: cronRouteDay, name: "Doorn", orderKeys: [lost.key] }));
  shop.failNext = { mode: "network-during", gid: lost.order.shopifyOrderId };
  await worker.scheduled(scheduledAt(`${cronDay}T14:10:00Z`), env);
  log = await env.PLANNING_ORDERS.get(`plan-announce:${cronRouteDay}`, "json");
  const statuses = Object.fromEntries(log.routes.flatMap((route) => route.results).map((result) => [result.id, result.status]));
  assert.equal(statuses["#DRS220"], "aangekondigd", "tweede kans om 16:10");
  assert.match(statuses["#DRS221"], /^onzeker/);
  assert.ok(await env.PLANNING_ORDERS.get(`announced:${lost.key}`), "markering blijft bij twijfel, geen tweede mail");
  assert.ok(log.retriedAt);

  // The fulfillment of an announced order is undone in Shopify: the marker goes.
  await webhook(env, DRS, { ...lost.raw, fulfillment_status: null, updated_at: new Date(Date.now() + 2000).toISOString() });
  assert.equal(await env.PLANNING_ORDERS.get(`announced:${lost.key}`), null);
});

await test("aankondiging: veel orders passen binnen 50 aanroepen, de rest volgt om 16:10", async () => {
  const env = makeEnv({ AUTO_FULFILL: "aan" });
  const keys = [];
  for (let index = 0; index < 30; index += 1) keys.push((await seedOrder(env, DRS, `#DRS3${String(index).padStart(2, "0")}`)).key);
  await env.PLANNING_ORDERS.put(`plan:${cronRouteDay}:r1`, JSON.stringify({ id: "r1", number: 1, date: cronRouteDay, name: "Druk", orderKeys: keys }));
  let before = shop.calls;
  await worker.scheduled(scheduledAt(`${cronDay}T14:00:00Z`), env);
  assert.ok(shop.calls - before <= 50, `${shop.calls - before} aanroepen in één run`);
  let log = await env.PLANNING_ORDERS.get(`plan-announce:${cronRouteDay}`, "json");
  const waiting = log.routes[0].results.filter((result) => result.status.startsWith("uitgesteld")).length;
  assert.equal(waiting, 8);
  before = shop.calls;
  await worker.scheduled(scheduledAt(`${cronDay}T14:10:00Z`), env);
  assert.ok(shop.calls - before <= 50);
  log = await env.PLANNING_ORDERS.get(`plan-announce:${cronRouteDay}`, "json");
  assert.equal(log.routes[0].results.filter((result) => result.status === "aangekondigd").length, 30);
  assert.equal(shop.mails.length, 30);
});

await test("aankondiging: een fout halverwege laat toch een verslag achter", async () => {
  const env = makeEnv({ AUTO_FULFILL: "aan" });
  await env.PLANNING_ORDERS.put(`plan:${cronRouteDay}:r1`, JSON.stringify({ id: "r1", number: 1, date: cronRouteDay, name: "Doorn", orderKeys: [`${DRS}:#DRS400`] }));
  const kv = env.PLANNING_ORDERS;
  const originalGet = kv.get.bind(kv);
  kv.get = async (key, type) => {
    if (key.startsWith("order:")) throw new Error("KV daglimiet bereikt");
    return originalGet(key, type);
  };
  await worker.scheduled(scheduledAt(`${cronDay}T14:00:00Z`), env);
  kv.get = originalGet;
  const log = await kv.get(`plan-announce:${cronRouteDay}`, "json");
  assert.match(log.error, /daglimiet/);
});

globalThis.fetch = realFetch;
let failed = 0;
for (const [status, name, error] of results) {
  console.log(`${status === "ok" ? "✓" : "✗"} ${name}`);
  if (error) {
    failed += 1;
    console.log(`   ${String(error.stack || error).split("\n").slice(0, 4).join("\n   ")}`);
  }
}
console.log(`${results.length - failed}/${results.length} backend-stromen goed`);
if (failed) process.exit(1);
