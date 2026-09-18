// Video channel lifecycle on top of ACD Core. Routing, offers, wrap-up and
// transfers are the native text lifecycle (lib/acd/text-lifecycle.mjs); this
// module owns the Telnyx room, its join tokens, the room webhooks and the
// recording artefacts (the internal documentation).
import { randomUUID } from "node:crypto";
import { appendEvent } from "../acd/events.mjs";
import { applyTransition, createWorkItem, openSegment } from "../acd/lifecycle.mjs";
import { endCustomerChat } from "../acd/text-lifecycle.mjs";
import { resolveWebhookBaseUrl } from "../webhook-base-url.mjs";
import { COMPOSITION_LAYOUTS, defaultRoomsClient } from "./rooms.mjs";

export const VIDEO_WEBHOOK_PATH = "/api/video/webhook";
export const VIDEO_RECORDING_PROVIDER = "telnyx_video";
export const VIDEO_ROOM_EVENT_TYPES = new Set([
  "video.room.session.started",
  "video.room.session.ended",
  "video.room.participant.joined",
  "video.room.participant.left",
  "video.room.recording.started",
  "video.room.recording.completed",
  "video.room.composition.completed",
]);
const TERMINAL_SESSION_STATES = new Set(["ended", "failed"]);
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

export function videoWebhookUrl({ env = process.env } = {}) {
  try {
    const url = new URL(`${resolveWebhookBaseUrl({ env })}${VIDEO_WEBHOOK_PATH}`);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// Stable playback URL: Telnyx download links are presigned for one hour, so
// history stores this proxy path and the route fetches a fresh link on demand.
export function videoRecordingStreamPath(providerId, kind = "composition") {
  const suffix = kind === "composition" ? "" : `?kind=${encodeURIComponent(kind)}`;
  return `/api/video/recordings/${encodeURIComponent(providerId)}/stream${suffix}`;
}

function parseContext(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function videoQueue(db, queueId) {
  const queue = (await db.query(`SELECT q.* FROM cc_queues q JOIN cc_queue_channels c
    ON c.queue_id=q.id AND c.channel='video' AND c.enabled=true WHERE q.id=$1 AND q.enabled=true`, [queueId])).rows[0];
  if (!queue) throw fail("This queue is not accepting video calls", 503);
  return queue;
}

// Caller owns the transaction. The room itself is created after commit
// (provisionVideoRoom): provider I/O never runs under the widget lock.
export async function createVideoWork(db, { conversationId = randomUUID(), queueId, customerName = "Website visitor", attributes = {}, actor = "widget", recording = {}, media = {} }) {
  const queue = await videoQueue(db, queueId);
  const name = String(customerName || "Website visitor").slice(0, 120);
  await db.query(`INSERT INTO acd_conversations(id,channel,customer_name,attributes) VALUES($1,'video',$2,$3::jsonb)`,
    [conversationId, name, JSON.stringify(attributes)]);
  const work = await createWorkItem(db, { channel: "video", direction: "inbound", queueId, conversationId,
    customerAddress: name, requiredSkills: queue.skill_requirements || {}, attributes, actor });
  await applyTransition(db, { workItemId: work.id, to: "queued", eventType: "work_item_queued",
    patch: { enqueuedAt: new Date().toISOString() }, actor });
  await openSegment(db, { workItemId: work.id, kind: "queue_wait", queueId });
  const layout = COMPOSITION_LAYOUTS.includes(recording.layout) ? recording.layout : "pip";
  await db.query(`INSERT INTO acd_video_sessions(work_item_id,conversation_id,recording_enabled,recording_layout,media)
    VALUES($1,$2,$3,$4,$5::jsonb)`, [work.id, conversationId, recording.enabled !== false, layout, JSON.stringify(media || {})]);
  return { ...work, conversation_id: conversationId };
}

export async function readVideoSession(db, workItemId) {
  return (await db.query("SELECT * FROM acd_video_sessions WHERE work_item_id=$1", [workItemId])).rows[0] || null;
}

export async function provisionVideoRoom(pool, { workItemId, rooms = defaultRoomsClient() }) {
  const current = await readVideoSession(pool, workItemId);
  if (!current) throw fail("Video session not found", 404);
  if (current.room_id) return current;
  if (TERMINAL_SESSION_STATES.has(current.state)) throw fail("Video session has ended");
  const room = await rooms.createRoom({
    uniqueName: `cc-video-${workItemId}`,
    enableRecording: current.recording_enabled,
    webhookUrl: videoWebhookUrl(),
  });
  const claimed = await pool.query(`UPDATE acd_video_sessions SET room_id=$2,state='waiting',updated_at=now()
    WHERE work_item_id=$1 AND room_id IS NULL RETURNING *`, [workItemId, room.id]);
  if (!claimed.rowCount) {
    // A concurrent start already attached a room; this one is surplus.
    await rooms.deleteRoom(room.id).catch(() => undefined);
    return readVideoSession(pool, workItemId);
  }
  await appendEvent(pool, { workItemId, type: "video_room_created", actor: "video",
    payload: { room_id: room.id, recording_enabled: current.recording_enabled, recording_layout: current.recording_layout } });
  return claimed.rows[0];
}

async function joinableSession(pool, workItemId) {
  const session = await readVideoSession(pool, workItemId);
  if (!session) throw fail("Video session not found", 404);
  if (TERMINAL_SESSION_STATES.has(session.state)) throw fail("Video session has ended");
  if (!session.room_id) throw fail("Video room is not ready yet", 409);
  return session;
}

export async function customerJoinToken(pool, { workItemId, rooms = defaultRoomsClient() }) {
  const session = await joinableSession(pool, workItemId);
  return { roomId: session.room_id, ...(await rooms.generateJoinToken(session.room_id)) };
}

async function requireActiveAssignment(pool, workItemId, agentId) {
  const owned = await pool.query(`SELECT 1 FROM acd_text_assignments WHERE work_item_id=$1 AND agent_id=$2 AND state='active'`, [workItemId, agentId]);
  if (!owned.rowCount) throw fail("Accept the video call before joining", 403);
}

export async function agentJoinToken(pool, { workItemId, agentId, rooms = defaultRoomsClient() }) {
  await requireActiveAssignment(pool, workItemId, agentId);
  const session = await joinableSession(pool, workItemId);
  return { roomId: session.room_id, ...(await rooms.generateJoinToken(session.room_id)) };
}

// The visitor refreshes with the widget session token (checked by the caller);
// an agent must still own the active assignment, so a transferred-away agent
// cannot keep minting tokens with a refresh token they remember; a supervisor
// must still be the one supervising the session.
export async function refreshJoinToken(pool, { workItemId, refreshToken, agentId = null, supervisorId = null, rooms = defaultRoomsClient() }) {
  if (typeof refreshToken !== "string" || !refreshToken) throw fail("Refresh token is required", 400);
  if (agentId) await requireActiveAssignment(pool, workItemId, agentId);
  const session = await joinableSession(pool, workItemId);
  if (supervisorId && String(session.supervision?.supervisorId || "") !== String(supervisorId)) throw fail("You are not supervising this video call", 403);
  return { roomId: session.room_id, ...(await rooms.refreshJoinToken(session.room_id, refreshToken)) };
}

// ------------------------------------------------------------- supervision
//
// A supervisor joins the room as a third participant with the mode in the
// join context; the clients decide per receiver what they subscribe to
// (the internal documentation §2). One supervisor per session.
export const SUPERVISION_MODES = ["monitor", "whisper", "barge"];

function supervisionView(session) {
  const supervision = session?.supervision;
  return supervision?.mode ? { mode: supervision.mode, name: supervision.name || null, supervisorId: supervision.supervisorId || null, startedAt: supervision.startedAt || null } : null;
}

export async function startVideoSupervision(pool, { workItemId, supervisorId, name = "Supervisor", mode, rooms = defaultRoomsClient() }) {
  if (!SUPERVISION_MODES.includes(mode)) throw fail("Invalid supervision mode", 400);
  const session = await joinableSession(pool, workItemId);
  if (session.state !== "active") throw fail("The video call is not active yet", 409);
  if (session.supervision?.supervisorId && String(session.supervision.supervisorId) !== String(supervisorId)) throw fail("Another supervisor is already on this call", 409);
  // The token comes first so a provider failure leaves no phantom supervisor;
  // the seat is then claimed atomically (the same supervisor may re-claim
  // their own seat, e.g. after a failed join). The supervision id travels in
  // the join context so a late "left" webhook of an earlier supervisor cannot
  // clear a newer one.
  const token = await rooms.generateJoinToken(session.room_id);
  const supervision = { id: randomUUID(), supervisorId: String(supervisorId), name: String(name || "Supervisor").slice(0, 120), mode, startedAt: new Date().toISOString() };
  // The seat and its start event commit together: a failed event append
  // must not leave a claimed seat nobody records.
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const claimed = await tx.query(`UPDATE acd_video_sessions SET supervision=$2::jsonb, updated_at=now()
      WHERE work_item_id=$1 AND (supervision IS NULL OR supervision->>'supervisorId'=$3) RETURNING work_item_id`, [workItemId, JSON.stringify(supervision), String(supervisorId)]);
    if (!claimed.rowCount) throw fail("Another supervisor is already on this call", 409);
    await appendEvent(tx, { workItemId, type: "video_supervision_started", actor: `supervisor:${supervisorId}`, payload: { room_id: session.room_id, mode, supervisor_id: String(supervisorId), supervision_id: supervision.id } });
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
  return { roomId: session.room_id, ...token, context: { role: "supervisor", name: supervision.name, mode, supervisionId: supervision.id }, supervision: supervisionView({ supervision }) };
}

export async function setVideoSupervisionMode(pool, { workItemId, supervisorId, supervisionId = null, mode }) {
  if (!SUPERVISION_MODES.includes(mode)) throw fail("Invalid supervision mode", 400);
  const session = await readVideoSession(pool, workItemId);
  if (!session?.supervision?.mode || String(session.supervision.supervisorId) !== String(supervisorId)) throw fail("You are not supervising this video call", 409);
  // An older tab of the same supervisor holds a superseded seat id.
  if (supervisionId && String(session.supervision.id) !== String(supervisionId)) throw fail("This supervision session was replaced by a newer one", 409);
  const supervision = { ...session.supervision, mode };
  // Conditional on the seat read above: a seat re-claimed by someone else in
  // the meantime must not be overwritten with this supervisor's copy.
  const changed = await pool.query(`UPDATE acd_video_sessions SET supervision=$2::jsonb, updated_at=now()
    WHERE work_item_id=$1 AND supervision->>'id'=$3 AND supervision->>'supervisorId'=$4 RETURNING work_item_id`,
    [workItemId, JSON.stringify(supervision), String(session.supervision.id || ""), String(supervisorId)]);
  if (!changed.rowCount) throw fail("You are not supervising this video call", 409);
  await appendEvent(pool, { workItemId, type: "video_supervision_mode", actor: `supervisor:${supervisorId}`, payload: { room_id: session.room_id, mode, previous_mode: session.supervision.mode } });
  return supervisionView({ supervision });
}

// `supervisionId` (from the start response) ends only that seat: a closed
// older tab of the same supervisor cannot end a newer session.
export async function endVideoSupervision(pool, { workItemId, supervisorId = null, supervisionId = null, reason = "left" }) {
  const session = await readVideoSession(pool, workItemId);
  if (!session?.supervision?.mode) return null;
  if (supervisorId && String(session.supervision.supervisorId) !== String(supervisorId)) throw fail("You are not supervising this video call", 409);
  if (supervisionId && String(session.supervision.id) !== String(supervisionId)) return null;
  const cleared = await pool.query("UPDATE acd_video_sessions SET supervision=NULL, updated_at=now() WHERE work_item_id=$1 AND supervision->>'id'=$2 RETURNING work_item_id", [workItemId, String(session.supervision.id)]);
  if (!cleared.rowCount) return null;
  await appendEvent(pool, { workItemId, type: "video_supervision_ended", actor: supervisorId ? `supervisor:${supervisorId}` : "video",
    payload: { room_id: session.room_id, mode: session.supervision.mode, supervisor_id: session.supervision.supervisorId || null, reason } });
  return supervisionView(session);
}

// Telnyx answers 422 "No private_ip for room" once the session is no longer
// on a media node: it already ended (from the API, or because everyone left).
function sessionAlreadyEnded(error) {
  return error?.status === 404 || (error?.providerStatus === 422 && /private_ip/i.test(error?.message || ""));
}

// Best effort: the ACD side has already ended the work; kicking the room
// only makes the other participant's client notice immediately. Both sides
// race here (the agent's disconnect and the visitor's leave land within
// milliseconds), so the end is claimed atomically and only the winner talks
// to the provider.
export async function endVideoRoom(pool, { workItemId, rooms = defaultRoomsClient(), actor = "system", reason = "ended" }) {
  const claimed = (await pool.query(`UPDATE acd_video_sessions SET state=CASE WHEN state IN ('ended','failed') THEN state ELSE 'ended' END,
    ended_at=now(),updated_at=now() WHERE work_item_id=$1 AND ended_at IS NULL RETURNING *`, [workItemId])).rows[0];
  if (!claimed) return readVideoSession(pool, workItemId);
  if (claimed.room_session_id) {
    try { await rooms.endSession(claimed.room_session_id); }
    catch (error) { if (!sessionAlreadyEnded(error)) console.warn("[video] end room session failed:", error?.message || error); }
  }
  await appendEvent(pool, { workItemId, type: "video_room_ended", actor, payload: { room_id: claimed.room_id, room_session_id: claimed.room_session_id, reason } });
  return claimed;
}

// ---------------------------------------------------------------- webhooks

function upsertParticipant(list, payload, patch) {
  const id = payload.participant_id;
  const context = parseContext(payload.context);
  const existing = list.find((item) => item.participant_id === id);
  const next = { participant_id: id, role: context.role || existing?.role || "customer", name: context.name || existing?.name || null, ...existing, ...patch };
  return existing ? list.map((item) => (item.participant_id === id ? next : item)) : [...list, next];
}

function upsertRecording(list, payload, patch) {
  const id = payload.recording_id;
  const existing = list.find((item) => item.recording_id === id);
  const next = { recording_id: id, participant_id: payload.participant_id || existing?.participant_id || null,
    type: payload.type || existing?.type || null, ...existing, ...patch };
  return existing ? list.map((item) => (item.recording_id === id ? next : item)) : [...list, next];
}

function compositionSources(session) {
  const roles = new Map((session.participants || []).map((item) => [item.participant_id, item.role]));
  const videos = (session.recordings || []).filter((item) => item.type === "video" && item.status === "completed");
  const customer = videos.find((item) => roles.get(item.participant_id) === "customer");
  const agent = videos.find((item) => roles.get(item.participant_id) === "agent" && item !== customer);
  const main = customer || videos[0] || null;
  const secondary = agent || videos.find((item) => item !== main) || null;
  return { videos, main, secondary };
}

function recordingFormat(codec) {
  if (!codec) return null;
  const lower = String(codec).toLowerCase();
  if (lower === "opus") return "ogg";
  if (lower === "vp8" || lower === "vp9") return "webm";
  if (lower === "h264") return "mp4";
  return lower;
}

async function persistVideoArtifact(db, { session, providerRecordingId, kind, format, sourceEventId, startedAt, endedAt, metadata }) {
  const existing = await db.query("SELECT id FROM acd_recordings WHERE source_event_id=$1", [sourceEventId]);
  if (existing.rowCount) return { id: existing.rows[0].id, created: false };
  const id = randomUUID();
  const url = videoRecordingStreamPath(providerRecordingId, kind);
  const saved = await db.query(
    `INSERT INTO acd_recordings
       (id, work_item_id, provider, provider_recording_id, source_event_id, provider_session_id, format,
        channels, recording_url, recording_urls, started_at, ended_at, provider_metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13::jsonb)
     ON CONFLICT (provider, provider_recording_id) WHERE provider_recording_id IS NOT NULL DO UPDATE SET
       format = COALESCE(EXCLUDED.format, acd_recordings.format),
       recording_url = EXCLUDED.recording_url,
       recording_urls = EXCLUDED.recording_urls,
       started_at = COALESCE(acd_recordings.started_at, EXCLUDED.started_at),
       ended_at = COALESCE(acd_recordings.ended_at, EXCLUDED.ended_at),
       provider_metadata = acd_recordings.provider_metadata || EXCLUDED.provider_metadata,
       updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [id, session.work_item_id, VIDEO_RECORDING_PROVIDER, providerRecordingId, sourceEventId, session.room_session_id,
      format, JSON.stringify(kind === "composition" ? "mixed" : "single"), url, JSON.stringify({ [format || "file"]: url }),
      startedAt, endedAt, JSON.stringify({ kind, room_id: session.room_id, room_session_id: session.room_session_id, ...metadata })],
  );
  const row = saved.rows[0];
  await appendEvent(db, { workItemId: session.work_item_id, type: "recording_saved", actor: "video",
    payload: { recording_id: row.id, provider: VIDEO_RECORDING_PROVIDER, provider_recording_id: providerRecordingId, kind, format, source_event_id: sourceEventId } });
  return { id: row.id, created: Boolean(row.inserted) };
}

// Audio-only sessions have nothing to compose: keep each participant's audio
// file as its own artefact so history still offers playback.
async function persistParticipantAudio(pool, session) {
  const audio = (session.recordings || []).filter((item) => item.type === "audio" && item.status === "completed");
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    for (const item of audio) {
      const role = (session.participants || []).find((p) => p.participant_id === item.participant_id)?.role || null;
      await persistVideoArtifact(tx, { session, providerRecordingId: item.recording_id, kind: "recording", format: recordingFormat(item.codec),
        sourceEventId: `video-recording:${item.recording_id}`, startedAt: iso(item.started_at), endedAt: iso(item.completed_at || item.ended_at),
        metadata: { participant_id: item.participant_id, role, codec: item.codec, duration_secs: item.duration_secs, size_mb: item.size_mb } });
    }
    await tx.query(`UPDATE acd_video_sessions SET composition_state='skipped_audio_only',updated_at=now() WHERE work_item_id=$1`, [session.work_item_id]);
    await tx.query("COMMIT");
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}

async function requestVideoComposition(pool, session, { rooms }) {
  const { videos, main, secondary } = compositionSources(session);
  if (!videos.length) return persistParticipantAudio(pool, session);
  try {
    const composition = await rooms.createComposition({ sessionId: session.room_session_id, layout: session.recording_layout,
      main: main.recording_id, secondary: secondary?.recording_id || null, webhookUrl: videoWebhookUrl() });
    await pool.query(`UPDATE acd_video_sessions SET composition_id=$2,composition_state=$3,composition_error=NULL,updated_at=now() WHERE work_item_id=$1`,
      [session.work_item_id, composition.id, composition.status || "enqueued"]);
    await appendEvent(pool, { workItemId: session.work_item_id, type: "video_composition_requested", actor: "video",
      payload: { composition_id: composition.id, layout: session.recording_layout, sources: videos.map((item) => item.recording_id) } });
  } catch (error) {
    await pool.query(`UPDATE acd_video_sessions SET composition_state='failed',composition_error=$2,updated_at=now() WHERE work_item_id=$1`,
      [session.work_item_id, String(error?.message || error).slice(0, 500)]);
    console.warn("[video] composition request failed:", error?.message || error);
  }
}

export async function applyVideoRoomEvent(pool, event, { rooms = defaultRoomsClient() } = {}) {
  const type = event?.eventType || "";
  const payload = event?.payload || {};
  if (!VIDEO_ROOM_EVENT_TYPES.has(type)) return { handled: false, reason: "unsupported_event" };
  const occurredAt = iso(event.occurredAt) || new Date().toISOString();
  const tx = await pool.connect();
  let compose = null;
  try {
    await tx.query("BEGIN");
    // Same lock order as the routing and text lifecycle paths: a session end
    // may cancel offers or start the agent's wrap-up.
    await tx.query("SELECT pg_advisory_xact_lock(741901,5)");
    const session = type === "video.room.composition.completed"
      ? (await tx.query("SELECT * FROM acd_video_sessions WHERE composition_id=$1 FOR UPDATE", [payload.composition_id || null])).rows[0]
      : (await tx.query("SELECT * FROM acd_video_sessions WHERE room_id=$1 FOR UPDATE", [payload.room_id || null])).rows[0];
    if (!session) { await tx.query("ROLLBACK"); return { handled: false, reason: "unknown_room" }; }
    const work = (await tx.query("SELECT * FROM acd_work_items WHERE id=$1 FOR UPDATE", [session.work_item_id])).rows[0];
    const next = { state: session.state, room_session_id: session.room_session_id, started_at: session.started_at, ended_at: session.ended_at,
      participants: session.participants || [], recordings: session.recordings || [], composition_state: session.composition_state };
    if (type === "video.room.session.started") {
      next.room_session_id = payload.session_id || next.room_session_id;
      next.started_at = next.started_at || occurredAt;
      if (next.state === "starting") next.state = "waiting";
    } else if (type === "video.room.participant.joined") {
      next.room_session_id = payload.session_id || next.room_session_id;
      next.participants = upsertParticipant(next.participants, payload, { joined_at: occurredAt, left_at: null });
      const role = parseContext(payload.context).role;
      if (role === "agent" && !TERMINAL_SESSION_STATES.has(next.state)) next.state = "active";
    } else if (type === "video.room.participant.left") {
      next.participants = upsertParticipant(next.participants, payload, { left_at: occurredAt, left_reason: payload.left_reason || null, duration_secs: payload.duration_secs ?? null });
      const leftContext = parseContext(payload.context);
      if (leftContext.role === "supervisor" && session.supervision?.mode && leftContext.supervisionId === session.supervision.id) {
        await tx.query("UPDATE acd_video_sessions SET supervision=NULL WHERE work_item_id=$1", [session.work_item_id]);
        await appendEvent(tx, { workItemId: session.work_item_id, type: "video_supervision_ended", actor: "video",
          payload: { room_id: session.room_id, mode: session.supervision.mode, supervisor_id: session.supervision.supervisorId || null, reason: payload.left_reason || "left" } });
      }
    } else if (type === "video.room.recording.started") {
      next.recordings = upsertRecording(next.recordings, payload, { status: "started", started_at: occurredAt });
    } else if (type === "video.room.recording.completed") {
      next.recordings = upsertRecording(next.recordings, payload, { status: "completed", codec: payload.codec || null, duration_secs: payload.duration_secs ?? null,
        size_mb: payload.size_mb ?? null, completed_at: occurredAt });
    } else if (type === "video.room.session.ended") {
      next.state = TERMINAL_SESSION_STATES.has(next.state) ? next.state : "ended";
      next.ended_at = next.ended_at || occurredAt;
      // The media session is over: finish the work item unless ACD already did.
      if (work && !work.terminal_at) await endCustomerChat(tx, work);
      await appendEvent(tx, { workItemId: session.work_item_id, type: "video_session_ended", actor: "video",
        payload: { room_id: session.room_id, room_session_id: next.room_session_id, ended_reason: payload.ended_reason || null, duration_secs: payload.duration_secs ?? null } });
    } else if (type === "video.room.composition.completed") {
      next.composition_state = "completed";
      const composition = payload.composition_id ? await rooms.getComposition(payload.composition_id).catch(() => null) : null;
      await persistVideoArtifact(tx, { session, providerRecordingId: payload.composition_id, kind: "composition", format: "mp4",
        sourceEventId: event.eventId || `video-composition:${payload.composition_id}`, startedAt: iso(session.started_at), endedAt: iso(session.ended_at),
        metadata: { layout: session.recording_layout, duration_secs: composition?.duration_secs ?? payload.duration_secs ?? null,
          size_mb: composition?.size_mb ?? payload.size_mb ?? null, resolution: composition?.resolution || null,
          recordings: (session.recordings || []).map(({ recording_id, participant_id, type: kind, codec, duration_secs }) => ({ recording_id, participant_id, type: kind, codec, duration_secs })) } });
    }
    const allDone = next.recordings.length > 0 && next.recordings.every((item) => item.status === "completed");
    if (session.recording_enabled && next.state === "ended" && !session.composition_id && !next.composition_state && allDone) {
      next.composition_state = "requesting";
      compose = true;
    }
    const updated = (await tx.query(`UPDATE acd_video_sessions SET state=$2,room_session_id=$3,started_at=$4,ended_at=$5,participants=$6::jsonb,
      recordings=$7::jsonb,composition_state=$8,updated_at=now() WHERE work_item_id=$1 RETURNING *`,
      [session.work_item_id, next.state, next.room_session_id, next.started_at, next.ended_at, JSON.stringify(next.participants),
        JSON.stringify(next.recordings), next.composition_state])).rows[0];
    await tx.query("COMMIT");
    if (compose) await requestVideoComposition(pool, updated, { rooms });
    return { handled: true, workItemId: session.work_item_id, state: updated.state, composition: compose ? "requested" : updated.composition_state };
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}

// ---------------------------------------------------------------- readers

async function conversationWork(db, conversationId) {
  return (await db.query(`SELECT w.*,c.state AS conversation_state,c.customer_name FROM acd_work_items w
    JOIN acd_conversations c ON c.id=w.conversation_id WHERE w.conversation_id=$1 ORDER BY w.created_at DESC LIMIT 1`, [conversationId])).rows[0] || null;
}

// Handoff-style status for the widget: waiting in queue, agent assigned
// (offer ringing), connected (assignment active) or disconnected.
export async function readVideoWidgetState(db, session) {
  const work = await conversationWork(db, session.conversation_id);
  if (!work) return { runtimeKind: "video", session: { id: session.id, status: session.runtime_state }, handoff: { status: "disconnected" }, room: null };
  const video = await readVideoSession(db, work.id);
  const assignment = (await db.query(`SELECT a.*,u.first_name,u.last_name FROM acd_text_assignments a
    JOIN acd_segments s ON s.id=a.segment_id LEFT JOIN users u ON u.id=a.agent_id
    WHERE a.work_item_id=$1 AND a.state='active' AND s.outcome IS DISTINCT FROM 'transferred'
    ORDER BY s.seq DESC LIMIT 1`, [work.id])).rows[0];
  const offer = (await db.query(`SELECT o.*,u.first_name,u.last_name FROM acd_offers o LEFT JOIN users u ON u.id=o.agent_id
    WHERE o.work_item_id=$1 AND o.state IN ('created','ringing') ORDER BY o.created_at DESC LIMIT 1`, [work.id])).rows[0];
  const queue = (await db.query("SELECT name FROM cc_queues WHERE id=$1", [work.queue_id])).rows[0];
  const agent = assignment || offer;
  const closed = Boolean(work.terminal_at) || work.conversation_state === "closed" || ["completed", "failed"].includes(session.runtime_state)
    || TERMINAL_SESSION_STATES.has(video?.state);
  const status = closed ? "disconnected" : assignment ? "connected" : offer ? "assigned" : "waiting";
  return {
    runtimeKind: "video",
    session: { id: session.id, status: session.runtime_state },
    workItemId: work.id,
    room: { id: video?.room_id || null, ready: Boolean(video?.room_id), state: video?.state || null, recording: Boolean(video?.recording_enabled) },
    // Only the mode: the widget adjusts its subscriptions (a barging supervisor becomes a tile).
    supervision: video?.supervision?.mode ? { mode: video.supervision.mode, name: video.supervision.mode === "barge" ? video.supervision.name || null : null } : null,
    handoff: {
      status,
      queueName: queue?.name || "Support",
      agentName: agent ? [agent.first_name, agent.last_name].filter(Boolean).join(" ") || "Agent" : null,
      agentAssigned: Boolean(agent),
      agentConnected: Boolean(assignment),
    },
  };
}

export async function readVideoDetail(db, { workItemId, agentId }) {
  const work = (await db.query(`SELECT w.* FROM acd_work_items w WHERE w.id=$1 AND w.channel='video' AND
    (EXISTS(SELECT 1 FROM acd_offers o WHERE o.work_item_id=w.id AND o.agent_id=$2 AND o.state IN ('created','ringing','accepted'))
      OR EXISTS(SELECT 1 FROM acd_text_assignments a JOIN acd_segments s ON s.id=a.segment_id
        WHERE a.work_item_id=w.id AND a.agent_id=$2 AND ((a.state IN ('active','wrapup') AND s.outcome IS DISTINCT FROM 'transferred') OR w.terminal_at IS NOT NULL)))`,
    [workItemId, agentId])).rows[0];
  if (!work) throw fail("Video call not found or not assigned to you", 403);
  const video = await readVideoSession(db, workItemId);
  const conversation = (await db.query("SELECT customer_name FROM acd_conversations WHERE id=$1", [work.conversation_id])).rows[0];
  const assignment = (await db.query(`SELECT state FROM acd_text_assignments WHERE work_item_id=$1 AND agent_id=$2 AND state<>'completed' LIMIT 1`, [workItemId, agentId])).rows[0];
  const queue = (await db.query("SELECT name FROM cc_queues WHERE id=$1", [work.queue_id])).rows[0];
  const agent = (await db.query("SELECT first_name,last_name,profile_picture_uri FROM users WHERE id=$1", [agentId])).rows[0];
  return {
    work,
    customerName: conversation?.customer_name || work.customer_address || "Website visitor",
    queueName: queue?.name || null,
    agent,
    assignmentState: assignment?.state || null,
    video: video ? { roomId: video.room_id, roomSessionId: video.room_session_id, state: video.state, participants: video.participants || [],
      recordingEnabled: video.recording_enabled, recordingLayout: video.recording_layout, media: video.media || {}, supervision: supervisionView(video) } : null,
    context: work.attributes?.context || {},
  };
}
