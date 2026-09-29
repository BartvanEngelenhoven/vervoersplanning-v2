import assert from "node:assert/strict";
import { mapShopifyOrder, readNoteDates, withNoteDates } from "./backend-worker.js";

const deliveryOrder = {
  id: 123,
  name: "#1001",
  financial_status: "paid",
  created_at: "2026-09-17T10:00:00+02:00",
  fulfillment_status: null,
  cancelled_at: null,
  tags: "Van Roekel, eigen bezorging",
  shipping_address: {
    first_name: "Jan",
    last_name: "Jansen",
    address1: "Dorpsstraat 1",
    city: "Ede",
    zip: "6718 TA",
    country_code: "NL",
  },
  shipping_lines: [{ title: "Bezorging Van Roekel" }],
  note_attributes: [{ name: "Bezorgdatum", value: "2026-09-24" }],
  line_items: [
    { title: "Kunststof rijplaat", grams: 31000, quantity: 20 },
    { title: "Koppelstuk", grams: 2500, quantity: 4 },
  ],
};

assert.deepEqual(mapShopifyOrder(deliveryOrder, "slowfeeder-specialist.myshopify.com"), {
  id: "#1001",
  shopifyOrderId: "gid://shopify/Order/123",
  shopDomain: "slowfeeder-specialist.myshopify.com",
  webshop: "De Slowfeeder Specialist",
  customer: "Jan Jansen",
  addressLine: "Dorpsstraat 1",
  fullAddress: "Dorpsstraat 1, 6718 TA Ede, NL",
  city: "Ede",
  postcode: "6718 TA",
  orderDate: "2026-09-17",
  dueDate: "2026-09-24",
  paid: true,
  paymentStatus: "Betaald",
  cancelled: false,
  fulfilled: false,
  deliveryMethod: "delivery",
  requiresVanRoekelDelivery: true,
  addressComplete: true,
  deliveryAppointmentLocked: false,
  deliveryMinutes: 20,
  weightKg: 630,
  products: ["20x Kunststof rijplaat", "4x Koppelstuk"],
  phone: "",
  customerNote: "",
  refunded: false,
  country: "NL",
  ownDeliveryTagged: true,
  shopifyUpdatedAt: "",
});

const pickupOrder = {
  id: 124,
  name: "#1002",
  financial_status: "pending",
  fulfillment_status: null,
  cancelled_at: null,
  tags: "afhalen",
  shipping_address: {},
  shipping_lines: [{ title: "Afhalen in Ede" }],
  line_items: [{ title: "Slowfeeder", grams: 85000, quantity: 1 }],
};

assert.equal(mapShopifyOrder(pickupOrder).deliveryMethod, "pickup");
assert.equal(mapShopifyOrder(pickupOrder).requiresVanRoekelDelivery, false);
// Pickup said another way: "ophalen" in the title, or Shopify's local pickup code.
assert.equal(mapShopifyOrder({ ...pickupOrder, tags: "", shipping_lines: [{ title: "Ophalen in Ede" }] }).deliveryMethod, "pickup");
assert.equal(mapShopifyOrder({ ...pickupOrder, tags: "", shipping_lines: [{ title: "De Rijplaten Specialist", code: "Local Pickup" }] }).deliveryMethod, "pickup");
assert.equal(mapShopifyOrder({ ...pickupOrder, tags: "", shipping_lines: [{ title: "Bezorgen" }] }).deliveryMethod, "delivery");
assert.equal(mapShopifyOrder(pickupOrder).paid, false);
assert.equal(mapShopifyOrder(pickupOrder).addressComplete, false);

const rijplatenShippingOrder = {
  id: 125,
  name: "#DRS1",
  financial_status: "pending",
  created_at: "2026-09-23T15:30:00+02:00",
  fulfillment_status: null,
  cancelled_at: null,
  tags: "",
  shipping_address: {
    first_name: "Test",
    last_name: "Klant",
    address1: "Goorsteeg 46",
    city: "Ede",
    zip: "6718 TA",
    country_code: "NL",
  },
  shipping_lines: [{ title: "Shipping" }],
  line_items: [{ title: "Gebruikte kunststof rijplaat", grams: 0, quantity: 1 }],
};

const mappedRijplatenOrder = mapShopifyOrder(rijplatenShippingOrder, "de-rijplaten-specialist.myshopify.com");
assert.equal(mappedRijplatenOrder.requiresVanRoekelDelivery, true);
assert.equal(mappedRijplatenOrder.dueDate, "2026-09-30");

// The driver needs a number to ring and whatever the customer wrote at checkout.
const doorstepOrder = {
  ...deliveryOrder,
  note: "Achterom, de hond loopt los",
  phone: "+31 6 00000000",
  shipping_address: { ...deliveryOrder.shipping_address, phone: "+31 6 11111111" },
};
const mappedDoorstep = mapShopifyOrder(doorstepOrder, "slowfeeder-specialist.myshopify.com");
assert.equal(mappedDoorstep.phone, "+31 6 11111111", "the shipping phone wins over the order phone");
assert.equal(mappedDoorstep.customerNote, "Achterom, de hond loopt los");

// The Shopify title never says "houten": a hay house must still get its 90 minutes.
const hayHouseOrder = { ...deliveryOrder, line_items: [{ title: "Slowfeeder hooihuisje voor paarden. Compleet geleverd", grams: 0, quantity: 1 }] };
assert.equal(mapShopifyOrder(hayHouseOrder, "slowfeeder-specialist.myshopify.com").deliveryMinutes, 90);

// A line taken off the order in an edit stays in line_items at quantity zero.
const editedOrder = { ...deliveryOrder, line_items: [{ title: "Slowfeeder XXL Pony Edition", quantity: 1, current_quantity: 0 }, { title: "Koppelstuk", quantity: 2, current_quantity: 2, grams: 2500 }] };
assert.deepEqual(mapShopifyOrder(editedOrder, "slowfeeder-specialist.myshopify.com").products, ["2x Koppelstuk"]);

// The planning's own block in the note is not the customer's.
const notedOrder = { ...deliveryOrder, note: "Bel even aan\n\n[Vervoersplanning]\nBezorgd gemeld via Vervoersplanning" };
assert.equal(mapShopifyOrder(notedOrder, "slowfeeder-specialist.myshopify.com").customerNote, "Bel even aan");

// The day in the note: what it says wins over the shop's date, and what it
// cannot place for certain goes to the planner. Orders of 20 September 2026;
// 7 October 2026 is a Wednesday.
const noteCases = [
  ["Bezorging 7 oktober", { earliest: "2026-10-07", latest: "2026-10-07", avoid: [] }],
  ["bezorging 7 okt.", { earliest: "2026-10-07", latest: "2026-10-07", avoid: [] }],
  ["Graag leveren op woensdag 7 oktober", { earliest: "2026-10-07", latest: "2026-10-07", avoid: [] }],
  ["Bezorging 7/10", { earliest: "2026-10-07", latest: "2026-10-07", avoid: [] }],
  ["bezorgdatum 7-10-26", { earliest: "2026-10-07", latest: "2026-10-07", avoid: [] }],
  ["Klant belde: bezorging verzet naar 9 oktober", { earliest: "2026-10-09", latest: "2026-10-09", avoid: [] }],
  ["Levering gepland voor 7 oktober", { earliest: "2026-10-07", latest: "2026-10-07", avoid: [] }],
  ["Uiterlijk 7 oktober", { earliest: null, latest: "2026-10-07", avoid: [] }],
  ["Graag voor 7 oktober bezorgen", { earliest: null, latest: "2026-10-06", avoid: [] }],
  ["Niet leveren na 9 oktober", { earliest: null, latest: "2026-10-09", avoid: [] }],
  ["Niet voor 7 oktober bezorgen", { earliest: "2026-10-07", latest: null, avoid: [] }],
  ["Niet bezorgen voor 7 oktober", { earliest: "2026-10-07", latest: null, avoid: [] }],
  ["Vanaf 7-10", { earliest: "2026-10-07", latest: null, avoid: [] }],
  ["Na 7 oktober", { earliest: "2026-10-08", latest: null, avoid: [] }],
  ["Tussen 5 en 9 oktober", { earliest: "2026-10-05", latest: "2026-10-09", avoid: [] }],
  ["5 t/m 9 oktober", { earliest: "2026-10-05", latest: "2026-10-09", avoid: [] }],
  ["van 5 oktober tot 9 oktober", { earliest: "2026-10-05", latest: "2026-10-08", avoid: [] }],
  ["Levering in week 41", { earliest: "2026-10-05", latest: "2026-10-11", avoid: [] }],
  ["Graag in de week van 12 oktober", { earliest: "2026-10-12", latest: "2026-10-18", avoid: [] }],
  ["7 oktober niet thuis", { earliest: null, latest: null, avoid: ["2026-10-07"] }],
  ["Niet leveren op 7 oktober", { earliest: null, latest: null, avoid: ["2026-10-07"] }],
  ["7 oktober kan niet", { earliest: null, latest: null, avoid: ["2026-10-07"] }],
  ["niet op 7 en 9 oktober", { earliest: null, latest: null, avoid: ["2026-10-07", "2026-10-09"] }],
  ["Niet thuis van 5 t/m 7 oktober", { earliest: null, latest: null, avoid: ["2026-10-05", "2026-10-06", "2026-10-07"] }],
  ["Wij zijn tot 7 oktober op vakantie", { earliest: "2026-10-08", latest: null, avoid: [] }],
  ["Voor 7 oktober niet thuis", { earliest: "2026-10-07", latest: null, avoid: [] }],
  ["Graag bezorgen op 7 oktober om 10:00", { earliest: "2026-10-07", latest: "2026-10-07", avoid: [] }],
  // Not a day at all: a house number, a time, a count, a phone number.
  ["Huisnummer 3-5, achterom", null],
  ["Tussen 9-12 uur leveren", null],
  ["Levering 2-3 dagen", null],
  ["Bel 06-12345678 voor levering", null],
  ["Graag vóór 12.00 uur", null],
  ["Goedemorgen, graag achterom", null],
  ["Achterom, de hond loopt los", null],
  ["Fijn weekend!", null],
  // Said, but not placed for certain: the planner looks.
  ["Graag op dinsdag bezorgen", { earliest: null, latest: null, avoid: [], unclear: "dinsdag" }],
  ["Volgende week graag", { earliest: null, latest: null, avoid: [], unclear: "volgende week" }],
  ["Begin oktober", { earliest: null, latest: null, avoid: [], unclear: "begin oktober" }],
  ["Morgen bezorgen graag", { earliest: null, latest: null, avoid: [], unclear: "morgen" }],
  ["In het weekend niet thuis", { earliest: null, latest: null, avoid: [], unclear: "in het weekend" }],
  ["Graag leveren op dinsdag 7 oktober", { earliest: "2026-10-07", latest: "2026-10-07", avoid: [], conflict: "De opmerking zegt dinsdag 7 oktober, maar dat is een woensdag" }],
  ["Bezorging 7 oktober, anders 9 oktober", { earliest: "2026-10-09", latest: "2026-10-07", avoid: [], conflict: "De opmerking noemt dagen die niet samengaan" }],
  ["7 of 8 oktober", { earliest: "2026-10-08", latest: "2026-10-07", avoid: [], conflict: "De opmerking noemt dagen die niet samengaan" }],
  ["Bezorging 31 september", { earliest: null, latest: null, avoid: [], conflict: "De opmerking noemt 31 september, een dag die niet bestaat" }],
];
for (const [note, expected] of noteCases) assert.deepEqual(readNoteDates(note, "2026-09-20"), expected, note);
// Around the turn of the year the nearer year is meant.
assert.equal(readNoteDates("Bezorging 5 januari", "2026-12-15").earliest, "2027-01-05");
assert.equal(readNoteDates("Bezorging 28 december", "2027-01-03").earliest, "2026-12-28");

// Mapped from Shopify, the note's day beats the checkout date; read again, it
// stays the same; and without a date nothing is added.
const datedOrder = mapShopifyOrder({ ...deliveryOrder, note: "Graag bezorgen op 7 oktober" }, "slowfeeder-specialist.myshopify.com");
assert.equal(datedOrder.dueDate, "2026-10-07", "was 2026-09-24 from the checkout");
assert.equal(datedOrder.earliestDate, "2026-10-07");
assert.deepEqual(withNoteDates(datedOrder), datedOrder);
const fromOrder = withNoteDates({ customerNote: "vanaf 7 oktober", orderDate: "2026-09-20", dueDate: "2026-09-25" });
assert.equal(fromOrder.dueDate, "2026-10-07", "a first day after the shop's last one moves the last one along");
assert.deepEqual(withNoteDates(fromOrder), fromOrder);
const unclearOrder = withNoteDates({ customerNote: "Graag op 7 okt of 8 okt", orderDate: "2026-09-20", dueDate: "2026-09-25" });
assert.equal(unclearOrder.dateUnclear, true);
assert.equal(unclearOrder.dueDate, "2026-09-25", "days that do not go together change nothing but the flag");
assert.ok(!("earliestDate" in unclearOrder));
assert.ok(!("noteDates" in mapShopifyOrder(deliveryOrder, "slowfeeder-specialist.myshopify.com")));

console.log("backend mapping tests passed");
