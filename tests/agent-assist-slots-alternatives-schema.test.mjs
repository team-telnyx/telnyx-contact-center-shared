import test from "node:test";
import assert from "node:assert/strict";

import {
  generateSlotsSchema,
  generateSlotsInstructions,
} from "../lib/agent-assist/insight-schema-generator.js";

// Single slot used across assertions to keep the test focused on the
// `alternatives` extension required by FDE-535.
const SLOT = {
  slot_name: "caller_name",
  slot_type: "text",
  label: "Caller Name",
  description: "Name of the caller",
  hints: ["my name is", "I am"],
};

const WORKFLOW = { name: "Caller Intake", description: "Intake workflow" };

const STAGES = [
  {
    name: "Opening",
    items: [
      { ...SLOT, type: "slot" },
      {
        type: "slot",
        slot_name: "transport_reason",
        slot_type: "text",
        label: "Reason for transport",
      },
    ],
  },
];

test("generateSlotsSchema adds an `alternatives` array property to every slot, with required + additionalProperties preserved", () => {
  const schema = generateSlotsSchema([SLOT]);
  const slotProp = schema.properties.slots.properties.caller_name;

  // The new `alternatives` property exists and is typed as an array.
  assert.ok(slotProp.properties.alternatives, "alternatives property exists on slot");
  assert.equal(slotProp.properties.alternatives.type, "array");

  // Each item is an object with `value` (string) + `confidence` (number 0..1),
  // required listing both fields, and additionalProperties:false (Telnyx strict mode).
  const itemSchema = slotProp.properties.alternatives.items;
  assert.equal(itemSchema.type, "object");
  assert.deepEqual(itemSchema.required, ["value", "confidence"]);
  assert.equal(itemSchema.additionalProperties, false);
  assert.equal(itemSchema.properties.value.type, "string");
  assert.equal(itemSchema.properties.confidence.type, "number");
  assert.equal(itemSchema.properties.confidence.minimum, 0);
  assert.equal(itemSchema.properties.confidence.maximum, 1);

  // The slot's `required` array must include "alternatives" alongside the
  // existing fields (Telnyx requires required to list ALL properties).
  assert.ok(
    slotProp.required.includes("alternatives"),
    "alternatives is in the slot required array"
  );
  assert.ok(slotProp.required.includes("value"));
  assert.ok(slotProp.required.includes("confidence"));
  assert.ok(slotProp.required.includes("source_utterance"));
  assert.deepEqual(
    [...slotProp.required].sort(),
    ["alternatives", "confidence", "source_utterance", "value"],
    "slot required lists all four properties"
  );

  // additionalProperties must stay false (Telnyx Insights API strict requirement).
  assert.equal(slotProp.additionalProperties, false);

  // Root schema invariants are preserved.
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.slots.additionalProperties, false);
});

test("generateSlotsInstructions documents the alternatives rule and includes the alternatives key in both JSON examples", () => {
  const instructions = generateSlotsInstructions(WORKFLOW, STAGES);

  // Mentions the `alternatives` field by name.
  assert.match(instructions, /alternatives/i);

  // Empty array guidance for confident slots.
  assert.match(instructions, /empty array/i);
  assert.match(instructions, /\[\]/);

  // 2-3 candidate entries guidance for low-confidence slots.
  // Match either "2-3" or "2–3" (en dash) and mention of `{value, confidence}` shape.
  assert.match(instructions, /2.?[3]\b/);
  assert.match(instructions, /value.*confidence/i);

  // Both the found (`caller_name`) and not-found (`transport_reason`) JSON examples
  // must include the `alternatives` key. There should be at least two occurrences.
  const matches = instructions.match(/"alternatives"\s*:/g) || [];
  assert.ok(
    matches.length >= 2,
    `expected at least two "alternatives" keys in examples, found ${matches.length}`
  );
});

test("generateSlotsInstructions ties the alternatives cutoff to the workflow threshold (default 0.95), not a hardcoded 0.8", () => {
  // Default workflow (no llm_confidence_threshold) -> 0.95.
  const def = generateSlotsInstructions(WORKFLOW, STAGES);
  assert.match(def, />=\s*0\.95/, "empty-array cutoff uses the 0.95 default threshold");
  assert.match(def, /below the 0\.95 threshold/, "alternatives band references the threshold");
  // Must NOT ship the old hardcoded 0.8 cutoff, which left the 0.80–0.94
  // suggested band without alternative chips.
  assert.doesNotMatch(def, /high \(>=\s*0\.8\)/);
});

test("generateSlotsInstructions honors a custom workflow confidence threshold", () => {
  const custom = generateSlotsInstructions(
    { ...WORKFLOW, llm_confidence_threshold: 0.85 },
    STAGES
  );
  assert.match(custom, />=\s*0\.85/);
  assert.match(custom, /below the 0\.85 threshold/);
});

test("generateSlotsInstructions falls back to 0.95 for an invalid threshold", () => {
  for (const bad of [0, -1, 2, NaN, null, undefined, "high"]) {
    const out = generateSlotsInstructions(
      { ...WORKFLOW, llm_confidence_threshold: bad },
      STAGES
    );
    assert.match(out, />=\s*0\.95/, `threshold ${String(bad)} should fall back to 0.95`);
  }
});
