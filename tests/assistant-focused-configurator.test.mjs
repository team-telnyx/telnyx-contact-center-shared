import test from "node:test";
import assert from "node:assert/strict";
import {
  assistantChangeRows,
  redactAssistantSettings,
} from "../lib/ai/assistant-setting-presentation.mjs";
import {
  newWorkflowExpression,
  workflowExpressionIssues,
  changeWorkflowBooleanOperator,
} from "../lib/ai/assistant-workflow-expressions.mjs";
import {
  assistantSchemas,
  validateAssistantValue,
} from "../lib/ai/assistant-contract.mjs";
import { cloneAssistantOverride } from "../lib/ai/assistant-overrides.mjs";
import { cloneAssistantTranscriptionOverride } from "../lib/ai/assistant-transcription.mjs";

test("new workflow overrides omit GET placeholders and preserve nullable settings", () => {
  const transcription = { model: "deepgram/flux", language: "en", api_key_ref: null, region: null, settings: { eot_threshold: 0.8, smart_format: null, context: null }, fallback_models: [{ model: "deepgram/nova-3", language: null, settings: null }], challenger: null };
  const original = structuredClone(transcription);
  const copied = cloneAssistantTranscriptionOverride(transcription);
  assert.deepEqual(validateAssistantValue(assistantSchemas.TranscriptionSettings, copied), []);
  assert.equal(copied.api_key_ref, undefined);
  assert.equal(copied.settings.smart_format, undefined);
  assert.equal(copied.fallback_models[0].settings, null);
  assert.equal(copied.challenger, null);
  copied.settings.eot_threshold = 0.7;
  assert.deepEqual(transcription, original);
  const voice = cloneAssistantOverride({ voice: "Telnyx.KokoroTTS.af_heart", api_key_ref: null, temperature: null, language_boost: null, tool_call_audio: null, future_field: null }, "VoiceSettings");
  assert.deepEqual(validateAssistantValue(assistantSchemas.VoiceSettings, voice), []);
  assert.equal(voice.api_key_ref, undefined);
  assert.equal(voice.tool_call_audio, null);
  assert.equal(voice.language_boost, null);
  assert.equal(voice.future_field, null);
});

test("review lists only changed leaves and distinguishes off, zero and clearing", () => {
  const original = {
    voice_settings: {
      voice: "Telnyx.KokoroTTS.af_heart",
      tool_call_audio: {
        type: "predefined_media",
        value: "typing",
        volume: 0.5,
      },
    },
    privacy_settings: { data_retention: true },
    transcription: { fallback_models: [{ model: "deepgram/flux" }] },
  };
  const rows = assistantChangeRows(original, {
    voice_settings: {
      ...original.voice_settings,
      tool_call_audio: {
        ...original.voice_settings.tool_call_audio,
        volume: 0,
      },
    },
    privacy_settings: { data_retention: false },
    transcription: { fallback_models: null },
  });
  assert.deepEqual(
    rows.map((row) => [row.path, row.before, row.after]),
    [
      ["voice_settings.tool_call_audio.volume", "0.5", "0"],
      ["privacy_settings.data_retention", "On", "Off"],
      ["transcription.fallback_models", "deepgram/flux", "Not configured"],
    ],
  );
});

test("review does not expose credentials in headers or nested configuration", () => {
  const secret = "sensitive-test-value";
  const source = {
    a2a_agents: [
      {
        headers: [
          { name: "Authorization", value: secret },
          { name: "X-Api-Key", value: secret },
          { name: "X-Token", value: secret },
        ],
      },
    ],
    tools: [{ auth: { password: secret, api_key: secret } }],
  };
  assert(!JSON.stringify(redactAssistantSettings(source)).includes(secret));
  assert(!JSON.stringify(assistantChangeRows({}, source)).includes(secret));
  assert.equal(source.a2a_agents[0].headers[0].value, secret);
});

test("rule builder creates valid nested expressions without exposing serialization controls", () => {
  const expression = newWorkflowExpression("bool_op");
  expression.operands[0] = {
    type: "comparison",
    op: ">=",
    left: {
      type: "arithmetic",
      op: "+",
      left: { type: "variable", name: "cart_total" },
      right: { type: "number_literal", value: 10 },
    },
    right: { type: "number_literal", value: 50 },
  };
  expression.operands[1] = {
    type: "comparison",
    op: "==",
    left: { type: "variable", name: "service_plan" },
    right: { type: "string_literal", value: "Business" },
  };
  assert.deepEqual(
    validateAssistantValue(assistantSchemas.Expression, expression),
    [],
  );
  assert.deepEqual(workflowExpressionIssues(expression), []);
  assert.deepEqual(workflowExpressionIssues({ type: "variable", name: "" }), ["A variable is required."]);
  const not = changeWorkflowBooleanOperator(expression, "not");
  assert.equal(not.operands.length, 1);
  assert.deepEqual(not.operands[0], expression.operands[0]);
  assert.equal(expression.operands.length, 2);
  const any = changeWorkflowBooleanOperator(not, "or");
  assert.equal(any.operands.length, 2);
  assert.equal(any.op, "or");
});
