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
 * - PLANNING_STORE: the Durable Object (SQLite) that holds everything; see planning-store.js
 * - PLANNING_ORDERS: the Cloudflare KV namespace that held everything before the move,
 *   copied over once and kept as it was; without PLANNING_STORE it is still the store
 * - CORS_ORIGIN: the site's address, or several comma-separated, for example
 *   https://specialistenplanning.pages.dev,https://bartvanengelenhoven.github.io
 * - OPERATOR_KEY: the planner's code; opens everything
 * - DRIVER_KEY: optional, the one code all drivers shared before each got their own
 *   (see "Drivers" below); it only opens routes that have no driver. Delete it once
 *   every driver has their own code.
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
 * - order:<shop>:<id>      open orders, while open. A cancelled one stays until 14 days
 *                          after it was cancelled, so a planned route can say
 *                          "geannuleerd" instead of "not found".
 * - delivered:<shop>:<id>  until 60 days after the delivery, without phone or customer
 *                          note, for undo and the driver's "bezorgd" ticks.
 * - plan:<date>:<id>       until 60 days after the route's date.
 * - geo:<address>          90 days (a point), 7 days (a miss).
 * - drivers                the drivers' names and a hash of each one's code, until the
 *                          planner removes them. The codes themselves are never kept.
 */

import { copyFromKv, sqlStore } from "./planning-store.js";

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
// When Shopify gives the Bezorgd button no answer, it may still have made the
// fulfillment, and only its webhook can say so. These two notes, kept for ten
// minutes and holding no customer details, let the report and the webhook find
// each other whichever comes first (see markDelivered and storeShopifyOrder).
const REPORT_SEEN_PREFIX = "reporting-seen:";
const REPORT_UNSURE_PREFIX = "reporting-unsure:";
const REPORT_NOTE_TTL = 600;
// Who reported a delivery through the planning. Only those deliveries hold a
// fulfillment the planning made, which Terugdraaien can undo.
const OWN_SOURCES = ["planner", "bezorger", "driver"];
// The free plan allows so many KV reads, writes and listings a day; past that
// every call fails until the count resets at midnight UTC. Said plainly, so the
// driver phones instead of trying again and again.
const KV_LIMIT_MESSAGE = "Het gratis dagtegoed van Cloudflare is op. Vanaf 02:00 werkt alles weer; bel tot die tijd de planner.";
// The same drive-time model as the planning in app.js, for the one check the
// Worker makes itself: a stop the driver adds must keep the day within 5:45.
const DEPOT_POINT = { lat: 52.07309, lon: 5.63884 };
const DAY_LIMIT_MINUTES = 345;

// Every request goes through to the one Durable Object that owns the storage,
// and is answered there. Only the Worker can reach it; a request for its
// internal address from outside is refused here.
export default {
  async scheduled(event, env) {
    if (!env.PLANNING_STORE) return runScheduled(event, env);
    try {
      await storeStub(env).fetch(`https://${STORE_HOST}/scheduled`, {
        method: "POST",
        body: JSON.stringify({ scheduledTime: event.scheduledTime, cron: event.cron }),
      });
    } catch (error) {
      // The 16:10 run tries again.
      console.error("scheduled", error);
    }
  },

  async fetch(request, env) {
    if (!env.PLANNING_STORE) return handleRequest(request, env);
    if (new URL(request.url).hostname === STORE_HOST) return new Response("Not found", { status: 404 });
    try {
      return await storeStub(env).fetch(request);
    } catch (error) {
      // The object itself could not answer: restarted by a deploy, or the free
      // tier's day spent. Said with CORS headers, or the screen reads nothing.
      console.error(error);
      const answerEnv = { ...env, REQUEST_ORIGIN: request.headers.get("origin") || "" };
      if (kvLimitSpent(error)) return json({ error: KV_LIMIT_MESSAGE }, 503, answerEnv);
      return json({ error: "De opslag reageert even niet. Probeer het zo opnieuw." }, 503, answerEnv);
    }
  },
};

const STORE_HOST = "planning-store.internal";

function storeStub(env) {
  return env.PLANNING_STORE.get(env.PLANNING_STORE.idFromName("planning"));
}

// The planning's storage and everything that works on it, in one place: one
// object, so every read sees every write before it. See planning-store.js.
export class PlanningStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.store = sqlStore(ctx.storage.sql);
    this.copied = null;
    this.copyTriedAt = 0;
    this.onKv = 0;
    // The first time, KV's contents come over before anything is answered.
    ctx.blockConcurrencyWhile(() => (this.copyDue() ? this.copyKv() : copyFromKv(null, ctx.storage.sql).then((done) => { this.copied = done; })));
  }

  // STORE_COPY_AFTER holds the copy back for a moment after the deploy: KV takes
  // up to a minute to show a write from elsewhere, and the old Worker may still
  // be writing. Until then the object works on KV itself.
  copyDue() {
    const kv = this.env.PLANNING_ORDERS;
    const after = Date.parse(this.env.STORE_COPY_AFTER || "");
    if (this.copied || !kv || this.onKv > 0) return false;
    if (!Number.isNaN(after) && Date.now() < after) return false;
    return !this.copyTriedAt || Date.now() - this.copyTriedAt > 5 * 60_000;
  }

  // When KV cannot be read (its day's budget spent, say), the site keeps running
  // on KV as before, and the copy is tried again five minutes later. Nothing
  // else is answered meanwhile, so no write slips past it.
  async copyKv() {
    try {
      this.copied = await copyFromKv(this.env.PLANNING_ORDERS, this.ctx.storage.sql);
      this.copyError = null;
      // Counts only, for wrangler tail on the day of the move.
      console.log("store", JSON.stringify(this.copied));
    } catch (error) {
      this.copied = null;
      this.copyError = String(error?.message || error).slice(0, 200);
      console.error("copy from KV", error);
    }
    this.copyTriedAt = Date.now();
  }

  async fetch(request) {
    const kv = this.env.PLANNING_ORDERS;
    // Never while a request is still working on KV: its writes would land in KV
    // after the copy, and be lost.
    if (this.copyDue()) await this.ctx.blockConcurrencyWhile(() => this.copyKv());
    const onStore = Boolean(this.copied) || !kv;
    const env = {
      ...this.env,
      PLANNING_ORDERS: onStore ? this.store : kv,
      // The KV copy of the move day, as long as it exists: erasing a customer
      // erases them there too.
      OLD_KV: onStore ? kv : null,
      STORE_STATUS: () => ({ store: onStore ? "durable-object" : this.copyError ? "kv, kopie mislukt, volgt opnieuw" : "kv, kopie volgt", copiedFromKv: this.copied, copyError: this.copyError || undefined, keys: this.store.counts() }),
    };
    if (!onStore) this.onKv += 1;
    try {
      const url = new URL(request.url);
      if (url.hostname === STORE_HOST && url.pathname === "/scheduled") {
        await runScheduled(await request.json(), env);
        if (onStore) this.store.purge();
        return new Response("ok");
      }
      return await handleRequest(request, env);
    } finally {
      if (!onStore) this.onKv -= 1;
    }
  }
}

// The announcement at 16:00 the day before a route. Cron runs in UTC, so it
// fires at 14:00 and 15:00 UTC and only the one that is 16:00 in Amsterdam
// goes ahead: 14:00 in summer time, 15:00 in winter time. A second trigger ten
// minutes later picks up whatever the first could not finish or got refused.
//
// That second run is a second chance for the first, not a second announcement,
// so it goes the way the 16:00 run went. AUTO_FULFILL switched on at 16:03
// would otherwise mail every customer of tomorrow's routes that same day, under
// a report still headed "proef". It is never live while AUTO_FULFILL is off.
async function runScheduled(event, env) {
  const now = amsterdamNow(new Date(event.scheduledTime));
  if (now.hour !== ANNOUNCE_HOUR) return;
  const date = nextDay(now.day);
  const logKey = `${ANNOUNCE_LOG_PREFIX}${date}`;
  const earlier = now.minute >= 10 ? await env.PLANNING_ORDERS.get(logKey, "json").catch(() => null) : null;
  const live = announceLive(env) && earlier?.mode !== "proef";
  const report = { date, ranAt: new Date().toISOString(), mode: live ? "echt" : "proef", routes: [] };
  try {
    await runAnnouncement(env, date, { preview: !live, report });
  } catch (error) {
    report.error = String(error?.message || error).slice(0, 200);
  } finally {
    // Written whatever happened, so the agenda never shows a silent gap.
    await env.PLANNING_ORDERS.put(logKey, JSON.stringify(mergeAnnounceReports(earlier, report)), { expirationTtl: 60 * DAY_SECONDS });
  }
}

async function handleRequest(request, requestEnv) {
  const env = { ...requestEnv, REQUEST_ORIGIN: request.headers.get("origin") || "" };
  try {
    env[CALLER] = await identify(request, env);
    const braked = await codeBrake(request, env);
    if (braked) return braked;
    return await route(request, env);
  } catch (error) {
    // Without this a thrown error comes back as a bare 500 with no CORS
    // headers, and the browser reports only "Failed to fetch" instead of
    // anything the planner could act on.
    console.error(error);
    if (kvLimitSpent(error)) return json({ error: KV_LIMIT_MESSAGE }, 503, env);
    return json({ error: "Er ging iets mis op de server. Probeer het zo opnieuw." }, 500, env);
  }
}

async function route(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  if (request.method === "POST" && url.pathname === "/orders/shipping") {
    return setOrderShipping(request, env);
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

  if (request.method === "POST" && url.pathname === "/actions/refresh-orders") {
    return refreshFromShopify(request, env);
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

  if (request.method === "GET" && url.pathname === "/store/status") {
    const denied = plannerOnly(request, env);
    if (denied) return denied;
    return json(env.STORE_STATUS ? env.STORE_STATUS() : { store: "kv" }, 200, env);
  }

  if (request.method === "POST" && url.pathname === "/store/tidy-history") {
    return tidyHistory(request, env);
  }

  if (request.method === "POST" && url.pathname === "/store/forget") {
    return forgetCustomerOrder(request, env);
  }

  if (request.method === "GET" && url.pathname === "/whoami") {
    const role = roleFor(request, env);
    if (!role) return json({ error: "Unauthorized" }, 401, env);
    return json(role === "driver" ? { role, driver: callerDriver(env) } : { role }, 200, env);
  }

  if (request.method === "POST" && url.pathname === "/drivers/add") {
    return addDriver(request, env);
  }

  if (request.method === "POST" && url.pathname === "/drivers/code") {
    return renewDriverCode(request, env);
  }

  if (request.method === "POST" && url.pathname === "/drivers/remove") {
    return removeDriver(request, env);
  }

  if (request.method === "POST" && url.pathname === "/plan/driver") {
    return setPlanDriver(request, env);
  }

  if (request.method === "POST" && url.pathname === "/plan/add-stop") {
    return addPlanStop(request, env);
  }

  if (request.method === "POST" && url.pathname === "/plan/abort") {
    return closePlanRoute(request, env, { finish: false });
  }

  if (request.method === "POST" && url.pathname === "/plan/finish") {
    return closePlanRoute(request, env, { finish: true });
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

// KV's own words when the day's budget is spent: "KV put() limit exceeded for
// the day."
// KV said "KV put() limit exceeded for the day"; the SQLite store speaks of
// exceeding the free tier's rows read or written.
function kvLimitSpent(error) {
  const message = String(error?.message || error || "");
  return (/limit/i.test(message) && /exceeded|day/i.test(message)) || (/exceeded/i.test(message) && /free tier|rows (read|written)/i.test(message));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// KV takes one write per key per second: a second write to the same key within
// that second (Shopify's webhook for the order just reported, two quick taps)
// is refused. One more try once the second is over nearly always lands. A spent
// day's budget is not tried again; that would only wait and fail the same way.
async function putWithRetry(env, key, value, options) {
  try {
    await env.PLANNING_ORDERS.put(key, value, options);
  } catch (error) {
    if (kvLimitSpent(error)) throw error;
    await sleep(1100);
    await env.PLANNING_ORDERS.put(key, value, options);
  }
}

// The point PDOK gave an order's address, from the cache /geo keeps. null when
// the address was never looked up or not found.
async function cachedPoint(env, order) {
  const point = await env.PLANNING_ORDERS.get(geoKeyForOrder(order), "json").catch(() => null);
  return point && !point.miss ? { lat: point.lat, lon: point.lon } : null;
}

// About a kilometre: close enough to weigh a detour, too coarse to find a house.
function roundPoint(point) {
  return point ? { lat: Math.round(point.lat * 100) / 100, lon: Math.round(point.lon * 100) / 100 } : null;
}

// Delivered on this Amsterdam day, by the time on the delivery record.
function deliveredOn(record, day) {
  const at = new Date(record?.deliveredAt || "");
  return !Number.isNaN(at.getTime()) && amsterdamNow(at).day === day;
}

// What the driver's phone needs of an order that is not one of their stops: enough
// to weigh "can it come along", nothing to identify the customer by. Name, street,
// phone and note only reach the phone for stops of their own routes, via /plan.
// The days from the note go along, without the note itself.
const DRIVER_ORDER_FIELDS = ["extern", "id", "shopifyOrderId", "shopDomain", "webshop", "city", "dueDate", "earliestDate", "avoidDates", "dateUnclear", "paid", "paymentStatus", "refunded", "cancelled", "fulfilled", "deliveryMethod", "addressComplete", "deliveryAppointmentLocked", "weightKg", "products", "announced", "ownDeliveryTagged"];

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
  // Orders stored before notes were read get their days from the note here.
  let orders = (await Promise.all(
    keys.map((key) => env.PLANNING_ORDERS.get(key.name, "json"))
  )).filter(Boolean).map(withNoteDates);
  orders.sort((a, b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31"));
  // Taken out of a proposal by the planner: goes with DHL or FVR, not the van.
  const extern = new Set((await listAll(env, SHIPPING_PREFIX)).map((key) => key.name.slice(SHIPPING_PREFIX.length)));
  if (extern.size) orders = orders.map((order) => (extern.has(`${order.shopDomain}:${order.id}`) ? { ...order, extern: true } : order));

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
      const point = await cachedPoint(env, order);
      if (point) slim.point = roundPoint(point);
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
  const legacy = !url.searchParams.has("keys");
  // The driver only asks after the stops of their own routes. Those are read one
  // by one: reads are plentiful on the free plan, listings are not (1,000 a day),
  // and Bezorgd and the planner's screen need what is left of those.
  if (role === "driver") {
    if (legacy) return json([], 200, env);
    const delivered = {};
    await Promise.all([...asked].map(async (orderKey) => {
      const record = await env.PLANNING_ORDERS.get(`delivered:${orderKey}`, "json");
      if (record) delivered[orderKey] = record.deliveredAt || "";
    }));
    return json({ entries: [], delivered }, 200, env);
  }

  const listed = await listAll(env, "delivered:");
  const delivered = {};
  for (const key of listed) {
    const orderKey = key.name.slice("delivered:".length);
    if (asked.has(orderKey)) delivered[orderKey] = key.metadata?.deliveredAt || "";
  }
  const read = async (keys) => (await Promise.all(keys.map(async (key) => ({ name: key.name, record: await env.PLANNING_ORDERS.get(key.name, "json") })))).filter((entry) => entry.record);

  const withTime = listed.filter((key) => key.metadata?.deliveredAt);
  const newest = withTime
    .sort((a, b) => String(b.metadata.deliveredAt).localeCompare(String(a.metadata.deliveredAt)))
    .slice(0, 50);
  let entries = await read(newest);
  // Deliveries written before the time went into the metadata have to be read
  // to be placed. Only while the newer ones do not fill the screen yet.
  if (newest.length < 50) {
    const older = listed.filter((key) => !key.metadata?.deliveredAt).slice(0, 200);
    entries = [...entries, ...(await read(older))];
  }
  entries.sort((a, b) => String(b.record.deliveredAt || "").localeCompare(String(a.record.deliveredAt || "")));
  entries = entries.slice(0, 50);
  if (legacy) return json(entries.map((entry) => entry.record), 200, env);

  // The deliveries the planning made itself, the ones Terugdraaien can undo, also
  // once they are past the newest fifty. Those fifty are mostly DHL parcels that
  // Shopify reports, and pushed a van delivery off the screen within a day or
  // two. Found from the listing alone: the key's metadata says "own". Records
  // from before that mark only show among the newest fifty.
  const shown = new Set(entries.map((entry) => entry.name));
  const own = await read(withTime.filter((key) => key.metadata.own && !shown.has(key.name)).slice(0, 200));
  return json({ entries: entries.map((entry) => entry.record), delivered, own: own.map((entry) => entry.record) }, 200, env);
}

// A delivery on record: until sixty days after the delivery, with the time in the
// key's metadata so the history can find the newest without reading everything.
// A delivery the planning made itself is marked "own" there too. Phone and
// customer note are left out; they served the driver at the door and nobody after.
//
// The sixty days count from the delivery, not from the last write. Shopify sends
// the order again on every later change (a refund weeks on, a tag, "Sync
// Shopify"), and each of those used to start the sixty days afresh, so name and
// address outlived the promise, and a delivery whose record had already gone was
// written back. Past its sixty days nothing is written, and what is there goes.
async function putDelivered(env, key, record) {
  const order = record.order ? { ...record.order } : null;
  if (order) {
    delete order.phone;
    delete order.customerNote;
  }
  // One clock for everything: Shopify writes "+02:00", the Worker "Z", and as
  // text the two sort up to two hours wrong in the history.
  const deliveredAt = shopifyTime(record.deliveredAt) || new Date().toISOString();
  const expiration = Math.floor(Date.parse(deliveredAt) / 1000) + DELIVERED_TTL;
  // KV refuses an expiry less than a minute ahead; a minute and a half leaves room.
  if (expiration < Date.now() / 1000 + 90) {
    await env.PLANNING_ORDERS.delete(`delivered:${key}`);
    return false;
  }
  const own = Boolean(record.fulfillment?.id) || OWN_SOURCES.includes(record.source);
  const value = JSON.stringify({ ...record, deliveredAt, order });
  // Shopify's webhook for the same order can land in the same second.
  await putWithRetry(env, `delivered:${key}`, value, { expiration, metadata: own ? { deliveredAt, own: true } : { deliveredAt } });
  return true;
}

// Once, for delivery records written before the terms above (September 2026):
// phone and customer note out, no name or address for a parcel that never went
// with the van, gone 60 days after delivery (older ones at once), and marked as
// the planning's own where it was, so the history screen keeps showing them.
// It deletes data, so it runs only when the owner starts it (scripts/historie-bewaartermijn.mjs):
// asked without "apply" it only counts.
async function tidyHistory(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  const keys = await listAll(env, "delivered:");
  const counts = { records: keys.length, cleaned: 0, removed: 0, marked: 0 };
  for (const key of keys) {
    const needsTerms = !key.metadata?.deliveredAt;
    if (!needsTerms && key.metadata?.own) continue;
    const record = await env.PLANNING_ORDERS.get(key.name, "json");
    if (!record) continue;
    const own = Boolean(record.fulfillment?.id) || OWN_SOURCES.includes(record.source);
    if (!needsTerms && !own) continue;
    const vanDelivery = String(record.shopDomain || "").includes("rijplaten") || record.order?.ownDeliveryTagged || record.order?.announced || record.source !== "shopify";
    const order = record.order && !vanDelivery ? shippedElsewhere(record.order) : record.order;
    const delivered = Date.parse(shopifyTime(record.deliveredAt) || "");
    const expired = !Number.isNaN(delivered) && delivered / 1000 + DELIVERED_TTL < Date.now() / 1000 + 90;
    if (needsTerms) counts[expired ? "removed" : "cleaned"] += 1;
    if (own && !expired) counts.marked += 1;
    if (!payload.apply) continue;
    // A record without a readable time keeps its 60 days from today.
    await putDelivered(env, key.name.slice("delivered:".length), { ...record, order, deliveredAt: Number.isNaN(delivered) ? new Date().toISOString() : record.deliveredAt });
  }
  return json({ ...counts, applied: Boolean(payload.apply) }, 200, env);
}

// A customer who asks to be erased (AVG): every copy of their order here goes,
// with the point of their address. Routes hold only order numbers. In Shopify
// the customer is erased there, by hand.
async function forgetCustomerOrder(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  const asked = normalizeShopDomain(payload.shopDomain);
  const number = String(payload.id || "").trim().replace(/^#/, "").toUpperCase();
  if (!asked || !/^[\w-]+$/.test(number)) return json({ error: "Winkel en ordernummer zijn nodig." }, 400, env);
  // Order numbers are Shopify's, in capitals with a #. A number typed under the
  // wrong shop is looked for under the other one too.
  const shops = [asked, ...KNOWN_SHOPS.filter((shop) => shop !== asked)];
  const removed = new Set();
  let found = false;
  for (const shopDomain of shops) {
    const key = `${shopDomain}:#${number}`;
    const order = await env.PLANNING_ORDERS.get(`order:${key}`, "json");
    const delivered = await env.PLANNING_ORDERS.get(`delivered:${key}`, "json");
    if (!order && !delivered) continue;
    found = true;
    const keys = [`order:${key}`, `delivered:${key}`, `${ANNOUNCED_PREFIX}${key}`, `${REPORTING_PREFIX}${key}`, `${REPORT_SEEN_PREFIX}${key}`, `${REPORT_UNSURE_PREFIX}${key}`, `${SHIPPING_PREFIX}${key}`];
    for (const record of [order, delivered?.order]) if (record?.fullAddress || record?.city) keys.push(geoKeyForOrder(record));
    for (const store of [env.PLANNING_ORDERS, env.OLD_KV].filter(Boolean)) {
      for (const name of new Set(keys)) {
        if ((await store.get(name)) === null) continue;
        await store.delete(name);
        removed.add(name.slice(0, name.indexOf(":")));
      }
    }
  }
  return json({ ok: true, found, removed: [...removed] }, 200, env);
}

// The planner taking an order out of a proposal with the "−": it goes with DHL
// or FVR, not with the van, until the planner puts it back. Kept apart from the
// order record, which every Shopify webhook writes anew, and never sent to
// Shopify. Gone by itself after 120 days, long after the order has shipped.
const SHIPPING_PREFIX = "shipping:";

async function setOrderShipping(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  const orderKey = String(payload.orderKey || "");
  const split = orderKey.indexOf(":");
  if (split < 0 || !KNOWN_SHOPS.includes(orderKey.slice(0, split)) || !/^#[\w-]+$/.test(orderKey.slice(split + 1))) {
    return json({ error: "Onbekende order." }, 400, env);
  }
  if (payload.extern) {
    await env.PLANNING_ORDERS.put(`${SHIPPING_PREFIX}${orderKey}`, JSON.stringify({ extern: true, at: new Date().toISOString() }), { expirationTtl: 120 * DAY_SECONDS });
  } else {
    await env.PLANNING_ORDERS.delete(`${SHIPPING_PREFIX}${orderKey}`);
  }
  return json({ ok: true, orderKey, extern: Boolean(payload.extern) }, 200, env);
}

// Until fourteen days after it was cancelled, counted the same way: a refund or a
// tag a week later does not start the fortnight again. An order Shopify does not
// date is kept the fortnight from now.
function cancelledExpiration(shopifyOrder) {
  const cancelledAt = Date.parse(shopifyOrder.cancelled_at || "");
  const from = Number.isNaN(cancelledAt) ? Date.now() : cancelledAt;
  return Math.floor(from / 1000) + CANCELLED_TTL;
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
  // No address and no word of pickup in the order: Shopify's own delivery
  // method says whether the customer collects it. A pickup order read as a
  // delivery sat under Controleren as "Bezorgadres is onvolledig".
  if (planningOrder.deliveryMethod === "delivery" && !planningOrder.addressComplete && !planningOrder.fulfilled && !planningOrder.cancelled) {
    if ((await shopifyDeliveryMethod(env, shopDomain, planningOrder.shopifyOrderId)) === "PICK_UP") {
      planningOrder.deliveryMethod = "pickup";
      planningOrder.requiresVanRoekelDelivery = false;
    }
  }
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
    // fulfillment undo needs, is on its way: this one steps aside. The report
    // may yet end without an answer from Shopify, though, and Shopify sends this
    // webhook only once: what it knows is noted, so the report can file it then.
    if (reporting) {
      const made = history ? null : newestFulfillment(shopifyOrder);
      if (made) await env.PLANNING_ORDERS.put(`${REPORT_SEEN_PREFIX}${key}`, JSON.stringify(made), { expirationTtl: REPORT_NOTE_TTL }).catch(() => {});
      return planningOrder;
    }
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
      // Reported again after "Geen antwoord van Shopify", the retry found the
      // order already fulfilled and filed it without the fulfillment. The note
      // of the first try still says whether that fulfillment was the report's.
      let fulfillment = history.fulfillment || null;
      if (!fulfillment?.id) {
        const unsure = await env.PLANNING_ORDERS.get(`${REPORT_UNSURE_PREFIX}${key}`, "json");
        const ours = unsure ? madeWhileReporting(newestFulfillment(shopifyOrder), unsure) : null;
        if (ours) fulfillment = { id: ours.id, status: "SUCCESS" };
      }
      await putDelivered(env, key, { ...history, fulfillment, order: { ...(history.order || {}), ...planningOrder }, shopifyUpdatedAt: incoming || history.shopifyUpdatedAt });
      if (storedOrder) await env.PLANNING_ORDERS.delete(storageKey);
      return planningOrder;
    }
    const merged = storedOrder ? { ...storedOrder, ...planningOrder } : planningOrder;
    // A Bezorgd that got no answer from Shopify left a note of when it waited.
    // A fulfillment made in that window is the report's own: filed as the
    // planning's, so Terugdraaien can undo it. Any other fulfillment was made in
    // Shopify itself, and is not the planning's to undo. Only looked for while no
    // delivery is on record: the first webhook after such a report files it.
    const unsure = history ? null : await env.PLANNING_ORDERS.get(`${REPORT_UNSURE_PREFIX}${key}`, "json");
    const ours = unsure ? madeWhileReporting(newestFulfillment(shopifyOrder), unsure) : null;
    // Went with the van: rijplaten always do, and a slowfeeder order only when
    // it carries the own-delivery tag or was announced. (The shipping line says
    // "Bezorgen" for DHL parcels too, so it says nothing here.)
    const ownDelivery = ours || shopDomain.includes("rijplaten") || merged.ownDeliveryTagged || merged.announced;
    await putDelivered(env, key, {
      id: planningOrder.id,
      shopDomain,
      shopifyOrderId: planningOrder.shopifyOrderId,
      order: ownDelivery ? merged : shippedElsewhere(merged),
      fulfillment: ours ? { id: ours.id, status: "SUCCESS" } : null,
      deliveredAt: history?.deliveredAt || ours?.at || shopifyFulfilledAt(shopifyOrder) || new Date().toISOString(),
      source: ours ? unsure.source : "shopify",
      shopifyUpdatedAt: incoming,
    });
    if (storedOrder) await env.PLANNING_ORDERS.delete(storageKey);
    // A parcel keeps no address here, and so no point of it either.
    if (!ownDelivery && merged.fullAddress) await env.PLANNING_ORDERS.delete(geoKeyForOrder(merged)).catch(() => {});
    return planningOrder;
  }

  // Not (or no longer fully) fulfilled while an announcement marker stands: the
  // fulfillment was undone in Shopify, or items were added since. The marker no
  // longer tells the truth, so it goes, and the order is open like any other.
  if (announced) await env.PLANNING_ORDERS.delete(announcedKey);

  if (planningOrder.cancelled) {
    // Kept a fortnight, so a route it sat in says "geannuleerd, niet afleveren".
    const expiration = cancelledExpiration(shopifyOrder);
    if (expiration < Date.now() / 1000 + 90) await env.PLANNING_ORDERS.delete(storageKey);
    else await env.PLANNING_ORDERS.put(storageKey, JSON.stringify(planningOrder), { expiration });
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
        fulfillments(first: 10) { id createdAt status }
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
    if (order?.displayFulfillmentStatus === "FULFILLED") {
      // The newest one, so a report that got no answer the first time can tell
      // whether this fulfillment was its own.
      const newest = (order.fulfillments || [])
        .filter((item) => item?.id && item.status !== "CANCELLED" && item.createdAt)
        .map((item) => ({ id: item.id, at: item.createdAt }))
        .sort((a, b) => a.at.localeCompare(b.at))
        .at(-1) || null;
      return { fulfillment: null, alreadyFulfilled: true, newest };
    }
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

  // The driver reports deliveries of their own routes only. The phone says which
  // route the stop is in, so that one route is read instead of every route being
  // listed: Bezorgd keeps working when the day's listings are used up. Without
  // it (an older phone), or when it does not check out, every route in the
  // driver's fortnight is looked through as before.
  if (role === "driver") {
    const window = driverWindow();
    const routeDate = String(payload.routeDate || "");
    const routeId = String(payload.routeId || "");
    const named = /^[A-Za-z0-9-]{1,64}$/.test(routeId) && isPlanDate(routeDate) && routeDate >= window.from && routeDate <= window.to
      ? await readPlanRecord(env, routeDate, routeId)
      : null;
    const inNamedRoute = named && !named.abortedAt && isCallersRoute(env, named) && (named.orderKeys || []).includes(key);
    if (!inNamedRoute) {
      const stops = await plannedStops(env, window.from, window.to);
      if (!stops.has(key) || !isCallersRoute(env, stops.get(key))) return json({ error: NOT_YOUR_ROUTE }, 403, env);
    }
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
  const source = role === "driver" ? "bezorger" : "planner";
  const askedAt = new Date().toISOString();
  await env.PLANNING_ORDERS.put(reportingKey, askedAt, { expirationTtl: 60 });
  const created = await createShopifyFulfillment(shopDomain, token, shopifyOrderId, false);
  let fulfillment = created.fulfillment || (announced?.fulfillmentId ? { id: announced.fulfillmentId, status: "SUCCESS" } : null);
  // Reported again after "Geen antwoord van Shopify": the first try did make
  // the fulfillment. Its note says when it waited, so it is filed as the
  // planning's, and Terugdraaien can still undo it.
  if (!fulfillment && created.alreadyFulfilled) {
    const unsure = await env.PLANNING_ORDERS.get(`${REPORT_UNSURE_PREFIX}${key}`, "json");
    const ours = unsure ? madeWhileReporting(created.newest, unsure) : null;
    if (ours) fulfillment = { id: ours.id, status: "SUCCESS" };
  }
  if (created.error && !created.ambiguous) {
    await deleteWithRetry(env, reportingKey);
    return json({ error: created.error, userErrors: created.userErrors }, created.status, env);
  }
  if (created.error) {
    // No answer from Shopify, which may still have made the fulfillment. Its
    // webhook may already have come in while this report waited, and left what
    // it knew (see storeShopifyOrder): then it is certain after all.
    const waited = { from: askedAt, until: new Date().toISOString() };
    const seenKey = `${REPORT_SEEN_PREFIX}${key}`;
    let ours = madeWhileReporting(await env.PLANNING_ORDERS.get(seenKey, "json"), waited);
    if (!ours) {
      // Otherwise the webhook is still to come, and must not step aside: this
      // report is not going to write the delivery. The reporting marker goes,
      // and a note of when this report waited takes its place, so the webhook
      // files the fulfillment as this report's and Terugdraaien can undo it.
      await env.PLANNING_ORDERS.put(`${REPORT_UNSURE_PREFIX}${key}`, JSON.stringify({ ...waited, source }), { expirationTtl: REPORT_NOTE_TTL }).catch(() => {});
      await deleteWithRetry(env, reportingKey);
      // A webhook that slipped in just before the marker went.
      ours = madeWhileReporting(await env.PLANNING_ORDERS.get(seenKey, "json"), waited);
    }
    if (!ours) {
      return json({ error: "Geen antwoord van Shopify. Wacht een minuut, ververs en kijk of de stop als bezorgd staat voor je het opnieuw probeert.", userErrors: created.userErrors }, created.status, env);
    }
    fulfillment = { id: ours.id, status: "SUCCESS" };
  }

  // Written the moment Shopify said yes; the note, which is only context, last.
  const now = new Date().toISOString();
  await putDelivered(env, key, {
    id: displayOrderId,
    shopDomain,
    shopifyOrderId,
    order: storedOrder,
    fulfillment,
    deliveredAt: now,
    source,
    // Which driver, for the planner's history. Only a name the planner gave.
    ...(callerDriver(env) ? { by: callerDriver(env).name } : {}),
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

async function shopifyDeliveryMethod(env, shopDomain, shopifyOrderId) {
  const token = shopifyOrderId ? await shopifyAdminToken(env, shopDomain) : "";
  if (!token) return null;
  try {
    const result = await shopifyGraphql(shopDomain, token, `
      query DeliveryMethod($id: ID!) {
        order(id: $id) { fulfillmentOrders(first: 5) { nodes { deliveryMethod { methodType } } } }
      }
    `, { id: shopifyOrderId });
    const types = (result.data?.order?.fulfillmentOrders?.nodes || []).map((node) => node.deliveryMethod?.methodType).filter(Boolean);
    return types.includes("PICK_UP") ? "PICK_UP" : types[0] || null;
  } catch {
    return null;
  }
}

// "Ophalen uit Shopify" under Orders: orders read afresh from Shopify and put
// through the same door as a webhook. With order numbers, those orders (for one
// that never came in); without, every open order in the planning (for records
// written by an older version). Only reads Shopify; writes nothing there.
async function refreshFromShopify(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  const names = [...new Set((Array.isArray(payload.names) ? payload.names : [])
    .map((name) => String(name || "").trim().toUpperCase().replace(/^#?/, "#"))
    .filter((name) => /^#[A-Z0-9-]{2,20}$/.test(name)))].slice(0, 20);
  const found = [];

  if (names.length) {
    for (const name of names) {
      const shops = name.startsWith("#DSP") ? ["slowfeeder-specialist.myshopify.com"] : name.startsWith("#DRS") ? ["de-rijplaten-specialist.myshopify.com"] : KNOWN_SHOPS;
      let hit = null;
      for (const shopDomain of shops) {
        const orders = await shopifyRestOrders(env, shopDomain, { name, status: "any" });
        const order = orders.find((item) => String(item.name || "").toUpperCase() === name);
        if (order) {
          hit = { shopDomain, order };
          break;
        }
      }
      if (!hit) {
        found.push({ name, state: "niet gevonden" });
        continue;
      }
      found.push({ name, ...describeStored(await storeShopifyOrder(env, hit.order, hit.shopDomain)) });
    }
  } else {
    const open = (await Promise.all((await listAll(env, "order:")).map((key) => env.PLANNING_ORDERS.get(key.name, "json")))).filter(Boolean);
    for (const shopDomain of KNOWN_SHOPS) {
      const ids = open.filter((order) => order.shopDomain === shopDomain).map((order) => String(order.shopifyOrderId || "").split("/").pop()).filter((id) => /^\d+$/.test(id));
      for (let start = 0; start < ids.length; start += 100) {
        const orders = await shopifyRestOrders(env, shopDomain, { ids: ids.slice(start, start + 100).join(","), status: "any", limit: "250" });
        for (const order of orders) found.push({ name: order.name, ...describeStored(await storeShopifyOrder(env, order, shopDomain)) });
      }
    }
  }
  return json({ ok: true, found }, 200, env);
}

function describeStored(order) {
  if (order.cancelled) return { state: "geannuleerd" };
  if (order.fulfilled) return { state: "al verzonden" };
  if (order.deliveryMethod === "pickup") return { state: "afhalen" };
  return { state: "open" };
}

async function shopifyRestOrders(env, shopDomain, params) {
  const token = await shopifyAdminToken(env, shopDomain);
  if (!token) return [];
  const url = new URL(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders.json`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await fetch(url.toString(), { headers: { "content-type": "application/json", "x-shopify-access-token": token }, signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Shopify ${response.status}`);
  return Array.isArray(data.orders) ? data.orders : [];
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

// Decided on the country, which the planning writes last in every address
// ("..., 3941 BX Doorn, Netherlands"). Any word for a country anywhere in the
// address used to count, so a customer on the Belgiëlaan in Amersfoort was never
// placed, and only a list of names kept other countries out. A last part with no
// digits in it is taken as the country: the Netherlands under any of its names
// is Dutch, anything else (a name, a code like BE or CH) is not. Only an address
// without a country falls back to the look of a Dutch postcode.
function looksDutch(address) {
  const parts = String(address).split(",").map((part) => part.trim()).filter(Boolean);
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const hasPostcode = /\b\d{4}\s?[A-Z]{2}\b/i.test(address);
  if (last && !/\d/.test(last)) return hasPostcode && /^(nl|nld|netherlands|the netherlands|nederland|holland)$/i.test(last);
  return hasPostcode;
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
  const withFulfillment = [];

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
        const markedAt = Date.now();
        fetches += 2;
        report.reachedShopify = true;
        const created = await createShopifyFulfillment(shopDomain, token, order.shopifyOrderId, true);
        if (created.error && created.ambiguous) {
          // The request went out and no answer came: Shopify may have fulfilled
          // it and mailed the customer. The marker stays, so the order stays on
          // the route and is not mailed twice; a person looks in Shopify.
          result.status = "onzeker: kijk in Shopify of de mail is verstuurd";
          continue;
        }
        if (created.error) throw new Error(created.error);
        if (created.fulfillment?.id) withFulfillment.push({ markerKey, value: JSON.stringify({ ...marker, fulfillmentId: created.fulfillment.id }), markedAt });
        result.status = created.alreadyFulfilled ? "stond al op verzonden in Shopify, geen mail" : "aangekondigd";
      } catch (error) {
        // Certain that nothing was made: the lookup failed, or Shopify said no.
        const cleared = await deleteWithRetry(env, markerKey);
        result.status = `mislukt${cleared ? "" : " (markering bleef staan, meld het)"}: ${String(error?.message || error).slice(0, 120)}`;
      }
    }
  }

  // The markers again, now with the fulfillment Terugdraaien needs. KV takes one
  // write per key per second and Shopify often answers within that second, so
  // each is written once its first second is over: here, after the walk, so the
  // waits do not add up order by order. A refusal is tried once more. Should that
  // fail too, the customer was still told: the announcement stands, and is
  // undone in Shopify if need be.
  for (const { markerKey, value, markedAt } of withFulfillment) {
    await sleep(Math.max(0, 1100 - (Date.now() - markedAt)));
    await putWithRetry(env, markerKey, value, { expirationTtl: 365 * DAY_SECONDS }).catch(() => {});
  }

  return report;
}

// The run at 16:10 does the same walk again: orders announced at 16:00 answer
// "al aangekondigd" and keep the result they had; anything that failed or had to
// wait gets its second chance, and its new outcome replaces the old. The report
// says "echt" once either run really went to Shopify, and not before: the agenda
// shows a trial as "Proef", which tells the planner no customer was mailed.
function mergeAnnounceReports(earlier, later) {
  if (!earlier) return later;
  const merged = { ...earlier, retriedAt: later.ranAt, routes: [...(earlier.routes || [])] };
  if (later.mode === "echt" && later.reachedShopify) {
    merged.mode = "echt";
    merged.reachedShopify = true;
  }
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
  // A driver gets their own routes and nobody else's. Another driver's routes
  // only tell the phone which orders are taken (heldKeys below), so "kan er nog
  // bij" leaves them alone; their stops, names and notes stay off this phone.
  const inWindowRoutes = routes.filter(Boolean);
  const own = role === "driver" ? inWindowRoutes.filter((route) => isCallersRoute(env, route)) : inWindowRoutes;
  const othersKeys = role === "driver" ? inWindowRoutes.filter((route) => !isCallersRoute(env, route) && !route.abortedAt).flatMap((route) => route.orderKeys || []) : [];
  // A note saved on its own wins over one still inside an older route record.
  const ids = new Set(own.map((route) => route.id));
  const noteKeys = names.filter((name) => name.startsWith(PLAN_NOTE_PREFIX) && ids.has(name.slice(PLAN_NOTE_PREFIX.length)));
  const notes = new Map((await Promise.all(noteKeys.map((name) => env.PLANNING_ORDERS.get(name, "json")))).filter(Boolean).map((entry) => [entry.id, entry.note]));
  const planned = own.map((route) => (notes.has(route.id) ? { ...route, note: notes.get(route.id) } : route));
  planned.sort((a, b) => `${a.date}${String(a.number || 0).padStart(6, "0")}`.localeCompare(`${b.date}${String(b.number || 0).padStart(6, "0")}`));

  // The announcement reports name every route of the day, so only the planner,
  // whose agenda shows them, gets them.
  const body = { routes: planned, dayNotes: dayNotes.filter(Boolean), announcements: role === "driver" ? [] : announcements.filter(Boolean), announceLive: announceLive(env) };
  // Concepts come along in the same listing. The planner gets them whole; the
  // driver only learns which orders they hold, so "kan er nog bij" leaves those
  // alone.
  const concepts = (await Promise.all(names.filter((name) => name.startsWith(CONCEPT_PREFIX)).map((name) => env.PLANNING_ORDERS.get(name, "json")))).filter(Boolean);
  if (role === "driver") body.heldKeys = [...new Set([...concepts.flatMap((concept) => concept.orderKeys || []), ...othersKeys])];
  else body.concepts = concepts.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  // The planner picks a driver per route from these; the driver's phone says
  // "Welkom" with its own name. The shared code's phone learns whether drivers
  // have their own codes yet, and only then asks its holder to get one.
  if (role === "driver") {
    body.driver = callerDriver(env);
    if (!body.driver) body.ownCodes = (await readDrivers(env)).length > 0;
  } else body.drivers = publicDrivers(await readDrivers(env));
  if (role === "driver") {
    // Name, address, phone and note of the stops on the driver's own routes: the
    // only customers whose details the phone is given. Each with its point from
    // the address cache, so "kan er nog bij" weighs the route as it really lies
    // and not by a guess from the postcode. Not rounded: the phone has these
    // addresses anyway.
    const stopKeys = [...new Set(planned.filter((route) => !route.abortedAt).flatMap((route) => route.orderKeys || []))];
    const stops = (await Promise.all(stopKeys.map((key) => env.PLANNING_ORDERS.get(`order:${key}`, "json")))).filter(Boolean).map(withNoteDates);
    body.stops = await Promise.all(stops.map(async (order) => {
      const point = await cachedPoint(env, order);
      return point ? { ...order, point } : order;
    }));
    // Orders in routes planned past the driver's fortnight: the phone does not
    // see those routes, so without this it offered their orders under "kan er
    // nog bij", and the Worker then refused them as planned elsewhere.
    const laterNames = names.filter((name) => name.startsWith(PLAN_PREFIX) && name.slice(PLAN_PREFIX.length, PLAN_PREFIX.length + 10) > to);
    const later = (await Promise.all(laterNames.map((name) => env.PLANNING_ORDERS.get(name, "json")))).filter((route) => route && !route.abortedAt);
    body.heldKeys = [...new Set([...body.heldKeys, ...later.flatMap((route) => route.orderKeys || [])])];
  }
  // Stops of today's routes that were delivered today, with where they were and
  // what went there. "Kan er nog bij" counts the day as driven, not only what is
  // left of it (see routeMinutesWith). The driver gets the point to a kilometre.
  const today = amsterdamNow().day;
  const todayKeys = [...new Set(planned.filter((route) => route.date === today && !route.abortedAt).flatMap((route) => route.orderKeys || []))];
  body.doneToday = (await Promise.all(todayKeys.map(async (key) => {
    const record = await env.PLANNING_ORDERS.get(`delivered:${key}`, "json");
    if (!record || !deliveredOn(record, today)) return null;
    const point = record.order ? await cachedPoint(env, record.order) : null;
    return { key, point: role === "driver" ? roundPoint(point) : point, products: record.order?.products || [] };
  }))).filter(Boolean);
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
  // The driver who gets the route: "" for none yet. Left out of the request (a
  // route moved to another day, an older screen), the route keeps its driver.
  const driverId = "driverId" in payload ? await knownDriverId(env, payload.driverId) : undefined;
  if (driverId === null) return json({ error: DRIVER_GONE }, 404, env);

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
  if (driverId) record.driverId = driverId;
  else if (driverId === "") delete record.driverId;

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

const CONCEPT_GONE = "Dit concept bestaat niet meer: het is intussen ingepland of verwijderd.";
const CONCEPT_EMPTY = "Een concept heeft minstens één stop nodig.";

async function saveConcept(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  if (payload.update && (Array.isArray(payload.add) || Array.isArray(payload.remove))) return changeConcept(env, payload);
  const orderKeys = cleanKeys(payload.orderKeys);
  const id = /^[A-Za-z0-9-]{8,64}$/.test(String(payload.id || "")) ? String(payload.id) : crypto.randomUUID();
  if (!orderKeys.length) return json({ error: CONCEPT_EMPTY }, 400, env);
  const existing = await env.PLANNING_ORDERS.get(`${CONCEPT_PREFIX}${id}`, "json");
  if (payload.update && !existing) return json({ error: CONCEPT_GONE }, 404, env);

  const conflict = await conceptConflict(env, id, orderKeys);
  if (conflict) return conflict;

  const now = new Date().toISOString();
  const concept = { id, name: cleanName(payload.name, "Concept"), orderKeys, createdAt: existing?.createdAt || now, updatedAt: now };
  await putWithRetry(env, `${CONCEPT_PREFIX}${id}`, JSON.stringify(concept));
  return json({ ok: true, concept }, 200, env);
}

// A change to an opened concept comes as what was added and what was taken out,
// and is applied to the concept as it is on record now. The whole list from the
// screen used to replace it, so a screen that was ten minutes behind silently
// undid what another screen had added or removed meanwhile. (Older screens still
// send the whole list, and still get it replaced; see saveConcept.)
async function changeConcept(env, payload) {
  const id = String(payload.id || "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return json({ error: "Concept ontbreekt in het verzoek." }, 400, env);
  const key = `${CONCEPT_PREFIX}${id}`;
  const add = cleanKeys(payload.add);
  const remove = new Set(cleanKeys(payload.remove));
  const apply = (concept) => {
    const kept = (concept.orderKeys || []).filter((entry) => !remove.has(entry));
    return {
      ...concept,
      name: payload.name ? cleanName(payload.name, concept.name) : concept.name,
      orderKeys: [...kept, ...add.filter((entry) => !kept.includes(entry))],
      updatedAt: new Date().toISOString(),
    };
  };

  const existing = await env.PLANNING_ORDERS.get(key, "json");
  if (!existing) return json({ error: CONCEPT_GONE }, 404, env);
  // Only what is added can clash with a route or another concept; the rest was
  // checked when it went in. Nothing added, nothing listed: that spares the
  // day's listing budget.
  const added = add.filter((entry) => !(existing.orderKeys || []).includes(entry));
  if (added.length) {
    const conflict = await conceptConflict(env, id, added);
    if (conflict) return conflict;
  }
  let concept = apply(existing);
  if (!concept.orderKeys.length) return json({ error: CONCEPT_EMPTY }, 400, env);
  try {
    await env.PLANNING_ORDERS.put(key, JSON.stringify(concept));
  } catch (error) {
    if (kvLimitSpent(error)) throw error;
    // Two quick taps on one concept can land within KV's one write per key per
    // second. Tried again once that second is over, on the concept as it is
    // then, so the change of the first tap is kept as well.
    await sleep(1100);
    const current = await env.PLANNING_ORDERS.get(key, "json");
    if (!current) return json({ error: CONCEPT_GONE }, 404, env);
    concept = apply(current);
    if (!concept.orderKeys.length) return json({ error: CONCEPT_EMPTY }, 400, env);
    await env.PLANNING_ORDERS.put(key, JSON.stringify(concept));
  }
  return json({ ok: true, concept }, 200, env);
}

// A 409 when one of these orders is in a planned route, or in another concept.
async function conceptConflict(env, id, orderKeys) {
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
  return null;
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
  const basedOn = record.updatedAt || null;
  record.updatedAt = new Date().toISOString();
  const key = `${PLAN_PREFIX}${record.date}:${record.id}`;
  const options = { expiration: planExpiration(record.date) };
  try {
    await env.PLANNING_ORDERS.put(key, JSON.stringify(record), options);
  } catch (error) {
    if (kvLimitSpent(error)) throw error;
    // KV takes one write per key per second, so a second change to the same
    // route within that second is refused. Tried again once the second is over,
    // but only while the route on record is still the one this change started
    // from: a stop added or the route broken off meanwhile is not written over.
    await sleep(1100);
    const current = await env.PLANNING_ORDERS.get(key, "json");
    if ((current?.updatedAt || null) !== basedOn) throw error;
    await env.PLANNING_ORDERS.put(key, JSON.stringify(record), options);
  }
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
  if (!isCallersRoute(env, record)) return json({ error: NOT_YOUR_ROUTE }, 403, env);
  if (record.abortedAt) return json({ error: "Deze rit is afgebroken." }, 409, env);
  if ((record.orderKeys || []).includes(key)) return json({ route: record, already: true }, 200, env);

  const stored = await env.PLANNING_ORDERS.get(`order:${key}`, "json");
  if (!stored || stored.cancelled || stored.fulfilled) return json({ error: "Deze order staat niet meer open." }, 404, env);
  const order = withNoteDates(stored);

  if (role === "driver") {
    const today = amsterdamNow().day;
    if (record.date > today || record.date < shiftDay(today, -7)) return json({ error: "Onderweg iets meenemen kan alleen in de rit die je nu rijdt." }, 403, env);
    const eligible = order.paid && !order.refunded && order.addressComplete && order.deliveryMethod !== "pickup"
      && !order.deliveryAppointmentLocked && !(order.dueDate && order.dueDate < HIDE_ORDERS_DUE_BEFORE);
    if (!eligible) return json({ error: "Deze order kan niet zomaar mee. Bel de planner." }, 403, env);
    // What the note says about the day holds on the road too.
    if (order.dateUnclear) return json({ error: "In de opmerking bij deze order staat iets over de dag. Bel de planner." }, 403, env);
    if (order.earliestDate && record.date < order.earliestDate) return json({ error: `Deze order mag volgens de opmerking pas vanaf ${spokenDay(order.earliestDate)}. Bel de planner.` }, 403, env);
    if ((order.avoidDates || []).includes(record.date)) return json({ error: `Volgens de opmerking kan deze order niet op ${spokenDay(record.date)}. Bel de planner.` }, 403, env);
    const weighed = await routeMinutesWith(env, record, order);
    if (weighed.missing) return json({ error: `Van ${weighed.missing} is geen locatie bekend, dus de rit is niet na te rekenen. Bel de planner.` }, 403, env);
    if (weighed.minutes > DAY_LIMIT_MINUTES) return json({ error: "Met deze stop wordt de rit langer dan 5:45. Bel de planner." }, 403, env);
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
  if (!record || record.abortedAt || !isCallersRoute(env, record)) {
    await untagOrders(env, tagged);
    return json({ error: !record ? "Deze rit staat niet meer in de agenda." : record.abortedAt ? "Deze rit is intussen afgebroken." : NOT_YOUR_ROUTE }, 409, env);
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
// Returns { minutes }, or { missing: order number } when an address has no
// point: then nothing sensible can be said, and the driver is told which stop.
//
// The day counts as driven: stops of this route delivered today stay in the loop
// and in the unloading. Counting only the open ones let the check shrink with
// every delivery, so by the afternoon it let in what it refused that morning.
// Stops delivered on an earlier day (a route of last week, still unfinished)
// were another day's drive and do not count.
async function routeMinutesWith(env, record, extra) {
  const today = amsterdamNow().day;
  const stops = await Promise.all((record.orderKeys || []).map(async (key) => {
    const order = await env.PLANNING_ORDERS.get(`order:${key}`, "json");
    // A refunded stop is not driven, and the phone leaves it out too.
    if (order) return order.fulfilled || order.cancelled || order.refunded ? null : { order };
    const delivered = await env.PLANNING_ORDERS.get(`delivered:${key}`, "json");
    return delivered?.order && deliveredOn(delivered, today)
      ? { order: { ...delivered.order, id: delivered.order.id || delivered.id }, doneAt: String(delivered.deliveredAt || "") }
      : null;
  }));
  // What was delivered today is behind the van, in the order it was delivered;
  // the new stop can only go somewhere among the stops still ahead. Slotted in
  // between two delivered stops, a parcel far behind the van priced as +59
  // minutes when driving back for it cost three hours.
  const done = stops.filter((stop) => stop?.doneAt).sort((a, b) => a.doneAt.localeCompare(b.doneAt));
  const ahead = stops.filter((stop) => stop && !stop.doneAt);
  const orders = [...done, ...ahead].map((stop) => stop.order).concat(extra);
  const points = await Promise.all(orders.map((order) => cachedPoint(env, order)));
  const unplaced = orders.find((_, index) => !points[index]);
  if (unplaced) return { missing: unplaced.id || "deze order" };
  const km = (a, b) => Math.sqrt(((a.lat - b.lat) * 111) ** 2 + ((a.lon - b.lon) * 70) ** 2);
  const loop = (list) => list.reduce((sum, point, index) => sum + km(index ? list[index - 1] : DEPOT_POINT, point), 0) + km(list[list.length - 1], DEPOT_POINT);
  const route = points.slice(0, -1);
  let best = Infinity;
  for (let index = done.length; index <= route.length; index += 1) best = Math.min(best, loop([...route.slice(0, index), points[points.length - 1], ...route.slice(index)]));
  const unloading = orders.reduce((sum, order) => sum + (/hooihuisje|hoihuisje/.test((order.products || []).join(" ").toLowerCase()) ? 90 : 20), 0);
  return { minutes: Math.round(20.2 + 5 * (orders.length - 1) + 0.975 * best) + unloading };
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

// Breaking a route off halfway, or finishing it ("Rit afronden") at the end of
// the day. Which stops were delivered is decided here from the delivered
// records, not from whatever the driver's phone last loaded: the phone may have
// been offline for the last three drops. Delivered stops stay on the route as
// its record; the rest are released so the planning offers them again, and are
// kept apart so the planner can see what came back and why. Both close the route
// the same way (abortedAt); a finished one says so (finished), and can only be
// finished on its day or after.
async function closePlanRoute(request, env, { finish }) {
  const role = roleFor(request, env);
  if (!role) return unauthorized(env);
  const payload = await request.json().catch(() => ({}));
  const record = await readPlanRecord(env, String(payload.date || ""), String(payload.id || ""));
  if (!record) return json({ error: "Deze rit staat niet meer in de agenda." }, 404, env);
  if (!isCallersRoute(env, record)) return json({ error: NOT_YOUR_ROUTE }, 403, env);
  if (record.abortedAt) return json({ route: record }, 200, env);
  if (role === "driver") {
    const window = driverWindow();
    if (record.date < window.from || record.date > window.to) return json({ error: "Deze rit valt buiten jouw week." }, 403, env);
  }
  if (finish && record.date > amsterdamNow().day) return json({ error: "Een rit van een latere dag kun je nog niet afronden." }, 409, env);

  const keys = record.orderKeys || [];
  const delivered = await Promise.all(keys.map(async (key) =>
    key.includes(":") && !key.startsWith("?:") && Boolean(await env.PLANNING_ORDERS.get(`delivered:${key}`))
  ));

  record.orderKeys = keys.filter((_, index) => delivered[index]);
  record.droppedKeys = keys.filter((_, index) => !delivered[index]);
  record.abortedAt = new Date().toISOString();
  record.abortedBy = role === "driver" ? callerDriver(env)?.name || "bezorger" : "planner";
  record.abortReason = String(payload.reason || "").slice(0, 300);
  if (finish) record.finished = true;
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

// Two roles. The planner's code opens everything. A driver's code opens what is
// needed on the road, for their own routes: reading the day, reporting a
// delivery, taking a parcel along, breaking a route off. It cannot plan, delete
// or undo. Who is asking is worked out once per request (identify, below).
function roleFor(request, env) {
  return env[CALLER]?.role || null;
}

// ---------------------------------------------------------------------------
// Drivers. Each has a name and a code of their own. The Worker makes the code
// and the planner sees it once, to pass on; only a hash of it is kept. A driver
// sees and works on the routes the planner gave them, and on nobody else's.
//
// DRIVER_KEY, the one code every driver shared before, still opens the driver's
// screen, but only for routes without a driver: the ones planned before drivers
// had names. So the day this went live nobody was locked out halfway through a
// route, and nobody could read another driver's new routes with the old code.
// It goes once every driver has their own: wrangler secret delete DRIVER_KEY.
// ---------------------------------------------------------------------------
const CALLER = Symbol("caller");
const DRIVERS_KEY = "drivers";
// No 0 or o, no 1, l or i: read out over the phone, nothing can be mistaken.
const DRIVER_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
// Twelve of 31 signs: 59 bits. The brake lets one address try five codes in five
// minutes, so a thousand addresses would guess for millions of years.
const DRIVER_CODE_LENGTH = 12;
const MAX_DRIVERS = 20;
const DRIVER_GONE = "Deze bezorger bestaat niet meer. Ververs het scherm.";
const NOT_YOUR_ROUTE = "Deze rit staat niet (meer) op jouw naam. Ververs het scherm, of bel de planner.";

// The planner, a driver by name, or whoever holds the shared code from before
// (a driver without a name). A driver's code is looked up by its hash; one of
// another length is not even looked up.
async function identify(request, env) {
  const provided = request.headers.get("x-operator-key") || "";
  if (!provided) return { role: null };
  const planner = String(env.OPERATOR_KEY || "");
  if (planner && timingSafeEqual(planner, provided)) return { role: "planner" };
  const shared = String(env.DRIVER_KEY || "");
  if (shared && timingSafeEqual(shared, provided)) return { role: "driver", driver: null };
  const code = normalizeDriverCode(provided);
  if (code.length !== DRIVER_CODE_LENGTH) return { role: null };
  const hash = await sha256Hex(code);
  const driver = (await readDrivers(env)).find((entry) => typeof entry.codeHash === "string" && timingSafeEqual(entry.codeHash, hash));
  return driver ? { role: "driver", driver: { id: driver.id, name: driver.name } } : { role: null };
}

// The driver asking, by id and name; null for the planner or the shared code.
function callerDriver(env) {
  return env[CALLER]?.driver || null;
}

// Whether whoever asks may see and work on this route. The planner may on every
// route. A driver on their own; the shared code only on a route without a driver.
function isCallersRoute(env, route) {
  const caller = env[CALLER];
  if (caller?.role === "planner") return true;
  if (caller?.role !== "driver" || !route) return false;
  return caller.driver ? route.driverId === caller.driver.id : !route.driverId;
}

// Read on every request with a code that is not the planner's. A failed read
// throws, so the phone hears "try again" and keeps its code, and does not hear
// "wrong code", which would make it forget it.
async function readDrivers(env) {
  const record = await env.PLANNING_ORDERS.get(DRIVERS_KEY, "json");
  return Array.isArray(record?.drivers) ? record.drivers : [];
}

async function writeDrivers(env, drivers) {
  await putWithRetry(env, DRIVERS_KEY, JSON.stringify({ drivers, updatedAt: new Date().toISOString() }));
}

// What the planner's screen may know of the drivers: never the hash.
function publicDrivers(drivers) {
  return drivers.map((driver) => ({ id: driver.id, name: driver.name, codeSetAt: driver.codeSetAt || null }));
}

// "" for no driver, the id of a driver who exists, or null for one who does not
// (any more).
async function knownDriverId(env, value) {
  const id = String(value || "");
  if (!id) return "";
  return (await readDrivers(env)).some((driver) => driver.id === id) ? id : null;
}

// Every sign equally likely: bytes from 248 up are skipped, since 248 is the
// largest multiple of 31 that fits in a byte.
function newDriverCode() {
  const limit = 256 - (256 % DRIVER_CODE_ALPHABET.length);
  let code = "";
  while (code.length < DRIVER_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < limit && code.length < DRIVER_CODE_LENGTH) code += DRIVER_CODE_ALPHABET[byte % DRIVER_CODE_ALPHABET.length];
    }
  }
  return code;
}

// As the planner passes it on: three groups of four, "abcd-efgh-jkmn".
function formatDriverCode(code) {
  return code.match(/.{1,4}/g).join("-");
}

// Typed on a phone: capitals, spaces and dashes make no difference.
function normalizeDriverCode(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cleanDriverName(value) {
  return String(value || "").replace(/[<>"'`]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

// A new driver, with a code of their own, shown this once.
async function addDriver(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  const name = cleanDriverName(payload.name);
  if (!name) return json({ error: "Vul een naam in." }, 400, env);
  const drivers = await readDrivers(env);
  if (drivers.some((driver) => driver.name.toLowerCase() === name.toLowerCase())) return json({ error: `Er is al een bezorger die ${name} heet.` }, 409, env);
  if (drivers.length >= MAX_DRIVERS) return json({ error: `Meer dan ${MAX_DRIVERS} bezorgers kan niet.` }, 400, env);
  const code = newDriverCode();
  const now = new Date().toISOString();
  const driver = { id: crypto.randomUUID(), name, codeHash: await sha256Hex(code), codeSetAt: now, createdAt: now };
  const next = [...drivers, driver];
  await writeDrivers(env, next);
  return json({ driver: { id: driver.id, name }, code: formatDriverCode(code), drivers: publicDrivers(next) }, 200, env);
}

// A new code for a driver: a phone lost, a code passed on to the wrong person.
// The old code stops working at once; their routes stay theirs.
async function renewDriverCode(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  const drivers = await readDrivers(env);
  const driver = drivers.find((entry) => entry.id === String(payload.id || ""));
  if (!driver) return json({ error: DRIVER_GONE }, 404, env);
  const code = newDriverCode();
  driver.codeHash = await sha256Hex(code);
  driver.codeSetAt = new Date().toISOString();
  await writeDrivers(env, drivers);
  return json({ driver: { id: driver.id, name: driver.name }, code: formatDriverCode(code), drivers: publicDrivers(drivers) }, 200, env);
}

// Their code stops working at once. Routes they had keep their id and show
// in the agenda as having no driver, until the planner gives them to someone.
async function removeDriver(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  const drivers = await readDrivers(env);
  const next = drivers.filter((driver) => driver.id !== String(payload.id || ""));
  if (next.length !== drivers.length) await writeDrivers(env, next);
  return json({ drivers: publicDrivers(next) }, 200, env);
}

// The planner giving a planned route to a driver, or to nobody yet (""). The
// driver who had it no longer sees it from their next refresh.
async function setPlanDriver(request, env) {
  const denied = plannerOnly(request, env);
  if (denied) return denied;
  const payload = await request.json().catch(() => ({}));
  const record = await readPlanRecord(env, String(payload.date || ""), String(payload.id || ""));
  if (!record) return json({ error: "Deze rit staat niet meer in de agenda." }, 404, env);
  const driverId = await knownDriverId(env, payload.driverId);
  if (driverId === null) return json({ error: DRIVER_GONE }, 404, env);
  if ((record.driverId || "") === driverId) return json({ route: record }, 200, env);
  if (driverId) record.driverId = driverId;
  else delete record.driverId;
  return json({ route: await writePlanRecord(env, record) }, 200, env);
}

// Five wrong codes from one address, and that address waits five minutes, the
// right code included: without a pause, a short code is found by trying. The
// same wrong code sent again (three requests at once, or a screen still
// holding an old code) counts once, and a request without a code is not an
// attempt. Only the planner's code clears the count: cleared by the driver's,
// whoever holds that short code could go on guessing the planner's for ever.
// Only a keyed hash of a wrong code is kept, for a quarter of an hour.
const BRAKE_PREFIX = "brake:";
const BRAKE_ATTEMPTS = 5;
const BRAKE_WAIT_MS = 5 * 60_000;
const BRAKE_WINDOW_MS = 15 * 60_000;

async function codeBrake(request, env) {
  const provided = request.headers.get("x-operator-key") || "";
  if (!provided || request.method === "OPTIONS") return null;
  const address = brakeAddress(request);
  // Without an address everyone would share one count, and one person typing
  // wrong would lock everybody out. Cloudflare always sends it; said in the log
  // if it ever does not.
  if (!address) {
    console.warn("code brake: no client address");
    return null;
  }
  const key = `${BRAKE_PREFIX}${address}`;
  const now = Date.now();
  const record = (await env.PLANNING_ORDERS.get(key, "json").catch(() => null)) || {};
  if (record.until > now) return brakeAnswer(record.until - now, env);
  const role = roleFor(request, env);
  if (role) {
    if (role === "planner" && record.wrong?.length) await env.PLANNING_ORDERS.delete(key).catch(() => {});
    return null;
  }
  const mark = (await hmacHex(`brake|${env.OPERATOR_KEY || ""}|${env.DRIVER_KEY || ""}`, provided)).slice(0, 16);
  const wrong = (record.wrong || []).filter((entry) => entry.at > now - BRAKE_WINDOW_MS);
  if (!wrong.some((entry) => entry.mark === mark)) wrong.push({ mark, at: now });
  if (wrong.length >= BRAKE_ATTEMPTS) {
    await env.PLANNING_ORDERS.put(key, JSON.stringify({ until: now + BRAKE_WAIT_MS }), { expirationTtl: BRAKE_WAIT_MS / 1000 + 60 });
    return brakeAnswer(BRAKE_WAIT_MS, env);
  }
  await env.PLANNING_ORDERS.put(key, JSON.stringify({ wrong }), { expirationTtl: BRAKE_WINDOW_MS / 1000 });
  return null;
}

function brakeAnswer(waitMs, env) {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  const response = json({ error: `Vijf keer een verkeerde code. Wacht ${minutes} ${minutes === 1 ? "minuut" : "minuten"} en probeer het dan opnieuw.` }, 429, env);
  response.headers.set("retry-after", String(Math.ceil(waitMs / 1000)));
  return response;
}

// Who is trying: the address Cloudflare saw. On IPv6 one party easily holds a
// whole block (a free tunnel gives 65,536 networks), so a /48 counts as one.
function brakeAddress(request) {
  const ip = String(request.headers.get("cf-connecting-ip") || "").trim().toLowerCase();
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return groups.slice(0, 3).map((group) => group.replace(/^0+(?=.)/, "")).join(":");
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

// ---------------------------------------------------------------------------
// The day in the order's note. The customer at checkout, or the office after a
// phone call, writes it in words in Shopify's note (the "Opmerking"): "bezorging
// 7 oktober", "graag voor 7-10", "vanaf dinsdag 6 okt", "tussen 5 en 9 oktober",
// "week 41", "7 oktober niet thuis". What the note says wins over the date the
// shop gave (picked at checkout, or five working days for rijplaten).
//
// It does not guess. A moment it cannot place for certain ("dinsdag", "volgende
// week", "begin oktober"), a weekday that is not that date's, or days that do
// not go together: the order goes to the planner to check (dateUnclear).
// ---------------------------------------------------------------------------
const NOTE_MONTHS = { januari: 1, jan: 1, februari: 2, feb: 2, maart: 3, mrt: 3, april: 4, apr: 4, mei: 5, juni: 6, jun: 6, juli: 7, jul: 7, augustus: 8, aug: 8, september: 9, sept: 9, sep: 9, oktober: 10, october: 10, okt: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12 };
const NOTE_WEEKDAYS = { zondag: 0, zo: 0, maandag: 1, ma: 1, dinsdag: 2, di: 2, woensdag: 3, wo: 3, donderdag: 4, do: 4, vrijdag: 5, vr: 5, zaterdag: 6, za: 6 };
const WEEKDAY_NAMES = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
const MONTH_NAMES = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
const noteWords = (words) => Object.keys(words).sort((a, b) => b.length - a.length).join("|");
const NOTE_MONTH = `(${noteWords(NOTE_MONTHS)})\\.?(?![a-z])`;
const NOTE_WEEKDAY = `(?:\\b(${noteWords(NOTE_WEEKDAYS)})\\.?,?\\s+(?:de\\s+)?)?`;
const NOTE_DAY = `(\\d{1,2})(?:ste|de|e)?`;
// A number pair that is a time, a count or a size, not a day: "9-12 uur", "2-3 dagen".
const NOT_A_DAY = "(?!\\s*(?:uur|u\\b|h\\b|min|dag|dagen|werkdag|werkdagen|week|weken|stuks|st\\b|x\\b|pallet|platen|meter|m\\b|cm|mm|kg|%))";
const NOTE_PATTERNS = [
  // 2026-10-07
  { kind: "iso", re: new RegExp("(?<![\\d-])(\\d{4})-(\\d{2})-(\\d{2})(?![\\d-])", "g") },
  // 5 t/m 9 oktober, 5-9 okt, tussen 5 en 9 oktober
  { kind: "span", re: new RegExp(`(?<![\\d/.-])${NOTE_DAY}\\s*(-|t\\/m|tm|tot en met|tot|en|of)\\s*${NOTE_DAY}\\s*${NOTE_MONTH}(?:\\s+(\\d{4}))?`, "g") },
  // (dinsdag) 7 oktober (2026)
  { kind: "words", re: new RegExp(`${NOTE_WEEKDAY}(?<![\\d/.-])\\b${NOTE_DAY}\\s*${NOTE_MONTH}(?:\\s+(\\d{4}))?`, "g") },
  // (di) 7-10, 7/10, 07-10-2026
  { kind: "digits", re: new RegExp(`${NOTE_WEEKDAY}(?<![\\d/.:-])\\b(\\d{1,2})[-/](\\d{1,2})(?:[-/](\\d{4}|\\d{2}))?(?![\\d/]|[-.:]\\d)${NOT_A_DAY}`, "g") },
  // week 41
  { kind: "week", re: /\bweek\s*(?:nr\.?\s*|nummer\s*)?(\d{1,2})\b/g },
];
// Words just before a day that say what kind of day it is, tried in this order.
// "Gepland voor 7 oktober" is that day; "voor 7 oktober" on its own is before it.
const NOTE_DELIVER = "(?:bezorgen|leveren|afleveren|komen|brengen|langskomen)";
const NOTE_BEFORE = [
  { kind: "week-of", re: /(?:^|\s)week van$/ },
  { kind: "on", re: /(?:^|\s)(?:gepland|ingepland|afgesproken|verzet|verschoven|gezet|staat|staan)\s+(?:voor|naar|tot)$/ },
  { kind: "tot", re: /(?:^|\s)(?:tot en met|t\/m|tot)$/ },
  { kind: "from", re: new RegExp(`(?:^|\\s)(?:vanaf|pas vanaf|niet voor|niet eerder dan|ten vroegste|op zijn vroegst|niet(?:\\s+[a-z]+)?\\s+${NOTE_DELIVER}\\s+voor)$`) },
  { kind: "until", re: new RegExp(`(?:^|\\s)niet(?:\\s+[a-z]+)?\\s+${NOTE_DELIVER}\\s+na$`) },
  { kind: "after", re: /(?:^|\s)(?:na|pas na|na de)$/ },
  { kind: "until", re: /(?:^|\s)(?:uiterlijk|ten laatste|op zijn laatst|niet later dan|voor of op|op of voor|tot uiterlijk)$/ },
  { kind: "before", re: /(?:^|\s)voor$/ },
  { kind: "not", re: new RegExp(`(?:^|\\s)(?:niet op|liever niet|niet|behalve|geen|niet\\s+${NOTE_DELIVER})$`) },
];
// Words just after a day that turn it round: "7 oktober niet thuis", "7 oktober kan niet".
const NOTE_AFTER_ABSENT = /^\s*[,:]?\s*(?:ben|zijn|is)?\s*(?:ik|we|wij|er)?\s*(?:niet thuis|niemand thuis|niet aanwezig|afwezig|op vakantie|weg)\b/;
const NOTE_AFTER_NOT = /^\s*[,:]?\s*(?:kan|kunnen|gaat|lukt|past)\s+(?:ik|we|wij|het|dat)?\s*niet\b/;
// A number pair is only a day right after a word about the day: "bezorging
// 7/10", "vanaf 7-10". "Huisnummer 3-5" is not.
const NOTE_DATE_WORD = /(?:^|\s)(?:op|vanaf|na|voor|uiterlijk|tot|t\/m|tussen|bezorging|bezorgen|bezorgd|levering|leveren|geleverd|afleveren|datum|leverdatum|bezorgdatum|week van)$/;
const NOTE_ABSENT = /\b(?:niet thuis|niemand thuis|niet aanwezig|afwezig|op vakantie|vakantie)\b/;
const NOTE_VAGUE = new RegExp(`\\b(?:maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)(?:en|s)?\\b|\\b(?:vandaag|morgen|overmorgen)\\b|\\b(?:volgende|komende|deze|over (?:een|twee|drie|vier|\\d+)) (?:week|weken)\\b|\\b(?:begin|eind|einde|half|halverwege|midden|medio|in)\\s+(?:${noteWords(NOTE_MONTHS)})(?![a-z])|\\b(?:in het|dit|volgend|komend) weekend\\b|\\bna de vakantie\\b`, "g");
const DAY_MS = 86_400_000;

function isoOf(date) {
  return date.toISOString().slice(0, 10);
}

// A day and month without a year are taken in the year that puts them nearest
// a month after the order: "7 oktober" on an order of 20 September is this
// year's, "5 januari" on one of 15 December is next year's.
function noteDay(day, month, year, reference) {
  const make = (y) => {
    const date = new Date(Date.UTC(y, month - 1, day, 12));
    return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
  };
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  if (year) {
    const date = make(year < 100 ? 2000 + year : year);
    return date ? isoOf(date) : null;
  }
  const target = Date.parse(`${reference}T12:00:00Z`) + 30 * DAY_MS;
  const base = new Date(target).getUTCFullYear();
  const options = [base - 1, base, base + 1].map(make).filter(Boolean);
  options.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
  return options.length ? isoOf(options[0]) : null;
}

// Monday to Sunday of an ISO week, in the year that puts it nearest a month
// after the order.
function noteWeek(week, reference) {
  if (!(week >= 1 && week <= 53)) return null;
  const target = Date.parse(`${reference}T12:00:00Z`) + 30 * DAY_MS;
  const base = new Date(target).getUTCFullYear();
  const mondays = [base - 1, base, base + 1].map((year) => {
    const jan4 = new Date(Date.UTC(year, 0, 4, 12));
    return new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY_MS + (week - 1) * 7 * DAY_MS);
  });
  mondays.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
  return { from: isoOf(mondays[0]), to: isoOf(new Date(mondays[0].getTime() + 6 * DAY_MS)) };
}

function shiftIso(isoDate, days) {
  return isoOf(new Date(Date.parse(`${isoDate}T12:00:00Z`) + days * DAY_MS));
}

function spokenDay(isoDate) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  return `${WEEKDAY_NAMES[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]}`;
}

// What the note says about the day: { earliest, latest, avoid, unclear, conflict },
// or null when it says nothing about one. reference is the order's date.
export function readNoteDates(note, reference) {
  const text = String(note || "").toLowerCase().replace(/vóór/g, "voor").replace(/[–—]/g, "-").replace(/\s+/g, " ");
  if (!text.trim()) return null;
  const ref = /^\d{4}-\d{2}-\d{2}$/.test(String(reference || "")) ? reference : new Date().toISOString().slice(0, 10);
  let masked = text;
  const found = [];
  const conflicts = [];
  for (const { kind, re } of NOTE_PATTERNS) {
    for (const match of masked.matchAll(re)) {
      const start = match.index;
      const end = start + match[0].length;
      const before = text.slice(Math.max(0, start - 40), start);
      let mention = null;
      if (kind === "iso") {
        const day = noteDay(Number(match[3]), Number(match[2]), Number(match[1]), ref);
        if (day) mention = { from: day, to: day };
      } else if (kind === "span") {
        const month = NOTE_MONTHS[match[4]];
        const from = noteDay(Number(match[1]), month, match[5] ? Number(match[5]) : null, ref);
        let to = noteDay(Number(match[3]), month, match[5] ? Number(match[5]) : null, ref);
        if (!from || !to) continue;
        // "7 en 9 oktober", "7 of 9 oktober": two days, each read on its own.
        // Only "tussen 7 en 9 oktober" is everything in between.
        if ((match[2] === "en" || match[2] === "of") && !/(?:^|\s)tussen\s*$/.test(before)) {
          const second = start + match[0].search(/\d+(?:ste|de|e)?\s*[a-z]+\.?(?:\s+\d{4})?$/);
          found.push({ from, to: from, start, end: second, before, after: text.slice(end, end + 30), pair: true });
          found.push({ from: to, to, start: second, end, before: text.slice(Math.max(0, second - 40), second), after: text.slice(end, end + 30), pairedWith: before });
          masked = masked.slice(0, start) + " ".repeat(end - start) + masked.slice(end);
          continue;
        }
        if (match[2] === "tot") to = shiftIso(to, -1);
        if (from <= to) mention = { from, to, span: true };
      } else if (kind === "words" || kind === "digits") {
        const month = kind === "words" ? NOTE_MONTHS[match[3]] : Number(match[3]);
        const year = match[4] ? Number(match[4]) : null;
        if (kind === "digits" && !year && !match[1] && !NOTE_DATE_WORD.test(before.replace(/[\s:,]+$/, ""))) continue;
        const day = noteDay(Number(match[2]), month, year, ref);
        if (!day) {
          // "31 september" is a slip of the pen: said, not guessed at.
          if (kind === "words") conflicts.push(`De opmerking noemt ${Number(match[2])} ${MONTH_NAMES[month - 1]}, een dag die niet bestaat`);
          continue;
        }
        mention = { from: day, to: day };
        const said = match[1] ? NOTE_WEEKDAYS[match[1]] : null;
        if (said !== null && said !== new Date(`${day}T12:00:00Z`).getUTCDay()) {
          conflicts.push(`De opmerking zegt ${WEEKDAY_NAMES[said]} ${spokenDay(day).split(" ").slice(1).join(" ")}, maar dat is een ${spokenDay(day).split(" ")[0]}`);
        }
      } else if (kind === "week") {
        const week = noteWeek(Number(match[1]), ref);
        if (week) mention = { ...week, span: true };
      }
      if (!mention) continue;
      found.push({ ...mention, start, end, before, after: text.slice(end, end + 30) });
      masked = masked.slice(0, start) + " ".repeat(end - start) + masked.slice(end);
    }
  }
  found.sort((a, b) => a.start - b.start);

  // Two days joined by "t/m" or "tot" are a span too: "5 oktober t/m 9 oktober".
  const mentions = [];
  for (const mention of found) {
    const last = mentions[mentions.length - 1];
    const between = last ? text.slice(last.end, mention.start) : "";
    if (last && !last.joined && /^\s*(?:-|t\/m|tm|tot en met|tot)\s*$/.test(between)) {
      last.to = /^\s*tot\s*$/.test(between) ? shiftIso(mention.to, -1) : mention.to;
      last.end = mention.end;
      last.after = mention.after;
      last.span = true;
      last.joined = true;
      continue;
    }
    mentions.push({ ...mention });
  }

  let earliest = null;
  let latest = null;
  const avoid = new Set();
  const later = (a, b) => (!a || b > a ? b : a);
  const sooner = (a, b) => (!a || b < a ? b : a);
  // The second of "7 en 9 oktober" shares the words before the first:
  // "niet op 7 en 9 oktober" is neither day.
  let pairedLead = null;
  for (const mention of mentions) {
    let lead = mention.pairedWith ?? mention.before;
    for (let previous = null; previous !== lead;) {
      previous = lead;
      lead = lead.replace(/[\s:,]+$/, "").replace(/(?:^|\s)(?:op|de|het|dag|datum|graag)$/, "");
    }
    if (mention.pairedWith !== undefined && pairedLead !== null) lead = pairedLead;
    pairedLead = mention.pair ? lead : null;
    const absent = NOTE_ABSENT.test(mention.pairedWith ?? mention.before) || NOTE_AFTER_ABSENT.test(mention.after);
    const refused = NOTE_AFTER_NOT.test(mention.after);
    const word = NOTE_BEFORE.find(({ re }) => re.test(lead))?.kind;
    const day = mention.from;
    if (absent && !mention.span && word === "tot") {
      // "Op vakantie tot 7 oktober": after that day, to be safe.
      earliest = later(earliest, shiftIso(day, 1));
    } else if (absent && !mention.span && word === "before") {
      earliest = later(earliest, day);
    } else if (absent && !mention.span && word === "from") {
      latest = sooner(latest, shiftIso(day, -1));
    } else if (absent && !mention.span && word === "after") {
      latest = sooner(latest, day);
    } else if (absent || refused || word === "not") {
      for (let each = mention.from; each <= mention.to && avoid.size < 62; each = shiftIso(each, 1)) avoid.add(each);
    } else if (word === "week-of") {
      const monday = shiftIso(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
      earliest = later(earliest, monday);
      latest = sooner(latest, shiftIso(monday, 6));
    } else if (!mention.span && word === "from") {
      earliest = later(earliest, day);
    } else if (!mention.span && word === "after") {
      earliest = later(earliest, shiftIso(day, 1));
    } else if (!mention.span && (word === "until" || word === "tot")) {
      latest = sooner(latest, mention.to);
    } else if (!mention.span && word === "before") {
      latest = sooner(latest, shiftIso(mention.to, -1));
    } else {
      earliest = later(earliest, mention.from);
      latest = sooner(latest, mention.to);
    }
  }
  if (earliest && latest && earliest > latest) conflicts.push("De opmerking noemt dagen die niet samengaan");

  const vague = [...new Set([...masked.matchAll(NOTE_VAGUE)].map((match) => match[0].trim()))].slice(0, 3);
  if (!mentions.length && !vague.length && !conflicts.length) return null;
  const read = { earliest, latest, avoid: [...avoid].sort() };
  if (vague.length) read.unclear = vague.join(", ");
  if (conflicts.length) read.conflict = conflicts[0];
  return read;
}

// The order with what its note says about the day on it: earliestDate (not
// before), dueDate (not after, the note's over the shop's), avoidDates (not on),
// and dateUnclear when the planner has to look. The same order read twice gives
// the same answer, so orders stored before notes were read can be read on the way out.
export function withNoteDates(order) {
  const read = readNoteDates(order.customerNote, order.orderDate);
  if (!read) return order;
  const dated = { ...order, noteDates: read };
  if (read.unclear || read.conflict) dated.dateUnclear = true;
  if (read.conflict) return dated;
  if (read.earliest) dated.earliestDate = read.earliest;
  if (read.avoid.length) dated.avoidDates = read.avoid;
  if (read.latest) dated.dueDate = read.latest;
  else if (read.earliest && (!order.dueDate || order.dueDate < read.earliest)) dated.dueDate = read.earliest;
  return dated;
}

export function mapShopifyOrder(order, shopDomain = "") {
  const shipping = order.shipping_address || {};
  const lineItems = orderedLines(order);
  const tags = String(order.tags || "").toLowerCase();
  const deliveryMethod = inferDeliveryMethod(order, tags);

  return withNoteDates({
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
  });
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

// The newest fulfillment on an order Shopify sent, as the id undo needs and its time.
function newestFulfillment(order) {
  const made = (Array.isArray(order.fulfillments) ? order.fulfillments : [])
    .filter((item) => item && item.status !== "cancelled" && (item.admin_graphql_api_id || item.id) && shopifyTime(item.created_at))
    .map((item) => ({ id: item.admin_graphql_api_id || `gid://shopify/Fulfillment/${item.id}`, at: shopifyTime(item.created_at) }))
    .sort((a, b) => a.at.localeCompare(b.at));
  return made.at(-1) || null;
}

// A fulfillment made while a Bezorgd report waited for Shopify: from half a minute
// before it asked (two clocks) to a minute after it gave up (a request still on
// its way). Anything outside that was made in Shopify by someone else.
function madeWhileReporting(made, report) {
  if (!made?.id || !report) return null;
  const at = Date.parse(made.at || "");
  const from = Date.parse(report.from || "") - 30_000;
  const until = Date.parse(report.until || "") + 60_000;
  return at >= from && at <= until ? made : null;
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
  const line = order.shipping_lines?.[0] || {};
  const text = [line.title, line.code, line.delivery_category].map((value) => String(value || "").toLowerCase()).join(" ");
  if (/afhalen|ophalen/.test(tags) || /afhalen|ophalen|pick-?\s?up/.test(text)) return "pickup";
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

// CORS_ORIGIN may name more than one site, comma-separated: the planning moved
// from GitHub Pages to specialistenplanning.pages.dev, and a tab still open on
// the old address keeps working. The browser is told the one it asked from.
function corsHeaders(env) {
  const allowed = String(env.CORS_ORIGIN || "*").split(",").map((origin) => origin.trim()).filter(Boolean);
  const origin = allowed.includes(env.REQUEST_ORIGIN) ? env.REQUEST_ORIGIN : allowed[0] || "*";
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-shopify-hmac-sha256, x-operator-key",
  };
}
