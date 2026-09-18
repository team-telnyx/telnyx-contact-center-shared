import { randomUUID } from "node:crypto";
import { hashSessionToken, widgetSessionToken } from "./session-tokens.js";
import { getWidgetSession } from "./sessions.js";
import { endCustomerChat } from "../acd/text-lifecycle.mjs";
import { createVideoWork, customerJoinToken, endVideoRoom, provisionVideoRoom, readVideoWidgetState, refreshJoinToken } from "../video/lifecycle.mjs";
import { defaultRoomsClient } from "../video/rooms.mjs";
import { contactCenterRuntimeLogger } from "../runtime-logging.mjs";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
// A video visitor polls every couple of seconds; a browser that vanishes
// leaves the queue quickly instead of holding an agent slot for the chat TTL.
const VIDEO_SESSION_MINUTES = 2;

async function latestWork(db, conversationId, { lock = false } = {}) {
  return (await db.query(`SELECT * FROM acd_work_items WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1 ${lock ? "FOR UPDATE" : ""}`, [conversationId])).rows[0] || null;
}

// Caller owns the transaction (prepareWidgetSession). The room is created after
// commit by initializeVideoWidgetSession, mirroring the AI chat bootstrap.
export async function createVideoWidgetSession(tx, { widget, decision, claims, clientKey, admissionKey, context }) {
  const video = decision.config.channels.video;
  if (!video?.routing?.queueId) throw fail("Select a Contact Center video queue before enabling this channel", 503);
  const customerName = decision.matchedRule?.actions.some((action) => action.type === "customer-label")
    ? decision.customerLabel
    : String(context["customer.name"] || context.customer_name || "Website visitor");
  const work = await createVideoWork(tx, {
    queueId: video.routing.queueId,
    customerName,
    attributes: { widget_id: widget.id, widget_revision_id: widget.revision_id, context, origin: claims.org, media: "video" },
    recording: { enabled: video.recording.enabled, layout: video.recording.layout },
    media: { camera: video.camera, screenShare: video.allowScreenShare },
  });
  const id = randomUUID(), token = widgetSessionToken(id);
  await tx.query(`INSERT INTO cc_widget_sessions(id,token_hash,widget_id,revision_id,conversation_id,origin,client_key,expires_at,
      runtime_kind,context,runtime_state,admission_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::text||' minutes')::interval,'video',$9::jsonb,'starting',$10)`,
    [id, hashSessionToken(token), widget.id, widget.revision_id, work.conversation_id, claims.org, clientKey, VIDEO_SESSION_MINUTES, JSON.stringify(context), admissionKey]);
  const session = await getWidgetSession(tx, token);
  return { sessionToken: token, ...(await readVideoWidgetState(tx, session)) };
}

// Only the creator of the committed session calls this. A provider failure
// abandons the queued work item so no agent is offered a room that does not exist.
export async function initializeVideoWidgetSession(pool, token, { rooms = defaultRoomsClient() } = {}) {
  const session = await getWidgetSession(pool, token);
  const work = await latestWork(pool, session.conversation_id);
  if (!work) throw fail("Video session not found", 404);
  try {
    await provisionVideoRoom(pool, { workItemId: work.id, rooms });
    await pool.query(`UPDATE cc_widget_sessions SET runtime_state='active',expires_at=now()+($2::text||' minutes')::interval,last_seen_at=now()
      WHERE id=$1 AND runtime_state='starting'`, [session.id, VIDEO_SESSION_MINUTES]);
  } catch (error) {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const locked = await latestWork(tx, session.conversation_id, { lock: true });
      if (locked && !locked.terminal_at) await endCustomerChat(tx, locked);
      await tx.query("UPDATE acd_video_sessions SET state='failed',updated_at=now() WHERE work_item_id=$1", [work.id]);
      await tx.query("UPDATE cc_widget_sessions SET runtime_state='failed' WHERE id=$1", [session.id]);
      await tx.query("COMMIT");
    } catch (rollbackError) { await tx.query("ROLLBACK").catch(() => undefined); contactCenterRuntimeLogger.warn("video_session_cleanup_failed", { error: rollbackError?.message || String(rollbackError) }); }
    finally { tx.release(); }
    throw error;
  }
  return { sessionToken: token, ...(await readVideoWidgetState(pool, await getWidgetSession(pool, token))) };
}

async function requireVideoSession(pool, token, { lock = false } = {}) {
  const session = await getWidgetSession(pool, token, { lock });
  if (session.runtime_kind !== "video") throw fail("Video session required", 409);
  return session;
}

// Polls keep the visitor alive; a terminal session still expires on its own.
export async function videoWidgetState(pool, token) {
  const session = await requireVideoSession(pool, token);
  await pool.query(`UPDATE cc_widget_sessions SET expires_at=now()+($2::text||' minutes')::interval,last_seen_at=now()
    WHERE id=$1 AND runtime_state='active'`, [session.id, VIDEO_SESSION_MINUTES]);
  return readVideoWidgetState(pool, session);
}

export async function videoWidgetJoin(pool, token, { rooms = defaultRoomsClient() } = {}) {
  const session = await requireVideoSession(pool, token);
  if (session.runtime_state !== "active") throw fail("Video session is not active", 409);
  const work = await latestWork(pool, session.conversation_id);
  if (!work || work.terminal_at) throw fail("Video session has ended", 409);
  const join = await customerJoinToken(pool, { workItemId: work.id, rooms });
  return { ...(await readVideoWidgetState(pool, session)), join };
}

export async function videoWidgetRefreshToken(pool, token, { refreshToken, rooms = defaultRoomsClient() } = {}) {
  const session = await requireVideoSession(pool, token);
  const work = await latestWork(pool, session.conversation_id);
  if (!work || work.terminal_at) throw fail("Video session has ended", 409);
  return { join: await refreshJoinToken(pool, { workItemId: work.id, refreshToken, rooms }) };
}

export async function videoWidgetLeave(pool, token, { rooms = defaultRoomsClient() } = {}) {
  const tx = await pool.connect();
  let workItemId = null;
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(741901,5)");
    const initial = await requireVideoSession(tx, token);
    const work = await latestWork(tx, initial.conversation_id, { lock: true });
    const session = await requireVideoSession(tx, token, { lock: true });
    if (work && !work.terminal_at) await endCustomerChat(tx, work);
    workItemId = work?.id || null;
    await tx.query("UPDATE cc_widget_sessions SET runtime_state='completed',last_seen_at=now() WHERE id=$1 AND runtime_state IN ('starting','active')", [session.id]);
    await tx.query("COMMIT");
  } catch (error) { await tx.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { tx.release(); }
  if (workItemId) await endVideoRoom(pool, { workItemId, rooms, actor: "customer", reason: "customer_left" }).catch(() => undefined);
  return readVideoWidgetState(pool, await getWidgetSession(pool, token));
}
