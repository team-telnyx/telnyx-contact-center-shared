import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateAiAgentTestFlow,
  normalizeTestVoiceConfig,
  startVoiceTestListener,
  stopVoiceTestListener,
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

test("validateAiAgentTestFlow no longer requires agent_assist (only AI assistant + transcription)", () => {
  const v = validateAiAgentTestFlow(flow([answerNode(), aiAssistantNode()]));
  assert.equal(v.ok, true);
  assert.ok(!v.reasons.includes("missing_agent_assist"));
  assert.equal(v.hasAgentAssist, false);
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

// --- Silent WebRTC listener (Telnyx monitor supervision) --------------------

test("startVoiceTestListener validates required inputs", async () => {
  assert.deepEqual(await startVoiceTestListener({ sipUsername: "u" }), {
    ok: false,
    reason: "missing_target_call",
  });
  assert.deepEqual(await startVoiceTestListener({ targetCallControlId: "cc" }), {
    ok: false,
    reason: "missing_sip_username",
  });
});

test("startVoiceTestListener posts a monitor supervisor call and returns its id", async () => {
  const prevKey = process.env.TELNYX_API_KEY;
  const prevConn = process.env.TELNYX_CALL_CONTROL_ID;
  const prevFetch = globalThis.fetch;
  process.env.TELNYX_API_KEY = "test-key";
  process.env.TELNYX_CALL_CONTROL_ID = "conn-123";

  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), body: JSON.parse(opts.body) };
    return { ok: true, text: async () => JSON.stringify({ data: { call_control_id: "sup-leg-1" } }) };
  };

  try {
    const res = await startVoiceTestListener({ targetCallControlId: "gen-leg-1", sipUsername: "agent7" });
    assert.equal(res.ok, true);
    assert.equal(res.supervisorCallControlId, "sup-leg-1");
    assert.match(captured.url, /\/calls$/);
    assert.equal(captured.body.to, "sip:agent7@sip.telnyx.com");
    assert.equal(captured.body.supervisor_role, "monitor");
    assert.equal(captured.body.supervise_call_control_id, "gen-leg-1");
    assert.equal(captured.body.connection_id, "conn-123");
    assert.ok(
      captured.body.custom_headers.some((h) => h.name === "X-AI-Voice-Test-Listener" && h.value === "true"),
    );
  } finally {
    process.env.TELNYX_API_KEY = prevKey;
    process.env.TELNYX_CALL_CONTROL_ID = prevConn;
    globalThis.fetch = prevFetch;
  }
});

test("startVoiceTestListener surfaces a Telnyx dial failure", async () => {
  const prevKey = process.env.TELNYX_API_KEY;
  const prevConn = process.env.TELNYX_CALL_CONTROL_ID;
  const prevFetch = globalThis.fetch;
  process.env.TELNYX_API_KEY = "test-key";
  process.env.TELNYX_CALL_CONTROL_ID = "conn-123";
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    text: async () => JSON.stringify({ errors: [{ detail: "call not found" }] }),
  });
  try {
    const res = await startVoiceTestListener({ targetCallControlId: "gen-leg-1", sipUsername: "agent7" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "listener_dial_failed");
    assert.equal(res.detail, "call not found");
  } finally {
    process.env.TELNYX_API_KEY = prevKey;
    process.env.TELNYX_CALL_CONTROL_ID = prevConn;
    globalThis.fetch = prevFetch;
  }
});

test("stopVoiceTestListener requires a supervisor call id", async () => {
  const res = await stopVoiceTestListener({});
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing_identifier");
});
