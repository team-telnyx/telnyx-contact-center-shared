import { recordSlaService } from "./sla.mjs";
// ACD event log + outbox (the internal documentation §3, §5.6).
// appendEvent runs inside the CALLER's transaction: the state change, the event
// and its outbox record commit or roll back together. NOTIFY is only a wake-up;
// consumers replay from acd_outbox by seq, so a lost NOTIFY loses nothing.

const NOTIFY_CHANNEL = "acd_events";

function outboxTopic({ workItemId, agentId, type }) {
  if (workItemId) return `work_item:${workItemId}`;
  if (agentId) return `agent:${agentId}`;
  return `system:${type}`;
}

export async function appendEvent(db, event) {
  const {
    workItemId = null,
    agentId = null,
    type,
    payload = {},
    actor,
  } = event;

  if (!type) throw new Error("appendEvent: type is required");
  if (!actor) throw new Error("appendEvent: actor is required");

  const inserted = await db.query(
    `INSERT INTO acd_events (work_item_id, agent_id, type, payload, actor)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id, occurred_at`,
    [workItemId, agentId, type, JSON.stringify(payload), actor],
  );
  const eventId = inserted.rows[0].id;
  const occurredAt = inserted.rows[0].occurred_at;

  if (type === "text_message_created" && payload.sender_role === "agent") {
    const message = (await db.query("SELECT created_at,sender_id FROM acd_messages WHERE id=$1 AND work_item_id=$2 AND sender_role='agent'", [payload.message_id, workItemId])).rows[0];
    if (message) await recordSlaService(db, { workItemId, serviceEvent: "human_message_persisted", occurredAt: message.created_at, evidenceId: String(eventId), agentId: message.sender_id });
  }
  if (["email_send_updated", "message_send_updated"].includes(type) && payload.status === "accepted") {
    const message = (await db.query("SELECT sender_id FROM acd_messages WHERE id=$1 AND work_item_id=$2 AND sender_role='agent'", [payload.message_id, workItemId])).rows[0];
    if (message) await recordSlaService(db, { workItemId, serviceEvent: "human_send_accepted", occurredAt, evidenceId: String(eventId), agentId: message.sender_id });
  }
  const topic = outboxTopic({ workItemId, agentId, type });
  const outboxPayload = {
    type,
    work_item_id: workItemId,
    agent_id: agentId,
    actor,
    occurred_at: occurredAt,
    ...payload,
  };
  const outbox = await db.query(
    `INSERT INTO acd_outbox (event_id, topic, payload)
     VALUES ($1, $2, $3::jsonb)
     RETURNING seq`,
    [eventId, topic, JSON.stringify(outboxPayload)],
  );
  const seq = outbox.rows[0].seq;

  // Compact wake-up only — payloads can exceed the 8000-byte NOTIFY limit.
  await db.query(`SELECT pg_notify($1, $2)`, [
    NOTIFY_CHANNEL,
    JSON.stringify({ seq: Number(seq), topic, type }),
  ]);

  return { eventId: Number(eventId), seq: Number(seq), topic, occurredAt };
}

/** Ordered replay source for SSE reconnect / projection catch-up. */
export async function readOutboxAfter(db, { afterSeq = 0, topics = null, limit = 200 }) {
  const params = [afterSeq, limit];
  let topicFilter = "";
  if (Array.isArray(topics) && topics.length > 0) {
    params.push(topics);
    topicFilter = `AND topic = ANY($3)`;
  }
  const result = await db.query(
    `SELECT seq, event_id, topic, payload, created_at
       FROM acd_outbox
      WHERE seq > $1 ${topicFilter}
      ORDER BY seq
      LIMIT $2`,
    params,
  );
  return result.rows.map((row) => ({ ...row, seq: Number(row.seq) }));
}

export const ACD_NOTIFY_CHANNEL = NOTIFY_CHANNEL;
