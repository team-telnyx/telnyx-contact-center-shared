import assert from "node:assert/strict";
import test from "node:test";

import {
  MEDICAL_TRANSPORT_SLOT_TEMPLATES,
  extractExplicitSuggestionScript,
  phraseSlotCollection,
  resolveFastSuggestionTemplate,
} from "../lib/agent-assist/suggestion-templates.mjs";

test("the reference workflow healthcare intake maps every known slot_name to a spoken line", () => {
  const required = [
    "caller_first_name",
    "callback_number",
    "pickup_facility",
    "patient_dob",
    "weather_declined",
    "other_aircraft",
    // Granular pickup/destination location fields (address, department, room,
    // bed) and sending/receiving physician — these already appear elsewhere
    // in the codebase (buildTransportReadBack in readback.mjs, various
    // resolver tests) as the live slot_name convention, even though earlier
    // versions of this template map only had a single combined
    // "pickup_location"/no-destination-breakdown entry.
    "pickup_address",
    "pickup_department",
    "pickup_room",
    "pickup_bed",
    "sending_physician",
    "destination_address",
    "destination_department",
    "destination_room",
    "destination_bed",
    "receiving_physician",
    "trip_notes",
  ];
  for (const key of required) {
    assert.ok(MEDICAL_TRANSPORT_SLOT_TEMPLATES[key], `missing template for ${key}`);
    assert.match(MEDICAL_TRANSPORT_SLOT_TEMPLATES[key], /\?$/);
  }
  // The old combined "pickup department or room" slot is gone now that the
  // granular pickup_department/pickup_room/pickup_bed fields cover the same
  // ground — keeping both was duplicated info on the same workflow.
  assert.equal(MEDICAL_TRANSPORT_SLOT_TEMPLATES.pickup_location, undefined);
});

test("explicit SAY: hint wins over slot_name map", () => {
  const text = resolveFastSuggestionTemplate({
    itemType: "slot",
    itemLabel: "Callback number",
    slotName: "callback_number",
    itemPromptHint: "SAY: Can I reach you at this number?",
  });
  assert.equal(text, "Can I reach you at this number?");
});

test("suggestionTemplate body field wins over SAY hint", () => {
  const text = resolveFastSuggestionTemplate({
    itemType: "slot",
    slotName: "callback_number",
    suggestionTemplate: "Please confirm your best callback number.",
    itemPromptHint: "SAY: ignored",
  });
  assert.equal(text, "Please confirm your best callback number.");
});

test("the reference workflow slot_name map is used when no explicit script is set", () => {
  const text = resolveFastSuggestionTemplate({
    itemType: "slot",
    itemLabel: "Caller's first name",
    slotName: "caller_first_name",
  });
  assert.equal(text, "May I have your first name?");
});

test("generic slot phrasing is used when slot_name is unknown", () => {
  const text = resolveFastSuggestionTemplate({
    itemType: "slot",
    itemLabel: "Patient date of birth",
    slotName: "custom_unknown_slot",
  });
  assert.equal(text, "Could you provide the patient's date of birth?");
});

test("confirm_slot mode skips the fast template path", () => {
  const text = resolveFastSuggestionTemplate({
    itemType: "slot",
    slotName: "callback_number",
    targetMode: "confirm_slot",
  });
  assert.equal(text, null);
});

test("phraseSlotCollection keeps full question labels verbatim", () => {
  assert.equal(
    phraseSlotCollection("Other aircraft currently responding?"),
    "Other aircraft currently responding?"
  );
});

test("extractExplicitSuggestionScript supports script: prefix", () => {
  assert.equal(
    extractExplicitSuggestionScript({ itemHints: ["script: Hello from dispatch."] }),
    "Hello from dispatch."
  );
});
