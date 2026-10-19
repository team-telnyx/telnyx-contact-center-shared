import { startTelnyxSttMediaStream, stopTelnyxSttTranscription, normalizeAgentSttLanguage } from "../telnyx-stt-handler.mjs";
import { randomUUID } from "node:crypto";
import { createTelnyxProvider, isAlreadyEndedResponse } from "./provider.mjs";

// The media/STT sockets may belong to another process. Stop the provider fork
// so its stop/close event also cleans up the session in that streaming worker.
export async function stopInviteTransportTranscription(callControlId, {
  provider = createTelnyxProvider(), stopLocal = stopTelnyxSttTranscription,
} = {}) {
  const result = await provider.send({ operation: "assistant_transcription_stop", commandId: randomUUID(),
    endpoint: `/calls/${encodeURIComponent(callControlId)}/actions/streaming_stop`, request: {},
  });
  if (result.outcome !== "accepted" && !isAlreadyEndedResponse(result.response)) {
    throw new Error("Could not stop the conference transcription stream. Try inviting the assistant again.");
  }
  await stopLocal(callControlId);
}

// A supervised transport contains a conference mix. Capture each endpoint's
// inbound audio instead, before dialing AI, and retain the mapping for the
// remainder of this call (including after AI removal).
export async function prepareInviteTranscription(pool, item, invite, {
  start = startTelnyxSttMediaStream, stop = stopInviteTransportTranscription,
} = {}) {
  const config = item.attributes?.telnyx_stt_config;
  if (!config?.enabled) return null;
  const legs = (await pool.query("SELECT role,provider_call_id FROM acd_legs WHERE work_item_id=$1 AND ended_at IS NULL", [item.id])).rows;
  const customerId = legs.find(leg => leg.role === "customer")?.provider_call_id;
  const agentId = invite.supervised_call_id;
  const agent = (await pool.query("SELECT username,language FROM users WHERE id=$1", [invite.agent_id])).rows[0];
  const username = agent?.username;
  if (!customerId || !agentId || !username) throw new Error("Could not identify the participants for separate transcription.");
  const tracks = config.transcription_tracks || "both";
  const starts = await Promise.all([
    ...(["inbound", "both"].includes(tracks) ? [start(customerId, config, item.id, username, { mediaTrack: "inbound", outputTrack: "inbound", streamTrack: "inbound_track" })] : []),
    ...(["outbound", "both"].includes(tracks) ? [start(agentId, { ...config, language: normalizeAgentSttLanguage(agent.language, config) }, item.id, username, { mediaTrack: "inbound", outputTrack: "outbound", streamTrack: "inbound_track" })] : []),
  ]);
  if (!starts.every(Boolean)) throw new Error("Could not start separate participant transcription. Try inviting the assistant again.");
  const ignoredCallIds = legs.filter(leg => ["agent_transport", "handoff_transport"].includes(leg.role) && ![customerId, agentId].includes(leg.provider_call_id)).map(leg => leg.provider_call_id).filter(Boolean);
  const mapping = { customerCallId: customerId, agentCallId: agentId, ignoredCallIds };
  await pool.query("UPDATE acd_work_items SET attributes=jsonb_set(attributes,'{assistant_invite_transcription}',$2::jsonb),version=version+1 WHERE id=$1", [item.id, JSON.stringify(mapping)]);
  await Promise.all(ignoredCallIds.map(id => stop(id)));
  return { config, username, interactionId: item.id };
}

// A unique SIP user is preserved in conversation metadata by Telnyx. Never
// correlate by assistant, phone number or time alone: they can be shared by
// simultaneous calls.
export function invitationSipTarget(invite) {
  return `${invite.id}@${invite.assistant_id}.sip.telnyx.com`;
}
