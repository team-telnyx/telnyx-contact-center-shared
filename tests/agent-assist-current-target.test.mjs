import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildWorkflowAnalysisSystemPrompt } from "../lib/agent-assist/workflow-prompts.js";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const PENDING = [
  { item_id: "d", type: "slot", label: "Destination facility name", slot_name: "destination_facility", slot_type: "text", completion_trigger: "customer", stage_name: "Destination" },
  { item_id: "p", type: "slot", label: "Patient full name", slot_name: "patient_name", slot_type: "text", completion_trigger: "customer", stage_name: "Patient Information" },
];
const FOCUS = { label: "Destination facility name", slotName: "destination_facility" };

test("prompt includes a Current Collection Focus section naming the current slot", () => {
  const prompt = buildWorkflowAnalysisSystemPrompt({ pendingItems: PENDING, slotsFilled: {}, currentTarget: FOCUS });
  assert.match(prompt, /## Current Collection Focus/);
  assert.match(prompt, /Destination facility name/);
  assert.match(prompt, /destination_facility/);
});

test("focus section carries the facility-vs-person-name disambiguation (the reported bug)", () => {
  const prompt = buildWorkflowAnalysisSystemPrompt({ pendingItems: PENDING, slotsFilled: {}, currentTarget: FOCUS });
  // A mis-heard destination hospital must not land in a patient-name slot.
  assert.match(prompt, /NOT a patient-name/i);
  assert.match(prompt, /John Muir/);
});

test("focus is a tie-breaker, not a hard filter — clearly volunteered values still captured", () => {
  const prompt = buildWorkflowAnalysisSystemPrompt({ pendingItems: PENDING, slotsFilled: {}, currentTarget: FOCUS });
  assert.match(prompt, /tie-breaker/i);
  assert.match(prompt, /volunteers/i);
});

test("prompt omits the focus section when no current target is provided", () => {
  const prompt = buildWorkflowAnalysisSystemPrompt({ pendingItems: PENDING, slotsFilled: {} });
  assert.doesNotMatch(prompt, /## Current Collection Focus/);
  // A blank/label-less target also yields no section.
  const blank = buildWorkflowAnalysisSystemPrompt({ pendingItems: PENDING, slotsFilled: {}, currentTarget: { label: "", slotName: "" } });
  assert.doesNotMatch(blank, /## Current Collection Focus/);
});

test("analyzer threads currentTarget into the system prompt", async () => {
  const analyzer = await read("../lib/agent-assist/workflow-analyzer.js");
  assert.match(analyzer, /currentTarget = null,/);
  assert.match(analyzer, /buildWorkflowAnalysisSystemPrompt\(\{[\s\S]*?currentTarget,/);
});

test("live + test analyze routes compute and pass the current-target slot", async () => {
  const live = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // Current target = earliest still-open OR still-unconfirmed ("suggested")
  // slot — a low-confidence capture isn't confirmed yet, and treating it as
  // "moved on" let a bare repeat/clarification of it get misattributed to
  // whatever slot comes next (reported live: a repeated sending-physician
  // name bled into receiving_physician once sending_physician was merely
  // "suggested", not yet confirmed).
  assert.match(
    live,
    /i\.type === "slot" && \(i\.current_status === "pending" \|\| i\.current_status === "suggested"\)/
  );
  assert.match(live, /analyzeWorkflowTranscript\(\{[\s\S]*?currentTarget,/);
  const testRoute = await read("../app/api/admin/workflows/[id]/analyze-test/route.js");
  assert.match(testRoute, /const currentTarget =/);
  assert.match(testRoute, /analyzeWorkflowTranscript\(\{[\s\S]*?currentTarget,/);
});
