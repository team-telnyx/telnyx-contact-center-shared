import { buildTelnyxV2Url } from "../telnyx.js";
import { createDiagnosticLogger } from "../diagnostic-logger.mjs";
import { parseGeneratorClientState } from "./engine.mjs";

// Persona vocabulary and Expressive Mode (per-voice TTS expression) live in a
// client-safe module so they can be shared verbatim with the browser
// "Test AI Agent" page. Re-exported here so existing server imports
// (and tests) keep working unchanged.
export {
  WORKFLOW_TESTING_PERSONAS,
  normalizePersona,
  personaInstruction,
  normalizeMaxSlotsPerTurn,
  resolveSlotCountForTurn,
  isUltraVoice,
  isXaiVoice,
  voiceExpressiveKind,
  voiceSupportsExpressive,
  ULTRA_EMOTIONS,
  personaEmotion,
  applyVoiceExpression,
  applyUltraExpression,
} from "./persona-expression.mjs";

import {
  normalizePersona,
  personaInstruction,
  resolveSlotCountForTurn,
  voiceExpressiveKind,
  personaEmotion,
  applyVoiceExpression,
} from "./persona-expression.mjs";

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

function workflowTestingClientState(...candidates) {
  for (const candidate of candidates) {
    const state = parseGeneratorClientState(candidate);
    if (state?.ledgerId) return state;
  }
  return null;
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
  const step = { type: "workflow_testing", voice: DEFAULT_WORKFLOW_TESTING_VOICE, sample_text: DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT, persona: "neutral", max_slots_per_turn: 1, randomize_slots: false, reply_delay_ms: 0, expressive: false };
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

function buildCustomerReplyPrompt({ workflow, transcript, history, persona, slotCount, expressiveKind }) {
  const personaText = personaInstruction(persona);
  const slots = Math.max(1, Number(slotCount) || 1);
  // Slot-count instruction. With 1 the caller volunteers exactly one piece of
  // information per turn (deterministic single-slot testing). With >1 the
  // caller may answer several of the agent's requested fields in one sentence,
  // which exercises parallel multi-slot filling. The model must never exceed
  // the resolved count for this turn.
  const slotInstruction = slots <= 1
    ? "Provide exactly ONE piece of requested information in this turn (single slot). Do not volunteer additional details the agent has not asked for yet."
    : `You may provide UP TO ${slots} distinct pieces of requested information in a single natural sentence this turn (e.g. customer name, facility name, and date of birth together) to test parallel slot filling. Never provide more than ${slots} distinct pieces of information in this turn, and never invent details the workflow does not need.`;

  const systemParts = [
    "You are simulating a realistic caller for automated contact-center workflow testing. Reply as the caller only. Be natural and provide information that helps the agent complete the configured workflow. Do not mention that you are an AI, a test harness, a workflow, or a simulation.",
  ];
  if (personaText) systemParts.push(`Caller persona: ${personaText}`);
  systemParts.push(slotInstruction);
  // Expressive Mode: invite the model to add the voice family's expression tags
  // sparingly for more realistic delivery. Only added when Expressive Mode is on
  // AND the voice family supports it (Ultra SSML emotion tags, or xAI speech
  // tags). Other voices / Mode off → no tag instruction, so TTS never speaks
  // tags literally.
  if (expressiveKind === "ultra") {
    systemParts.push('Expressive Mode is on (Telnyx Ultra voice). You may add SSML emotion tags such as <emotion value="angry" />, <emotion value="excited" />, <emotion value="happy" />, <emotion value="frustrated" /> or <emotion value="hesitant" /> before a sentence, and the nonverbal cue [laughter], to match the persona. Use them sparingly and only when they fit. Output them inline as part of the utterance text.');
  } else if (expressiveKind === "xai") {
    systemParts.push('Expressive Mode is on (xAI Grok voice). You may add xAI speech tags inline to make delivery realistic: [pause], [long-pause], [laugh], [chuckle], [giggle], [sigh], [breath], [inhale], [exhale] placed where the sound happens, and wrapping tags like <soft>...</soft>, <whisper>...</whisper>, <emphasis>...</emphasis>, <slow>...</slow>, <fast>...</fast> to set delivery style. Use them sparingly and only when they fit the persona. Output them inline as part of the utterance text.');
  }

  return [
    { role: "system", content: systemParts.join(" ") },
    { role: "user", content: JSON.stringify({
      task: "Generate the next caller utterance in response to the agent's finalized transcript.",
      workflow: {
        name: workflow?.name || "Workflow",
        description: workflow?.description || "",
        items: compactWorkflowItems(workflow),
      },
      recent_conversation: Array.isArray(history) ? history.slice(-8) : [],
      latest_agent_transcript: String(transcript || "").slice(0, 2000),
      persona: normalizePersona(persona),
      max_information_pieces_this_turn: slots,
      style: slots <= 1
        ? "One short spoken sentence. Include a single concrete fake but plausible detail when the agent asks for it. Example for healthcare intake: patient name John Wick."
        : "One or two short spoken sentences. Include concrete fake but plausible details when the agent asks for them. Example for healthcare intake: patient name John Wick, date of birth July 4 1978.",
      output: "Return only the caller utterance text, no JSON, no labels.",
    }) },
  ];
}

// Build the LLM prompt for the Expressive Mode preview sample. Produces ONE
// short spoken sentence (≤20 words) in the persona's style. When expressive is
// on and the voice supports it, the model is told to embed the matching tags
// inline (Ultra <emotion>/[laughter]; xAI [pause]/<whisper>/<emphasis>/...), so
// the Play preview demonstrates exactly what the caller will sound like.
export function buildPreviewSamplePrompt({ persona, voice, expressive }) {
  const personaText = personaInstruction(persona);
  const personaId = normalizePersona(persona);
  const kind = expressive === true ? voiceExpressiveKind(voice) : null;

  const sys = [
    "You write a single short sample line for previewing a text-to-speech voice in a contact-center testing tool. Output ONE natural spoken sentence of at most 20 words. No quotes, no labels, no preamble — just the sentence.",
  ];
  if (personaText) sys.push(`Speak as this persona: ${personaText}`);
  if (kind === "ultra") {
    const emotion = personaEmotion(personaId) || "excited";
    sys.push(`Expressive Mode is on for a Telnyx Ultra voice. Begin the sentence with the SSML tag <emotion value="${emotion}" /> and you may add the nonverbal cue [laughter] if it fits. Keep the tags inline in the output.`);
  } else if (kind === "xai") {
    sys.push('Expressive Mode is on for an xAI Grok voice. Embed one or two xAI speech tags inline to demonstrate expression, e.g. [pause], [laugh], [sigh], or wrap part of the sentence with <whisper>...</whisper>, <emphasis>...</emphasis>, <soft>...</soft>, <slow>...</slow>. Keep the tags inline in the output.');
  }

  return [
    { role: "system", content: sys.join(" ") },
    { role: "user", content: JSON.stringify({
      task: "Write one preview sentence (max 20 words) demonstrating the persona and, if applicable, the expression tags.",
      persona: personaId,
      expressive: kind !== null,
      voice_family: kind || "standard",
    }) },
  ];
}

// Generate the preview sample sentence via Telnyx AI. Returns a trimmed string
// (≤ ~240 chars). Throws on transport / non-OK responses so the caller route
// can surface a clean error.
export async function generateExpressivePreviewSample({ persona, voice, expressive, apiKey, model = "openai/gpt-4o" }) {
  const key = apiKey || process.env.TELNYX_API_KEY;
  if (!key) throw new Error("TELNYX_API_KEY environment variable is required");
  const response = await fetch(buildTelnyxV2Url("/ai/chat/completions"), {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature: 0.8, max_tokens: 80, messages: buildPreviewSamplePrompt({ persona, voice, expressive }) }),
  });
  if (!response.ok) throw new Error(`Telnyx AI preview generation failed: ${response.status}`);
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || data?.data?.choices?.[0]?.message?.content || "";
  return String(text).replace(/^['"\s]+|['"\s]+$/g, "").slice(0, 240);
}

async function generateWorkflowTestingReply({ workflow, transcript, history, apiKey, persona, maxSlotsPerTurn, randomizeSlots, voice, expressive }) {
  const model = workflow?.llm_model || "openai/gpt-4o";
  const slotCount = resolveSlotCountForTurn({ maxSlotsPerTurn, randomizeSlots });
  // Only invite expression tags when Expressive Mode is on AND the voice family
  // supports them (Ultra → "ultra", xAI → "xai"); otherwise no tag instruction.
  const expressiveKind = expressive === true ? voiceExpressiveKind(voice) : null;
  const response = await fetch(buildTelnyxV2Url("/ai/chat/completions"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature: 0.7, max_tokens: 160, messages: buildCustomerReplyPrompt({ workflow, transcript, history, persona, slotCount, expressiveKind }) }),
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
  // sessions. Prefer the generator client_state that is persisted on the
  // interaction when available; it contains the exact cg_call_ledger id and keeps
  // concurrent workflow-testing calls with the same workflow/from-number from
  // blocking each other's replies. Older interactions may not have that metadata,
  // so keep the conservative workflow/from-number fallback below.
  const workflowId = String(assistConfig.workflow_id);
  const fromNumber = interaction.from_number || payload?.from || null;
  const metadata = interaction.metadata && typeof interaction.metadata === "object" ? interaction.metadata : {};
  const generatorState = workflowTestingClientState(
    metadata.call_generator_client_state,
    metadata.client_state,
    metadata.clientState,
    payload?.client_state,
    payload?.clientState,
  );

  if (generatorState?.ledgerId) {
    const { rows } = await pool.query(
      `SELECT id, run_id, call_control_id, result
         FROM cg_call_ledger
        WHERE id = $1
          AND status IN ('answered','talking')
          AND COALESCE(result, '{}'::jsonb) -> 'workflow_testing' IS NOT NULL
          AND COALESCE(result, '{}'::jsonb) #>> '{workflow_testing,workflow_id}' = $2
        LIMIT 1`,
      [generatorState.ledgerId, workflowId],
    );
    if (rows[0]?.call_control_id) {
      return handleWorkflowTestingLedgerReply({ pool, ledger: rows[0], transcriptionData, assistConfig });
    }
  }

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

  return handleWorkflowTestingLedgerReply({ pool, ledger, transcriptionData, assistConfig });
}

async function handleWorkflowTestingLedgerReply({ pool, ledger, transcriptionData, assistConfig }) {
  const result = ledger.result && typeof ledger.result === "object" ? ledger.result : {};
  const testing = result.workflow_testing || {};

  const history = Array.isArray(testing.history) ? testing.history : [];
  const recentAgentText = String(transcriptionData.transcript || "").trim();
  if (!recentAgentText || history.some((h) => h.role === "agent" && h.text === recentAgentText)) {
    return { ok: false, reason: "duplicate_or_empty" };
  }

  try {
    const workflow = await loadWorkflowContext(pool, assistConfig.workflow_id);
    const expressive = testing.expressive === true;
    // Optional human-like pause: wait before generating/speaking the caller
    // reply so the simulated caller does not jump in the instant the agent
    // stops talking. Configured per Workflow Testing action (reply_delay_ms).
    const replyDelayMs = Math.min(10000, Math.max(0, Math.round(Number(testing.reply_delay_ms)) || 0));
    if (replyDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, replyDelayMs));
    }
    const reply = await generateWorkflowTestingReply({
      workflow,
      transcript: recentAgentText,
      history,
      apiKey: process.env.TELNYX_API_KEY,
      persona: testing.persona,
      maxSlotsPerTurn: testing.max_slots_per_turn,
      randomizeSlots: testing.randomize_slots,
      voice: testing.voice,
      expressive,
    });
    if (!reply) return { ok: false, reason: "empty_reply" };
    // Expressive Mode: for Ultra voices prepend the persona's <emotion> tag, for
    // xAI voices prepend a fitting speech tag, so the caller sounds the part
    // (angry/excited/...). Only when Expressive Mode is on and the voice family
    // supports it; neutral persona and unsupported voices speak the plain reply.
    // The expressive text is only used for TTS; history and the returned reply
    // stay clean (no tags) so the LLM context and logs are not polluted.
    const spokenText = applyVoiceExpression(reply, { voice: testing.voice, persona: testing.persona, expressive });
    await speakOnGeneratedCall({ callControlId: ledger.call_control_id, text: spokenText, voice: testing.voice, ledgerId: ledger.id, runId: ledger.run_id });
    const nextHistory = [...history, { role: "agent", text: recentAgentText, at: new Date().toISOString() }, { role: "caller", text: reply, at: new Date().toISOString() }].slice(-12);
    await pool.query(
      `UPDATE cg_call_ledger
          SET result = COALESCE(result, '{}'::jsonb) || $1::jsonb
        WHERE id = $2`,
      [JSON.stringify({ workflow_testing: { ...testing, history: nextHistory, last_reply_at: new Date().toISOString(), last_reply: reply } }), ledger.id],
    );
    return { ok: true, reply };
  } catch (error) {
    logger.warn("workflow_testing_reply_failed", { error: error?.message || String(error), ledgerId: ledger.id });
    await pool.query(
      `UPDATE cg_call_ledger SET result = COALESCE(result, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
      [JSON.stringify({ workflow_testing_error: error?.message || String(error) }), ledger.id],
    );
    return { ok: false, reason: "reply_failed" };
  }
}
