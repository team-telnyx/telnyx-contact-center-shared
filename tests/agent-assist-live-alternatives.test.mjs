import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildWorkflowAnalysisSystemPrompt } from "../lib/agent-assist/workflow-prompts.js";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const PENDING = [{ item_id: "i1", type: "slot", label: "Dept", stage_name: "S", slot_name: "dept", slot_type: "text", completion_trigger: "either" }];

test("live analyze prompt requests alternatives (section + response format)", async () => {
  const prompt = await read("../lib/agent-assist/workflow-prompts.js");
  assert.match(prompt, /## Alternatives \(for low-confidence slots\)/);
  // Response format JSON includes the alternatives key.
  assert.match(prompt, /"alternatives":\s*\[\]/);
});

test("alternatives are requested against the workflow confidence threshold (not subjective)", () => {
  // Default threshold -> 0.95 in the prompt.
  const def = buildWorkflowAnalysisSystemPrompt({ pendingItems: PENDING, slotsFilled: {} });
  assert.match(def, /below 0\.95/);
  assert.match(def, />= 0\.95/);
  // Custom threshold flows through so a 0.9 slot under 0.95 still gets alternatives.
  const custom = buildWorkflowAnalysisSystemPrompt({ pendingItems: PENDING, slotsFilled: {}, confidenceThreshold: 0.7 });
  assert.match(custom, /below 0\.7/);
  assert.doesNotMatch(custom, /below 0\.95/);
  // Invalid threshold falls back to 0.95.
  const bad = buildWorkflowAnalysisSystemPrompt({ pendingItems: PENDING, slotsFilled: {}, confidenceThreshold: 2 });
  assert.match(bad, /below 0\.95/);
});

test("analyzer + both routes thread confidenceThreshold into the prompt", async () => {
  const analyzer = await read("../lib/agent-assist/workflow-analyzer.js");
  assert.match(analyzer, /confidenceThreshold = 0\.95,/);
  assert.match(analyzer, /buildWorkflowAnalysisSystemPrompt\(\{[\s\S]*?confidenceThreshold,/);
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(route, /analyzeWorkflowTranscript\(\{[\s\S]*?confidenceThreshold,/);
  const testRoute = await read("../app/api/admin/workflows/[id]/analyze-test/route.js");
  assert.match(testRoute, /analyzeWorkflowTranscript\(\{[\s\S]*?confidenceThreshold,/);
});

test("analyzer normalize passes alternatives through as {value, confidence}", async () => {
  const analyzer = await read("../lib/agent-assist/workflow-analyzer.js");
  assert.match(analyzer, /alternatives:\s*Array\.isArray\(item\.alternatives\)/);
  assert.match(analyzer, /value:\s*a\.value,\s*confidence:/);
});

test("live analyze route PERSISTS alternatives on the suggested branch (not NULL)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // The suggested UPDATE now binds a jsonb param instead of a hardcoded NULL.
  assert.match(route, /alternatives = \$7::jsonb/);
  // Built from completed.alternatives (non-empty -> stringified, else null).
  assert.match(route, /Array\.isArray\(completed\.alternatives\) && completed\.alternatives\.length > 0/);
  // Returned in updates[] for the client/UI.
  assert.match(route, /alternatives:\s*Array\.isArray\(completed\.alternatives\)\s*\?\s*completed\.alternatives\s*:\s*\[\]/);
});

test("analyze-test route returns alternatives for suggested slots", async () => {
  const route = await read("../app/api/admin/workflows/[id]/analyze-test/route.js");
  assert.match(route, /alternatives:\s*Array\.isArray\(completed\.alternatives\)\s*\?\s*completed\.alternatives\s*:\s*\[\]/);
});

test("analyzer scales the token budget with pending item count (no truncation on multi-slot)", async () => {
  const analyzer = await read("../lib/agent-assist/workflow-analyzer.js");
  assert.match(analyzer, /const maxTokens = Math\.min\(\s*4000,/s);
  assert.match(analyzer, /itemCount \* 150/);
  assert.match(analyzer, /max_tokens: maxTokens/);
  // The old fixed 500/800 cap must be gone.
  assert.doesNotMatch(analyzer, /max_tokens: includeIntent \|\| includeSentiment \? 800 : 500/);
});
