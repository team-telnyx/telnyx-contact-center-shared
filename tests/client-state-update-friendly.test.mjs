import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

async function loadClientStateHelpers() {
  const engineSource = await source("../lib/voice-flow-engine.js");
  const start = engineSource.indexOf("function decodeClientStateObject");
  const end = engineSource.indexOf("// End friendly client_state helpers", start);
  assert.ok(start > -1, "client-state helper block should exist");
  assert.ok(end > start, "client-state helper block should be bounded");
  return vm.runInNewContext(
    `${engineSource.slice(start, end)}; ({ decodeClientStateObject, buildClientStatePatch, buildMergedClientStateBase64, resolveClientStateUpdateBase });`,
    { Buffer, console },
  );
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function decode(encoded) {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

test("Update Client State can merge a predefined caller_language without overwriting existing state", async () => {
  const { buildMergedClientStateBase64 } = await loadClientStateHelpers();

  const encoded = buildMergedClientStateBase64({
    existingClientStateBase64: encode({ queue_name: "Support", call_priority: 4 }),
    config: {
      update_mode: "predefined",
      predefined_key: "caller_language",
      value_source: "static",
      caller_language: "pl-PL",
    },
  });

  assert.deepEqual(decode(encoded), {
    queue_name: "Support",
    call_priority: 4,
    caller_language: "pl-PL",
  });
});

test("Update Client State supports custom text values and raw JSON patches", async () => {
  const { buildMergedClientStateBase64 } = await loadClientStateHelpers();

  const customEncoded = buildMergedClientStateBase64({
    existingClientStateBase64: encode({ caller_language: "en-US" }),
    config: {
      update_mode: "custom",
      custom_key: "customer_tier",
      custom_value_type: "text",
      custom_value: "gold",
    },
  });
  assert.deepEqual(decode(customEncoded), {
    caller_language: "en-US",
    customer_tier: "gold",
  });

  const rawEncoded = buildMergedClientStateBase64({
    existingClientStateBase64: customEncoded,
    config: {
      update_mode: "raw_json",
      raw_json: '{"workflow_data":{"case_id":"C-123"},"vip":true}',
    },
  });
  assert.deepEqual(decode(rawEncoded), {
    caller_language: "en-US",
    customer_tier: "gold",
    workflow_data: { case_id: "C-123" },
    vip: true,
  });
});

test("Update Client State preserves route-injected flow tracking over stale webhook state", async () => {
  const { buildMergedClientStateBase64, resolveClientStateUpdateBase } =
    await loadClientStateHelpers();

  const injectedState = encode({ flowId: "flow-1", currentNodeId: "node-2" });
  const staleWebhookState = encode({ flowId: "flow-1", currentNodeId: "node-1" });

  const existingClientStateBase64 = resolveClientStateUpdateBase({
    config: {
      client_state: injectedState,
      update_mode: "predefined",
      predefined_key: "caller_language",
      caller_language: "pl-PL",
    },
    event: { data: { payload: { client_state: staleWebhookState } } },
    executionState: { client_state: encode({ flowId: "flow-1", currentNodeId: "fallback" }) },
  });

  const encoded = buildMergedClientStateBase64({
    existingClientStateBase64,
    config: {
      client_state: injectedState,
      update_mode: "predefined",
      predefined_key: "caller_language",
      caller_language: "pl-PL",
    },
  });

  assert.deepEqual(decode(encoded), {
    flowId: "flow-1",
    currentNodeId: "node-2",
    caller_language: "pl-PL",
  });
});

test("Update Client State UI is a friendly JSON builder with predefined caller language and Base64 preview", async () => {
  const nodeConfig = await source("../config/voice-flow-nodes.js");
  const editorSource = await source("../components/voice-flow/ClientStateUpdateNodeEditor.jsx");
  const pageSource = await source("../app/(portal)/admin/call-flows/[id]/page.jsx");

  assert.match(nodeConfig, /customEditor:\s*"ClientStateUpdateNodeEditor"/);
  assert.match(editorSource, /Caller language/);
  assert.match(editorSource, /Custom parameter/);
  assert.match(editorSource, /Raw JSON/);
  assert.match(editorSource, /Base64 preview/);
  assert.match(editorSource, /caller_language/);
  assert.match(pageSource, /import ClientStateUpdateNodeEditor/);
  assert.match(pageSource, /<ClientStateUpdateNodeEditor[\s\S]*availableVariables=\{getAllVariableNames/);
});
