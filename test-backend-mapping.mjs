import assert from "node:assert/strict";
import { mapShopifyOrder } from "./backend-worker.js";

const deliveryOrder = {
  id: 123,
  name: "#1001",
  financial_status: "paid",
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

assert.deepEqual(mapShopifyOrder(deliveryOrder), {
  id: "#1001",
  customer: "Jan Jansen",
  city: "Ede",
  postcode: "6718 TA",
  dueDate: "2026-09-24",
  paid: true,
  cancelled: false,
  fulfilled: false,
  deliveryMethod: "delivery",
  requiresVanRoekelDelivery: true,
  addressComplete: true,
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

console.log("backend mapping tests passed");
