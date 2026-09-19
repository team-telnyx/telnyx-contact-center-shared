import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Codex review (PR #1382, P1): the address-shaped-value guard in
// analyze/route.js keys off slot_validation === "address" to find a group's
// address sibling. The built-in seed workflow template
// (lib/medical-transport-intake-workflow.mjs) - used whenever a fresh
// environment is first provisioned - defined pickup_address/
// destination_address without slot_validation set at all, so the guard
// would silently be a no-op for any workflow instance seeded from this
// template, even though it's otherwise structurally identical to the fixed
// admin-imported version.

test("seed healthcare intake template marks pickup_address and destination_address with slot_validation: address", async () => {
  const source = await read("../lib/medical-transport-intake-workflow.mjs");

  const pickupBlock = source.slice(
    source.indexOf('slot_name: "pickup_address"') - 200,
    source.indexOf('slot_name: "pickup_address"') + 100,
  );
  assert.match(pickupBlock, /slot_validation: "address",/, "pickup_address must carry slot_validation: address");

  const destinationBlock = source.slice(
    source.indexOf('slot_name: "destination_address"') - 200,
    source.indexOf('slot_name: "destination_address"') + 100,
  );
  assert.match(destinationBlock, /slot_validation: "address",/, "destination_address must carry slot_validation: address");
});
