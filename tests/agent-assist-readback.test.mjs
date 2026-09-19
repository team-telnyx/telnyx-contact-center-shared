import test from "node:test";
import assert from "node:assert/strict";

import {
  isReadBackItem,
  buildReadBackSuggestion,
  orderedSlotsFromMap,
  humanizeSlotName,
  earliestReadBackItemId,
  isTransportIntake,
} from "../lib/agent-assist/readback.mjs";

test("isReadBackItem matches finalization confirm/read-back items", () => {
  // The air-transport workflow's confirmation item (label alone is enough).
  assert.equal(isReadBackItem({ itemType: "question", itemLabel: "Confirm all information is correct" }), true);
  // Detected via prompt_hint / hints too.
  assert.equal(
    isReadBackItem({
      itemType: "action",
      itemLabel: "Read back transport details",
      itemPromptHint: "let me confirm, read back, verify details",
    }),
    true
  );
  assert.equal(
    isReadBackItem({ itemType: "question", itemLabel: "Verify the details", itemHints: ["make sure everything is right"] }),
    true
  );
});

test("isReadBackItem does NOT fire for slots or mid-flow items", () => {
  // Slots never read back.
  assert.equal(isReadBackItem({ itemType: "slot", itemLabel: "Confirm all information is correct" }), false);
  // A bare "summarize" mid-flow item must not trigger a premature read-back.
  assert.equal(isReadBackItem({ itemType: "action", itemLabel: "Summarize their needs" }), false);
  assert.equal(isReadBackItem({ itemType: "action", itemLabel: "Summarize the issue back to customer" }), false);
  // Ordinary items.
  assert.equal(isReadBackItem({ itemType: "question", itemLabel: "Ask how to assist today" }), false);
  assert.equal(isReadBackItem({ itemType: "action", itemLabel: "Thank caller and close" }), false);
});

test("humanizeSlotName turns snake_case into a readable label", () => {
  assert.equal(humanizeSlotName("patient_name"), "Patient Name");
  assert.equal(humanizeSlotName("date_of_birth"), "Date Of Birth");
  assert.equal(humanizeSlotName("pickup-facility"), "Pickup Facility");
});

test("orderedSlotsFromMap drops empties, keeps boolean false as No, humanizes keys, prefers labels", () => {
  const out = orderedSlotsFromMap(
    { patient_name: "Jane Doe", date_of_birth: "", accompanying: false, caller_name: "  Bob  " },
    { patient_name: "Patient full name" }
  );
  assert.deepEqual(out, [
    { label: "Patient full name", value: "Jane Doe" },
    // date_of_birth dropped (empty); accompanying=false is a real captured value -> "No".
    { label: "Accompanying", value: "No" },
    { label: "Caller Name", value: "Bob" },
  ]);
});

test("buildReadBackSuggestion reads back EVERY slot (not truncated) and asks to confirm", () => {
  const orderedSlots = [
    { label: "Caller name", value: "Bob" },
    { label: "Pickup facility", value: "Summit Hospital" },
    { label: "Patient full name", value: "Jane Doe" },
    { label: "Date of birth", value: "1988-03-04" },
  ];
  const line = buildReadBackSuggestion({ orderedSlots });
  // Every collected value is present — the whole intake, not a 2-sentence cap.
  for (const { label, value } of orderedSlots) {
    assert.match(line, new RegExp(label));
    assert.match(line, new RegExp(value));
  }
  // Asks the caller to confirm / offers to change.
  assert.match(line, /correct/i);
  assert.match(line, /change/i);
});

test("buildReadBackSuggestion returns null when nothing was collected", () => {
  assert.equal(buildReadBackSuggestion({ orderedSlots: [] }), null);
  assert.equal(buildReadBackSuggestion({ orderedSlots: [{ label: "X", value: "" }] }), null);
  assert.equal(buildReadBackSuggestion({}), null);
});

test("buildReadBackSuggestion (transport intake) speaks the the reference workflow narrative confirmation sentence", () => {
  // Requested format (the reference workflow, Aug 12 — supersedes the earlier compact
  // 'Title: value' checklist): one narrative sentence with a formatted DOB,
  // the weight carrying its unit conversion, reason, IV/companion details,
  // notes, and the EMS contact in the 3-3-4 display mask. Addresses, caller
  // identity, intent and the safety booleans stay out.
  const rawSlots = {
    patient_name: "Marcus Webb",
    patient_dob: "1958-06-15",
    patient_weight: "198 lbs",
    pickup_facility: "Maplewood Regional Medical Center",
    pickup_department: "Emergency Department",
    destination_facility: "Riverside Medical",
    destination_department: "Cath Lab",
    transport_reason: "STEMI Alert",
    iv_count: 2,
    accompanying: true,
    trip_notes: "STEMI patient. Aspirin given, heparin drip running. Wife accompanying.",
    callback_number: "9405550192",
    // Fields that must NOT appear:
    pickup_address: "123 Main St",
    destination_address: "456 Oak Ave",
    weather_declined: false,
    other_aircraft: false,
    caller_first_name: "Alex",
    caller_facility: "Summit Hospital",
    intent: "request_new_transport",
  };
  const line = buildReadBackSuggestion({ rawSlots });

  assert.equal(
    line,
    "We're transferring Marcus Webb, DOB Jun 15, 1958, 198 lbs (90 kg) — " +
      "from Maplewood Regional Medical Center, Emergency Department to Riverside Medical, Cath Lab — " +
      "reason: STEMI Alert. 2 IV drip(s), companion: Yes. " +
      "Notes: STEMI patient. Aspirin given, heparin drip running. Wife accompanying. " +
      "EMS contact: 940-555-0192."
  );

  assert.doesNotMatch(line, /Main St/);
  assert.doesNotMatch(line, /Oak Ave/);
  assert.doesNotMatch(line, /aircraft|weather/i);
  assert.doesNotMatch(line, /Sarah/);
  assert.doesNotMatch(line, /Summit Hospital/);
  assert.doesNotMatch(line, /request_new_transport|request new transport/);
  // The raw unmasked digits never appear — only the 3-3-4 display form.
  assert.doesNotMatch(line, /9405550192/);
});

test("transport narrative: kg weights keep their unit primary, snake_case reasons humanize, rooms/beds join locations", () => {
  const line = buildReadBackSuggestion({
    rawSlots: {
      patient_name: "Jordan Rivera",
      patient_weight: "90 kg",
      pickup_facility: "Saint Mary's Hospital",
      pickup_department: "ICU",
      pickup_room: "412",
      pickup_bed: "B",
      destination_facility: "Lakeview Memorial Hospital",
      transport_reason: "cardiac_cath",
      transport_timing: "as_soon_as_possible",
      sending_physician: "Dr. Patel",
      special_equipment: "IV pump",
    },
  });
  assert.match(line, /90 kg \(198 lbs\)/);
  assert.match(line, /from Saint Mary's Hospital, ICU, room 412, bed B/);
  assert.match(line, /reason: Cardiac Cath\./);
  // Required scheduling detail is spoken (Codex 5th pass on #1367).
  assert.match(line, /timing: As Soon As Possible/);
  assert.match(line, /equipment: IV pump\./);
  assert.match(line, /Sending physician: Dr\. Patel\./);
});

test("buildReadBackSuggestion (transport intake): missing fragments are OMITTED, never spoken as N/A", () => {
  const rawSlots = {
    patient_name: "Jordan Rivera",
    // No patient_dob or weight.
    pickup_facility: "Saint Mary's Hospital",
    // No pickup_department/room/bed.
    pickup_bed: "N/A", // an inferred no-bed must not be spoken
    destination_facility: "Lakeview Memorial Hospital",
    destination_department: "Cardiac ICU",
    destination_room: "204",
    destination_bed: "A",
    // No reason, iv_count, companion, notes, physicians, equipment, callback.
  };
  const line = buildReadBackSuggestion({ rawSlots });

  assert.equal(
    line,
    "We're transferring Jordan Rivera — from Saint Mary's Hospital " +
      "to Lakeview Memorial Hospital, Cardiac ICU, room 204, bed A."
  );
  assert.doesNotMatch(line, /N\/A/);
  assert.doesNotMatch(line, /DOB/);
  assert.doesNotMatch(line, /reason/);
  assert.doesNotMatch(line, /companion/);
  assert.doesNotMatch(line, /Notes/);
  assert.doesNotMatch(line, /EMS contact/);
});

test("earliestReadBackItemId picks the FIRST read-back item so an adjacent confirm-all doesn't repeat it", () => {
  // Seeded air-transport Confirmation stage: read-back then confirm-all then submit.
  const items = [
    { id: "rb", type: "action", label: "Read back transport details", prompt_hint: "let me confirm, read back, verify details" },
    { id: "confirm", type: "question", label: "Confirm all information is correct", prompt_hint: "is that correct, anything to change, accurate" },
    { id: "submit", type: "action", label: "Submit transport request", prompt_hint: "submitting, creating request" },
  ];
  // Only the read-back item recites the list; the confirm-all item does not.
  assert.equal(earliestReadBackItemId(items), "rb");
});

test("earliestReadBackItemId returns the confirm-all item when it is the only read-back item", () => {
  // The 24-RFI air-transport workflow: no separate read-back item, so the
  // confirm-all item IS the one that reads back (issue #7).
  const items = [
    { id: "confirm", type: "question", label: "Confirm all information is correct", prompt_hint: "let me read back, confirm everything is correct" },
    { id: "ref", type: "action", label: "Provide confirmation/reference number", prompt_hint: "confirmation number" },
    { id: "close", type: "action", label: "Thank caller and close", prompt_hint: "thank you for calling" },
  ];
  assert.equal(earliestReadBackItemId(items), "confirm");
});

test("earliestReadBackItemId returns null when no item matches", () => {
  const items = [
    { id: "a", type: "slot", label: "Patient name", prompt_hint: "patient name" },
    { id: "b", type: "action", label: "Thank caller and close", prompt_hint: "thank you" },
  ];
  assert.equal(earliestReadBackItemId(items), null);
  assert.equal(earliestReadBackItemId([]), null);
});

test("earliestReadBackItemId detects a read-back item identified ONLY by its hints (JSONB)", () => {
  // The route must SELECT i.hints for this to work: label/prompt_hint don't
  // match, only the hints array does. Otherwise the guard misses this item and
  // the following confirm-all would recite the list again.
  const items = [
    { id: "rb", type: "action", label: "Verify order", prompt_hint: "double check", hints: ["let me read back the details"] },
    { id: "confirm", type: "question", label: "Confirm all information is correct", prompt_hint: "accurate" },
  ];
  assert.equal(earliestReadBackItemId(items), "rb");
});

test("generate-suggestion route SELECTs i.hints when finding the earliest read-back item", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(
    new URL("../app/api/agent-assist/workflow/generate-suggestion/route.js", import.meta.url),
    "utf8"
  );
  // hints must be in the projection so isReadBackItem sees hints-only matches.
  assert.match(route, /SELECT i\.id, i\.type, i\.label, i\.prompt_hint, i\.hints/);
});

// Codex review: buildTransportReadBack's compact multi-line format has no
// trailing question (unlike the generic branch of buildReadBackSuggestion,
// which always asks one itself) — when a transport workflow has no separate
// "Read back transport details" ACTION, the customer-facing "Confirm all
// information is correct" QUESTION item IS the earliest read-back item,
// serving both recitation and confirmation at once. Without an appended
// question, nothing in the suggested text prompts the customer to give the
// affirmative that completes that exact item.
test("generate-suggestion route appends a confirmation question for a TRANSPORT read-back QUESTION item (no separate recitation action)", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(
    new URL("../app/api/agent-assist/workflow/generate-suggestion/route.js", import.meta.url),
    "utf8"
  );
  assert.match(route, /import \{ isReadBackItem, buildReadBackSuggestion, orderedSlotsFromMap, formatSlotValue, earliestReadBackItemId, isTransportIntake \}/);
  assert.match(
    route,
    /const needsConfirmationAsk = isTransportIntake\(prefilledSlots \|\| \{\}\) && itemType !== "action";/
  );
  assert.match(
    route,
    /const suggestion = needsConfirmationAsk\s*\n\s*\? `\$\{readBack\}\\nIs all of that correct, or is there anything you'd like to change\?`\s*\n\s*: readBack;/
  );
});

test("isTransportIntake is exported so callers can tell which buildReadBackSuggestion branch fired", () => {
  assert.equal(isTransportIntake({ patient_name: "Jordan Rivera" }), true);
  assert.equal(isTransportIntake({ pickup_facility: "Saint Mary's Hospital" }), true);
  assert.equal(isTransportIntake({ destination_facility: "Lakeview Memorial" }), true);
  assert.equal(isTransportIntake({ caller_first_name: "Alex" }), false);
  assert.equal(isTransportIntake({}), false);
});
