import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateAiAgentTestFlow,
  normalizeTestVoiceConfig,
  AI_AGENT_TEST_SCENARIO_ID,
  AI_AGENT_TEST_SCENARIO_NAME,
} from "../lib/workflows/ai-agent-voice-test.mjs";

process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || "test-key";

// Build a voice_flows-shaped object whose nodes/edges are JSON (as stored).
function flow(nodes) {
  return { id: "flow-1", name: "Test Flow", nodes: JSON.stringify(nodes), edges: "[]" };
}

function answerNode({ transcription = true } = {}) {
  return { id: "n1", data: { nodeType: "answer", config: transcription ? { transcription: true } : {} } };
}

function agentAssistNode({ workflowId = "wf-1" } = {}) {
  return {
    id: "n2",
    data: { nodeType: "agent_assist", config: { enabled: true, assist_type: "workflows", workflow_id: workflowId } },
  };
}

function aiAssistantNode({ assistantId = "assistant-1", transcription = false } = {}) {
  const config = { assistant_id: assistantId };
  if (transcription) config.transcription = { model: "telnyx" };
  return { id: "n3", data: { nodeType: "ai_assistant_start", config } };
}

test("hidden scenario constants are stable UUID + sentinel name", () => {
  assert.match(AI_AGENT_TEST_SCENARIO_ID, /^[0-9a-f-]{36}$/i);
  assert.equal(AI_AGENT_TEST_SCENARIO_NAME, "__ai_agent_voice_test__");
});

test("validateAiAgentTestFlow accepts a complete AI-agent test flow", () => {
  const v = validateAiAgentTestFlow(flow([answerNode(), agentAssistNode(), aiAssistantNode()]));
  assert.equal(v.ok, true);
  assert.deepEqual(v.reasons, []);
  assert.equal(v.hasAiAssistant, true);
  assert.equal(v.hasAgentAssist, true);
  assert.equal(v.transcriptionActive, true);
  assert.equal(v.assistantId, "assistant-1");
});

test("validateAiAgentTestFlow flags a flow missing ai_assistant_start", () => {
  const v = validateAiAgentTestFlow(flow([answerNode(), agentAssistNode()]));
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes("missing_ai_assistant_start"));
});

test("validateAiAgentTestFlow flags a flow missing agent_assist", () => {
  const v = validateAiAgentTestFlow(flow([answerNode(), aiAssistantNode()]));
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes("missing_agent_assist"));
});

test("validateAiAgentTestFlow flags a flow missing transcription", () => {
  const v = validateAiAgentTestFlow(flow([answerNode({ transcription: false }), agentAssistNode(), aiAssistantNode()]));
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes("missing_transcription"));
});

test("validateAiAgentTestFlow accepts ai_assistant_start-level transcription when answer has none", () => {
  const v = validateAiAgentTestFlow(
    flow([answerNode({ transcription: false }), agentAssistNode(), aiAssistantNode({ transcription: true })]),
  );
  assert.equal(v.transcriptionActive, true);
  assert.ok(!v.reasons.includes("missing_transcription"));
});

test("validateAiAgentTestFlow flags assistant id mismatch with the workflow's assistant", () => {
  const v = validateAiAgentTestFlow(
    flow([answerNode(), agentAssistNode(), aiAssistantNode({ assistantId: "other-assistant" })]),
    { expectAssistantId: "assistant-1" },
  );
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes("assistant_mismatch"));
});

test("validateAiAgentTestFlow ignores unresolved {{variable}} assistant ids for mismatch", () => {
  const v = validateAiAgentTestFlow(
    flow([answerNode(), agentAssistNode(), aiAssistantNode({ assistantId: "{{assistant_id}}" })]),
    { expectAssistantId: "assistant-1" },
  );
  assert.ok(!v.reasons.includes("assistant_mismatch"));
});

test("normalizeTestVoiceConfig clamps and defaults the caller voice config", () => {
  const c = normalizeTestVoiceConfig({ persona: "ANGRY", voice: "  Telnyx.Ultra.Alloy  ", expressive: true, reply_delay_ms: 99999 });
  assert.equal(c.persona, "angry");
  assert.equal(c.voice, "Telnyx.Ultra.Alloy");
  assert.equal(c.expressive, true);
  assert.equal(c.reply_delay_ms, 10000); // clamped to max
  assert.equal(c.max_slots_per_turn, 1);
  assert.equal(c.randomize_slots, false);
});

test("normalizeTestVoiceConfig falls back to defaults for empty input", () => {
  const c = normalizeTestVoiceConfig({});
  assert.equal(c.persona, "neutral");
  assert.equal(typeof c.voice, "string");
  assert.ok(c.voice.length > 0);
  assert.equal(c.expressive, false);
  assert.equal(c.reply_delay_ms, 0);
});
