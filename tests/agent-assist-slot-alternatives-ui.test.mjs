import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("an earlier fix frontend: workflow-store applyAiHandoffData normalizes slotDetail.alternatives to an array on item status", async () => {
  const storeSource = await source("../lib/stores/workflow-store.js");

  // The applyAiHandoffData block builds newStatuses[item.id] with extracted_value,
  // confidence_score, etc. It must also set alternatives defensively as an array
  // so downstream UI always sees a stable shape even for un-synced workflows.
  assert.match(
    storeSource,
    /alternatives:\s*Array\.isArray\(slotDetail\?\.alternatives\)\s*\?\s*slotDetail\.alternatives\s*:\s*\[\]/
  );
});

test("an earlier fix frontend: alternatives chips render whenever a suggestion carries them", async () => {
  const workflowSource = await source("../components/contact-center/AgentAssistWorkflow.jsx");

  // Chips are gated on the suggestion actually having alternatives, NOT on LLM
  // confidence. An MCP lookup that matched several facilities fills no value and
  // carries no confidence score, so a confidence gate would hide precisely the
  // choices the agent needs to resolve.
  assert.match(
    workflowSource,
    /const hasAlternatives\s*=\s*\n?\s*isSuggested && Array\.isArray\(status\.alternatives\) && status\.alternatives\.length > 0;/,
  );
  assert.match(workflowSource, /\{hasAlternatives && \(/);
  assert.ok(
    !/\{isLowConfidence && Array\.isArray\(status\.alternatives\)/.test(workflowSource),
    "alternatives must not be gated on isLowConfidence",
  );

  // The low-confidence Confirm affordance is separate and stays.
  assert.match(workflowSource, /\{isLowConfidence && \(/);
});

test("an earlier fix frontend: each alternative chip maps over status.alternatives and calls handleConfirmSuggestedSlot with alt.value", async () => {
  const workflowSource = await source("../components/contact-center/AgentAssistWorkflow.jsx");

  // The chips are rendered by mapping over status.alternatives (alt, altIdx) and
  // each chip's onClick reuses the existing handleConfirmSuggestedSlot handler.
  assert.match(workflowSource, /status\.alternatives\.map\(\(alt, altIdx\)/);
  assert.match(workflowSource, /handleConfirmSuggestedSlot\(item\.id, alt\.value\)/);
});

test("an earlier fix frontend: each alternative chip displays its value and rounded confidence percentage", async () => {
  const workflowSource = await source("../components/contact-center/AgentAssistWorkflow.jsx");

  // Chips display alt.label when one is present, falling back to the formatted
  // value. LLM alternatives carry no label so they render exactly as before;
  // MCP lookup candidates carry a human-readable label because the raw value is
  // an opaque facility id.
  assert.match(workflowSource, /\{alt\.label \?\? formatSlotDisplay\(alt\.value, item\.slot_type\)\}/);

  // The percentage still comes from alt.confidence, now only when one was
  // supplied - an MCP lookup match is not a probability.
  assert.match(workflowSource, /Math\.round\(alt\.confidence \* 100\)/);
  assert.match(workflowSource, /alt\.confidence != null &&/);

  // The chip title still conveys confidence for alternatives that have it.
  assert.match(
    workflowSource,
    /Use this alternative \(\$\{Math\.round\(\(alt\.confidence \?\? 0\) \* 100\)\}% confidence\)/,
  );
});

test("an earlier fix frontend regression guard: the existing Confirm-this-low-confidence-LLM-value button is retained", async () => {
  const workflowSource = await source("../components/contact-center/AgentAssistWorkflow.jsx");

  // The new alternatives chips must coexist with the original Confirm button
  // (which confirms the current slotValue). Do not remove it.
  assert.match(workflowSource, /Confirm this low-confidence LLM value/);
  assert.match(workflowSource, /handleConfirmSuggestedSlot\(item\.id, slotValue\)/);
});
