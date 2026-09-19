import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  isNoRoomValue,
  isBedSlotName,
  isRoomSlotName,
  roomSlotNameForBed,
  bedSlotsToResolve,
  resolveInferredBeds,
  NO_BED_VALUE,
  INFERRED_BY,
} from "../lib/agent-assist/room-bed-inference.mjs";
import { resolveSuggestedResponseTarget } from "../lib/agent-assist/suggestion-target-resolver.mjs";

// an earlier fix: a room resolved as not-applicable (scene pickup, residence) means
// there is no bed either. The bed resolves to none without an agent prompt, the
// suggested-response panel stops asking for it, and the agent can still override.

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("an explicit not-applicable room reads as 'no room'", () => {
  for (const value of [
    "N/A", "n/a", "na", "N.A.", "none", "None", "no", "nil",
    "unknown", "not applicable", "TBD", "to be determined",
    "not assigned", "unassigned", "-", "--",
    "no room", "no room number", "without a room", "not in a room",
    "room number is N/A", "room not assigned", "room: unknown",
  ]) {
    assert.equal(isNoRoomValue(value), true, `expected "${value}" to read as no-room`);
  }
});

test("a real room number is never mistaken for 'no room'", () => {
  for (const value of ["302", "4 North", "ER bay 2", "ICU-12", "Room 7", "A", "0"]) {
    assert.equal(isNoRoomValue(value), false, `expected "${value}" to be a real room`);
  }
});

test("an unfilled room is not a no-room answer — the caller was never asked", () => {
  assert.equal(isNoRoomValue(""), false);
  assert.equal(isNoRoomValue("   "), false);
  assert.equal(isNoRoomValue(null), false);
  assert.equal(isNoRoomValue(undefined), false);
});

test("bed slots pair to their room slot by name", () => {
  assert.equal(roomSlotNameForBed("pickup_bed"), "pickup_room");
  assert.equal(roomSlotNameForBed("destination_bed"), "destination_room");
  assert.equal(roomSlotNameForBed("bed"), "room");
  assert.equal(roomSlotNameForBed("bed_number"), "room_number");
  assert.equal(roomSlotNameForBed("pickup_bed_number"), "pickup_room_number");
  // Not a bed slot at all.
  assert.equal(roomSlotNameForBed("pickup_room"), null);
  assert.equal(roomSlotNameForBed("patient_name"), null);
  // "bedside" / "embed" must not be treated as bed slots.
  assert.equal(isBedSlotName("bedside_phone"), false);
  assert.equal(isBedSlotName("embed_code"), false);
  assert.equal(isRoomSlotName("pickup_room"), true);
  assert.equal(isRoomSlotName("roommate_name"), false);
});

const PICKUP_ITEMS = [
  { id: "i-room", type: "slot", slot_name: "pickup_room" },
  { id: "i-bed", type: "slot", slot_name: "pickup_bed" },
  { id: "i-phys", type: "slot", slot_name: "sending_physician" },
];

test("a not-applicable room resolves its paired bed", () => {
  const resolved = bedSlotsToResolve({
    items: PICKUP_ITEMS,
    slotsFilled: { pickup_room: "N/A" },
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].item.slot_name, "pickup_bed");
  assert.equal(resolved[0].roomSlotName, "pickup_room");
});

test("a real room number leaves the bed open to be asked", () => {
  const resolved = bedSlotsToResolve({
    items: PICKUP_ITEMS,
    slotsFilled: { pickup_room: "302" },
  });
  assert.deepEqual(resolved, []);
});

test("an unasked room leaves the bed open — no inference before the room is resolved", () => {
  assert.deepEqual(bedSlotsToResolve({ items: PICKUP_ITEMS, slotsFilled: {} }), []);
});

test("a bed the caller actually answered is never overwritten", () => {
  const resolved = bedSlotsToResolve({
    items: PICKUP_ITEMS,
    slotsFilled: { pickup_room: "N/A", pickup_bed: "2" },
  });
  assert.deepEqual(resolved, []);
});

test("a skipped room resolves the bed even though the skip writes no value", () => {
  const resolved = bedSlotsToResolve({
    items: PICKUP_ITEMS,
    slotsFilled: {},
    noRoomSlotNames: ["pickup_room"],
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].item.slot_name, "pickup_bed");
  assert.equal(resolved[0].roomValue, null);
});

test("pickup and destination resolve independently", () => {
  const items = [
    { id: "p-room", type: "slot", slot_name: "pickup_room" },
    { id: "p-bed", type: "slot", slot_name: "pickup_bed" },
    { id: "d-room", type: "slot", slot_name: "destination_room" },
    { id: "d-bed", type: "slot", slot_name: "destination_bed" },
  ];
  // Scene pickup, but a real room at the receiving hospital.
  const resolved = bedSlotsToResolve({
    items,
    slotsFilled: { pickup_room: "none", destination_room: "414" },
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].item.slot_name, "pickup_bed");
});

/** Client that claims every guarded UPDATE (nothing raced us). */
function winningClient(queries) {
  return { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ item_id: params?.[3] }] }; } };
}

/** Client that claims nothing — something else answered the bed first. */
function losingClient(queries) {
  return { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
}

test("resolveInferredBeds writes the item status and fills the slot", async () => {
  const queries = [];
  const slotsFilled = { pickup_room: "N/A" };

  const resolved = await resolveInferredBeds({
    client: winningClient(queries),
    sessionId: "sess-1",
    items: PICKUP_ITEMS,
    slotsFilled,
  });

  assert.equal(resolved.length, 1);
  assert.equal(slotsFilled.pickup_bed, NO_BED_VALUE);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /UPDATE aa_workflow_item_status/);
  assert.match(queries[0].sql, /status = 'completed'/);
  // clock_timestamp(), not NOW() — the analyzer batches many utterances in one
  // transaction and its bleed guard compares against real completion times.
  assert.match(queries[0].sql, /clock_timestamp\(\)/);
  assert.deepEqual(queries[0].params, [INFERRED_BY, NO_BED_VALUE, "sess-1", "i-bed"]);
});

test("the write is guarded so a concurrently-answered bed is never overwritten", async () => {
  const queries = [];
  await resolveInferredBeds({
    client: winningClient(queries),
    sessionId: "s",
    items: PICKUP_ITEMS,
    slotsFilled: { pickup_room: "N/A" },
  });
  // The in-memory check is a snapshot; the analyzer runs concept groups
  // concurrently on separate connections, so the statement itself must refuse
  // a row that is no longer open or has since acquired a value.
  assert.match(queries[0].sql, /status IN \('pending', 'suggested'\)/);
  assert.match(queries[0].sql, /extracted_value IS NULL OR extracted_value = ''/);
  assert.match(queries[0].sql, /RETURNING item_id/);
});

test("losing the race leaves the caller's real bed alone", async () => {
  const queries = [];
  const slotsFilled = { pickup_room: "N/A" };

  const resolved = await resolveInferredBeds({
    client: losingClient(queries),
    sessionId: "s",
    items: PICKUP_ITEMS,
    slotsFilled,
  });

  assert.equal(queries.length, 1, "it still attempts the guarded write");
  assert.deepEqual(resolved, [], "but reports nothing resolved");
  assert.equal(
    slotsFilled.pickup_bed,
    undefined,
    "and must not claim a value it did not actually write",
  );
});

test("resolveInferredBeds is idempotent — a second pass is a no-op", async () => {
  const queries = [];
  const slotsFilled = { pickup_room: "N/A" };
  const args = { client: winningClient(queries), sessionId: "sess-1", items: PICKUP_ITEMS, slotsFilled };

  await resolveInferredBeds(args);
  await resolveInferredBeds(args);

  assert.equal(queries.length, 1, "the bed already holds a value on the second pass");
});

test("resolveInferredBeds accepts rows keyed by either id or item_id", async () => {
  const queries = [];
  // The analyzer's query aliases the id as item_id; the manual routes select id.
  const resolved = await resolveInferredBeds({
    client: winningClient(queries),
    sessionId: "s",
    items: [{ item_id: "aliased-bed", type: "slot", slot_name: "pickup_bed" }],
    slotsFilled: { pickup_room: "none" },
  });
  assert.equal(queries[0].params[3], "aliased-bed");
  assert.equal(resolved[0].itemId, "aliased-bed");
});

test("the suggested-response panel stops targeting the bed once it is resolved", () => {
  const stages = [{
    id: "stage-pickup",
    name: "Pickup Information",
    order_index: 0,
    items: [
      { id: "i-room", type: "slot", label: "Pickup Facility Room", slot_name: "pickup_room", order_index: 3 },
      { id: "i-bed", type: "slot", label: "Pickup Facility Bed Number", slot_name: "pickup_bed", order_index: 4 },
      { id: "i-phys", type: "slot", label: "Name of Sending Physician", slot_name: "sending_physician", order_index: 5 },
    ],
  }];
  const itemStatuses = { "i-room": { status: "completed", extracted_value: "N/A" } };

  // Before the inference: the panel would ask for the bed next.
  const beforeTarget = resolveSuggestedResponseTarget({
    stages,
    itemStatuses,
    slotsFilled: { pickup_room: "N/A" },
    transcriptions: [],
  });
  assert.equal(beforeTarget?.item?.slot_name, "pickup_bed");

  // After: the bed carries the inferred value, so the panel advances past it.
  const afterTarget = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: { ...itemStatuses, "i-bed": { status: "completed", extracted_value: NO_BED_VALUE } },
    slotsFilled: { pickup_room: "N/A", pickup_bed: NO_BED_VALUE },
    transcriptions: [],
  });
  assert.equal(afterTarget?.item?.slot_name, "sending_physician");
});

test("the analyzer runs the inference after completions land, and reports it in the delta", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(route, /import \{ resolveInferredBeds, NO_BED_VALUE, INFERRED_BY \}/);
  // Scoped to still-open items so a bed the caller answered is never touched.
  assert.match(route, /resolveInferredBeds\(\{[\s\S]{0,200}items: allPendingItems/);
  // The client needs the inferred bed in the same response, or the panel would
  // keep asking for it until the next analyze call.
  assert.match(route, /slotsDelta\[bedItem\.slot_name\] = NO_BED_VALUE/);
  assert.match(route, /completed_by: INFERRED_BY/);
});

test("the manual routes infer too: agent-entered N/A room, and a skipped room", async () => {
  const complete = await read("../app/api/agent-assist/workflow/item/[id]/complete/route.js");
  assert.match(complete, /resolveInferredBeds/);
  // Must mutate slotsFilled BEFORE the session write, or the bed is lost.
  const inferIndex = complete.indexOf("resolveInferredBeds({");
  const writeIndex = complete.indexOf("SET slots_filled = COALESCE");
  assert.ok(inferIndex > -1 && writeIndex > inferIndex, "inference must precede the slots_filled write");

  const skip = await read("../app/api/agent-assist/workflow/item/[id]/skip/route.js");
  assert.match(skip, /isRoomSlotName\(item\.slot_name\)/);
  assert.match(skip, /noRoomSlotNames: \[item\.slot_name\]/);
});

test("the manual routes merge their slot delta instead of replacing the snapshot", async () => {
  // workflowSession.slots_filled is read before the request does anything, so
  // writing the whole object back deletes any slot a concurrent analyze call
  // captured meanwhile. Both routes use the same atomic jsonb merge the
  // analyze route already relies on for overlapping requests.
  for (const path of [
    "../app/api/agent-assist/workflow/item/[id]/complete/route.js",
    "../app/api/agent-assist/workflow/item/[id]/skip/route.js",
  ]) {
    const route = await read(path);
    assert.match(
      route,
      /SET slots_filled = COALESCE\(slots_filled, '\{\}'::jsonb\) \|\| \$1::jsonb/,
      `${path} must merge, not replace`,
    );
    assert.doesNotMatch(route, /SET slots_filled = \$1,/, `${path} must not clobber the whole object`);
  }
});

test("inferred beds reach the live store, so the panel stops asking immediately", async () => {
  // Without this the resolver sees the bed as pending with no value and
  // re-asks for it until the next analysis or a session refresh.
  for (const path of [
    "../app/api/agent-assist/workflow/item/[id]/complete/route.js",
    "../app/api/agent-assist/workflow/item/[id]/skip/route.js",
  ]) {
    const route = await read(path);
    assert.match(route, /inferredUpdates/, `${path} must return the updates`);
    assert.match(route, /slot_name: bedItem\.slot_name/, `${path} must carry the slot name`);
    assert.match(route, /extracted_value: NO_BED_VALUE/, `${path} must carry the value`);
  }

  const store = await read("../lib/stores/workflow-store.js");
  assert.match(store, /applyInferredUpdates:/);
  // Both the status AND the slot value must land — the resolver keys "closed"
  // off the slot value, not the item status.
  assert.match(store, /updateItemStatus\(update\.item_id/);
  assert.match(store, /updateSlot\(update\.slot_name, update\.extracted_value\)/);
  // Wired into both manual actions.
  assert.match(store, /get\(\)\.applyInferredUpdates\(data\.inferredUpdates\)[\s\S]{0,400}completeItem:completion/);
  assert.match(store, /completed_by: "agent",\s*\}\);\s*\n\s*get\(\)\.applyInferredUpdates\(data\.inferredUpdates\);/);
});

test("an inferred value is labelled as such, not as AI or agent work", async () => {
  for (const path of [
    "../components/contact-center/AgentAssistWorkflow.jsx",
    "../components/contact-center/WorkflowHistoryView.jsx",
  ]) {
    const cmp = await read(path);
    assert.match(cmp, /completedBy === "inferred"/, `${path} must recognise the marker`);
    assert.match(cmp, /Inferred/, `${path} must label it`);
  }
});
