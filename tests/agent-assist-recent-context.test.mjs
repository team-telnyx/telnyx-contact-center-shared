import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildWorkflowAnalysisUserPrompt } from "../lib/agent-assist/workflow-prompts.js";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("user prompt includes the recent context (agent question) as READ-ONLY", () => {
  const p = buildWorkflowAnalysisUserPrompt({
    transcript: "No.",
    speaker: "customer",
    recentContext: [{ speaker: "agent", text: "Any other aircraft currently responding?" }],
  });
  assert.match(p, /Any other aircraft currently responding\?/);
  assert.match(p, /do NOT extract any values from these earlier lines/i);
  // The current segment is still the thing to extract from.
  assert.match(p, /NEW transcription segment/);
  assert.match(p, /Transcript: "No\."/);
  // Speaker labels normalized.
  assert.match(p, /Agent: "Any other aircraft/);
});

test("no context block when recentContext is empty/absent", () => {
  assert.doesNotMatch(buildWorkflowAnalysisUserPrompt({ transcript: "No.", speaker: "customer" }), /Recent conversation/);
  assert.doesNotMatch(buildWorkflowAnalysisUserPrompt({ transcript: "No.", speaker: "customer", recentContext: [] }), /Recent conversation/);
});

test("analyzer, both routes, store, and component thread recentContext end-to-end", async () => {
  const analyzer = await read("../lib/agent-assist/workflow-analyzer.js");
  assert.match(analyzer, /recentContext = \[\]/);
  assert.match(analyzer, /buildWorkflowAnalysisUserPrompt\(\{[\s\S]*?recentContext,/);

  const live = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(live, /speaker, recentContext \} = body/);
  assert.match(live, /recentContext: Array\.isArray\(recentContext\)/);

  const testRoute = await read("../app/api/admin/workflows/[id]/analyze-test/route.js");
  assert.match(testRoute, /recentContext = \[\] \} = body/);
  assert.match(testRoute, /recentContext: Array\.isArray\(recentContext\)/);

  const store = await read("../lib/stores/workflow-store.js");
  assert.match(store, /analyzeTranscript: async \(transcript, speaker, recentContext = \[\]\)/);

  const cmp = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.match(cmp, /const recentContext = /);
  assert.match(cmp, /transcription\.track,\s*\n\s*recentContext/);
});
