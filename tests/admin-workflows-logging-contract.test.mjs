import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import test from "node:test";

const adminWorkflowPattern = "app/api/admin/workflows/**/*.js";
const helperPath = "lib/agent-assist/logging.mjs";
const legacyDiagnostics = /console\.(log|warn|error|info|debug)|LOG_PREFIX|[`"]\[[A-Za-z0-9][^`"]*\]/;
const workflowLoggerCall = /workflowLogger\.(?:debug|info|warn|error)\(([^;]+)\);/gs;

async function source(file) {
  return readFile(file, "utf8");
}

async function files() {
  const out = [];
  for await (const file of glob(adminWorkflowPattern)) out.push(file);
  return out.sort();
}

function calls(src) {
  const out = [];
  let match;
  while ((match = workflowLoggerCall.exec(src))) out.push(match[1]);
  return out;
}

test("Admin workflow routes use Agent Assist structured workflow logger", async () => {
  const helper = await source(helperPath);
  assert.match(helper, /createDiagnosticLogger\(\s*["']agent-assist\.workflow["']\s*\)/);
  assert.match(helper, /export const workflowLogger\b/);
  assert.match(helper, /export function agentAssistRuntimePayload\b/);

  for (const file of await files()) {
    const src = await source(file);
    if (!/workflowLogger\.(?:debug|info|warn|error)\(/.test(src)) continue;
    assert.match(src, /@\/lib\/agent-assist\/logging\.mjs/, `${file} should import Agent Assist logging helper`);
  }
});

test("Admin workflow routes do not use legacy console or bracket-prefix diagnostics", async () => {
  for (const file of await files()) {
    const src = await source(file);
    assert.doesNotMatch(src, legacyDiagnostics, `${file} should not contain console.*, LOG_PREFIX, or bracket-prefix diagnostics`);
  }
});

test("Admin workflow logger calls avoid raw LLM/provider payloads, instructions, and response bodies", async () => {
  const forbidden = /\b(rawPayload|rawProvider|providerResponse|requestBody|responseBody|headers|authorization|apiKey|token|instructions|prompt|responseText|errorText)\b/i;
  for (const file of await files()) {
    const src = await source(file);
    for (const call of calls(src)) {
      assert.doesNotMatch(call, forbidden, `${file} logger call should avoid raw/sensitive identifiers: ${call}`);
    }
  }
});
