import test from "node:test";
import assert from "node:assert/strict";
import { assistantSchemas, initialSchemaValue, validateAssistantValue, validateAssistantDraftChanges } from "../lib/ai/assistant-contract.mjs";
import { assistantCreateWirePayload, assistantUpdateWirePayload } from "../lib/ai/assistant-payload.mjs";
import {
  assistantForEditor,
  payloadForSave,
} from "../lib/ai/assistant-draft.mjs";
import { planAssistantToolSave } from "../lib/ai/shared-tool-sync.mjs";
import { verifyAssistantWrite } from "../lib/ai/assistant-verification.mjs";

test("tool audio accepts decimal tenths without accepting other increments", () => {
  const schema = assistantSchemas.VoiceSettings.properties.tool_call_audio;
  for (const volume of [0, 0.3, 0.7, 1]) {
    assert.deepEqual(validateAssistantValue(schema, { type: "predefined_media", value: "typing", volume }), []);
  }
  for (const volume of [0.75, -0.1, 1.1]) {
    assert(validateAssistantValue(schema, { type: "predefined_media", value: "typing", volume }).length);
  }
});

test("contract rejects invalid bounds and incompatible STT plans", () => {
  assert.ok(
    validateAssistantDraftChanges({
      dynamic_variables_webhook_timeout_ms: 10001,
    }).length,
  );
  assert.ok(validateAssistantDraftChanges({ tags: ["x".repeat(21)] }).length);
  assert.ok(
    validateAssistantDraftChanges({
      transcription: {
        model: "deepgram/flux",
        fallback_models: [{ model: "soniox/stt-rt-v5" }],
        challenger: { model: "soniox/stt-rt-v5", rule: "best_turn" },
      },
    }).length,
  );
  assert.deepEqual(
    validateAssistantDraftChanges({
      dynamic_variables_webhook_timeout_ms: 1,
      enabled_features: [],
      telephony_settings: { disable_dtmf: false, user_idle_reply_secs: 0 },
    }),
    [],
  );
});
test("read-schema nulls do not block unrelated edits but newly introduced invalid nulls do", () => {
  const original = {
    transcription: {
      model: "deepgram/flux",
      api_key_ref: null,
      settings: null,
    },
  };
  assert.deepEqual(
    validateAssistantDraftChanges(
      { transcription: { ...original.transcription, language: "auto" } },
      original,
    ),
    [],
  );
  assert.ok(
    validateAssistantDraftChanges({
      transcription: { model: "deepgram/flux", settings: null },
    }).length,
  );
  assert.ok(validateAssistantDraftChanges({ name: null }).length);
});
test("untouched response normalization never leaks into a patch", () => {
  const draft = assistantForEditor({
    name: "test",
    transcription: { model: "deepgram/flux", region: null },
    external_llm: { model: "example", base_url: "https://example.test" },
    model: null,
  });
  draft.name = "renamed";
  assert.deepEqual(payloadForSave(draft, { patch: true }), { name: "renamed" });
});
test("shared attachment omission preserves attachments and explicit empty IDs removes them", () => {
  const currentTools = [
    { type: "hangup", tool_id: "shared-1", shared: true, hangup: {} },
  ];
  assert.deepEqual(
    [
      ...planAssistantToolSave({ tools: [] }, { currentTools })
        .desiredSharedToolIds,
    ],
    ["shared-1"],
  );
  assert.deepEqual(
    [
      ...planAssistantToolSave({ tools: [], tool_ids: [] }, { currentTools })
        .desiredSharedToolIds,
    ],
    [],
  );
  const draft = assistantForEditor({ tools: currentTools });
  draft.tools = [];
  assert.deepEqual(payloadForSave(draft, { patch: true }), {
    tools: [],
    tool_ids: [],
  });
  draft.tools = [{ ...currentTools[0], hangup: { description: "changed" } }];
  assert.throws(() => payloadForSave(draft), /Tools Library/);
});
test("an unpromoted version is never verified against main when its identifier is missing", async () => {
  let called = false;
  const result = await verifyAssistantWrite(
    "key",
    "id",
    { promote_to_main: false },
    {
      fetchImpl: async () => {
        called = true;
      },
    },
  );
  assert.equal(called, false);
  assert.equal(result.verification.status, "unavailable");
});

test("hosted fallback accepts canonical external clearing on creation and provider switch", () => {
  const payload = { fallback_config: { model: "openai/gpt-4.1", llm_api_key_ref: "", external_llm: null } };
  for (const original of [{}, {fallback_config: {external_llm: {model: "alias", base_url: "https://example.test"}}}]) {
    assert.deepEqual(validateAssistantDraftChanges(payload, original), []);
  }
  assert.deepEqual(assistantUpdateWirePayload(payload).fallback_config.external_llm, {model: "", base_url: ""});
});

test("client delegation validates the effective WebSocket configuration in either edited root", () => {
  const delegation_settings = {enabled: true, mode: "client"};
  for (const original of [{}, {websocket_settings: {enabled: false}}, {websocket_settings: {enabled: true, url: ""}}]) {
    assert.ok(validateAssistantDraftChanges({delegation_settings}, original).some(error => error.includes("WebSocket")));
  }
  const websocket_settings = {enabled: true, url: "wss://example.test/socket"};
  assert.deepEqual(validateAssistantDraftChanges({delegation_settings}, {websocket_settings}), []);
  assert.ok(validateAssistantDraftChanges({websocket_settings: {enabled: false}}, {delegation_settings, websocket_settings}).some(error => error.includes("WebSocket")));
  assert.deepEqual(validateAssistantDraftChanges({name: "unrelated"}, {delegation_settings}), []);
});

test("nullable schema variants produce the actual clearing value", () => {
  assert.equal(initialSchemaValue({type: "null"}), null);
  assert.deepEqual(validateAssistantDraftChanges({avatar_settings: initialSchemaValue({type: "null"})}, {avatar_settings: {avatar_id: "old"}}), []);
});

test("save validation rejects incomplete tools and broken workflow references but permits inherited prompt instructions", () => {
  const conversation_flow = {start_node_id: "tool-node", nodes: [{id: "tool-node", type: "tool", shared_tool_id: ""}], edges: []};
  assert.ok(validateAssistantDraftChanges({conversation_flow}).some(error => error.includes("shared tool")));
  conversation_flow.nodes[0].shared_tool_id = "tool-controlled";
  assert.deepEqual(validateAssistantDraftChanges({conversation_flow}), []);
  conversation_flow.nodes[0].id = "renamed";
  assert.ok(validateAssistantDraftChanges({conversation_flow}).some(error => error.includes("start node")));
  assert.deepEqual(validateAssistantDraftChanges({conversation_flow: {start_node_id: "prompt", nodes: [{id: "prompt", type: "prompt", instructions: ""}], edges: []}}), []);
});

test("creation omits canonical removal values without changing update clearing or free-form data", () => {
  const draft = {name: "test", instructions: "", model: "openai/gpt-4.1", external_llm: null, fallback_config: {model: "moonshotai/Kimi-K2.6", external_llm: null}, avatar_settings: null, conversation_flow: null, dynamic_variables: {external_llm: null}};
  const wire = assistantCreateWirePayload(draft);
  assert.equal('external_llm' in wire, false);
  assert.equal('external_llm' in wire.fallback_config, false);
  assert.deepEqual(wire.dynamic_variables, {external_llm: null});
  assert.equal(draft.external_llm, null);
  assert.deepEqual(validateAssistantValue(assistantSchemas.CreateAssistantRequest, wire), []);
  assert.equal('fallback_config' in assistantCreateWirePayload({...draft, fallback_config: null}), false);
  assert.deepEqual(assistantUpdateWirePayload(draft).external_llm, {model: "", base_url: ""});
});

test("FastRouter requires a credential reference in primary, fallback, delegation and workflow configurations", () => {
  const external_llm = {model: "virtual-alias", base_url: "https://api.fastrouter.ai/api/v1", authentication_method: "token"};
  const flow = {start_node_id: "node", nodes: [{id: "node", type: "prompt", instructions: "", external_llm}], edges: []};
  for (const payload of [{external_llm}, {fallback_config: {external_llm}}, {delegation_settings: {external_llm}}, {conversation_flow: flow}]) {
    assert.ok(validateAssistantDraftChanges(payload).some(error => error.includes("FastRouter API key")));
  }
  assert.deepEqual(validateAssistantDraftChanges({external_llm: {...external_llm, llm_api_key_ref: "controlled-secret"}}), []);
  assert.deepEqual(validateAssistantDraftChanges({external_llm: {...external_llm, base_url: "https://public.example.test/v1"}}), []);
});
