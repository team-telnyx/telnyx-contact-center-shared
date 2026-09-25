import { agentStatusPresentation } from "./agent-state.mjs";
import { planAcdStreamRead } from "./retention-contract.mjs";
// Outbox ids are allocated before COMMIT, so they are NOT safe SSE cursors.
// A serialized publisher assigns a second sequence only to committed rows.
// Holding the lock until commit prevents a higher cursor overtaking a lower one.
export async function publishCommittedOutbox(pool, { limit = 500 } = {}) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const lock = await tx.query(`SELECT pg_try_advisory_xact_lock(741901, 3) AS acquired`);
    if (!lock.rows[0].acquired) { await tx.query("ROLLBACK"); return 0; }
    const result = await tx.query(`
      INSERT INTO acd_stream_events (outbox_seq, event_id)
      SELECT o.seq, o.event_id FROM acd_outbox o
       WHERE NOT EXISTS (SELECT 1 FROM acd_stream_events s WHERE s.outbox_seq = o.seq)
       ORDER BY o.seq LIMIT $1 ON CONFLICT (outbox_seq) DO NOTHING RETURNING seq`, [limit]);
    await tx.query("COMMIT");
    return result.rowCount;
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}

export async function readAgentSnapshot(db, agentId) {
  const agent = (await db.query(`SELECT presence, routability, workflow_state, workflow_deadline_at,
      workflow_work_item_id, status_id, status_started_at, version, manual_status, manual_status_set_at
    FROM acd_agent_state WHERE agent_id = $1`, [agentId])).rows[0] || null;
  const interactions = await db.query(`
    SELECT w.id AS work_item_id, w.id::text AS interaction_id,
           w.state, w.channel, w.version, w.terminal_at, w.queue_id, w.direction, w.customer_address,
           w.attributes->'agent_assist_config' AS agent_assist_config,
           EXISTS (SELECT 1 FROM acd_reservations r WHERE r.work_item_id = w.id AND r.agent_id = $1 AND r.state <> 'released') AS owns_live_assignment,
           customer.provider_call_id AS call_control_id,
           s.segment_id, s.segment_ended_at, s.wrapup_deadline_at,
           s.wrapup_ended_at, s.wrapup_code_id, s.media_endpoint_id, s.wrapup_endpoint_id, s.wrapup_owner_version
      FROM acd_work_items w
      LEFT JOIN LATERAL (SELECT id AS segment_id, ended_at AS segment_ended_at,
          wrapup_deadline_at, wrapup_ended_at, wrapup_code_id, media_endpoint_id, wrapup_endpoint_id, wrapup_owner_version FROM acd_segments
        WHERE work_item_id = w.id AND agent_id = $1 ORDER BY seq DESC LIMIT 1) s ON true
      LEFT JOIN LATERAL (SELECT provider_call_id FROM acd_legs
        WHERE work_item_id = w.id AND role = 'customer' ORDER BY created_at DESC LIMIT 1) customer ON true
     WHERE (w.terminal_at IS NULL OR w.terminal_at > now() - interval '24 hours')
       AND (EXISTS (SELECT 1 FROM acd_segments s WHERE s.work_item_id = w.id AND s.agent_id = $1)
         OR EXISTS (SELECT 1 FROM acd_offers o WHERE o.work_item_id = w.id AND o.agent_id = $1)
         OR EXISTS (SELECT 1 FROM acd_reservations r WHERE r.work_item_id = w.id AND r.agent_id = $1))
     ORDER BY w.created_at DESC LIMIT 200`, [agentId]);
  const pendingWrapup = agent?.workflow_state === "wrapup"
    ? (await db.query(`
        SELECT s.id AS segment_id, s.work_item_id,
               w.id::text AS interaction_id,
               s.ended_at, s.wrapup_deadline_at, s.wrapup_ended_at,
               s.wrapup_code_id, s.media_endpoint_id, s.wrapup_endpoint_id, s.wrapup_owner_version, w.channel, w.outbound_attempt_id, w.customer_address,
               ol.campaign_id AS outbound_campaign_id,
               ol.released_at AS outbound_released_at, w.terminal_at
          FROM acd_segments s
          JOIN acd_work_items w ON w.id = s.work_item_id
          LEFT JOIN acd_outbound_lines ol ON ol.attempt_id = w.outbound_attempt_id
         WHERE s.agent_id = $1 AND s.work_item_id = $2 AND s.kind = 'agent'
           AND s.ended_at IS NOT NULL AND s.wrapup_ended_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM acd_text_assignments a
             WHERE a.segment_id=s.id AND a.state<>'wrapup')
         ORDER BY s.seq DESC LIMIT 1`, [agentId, agent.workflow_work_item_id])).rows[0] || null
    : null;
  return {
    agent: agent ? { ...agent, ...agentStatusPresentation(agent) } : null,
    interactions: interactions.rows,
    pendingWrapup,
  };
}

export async function readAgentStream(pool, { agentId, after = 0, snapshot = false, limit = 200 }) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const bounds = (await tx.query(`
      SELECT MIN(seq)::text AS minimum_retained,
             MAX(seq)::text AS current
        FROM acd_stream_events
    `)).rows[0] || {};
    const watermark = (await tx.query(`
      SELECT latest_sequence::text AS latest_sequence
        FROM acd_retention_watermarks
       WHERE layer = 'acd_stream_events'
    `)).rows[0];
    const retainedCurrent = BigInt(bounds.current || 0);
    const recordedCurrent = BigInt(watermark?.latest_sequence || 0);
    const current = retainedCurrent > recordedCurrent
      ? retainedCurrent
      : recordedCurrent;
    const minimumRetained = bounds.minimum_retained != null
      ? BigInt(bounds.minimum_retained)
      : current > 0n
        ? current + 1n
        : 0n;
    const plan = planAcdStreamRead({
      after,
      minimumRetained,
      current,
      forceSnapshot: snapshot,
    });

    if (plan.mode === "snapshot") {
      const state = await readAgentSnapshot(tx, agentId);
      await tx.query("COMMIT");
      return {
        cursor: plan.cursor,
        snapshot: state,
        more: false,
        recovery: plan.reason,
      };
    }

    // Advance over unowned events too, without disclosing their contents.
    const batch = await tx.query(`SELECT s.seq,
      (e.agent_id = $2 OR EXISTS (SELECT 1 FROM acd_segments a WHERE a.work_item_id = e.work_item_id AND a.agent_id = $2)
       OR EXISTS (SELECT 1 FROM acd_offers o WHERE o.work_item_id = e.work_item_id AND o.agent_id = $2)) AS visible
      FROM acd_stream_events s JOIN acd_events e ON e.id = s.event_id
      WHERE s.seq > $1 ORDER BY s.seq LIMIT $3`, [plan.readAfter, agentId, limit]);
    const cursor = batch.rows.at(-1)?.seq || plan.cursor;
    const changed = batch.rows.some(row => row.visible);
    const state = changed ? await readAgentSnapshot(tx, agentId) : null;
    await tx.query("COMMIT");
    return {
      cursor,
      snapshot: state,
      more: batch.rowCount === limit,
      recovery: plan.reason,
    };
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}
