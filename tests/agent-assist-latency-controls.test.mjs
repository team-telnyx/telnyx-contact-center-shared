import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("workflow reasoning is persisted as an opt-in, default-off setting", async () => {
  const schema = await read("../lib/postgres-schema.mjs");
  const api = await read("../app/api/admin/workflows/[id]/route.js");
  const editor = await read("../app/(portal)/admin/workflows/[id]/page.jsx");
  assert.match(schema, /llm_reasoning_enabled BOOLEAN NOT NULL DEFAULT false/);
  assert.match(api, /typeof llm_reasoning_enabled !== "boolean"/);
  assert.match(editor, /Reasoning enabled/);
  assert.match(editor, /llm_reasoning_enabled: false/);
});

test("workflow slot output cap is persisted, validated, and defaults to 1200", async () => {
  const schema = await read("../lib/postgres-schema.mjs");
  const api = await read("../app/api/admin/workflows/[id]/route.js");
  const editor = await read("../app/(portal)/admin/workflows/[id]/page.jsx");
  const analyzer = await read("../lib/agent-assist/workflow-analyzer.js");
  assert.match(schema, /llm_max_output_tokens INTEGER NOT NULL DEFAULT 1200/);
  assert.match(api, /outputCap < 512 \|\| outputCap > 1200/);
  assert.match(editor, /Slot filling output cap/);
  assert.match(editor, /step="100"/);
  assert.match(editor, /Use 800 for simple workflows; keep 1,200 for complex or multi-slot intake/);
  assert.match(analyzer, /Math\.min\(outputCap, Math\.max\(512,/);
});

test("workflow slot fallback model is persisted and configurable with Luna as the default", async () => {
  const schema = await read("../lib/postgres-schema.mjs");
  const api = await read("../app/api/admin/workflows/[id]/route.js");
  const editor = await read("../app/(portal)/admin/workflows/[id]/page.jsx");
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const analyzer = await read("../lib/agent-assist/workflow-analyzer.js");
  assert.match(schema, /llm_fallback_model VARCHAR\(100\) NOT NULL DEFAULT 'openai\/gpt-5\.6-luna'/);
  assert.match(api, /llm_fallback_model/);
  assert.match(editor, /Slot filling fallback model/);
  assert.match(editor, /Select fallback model/);
  assert.match(route, /fallbackModel = workflow\?\.llm_fallback_model \|\| "openai\/gpt-5\.6-luna"/);
  assert.match(analyzer, /models\.push\(configuredFallbackModel\)/);
});

test("workflow reasoning setting also controls suggestions and admin test generation", async () => {
  const suggestion = await read("../app/api/agent-assist/workflow/generate-suggestion/route.js");
  const response = await read("../app/api/admin/workflows/[id]/generate-response/route.js");
  const scenarioRoute = await read("../app/api/admin/workflows/[id]/generate-test-scenario/route.js");
  const scenarioGenerator = await read("../lib/agent-assist/generate-test-scenario.js");
  assert.match(suggestion, /enable_thinking: reasoningEnabled/);
  assert.match(response, /enable_thinking: workflow\.llm_reasoning_enabled === true/);
  assert.match(scenarioRoute, /reasoningEnabled: workflow\.llm_reasoning_enabled === true/);
  assert.match(scenarioGenerator, /enable_thinking: reasoningEnabled === true/);
});

test("slot filling sends explicit reasoning and never requests sentiment", async () => {
  const analyzer = await read("../lib/agent-assist/workflow-analyzer.js");
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(analyzer, /enable_thinking: reasoningEnabled === true/);
  assert.match(route, /reasoningEnabled = workflow\?\.llm_reasoning_enabled === true/);
  assert.doesNotMatch(route, /includeSentiment:/);
  assert.doesNotMatch(route, /sentimentScore:/);
});

test("sentiment remains a separate bounded non-reasoning request", async () => {
  const auxiliary = await read("../lib/agent-assist/sentiment-analysis.js");
  const router = await read("../lib/agent-assist-transcription-router.mjs");
  assert.match(auxiliary, /enable_thinking: false/);
  assert.match(auxiliary, /AUXILIARY_ANALYSIS_TIMEOUT_MS = 5000/);
  assert.match(auxiliary, /max_tokens: includeIntent && includeSentiment \? 180 : 100/);
  assert.match(router, /includeSentiment: assistConfig\.enable_sentiment_analysis === true/);
});

test("slot analysis has timeout, fallback, cancellation, and releases DB during inference", async () => {
  const analyzer = await read("../lib/agent-assist/workflow-analyzer.js");
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const store = await read("../lib/stores/workflow-store.js");
  assert.match(analyzer, /fallbackModel = DEFAULT_FALLBACK_MODEL/);
  assert.match(analyzer, /DEFAULT_TOTAL_TIMEOUT_MS = 12000/);
  assert.match(route, /connectionRef\.client\.release\(\);[\s\S]*analyzeWorkflowTranscript/);
  assert.match(route, /MAX_CONCURRENT_CONCEPT_GROUPS = 2/);
  assert.match(store, /activeAnalyzeControllers/);
  assert.match(store, /signal: controller\.signal/);
});

test("per-bubble debounce has a maximum wait and no old global FIFO", async () => {
  const component = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.match(component, /const firstSeenAt = existing\?\.firstSeenAt \|\| now/);
  assert.match(component, /Math\.min\(500, 1500 - elapsed\)/);
  assert.match(component, /existing\?\.text === text/);
  assert.doesNotMatch(component, /analyzeChainRef/);
});
