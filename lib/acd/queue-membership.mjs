import { randomUUID } from "node:crypto";
import { appendEvent } from "./events.mjs";

export async function setAgentQueueActivation(
  pool,
  { agentId, queueIds, enabled, actor = "agent" } = {},
) {
  const ids = [...new Set((queueIds || []).map(String).filter(Boolean))];
  if (!agentId || ids.length === 0) return [];
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const queues = await tx.query(
      `SELECT id, name, display_name FROM cc_queues
        WHERE id = ANY($1::text[]) AND ($2::boolean = false OR enabled = true)`,
      [ids, Boolean(enabled)],
    );
    const changed = [];
    for (const queue of queues.rows) {
      const previous = (
        await tx.query(
          `SELECT enabled, priority FROM cc_queue_user_assignments
            WHERE queue_id = $1 AND user_id = $2 FOR UPDATE`,
          [queue.id, String(agentId)],
        )
      ).rows[0];
      const priority = Number(previous?.priority) > 0 ? Number(previous.priority) : 1;
      await tx.query(
        `INSERT INTO cc_queue_user_assignments
           (id, queue_id, user_id, priority, enabled, activated_at,
            deactivated_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5,
                 CASE WHEN $5 THEN now() ELSE NULL END,
                 CASE WHEN $5 THEN NULL ELSE now() END, now(), now())
         ON CONFLICT (queue_id, user_id) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               activated_at = CASE WHEN EXCLUDED.enabled THEN now()
                 ELSE cc_queue_user_assignments.activated_at END,
               deactivated_at = CASE WHEN EXCLUDED.enabled THEN NULL ELSE now() END,
               updated_at = now()`,
        [randomUUID(), queue.id, String(agentId), priority, Boolean(enabled)],
      );
      changed.push(queue);
    }
    if (changed.length > 0) {
      await appendEvent(tx, {
        agentId: String(agentId),
        type: "agent_queue_membership_changed",
        payload: {
          queue_ids: changed.map((queue) => String(queue.id)),
          activated: Boolean(enabled),
        },
        actor,
      });
    }
    await tx.query("COMMIT");
    return changed;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
