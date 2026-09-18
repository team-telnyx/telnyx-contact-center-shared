import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { computeConceptGroups, classifyUtteranceGroup } from "../lib/agent-assist/concept-groups.mjs";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Fixture mirrors the real the reference workflow healthcare intake workflow's structure closely
// enough to exercise the grouping logic: pickup/destination share paired slot
// concepts (room, bed, facility, address, department), caller-identity and
// patient-info stages don't share anything with those or each other.
function row(itemId, stageName, slotName, label, promptHint) {
  return { item_id: itemId, slot_name: slotName, label, prompt_hint: promptHint, hints: null, stage_name: stageName };
}

const workflowRows = [
  row("greet", "Caller Identification", null, "Greet caller with brand name", "hello, thank you for calling"),
  row("ask-help", "Caller Identification", null, "Ask how to assist today", "how can I help, what can I do"),
  row("intent", "Caller Identification", "intent", "Call intent", "new transport, request flight"),
  row("caller-first", "Caller Identification", "caller_first_name", "Caller First Name", "my name is, first name"),
  row("caller-last", "Caller Identification", "caller_last_name", "Caller Last Name", "last name"),
  row("caller-facility", "Caller Identification", "caller_facility", "Caller Facility Name", "calling from, hospital"),
  row("callback", "Caller Identification", "callback_number", "Callback Number", "callback, phone number"),

  row("pickup-facility", "Pickup Location", "pickup_facility", "Pickup Facility Name", "pickup from, origin"),
  row("pickup-address", "Pickup Location", "pickup_address", "Pickup Facility Address", "address, street"),
  row("pickup-department", "Pickup Location", "pickup_department", "Pickup Department", "department, unit"),
  row("pickup-room", "Pickup Location", "pickup_room", "Pickup Room", "room number"),
  row("pickup-bed", "Pickup Location", "pickup_bed", "Pickup Bed", "bed letter"),
  row("sending-physician", "Pickup Location", "sending_physician", "Sending Physician", "doctor, physician"),

  row("dest-facility", "Destination", "destination_facility", "Destination Facility Name", "going to, destination"),
  row("dest-address", "Destination", "destination_address", "Destination Facility Address", "address, street"),
  row("dest-department", "Destination", "destination_department", "Destination Department", "department, unit"),
  row("dest-room", "Destination", "destination_room", "Destination Room", "room number"),
  row("dest-bed", "Destination", "destination_bed", "Destination Bed", "bed letter"),
  row("receiving-physician", "Destination", "receiving_physician", "Receiving Physician", "doctor, physician"),

  row("patient-name", "Patient Information", "patient_name", "Patient Name", "patient name, full name"),
  row("patient-dob", "Patient Information", "patient_dob", "Patient DOB", "date of birth, birthday"),
  row("patient-weight", "Patient Information", "patient_weight", "Patient Weight", "weight, pounds, kg"),
];

test("computeConceptGroups merges Pickup Location and Destination into ONE group (they share paired baseSlotKeys)", () => {
  const { itemGroup } = computeConceptGroups(workflowRows);
  const pickupGroup = itemGroup.get("pickup-room");
  const destGroup = itemGroup.get("dest-room");
  assert.equal(pickupGroup, destGroup, "pickup and destination must resolve to the SAME concept group");

  // Every pickup/destination item shares that one merged group.
  for (const id of ["pickup-facility", "pickup-address", "pickup-department", "pickup-room", "pickup-bed", "sending-physician",
                     "dest-facility", "dest-address", "dest-department", "dest-room", "dest-bed", "receiving-physician"]) {
    assert.equal(itemGroup.get(id), pickupGroup, `${id} must be in the merged location group`);
  }
});

test("computeConceptGroups keeps Caller Identification and Patient Information as SEPARATE groups (no shared baseSlotKey)", () => {
  const { itemGroup } = computeConceptGroups(workflowRows);
  const identityGroup = itemGroup.get("caller-first");
  const patientGroup = itemGroup.get("patient-name");
  const locationGroup = itemGroup.get("pickup-room");

  assert.notEqual(identityGroup, patientGroup);
  assert.notEqual(identityGroup, locationGroup);
  assert.notEqual(patientGroup, locationGroup);

  // Non-slot items (greet, ask-help) still get assigned to their own stage's group.
  assert.equal(itemGroup.get("greet"), identityGroup);
  assert.equal(itemGroup.get("ask-help"), identityGroup);
});

test("computeConceptGroups builds groupItemIds sets usable as scopeItemIds", () => {
  const { itemGroup, groupItemIds } = computeConceptGroups(workflowRows);
  const locationGroup = itemGroup.get("pickup-room");
  const idsInGroup = groupItemIds.get(locationGroup);
  assert.ok(idsInGroup.has("pickup-room"));
  assert.ok(idsInGroup.has("dest-bed"));
  assert.ok(!idsInGroup.has("patient-name"));
  assert.ok(!idsInGroup.has("caller-first"));
});

test("classifyUtteranceGroup picks the location group for pickup/destination-flavored text", () => {
  const { itemGroup, groupHintTokens } = computeConceptGroups(workflowRows);
  const locationGroup = itemGroup.get("pickup-room");
  const group = classifyUtteranceGroup(
    "The pickup facility address is 123 Main Street, department ICU, room 412, bed A, doctor Patel",
    groupHintTokens
  );
  assert.equal(group, locationGroup);
});

test("classifyUtteranceGroup picks the patient-info group for DOB/weight-flavored text", () => {
  const { itemGroup, groupHintTokens } = computeConceptGroups(workflowRows);
  const patientGroup = itemGroup.get("patient-name");
  const group = classifyUtteranceGroup("The patient's date of birth is March 12th and weight is 180 pounds", groupHintTokens);
  assert.equal(group, patientGroup);
});

test("classifyUtteranceGroup returns null for a bare, ambiguous fragment (caller must inherit the preceding utterance's group)", () => {
  const { groupHintTokens } = computeConceptGroups(workflowRows);
  assert.equal(classifyUtteranceGroup("412", groupHintTokens), null);
  assert.equal(classifyUtteranceGroup("yes", groupHintTokens), null);
  assert.equal(classifyUtteranceGroup("", groupHintTokens), null);
});

// Source-level checks for the parts of the POST handler that aren't unit-
// testable in isolation (DB-dependent branching/scoping wiring).
test("POST handler classifies the batch into groups and branches: single group stays sequential, multiple groups run concurrently", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");

  assert.match(route, /import \{ computeConceptGroups, classifyUtteranceGroup \} from "@\/lib\/agent-assist\/concept-groups\.mjs";/);
  assert.match(route, /const \{ itemGroup, groupItemIds, groupHintTokens \} = computeConceptGroups\(allWorkflowItemRows\);/);
  assert.match(route, /const classifiedGroupKey = classifyUtteranceGroup\(item\.transcript, groupHintTokens\);/);
  assert.match(route, /const groupKey = classifiedGroupKey \|\| inheritedGroupKey \|\| "unclassified";/);

  // Single-group path: sequential, shares the outer client/transaction — no
  // scopeItemIds passed (unscoped, exactly like the pre-grouping behavior).
  assert.match(route, /if \(groupKeyOrder\.length <= 1(\s*\|\|[^)]*)?\) \{/);

  // Multi-group path: concurrent via Promise.allSettled, one DB connection
  // per group (runConceptGroupBranch), passing that group's own scopeItemIds.
  // Bounded concurrency replaced the raw Promise.allSettled fan-out, but the
  // contract is unchanged: every group key is dispatched to its own branch and
  // one failure must not discard the others' results.
  assert.match(route, /allSettledWithConcurrency\(\s*\n?\s*groupKeyOrder,[\s\S]{0,200}?runConceptGroupBranch\(\{/);
  assert.match(route, /async function allSettledWithConcurrency\(/);
  assert.match(route, /allSettled/);
  assert.match(route, /scopeItemIds: groupItemIds\.get\(groupKey\) \|\| new Set\(\),/);
});

test("analyzeOneUtterance filters pendingItems by scopeItemIds when provided, but isReadBackStage/hasUnconfirmedSlot always use the unscoped allPendingItems", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");

  assert.match(
    route,
    /const pendingItems = scopeItemIds\s*\n\s*\? allPendingItems\.filter\(\(item\) => scopeItemIds\.has\(item\.item_id\)\)\s*\n\s*: allPendingItems;/
  );
  // Read-back readiness is a whole-workflow concept — must never be computed
  // from a concept-group-scoped view (a concurrent branch whose own group's
  // slots are done must not think read-back has been reached while ANOTHER
  // concurrently-running group still has open slots).
  assert.match(route, /const isReadBackStage =\s*\n\s*!allPendingItems\.some\(/);
  assert.match(route, /const hasUnconfirmedSlot = allPendingItems\.some\(\(p\) => p\.type === "slot"\);/);
});

test("runConceptGroupBranch runs its own utterances in a SEPARATE pool connection/transaction and merges its own slotsDelta atomically", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");

  assert.match(route, /async function runConceptGroupBranch\(\{/);
  assert.match(route, /(const|let) branchClient = await pool\.connect\(\);/);
  assert.match(route, /await branchClient\.query\("BEGIN"\);/);
  // The merge is one atomic jsonb concat of this branch's own delta. The
  // statement has since gained slots_version bumping; what must hold is that
  // the branch merges rather than overwrites, and writes only its own delta.
  const merge = route.match(
    /SET slots_filled = COALESCE\(slots_filled, '\{\}'::jsonb\) \|\| \$1::jsonb,[\s\S]{0,300}?\[JSON\.stringify\(branchSlotsDelta\), workflowSession\.id\]/
  );
  assert.ok(merge, "the branch must merge its own slotsDelta atomically");
  assert.match(merge[0], /WHERE id = \$2/);
  assert.match(merge[0], /slots_version = COALESCE\(slots_version, 0\) \+ 1/);
  assert.match(route, /await branchClient\.query\("COMMIT"\);/);
  // Failure isolation: one branch's rollback must not throw out of the
  // function — the caller uses Promise.allSettled so other groups' results
  // still make it into the response.
  assert.match(route, /return \{ updates: \[\], analysisResult: null, ok: false \};/);
});
