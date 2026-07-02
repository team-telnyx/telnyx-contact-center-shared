import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("FDE-535 frontend: workflow-store applyAiHandoffData normalizes slotDetail.alternatives to an array on item status", async () => {
  const storeSource = await source("../lib/stores/workflow-store.js");

  // The applyAiHandoffData block builds newStatuses[item.id] with extracted_value,
  // confidence_score, etc. It must also set alternatives defensively as an array
  // so downstream UI always sees a stable shape even for un-synced workflows.
  assert.match(
    storeSource,
    /alternatives:\s*Array\.isArray\(slotDetail\?\.alternatives\)\s*\?\s*slotDetail\.alternatives\s*:\s*\[\]/
  );
});

test("FDE-535 frontend: WorkflowStagesCard renders alternatives chips only when low-confidence AND alternatives exist", async () => {
  const workflowSource = await source("../components/contact-center/AgentAssistWorkflow.jsx");

  // Conditional render guards against low-confidence + non-empty alternatives array.
  assert.match(
    workflowSource,
    /isLowConfidence && Array\.isArray\(status\.alternatives\) && status\.alternatives\.length > 0/
  );
});

test("FDE-535 frontend: each alternative chip maps over status.alternatives and calls handleConfirmSuggestedSlot with alt.value", async () => {
  const workflowSource = await source("../components/contact-center/AgentAssistWorkflow.jsx");

  // The chips are rendered by mapping over status.alternatives (alt, altIdx) and
  // each chip's onClick reuses the existing handleConfirmSuggestedSlot handler.
  assert.match(workflowSource, /status\.alternatives\.map\(\(alt, altIdx\)/);
  assert.match(workflowSource, /handleConfirmSuggestedSlot\(item\.id, alt\.value\)/);
});

test("FDE-535 frontend: each alternative chip displays value and rounded confidence percentage", async () => {
  const workflowSource = await source("../components/contact-center/AgentAssistWorkflow.jsx");

  // Chips show the alt.value plus a rounded confidence percentage derived from alt.confidence.
  assert.match(workflowSource, /\{alt\.value\}/);
  assert.match(workflowSource, /Math\.round\(\(alt\.confidence \?\? 0\) \* 100\)/);
  // The chip title conveys the alternative confidence as a percentage.
  assert.match(
    workflowSource,
    /Use this alternative \(\$\{Math\.round\(\(alt\.confidence \?\? 0\) \* 100\)\}% confidence\)/
  );
});

test("FDE-535 frontend regression guard: the existing Confirm-this-low-confidence-LLM-value button is retained", async () => {
  const workflowSource = await source("../components/contact-center/AgentAssistWorkflow.jsx");

  // The new alternatives chips must coexist with the original Confirm button
  // (which confirms the current slotValue). Do not remove it.
  assert.match(workflowSource, /Confirm this low-confidence LLM value/);
  assert.match(workflowSource, /handleConfirmSuggestedSlot\(item\.id, slotValue\)/);
});
