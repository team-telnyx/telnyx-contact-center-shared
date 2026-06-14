import { buildTelnyxV2Url } from "../telnyx.js";
import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

export const WORKFLOW_TESTING_ACTION_ID = "00000000-0000-4000-8000-000000000001";
export const WORKFLOW_TESTING_ACTION_NAME = "Workflow Testing";
export const DEFAULT_WORKFLOW_TESTING_VOICE = "AWS.Polly.Joanna";
export const DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT = "This is a neutral voice preview for workflow testing.";

const logger = createDiagnosticLogger("contact-center.call-generator");

function safeJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

function nodeType(node) {
  return String(node?.data?.nodeType || node?.data?.node_type || node?.data?.type || node?.type || "").toLowerCase();
}

function nodeConfig(node) {
  const data = node?.data && typeof node.data === "object" ? node.data : {};
  const config = data.config && typeof data.config === "object" ? data.config : {};
  return { ...data, ...config, ...(node?.config && typeof node.config === "object" ? node.config : {}) };
}

function isTruthy(value) {
  if (value === true) return true;
  if (typeof value === "number") return value > 0;
  const text = String(value ?? "").toLowerCase();
  return ["true", "1", "yes", "on", "enabled", "both", "inbound", "outbound"].includes(text);
}

export function analyzeFlowForWorkflowTesting(flow, workflowById = {}) {
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : safeJson(flow?.nodes, []);
  const nodeList = Array.isArray(nodes) ? nodes : [];
  let workflowId = null;
  let workflowName = null;
  let agentAssistActive = false;
  let transcriptionActive = false;

  for (const node of nodeList) {
    const type = nodeType(node);
    const config = nodeConfig(node);
    if (type === "agent_assist") {
      const assistType = String(config.assist_type || config.assistType || "").toLowerCase();
      const enabled = config.enabled !== false && config.disabled !== true;
      const candidateWorkflowId = config.workflow_id || config.workflowId || null;
      if (enabled && (assistType === "workflows" || assistType === "workflow") && candidateWorkflowId) {
        agentAssistActive = true;
        workflowId = String(candidateWorkflowId);
        workflowName = workflowById[workflowId]?.name || config.workflow_name || config.workflowName || workflowId;
      }
    }
    if (type === "transcription_start" || type === "streaming_start") transcriptionActive = true;
    if (type === "answer") {
      const keys = [
        "transcription", "transcription_enabled", "enable_transcription", "start_transcription",
        "streaming", "streaming_enabled", "enable_streaming", "record_track",
      ];
      if (keys.some((key) => isTruthy(config[key]))) transcriptionActive = true;
    }
  }

  return {
    capable: Boolean(agentAssistActive && workflowId),
    enabled: Boolean(agentAssistActive && workflowId && transcriptionActive),
    agent_assist_active: Boolean(agentAssistActive),
    transcription_active: Boolean(transcriptionActive),
    workflow_id: workflowId,
    workflow_name: workflowName,
  };
}

export async function ensureWorkflowTestingAction(pool) {
  if (!pool) return null;
  const step = { type: "workflow_testing", voice: DEFAULT_WORKFLOW_TESTING_VOICE, sample_text: DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT };
  const { rows } = await pool.query(
    `INSERT INTO cg_actions (id, name, description, steps, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, 'system', NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       steps = CASE
         WHEN jsonb_typeof(cg_actions.steps) = 'array' AND jsonb_array_length(cg_actions.steps) > 0 THEN cg_actions.steps
         ELSE EXCLUDED.steps
       END,
       updated_at = NOW()
     RETURNING *`,
    [
      WORKFLOW_TESTING_ACTION_ID,
      WORKFLOW_TESTING_ACTION_NAME,
      "Protected call-generator action used by Test Workflow targets. Only the TTS voice and preview sample text are editable.",
      JSON.stringify([step]),
    ],
  );
  return rows[0] || null;
}

export function workflowTestingVoiceFromAction(actionRow) {
  const steps = Array.isArray(actionRow?.steps) ? actionRow.steps : safeJson(actionRow?.steps, []);
  const step = Array.isArray(steps) ? steps.find((s) => s?.type === "workflow_testing") : null;
  return String(step?.voice || DEFAULT_WORKFLOW_TESTING_VOICE).trim() || DEFAULT_WORKFLOW_TESTING_VOICE;
}

async function loadWorkflowContext(pool, workflowId) {
  if (!pool || !workflowId) return null;
  const { rows } = await pool.query(
    `SELECT id, name, description, llm_model FROM aa_workflows WHERE id = $1 LIMIT 1`,
    [workflowId],
  );
  const workflow = rows[0];
  if (!workflow) return null;

  // items/stages live in dedicated tables (aa_workflow_stages / aa_workflow_items),
  // NOT as JSON columns on aa_workflows. Pull a compact, ordered slice so the LLM
  // caller simulator knows what information the agent will try to collect.
  let items = [];
  try {
    const { rows: itemRows } = await pool.query(
      `SELECT i.label, i.description, i.type, i.slot_name, s.name AS stage_name, s.order_index AS stage_order, i.order_index
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON s.id = i.stage_id
        WHERE s.workflow_id = $1
        ORDER BY s.order_index NULLS LAST, i.order_index NULLS LAST
        LIMIT 40`,
      [workflowId],
    );
    items = itemRows.map((r) => ({
      title: r.label || r.slot_name || "Workflow item",
      description: r.description || "",
      type: r.type || null,
      stage: r.stage_name || null,
    }));
  } catch {
    items = [];
  }

  return { ...workflow, items, stages: [] };
}

function compactWorkflowItems(workflow) {
  const items = Array.isArray(workflow?.items) ? workflow.items : [];
  return items.slice(0, 30).map((item, index) => ({
    index: index + 1,
    id: item.id || item.item_id || item.key || null,
    title: item.title || item.name || item.label || "Workflow item",
    description: item.description || item.instructions || item.prompt || item.agent_prompt || "",
    type: item.type || null,
  }));
}

function buildCustomerReplyPrompt({ workflow, transcript, history }) {
  return [
    { role: "system", content: "You are simulating a realistic caller for automated contact-center workflow testing. Reply as the caller only. Be concise, natural, and provide information that helps the agent complete the configured workflow. Do not mention that you are an AI, a test harness, a workflow, or a simulation." },
    { role: "user", content: JSON.stringify({
      task: "Generate the next caller utterance in response to the agent's finalized transcript.",
      workflow: {
        name: workflow?.name || "Workflow",
        description: workflow?.description || "",
        items: compactWorkflowItems(workflow),
      },
      recent_conversation: Array.isArray(history) ? history.slice(-8) : [],
      latest_agent_transcript: String(transcript || "").slice(0, 2000),
      style: "One short spoken sentence or two. Include concrete fake but plausible details when the agent asks for them. Example for healthcare intake: patient name John Wick, date of birth July 4 1978, if relevant.",
      output: "Return only the caller utterance text, no JSON, no labels.",
    }) },
  ];
}

async function generateWorkflowTestingReply({ workflow, transcript, history, apiKey }) {
  const model = workflow?.llm_model || "openai/gpt-4o";
  const response = await fetch(buildTelnyxV2Url("/ai/chat/completions"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature: 0.7, max_tokens: 120, messages: buildCustomerReplyPrompt({ workflow, transcript, history }) }),
  });
  if (!response.ok) throw new Error(`Telnyx AI reply generation failed: ${response.status}`);
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || data?.data?.choices?.[0]?.message?.content || "";
  return String(text).replace(/^['"\s]+|['"\s]+$/g, "").slice(0, 1000);
}

async function speakOnGeneratedCall({ callControlId, text, voice, ledgerId, runId }) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error("TELNYX_API_KEY environment variable is required");
  const { buildGeneratorClientState } = await import("./engine.mjs");
  const response = await fetch(buildTelnyxV2Url(`/calls/${encodeURIComponent(callControlId)}/actions/speak`), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ payload: text, voice: voice || DEFAULT_WORKFLOW_TESTING_VOICE, client_state: buildGeneratorClientState({ runId, ledgerId }) }),
  });
  if (!response.ok) throw new Error(`Telnyx speak failed: ${response.status}`);
}

export async function handleWorkflowTestingFinalTranscription({ pool, interaction, payload, transcriptionData, assistConfig }) {
  if (!pool || !interaction || !transcriptionData?.transcript) return { ok: false, reason: "missing_context" };
  const assistType = String(assistConfig?.assist_type || "").toLowerCase();
  if (!(["workflows", "workflow"].includes(assistType)) || !assistConfig.workflow_id) return { ok: false, reason: "not_workflow_assist" };

  const track = String(transcriptionData?.transcription_track || transcriptionData?.track || "").toLowerCase();
  if (track === "inbound" || track === "customer") {
    return { ok: false, reason: "customer_transcript" };
  }

  // Correlate the agent's flow leg to the originating generated leg.
  //
  // The Call Generator dials sip:gen@<flow>.sip.telnyx.com, so the generated
  // (originating) leg and the flow leg that runs Agent Assist are DIFFERENT call
  // sessions. The cg_call_ledger row stores the generated leg's call_session_id,
  // while transcription events carry the flow leg's call_session_id — they never
  // match. So we correlate on the workflow being tested + the active generated
  // leg, picking the most recent answered/talking workflow_testing ledger row for
  // this workflow. Generated calls are paced at low concurrency, so at most one
  // workflow_testing call per workflow is live at a time. from_number is used as
  // a secondary filter when present to stay correct under higher concurrency.
  const workflowId = String(assistConfig.workflow_id);
  const fromNumber = interaction.from_number || payload?.from || null;

  const { rows } = await pool.query(
    `SELECT id, run_id, call_control_id, result
       FROM cg_call_ledger
      WHERE status IN ('answered','talking')
        AND COALESCE(result, '{}'::jsonb) -> 'workflow_testing' IS NOT NULL
        AND COALESCE(result, '{}'::jsonb) #>> '{workflow_testing,workflow_id}' = $1
        AND ($2::text IS NULL OR from_number = $2)
      ORDER BY answered_at DESC NULLS LAST, created_at DESC
      LIMIT 2`,
    [workflowId, fromNumber],
  );
  if (rows.length > 1) return { ok: false, reason: "ambiguous_workflow_testing_call" };
  const ledger = rows[0];
  if (!ledger?.call_control_id) return { ok: false, reason: "no_active_workflow_testing_call" };

  const result = ledger.result && typeof ledger.result === "object" ? ledger.result : {};
  const testing = result.workflow_testing || {};

  const history = Array.isArray(testing.history) ? testing.history : [];
  const recentAgentText = String(transcriptionData.transcript || "").trim();
  if (!recentAgentText || history.some((h) => h.role === "agent" && h.text === recentAgentText)) {
    return { ok: false, reason: "duplicate_or_empty" };
  }

  try {
    const workflow = await loadWorkflowContext(pool, assistConfig.workflow_id);
    const reply = await generateWorkflowTestingReply({ workflow, transcript: recentAgentText, history, apiKey: process.env.TELNYX_API_KEY });
    if (!reply) return { ok: false, reason: "empty_reply" };
    await speakOnGeneratedCall({ callControlId: ledger.call_control_id, text: reply, voice: testing.voice, ledgerId: ledger.id, runId: ledger.run_id });
    const nextHistory = [...history, { role: "agent", text: recentAgentText, at: new Date().toISOString() }, { role: "caller", text: reply, at: new Date().toISOString() }].slice(-12);
    await pool.query(
      `UPDATE cg_call_ledger
          SET result = COALESCE(result, '{}'::jsonb) || $1::jsonb
        WHERE id = $2`,
      [JSON.stringify({ workflow_testing: { ...testing, history: nextHistory, last_reply_at: new Date().toISOString(), last_reply: reply } }), ledger.id],
    );
    return { ok: true, reply };
  } catch (error) {
    logger.warn("workflow_testing_reply_failed", { error: error?.message || String(error), ledgerId: ledger.id, interactionId: interaction.id });
    await pool.query(
      `UPDATE cg_call_ledger SET result = COALESCE(result, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
      [JSON.stringify({ workflow_testing_error: error?.message || String(error) }), ledger.id],
    );
    return { ok: false, reason: "reply_failed" };
  }
}
