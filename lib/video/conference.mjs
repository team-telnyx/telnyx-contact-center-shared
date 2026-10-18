import { validateAssistantVision } from "../ai/vision-validation.mjs";
import { hasAssistantVisionTool } from "../ai/vision-tool.mjs";
import { widgetAiRequest } from "../widgets/ai-provider.js";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createVideoWork, endVideoRoom, readVideoSession } from "./lifecycle.mjs";
import { videoUsesAi } from "./conference-config.mjs";
import { refreshAvatarPreview } from "../ai/telnyx-avatars.mjs";
import { defaultRoomsClient } from "./rooms.mjs";
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const digest = value => createHash("sha256").update(String(value)).digest("hex");
export async function videoEvent(db, videoSessionId, kind, payload = {}) {
  await db.query("INSERT INTO cc_video_ai_events(video_session_id,kind,payload) VALUES($1,$2,$3::jsonb)", [videoSessionId, kind, JSON.stringify(payload)]);
}
export async function conferenceByConversation(db, conversationId) {
  return (await db.query("SELECT * FROM acd_video_sessions WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1", [conversationId])).rows[0] || null;
}
export async function createAiFirstConference(db, { video, customerName, attributes }) {
  if (!videoUsesAi(video)) throw fail("Video AI is not configured", 400);
  const healthy = await db.query("SELECT 1 FROM cc_video_ai_workers WHERE heartbeat_at>now()-interval '15 seconds' LIMIT 1");
  if (!healthy.rowCount) throw fail("The video assistant service is unavailable. Please retry shortly.",503);
  const id = randomUUID(), conversationId = randomUUID();
  await db.query("INSERT INTO acd_conversations(id,channel,customer_name,attributes) VALUES($1,'video',$2,$3::jsonb)", [conversationId, customerName, JSON.stringify(attributes)]);
  await db.query(`INSERT INTO acd_video_sessions(id,conversation_id,recording_enabled,recording_layout,media,conference_config)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`, [id, conversationId, video.recording.enabled, video.recording.layout, JSON.stringify({ camera: video.camera, screenShare: video.allowScreenShare }), JSON.stringify(video)]);
  return { id, conversation_id: conversationId };
}
export async function requestConferenceAi(db, { videoSessionId, assistantId, invited = false }) {
  if (process.env.VIDEO_CONFERENCE_AI_ENABLED === "false") throw fail("Conference AI is disabled", 503);
  const video = (await db.query("SELECT * FROM acd_video_sessions WHERE id=$1", [videoSessionId])).rows[0];
  if (!video || ["ended", "failed"].includes(video.state)) throw fail("Video conference has ended");
  const ai = video.conference_config.ai;
  if (!ai || (invited && !ai.allowAgentInvite)) throw fail("Assistant invitations are disabled", 403);
  const selected = assistantId || ai.assistantId;
  if (![ai.assistantId, ...(ai.allowedAssistantIds || [])].includes(selected)) throw fail("This assistant is not allowed in the video conference", 403);
  const profile = (await db.query(`SELECT p.* FROM cc_video_ai_profiles p JOIN cc_widget_sessions s ON s.revision_id=p.revision_id
    WHERE s.conversation_id=$1 AND p.source_assistant_id=$2 AND p.status='ready' AND p.deleted_at IS NULL LIMIT 1`, [video.conversation_id, selected])).rows[0];
  if (!profile) throw fail("Publish the widget's video profile before starting AI", 503);
  const healthy = await db.query("SELECT 1 FROM cc_video_ai_workers WHERE heartbeat_at>now()-interval '15 seconds' LIMIT 1");
  if (!healthy.rowCount) throw fail("The video assistant service is unavailable. The human conference can continue.", 503);
  if (profile.config.vision?.mode !== "disabled") {
    const fetched = await widgetAiRequest(`/ai/assistants/${encodeURIComponent(profile.assistant_id)}`);
    const assistant = fetched.data || fetched;
    await validateAssistantVision(assistant, {buffered:true});
    if (!await hasAssistantVisionTool(assistant, widgetAiRequest)) throw fail("The published video assistant has no Vision tool. Publish the widget again to restore its profile.", 409);
  }
  const result = await db.query(`INSERT INTO cc_video_ai_sessions(video_session_id,profile_id)
    VALUES($1,$2) ON CONFLICT(video_session_id) DO UPDATE SET desired_state='active',state='pending',profile_id=EXCLUDED.profile_id,error=NULL,ended_at=NULL,updated_at=now()
    WHERE cc_video_ai_sessions.state IN ('stopped','failed') AND (cc_video_ai_sessions.lease_until IS NULL OR cc_video_ai_sessions.lease_until<now()) RETURNING *`, [videoSessionId, profile.id]);
  if (result.rowCount) await videoEvent(db, videoSessionId, "ai.requested", { assistantId: selected, invited });
  return conferenceAiView(db, videoSessionId);
}
export async function conferenceAiView(db, videoSessionId, viewer) {
  const row = (await db.query(`SELECT a.*,p.config,p.source_assistant_id FROM cc_video_ai_sessions a JOIN cc_video_ai_profiles p ON p.id=a.profile_id WHERE a.video_session_id=$1`, [videoSessionId])).rows[0];
  if (!row) return null;
  // Visitor polling also handles the case where every media worker is down.
  if (db.connect && row.desired_state !== "stopped" && !["failed", "stopped"].includes(row.state) && Date.now() - new Date(row.updated_at).getTime() > 90000) {
    const failed = await db.query(`UPDATE cc_video_ai_sessions SET state='failed',desired_state='stopped',generation=generation+1,
      error='Video assistant timed out',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE video_session_id=$1 AND generation=$2
      AND updated_at<now()-interval '90 seconds' RETURNING *`, [videoSessionId, row.generation]);
    if (failed.rowCount) { Object.assign(row, failed.rows[0]); await conferenceHandoff(db, { videoSessionId, reason: "ai_timeout" }); }
  }
  const member = viewer ? (await db.query("SELECT consent FROM cc_video_members WHERE video_session_id=$1 AND role=$2 AND principal_id=$3 AND revoked_at IS NULL", [videoSessionId, viewer.role, viewer.principalId])).rows[0] : null;
  return { ownConsent: member?.consent || {}, state: row.state, desiredState: row.desired_state, assistantId: row.source_assistant_id,
    avatar: await refreshAvatarPreview(row.config.avatar), vision: { ...row.vision, transitioning: row.vision?.transitionUntil > Date.now() }, sources: row.sources, visionConfig: row.config.vision, error: row.error };
}
export async function requireConferenceAgent(db, { workItemId, agentId }) {
  const video = await readVideoSession(db, workItemId);
  const active = await db.query("SELECT 1 FROM acd_text_assignments WHERE work_item_id=$1 AND agent_id=$2 AND state='active'", [workItemId, agentId]);
  if (!active.rowCount || !video || ["ended", "failed"].includes(video.state)) throw fail("The video conference is not assigned to you", 403);
  return video;
}
export async function conferenceHandoff(pool, { videoSessionId, summary = "", reason = "customer_request" }) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN"); await tx.query("SELECT pg_advisory_xact_lock(741901,5)");
    const video = (await tx.query("SELECT * FROM acd_video_sessions WHERE id=$1 FOR UPDATE", [videoSessionId])).rows[0];
    if (!video || ["ended", "failed"].includes(video.state)) throw fail("The conference has ended");
    if (video.work_item_id) { await tx.query("COMMIT"); return { ok: true, workItemId: video.work_item_id, roomId: video.room_id }; }
    const conversation = (await tx.query("SELECT * FROM acd_conversations WHERE id=$1", [video.conversation_id])).rows[0];
    const work = await createVideoWork(tx, { conversationId: video.conversation_id, existingSessionId: video.id,
      queueId: video.conference_config.routing.queueId, customerName: conversation.customer_name,
      attributes: { ...conversation.attributes, handoff: { source: "video_ai", summary: String(summary).slice(0, 8000), reason: String(reason).slice(0, 1000), videoSessionId } } });
    await videoEvent(tx, video.id, "ai.handoff", { workItemId: work.id, reason: String(reason).slice(0, 1000) });
    await tx.query("COMMIT");
    return { ok: true, workItemId: work.id, roomId: video.room_id };
  } catch (error) { await tx.query("ROLLBACK"); throw error; } finally { tx.release(); }
}
// Admission ID is public room context; bindingToken is private and delivered
// only through the authorized join endpoint. The bot never trusts a role/name
// supplied by another room participant.
export async function issueVideoMember(db, { videoSessionId, role, principalId }) {
  const id = randomUUID(), bindingToken = randomBytes(32).toString("base64url");
  await db.query("UPDATE cc_video_members SET revoked_at=now(),consent='{}'::jsonb WHERE video_session_id=$1 AND role=$2 AND principal_id=$3 AND revoked_at IS NULL AND participant_id IS NULL", [videoSessionId, role, principalId]);
  await db.query("INSERT INTO cc_video_members(id,video_session_id,role,principal_id,binding_hash) VALUES($1,$2,$3,$4,$5)", [id, videoSessionId, role, principalId, digest(bindingToken)]);
  return { admissionId: id, bindingToken };
}
export async function bindVideoMember(pool, { videoSessionId, role, principalId, admissionId, bindingToken, participantId }) {
  if (typeof participantId !== "string" || !participantId || participantId.length > 200
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(admissionId || "")
    || typeof bindingToken !== "string" || bindingToken.length > 100) throw fail("Invalid participant admission", 403);
  const tx=await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,814025))", [`${videoSessionId}:${role}:${principalId}`]);
    const valid=await tx.query(`SELECT id FROM cc_video_members WHERE id=$1 AND video_session_id=$2 AND role=$3 AND principal_id=$4 AND binding_hash=$5
      AND revoked_at IS NULL AND (participant_id=$6 OR participant_id IS NULL AND created_at>now()-interval '15 minutes') FOR UPDATE`, [admissionId, videoSessionId, role, principalId, digest(bindingToken), participantId]);
    if(!valid.rowCount)throw fail("Video participant admission expired",403);
    // Replace the active admission only when the new room participant has
    // actually joined. Preparing/cancelling a device move leaves it intact.
    await tx.query("UPDATE cc_video_members SET revoked_at=now(),consent='{}'::jsonb WHERE video_session_id=$1 AND role=$2 AND principal_id=$3 AND id<>$4 AND revoked_at IS NULL",[videoSessionId,role,principalId,admissionId]);
    await tx.query("UPDATE cc_video_members SET participant_id=$2 WHERE id=$1",[admissionId,participantId]);
    await tx.query("COMMIT");return {ok:true};
  } catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
}
export async function controlConferenceAi(pool, { video, role, principalId, body }) {
  const actor = `${role}:${principalId}`;
  if (body.action === "bind") return bindVideoMember(pool, { videoSessionId: video.id, role, principalId, admissionId: body.admissionId, bindingToken: body.bindingToken, participantId: body.participantId });
  if (body.action === "consent") {
    if (!["camera", "screen"].includes(body.source) || typeof body.enabled !== "boolean") throw fail("Choose a source and consent state", 400);
    const config = video.conference_config.ai?.vision;
    if (body.enabled && (config?.mode !== 'live' || !config.allowedSources.includes(`${role}-${body.source}`))) throw fail("This Vision source is disabled", 403);
    const changed = await pool.query(`UPDATE cc_video_members SET consent=jsonb_set(consent,ARRAY[$4::text],$5::jsonb)
      WHERE video_session_id=$1 AND role=$2 AND principal_id=$3 AND revoked_at IS NULL AND participant_id IS NOT NULL RETURNING id`, [video.id, role, principalId, body.source, JSON.stringify(body.enabled)]);
    if (!changed.rowCount) throw fail("Join the conference before sharing with Vision");
    await videoEvent(pool, video.id, "vision.consent", { actor, source: body.source, enabled: body.enabled });
    return { ok: true };
  }
  const human = (await pool.query("SELECT agent_id FROM acd_text_assignments WHERE work_item_id=$1 AND state='active' LIMIT 1", [video.work_item_id])).rows[0];
  if (role === "customer" && human) throw fail("The assigned agent controls the assistant after joining", 403);
  if (body.action === "invite") {
    if (role !== "agent") throw fail("Only the assigned agent may invite AI", 403);
    return requestConferenceAi(pool, { videoSessionId: video.id, assistantId: body.assistantId, invited: true });
  }
  if (body.action === "handoff") return conferenceHandoff(pool, { videoSessionId: video.id });
  if (["active", "muted", "stopped"].includes(body.action)) {
    await pool.query("UPDATE cc_video_ai_sessions SET desired_state=$2,updated_at=now() WHERE video_session_id=$1", [video.id, body.action]);
    await videoEvent(pool, video.id, "ai.control", { actor, state: body.action }); return { ok: true };
  }
  if (["vision-source", "analyze", "image"].includes(body.action)) {
    const config = video.conference_config.ai?.vision;
    if (!config || config.mode === "disabled" || process.env.VIDEO_VISION_ENABLED === "false") throw fail("Vision is disabled", 403);
    if (role === "agent" && !config.agentControls) throw fail("Agent Vision controls are disabled", 403);
    if (body.action === "vision-source") {
      if (body.automatic != null && typeof body.automatic !== "boolean" || body.sourceKey != null && (typeof body.sourceKey !== "string" || body.sourceKey.length > 500)) throw fail("Invalid Vision selection",400);
      if (config.mode !== "live") throw fail("Live Vision is disabled", 403);
      if (role === "agent" && !config.agentControls) throw fail("Agent Vision controls are disabled", 403);
      const state = await conferenceAiView(pool, video.id);
      if (body.sourceKey && !(state?.sources || []).some(s => s.key === body.sourceKey && s.consented && s.available && config.allowedSources.includes(s.type) && (role === "agent" || s.role === "customer"))) throw fail("This Vision source is unavailable", 403);
      await pool.query(`UPDATE cc_video_ai_sessions SET vision=vision||$2::jsonb,updated_at=now() WHERE video_session_id=$1`, [video.id, JSON.stringify({ requestedSourceKey: body.sourceKey || null, selection: body.automatic ? "automatic" : "manual", requestId: randomUUID() })]);
      await videoEvent(pool, video.id, "vision.selected", { actor, sourceKey: body.sourceKey || null, automatic: Boolean(body.automatic) }); return { ok: true };
    }
    const prompt = String(body.prompt || "Describe the current image.").slice(0, 2000);
    const current = await pool.query("SELECT 1 FROM cc_video_ai_sessions WHERE video_session_id=$1 AND desired_state='active' AND state IN ('connected','audio_only')", [video.id]);
    if (!current.rowCount) throw fail("Activate the assistant before requesting analysis");
    const payload = { prompt };
    if (body.action === "image") {
      const { visionImageFrame } = await import("./vision-policy.mjs");
      try { visionImageFrame(body.imageUrl); } catch (error) { throw fail(error.message, 400); } payload.imageUrl = body.imageUrl;
      const worker = (await pool.query(`SELECT w.control_url,w.control_token,a.generation FROM cc_video_ai_sessions a JOIN cc_video_ai_workers w ON w.id=a.lease_owner
        WHERE a.video_session_id=$1 AND a.lease_until>now() AND a.desired_state='active' AND w.heartbeat_at>now()-interval '15 seconds'`, [video.id])).rows[0];
      if (!worker?.control_url) throw fail("Activate the assistant before sending an image", 409);
      const response = await fetch(`${worker.control_url}/image`, { method: "POST", headers: { "Content-Type": "application/json", "x-video-worker-token": worker.control_token },
        body: JSON.stringify({ videoSessionId: video.id, generation: String(worker.generation), payload }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw fail("The assistant could not receive this image. Retry shortly.", 503);
      return { ok: true };
    }
    // Only text commands are persisted. Uploaded images travel directly to
    // worker memory, avoiding database WAL, backups and audit retention.
    const selected = await conferenceAiView(pool, video.id);
    if (!selected?.vision.effectiveSourceKey || selected.vision.transitioning || selected.vision.uploadStage) throw fail("Select an available Vision source before analysis");
    payload.sourceKey = selected.vision.effectiveSourceKey;
    const queued = await pool.query(`INSERT INTO cc_video_ai_commands(id,video_session_id,actor_id,kind,payload)
      SELECT $1,$2,$3,$4,$5::jsonb WHERE NOT EXISTS(SELECT 1 FROM cc_video_ai_commands WHERE video_session_id=$2 AND completed_at IS NULL AND expires_at>now())`, [randomUUID(), video.id, actor, body.action, JSON.stringify(payload)]);
    if (!queued.rowCount) throw fail("A visual analysis is already pending");
    return { ok: true };
  }
  throw fail("Unsupported video assistant action", 400);
}
export async function endConference(pool, videoSessionId, options = {}) {
  const video = (await pool.query("SELECT * FROM acd_video_sessions WHERE id=$1", [videoSessionId])).rows[0];
  if (!video) return;
  await pool.query("UPDATE cc_video_ai_sessions SET desired_state='stopped',updated_at=now() WHERE video_session_id=$1", [videoSessionId]);
  await pool.query("UPDATE cc_video_members SET revoked_at=now(),consent='{}'::jsonb WHERE video_session_id=$1 AND revoked_at IS NULL", [videoSessionId]);
  if (video.work_item_id) return endVideoRoom(pool, { workItemId: video.work_item_id, ...options });
  await pool.query("UPDATE acd_video_sessions SET state='ended',ended_at=COALESCE(ended_at,now()),updated_at=now() WHERE id=$1", [video.id]);
  await pool.query("UPDATE acd_conversations SET state='closed',closed_at=now() WHERE id=$1", [video.conversation_id]);
  const rooms = options.rooms || defaultRoomsClient();
  const sessionId = video.room_session_id || (video.room_id ? (await rooms.getRoom(video.room_id).catch(() => null))?.active_session_id : null);
  if (sessionId) await rooms.endSession(sessionId).catch(() => undefined);
}
