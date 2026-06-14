import assert from "node:assert/strict";
import { test } from "node:test";
import { handleWorkflowTestingFinalTranscription } from "../lib/call-generator/workflow-testing.mjs";

// Zadanie 2: LLM caller simulator (Test Workflow).
// The generated (originating) leg and the flow leg that runs Agent Assist are
// DIFFERENT call sessions, so the workflow_testing reply must correlate the
// active generated leg by workflow_id (+ from_number), NOT by call_session_id.

process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || "test-key";

function makePool({ ledgerRow, captureUpdates }) {
  return {
    async query(sql, params) {
      if (/FROM cg_call_ledger/i.test(sql) && /status IN \('answered','talking'\)/.test(sql)) {
        // correlation lookup — assert it does NOT filter by call_session_id
        assert.ok(!/call_session_id\s*=/.test(sql), "must not correlate by flow-leg call_session_id");
        assert.ok(/workflow_testing,workflow_id/.test(sql), "must correlate by workflow_id");
        return { rows: ledgerRow ? [ledgerRow] : [] };
      }
      if (/FROM aa_workflows/i.test(sql)) {
        return { rows: [{ id: params[0], name: "Healthcare Intake", description: "Collect patient intake", llm_model: "openai/gpt-4o" }] };
      }
      if (/FROM aa_workflow_items/i.test(sql)) {
        return { rows: [{ label: "Patient name", description: "Full legal name", type: "text", slot_name: "patient_name", stage_name: "Identify", stage_order: 1, order_index: 1 }] };
      }
      if (/UPDATE cg_call_ledger/i.test(sql)) {
        captureUpdates.push(JSON.parse(params[0]));
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  };
}

function withFetch(handler, fn) {
  const original = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = original; });
}

test("generates an LLM caller reply and speaks it on the active generated leg", async () => {
  const captureUpdates = [];
  const ledgerRow = {
    id: "ledger-1",
    run_id: "run-1",
    call_control_id: "v3:GEN-LEG",
    result: { workflow_testing: { enabled: true, workflow_id: "wf-1", voice: "Telnyx.Ultra.x", history: [] } },
  };
  const pool = makePool({ ledgerRow, captureUpdates });

  const speakCalls = [];
  await withFetch(async (url, options) => {
    const u = String(url);
    if (u.includes("/ai/chat/completions")) {
      return { ok: true, async json() { return { choices: [{ message: { content: "Hi, my name is John Wick." } }] }; } };
    }
    if (u.includes("/actions/speak")) {
      speakCalls.push(JSON.parse(options.body));
      return { ok: true, async json() { return {}; } };
    }
    return { ok: false, status: 404, async text() { return "nope"; } };
  }, async () => {
    const res = await handleWorkflowTestingFinalTranscription({
      pool,
      interaction: { id: "int-1", from_number: "+48221811540", call_session_id: "FLOW-LEG-SESSION" },
      payload: { call_session_id: "FLOW-LEG-SESSION", from: "+48221811540" },
      transcriptionData: { transcript: "Hello, can I get your name please?", is_final: true },
      assistConfig: { assist_type: "workflows", workflow_id: "wf-1" },
    });

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.reply, "Hi, my name is John Wick.");
    // spoke on the GENERATED leg, not the flow leg
    assert.equal(speakCalls.length, 1);
    assert.equal(speakCalls[0].payload, "Hi, my name is John Wick.");
    assert.equal(speakCalls[0].voice, "Telnyx.Ultra.x");
    // history recorded both turns
    const lastUpdate = captureUpdates.at(-1);
    const hist = lastUpdate.workflow_testing.history;
    assert.equal(hist.at(-2).role, "agent");
    assert.equal(hist.at(-1).role, "caller");
  });
});

test("returns no_active_workflow_testing_call when no live generated leg matches", async () => {
  const pool = makePool({ ledgerRow: null, captureUpdates: [] });
  const res = await handleWorkflowTestingFinalTranscription({
    pool,
    interaction: { id: "int-2", from_number: "+48221811540" },
    payload: { call_session_id: "FLOW-LEG" },
    transcriptionData: { transcript: "Any update?", is_final: true },
    assistConfig: { assist_type: "workflows", workflow_id: "wf-2" },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_active_workflow_testing_call");
});

test("skips when assist is not workflow type", async () => {
  const pool = makePool({ ledgerRow: null, captureUpdates: [] });
  const res = await handleWorkflowTestingFinalTranscription({
    pool,
    interaction: { id: "int-3" },
    payload: {},
    transcriptionData: { transcript: "hi", is_final: true },
    assistConfig: { assist_type: "kb_articles" },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_workflow_assist");
});
