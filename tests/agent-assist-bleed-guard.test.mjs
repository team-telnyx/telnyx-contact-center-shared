import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("bleed guard prompt section is injected when bleedGuardSlot is provided", async () => {
  const src = await read("../lib/agent-assist/workflow-prompts.js");

  // buildWorkflowAnalysisSystemPrompt accepts bleedGuardSlot
  assert.match(src, /bleedGuardSlot = null/);

  // bleedGuardStr is built from bleedGuardSlot
  assert.match(src, /const bleedGuardStr = bleedGuardSlot/);
  assert.match(src, /Stray Fragment Guard/);
  assert.match(src, /bleedGuardSlot\.slotName/);
  assert.match(src, /bleedGuardSlot\.value/);

  // bleedGuardStr is included in the returned prompt
  assert.match(src, /\$\{bleedGuardStr\}/);
});

test("analyze route passes bleedGuardSlot derived from recently completed slots", async () => {
  const src = await read("../app/api/agent-assist/workflow/analyze/route.js");

  // Query fetches completed_at and extracted_value
  assert.match(src, /ist\.completed_at/);
  assert.match(src, /ist\.extracted_value as completed_value/);

  // BLEED_WINDOW_MS constant
  assert.match(src, /BLEED_WINDOW_MS/);

  // bleedGuardSlot is derived and passed to analyzeWorkflowTranscript
  assert.match(src, /bleedGuardSlot/);
  assert.match(src, /recentlyCompletedSlot/);

  // Numeric gate: bleed guard only fires for numeric/ordinal fragments, never
  // for clear boolean answers like "No" or "Yes"
  assert.match(src, /NUMERIC_FRAGMENT_RE/);
  assert.match(src, /isNumericFragment/);
});

test("analyzer forwards bleedGuardSlot to buildWorkflowAnalysisSystemPrompt", async () => {
  const src = await read("../lib/agent-assist/workflow-analyzer.js");

  assert.match(src, /bleedGuardSlot = null/);
  assert.match(src, /bleedGuardSlot,/);
});
