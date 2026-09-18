import assert from "node:assert/strict";
import test from "node:test";

import { collectSlotMcpBindings } from "../lib/agent-assist/slot-mcp-runner.mjs";
import { orchestrateSlotMcpBindings } from "../lib/agent-assist/slot-mcp-orchestrator.mjs";

const facility = (id, name) => ({
  facility_id: id,
  facility_name: name,
  address: `${name}, CA`,
});

const pickupItem = {
  item_id: "item-pickup",
  slot_name: "pickup_location",
  mcp_binding: {
    server_id: "srv-intake",
    tool_name: "lookup_addresses",
    trigger: "on_fill",
    result_key: "pickup_lookup",
    arguments: { userAddress: "{{slots.pickup_location}}" },
    outputs: { pickup_facility_id: "0.facility_id" },
  },
};

const dropoffItem = {
  item_id: "item-dropoff",
  slot_name: "dropoff_location",
  mcp_binding: {
    server_id: "srv-intake",
    tool_name: "lookup_addresses",
    trigger: "on_fill",
    result_key: "dropoff_lookup",
    arguments: { userAddress: "{{slots.dropoff_location}}" },
    outputs: { dropoff_facility_id: "0.facility_id" },
  },
};

const validateItem = {
  item_id: "item-validate",
  slot_name: "pickup_coordinates",
  mcp_binding: {
    server_id: "srv-intake",
    tool_name: "validate_address",
    trigger: "on_result",
    depends_on: "pickup_lookup",
    result_key: "pickup_coords",
    arguments: { userAddress: "{{mcp.pickup_lookup.0.address}}" },
    outputs: { pickup_lat: "lat" },
  },
};

/** A small state double that matches the production claim/persist version contract. */
function versionedDeps({ onCall } = {}) {
  const runs = {};
  let version = 0;
  const held = new Map();
  const calls = [];

  return {
    runs,
    calls,
    version: () => version,
    claim: async (key, fingerprint, expectedVersion) => {
      if (expectedVersion !== version) return { claimed: false, itemUpdates: [] };
      if (runs[key] === fingerprint) return { claimed: false, itemUpdates: [] };
      runs[key] = fingerprint;
      held.set(key, fingerprint);
      version += 1;
      return { claimed: true, slotsVersion: version, itemUpdates: [] };
    },
    release: async (key) => {
      if (runs[key] === held.get(key)) delete runs[key];
      // Deliberately does not advance version: release changes only claim metadata.
    },
    persist: async ({ key, fingerprint, expectedSlotsVersion, slotUpdates }) => {
      if (runs[key] !== fingerprint) return false;
      if (expectedSlotsVersion !== version) return false;
      version += 1;
      return { slotsVersion: version, appliedSlotUpdates: slotUpdates };
    },
    callTool: async (request) => {
      calls.push(request);
      if (onCall) return onCall(request, { bumpVersion: () => { version += 1; } });
      return { payload: [facility("1", "Hospital")], error: null };
    },
  };
}

test("a source edit after claim prevents the stale result from persisting or chaining", async () => {
  const bindings = collectSlotMcpBindings([pickupItem, validateItem]);
  const deps = versionedDeps({
    onCall: async ({ toolName }, state) => {
      if (toolName === "lookup_addresses") {
        // Simulate another request updating pickup_location after this lookup
        // has claimed its generation but before its response is persisted.
        state.bumpVersion();
        return { payload: [facility("111", "Hospital A")], error: null };
      }
      return { payload: { lat: "37.4" }, error: null };
    },
  });

  const result = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A" },
    requiredSlots: ["pickup_location"],
    completedRuns: deps.runs,
    slotsVersion: deps.version(),
    deps,
  });

  assert.equal(deps.calls.length, 1, "the dependent validation must not consume a superseded lookup");
  assert.equal(result.slotUpdates.pickup_facility_id, undefined);
  assert.equal(result.mcpResults.pickup_lookup, undefined);
  assert.equal(result.invocations[0].superseded, true);
});

test("an optional failure does not block an independent binding in the same pass", async () => {
  const bindings = collectSlotMcpBindings([pickupItem, dropoffItem]);
  const deps = versionedDeps({
    onCall: async ({ input }) => {
      if (input.userAddress === "Hospital A") return { payload: null, error: "the reference workflow timeout" };
      return { payload: [facility("222", "Hospital B")], error: null };
    },
  });

  const result = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A", dropoff_location: "Hospital B" },
    requiredSlots: ["pickup_location", "dropoff_location"],
    completedRuns: deps.runs,
    slotsVersion: deps.version(),
    deps,
  });

  assert.equal(deps.calls.length, 2, "dropoff lookup should still run after optional pickup failure");
  assert.equal(result.invocations[0].ok, false);
  assert.equal(result.invocations[1].ok, true);
  assert.equal(result.slotUpdates.dropoff_facility_id, "222");
});

test("a volatile-arg binding invokes once, not up to the pass cap", async () => {
  const uuidItem = {
    item_id: "item-uuid",
    slot_name: "pickup_location",
    mcp_binding: {
      server_id: "srv-intake",
      // Not create_transport: the orchestrator suppresses that tool outside the
      // confirmed-submit endpoint. The volatile-fingerprint hazard is general.
      tool_name: "reserve_reference",
      trigger: "on_fill",
      execution_policy: "on_argument_change",
      result_key: "created",
      arguments: { tripId: "{{@uuid:trip}}", where: "{{slots.pickup_location}}" },
      outputs: {},
    },
  };
  const bindings = collectSlotMcpBindings([uuidItem]);
  const deps = versionedDeps({ onCall: async () => ({ payload: { ok: true }, error: null }) });

  const result = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A" },
    requiredSlots: ["pickup_location"],
    completedRuns: deps.runs,
    slotsVersion: deps.version(),
    deps,
  });

  // Before the fix this looped to the invocation cap: each iteration built a
  // fresh scope, drew a fresh uuid, saw a "changed" fingerprint, and re-fired.
  assert.equal(deps.calls.length, 1, "one invocation for one unchanged state");
  assert.equal(result.invocations.filter((i) => i.ok).length, 1);
});
