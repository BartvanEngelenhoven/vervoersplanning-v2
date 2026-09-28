// The move from KV to the Durable Object's SQLite store: that KV's contents come
// over once, with expiry and metadata; that the Worker hands every request to
// the store and keeps its internal address to itself; that the 16:00 run goes
// through it too; and the one-off tidy of old delivery records.
import assert from "node:assert/strict";
import worker, { PlanningStore } from "./backend-worker.js";
import { SqlKV, sqliteStorage } from "./test-store-shim.mjs";

const PLANNER = "planner-code-lang-genoeg";
const DRS = "de-rijplaten-specialist.myshopify.com";
const DAY = 86_400;

function oldKv(entries) {
  const map = new Map(entries.map(([key, value, options = {}]) => [key, { value: typeof value === "string" ? value : JSON.stringify(value), ...options }]));
  return {
    map,
    async list({ cursor } = {}) {
      const names = [...map.keys()].sort();
      const start = Number(cursor || 0);
      const page = names.slice(start, start + 2);
      const complete = start + 2 >= names.length;
      return { keys: page.map((name) => ({ name, ...(map.get(name).expiration ? { expiration: map.get(name).expiration } : {}), ...(map.get(name).metadata ? { metadata: map.get(name).metadata } : {}) })), list_complete: complete, ...(complete ? {} : { cursor: String(start + 2) }) };
    },
    async get(key) {
      return map.get(key)?.value ?? null;
    },
  };
}

function objectFor(env, sql = sqliteStorage()) {
  const ctx = { storage: { sql }, waiting: null, blockConcurrencyWhile(fn) { this.waiting = fn(); return this.waiting; } };
  const object = new PlanningStore(ctx, env);
  return { object, ctx, sql };
}

// A namespace with one object, as Cloudflare gives it to the Worker.
function namespaceFor(object) {
  return { idFromName: (name) => ({ name }), get: () => ({ fetch: (input, init) => object.fetch(input instanceof Request ? input : new Request(input, init)) }) };
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(["ok", name]);
  } catch (error) {
    results.push(["FOUT", name, error]);
  }
}

const now = Math.floor(Date.now() / 1000);
const order = (id, city) => ({ id, shopDomain: DRS, shopifyOrderId: `gid://shopify/Order/${id.slice(4)}`, customer: "Voorbeeldklant", city, postcode: "3941 BX", fullAddress: `Voorbeeldweg 1, 3941 BX ${city}, Netherlands`, paid: true, fulfilled: false, cancelled: false, deliveryMethod: "delivery", addressComplete: true, products: ["1x Kunststof rijplaat"] });

await test("bij de verhuizing komt alles uit KV mee, met vervaldatum en metadata, en verlopen blijft weg", async () => {
  const kv = oldKv([
    [`order:${DRS}:#DRS1`, order("#DRS1", "Doorn")],
    [`order:${DRS}:#DRS2`, order("#DRS2", "Zeist")],
    [`delivered:${DRS}:#DRS3`, { id: "#DRS3", deliveredAt: "2026-09-27T10:00:00.000Z" }, { expiration: now + 30 * DAY, metadata: { deliveredAt: "2026-09-27T10:00:00.000Z", own: true } }],
    ["geo:oud", { lat: 1, lon: 2 }, { expiration: now - 10 }],
    ["plan-counter", { next: 7 }],
  ]);
  const env = { PLANNING_ORDERS: kv, OPERATOR_KEY: PLANNER, CORS_ORIGIN: "https://example.test" };
  const { object, ctx } = objectFor(env);
  await ctx.waiting;
  assert.deepEqual({ listed: object.copied.listed, copied: object.copied.copied }, { listed: 5, copied: 4 });
  const status = await (await object.fetch(new Request("https://worker.test/store/status", { headers: { "x-operator-key": PLANNER } }))).json();
  assert.equal(status.store, "durable-object");
  assert.deepEqual(status.keys, { order: 2, delivered: 1, "plan-counter": 1 });
  const listed = await object.store.list({ prefix: "delivered:" });
  assert.deepEqual(listed.keys[0], { name: `delivered:${DRS}:#DRS3`, expiration: now + 30 * DAY, metadata: { deliveredAt: "2026-09-27T10:00:00.000Z", own: true } });
  // A second wake-up copies nothing again, even when KV has changed since.
  kv.map.set(`order:${DRS}:#DRS1`, { value: JSON.stringify({ ...order("#DRS1", "Doorn"), city: "Oud" }) });
  const again = objectFor(env, ctx.storage.sql);
  await again.ctx.waiting;
  assert.equal(again.object.copied.at, object.copied.at);
  assert.equal((await again.object.store.get(`order:${DRS}:#DRS1`, "json")).city, "Doorn");
});

await test("lukt de kopie uit KV niet, dan draait de site door op KV en komt de kopie later, met wat er intussen veranderde", async () => {
  const kv = new SqlKV();
  await kv.put(`order:${DRS}:#DRS30`, JSON.stringify(order("#DRS30", "Doorn")));
  await kv.put(`order:${DRS}:#DRS31`, JSON.stringify(order("#DRS31", "Zeist")));
  let broken = true;
  const flaky = {
    list: (options) => (broken ? Promise.reject(new Error("KV list() limit exceeded for the day.")) : kv.list(options)),
    get: (key, type) => kv.get(key, type),
    put: (...args) => kv.put(...args),
    delete: (key) => kv.delete(key),
  };
  const env = { PLANNING_ORDERS: flaky, OPERATOR_KEY: PLANNER, CORS_ORIGIN: "https://example.test" };
  const { object, ctx } = objectFor(env);
  await ctx.waiting;
  assert.equal(object.copied, null);
  const status = () => object.fetch(new Request("https://worker.test/store/status", { headers: { "x-operator-key": PLANNER } })).then((response) => response.json());
  assert.match((await status()).store, /^kv/);
  // Meanwhile the site works on KV: an order goes, another comes.
  await kv.delete(`order:${DRS}:#DRS31`);
  await kv.put(`order:${DRS}:#DRS32`, JSON.stringify(order("#DRS32", "Leersum")));
  broken = false;
  object.copyTriedAt = 0;
  const orders = await (await object.fetch(new Request("https://worker.test/orders", { headers: { "x-operator-key": PLANNER } }))).json();
  assert.deepEqual(orders.map((item) => item.id).sort(), ["#DRS30", "#DRS32"]);
  assert.equal((await status()).store, "durable-object");
  assert.equal(await object.store.get(`order:${DRS}:#DRS31`), null, "wat in KV weg was, komt niet terug");
});

await test("de Worker geeft elk verzoek aan de opslag, en zijn interne adres is van buiten dicht", async () => {
  const { object, ctx } = objectFor({ PLANNING_ORDERS: oldKv([[`order:${DRS}:#DRS1`, order("#DRS1", "Doorn")]]), OPERATOR_KEY: PLANNER, CORS_ORIGIN: "https://example.test" });
  await ctx.waiting;
  const env = { PLANNING_STORE: namespaceFor(object), OPERATOR_KEY: PLANNER, CORS_ORIGIN: "https://example.test" };
  const orders = await worker.fetch(new Request("https://worker.test/orders", { headers: { "x-operator-key": PLANNER } }), env);
  assert.equal(orders.status, 200);
  assert.deepEqual((await orders.json()).map((item) => item.id), ["#DRS1"]);
  assert.equal((await worker.fetch(new Request("https://worker.test/orders"), env)).status, 401, "zonder code niets");
  assert.equal((await worker.fetch(new Request("https://planning-store.internal/scheduled", { method: "POST", body: "{}" }), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://worker.test/store/status"), env)).status, 401);
});

await test("de aankondiging van 16:00 loopt via de opslag en ruimt verlopen rijen op", async () => {
  const { object, ctx, sql } = objectFor({ PLANNING_ORDERS: oldKv([]), OPERATOR_KEY: PLANNER, CORS_ORIGIN: "https://example.test" });
  await ctx.waiting;
  const env = { PLANNING_STORE: namespaceFor(object) };
  // 14:00 UTC on a summer day is 16:00 in Amsterdam.
  const at = Date.parse("2026-09-28T14:00:05Z");
  // Expired by the clock of the run, whatever the time the test runs at.
  sql.exec("INSERT INTO kv (key, value, expiration) VALUES ('geo:verlopen', '{}', ?)", Math.floor(at / 1000) - 5);
  const realNow = Date.now;
  Date.now = () => at + 5_000;
  try {
    await worker.scheduled({ scheduledTime: at, cron: "0 14,15 * * *" }, env);
  } finally {
    Date.now = realNow;
  }
  const report = await object.store.get("plan-announce:2026-09-29", "json");
  assert.equal(report.mode, "proef");
  assert.deepEqual(sql.exec("SELECT key FROM kv WHERE key = 'geo:verlopen'").toArray(), [], "verlopen rij is opgeruimd");
});

await test("opruimen van oude bezorgd-records: eerst tellen, pas met apply veranderen", async () => {
  const kv = new SqlKV();
  const env = { PLANNING_ORDERS: kv, OPERATOR_KEY: PLANNER, CORS_ORIGIN: "https://example.test" };
  const recent = new Date(Date.now() - 5 * DAY * 1000).toISOString();
  const ancient = new Date(Date.now() - 90 * DAY * 1000).toISOString();
  await kv.put(`delivered:${DRS}:#DRS10`, JSON.stringify({ id: "#DRS10", shopDomain: DRS, deliveredAt: recent, source: "planner", fulfillment: { id: "gid://shopify/Fulfillment/1" }, order: { ...order("#DRS10", "Doorn"), phone: "0612345678", customerNote: "achterom" } }));
  await kv.put(`delivered:slowfeeder-specialist.myshopify.com:#DSP11`, JSON.stringify({ id: "#DSP11", shopDomain: "slowfeeder-specialist.myshopify.com", deliveredAt: recent, source: "shopify", order: { id: "#DSP11", customer: "Voorbeeldklant", fullAddress: "Voorbeeldweg 2, 3941 BX Doorn", city: "Doorn", products: ["1x Hooinet"], phone: "0611111111" } }));
  await kv.put(`delivered:${DRS}:#DRS12`, JSON.stringify({ id: "#DRS12", shopDomain: DRS, deliveredAt: ancient, source: "shopify", order: order("#DRS12", "Zeist") }));
  await kv.put(`delivered:${DRS}:#DRS13`, JSON.stringify({ id: "#DRS13", shopDomain: DRS, deliveredAt: recent, source: "bezorger", order: order("#DRS13", "Leersum") }), { metadata: { deliveredAt: recent } });
  const ask = (apply) => worker.fetch(new Request("https://worker.test/store/tidy-history", { method: "POST", headers: { "x-operator-key": PLANNER, "content-type": "application/json" }, body: JSON.stringify({ apply }) }), env).then((response) => response.json());

  const dry = await ask(false);
  assert.deepEqual(dry, { records: 4, cleaned: 2, removed: 1, marked: 2, applied: false });
  assert.match(await kv.get(`delivered:${DRS}:#DRS10`), /0612345678/, "tellen verandert niets");

  const done = await ask(true);
  assert.equal(done.applied, true);
  const own = await kv.get(`delivered:${DRS}:#DRS10`, "json");
  assert.equal(own.order.phone, undefined);
  assert.equal(own.order.customerNote, undefined);
  assert.deepEqual(kv.entry(`delivered:${DRS}:#DRS10`).metadata, { deliveredAt: own.deliveredAt, own: true });
  const parcel = await kv.get(`delivered:slowfeeder-specialist.myshopify.com:#DSP11`, "json");
  for (const field of ["customer", "fullAddress", "phone"]) assert.equal(parcel.order[field], undefined, `een pakket houdt geen ${field}`);
  assert.equal(parcel.order.city, "Doorn");
  assert.equal(await kv.get(`delivered:${DRS}:#DRS12`), null, "ouder dan 60 dagen: weg");
  assert.equal(kv.entry(`delivered:${DRS}:#DRS13`).metadata.own, true, "eigen bezorging gemarkeerd");
  assert.ok(Math.abs(kv.entry(`delivered:${DRS}:#DRS13`).expiration - (Date.parse(recent) / 1000 + 60 * DAY)) < 2, "60 dagen vanaf de bezorging");
  assert.deepEqual(await ask(false), { records: 3, cleaned: 0, removed: 0, marked: 0, applied: false }, "een tweede keer is er niets meer te doen");
  assert.equal((await worker.fetch(new Request("https://worker.test/store/tidy-history", { method: "POST", body: "{}" }), env)).status, 401);
});

await test("een klant wissen haalt elke kopie van de order weg, met het kaartpunt, en alleen die", async () => {
  const kv = new SqlKV();
  const env = { PLANNING_ORDERS: kv, OPERATOR_KEY: PLANNER, CORS_ORIGIN: "https://example.test" };
  const doorn = order("#DRS20", "Doorn");
  await kv.put(`order:${DRS}:#DRS20`, JSON.stringify(doorn));
  await kv.put(`announced:${DRS}:#DRS20`, "{}");
  await kv.put(`geo:${doorn.fullAddress.toLowerCase()}`, JSON.stringify({ lat: 52, lon: 5.3 }));
  await kv.put(`order:${DRS}:#DRS21`, JSON.stringify(order("#DRS21", "Zeist")));
  const forget = (body, key = PLANNER) => worker.fetch(new Request("https://worker.test/store/forget", { method: "POST", headers: { "x-operator-key": key, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
  const result = await (await forget({ shopDomain: DRS, id: "DRS20" })).json();
  assert.deepEqual([...result.removed].sort(), ["announced", "geo", "order"]);
  assert.equal(await kv.get(`order:${DRS}:#DRS20`), null);
  assert.equal(await kv.get(`geo:${doorn.fullAddress.toLowerCase()}`), null);
  assert.ok(await kv.get(`order:${DRS}:#DRS21`), "een andere order blijft");
  assert.equal((await forget({ shopDomain: DRS, id: "#DRS21" }, "fout")).status, 401);
  assert.equal((await forget({ shopDomain: DRS, id: "../plan" })).status, 400);
});

await test("een verzoek dat nog op KV loopt, houdt de kopie tegen tot het klaar is", async () => {
  const kv = new SqlKV();
  let release;
  const slowWrite = new Promise((resolve) => { release = resolve; });
  let broken = true;
  const flaky = {
    list: (options) => (broken ? Promise.reject(new Error("KV list() limit exceeded for the day.")) : kv.list(options)),
    get: (key, type) => kv.get(key, type),
    put: async (key, value, options) => {
      if (key.startsWith("plan-day:")) await slowWrite;
      return kv.put(key, value, options);
    },
    delete: (key) => kv.delete(key),
  };
  const { object, ctx } = objectFor({ PLANNING_ORDERS: flaky, OPERATOR_KEY: PLANNER, CORS_ORIGIN: "https://example.test" });
  await ctx.waiting;
  broken = false;
  const date = "2026-10-05";
  // Starts on KV (the copy failed a moment ago), and hangs on its write.
  const note = object.fetch(new Request("https://worker.test/plan/day-note", { method: "POST", headers: { "x-operator-key": PLANNER, "content-type": "application/json" }, body: JSON.stringify({ date, note: "Bus naar de garage" }) }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  object.copyTriedAt = 0;
  const status = () => object.fetch(new Request("https://worker.test/store/status", { headers: { "x-operator-key": PLANNER } })).then((response) => response.json());
  assert.match((await status()).store, /^kv/, "geen kopie zolang de notitie nog schrijft");
  release();
  assert.equal((await note).status, 200);
  assert.equal((await status()).store, "durable-object");
  assert.equal((await object.store.get(`plan-day:${date}`, "json")).note, "Bus naar de garage", "de notitie is mee");
});

await test("STORE_COPY_AFTER houdt de kopie even tegen; tot dan werkt alles op KV", async () => {
  const kv = new SqlKV();
  await kv.put(`order:${DRS}:#DRS40`, JSON.stringify(order("#DRS40", "Doorn")));
  const env = { PLANNING_ORDERS: kv, OPERATOR_KEY: PLANNER, CORS_ORIGIN: "https://example.test", STORE_COPY_AFTER: new Date(Date.now() + 60_000).toISOString() };
  const { object, ctx, sql } = objectFor(env);
  await ctx.waiting;
  assert.equal(object.copied, null);
  const orders = await (await object.fetch(new Request("https://worker.test/orders", { headers: { "x-operator-key": PLANNER } }))).json();
  assert.deepEqual(orders.map((item) => item.id), ["#DRS40"]);
  object.env = { ...env, STORE_COPY_AFTER: new Date(Date.now() - 1000).toISOString() };
  await object.fetch(new Request("https://worker.test/orders", { headers: { "x-operator-key": PLANNER } }));
  assert.ok(object.copied, "na het tijdstip gekopieerd");
  // Woken again later, it knows the copy is done without asking KV.
  const again = objectFor({ ...env, PLANNING_ORDERS: { list: () => Promise.reject(new Error("niet meer nodig")) } }, sql);
  await again.ctx.waiting;
  assert.ok(again.object.copied);
});

await test("kan de opslag niet antwoorden, dan zegt de Worker dat netjes, met CORS", async () => {
  const env = { PLANNING_STORE: { idFromName: () => ({}), get: () => ({ fetch: () => Promise.reject(new Error("Durable Object reset because its code was updated.")) }) }, CORS_ORIGIN: "https://example.test" };
  const response = await worker.fetch(new Request("https://worker.test/orders", { headers: { "x-operator-key": PLANNER } }), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://example.test");
  assert.match((await response.json()).error, /opslag reageert even niet/);
  await worker.scheduled({ scheduledTime: Date.now(), cron: "0 14,15 * * *" }, env);
});

await test("klant wissen: kleine letters en de verkeerde winkel vinden de order toch, ook in de KV-kopie", async () => {
  const kv = new SqlKV();
  await kv.put(`order:${DRS}:#DRS50`, JSON.stringify(order("#DRS50", "Doorn")));
  const { object, ctx } = objectFor({ PLANNING_ORDERS: kv, OPERATOR_KEY: PLANNER, CORS_ORIGIN: "https://example.test" });
  await ctx.waiting;
  assert.ok(await kv.get(`order:${DRS}:#DRS50`), "de KV-kopie heeft hem nog");
  const forget = (body) => object.fetch(new Request("https://worker.test/store/forget", { method: "POST", headers: { "x-operator-key": PLANNER, "content-type": "application/json" }, body: JSON.stringify(body) })).then((response) => response.json());
  const result = await forget({ shopDomain: "slowfeeder-specialist.myshopify.com", id: "drs50" });
  assert.equal(result.found, true);
  assert.equal(await object.store.get(`order:${DRS}:#DRS50`), null);
  assert.equal(await kv.get(`order:${DRS}:#DRS50`), null, "ook uit de KV-kopie");
  assert.equal((await forget({ shopDomain: DRS, id: "#DRS99" })).found, false);
});

await test("de scripts vragen de code zonder hem te tonen en praten met de Worker", async () => {
  const { spawn } = await import("node:child_process");
  const http = await import("node:http");
  const kv = new SqlKV();
  await kv.put(`order:${DRS}:#DRS60`, JSON.stringify(order("#DRS60", "Doorn")));
  const env = { PLANNING_ORDERS: kv, OPERATOR_KEY: PLANNER, CORS_ORIGIN: "https://example.test" };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await worker.fetch(new Request(`https://worker.test${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(await response.text());
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const run = (script, input) => new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, WORKER_URL: `http://localhost:${server.address().port}` } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
  try {
    const wissen = await run("scripts/klant-wissen.mjs", `${PLANNER}\nr\n#DRS60\nja\n`);
    assert.equal(wissen.code, 0, wissen.output);
    assert.match(wissen.output, /Gewist: order/);
    assert.ok(!wissen.output.includes(PLANNER), "de code staat niet op het scherm");
    const fout = await run("scripts/klant-wissen.mjs", "verkeerd\nr\n#DRS60\nja\n");
    assert.match(fout.output, /Die code klopt niet/);
    const opruimen = await run("scripts/historie-bewaartermijn.mjs", `${PLANNER}\n`);
    assert.equal(opruimen.code, 0, opruimen.output);
    assert.match(opruimen.output, /0 bezorgd-records/);
  } finally {
    server.close();
  }
});

await test("CORS: het nieuwe en het oude adres van de site mogen allebei, een ander adres niet", async () => {
  const env = { PLANNING_ORDERS: new SqlKV(), OPERATOR_KEY: PLANNER, CORS_ORIGIN: "https://specialistenplanning.pages.dev,https://bartvanengelenhoven.github.io" };
  const vanaf = async (origin) => (await worker.fetch(new Request("https://worker.test/orders", { headers: { "x-operator-key": PLANNER, origin } }), env)).headers.get("access-control-allow-origin");
  assert.equal(await vanaf("https://specialistenplanning.pages.dev"), "https://specialistenplanning.pages.dev");
  assert.equal(await vanaf("https://bartvanengelenhoven.github.io"), "https://bartvanengelenhoven.github.io");
  assert.equal(await vanaf("https://kwaadwillend.example"), "https://specialistenplanning.pages.dev");
  const preflight = await worker.fetch(new Request("https://worker.test/orders", { method: "OPTIONS", headers: { origin: "https://bartvanengelenhoven.github.io" } }), env);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://bartvanengelenhoven.github.io");
  assert.equal(preflight.headers.get("vary"), "Origin");
});

let failed = 0;
for (const [status, name, error] of results) {
  console.log(`${status === "ok" ? "✓" : "✗"} ${name}`);
  if (error) {
    failed += 1;
    console.log(`   ${String(error.stack || error).split("\n").slice(0, 4).join("\n   ")}`);
  }
}
console.log(`${results.length - failed}/${results.length} opslag goed`);
if (failed) process.exit(1);
