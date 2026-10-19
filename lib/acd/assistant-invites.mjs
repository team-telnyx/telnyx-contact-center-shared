import { randomUUID } from "node:crypto";
import { assistantInvitePolicy, savedInviteAssistants } from "../ai/assistant-invite-policy.mjs";
import { widgetAiRequest } from "../widgets/ai-provider.js";
import { createTelnyxProvider, isAlreadyEndedResponse } from "./provider.mjs";
import { agentBridgeEvidence, loadVoiceBridgeTopology } from "./voice-bridge-evidence.mjs";
import { prepareInviteTranscription, invitationSipTarget } from "./assistant-invite-transcription.mjs";
import { telnyxErrorDetail } from "../telnyx-error.mjs";

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const publicInvite = row => row ? { id: row.id, assistantId: row.assistant_id, name: row.assistant_name, state: row.state, stopping: row.stop_requested, error: row.error } : null;
const savedAssistantName = (item, id) => savedInviteAssistants(item.attributes?.agent_assist_config).find(assistant => assistant.id === id)?.name || id;

async function ownedCall(db, interactionId, agentId, lock = false) {
  if (!uuid.test(interactionId || "")) throw fail("Invalid interaction.", 400);
  const item = (await db.query(`SELECT w.* FROM acd_work_items w WHERE w.id=$1 AND w.channel='voice' ${lock ? "FOR UPDATE" : ""}`, [interactionId])).rows[0];
  if (!item) throw fail("Call not found.", 404);
  const owner = await db.query("SELECT 1 FROM acd_segments WHERE work_item_id=$1 AND agent_id=$2 AND kind='agent' AND ended_at IS NULL", [interactionId, agentId]);
  if (!owner.rowCount) throw fail("Call belongs to another agent.", 403);
  if (item.state !== "active" || item.terminal_at) throw fail("Call is no longer active.");
  return item;
}

export async function readAssistantInvite(pool, { interactionId, agentId }) {
  const item = await ownedCall(pool, interactionId, agentId);
  const policy = assistantInvitePolicy(item.attributes?.agent_assist_config);
  const row = (await pool.query("SELECT * FROM acd_assistant_invites WHERE work_item_id=$1 ORDER BY created_at DESC LIMIT 1", [interactionId])).rows[0];
  return { enabled: policy.enabled, assistantIds: policy.assistantIds, assistants: policy.assistantIds.map(id => ({ id, name: savedAssistantName(item, id), unavailable: false })), invite: publicInvite(row) };
}

export async function inviteVoiceAssistant(pool, { interactionId, agentId, assistantId, requestId, webhookUrl }, { provider = createTelnyxProvider(), prepareTranscription = prepareInviteTranscription, connectionId = process.env.TELNYX_CALL_CONTROL_ID, from = process.env.TELNYX_SUPERVISOR_FROM_NUMBER || process.env.TELNYX_MAIN_FROM_NUMBER } = {}) {
  if (!uuid.test(requestId || "")) throw fail("Invalid invitation request.", 400);
  const initial = await ownedCall(pool, interactionId, agentId);
  const policy = assistantInvitePolicy(initial.attributes?.agent_assist_config);
  if (!policy.enabled || !policy.assistantIds.includes(assistantId)) throw fail("This assistant is not enabled for invitations in this call flow.", 403);
  if (!connectionId || !from || !/^https:\/\//.test(webhookUrl || "")) throw fail("Voice assistant invitations require a Call Control connection, caller ID and HTTPS application URL.", 503);
  const db = await pool.connect();
  let row;
  try {
    await db.query("BEGIN");
    const item = await ownedCall(db, interactionId, agentId, true);
    if (item.handoff_saga_id) throw fail("Wait for the transfer or device move to finish.");
    const currentPolicy = assistantInvitePolicy(item.attributes?.agent_assist_config);
    if (!currentPolicy.enabled || !currentPolicy.assistantIds.includes(assistantId)) throw fail("Assistant invitations are no longer enabled.", 403);
    const prior = (await db.query("SELECT * FROM acd_assistant_invites WHERE id=$1 OR (work_item_id=$2 AND ended_at IS NULL) ORDER BY created_at DESC LIMIT 1", [requestId, interactionId])).rows[0];
    if (prior) {
      if (prior.id !== requestId || prior.agent_id !== agentId || prior.work_item_id !== interactionId || prior.assistant_id !== assistantId) throw fail("An assistant is already joining or active. Remove it before inviting another.");
      await db.query("COMMIT"); return publicInvite(prior);
    }
    const topology = await loadVoiceBridgeTopology(db, interactionId);
    const bridge = agentBridgeEvidence(topology.legs, topology.intents, agentId, { live: true });
    const leg = topology.legs.find(item => item.id === bridge?.deviceLegId);
    if (!leg?.provider_call_id || leg.state === "held") throw fail("Wait until the customer and agent are connected and the call is not on hold.");
    row = (await db.query(`INSERT INTO acd_assistant_invites(id,work_item_id,agent_id,assistant_id,assistant_name,supervised_call_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [requestId, interactionId, agentId, assistantId, savedAssistantName(item, assistantId), leg.provider_call_id])).rows[0];
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  let transcription;
  try {
    transcription = await prepareTranscription(pool, initial, row);
    if (transcription) await pool.query("UPDATE acd_assistant_invites SET transcript_state=jsonb_set(transcript_state,'{enabled}','true') WHERE id=$1", [requestId]);
  }
  catch (error) {
    await pool.query("UPDATE acd_assistant_invites SET state='failed',ended_at=now(),error=$2,updated_at=now() WHERE id=$1", [requestId, error.message]);
    throw fail(error.message, 503);
  }
  // Dial the assistant's SIP endpoint, not a second human endpoint. This leg
  // owns no human capacity and has its own signed webhook/lifecycle.
  const result = await provider.send({ operation: "assistant_invite", endpoint: "/calls", commandId: requestId, request: {
    connection_id: connectionId, from, to: `sip:${invitationSipTarget(row)}`,
    supervise_call_control_id: row.supervised_call_id, supervisor_role: "barge",
    client_state: Buffer.from(JSON.stringify({ cc_assistant_invite: requestId })).toString("base64"),
    webhook_url: webhookUrl, webhook_url_method: "POST", time_limit_secs: 3600, timeout_secs: 30,
  } });
  const callId = result.response?.data?.call_control_id;
  row = (await pool.query(`UPDATE acd_assistant_invites SET provider_call_id=COALESCE(provider_call_id,$2),
    state=CASE WHEN ended_at IS NOT NULL OR state='active' THEN state WHEN $3='failed' THEN 'failed' WHEN $2 IS NULL THEN 'unknown' ELSE 'joining' END,
    ended_at=CASE WHEN $3='failed' AND provider_call_id IS NULL THEN now() ELSE ended_at END,
    error=CASE WHEN $3='failed' THEN $4 WHEN $2 IS NULL AND provider_call_id IS NULL THEN 'Invitation outcome is being reconciled. Do not redial.' ELSE error END,
    transcript_state=CASE WHEN $5 THEN jsonb_set(transcript_state,'{enabled}','true') ELSE transcript_state END, updated_at=now()
    WHERE id=$1 RETURNING *`, [requestId, callId || null, result.outcome, telnyxErrorDetail(result.response, "The provider rejected the assistant invitation.").slice(0, 500), Boolean(transcription)])).rows[0];
  return publicInvite(row);
}

export async function removeVoiceAssistant(pool, { interactionId, agentId, inviteId }) {
  await ownedCall(pool, interactionId, agentId);
  if (!uuid.test(inviteId || "")) throw fail("Invalid invitation.", 400);
  const row = (await pool.query(`UPDATE acd_assistant_invites SET stop_requested=true,state=CASE WHEN ended_at IS NULL THEN 'stopping' ELSE state END,updated_at=now()
    WHERE id=$1 AND work_item_id=$2 RETURNING *`, [inviteId, interactionId])).rows[0];
  if (!row) throw fail("Invitation not found.", 404);
  return publicInvite(row);
}

export async function applyAssistantInviteEvent(pool, event) {
  const payload = event?.data?.payload || {};
  let state; try { state = JSON.parse(Buffer.from(payload.client_state || "", "base64").toString()); } catch { state = {}; }
  const id = state?.cc_assistant_invite;
  if (!uuid.test(id || "") || !payload.call_control_id) return false;
  const type = event.data.event_type;
  await pool.query(`UPDATE acd_assistant_invites SET provider_call_id=COALESCE(provider_call_id,$2),
    state=CASE WHEN ended_at IS NOT NULL THEN state WHEN $3='call.hangup' THEN 'ended' WHEN stop_requested THEN 'stopping' WHEN $3 IN ('call.answered','call.bridged') THEN 'active' ELSE state END,
    ended_at=CASE WHEN $3='call.hangup' THEN COALESCE(ended_at,now()) ELSE ended_at END,updated_at=now()
    WHERE id=$1 AND (provider_call_id IS NULL OR provider_call_id=$2)`, [id, payload.call_control_id, type]);
  return true;
}

export async function reconcileAssistantInvites(pool, { provider = createTelnyxProvider(), request = widgetAiRequest } = {}) {
  const db = await pool.connect();
  let locked = false;
  try {
    locked = (await db.query("SELECT pg_try_advisory_lock(814026) AS locked")).rows[0].locked;
    if (!locked) return;
    const rows = (await db.query(`SELECT i.*,w.state AS work_state,w.terminal_at,w.handoff_saga_id,
      EXISTS(SELECT 1 FROM acd_segments s WHERE s.work_item_id=i.work_item_id AND s.agent_id=i.agent_id AND s.kind='agent' AND s.ended_at IS NULL) AS still_owner,
      EXISTS(SELECT 1 FROM acd_legs l WHERE l.work_item_id=i.work_item_id AND l.provider_call_id=i.supervised_call_id AND l.ended_at IS NULL) AS leg_live
      FROM acd_assistant_invites i JOIN acd_work_items w ON w.id=i.work_item_id WHERE i.ended_at IS NULL
      ORDER BY i.last_reconciled_at NULLS FIRST,i.created_at,i.id LIMIT 50`)).rows;
    // Rotate every inspected row, including unknown dial outcomes and throttled
    // provider checks. The oldest 50 invitations must not starve later cleanup.
    if (rows.length) await db.query("UPDATE acd_assistant_invites SET last_reconciled_at=clock_timestamp() WHERE id=ANY($1::uuid[])", [rows.map(row => row.id)]);
    for (const row of rows) {
      const mustStop = row.stop_requested || row.work_state !== "active" || row.terminal_at || row.handoff_saga_id || !row.still_owner || !row.leg_live;
      if (mustStop) await db.query("UPDATE acd_assistant_invites SET stop_requested=true,state='stopping' WHERE id=$1", [row.id]);
      if (!row.provider_call_id) continue; // Unknown dial outcome waits for its signed webhook, never redials.
      if (mustStop) {
        if (row.last_checked_at && Date.now() - new Date(row.last_checked_at).getTime() < 3000) continue;
        const result = await provider.send({ operation: "assistant_remove", endpoint: `/calls/${encodeURIComponent(row.provider_call_id)}/actions/hangup`, commandId: randomUUID(), request: {} });
        // HTTP 200 acknowledges the request, not completion. Only a terminal
        // webhook or provider evidence releases the invitation slot.
        if (isAlreadyEndedResponse(result.response)) {
          await db.query("UPDATE acd_assistant_invites SET state='ended',ended_at=now(),updated_at=now() WHERE id=$1", [row.id]);
        }
        await db.query("UPDATE acd_assistant_invites SET last_checked_at=now() WHERE id=$1", [row.id]);
        try {
          const result = await request(`/calls/${encodeURIComponent(row.provider_call_id)}`);
          if ((result.data || result).is_alive === false) await db.query("UPDATE acd_assistant_invites SET state='ended',ended_at=now(),updated_at=now() WHERE id=$1", [row.id]);
        } catch { /* The next worker pass retries without releasing ownership. */ }
      } else if (!row.last_checked_at || Date.now() - new Date(row.last_checked_at).getTime() > 15000) {
        try {
          const result = await request(`/calls/${encodeURIComponent(row.provider_call_id)}`);
          const call = result.data || result;
          if (call.is_alive === false) await db.query("UPDATE acd_assistant_invites SET state='ended',ended_at=now(),updated_at=now() WHERE id=$1", [row.id]);
        } catch { /* Missing evidence must not allow a duplicate invitation. */ }
        await db.query("UPDATE acd_assistant_invites SET last_checked_at=now() WHERE id=$1", [row.id]);
      }
    }
  } finally { if (locked) await db.query("SELECT pg_advisory_unlock(814026)"); db.release(); }
}
