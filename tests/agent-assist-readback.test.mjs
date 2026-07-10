import test from "node:test";
import assert from "node:assert/strict";

import {
  isReadBackItem,
  buildReadBackSuggestion,
  orderedSlotsFromMap,
  humanizeSlotName,
  earliestReadBackItemId,
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
    { label: "Pickup facility", value: "Mercy Hospital" },
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
