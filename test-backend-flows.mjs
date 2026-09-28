// End-to-end checks of the Worker against an in-memory KV and a stand-in for
// Shopify. Nothing here reaches a real shop or a real customer: fetch is
// replaced before the Worker is loaded, and every order and name is made up.
import assert from "node:assert/strict";

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// A KV namespace in memory, with the parts of the real one the Worker leans on:
// sorted listings of at most 1,000 keys with a cursor, metadata, expiry. With
// perKeyRate on it also keeps KV's rule of one write per key per second.
// ---------------------------------------------------------------------------
class MemoryKV {
  constructor() {
    this.map = new Map();
    this.ops = { get: 0, put: 0, delete: 0, list: 0 };
    this.perKeyRate = false;
    this.lastWrite = new Map();
  }
  rate(key) {
    const now = Date.now();
    if (this.perKeyRate && now - (this.lastWrite.get(key) ?? -Infinity) < 1000) throw new Error(`KV PUT failed: 429 Too Many Requests (${key})`);
    this.lastWrite.set(key, now);
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
    this.rate(key);
    this.map.set(key, { value: String(value), expiration, metadata: options.metadata });
  }
  async delete(key) {
    this.ops.delete += 1;
    this.rate(key);
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
      order.fulfillments.push(`gid://shopify/Fulfillment/${order.fulfillments.length + 1}${gid.split("/").pop()}`);
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
    const creates = /fulfillmentCreate\(/.test(JSON.parse(init.body).query);
    let payload;
    try {
      payload = fakeShopify(init.body);
    } catch (error) {
      // Shopify's webhook can come in while the answer is still lost on its way.
      if (creates && shop.onFulfilled) await shop.onFulfilled();
      throw error;
    }
    if (creates && shop.onFulfilled) await shop.onFulfilled();
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
  const at = Date.now() - 3600_000;
  await webhook(env, DRS, { ...a.raw, fulfillment_status: "fulfilled", updated_at: new Date(at).toISOString() });
  const late = await webhook(env, DRS, { ...a.raw, tags: "iets", updated_at: new Date(at - 60_000).toISOString() });
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

  const cancelledAt = new Date(Date.now() - 2 * 86400_000).toISOString();
  await webhook(env, DSP, { ...raw, cancelled_at: cancelledAt, updated_at: new Date().toISOString() });
  const entry = env.PLANNING_ORDERS.entry(`order:${DSP}:#DSP90`);
  assert.ok(entry, "geannuleerde order blijft even staan");
  assert.equal(JSON.parse(entry.value).cancelled, true);
  assert.equal(entry.expiration, Math.floor(Date.parse(cancelledAt) / 1000) + 14 * 86400, "14 dagen na de annulering");
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
  await webhook(env, DRS, { ...a.raw, cancelled_at: new Date(Date.now() - 86400_000).toISOString(), updated_at: new Date().toISOString() });
  const done = await call(env, "POST", "/actions/mark-delivered", { key: PLANNER, body: { id: a.order.id, shopDomain: DRS } });
  assert.equal(done.status, 409);
  assert.match(done.data.error, /geannuleerd/);
  assert.equal(shop.orders.get(a.order.shopifyOrderId).fulfilled, false);
});

await test("bezorgtijden in één tijdzone, en DHL-pakketten zonder naam en adres in de historie", async () => {
  const env = makeEnv();
  const pakket = await seedOrder(env, DSP, "#DSP650", { line_items: [{ title: "Pure Psyllium - Vlozaad", quantity: 1 }] });
  await webhook(env, DSP, { ...pakket.raw, fulfillment_status: "fulfilled", updated_at: new Date().toISOString(), fulfillments: [{ created_at: `${amsterdamDay(-1)}T09:14:51+02:00` }] });
  const entry = env.PLANNING_ORDERS.entry(`delivered:${pakket.key}`);
  assert.equal(entry.metadata.deliveredAt, `${amsterdamDay(-1)}T07:14:51.000Z`);
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

// An order at a known point: the address cache holds its coordinates, as /geo
// would have left them.
async function seedPlaced(env, shopDomain, name, { city, zip, lat, lon }) {
  const seeded = await seedOrder(env, shopDomain, name, { shipping_address: { first_name: "Test", last_name: `Klant ${name}`, address1: `Voorbeeldweg ${name.replace(/\D/g, "")}`, city, zip, country_code: "NL", phone: "06 1234 5678" } });
  if (lat !== undefined) await env.PLANNING_ORDERS.put(`geo:${seeded.order.fullAddress.toLowerCase()}`, JSON.stringify({ lat, lon }));
  return seeded;
}

const DAY_MS = 86400_000;

// The Worker logs every error it answers with a 500 or 503. Errors a test
// causes on purpose need not fill its output.
async function quietly(fn) {
  const log = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = log;
  }
}

await test("concept wijzigen: erbij en eruit tegen de stand van nu, een scherm dat achterloopt maakt niets ongedaan", async () => {
  const env = makeEnv();
  const orders = [];
  for (let index = 0; index < 6; index += 1) orders.push(await seedOrder(env, DRS, `#DRS80${index}`));
  const [a, b, c, d, e, f] = orders;
  const id = "abababab-0000-0000-0000-000000000001";
  const change = (body) => call(env, "POST", "/concepts/save", { key: PLANNER, body: { id, update: true, ...body } });
  await call(env, "POST", "/concepts/save", { key: PLANNER, body: { id, name: "Doorn", orderKeys: [a.key, b.key] } });

  // Screen A adds a stop; screen B, ten minutes behind, adds another and takes one out.
  const fromA = await change({ add: [c.key] });
  assert.equal(fromA.status, 200, JSON.stringify(fromA.data));
  assert.equal(fromA.data.ok, true);
  assert.deepEqual(fromA.data.concept.orderKeys, [a.key, b.key, c.key]);
  const fromB = await change({ add: [d.key], remove: [b.key], name: "Doorn en Zeist" });
  assert.deepEqual(fromB.data.concept.orderKeys, [a.key, c.key, d.key], "de stop van het andere scherm blijft staan");
  assert.equal(fromB.data.concept.name, "Doorn en Zeist");

  // Only taking out lists nothing, and keeps the name when none is sent.
  const lists = env.PLANNING_ORDERS.ops.list;
  const out = await change({ remove: [d.key] });
  assert.equal(out.status, 200);
  assert.equal(env.PLANNING_ORDERS.ops.list, lists, "alleen weghalen leest geen lijsten");
  assert.equal(out.data.concept.name, "Doorn en Zeist");

  // What is added is still checked: planned elsewhere, or in another concept.
  await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(1), orderKeys: [e.key] } });
  const planned = await change({ add: [e.key] });
  assert.equal(planned.status, 409);
  assert.match(planned.data.error, /staat al in rit/);
  await call(env, "POST", "/concepts/save", { key: PLANNER, body: { id: "cdcdcdcd-0000-0000-0000-000000000002", name: "Anders", orderKeys: [f.key] } });
  const held = await change({ add: [f.key] });
  assert.equal(held.status, 409);
  assert.match(held.data.error, /concept Anders/);

  assert.equal((await change({ remove: [a.key, c.key] })).status, 400, "een leeg concept bestaat niet");
  // An older screen still sends the whole list, and still replaces it.
  const whole = await call(env, "POST", "/concepts/save", { key: PLANNER, body: { id, name: "Doorn", orderKeys: [a.key], update: true } });
  assert.deepEqual(whole.data.concept.orderKeys, [a.key]);
  await call(env, "POST", "/concepts/remove", { key: PLANNER, body: { id } });
  assert.equal((await change({ add: [b.key] })).status, 404);
});

await test("concept: twee wijzigingen binnen één seconde gaan allebei door", async () => {
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS810");
  const b = await seedOrder(env, DRS, "#DRS811");
  const c = await seedOrder(env, DRS, "#DRS812");
  const id = "efefefef-0000-0000-0000-000000000003";
  env.PLANNING_ORDERS.perKeyRate = true;
  await call(env, "POST", "/concepts/save", { key: PLANNER, body: { id, name: "Doorn", orderKeys: [a.key] } });
  const first = await call(env, "POST", "/concepts/save", { key: PLANNER, body: { id, update: true, add: [b.key] } });
  const second = await call(env, "POST", "/concepts/save", { key: PLANNER, body: { id, update: true, add: [c.key] } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.deepEqual((await env.PLANNING_ORDERS.get(`plan-concept:${id}`, "json")).orderKeys, [a.key, b.key, c.key]);
});

await test("rit: twee stops erbij binnen één seconde gaan allebei door, maar een wijziging van een ander scherm blijft staan", async () => {
  const env = makeEnv();
  const kv = env.PLANNING_ORDERS;
  const a = await seedOrder(env, DRS, "#DRS820");
  const b = await seedOrder(env, DRS, "#DRS821");
  const c = await seedOrder(env, DRS, "#DRS822");
  const d = await seedOrder(env, DRS, "#DRS823");
  const route = (await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(1), orderKeys: [a.key] } })).data.route;
  kv.perKeyRate = true;
  const first = await call(env, "POST", "/plan/add-stop", { key: PLANNER, body: { id: route.id, date: route.date, orderKey: b.key } });
  const second = await call(env, "POST", "/plan/add-stop", { key: PLANNER, body: { id: route.id, date: route.date, orderKey: c.key } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(second.status, 200, JSON.stringify(second.data));
  const recordKey = `plan:${route.date}:${route.id}`;
  assert.deepEqual(JSON.parse(kv.entry(recordKey).value).orderKeys, [a.key, b.key, c.key]);

  // Refused because another screen wrote the route in that same second: its
  // change stands, and this one is not forced over it.
  kv.perKeyRate = false;
  const realPut = kv.put.bind(kv);
  kv.put = async (key, value, options) => {
    if (!key.startsWith("plan:")) return realPut(key, value, options);
    kv.put = realPut;
    const entry = kv.entry(key);
    kv.map.set(key, { ...entry, value: JSON.stringify({ ...JSON.parse(entry.value), abortedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }) });
    throw new Error(`KV PUT failed: 429 Too Many Requests (${key})`);
  };
  const clash = await quietly(() => call(env, "POST", "/plan/add-stop", { key: PLANNER, body: { id: route.id, date: route.date, orderKey: d.key } }));
  kv.put = realPut;
  assert.equal(clash.status, 500);
  const after = JSON.parse(kv.entry(recordKey).value);
  assert.ok(after.abortedAt, "afbreken van het andere scherm bleef staan");
  assert.ok(!after.orderKeys.includes(d.key));
});

await test("de 5:45 van de bezorger telt wat vandaag al bezorgd is; zonder locatie noemt de melding de stop", async () => {
  const env = makeEnv();
  const kv = env.PLANNING_ORDERS;
  const kampen = await seedPlaced(env, DRS, "#DRS841", { city: "Kampen", zip: "8261 AA", lat: 52.55, lon: 5.91 });
  const zwolle = await seedPlaced(env, DRS, "#DRS842", { city: "Zwolle", zip: "8011 AA", lat: 52.51, lon: 6.09 });
  const meppel = await seedPlaced(env, DRS, "#DRS843", { city: "Meppel", zip: "7941 AA", lat: 52.70, lon: 6.19 });
  const hoogeveen = await seedPlaced(env, DRS, "#DRS844", { city: "Hoogeveen", zip: "7901 AA", lat: 52.72, lon: 6.48 });
  const assen = await seedPlaced(env, DRS, "#DRS845", { city: "Assen", zip: "9401 AA", lat: 52.99, lon: 6.56 });
  const nergens = await seedPlaced(env, DRS, "#DRS846", { city: "Zeist", zip: "3701 AA" });
  const route = (await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(0), name: "Noord", orderKeys: [kampen.key, zwolle.key, meppel.key, hoogeveen.key] } })).data.route;
  const addAssen = () => call(env, "POST", "/plan/add-stop", { key: DRIVER, body: { id: route.id, date: route.date, orderKey: assen.key } });

  const before = await addAssen();
  assert.equal(before.status, 403);
  assert.match(before.data.error, /5:45/);
  for (const stop of [kampen, zwolle, meppel]) {
    const done = await call(env, "POST", "/actions/mark-delivered", { key: DRIVER, body: { id: stop.order.id, shopDomain: DRS, routeId: route.id, routeDate: route.date } });
    assert.equal(done.status, 200, JSON.stringify(done.data));
  }
  const after = await addAssen();
  assert.equal(after.status, 403, "wat al gereden is telt mee");
  assert.match(after.data.error, /5:45/);

  // Delivered on an earlier day (a route left unfinished): another day's drive.
  for (const stop of [kampen, zwolle, meppel]) {
    const entry = kv.entry(`delivered:${stop.key}`);
    kv.map.set(`delivered:${stop.key}`, { ...entry, value: JSON.stringify({ ...JSON.parse(entry.value), deliveredAt: new Date(Date.now() - DAY_MS).toISOString() }) });
  }
  assert.equal((await addAssen()).status, 200);

  const unknown = await call(env, "POST", "/plan/add-stop", { key: DRIVER, body: { id: route.id, date: route.date, orderKey: nergens.key } });
  assert.equal(unknown.status, 403);
  assert.equal(unknown.data.error, "Van #DRS846 is geen locatie bekend, dus de rit is niet na te rekenen. Bel de planner.");
});

await test("bezorger: zijn stops met punt, orders in ritten na zijn twee weken bezet, en wat vandaag al bezorgd is", async () => {
  const env = makeEnv();
  const a = await seedPlaced(env, DRS, "#DRS850", { city: "Doorn", zip: "3941 BX", lat: 52.031234, lon: 5.324567 });
  const b = await seedPlaced(env, DRS, "#DRS851", { city: "Zeist", zip: "3701 AA", lat: 52.09, lon: 5.23 });
  const later = await seedOrder(env, DRS, "#DRS852");
  const route = (await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(0), orderKeys: [a.key, b.key] } })).data.route;
  await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(9), orderKeys: [later.key] } });

  const plan = (await call(env, "GET", "/plan", { key: DRIVER })).data;
  assert.deepEqual(plan.stops.find((stop) => stop.id === a.order.id).point, { lat: 52.031234, lon: 5.324567 }, "eigen stop, niet afgerond");
  assert.ok(!plan.routes.some((entry) => entry.orderKeys.includes(later.key)), "die rit valt buiten zijn week");
  assert.ok(plan.heldKeys.includes(later.key), "maar zijn order wordt niet aangeboden");
  assert.deepEqual(plan.doneToday, []);

  assert.equal((await call(env, "POST", "/actions/mark-delivered", { key: DRIVER, body: { id: a.order.id, shopDomain: DRS, routeId: route.id, routeDate: route.date } })).status, 200);
  const after = (await call(env, "GET", "/plan", { key: DRIVER })).data;
  assert.deepEqual(after.doneToday, [{ key: a.key, point: { lat: 52.03, lon: 5.32 }, products: a.order.products }]);
  const planner = (await call(env, "GET", `/plan?from=${amsterdamDay(-7)}`, { key: PLANNER })).data;
  assert.deepEqual(planner.doneToday.map((entry) => entry.point), [{ lat: 52.031234, lon: 5.324567 }]);
});

await test("Bezorgd met de rit erbij werkt ook als de lijsten van vandaag op zijn; anders legt de Worker het dagtegoed uit", async () => {
  const env = makeEnv();
  const kv = env.PLANNING_ORDERS;
  const a = await seedOrder(env, DRS, "#DRS860");
  const b = await seedOrder(env, DRS, "#DRS861");
  const route = (await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(0), orderKeys: [a.key] } })).data.route;
  const realList = kv.list.bind(kv);
  kv.list = async () => { throw new Error("KV list() limit exceeded for the day."); };
  const plain = await quietly(() => call(env, "POST", "/actions/mark-delivered", { key: DRIVER, body: { id: a.order.id, shopDomain: DRS } }));
  assert.equal(plain.status, 503);
  assert.equal(plain.data.error, "Het gratis dagtegoed van Cloudflare is op. Vanaf 02:00 werkt alles weer; bel tot die tijd de planner.");
  assert.equal(plain.headers.get("access-control-allow-origin"), "https://example.test");
  assert.equal(shop.orders.get(a.order.shopifyOrderId).fulfilled, false);
  const withRoute = await call(env, "POST", "/actions/mark-delivered", { key: DRIVER, body: { id: a.order.id, shopDomain: DRS, routeId: route.id, routeDate: route.date } });
  assert.equal(withRoute.status, 200, JSON.stringify(withRoute.data));
  assert.equal((await quietly(() => call(env, "GET", "/orders", { key: DRIVER }))).status, 503);
  kv.list = realList;

  // A route that does not hold the stop is not taken at its word.
  const wrong = await call(env, "POST", "/actions/mark-delivered", { key: DRIVER, body: { id: b.order.id, shopDomain: DRS, routeId: route.id, routeDate: route.date } });
  assert.equal(wrong.status, 403);
});

await test("historie: eigen bezorgingen blijven vindbaar voorbij de 50 nieuwste, de bezorger vraagt zonder lijst", async () => {
  const env = makeEnv();
  const kv = env.PLANNING_ORDERS;
  const own = await seedOrder(env, DRS, "#DRS870");
  assert.equal((await call(env, "POST", "/actions/mark-delivered", { key: PLANNER, body: { id: own.order.id, shopDomain: DRS } })).status, 200);
  assert.equal(kv.entry(`delivered:${own.key}`).metadata.own, true);
  const pakket = await seedOrder(env, DSP, "#DSP870", { line_items: [{ title: "Pure Psyllium - Vlozaad", quantity: 1 }] });
  await webhook(env, DSP, { ...pakket.raw, fulfillment_status: "fulfilled", updated_at: new Date().toISOString(), fulfillments: [{ created_at: new Date(Date.now() + 500).toISOString() }] });
  assert.ok(!kv.entry(`delivered:${pakket.key}`).metadata.own, "een DHL-pakket is geen eigen bezorging");
  // Sixty more parcels shipped after it, and a planning delivery from before the "own" mark.
  for (let index = 0; index < 60; index += 1) {
    const at = new Date(Date.now() + (index + 1) * 1000).toISOString();
    await kv.put(`delivered:${DSP}:#P${index}`, JSON.stringify({ id: `#P${index}`, shopDomain: DSP, deliveredAt: at, source: "shopify", fulfillment: null }), { expirationTtl: 86400, metadata: { deliveredAt: at } });
  }
  const oldAt = new Date(Date.now() - DAY_MS).toISOString();
  await kv.put(`delivered:${DRS}:#OUD1`, JSON.stringify({ id: "#OUD1", shopDomain: DRS, deliveredAt: oldAt, source: "bezorger", fulfillment: { id: "gid://shopify/Fulfillment/9" } }), { expirationTtl: 86400, metadata: { deliveredAt: oldAt } });

  const history = (await call(env, "GET", "/history?keys=", { key: PLANNER })).data;
  assert.equal(history.entries.length, 50);
  assert.ok(!history.entries.some((entry) => entry.id === own.order.id));
  assert.deepEqual(history.own.map((entry) => entry.id), [own.order.id]);
  assert.ok(Array.isArray((await call(env, "GET", "/history", { key: PLANNER })).data), "oude schermen: nog steeds een lijst");

  const lists = kv.ops.list;
  const driver = (await call(env, "GET", `/history?keys=${encodeURIComponent(`${own.key},${DRS}:#NIETS`)}`, { key: DRIVER })).data;
  assert.equal(kv.ops.list, lists, "de bezorger kost geen lijst");
  assert.deepEqual(Object.keys(driver.delivered), [own.key]);
  assert.deepEqual(driver.entries, []);
});

await test("bewaren telt vanaf de bezorging en de annulering, niet vanaf de laatste webhook", async () => {
  const env = makeEnv();
  const kv = env.PLANNING_ORDERS;
  const now = () => new Date().toISOString();

  // Delivered by the van 45 days ago; a refund now does not start the sixty days again.
  const a = await seedOrder(env, DRS, "#DRS880");
  const deliveredAt = new Date(Date.now() - 45 * DAY_MS).toISOString();
  await kv.put(`delivered:${a.key}`, JSON.stringify({ id: a.order.id, shopDomain: DRS, order: a.order, fulfillment: { id: "gid://shopify/Fulfillment/1" }, deliveredAt, source: "bezorger" }), { expirationTtl: 15 * 86400, metadata: { deliveredAt } });
  await kv.delete(`order:${a.key}`);
  await webhook(env, DRS, { ...a.raw, fulfillment_status: "fulfilled", financial_status: "refunded", updated_at: now() });
  assert.equal(kv.entry(`delivered:${a.key}`).expiration, Math.floor(Date.parse(deliveredAt) / 1000) + 60 * 86400);

  // Delivered 90 days ago: a late webhook does not bring the record back.
  const b = await seedOrder(env, DRS, "#DRS881");
  await webhook(env, DRS, { ...b.raw, fulfillment_status: "fulfilled", updated_at: now(), fulfillments: [{ created_at: new Date(Date.now() - 90 * DAY_MS).toISOString() }] });
  assert.equal(kv.entry(`delivered:${b.key}`), null);
  assert.equal(kv.entry(`order:${b.key}`), null);

  // A record that outlived its sixty days under the old rule goes at the next webhook.
  const c = await seedOrder(env, DRS, "#DRS882");
  const oldAt = new Date(Date.now() - 70 * DAY_MS).toISOString();
  await kv.put(`delivered:${c.key}`, JSON.stringify({ id: c.order.id, shopDomain: DRS, order: c.order, fulfillment: null, deliveredAt: oldAt, source: "shopify" }), { expirationTtl: 30 * 86400, metadata: { deliveredAt: oldAt } });
  await kv.delete(`order:${c.key}`);
  await webhook(env, DRS, { ...c.raw, fulfillment_status: "fulfilled", tags: "iets", updated_at: now() });
  assert.equal(kv.entry(`delivered:${c.key}`), null);

  // Cancelled twelve days ago: two days left, whatever Shopify sends now. Twenty days ago: gone.
  const d = await seedOrder(env, DRS, "#DRS883");
  const cancelledAt = new Date(Date.now() - 12 * DAY_MS).toISOString();
  await webhook(env, DRS, { ...d.raw, cancelled_at: cancelledAt, financial_status: "refunded", updated_at: now() });
  assert.equal(kv.entry(`order:${d.key}`).expiration, Math.floor(Date.parse(cancelledAt) / 1000) + 14 * 86400);
  const e = await seedOrder(env, DRS, "#DRS884");
  await webhook(env, DRS, { ...e.raw, cancelled_at: new Date(Date.now() - 20 * DAY_MS).toISOString(), updated_at: now() });
  assert.equal(kv.entry(`order:${e.key}`), null);
});

await test("Bezorgd zonder antwoord van Shopify: de webhook boekt het alsnog als eigen bezorging, en Terugdraaien werkt", async () => {
  const env = makeEnv();
  const kv = env.PLANNING_ORDERS;
  const fulfilledPayload = (seeded) => ({ ...seeded.raw, fulfillment_status: "fulfilled", updated_at: new Date(Date.now() + 1000).toISOString(), fulfillments: [{ admin_graphql_api_id: shop.orders.get(seeded.order.shopifyOrderId).fulfillments.at(-1), created_at: new Date().toISOString(), status: "success" }] });

  // The answer is lost; Shopify's webhook comes in afterwards.
  const a = await seedOrder(env, DRS, "#DRS890");
  const route = (await call(env, "POST", "/plan/assign", { key: PLANNER, body: { date: amsterdamDay(0), orderKeys: [a.key] } })).data.route;
  shop.failNext = { mode: "network-during", gid: a.order.shopifyOrderId };
  const lost = await call(env, "POST", "/actions/mark-delivered", { key: DRIVER, body: { id: a.order.id, shopDomain: DRS, routeId: route.id, routeDate: route.date } });
  assert.equal(lost.status, 502);
  assert.match(lost.data.error, /Geen antwoord van Shopify/);
  assert.equal(kv.entry(`reporting:${a.key}`), null, "de webhook hoeft niet opzij te gaan");
  assert.equal((await webhook(env, DRS, fulfilledPayload(a))).status, 200);
  const record = await kv.get(`delivered:${a.key}`, "json");
  assert.equal(record.source, "bezorger");
  assert.equal(record.fulfillment.id, shop.orders.get(a.order.shopifyOrderId).fulfillments.at(-1));
  assert.equal(await kv.get(`order:${a.key}`), null, "de stop staat als bezorgd");
  const undo = await call(env, "POST", "/actions/undo-delivered", { key: PLANNER, body: { id: a.order.id, shopDomain: DRS } });
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  assert.equal(shop.orders.get(a.order.shopifyOrderId).fulfilled, false);

  // The webhook came in while the answer was still on its way: Bezorgd files it itself.
  const b = await seedOrder(env, DRS, "#DRS891");
  shop.failNext = { mode: "network-during", gid: b.order.shopifyOrderId };
  shop.onFulfilled = async () => {
    shop.onFulfilled = null;
    await webhook(env, DRS, fulfilledPayload(b));
  };
  const during = await call(env, "POST", "/actions/mark-delivered", { key: PLANNER, body: { id: b.order.id, shopDomain: DRS } });
  shop.onFulfilled = null;
  assert.equal(during.status, 200, JSON.stringify(during.data));
  const recordB = await kv.get(`delivered:${b.key}`, "json");
  assert.equal(recordB.source, "planner");
  assert.equal(recordB.fulfillment.id, shop.orders.get(b.order.shopifyOrderId).fulfillments.at(-1));

  // A fulfillment someone made in Shopify outside that wait is not the planning's to undo.
  const c = await seedOrder(env, DRS, "#DRS892");
  await kv.put(`reporting-unsure:${c.key}`, JSON.stringify({ from: new Date(Date.now() - 3600_000).toISOString(), until: new Date(Date.now() - 3585_000).toISOString(), source: "bezorger" }), { expirationTtl: 600 });
  await webhook(env, DRS, { ...c.raw, fulfillment_status: "fulfilled", updated_at: new Date().toISOString(), fulfillments: [{ admin_graphql_api_id: "gid://shopify/Fulfillment/77", created_at: new Date().toISOString() }] });
  const recordC = await kv.get(`delivered:${c.key}`, "json");
  assert.equal(recordC.fulfillment, null);
  assert.equal(recordC.source, "shopify");
});

await test("adressen: het land beslist, niet een woord in de straat", async () => {
  const env = makeEnv();
  const addresses = {
    "Belgiëlaan 3, 3811 AB Amersfoort, Netherlands": true,
    "Kerkstraat 1, 3941 BX Doorn, Nederland": true,
    "Voorbeeldweg 1, 3941 BX Doorn": true,
    "Bahnhofstrasse 1, 8001 ZH Zürich, Switzerland": false,
    "Rue Haute 1, 1000 BR Bruxelles, BE": false,
  };
  const result = await call(env, "POST", "/geo", { key: PLANNER, body: { addresses: Object.keys(addresses) } });
  assert.equal(result.status, 200);
  for (const [address, dutch] of Object.entries(addresses)) assert.equal(Boolean(result.data.results[address]), dutch, address);
  assert.equal(result.data.looked, 3, "alleen Nederlandse adressen naar PDOK");
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

await test("aankondiging echt: de markering krijgt de fulfillment ook als Shopify binnen de seconde antwoordt", async () => {
  const env = makeEnv({ AUTO_FULFILL: "aan" });
  const a = await seedOrder(env, DRS, "#DRS230");
  const b = await seedOrder(env, DRS, "#DRS231");
  await env.PLANNING_ORDERS.put(`plan:${cronRouteDay}:r1`, JSON.stringify({ id: "r1", number: 1, date: cronRouteDay, name: "Doorn", orderKeys: [a.key, b.key] }));
  env.PLANNING_ORDERS.perKeyRate = true;
  await worker.scheduled(scheduledAt(`${cronDay}T14:00:00Z`), env);
  for (const seeded of [a, b]) {
    const marker = await env.PLANNING_ORDERS.get(`announced:${seeded.key}`, "json");
    assert.equal(marker.fulfillmentId, shop.orders.get(seeded.order.shopifyOrderId).fulfillments.at(-1), "Terugdraaien kent de fulfillment");
  }
  const log = await env.PLANNING_ORDERS.get(`plan-announce:${cronRouteDay}`, "json");
  assert.deepEqual(log.routes[0].results.map((result) => result.status), ["aangekondigd", "aangekondigd"]);
});

await test("16:10 gaat zoals 16:00 ging: AUTO_FULFILL tussendoor aangezet mailt nog niemand, uitgezet ook niet meer", async () => {
  // A trial at 16:00, switched on at 16:03, a route planned at 16:05.
  const env = makeEnv();
  const a = await seedOrder(env, DRS, "#DRS240");
  const b = await seedOrder(env, DRS, "#DRS241");
  await env.PLANNING_ORDERS.put(`plan:${cronRouteDay}:r1`, JSON.stringify({ id: "r1", number: 1, date: cronRouteDay, name: "Doorn", orderKeys: [a.key] }));
  await worker.scheduled(scheduledAt(`${cronDay}T14:00:00Z`), env);
  env.AUTO_FULFILL = "aan";
  await env.PLANNING_ORDERS.put(`plan:${cronRouteDay}:r2`, JSON.stringify({ id: "r2", number: 2, date: cronRouteDay, name: "Zeist", orderKeys: [b.key] }));
  await worker.scheduled(scheduledAt(`${cronDay}T14:10:00Z`), env);
  assert.equal(shop.calls, 0, "niets naar Shopify");
  assert.equal(shop.mails.length, 0);
  let log = await env.PLANNING_ORDERS.get(`plan-announce:${cronRouteDay}`, "json");
  assert.equal(log.mode, "proef", "de agenda zegt eerlijk: proef");
  assert.deepEqual(log.routes.map((route) => route.results[0].status), ["zou aangekondigd worden", "zou aangekondigd worden"]);

  // Live at 16:00, switched off before 16:10: the second run stays out of Shopify.
  const live = makeEnv({ AUTO_FULFILL: "aan" });
  const c = await seedOrder(live, DRS, "#DRS242");
  const d = await seedOrder(live, DRS, "#DRS243");
  await live.PLANNING_ORDERS.put(`plan:${cronRouteDay}:r1`, JSON.stringify({ id: "r1", number: 1, date: cronRouteDay, name: "Doorn", orderKeys: [c.key] }));
  await worker.scheduled(scheduledAt(`${cronDay}T14:00:00Z`), live);
  assert.equal(shop.mails.length, 1);
  delete live.AUTO_FULFILL;
  await live.PLANNING_ORDERS.put(`plan:${cronRouteDay}:r2`, JSON.stringify({ id: "r2", number: 2, date: cronRouteDay, name: "Zeist", orderKeys: [d.key] }));
  const calls = shop.calls;
  await worker.scheduled(scheduledAt(`${cronDay}T14:10:00Z`), live);
  assert.equal(shop.calls, calls, "uitgezet is uit");
  log = await live.PLANNING_ORDERS.get(`plan-announce:${cronRouteDay}`, "json");
  assert.equal(log.mode, "echt", "om 16:00 ging er wel echt iets uit");
  assert.equal(log.routes.find((route) => route.id === "r2").results[0].status, "zou aangekondigd worden");
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
