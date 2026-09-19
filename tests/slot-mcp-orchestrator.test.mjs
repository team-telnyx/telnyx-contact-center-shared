import assert from "node:assert/strict";
import test from "node:test";

import { collectSlotMcpBindings } from "../lib/agent-assist/slot-mcp-runner.mjs";
import { orchestrateSlotMcpBindings } from "../lib/agent-assist/slot-mcp-orchestrator.mjs";

const facility = (id, name, city) => ({
  facility_id: id,
  facility_name: name,
  address: `${name}, ${city}, CA`,
  city,
  state: "CA",
  lat: null,
  lng: null,
  location_type: "Hospital",
});

const lookupBinding = (slot, resultKey, prefix) => ({
  server_id: "srv-intake",
  tool_name: "lookup_addresses",
  trigger: "on_fill",
  result_key: resultKey,
  arguments: { userAddress: `{{slots.${slot}}}` },
  outputs: { [`${prefix}_facility_id`]: "0.facility_id", [`${prefix}_address`]: "0.address" },
  alternatives: { path: "$", label: "{{facility_name}}", value: "{{facility_id}}", target_slot: `${prefix}_facility_id` },
});

const PICKUP_ITEM = { item_id: "item-pickup", slot_name: "pickup_location", mcp_binding: lookupBinding("pickup_location", "pickup_lookup", "pickup") };
const DROPOFF_ITEM = { item_id: "item-dropoff", slot_name: "dropoff_location", mcp_binding: lookupBinding("dropoff_location", "dropoff_lookup", "dropoff") };

/** Shared in-memory session standing in for aa_workflow_sessions.mcp_runs. */
function makeSession(initialRuns = {}) {
  const runs = { ...initialRuns };
  const state = { version: 0 };
  // Mirrors the adapter: it remembers the fingerprint it claimed so a release
  // can be conditional on still owning it.
  const held = new Map();
  return {
    runs,
    state,
    claim: async (key, fingerprint, version) => {
      // Mirrors the SQL: the snapshot the arguments came from must still be
      // current, and the stored fingerprint must differ.
      if (version !== undefined && version !== state.version) return { claimed: false, previous: null };
      if (runs[key] === fingerprint) return { claimed: false, previous: runs[key] };
      const previous = runs[key] ?? null;
      runs[key] = fingerprint;
      held.set(key, fingerprint);
      return { claimed: true, previous };
    },
    release: async (key) => {
      // Only release if we still own the claim; a newer invocation may have
      // superseded us while the failing call was in flight. The previous
      // fingerprint is never restored - claiming retired that generation.
      if (runs[key] !== held.get(key)) return;
      delete runs[key];
    },
  };
}

/** Persist that applies only while the caller still owns the claim. */
function makeStore(session) {
  const slots = {};
  return {
    slots,
    persist: async ({ key, fingerprint, slotUpdates }) => {
      if (session.runs[key] !== fingerprint) return false;
      Object.assign(slots, slotUpdates);
      return true;
    },
  };
}

function recordingTool(handler) {
  const calls = [];
  return {
    calls,
    callTool: async (request) => {
      calls.push(request);
      return handler(request);
    },
  };
}

test("pickup and dropoff resolving to the SAME facility both execute", async () => {
  // Realistic transport: same hospital for both legs. A fingerprint keyed only
  // on tool+arguments would collide and silently skip the second lookup.
  const bindings = collectSlotMcpBindings([PICKUP_ITEM, DROPOFF_ITEM]);
  const tool = recordingTool(async () => ({ payload: [facility("2566", "Hospital A", "Palo Alto")], error: null }));
  const session = makeSession();

  const result = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A", dropoff_location: "Hospital A" },
    requiredSlots: ["pickup_location", "dropoff_location"],
    completedRuns: session.runs,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.equal(tool.calls.length, 2, "both legs must call the tool");
  assert.equal(result.invocations.filter((i) => i.ok).length, 2);
  assert.deepEqual(Object.keys(result.mcpResults).sort(), ["dropoff_lookup", "pickup_lookup"]);
});

test("two concurrent passes produce exactly one remote call", async () => {
  const bindings = collectSlotMcpBindings([PICKUP_ITEM]);
  const session = makeSession();
  const tool = recordingTool(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { payload: [facility("2566", "Hospital A", "Palo Alto")], error: null };
  });

  const run = () =>
    orchestrateSlotMcpBindings({
      bindings,
      slotsFilled: { pickup_location: "Hospital A" },
      requiredSlots: ["pickup_location"],
      completedRuns: session.runs,
      deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
    });

  const [a, b] = await Promise.all([run(), run()]);

  assert.equal(tool.calls.length, 1, "the claim must let exactly one pass invoke the tool");
  const succeeded = [...a.invocations, ...b.invocations].filter((i) => i.ok);
  assert.equal(succeeded.length, 1);
});

test("a failed call is retried on a later pass", async () => {
  const bindings = collectSlotMcpBindings([PICKUP_ITEM]);
  const session = makeSession();
  let attempt = 0;
  const tool = recordingTool(async () => {
    attempt += 1;
    if (attempt === 1) return { payload: null, error: "the reference workflow timeout" };
    return { payload: [facility("2566", "Hospital A", "Palo Alto")], error: null };
  });

  const options = {
    bindings,
    slotsFilled: { pickup_location: "Hospital A" },
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  };

  const first = await orchestrateSlotMcpBindings(options);
  assert.equal(first.invocations[0].ok, false);
  // The claim was released, so the binding is eligible again.
  assert.deepEqual(session.runs, {}, "a failed call must not stay recorded as done");

  const second = await orchestrateSlotMcpBindings(options);
  assert.equal(second.invocations[0].ok, true);
  assert.equal(second.slotUpdates.pickup_facility_id, "2566");
});

test("a failing call is attempted once per pass, not repeatedly", async () => {
  const bindings = collectSlotMcpBindings([PICKUP_ITEM]);
  const session = makeSession();
  const tool = recordingTool(async () => ({ payload: null, error: "the reference workflow down" }));

  await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A" },
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.equal(tool.calls.length, 1, "must not hammer a failing tool within one pass");
});

test("a value changed away and back (A -> B -> A) runs again", async () => {
  const bindings = collectSlotMcpBindings([PICKUP_ITEM]);
  const session = makeSession();
  const tool = recordingTool(async ({ input }) => ({
    payload: [facility(input.userAddress === "Stanford" ? "1" : "2", input.userAddress, "Palo Alto")],
    error: null,
  }));

  const run = (value) =>
    orchestrateSlotMcpBindings({
      bindings,
      slotsFilled: { pickup_location: value },
      requiredSlots: ["pickup_location"],
      completedRuns: session.runs,
      deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
    });

  await run("Stanford");
  await run("Sutter");
  const third = await run("Stanford");

  // The derived facility currently on the session belongs to Sutter, so
  // returning to Stanford must re-derive rather than be treated as done.
  assert.equal(tool.calls.length, 3);
  assert.equal(third.invocations[0].ok, true);
  assert.equal(third.slotUpdates.pickup_facility_id, "1");
});

test("four enrichment operations run automatically and create_transport waits for confirmation", async () => {
  const validate = (slot, dependsOn, prefix) => ({
    item_id: `item-${prefix}-coords`,
    slot_name: `${prefix}_coordinates`,
    mcp_binding: {
      server_id: "srv-intake",
      tool_name: "validate_address",
      trigger: "on_result",
      depends_on: dependsOn,
      result_key: `${prefix}_coords`,
      arguments: { userAddress: `{{mcp.${dependsOn}.0.address}}` },
      outputs: { [`${prefix}_lat`]: "lat", [`${prefix}_lng`]: "lng" },
    },
  });

  const create = {
    item_id: "item-create",
    slot_name: "transport_created",
    mcp_binding: {
      server_id: "srv-intake",
      tool_name: "create_transport",
      trigger: "on_complete",
      result_key: "created",
      arguments: { pickupId: "{{slots.pickup_facility_id}}", dropoffId: "{{slots.dropoff_facility_id}}" },
      outputs: { olos_trip_id: "olos_trip_id" },
    },
  };

  const bindings = collectSlotMcpBindings([
    PICKUP_ITEM,
    DROPOFF_ITEM,
    validate("pickup", "pickup_lookup", "pickup"),
    validate("dropoff", "dropoff_lookup", "dropoff"),
    create,
  ]);

  const session = makeSession();
  const tool = recordingTool(async ({ toolName, input }) => {
    if (toolName === "lookup_addresses") {
      return { payload: [facility(input.userAddress === "Hospital A" ? "2566" : "2408", input.userAddress, "Palo Alto")], error: null };
    }
    if (toolName === "validate_address") return { payload: { lat: "37.4", lng: "-122.1" }, error: null };
    return { payload: { olos_trip_id: "trip-1" }, error: null };
  });

  const automatic = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A", dropoff_location: "Hospital B" },
    requiredSlots: ["pickup_location", "dropoff_location"],
    completedRuns: session.runs,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.equal(tool.calls.length, 4, "lookups and validations should run automatically");
  assert.ok(!tool.calls.some((c) => c.toolName === "create_transport"));

  const confirmed = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: {
      pickup_location: "Hospital A",
      dropoff_location: "Hospital B",
      ...automatic.slotUpdates,
    },
    mcpResults: automatic.mcpResults,
    requiredSlots: ["pickup_location", "dropoff_location"],
    completedRuns: session.runs,
    manualSubmitItemId: "item-create",
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.equal(tool.calls.length, 5, "confirmed submit adds exactly one create_transport call");
  assert.equal(confirmed.slotUpdates.olos_trip_id, "trip-1");
});

test("on_complete waits for a required slot that also triggers a binding", async () => {
  const create = {
    item_id: "item-create",
    slot_name: "transport_created",
    mcp_binding: {
      server_id: "srv-intake",
      tool_name: "create_transport",
      trigger: "on_complete",
      result_key: "created",
      arguments: { note: "static" },
      outputs: { olos_trip_id: "olos_trip_id" },
    },
  };
  const bindings = collectSlotMcpBindings([PICKUP_ITEM, create]);
  const tool = recordingTool(async () => ({ payload: { olos_trip_id: "trip-1" }, error: null }));
  const session = makeSession();

  const result = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: {},
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    manualSubmitItemId: "item-create",
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.equal(tool.calls.length, 0, "confirmed create_transport must still wait for pickup_location");
  assert.equal(result.invocations.length, 0);
});

test("derived output slots do not count as required caller input", async () => {
  const create = {
    item_id: "item-create",
    slot_name: "transport_created",
    mcp_binding: {
      server_id: "srv-intake",
      tool_name: "create_transport",
      trigger: "on_complete",
      result_key: "created",
      arguments: { pickupId: "{{slots.pickup_facility_id}}" },
      outputs: { olos_trip_id: "olos_trip_id" },
    },
  };
  const bindings = collectSlotMcpBindings([PICKUP_ITEM, create]);
  const session = makeSession();
  const tool = recordingTool(async ({ toolName }) =>
    toolName === "lookup_addresses"
      ? { payload: [facility("2566", "Hospital A", "Palo Alto")], error: null }
      : { payload: { olos_trip_id: "trip-1" }, error: null });

  const automatic = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A" },
    requiredSlots: ["pickup_location", "pickup_facility_id"],
    completedRuns: session.runs,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.equal(tool.calls.length, 1);
  const confirmed = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A", ...automatic.slotUpdates },
    mcpResults: automatic.mcpResults,
    requiredSlots: ["pickup_location", "pickup_facility_id"],
    completedRuns: session.runs,
    manualSubmitItemId: "item-create",
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.equal(confirmed.slotUpdates.olos_trip_id, "trip-1");
  assert.ok(tool.calls.some((c) => c.toolName === "create_transport"));
});

test("multiple candidates surface as alternatives instead of a guess", async () => {
  const bindings = collectSlotMcpBindings([PICKUP_ITEM]);
  const session = makeSession();
  const tool = recordingTool(async () => ({
    payload: [facility("1", "Sutter Palo Alto", "Palo Alto"), facility("2", "Sutter Menlo", "Menlo Park")],
    error: null,
  }));

  const seen = [];
  const result = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Sutter" },
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    deps: {
      callTool: tool.callTool,
      claim: session.claim,
      release: session.release,
      onAlternatives: async (payload) => seen.push(payload),
    },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].targetSlot, "pickup_facility_id");
  assert.equal(seen[0].alternatives.length, 2);
  assert.equal(result.slotUpdates.pickup_facility_id, undefined, "must not auto-pick between candidates");
  assert.deepEqual(result.slotUpdates, {}, "no derived field may be filled from candidate 0");
  assert.equal(result.invocations[0].awaiting_selection, true);
});

test("a cyclic binding graph stops at the invocation ceiling", async () => {
  const flip = {
    item_id: "item-flip",
    slot_name: "a",
    mcp_binding: {
      server_id: "srv",
      tool_name: "flip",
      trigger: "on_fill",
      result_key: "flip",
      arguments: { value: "{{slots.a}}" },
      outputs: { a: "next" },
    },
  };
  const bindings = collectSlotMcpBindings([flip]);
  const session = makeSession();
  let n = 0;
  const tool = recordingTool(async () => ({ payload: { next: `v${(n += 1)}` }, error: null }));

  const warnings = [];
  await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { a: "v0" },
    requiredSlots: [],
    completedRuns: session.runs,
    maxInvocations: 6,
    deps: {
      callTool: tool.callTool,
      claim: session.claim,
      release: session.release,
      onWarning: (w) => warnings.push(w),
    },
  });

  assert.equal(tool.calls.length, 6);
  assert.equal(warnings[0].reason, "max_invocations_reached");
});

test("a superseded response is discarded, not persisted over the newer value", async () => {
  const bindings = collectSlotMcpBindings([PICKUP_ITEM]);
  const session = makeSession();
  const store = makeStore(session);

  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });

  const tool = recordingTool(async ({ input }) => {
    if (input.userAddress === "Hospital A") {
      await gateA;
      return { payload: [facility("AAA", "Hospital A", "Palo Alto")], error: null };
    }
    return { payload: [facility("BBB", "Hospital B", "Sacramento")], error: null };
  });

  const run = (value) =>
    orchestrateSlotMcpBindings({
      bindings,
      slotsFilled: { pickup_location: value },
      requiredSlots: ["pickup_location"],
      completedRuns: session.runs,
      deps: {
        callTool: tool.callTool,
        claim: session.claim,
        release: session.release,
        persist: store.persist,
      },
    });

  const passA = run("Hospital A");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const passB = run("Hospital B");
  const resultB = await passB;
  releaseA();
  const resultA = await passA;

  assert.equal(resultB.slotUpdates.pickup_facility_id, "BBB");
  assert.equal(store.slots.pickup_facility_id, "BBB", "the newer value must survive");
  assert.equal(resultA.invocations[0].superseded, true);
  assert.equal(resultA.invocations[0].ok, false);
});

test("an on_complete owner slot does not block its own confirmed tool", async () => {
  const create = {
    item_id: "item-create",
    slot_name: "transport_created",
    mcp_binding: {
      server_id: "srv-intake",
      tool_name: "create_transport",
      trigger: "on_complete",
      result_key: "created",
      arguments: { pickupId: "{{slots.pickup_facility_id}}" },
      outputs: { olos_trip_id: "olos_trip_id" },
    },
  };
  const bindings = collectSlotMcpBindings([create]);
  const session = makeSession();
  const tool = recordingTool(async () => ({ payload: { olos_trip_id: "trip-1" }, error: null }));

  const result = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_facility_id: "2566" },
    requiredSlots: ["transport_created"],
    completedRuns: session.runs,
    manualSubmitItemId: "item-create",
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.equal(tool.calls.length, 1);
  assert.equal(result.slotUpdates.olos_trip_id, "trip-1");
});

test("an on_result owner slot is also treated as control, not caller input", async () => {
  const validate = {
    item_id: "item-coords",
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
  const create = {
    item_id: "item-create",
    slot_name: "transport_created",
    mcp_binding: {
      server_id: "srv-intake",
      tool_name: "create_transport",
      trigger: "on_complete",
      result_key: "created",
      arguments: { lat: "{{slots.pickup_lat}}" },
      outputs: { olos_trip_id: "olos_trip_id" },
    },
  };
  const bindings = collectSlotMcpBindings([PICKUP_ITEM, validate, create]);
  const session = makeSession();
  const tool = recordingTool(async ({ toolName }) => {
    if (toolName === "lookup_addresses") return { payload: [facility("2566", "Hospital A", "Palo Alto")], error: null };
    if (toolName === "validate_address") return { payload: { lat: "37.4" }, error: null };
    return { payload: { olos_trip_id: "trip-1" }, error: null };
  });

  const automatic = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A" },
    requiredSlots: ["pickup_location", "pickup_coordinates", "transport_created"],
    completedRuns: session.runs,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.equal(automatic.slotUpdates.pickup_lat, "37.4");
  const confirmed = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A", ...automatic.slotUpdates },
    mcpResults: automatic.mcpResults,
    requiredSlots: ["pickup_location", "pickup_coordinates", "transport_created"],
    completedRuns: session.runs,
    manualSubmitItemId: "item-create",
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.equal(confirmed.slotUpdates.olos_trip_id, "trip-1");
});

test("a confirmed submit tool does not re-run when a correction changes its arguments", async () => {
  const create = {
    item_id: "item-create",
    slot_name: "transport_created",
    mcp_binding: {
      server_id: "srv-intake",
      tool_name: "create_transport",
      trigger: "on_complete",
      result_key: "created",
      arguments: { pickupId: "{{slots.pickup_facility_id}}" },
      outputs: { olos_trip_id: "olos_trip_id" },
    },
  };
  const bindings = collectSlotMcpBindings([PICKUP_ITEM, create]);
  const session = makeSession();
  let trips = 0;
  const tool = recordingTool(async ({ toolName, input }) => {
    if (toolName === "lookup_addresses") {
      return { payload: [facility(input.userAddress === "Hospital A" ? "111" : "222", input.userAddress, "X")], error: null };
    }
    trips += 1;
    return { payload: { olos_trip_id: `trip-${trips}` }, error: null };
  });

  const firstLookup = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A" },
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });
  await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A", ...firstLookup.slotUpdates },
    mcpResults: firstLookup.mcpResults,
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    manualSubmitItemId: "item-create",
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  const correctedLookup = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital B" },
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });
  await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital B", ...correctedLookup.slotUpdates },
    mcpResults: correctedLookup.mcpResults,
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    manualSubmitItemId: "item-create",
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.equal(trips, 1, "create_transport must run exactly once per session");
});

test("a failed confirmed submit stays retryable", async () => {
  const create = {
    item_id: "item-create",
    slot_name: "transport_created",
    mcp_binding: {
      server_id: "srv-intake",
      tool_name: "create_transport",
      trigger: "on_complete",
      result_key: "created",
      arguments: { note: "x" },
      outputs: { olos_trip_id: "olos_trip_id" },
    },
  };
  const bindings = collectSlotMcpBindings([create]);
  const session = makeSession();
  let attempt = 0;
  const tool = recordingTool(async () => {
    attempt += 1;
    return attempt === 1
      ? { payload: null, error: "validation failed" }
      : { payload: { olos_trip_id: "trip-1" }, error: null };
  });

  const options = {
    bindings,
    slotsFilled: {},
    requiredSlots: [],
    completedRuns: session.runs,
    manualSubmitItemId: "item-create",
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  };

  const first = await orchestrateSlotMcpBindings(options);
  assert.equal(first.invocations[0].ok, false);

  const second = await orchestrateSlotMcpBindings(options);
  assert.equal(second.invocations[0].ok, true, "a failed submit must remain retryable");
  assert.equal(second.slotUpdates.olos_trip_id, "trip-1");
});

test("an ambiguous lookup does not satisfy a chained binding", async () => {
  const validate = {
    item_id: "item-coords",
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
  const bindings = collectSlotMcpBindings([PICKUP_ITEM, validate]);
  const session = makeSession();
  const tool = recordingTool(async ({ toolName }) =>
    toolName === "lookup_addresses"
      ? { payload: [facility("2566", "Sutter Palo Alto", "Palo Alto"), facility("2999", "Sutter Menlo", "Menlo Park")], error: null }
      : { payload: { lat: "37.4" }, error: null });

  const result = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Sutter" },
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.ok(!tool.calls.some((c) => c.toolName === "validate_address"), "the chain must wait for the agent's choice");
  assert.equal(result.mcpResults.pickup_lookup, undefined, "an unresolved lookup is not a result");
  assert.ok(result.mcpCandidates.pickup_lookup, "candidates are parked for selection");
  assert.equal(result.mcpCandidates.pickup_lookup.candidates.length, 2);
  assert.equal(result.mcpCandidates.pickup_lookup.target_slot, "pickup_facility_id");
});

test("a single match still publishes a result and releases the chain", async () => {
  const validate = {
    item_id: "item-coords",
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
  const bindings = collectSlotMcpBindings([PICKUP_ITEM, validate]);
  const session = makeSession();
  const tool = recordingTool(async ({ toolName }) =>
    toolName === "lookup_addresses"
      ? { payload: [facility("2566", "Sutter Palo Alto", "Palo Alto")], error: null }
      : { payload: { lat: "37.4" }, error: null });

  const result = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Sutter Palo Alto" },
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.ok(tool.calls.some((c) => c.toolName === "validate_address"));
  assert.equal(result.slotUpdates.pickup_lat, "37.4");
  assert.deepEqual(result.mcpCandidates, {});
});

test("a stalled pass cannot reclaim a binding after the session moved on", async () => {
  const bindings = collectSlotMcpBindings([PICKUP_ITEM]);
  const session = makeSession();
  const tool = recordingTool(async () => ({ payload: [facility("AAA", "Hospital A", "X")], error: null }));

  session.state.version = 7;

  const result = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A" },
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    slotsVersion: 3,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.equal(tool.calls.length, 0, "a stale snapshot must not win the claim");
  assert.equal(result.invocations.length, 0);
});

test("an ambiguous rerun clears the outputs the earlier match produced", async () => {
  const bindings = collectSlotMcpBindings([PICKUP_ITEM]);
  const session = makeSession();
  const tool = recordingTool(async ({ input }) =>
    input.userAddress === "Hospital A"
      ? { payload: [facility("111", "Hospital A", "X")], error: null }
      : { payload: [facility("222", "Sutter PA", "Y"), facility("333", "Sutter MP", "Z")], error: null });

  const run = (pickup) =>
    orchestrateSlotMcpBindings({
      bindings,
      slotsFilled: { pickup_location: pickup },
      requiredSlots: ["pickup_location"],
      completedRuns: session.runs,
      deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
    });

  const first = await run("Hospital A");
  assert.equal(first.slotUpdates.pickup_facility_id, "111");

  const second = await run("Sutter");
  assert.equal(second.slotUpdates.pickup_facility_id, undefined, "the stale id must not survive");
  assert.ok(second.invalidatedSlots.includes("pickup_facility_id"));
  assert.ok(second.mcpCandidates.pickup_lookup, "candidates await the agent");
});

test("a nested template defers the call just like a top-level one", async () => {
  const nested = {
    item_id: "item-nested",
    slot_name: "pickup_location",
    mcp_binding: {
      server_id: "s",
      tool_name: "nested_tool",
      trigger: "on_fill",
      result_key: "nested",
      arguments: { request: { facilityId: "{{mcp.lookup.id}}" } },
      outputs: {},
    },
  };
  const bindings = collectSlotMcpBindings([nested]);
  const session = makeSession();
  const tool = recordingTool(async () => ({ payload: {}, error: null }));

  await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A" },
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });

  assert.equal(tool.calls.length, 0, "a nested unresolved template must defer the call");
});

test("a partially interpolated argument defers the call", async () => {
  const partial = {
    item_id: "item-partial",
    slot_name: "pickup_location",
    mcp_binding: {
      server_id: "s",
      tool_name: "lookup_addresses",
      trigger: "on_fill",
      result_key: "partial",
      arguments: { reference: "facility-{{slots.facility_id}}" },
      outputs: {},
    },
  };
  const bindings = collectSlotMcpBindings([partial]);
  const session = makeSession();
  const tool = recordingTool(async () => ({ payload: [], error: null }));

  const held = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A" },
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });
  assert.equal(tool.calls.length, 0, "a partially resolved argument must defer");
  assert.equal(held.invocations.length, 0);

  const ready = await orchestrateSlotMcpBindings({
    bindings,
    slotsFilled: { pickup_location: "Hospital A", facility_id: "1562" },
    requiredSlots: ["pickup_location"],
    completedRuns: session.runs,
    deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
  });
  assert.equal(tool.calls.length, 1);
  assert.equal(tool.calls[0].input.reference, "facility-1562");
  assert.equal(ready.invocations[0].ok, true);
});

test("A succeeds, B fails, back to A: A runs again rather than being skipped", async () => {
  const bindings = collectSlotMcpBindings([PICKUP_ITEM]);
  const session = makeSession();
  const seen = [];
  const tool = recordingTool(async ({ input }) => {
    seen.push(input.userAddress);
    if (input.userAddress === "Hospital B") return { payload: null, error: "the reference workflow timeout" };
    return { payload: [facility("111", input.userAddress, "X")], error: null };
  });

  const run = (pickup) =>
    orchestrateSlotMcpBindings({
      bindings,
      slotsFilled: { pickup_location: pickup },
      requiredSlots: ["pickup_location"],
      completedRuns: session.runs,
      slotsVersion: session.state.version,
      deps: { callTool: tool.callTool, claim: session.claim, release: session.release },
    });

  await run("Hospital A");
  await run("Hospital B");
  const third = await run("Hospital A");

  assert.deepEqual(seen, ["Hospital A", "Hospital B", "Hospital A"]);
  assert.equal(third.invocations[0].ok, true, "returning to A must re-derive it");
  assert.equal(third.slotUpdates.pickup_facility_id, "111");
});

test("a failed replacement leaves nothing of the generation it replaced", async () => {
  const bindings = collectSlotMcpBindings([PICKUP_ITEM]);
  const session = makeSession();
  const tool = recordingTool(async ({ input }) =>
    input.userAddress === "Hospital A"
      ? { payload: [facility("111", "Hospital A", "X")], error: null }
      : { payload: null, error: "the reference workflow down" });

  const store = {};
  const run = (pickup) =>
    orchestrateSlotMcpBindings({
      bindings,
      slotsFilled: { pickup_location: pickup, ...store },
      requiredSlots: ["pickup_location"],
      completedRuns: session.runs,
      slotsVersion: session.state.version,
      deps: {
        callTool: tool.callTool,
        claim: session.claim,
        release: session.release,
        persist: async ({ slotUpdates }) => {
          Object.assign(store, slotUpdates);
          return { slotsVersion: session.state.version, appliedSlotUpdates: slotUpdates };
        },
      },
    });

  await run("Hospital A");
  assert.equal(store.pickup_facility_id, "111");

  const failed = await run("Nowhere");
  assert.ok(failed.invalidatedSlots.includes("pickup_facility_id"));
  assert.equal(failed.invocations[0].ok, false);
  assert.equal(session.runs[Object.keys(session.runs)[0]], undefined, "no fingerprint survives the failure");
});