// AI Agent Voice Test — server-side orchestration.
//
// Goal: test a workflow's AI assistant over a REAL voice call using the same
// deterministic mechanism as the Call Generator's "Workflow Testing" feature,
// instead of the old in-browser WebRTC + fixed-timer approach.
//
// How it works (mirrors Call Generator):
//   1. The user picks a test call flow that runs, on answer:
//        answer (Standalone STT on, BOTH legs)
//        → agent_assist (assist_type=workflows, workflow_id)
//        → ai_assistant_start (assistant_id = the workflow's AI assistant)
//      The agent_assist node seeds metadata.agent_assist_config on the flow-leg
//      interaction; that is what lets the transcription router dispatch the
//      assistant's finalized transcript to the simulated-caller reply handler.
//   2. We originate ONE SIP call to sip:gen@<flowId>.sip.telnyx.com (the same
//      target convention as resolveDialTarget('call_flow')). This becomes the
//      simulated-caller leg.
//   3. The generated leg's ledger row carries result.workflow_testing with the
//      persona / TTS voice / expressive / reply-delay config. As the AI
//      assistant SPEAKS, Standalone STT on the assistant leg produces finalized
//      transcripts (track 'outbound') which route to
//      handleWorkflowTestingFinalTranscription → generate caller reply via LLM →
//      speak on the generated leg. Deterministic end-of-utterance (no timer).
//   4. The browser joins the live conversation as a SILENT listener (handled on
//      the client via WebRTC) so the user can hear the AI↔AI call.
//
// This module deliberately reuses cg_runs / cg_call_ledger and the existing
// originate + webhook + transcription pipeline so there is a single, proven code
// path for "simulate a caller against a workflow over voice".

import { getPostgresPool } from "../postgres.mjs";
import {
  originateGeneratedCall,
  hangupGeneratedCall,
  isCallGeneratorEnabled,
} from "../call-generator/engine.mjs";
import {
  normalizePersona,
  DEFAULT_WORKFLOW_TESTING_VOICE,
  analyzeFlowForWorkflowTesting,
} from "../call-generator/workflow-testing.mjs";
import { createDiagnosticLogger } from "../diagnostic-logger.mjs";
import { buildTelnyxV2Url } from "../telnyx.js";

const logger = createDiagnosticLogger("contact-center.ai-agent-voice-test");

// A stable, hidden scenario row owns every AI-agent voice test run so the
// cg_call_ledger FK (run_id → cg_runs → cg_scenarios) is satisfied without
// polluting the user-facing Call Generator scenario list. It is filtered out of
// the Call Generator UI by name/prefix.
export const AI_AGENT_TEST_SCENARIO_ID = "00000000-0000-4000-8000-0000000000a1";
export const AI_AGENT_TEST_SCENARIO_NAME = "__ai_agent_voice_test__";

function clampReplyDelayMs(value) {
  return Math.min(10000, Math.max(0, Math.round(Number(value)) || 0));
}

function clampMaxDurationSecs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 300; // 5 min default for a test call
  return Math.min(3600, Math.max(10, Math.round(n)));
}

// Ensure the hidden scenario that anchors AI-agent test runs exists.
async function ensureAiAgentTestScenario(pool) {
  await pool.query(
    `INSERT INTO cg_scenarios (id, name, description, config, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, '{}'::jsonb, 'system', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [
      AI_AGENT_TEST_SCENARIO_ID,
      AI_AGENT_TEST_SCENARIO_NAME,
      "Hidden scenario anchoring AI Agent voice test runs. Not shown in the Call Generator UI.",
    ],
  );
}

// Load a workflow + its assigned AI assistant id.
async function loadWorkflow(pool, workflowId) {
  const { rows } = await pool.query(
    `SELECT id, name, ai_assistant_id FROM aa_workflows WHERE id = $1 LIMIT 1`,
    [workflowId],
  );
  return rows[0] || null;
}

// Load a voice flow definition (nodes/edges) for validation.
async function loadFlow(pool, flowId) {
  const { rows } = await pool.query(
    `SELECT id, name, nodes, edges FROM voice_flows WHERE id = $1 LIMIT 1`,
    [flowId],
  );
  return rows[0] || null;
}

function parseJsonMaybe(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function nodeType(node) {
  return String(
    node?.data?.nodeType || node?.data?.node_type || node?.data?.type || node?.type || "",
  ).toLowerCase();
}

function nodeConfig(node) {
  const data = node?.data && typeof node.data === "object" ? node.data : {};
  const config = data.config && typeof data.config === "object" ? data.config : {};
  return { ...data, ...config, ...(node?.config && typeof node.config === "object" ? node.config : {}) };
}

// Validate that a flow is suitable for AI-agent voice testing. The flow must:
//   - start an AI assistant on the call (ai_assistant_start), and
//   - enable transcription (Standalone STT) — ideally on both legs.
// Returns { ok, reasons[], hasAiAssistant, hasAgentAssist, transcriptionActive, assistantId }.
//
// NOTE: an `agent_assist` node is NOT required. The AI Agent voice test
// correlates the assistant's transcript to the simulated-caller reply via the
// generator client_state + the ai_agent_voice_test ledger (see
// resolveAiAgentVoiceTestAssist), so the test flow only needs to (a) start the
// AI assistant and (b) transcribe the call. `hasAgentAssist` is still reported
// for information, but it does not gate eligibility.
export function validateAiAgentTestFlow(flow, { expectAssistantId = null } = {}) {
  const nodes = parseJsonMaybe(flow?.nodes, []);
  const nodeList = Array.isArray(nodes) ? nodes : [];

  let hasAiAssistant = false;
  let assistantId = null;
  let aiAssistantTranscription = false;
  let hasIncomingCall = false;

  for (const node of nodeList) {
    const type = nodeType(node);
    if (type === "incoming_call") hasIncomingCall = true;
    if (type === "ai_assistant_start") {
      hasAiAssistant = true;
      const cfg = nodeConfig(node);
      assistantId = cfg.assistant_id || cfg.assistantId || assistantId;
      // Telnyx ai_assistant_start accepts a transcription block; if present the
      // assistant leg is transcribed too. We surface it but do not require it
      // here because the answer-level Standalone STT (both legs) is what the
      // analyzer checks below.
      if (cfg.transcription) aiAssistantTranscription = true;
    }
  }

  // Reuse the Call Generator analyzer for agent_assist + transcription detection.
  const analysis = analyzeFlowForWorkflowTesting(flow, {});

  // The ONLY hard requirement is an Incoming Call initiator: the test dials the
  // flow's SIP URI, which only routes when the flow is triggered by an incoming
  // call. Everything else (AI assistant present, transcription on) is reported
  // as an informational warning so the user is never blocked from selecting a
  // flow, but knows what to fix if replies don't fire.
  const reasons = [];
  if (!hasIncomingCall) reasons.push("missing_incoming_call");
  if (!hasAiAssistant) reasons.push("missing_ai_assistant_start");
  if (!(analysis.transcription_active || aiAssistantTranscription)) reasons.push("missing_transcription");
  if (
    expectAssistantId &&
    assistantId &&
    !String(assistantId).includes("{{") &&
    String(assistantId) !== String(expectAssistantId)
  ) {
    reasons.push("assistant_mismatch");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    hasIncomingCall,
    hasAiAssistant,
    hasAgentAssist: Boolean(analysis.agent_assist_active),
    transcriptionActive: Boolean(analysis.transcription_active || aiAssistantTranscription),
    assistantId: assistantId || null,
    workflowId: analysis.workflow_id || null,
  };
}

// Normalize the caller (simulated customer) voice config coming from the UI.
export function normalizeTestVoiceConfig(input = {}) {
  return {
    persona: normalizePersona(input.persona),
    voice: String(input.voice || DEFAULT_WORKFLOW_TESTING_VOICE).trim() || DEFAULT_WORKFLOW_TESTING_VOICE,
    expressive: input.expressive === true,
    reply_delay_ms: clampReplyDelayMs(input.reply_delay_ms),
    max_slots_per_turn: 1,
    randomize_slots: false,
  };
}

// Start an AI Agent voice test.
//
// Params:
//   workflowId  — the workflow whose AI assistant is under test
//   flowId      — the chosen test call flow id (must validate)
//   fromNumber  — E.164 caller id for the originated SIP call
//   voiceConfig — { persona, voice, expressive, reply_delay_ms }
//   maxDurationSecs — optional cap on the test call length
//
// Returns { ok, reason?, runId?, ledgerId?, callControlId? }.
export async function startAiAgentVoiceTest({
  workflowId,
  flowId,
  fromNumber,
  voiceConfig = {},
  maxDurationSecs,
}) {
  const pool = getPostgresPool();
  if (!pool) return { ok: false, reason: "db_unavailable" };
  if (!workflowId) return { ok: false, reason: "missing_workflow" };
  if (!flowId) return { ok: false, reason: "missing_flow" };
  if (!fromNumber) return { ok: false, reason: "missing_from_number" };

  // The originate path is gated by the same master switch as the Call Generator
  // because it places real outbound calls through the same connection.
  if (!(await isCallGeneratorEnabled(pool))) {
    return { ok: false, reason: "call_generator_disabled" };
  }

  const workflow = await loadWorkflow(pool, workflowId);
  if (!workflow) return { ok: false, reason: "workflow_not_found" };
  if (!workflow.ai_assistant_id) return { ok: false, reason: "workflow_has_no_assistant" };

  const flow = await loadFlow(pool, flowId);
  if (!flow) return { ok: false, reason: "flow_not_found" };

  const validation = validateAiAgentTestFlow(flow, { expectAssistantId: workflow.ai_assistant_id });
  // Hard-block issues that make the test invalid or unsafe:
  //   - no Incoming Call initiator (the SIP originate would not route),
  //   - no ai_assistant_start node (there is no assistant to test), or
  //   - the flow starts a different assistant than the one pinned on the workflow.
  // Everything else is a soft warning surfaced in the UI:
  //   - missing_transcription: the call still runs and is audible via the
  //     listener; replies just won't fire until transcription is enabled.
  const blockingReasons = (validation.reasons || []).filter((r) =>
    ["missing_incoming_call", "missing_ai_assistant_start", "assistant_mismatch"].includes(r),
  );
  if (blockingReasons.length > 0) {
    return { ok: false, reason: "flow_invalid", details: blockingReasons };
  }

  const normalized = normalizeTestVoiceConfig(voiceConfig);
  const durationSecs = clampMaxDurationSecs(maxDurationSecs);

  await ensureAiAgentTestScenario(pool);

  // One-shot run anchored to the hidden scenario. run.config carries the
  // post-answer max duration so originateGeneratedCall passes time_limit_secs.
  const { rows: runRows } = await pool.query(
    `INSERT INTO cg_runs (scenario_id, status, config, created_at)
     VALUES ($1, 'running', $2::jsonb, NOW())
     RETURNING id`,
    [
      AI_AGENT_TEST_SCENARIO_ID,
      JSON.stringify({
        ai_agent_voice_test: true,
        workflow_id: workflowId,
        flow_id: flowId,
        postAnswer: { maxDurationSecs: durationSecs },
        dialTimeoutSecs: 30,
      }),
    ],
  );
  const runId = runRows[0]?.id;
  if (!runId) return { ok: false, reason: "run_create_failed" };

  // Seed the single ledger row with the workflow_testing block. This is exactly
  // the shape handleWorkflowTestingFinalTranscription expects, so the assistant's
  // finalized (outbound-track) transcript drives the simulated-caller reply.
  const workflowTesting = {
    enabled: true,
    ai_agent_voice_test: true,
    workflow_id: workflowId,
    workflow_name: workflow.name || null,
    voice: normalized.voice,
    persona: normalized.persona,
    max_slots_per_turn: normalized.max_slots_per_turn,
    randomize_slots: normalized.randomize_slots,
    reply_delay_ms: normalized.reply_delay_ms,
    expressive: normalized.expressive,
    history: [],
  };

  const { rows: ledgerRows } = await pool.query(
    `INSERT INTO cg_call_ledger (run_id, status, from_number, result)
     VALUES ($1, 'pending', $2, $3::jsonb)
     RETURNING id`,
    [
      runId,
      fromNumber,
      JSON.stringify({
        ai_agent_voice_test: true,
        flow_id: flowId,
        action_steps: [],
        action_trigger: "call_answer",
        workflow_testing: workflowTesting,
      }),
    ],
  );
  const ledgerId = ledgerRows[0]?.id;
  if (!ledgerId) {
    await pool.query(`UPDATE cg_runs SET status = 'failed', stopped_at = NOW() WHERE id = $1`, [runId]);
    return { ok: false, reason: "ledger_create_failed" };
  }

  const ledgerRow = { id: ledgerId };
  const run = {
    id: runId,
    config: { postAnswer: { maxDurationSecs: durationSecs }, dialTimeoutSecs: 30 },
  };
  const task = { target_type: "call_flow", target: flowId };

  const originate = await originateGeneratedCall(pool, { run, ledgerRow, task, fromNumber });
  if (!originate.ok) {
    await pool.query(`UPDATE cg_runs SET status = 'failed', stopped_at = NOW() WHERE id = $1`, [runId]);
    logger.warn("ai_agent_voice_test_originate_failed", { runId, ledgerId, reason: originate.reason });
    return { ok: false, reason: originate.reason || "originate_failed", runId, ledgerId };
  }

  logger.info("ai_agent_voice_test_started", {
    runId,
    ledgerId,
    workflowId,
    flowId,
    callControlId: originate.callControlId || null,
  });

  return {
    ok: true,
    runId,
    ledgerId,
    callControlId: originate.callControlId || null,
  };
}

// Stop an AI Agent voice test: hang up the generated leg and close the run.
export async function stopAiAgentVoiceTest({ runId, ledgerId }) {
  const pool = getPostgresPool();
  if (!pool) return { ok: false, reason: "db_unavailable" };
  if (!runId && !ledgerId) return { ok: false, reason: "missing_identifier" };

  const where = ledgerId ? "id = $1" : "run_id = $1";
  const param = ledgerId || runId;
  const { rows } = await pool.query(
    `SELECT id, run_id, call_control_id, status FROM cg_call_ledger
     WHERE ${where}
       AND COALESCE(result, '{}'::jsonb) ? 'ai_agent_voice_test'
     ORDER BY created_at DESC
     LIMIT 5`,
    [param],
  );

  let hungUp = 0;
  for (const row of rows) {
    if (row.call_control_id && !["completed", "failed", "abandoned"].includes(row.status)) {
      const ok = await hangupGeneratedCall(row.call_control_id);
      if (ok) hungUp += 1;
    }
  }

  const resolvedRunId = runId || rows[0]?.run_id || null;
  if (resolvedRunId) {
    await pool.query(
      `UPDATE cg_runs SET status = 'stopped', stopped_at = NOW()
       WHERE id = $1 AND status NOT IN ('completed', 'failed', 'stopped')`,
      [resolvedRunId],
    );
  }

  return { ok: true, hungUp, runId: resolvedRunId };
}

// Read the live state of an AI Agent voice test (status + conversation history)
// for the UI to poll/render alongside the WebRTC listener.
export async function getAiAgentVoiceTestState({ runId, ledgerId }) {
  const pool = getPostgresPool();
  if (!pool) return { ok: false, reason: "db_unavailable" };
  if (!runId && !ledgerId) return { ok: false, reason: "missing_identifier" };

  const where = ledgerId ? "l.id = $1" : "l.run_id = $1";
  const param = ledgerId || runId;
  const { rows } = await pool.query(
    `SELECT l.id, l.run_id, l.status, l.call_control_id, l.result, l.answered_at, l.ended_at
     FROM cg_call_ledger l
     WHERE ${where}
       AND COALESCE(l.result, '{}'::jsonb) ? 'ai_agent_voice_test'
     ORDER BY l.created_at DESC
     LIMIT 1`,
    [param],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };

  const result = row.result && typeof row.result === "object" ? row.result : {};
  const testing = result.workflow_testing || {};
  return {
    ok: true,
    runId: row.run_id,
    ledgerId: row.id,
    status: row.status,
    callControlId: row.call_control_id || null,
    answeredAt: row.answered_at || null,
    endedAt: row.ended_at || null,
    history: Array.isArray(testing.history) ? testing.history : [],
    lastReply: testing.last_reply || null,
    error: result.workflow_testing_error || result.post_answer_error || null,
  };
}

// Attach a silent WebRTC listener to a running AI Agent voice test.
//
// Uses Telnyx native call supervision in 'monitor' (listen-only) mode: place a
// call to the supervisor's own WebRTC SIP identity and bind it to the test's
// generated leg via supervise_call_control_id. The browser receives this as an
// inbound call, auto-answers it, and the user hears the live AI↔caller
// conversation WITHOUT being heard (monitor never opens the listener's mic into
// the call). The simulated-caller reply logic stays fully server-side.
//
// Params:
//   targetCallControlId — the generated leg's call_control_id (from start/state)
//   sipUsername         — the listener's WebRTC SIP username (resolveWebrtcCredential)
//
// Returns { ok, reason?, supervisorCallControlId? }.
export async function startVoiceTestListener({ targetCallControlId, sipUsername }) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return { ok: false, reason: "missing_api_key" };
  if (!targetCallControlId) return { ok: false, reason: "missing_target_call" };
  if (!sipUsername) return { ok: false, reason: "missing_sip_username" };

  const connectionId = process.env.TELNYX_CALL_CONTROL_ID;
  if (!connectionId) return { ok: false, reason: "missing_connection_id" };

  const payload = {
    to: `sip:${sipUsername}@sip.telnyx.com`,
    connection_id: connectionId,
    supervise_call_control_id: targetCallControlId,
    supervisor_role: "monitor",
    from: process.env.TELNYX_SUPERVISOR_FROM_NUMBER || undefined,
    from_display_name: "AI Voice Test",
    custom_headers: [
      { name: "X-AI-Voice-Test-Listener", value: "true" },
    ],
  };

  let response;
  try {
    response = await fetch(buildTelnyxV2Url("/calls"), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logger.warn("ai_agent_voice_test_listener_request_failed", { error: err?.message || String(err) });
    return { ok: false, reason: "telnyx_request_error" };
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail = data?.errors?.[0]?.detail || `HTTP ${response.status}`;
    logger.warn("ai_agent_voice_test_listener_dial_failed", {
      status: response.status,
      detail: String(detail).slice(0, 300),
    });
    return { ok: false, reason: "listener_dial_failed", detail };
  }

  const supervisorCallControlId = data?.data?.call_control_id || null;
  if (!supervisorCallControlId) return { ok: false, reason: "no_call_control_id" };

  logger.info("ai_agent_voice_test_listener_started", {
    supervisorCallControlId,
    targetCallControlId,
  });
  return { ok: true, supervisorCallControlId };
}

// Hang up the listener leg (best-effort). The test call itself is unaffected.
export async function stopVoiceTestListener({ supervisorCallControlId }) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey || !supervisorCallControlId) return { ok: false, reason: "missing_identifier" };
  try {
    const response = await fetch(
      buildTelnyxV2Url(`/calls/${encodeURIComponent(supervisorCallControlId)}/actions/hangup`),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    return { ok: response.ok };
  } catch {
    return { ok: false, reason: "hangup_failed" };
  }
}

// Decode a base64 generator client_state and return its ledgerId, if any.
function decodeLedgerId(clientState) {
  try {
    const decoded = JSON.parse(Buffer.from(String(clientState || ""), "base64").toString("utf8"));
    if (decoded && decoded.callGenerator === true && decoded.ledgerId) return decoded.ledgerId;
  } catch {}
  return null;
}

// Resolve a synthetic agent_assist_config for an AI Agent voice test, given the
// flow-leg interaction (and optionally the raw Telnyx payload).
//
// Unlike Call Generator workflow-testing, the AI Agent test flow does NOT carry
// an `agent_assist` node, so `interaction.metadata.agent_assist_config` is empty
// and the interaction may not be flagged is_contact_center. Instead we correlate
// via the generator client_state persisted on the interaction (or the payload)
// → an active cg_call_ledger row tagged ai_agent_voice_test. When found, we
// return a config shaped like { assist_type: 'workflows', workflow_id } so the
// existing handleWorkflowTestingFinalTranscription path can drive the reply.
//
// Returns { assistConfig, ledger } or null.
export async function resolveAiAgentVoiceTestAssist({ pool, interaction, payload }) {
  if (!pool) return null;
  const metadata = interaction?.metadata && typeof interaction.metadata === "object" ? interaction.metadata : {};

  // 1) Precise: client_state → ledgerId
  const candidates = [
    metadata.call_generator_client_state,
    metadata.client_state,
    metadata.clientState,
    payload?.client_state,
    payload?.clientState,
  ];
  let ledger = null;
  for (const c of candidates) {
    const ledgerId = decodeLedgerId(c);
    if (!ledgerId) continue;
    const { rows } = await pool.query(
      `SELECT id, run_id, call_control_id, result
         FROM cg_call_ledger
        WHERE id = $1
          AND status IN ('answered','talking')
          AND COALESCE(result, '{}'::jsonb) ? 'ai_agent_voice_test'
        LIMIT 1`,
      [ledgerId],
    );
    if (rows[0]) {
      ledger = rows[0];
      break;
    }
  }

  // 2) Fallback: the most recent active AI-agent-test ledger for this from-number.
  if (!ledger) {
    const fromNumber = interaction?.from_number || payload?.from || null;
    const { rows } = await pool.query(
      `SELECT id, run_id, call_control_id, result
         FROM cg_call_ledger
        WHERE status IN ('answered','talking')
          AND COALESCE(result, '{}'::jsonb) ? 'ai_agent_voice_test'
          AND ($1::text IS NULL OR from_number = $1)
        ORDER BY answered_at DESC NULLS LAST, created_at DESC
        LIMIT 2`,
      [fromNumber],
    );
    if (rows.length === 1) ledger = rows[0];
    // If >1 active tests share the from-number we cannot disambiguate safely.
  }

  if (!ledger) return null;
  const result = ledger.result && typeof ledger.result === "object" ? ledger.result : {};
  const testing = result.workflow_testing || {};
  const workflowId = testing.workflow_id || result.workflow_id || null;
  if (!workflowId) return null;

  return {
    ledger,
    assistConfig: { assist_type: "workflows", workflow_id: String(workflowId), ai_agent_voice_test: true },
  };
}
