import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveTestModel, TestModelError } from "../lib/agent-assist/test-model-override.mjs";
import { resolveOperationModel, prepareAiOperation } from "../lib/ai-operations/runtime.mjs";

// Model precedence for workflows and the Test AI Agent page (2026-10-17):
//   test override (this run only) > workflow model (optional override)
//   > Admin → AI Copilot default > built-in catalogue default.
// The simulated caller has no workflow level: test override > AI Copilot
// "Simulated customer" > built-in.

const settingsPool = (ops) => ({ query: async () => ({ rows: [{ cc_settings: { ai_operations: ops } }] }) });
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("operation model: explicit model, then the AI Copilot card, then the platform default, then the environment", async () => {
  const settings = { ai_default_model: "moonshotai/Kimi-K2.5", ai_operations: { "workflow-analysis": { model: "zai-org/GLM-5.3-Flash", instructions: "" } } };
  const pool = { query: async () => ({ rows: [{ cc_settings: settings }] }) };
  const env = { TELNYX_AI_DEFAULT_MODEL: "env/model" };
  assert.deepEqual(await resolveOperationModel("workflow-analysis", { preferredModel: "workflow/model", pool, env }), { model: "workflow/model", source: "workflow" });
  assert.deepEqual(await resolveOperationModel("workflow-analysis", { preferredModel: "x/y", preferredSource: "test", pool, env }), { model: "x/y", source: "test" });
  assert.deepEqual(await resolveOperationModel("workflow-analysis", { pool, env }), { model: "zai-org/GLM-5.3-Flash", source: "ai-copilot" });
  assert.deepEqual(await resolveOperationModel("test-caller", { pool, env }), { model: "moonshotai/Kimi-K2.5", source: "default" });
  assert.deepEqual(await resolveOperationModel("test-caller", { settings: {}, env }), { model: "env/model", source: "env" });
  await assert.rejects(resolveOperationModel("test-caller", { settings: {}, env: {} }), /No AI model is configured/);
  // prepareAiOperation applies the same order to real requests; a model in the body is ignored.
  assert.equal((await prepareAiOperation("workflow-analysis", { model: "openai/gpt-4o", messages: [] }, { pool, env })).model, "zai-org/GLM-5.3-Flash");
  assert.equal((await prepareAiOperation("test-caller", { model: "openai/gpt-4o", messages: [] }, { pool, env })).model, "moonshotai/Kimi-K2.5");
  assert.equal((await prepareAiOperation("workflow-analysis", { messages: [] }, { pool, env, preferredModel: "workflow/model" })).model, "workflow/model");
});

test("no LLM model is defined in application code", async () => {
  const files = [
    "lib/ai-operations/catalog.mjs", "lib/ai-operations/runtime.mjs", "lib/ai-operations/playground.mjs",
    "lib/agent-assist/workflow-analyzer.js", "lib/agent-assist/sentiment-analysis.js", "lib/agent-assist/translation-service.js",
    "lib/agent-assist/generate-test-scenario.js", "lib/call-generator/workflow-testing.mjs", "lib/contact-center/call-summary.js",
    "lib/contact-center/chat-copilot.js", "lib/contact-center/chat-copilot-settings.mjs", "lib/email/template-ai.mjs",
    "lib/quality/models.mjs", "lib/quality/ai-evaluator.mjs", "lib/medical-transport-intake-workflow.mjs",
    "app/api/agent-assist/generate-response/route.js", "app/api/agent-assist/workflow/generate-suggestion/route.js",
    "app/api/agent-assist/workflow/analyze/route.js", "app/api/admin/workflows/[id]/analyze-test/route.js",
    "app/api/admin/workflows/[id]/generate-response/route.js", "app/api/translate/route.js", "app/api/admin/forms/[id]/ai/route.js",
    "app/api/ai/assistants/[id]/dashboard-summary/route.js", "app/(portal)/admin/workflows/[id]/page.jsx",
    "app/(portal)/admin/workflows/[id]/test/page.jsx", "components/workflows/CreateAgentSheet.jsx", "components/email/EmailTemplateDesigner.jsx",
    "scripts/upsert-medical-transport-intake-workflow.mjs", "app/api/ai/models/route.js",
  ];
  const model = /["'`](openai|meta-llama|Qwen|moonshotai|anthropic|google|mistralai|deepseek-ai|zai-org|xai-org|minimaxai)\/[A-Za-z0-9._:-]+["'`]/;
  for (const file of files) assert.doesNotMatch(await read(file), model, file);
  // The route harness injects modules as plain objects, so a removed export
  // only shows up in `next build`. The quality catalogue reports the AI
  // Copilot model instead of the removed DEFAULT_EVALUATION_MODEL.
  const modelsRoute = await read("app/api/ai/models/route.js");
  assert.doesNotMatch(modelsRoute, /DEFAULT_EVALUATION_MODEL/);
  assert.match(modelsRoute, /resolveOperationModel\("quality-evaluation"\)/);
});

test("a per-test model must be a Telnyx catalogue model (or the workflow's own)", async () => {
  const loadCatalog = async () => ({ models: [{ id: "zai-org/GLM-5.3-Flash" }, { id: "moonshotai/Kimi-K2.5" }] });
  assert.deepEqual(await resolveTestModel(undefined, { loadCatalog }), { model: null, source: "workflow" });
  assert.deepEqual(await resolveTestModel("", { loadCatalog }), { model: null, source: "workflow" });
  assert.deepEqual(await resolveTestModel("zai-org/GLM-5.3-Flash", { loadCatalog }), { model: "zai-org/GLM-5.3-Flash", source: "test" });
  assert.deepEqual(await resolveTestModel("custom/workflow-model", { workflowModel: "custom/workflow-model", loadCatalog }), { model: "custom/workflow-model", source: "workflow" });
  await assert.rejects(resolveTestModel("not/in-catalog", { loadCatalog }), (error) => error instanceof TestModelError && error.status === 400);
  await assert.rejects(resolveTestModel({ id: "x" }, { loadCatalog }), TestModelError);
  await assert.rejects(resolveTestModel("bad model id", { loadCatalog }), TestModelError);
  // An unavailable catalogue does not block a test (Telnyx still validates the id).
  assert.deepEqual(await resolveTestModel("zai-org/GLM-5.3-Flash", { loadCatalog: async () => ({ models: [] }) }), { model: "zai-org/GLM-5.3-Flash", source: "test" });
});

test("no workflow route hard-codes openai/gpt-4o over the AI Copilot default", async () => {
  const analyzeTest = await read("app/api/admin/workflows/[id]/analyze-test/route.js");
  assert.doesNotMatch(analyzeTest, /llm_model \|\| "openai\/gpt-4o"/);
  assert.match(analyzeTest, /resolveOperationModel\("workflow-analysis"/);
  assert.match(analyzeTest, /resolveTestModel\(body\.model/);
  const live = await read("app/api/agent-assist/workflow/analyze/route.js");
  assert.doesNotMatch(live, /llm_model \|\| "openai\/gpt-4o"/);
  const caller = await read("app/api/admin/workflows/[id]/generate-response/route.js");
  assert.doesNotMatch(caller, /preferredModel: workflow\.llm_model/, "the simulated caller does not use the workflow model");
  assert.match(caller, /resolveOperationModel\("test-caller"/);
  const callGenerator = await read("lib/call-generator/workflow-testing.mjs");
  assert.doesNotMatch(callGenerator, /preferredModel: workflow\?\.llm_model/);
});

test("workflows store an empty model as 'inherit AI Copilot' without clearing existing choices", async () => {
  const schema = await read("lib/postgres-schema.mjs");
  assert.match(schema, /await ensureWorkflowModelColumns\(client\)/);
  assert.doesNotMatch(schema, /UPDATE aa_workflows SET llm_model = NULL/);
  const put = await read("app/api/admin/workflows/[id]/route.js");
  assert.match(put, /llm_model\.trim\(\) \? llm_model\.trim\(\) : null/);
  const editor = await read("app/(portal)/admin/workflows/[id]/page.jsx");
  assert.doesNotMatch(editor, /llm_model: "openai\/gpt-4o"/);
  assert.doesNotMatch(editor, /llm_model \|\| "openai\/gpt-4o"/);
  assert.match(editor, /Use AI Copilot default/);
});

test("the Test AI Agent page offers the AI Copilot model list per test", async () => {
  const page = await read("app/(portal)/admin/workflows/[id]/test/page.jsx");
  assert.match(page, /import AIModels from "@\/components\/assistants\/AIModels"/);
  assert.match(page, /\/model-catalog`/);
  assert.match(page, /id="test-analysis-model"/);
  assert.match(page, /id="test-caller-model"/);
  assert.doesNotMatch(page, /tUi\("openai\/gpt-4o"\)/, "no hard-coded model label");
  assert.match(page, /analyzeWorkflowMessage\(flowId, job, job\.message\?\.analysisModel\)/);
  assert.match(page, /callerModelOverrideRef\.current \? \{ model: callerModelOverrideRef\.current \}/);
  const route = await read("app/api/admin/workflows/[id]/model-catalog/route.js");
  assert.match(route, /withPermission\("workflows:ai"/);
  assert.match(route, /chatCopilotCatalog\(\)/, "same catalogue as Admin → AI Copilot");
});

test("Create Agent never sends an empty model (Codex review on #1639)", async () => {
  const sheet = await read("components/workflows/CreateAgentSheet.jsx");
  assert.match(sheet, /disabled=\{creating \|\| !agentName\.trim\(\) \|\| !selectedModel \|\| loadingDefaultModel\}/);
  assert.match(sheet, /async function handleCreate\(\) \{\s*\n\s*if \(!selectedModel \|\| loadingDefaultModel\) return;/);
  assert.match(sheet, /if \(!controller\.signal\.aborted\) setLoadingDefaultModel\(false\);/, "Create waits for the platform default request");
  // Codex review on #1643: a request from an earlier opening is cancelled when the sheet closes.
  assert.match(sheet, /model-catalog`, \{ cache: "no-store", signal: controller\.signal \}\)/);
  assert.match(sheet, /if \(controller\.signal\.aborted\) return;\s*\n\s*const platformModel/);
  assert.match(sheet, /return \(\) => controller\.abort\(\);\s*\n\s*\}, \[open\]\);/);
  assert.match(sheet, /setLoadingDefaultModel\(needsDefaultModel\);/, "every opening sets its own loading state");
});
