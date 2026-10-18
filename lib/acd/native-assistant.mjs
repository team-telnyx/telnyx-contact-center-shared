import {
  applyTransition,
  openSegment,
  closeOpenSegment,
} from "./lifecycle.mjs";
import { releaseReservation } from "./reservations.mjs";

// Native AI WebRTC is not a Call Control leg: the SDK exposes no provider IDs.
// Its authenticated device owns this media session. Terminal updates are emitted
// only after the adapter has stopped local media, never on app backgrounding.
// A provider-enforced maximum duration provides crash recovery independently of
// foreground heartbeats; the setup window and delivery margin are included.
export async function updateNativeAssistant(
  pool,
  agentId,
  input,
  { expiredOnly = false } = {},
) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const row = (
      await db.query(
        `SELECT d.*,w.attributes FROM acd_direct_intents d JOIN acd_work_items w ON w.id=d.work_item_id
      WHERE d.id=$1 AND d.agent_id=$2 AND d.purpose='native_ai' FOR UPDATE OF d`,
        [input.id, agentId],
      )
    ).rows[0];
    if (
      !row ||
      (!expiredOnly &&
        row.attributes?.native_auth_session_id !== input.authSessionId)
    )
      throw Object.assign(Error("Assistant session not found."), {
        status: 404,
      });
    if (row.state === "ended") {
      await db.query("COMMIT");
      return { ended: true };
    }
    if (
      expiredOnly &&
      !(Date.parse(row.attributes?.native_deadline) <= Date.now())
    ) {
      await db.query("COMMIT");
      return { ended: false };
    }
    const work = (
      await db.query(
        "SELECT state FROM acd_work_items WHERE id=$1 FOR UPDATE",
        [row.work_item_id],
      )
    ).rows[0];
    if (input.state === "active" && work?.state === "offered") {
      await db.query(
        "UPDATE acd_direct_intents SET state='active' WHERE id=$1",
        [row.id],
      );
      await applyTransition(db, {
        workItemId: row.work_item_id,
        to: "active",
        eventType: "native_assistant_started",
        actor: `agent:${agentId}`,
        payload: { agent_id: agentId },
      });
      await openSegment(db, {
        workItemId: row.work_item_id,
        kind: "agent",
        agentId,
        answeredAt: new Date().toISOString(),
      });
    }
    if (input.state === "ended") {
      await db.query(
        "UPDATE acd_direct_intents SET state='ended',ended_at=now() WHERE id=$1",
        [row.id],
      );
      await closeOpenSegment(db, row.work_item_id, {
        outcome: work?.state === "active" ? "completed" : "failed",
      });
      await applyTransition(db, {
        workItemId: row.work_item_id,
        to: work?.state === "active" ? "completed" : "failed",
        eventType: "native_assistant_ended",
        actor: expiredOnly ? "provider:duration_limit" : `device:${agentId}`,
      });
      await releaseReservation(
        db,
        row.reservation_id,
        "native_assistant_ended",
        {
          actor: expiredOnly ? "provider:duration_limit" : `device:${agentId}`,
        },
      );
    }
    await db.query("COMMIT");
    return { ended: input.state === "ended" };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

export async function reconcileNativeAssistants(pool) {
  const rows = (
    await pool.query(`SELECT d.id,d.agent_id FROM acd_direct_intents d JOIN acd_work_items w ON w.id=d.work_item_id
    WHERE d.purpose='native_ai' AND d.state<>'ended' AND w.attributes->>'native_deadline' IS NOT NULL
    AND (w.attributes->>'native_deadline')::timestamptz < now() ORDER BY d.created_at LIMIT 20`)
  ).rows;
  for (const row of rows)
    await updateNativeAssistant(
      pool,
      row.agent_id,
      { id: row.id, state: "ended" },
      { expiredOnly: true },
    );
  return rows.length;
}
