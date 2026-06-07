import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  helper: "lib/agent-assist/logging.mjs",
  aiContext: "app/api/agent-assist/workflow/ai-context/route.js",
  analyze: "app/api/agent-assist/workflow/analyze/route.js",
  generateSuggestion: "app/api/agent-assist/workflow/generate-suggestion/route.js",
  completeItem: "app/api/agent-assist/workflow/item/[id]/complete/route.js",
  skipItem: "app/api/agent-assist/workflow/item/[id]/skip/route.js",
  saveHistory: "app/api/agent-assist/workflow/save-history/route.js",
  session: "app/api/agent-assist/workflow/session/route.js",
  slot: "app/api/agent-assist/workflow/slot/[name]/route.js",
  speakTranslation: "app/api/agent-assist/workflow/speak-translation/route.js",
  start: "app/api/agent-assist/workflow/start/route.js",
  handoffProcessor: "lib/agent-assist/ai-handoff-processor.js",
  scenarioGenerator: "lib/agent-assist/generate-test-scenario.js",
  translationService: "lib/agent-assist/translation-service.js",
  workflowAnalyzer: "lib/agent-assist/workflow-analyzer.js",
};

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const forbiddenLegacyDiagnostics = /console\.(log|warn|error|info|debug)|[`"]\[[A-Za-z0-9][^`"]*\]/;
const forbiddenRawProviderPayloads = /\b(rawPayload|fullPayload|providerResponse|llmResponse|responseText|errorText|errText|messagePayload|promptText|completionText)\b/;

test("Agent Assist logging helper exposes canonical topic loggers", async () => {
  const helper = await source(files.helper);

  for (const [name, topic] of [
    ["workflowLogger", "agent-assist.workflow"],
    ["suggestionsLogger", "agent-assist.suggestions"],
    ["translationLogger", "agent-assist.translation"],
    ["handoffLogger", "agent-assist.handoff"],
    ["llmLogger", "agent-assist.llm"],
  ]) {
    assert.match(helper, new RegExp(`export const ${name} = createDiagnosticLogger\\("${topic.replace(/[.]/g, "\\.")}\\"\\);`));
  }

  assert.match(helper, /export function agentAssistErrorPayload/);
  assert.match(helper, /export function agentAssistRuntimePayload/);
});

test("Agent Assist workflow/runtime files use structured topic loggers", async () => {
  const expectations = [
    [files.aiContext, /workflowLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.analyze, /workflowLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.generateSuggestion, /suggestionsLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.completeItem, /workflowLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.skipItem, /workflowLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.saveHistory, /workflowLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.session, /workflowLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.slot, /workflowLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.speakTranslation, /translationLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.start, /(workflowLogger|handoffLogger)\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.handoffProcessor, /handoffLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.scenarioGenerator, /llmLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.translationService, /translationLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.workflowAnalyzer, /(workflowLogger|llmLogger)\.(debug|info|warn|error)\("[a-z0-9_]+"/],
  ];

  for (const [path, loggerPattern] of expectations) {
    const content = await source(path);
    assert.match(content, /(agent-assist\/logging\.mjs|from "\.\/logging\.mjs")/, `${path} must import Agent Assist logging helper`);
    assert.match(content, loggerPattern, `${path} must emit canonical structured logger events`);
    assert.doesNotMatch(content, forbiddenLegacyDiagnostics, `${path} still contains legacy console/bracket diagnostics`);
  }
});

test("Agent Assist logs keep compact correlation fields and avoid raw LLM/provider responses", async () => {
  for (const path of Object.values(files)) {
    const content = await source(path);
    assert.doesNotMatch(content, forbiddenRawProviderPayloads, `${path} must not log raw LLM/provider payload fields`);
  }

  const combined = await Promise.all(Object.values(files).map(source)).then((parts) => parts.join("\n"));
  for (const field of ["sessionId", "interactionId", "workflowId", "itemId", "slotName", "language", "provider", "reason"]) {
    assert.match(combined, new RegExp(`\\b${field}\\b`), `expected safe field ${field} in Agent Assist logging slice`);
  }
});
