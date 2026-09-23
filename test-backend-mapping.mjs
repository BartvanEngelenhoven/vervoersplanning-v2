import assert from "node:assert/strict";
import { mapShopifyOrder } from "./backend-worker.js";

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
  products: ["Kunststof rijplaat", "Koppelstuk"],
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

console.log("backend mapping tests passed");
