import { startTerminalMediaCleanup } from "./sagas/media-cleanup.mjs";
// ACD work-item lifecycle engine — the ONLY writer of acd_work_items.state
// (the internal documentation §4.1). Every transition: row lock, version CAS,
// legality check against TRANSITIONS, event + outbox append — one transaction.

import { randomUUID } from "node:crypto";
import { startSlaMeasurement, recordSlaService } from "./sla.mjs";
import { appendEvent } from "./events.mjs";

export const TERMINAL_STATES = Object.freeze(["completed", "abandoned", "failed"]);

// Authoritative transition map. The mermaid diagram in the design doc is the
// illustration; this map is the contract enforced at runtime and in tests.
// offered → abandoned covers the caller hanging up while an agent is ringing.
export const TRANSITIONS = Object.freeze({
  // Queue-less manual/direct calls move straight to an agent offer.
  open: ["queued", "offered", "abandoned", "failed"],
  queued: ["offered", "abandoned", "failed"],
  offered: ["active", "queued", "abandoned", "failed"],
  active: ["queued", "completed", "failed"],
  completed: [],
  abandoned: [],
  failed: [],
});

export function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

export async function createWorkItem(db, workItem) {
  const {
    id = randomUUID(),
    channel,
    direction,
    queueId = null,
    priority = 0,
    requiredSkills = {},
    customerAddress = null,
    ccAddress = null,
    attributes = {},
    providerSessionId = attributes.call_session_id || null,
    outboundAttemptId = null,
    conversationId = null,
    actor = "api",
  } = workItem;

  if (!channel) throw new Error("createWorkItem: channel is required");
  if (!direction) throw new Error("createWorkItem: direction is required");

  const result = await db.query(
    `INSERT INTO acd_work_items
       (id, channel, direction, queue_id, priority, required_skills,
        customer_address, cc_address, attributes, provider_session_id, outbound_attempt_id, conversation_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11, $12)
     RETURNING *`,
    [
      id,
      channel,
      direction,
      queueId,
      priority,
      JSON.stringify(requiredSkills),
      customerAddress,
      ccAddress,
      JSON.stringify(attributes),
      providerSessionId,
      outboundAttemptId,
      conversationId,
    ],
  );

  await startSlaMeasurement(db, result.rows[0]);
  await appendEvent(db, {
    workItemId: id,
    type: "work_item_created",
    payload: { channel, direction, queue_id: queueId },
    actor,
  });

  return result.rows[0];
}

export class TransitionConflictError extends Error {
  constructor(workItemId, expected, actual) {
    super(`work item ${workItemId}: expected version ${expected}, found ${actual}`);
    this.name = "TransitionConflictError";
    this.code = "ACD_VERSION_CONFLICT";
  }
}

/**
 * Apply a state transition. Returns:
 *   { applied: true,  workItem }                      — transition committed
 *   { applied: false, reason: 'terminal'|'illegal'|'not_found', workItem? }
 * Late/illegal inputs are RECORDED (noop event) — never thrown — so intake can
 * treat provider replays as normal traffic. Version conflicts DO throw: the
 * caller raced another writer inside the core and must re-read.
 *
 * `patch` may set: queue_id, priority, enqueued_at, terminal_reason, attributes (merge).
 */
export async function applyTransition(db, transition) {
  const {
    workItemId,
    to,
    eventType,
    payload = {},
    actor,
    expectedVersion = null,
    patch = {},
  } = transition;

  if (!workItemId) throw new Error("applyTransition: workItemId is required");
  if (!to) throw new Error("applyTransition: target state is required");
  if (!eventType) throw new Error("applyTransition: eventType is required");
  if (!actor) throw new Error("applyTransition: actor is required");

  const locked = await db.query(
    `SELECT * FROM acd_work_items WHERE id = $1 FOR UPDATE`,
    [workItemId],
  );
  const row = locked.rows[0];
  if (!row) return { applied: false, reason: "not_found" };

  if (expectedVersion !== null && Number(row.version) !== Number(expectedVersion)) {
    throw new TransitionConflictError(workItemId, expectedVersion, row.version);
  }

  if (isTerminalState(row.state)) {
    await appendEvent(db, {
      workItemId,
      type: "late_event_noop",
      payload: { attempted: eventType, attempted_to: to, terminal_state: row.state, ...payload },
      actor,
    });
    return { applied: false, reason: "terminal", workItem: row };
  }

  if (!TRANSITIONS[row.state]?.includes(to)) {
    await appendEvent(db, {
      workItemId,
      type: "illegal_transition_rejected",
      payload: { from: row.state, attempted_to: to, attempted: eventType, ...payload },
      actor,
    });
    return { applied: false, reason: "illegal", workItem: row };
  }

  const isTerminalTarget = isTerminalState(to);
  const updated = await db.query(
    `UPDATE acd_work_items
        SET state = $2,
            version = version + 1,
            queue_id = COALESCE($3, queue_id),
            priority = COALESCE($4, priority),
            enqueued_at = COALESCE($5, enqueued_at),
            attributes = CASE WHEN $6::jsonb IS NULL THEN attributes ELSE attributes || $6::jsonb END,
            terminal_at = CASE WHEN $7 THEN now() ELSE terminal_at END,
            terminal_reason = CASE WHEN $7 THEN COALESCE($8, terminal_reason) ELSE terminal_reason END,
            required_skills = COALESCE($9::jsonb, required_skills)
      WHERE id = $1
      RETURNING *`,
    [
      workItemId,
      to,
      patch.queueId ?? null,
      patch.priority ?? null,
      patch.enqueuedAt ?? null,
      patch.attributes ? JSON.stringify(patch.attributes) : null,
      isTerminalTarget,
      patch.terminalReason ?? null,
      patch.requiredSkills == null ? null : JSON.stringify(patch.requiredSkills),
    ],
  );

  await appendEvent(db, {
    workItemId,
    agentId: payload.agent_id ?? null,
    type: eventType,
    payload: { from: row.state, to, ...payload },
    actor,
  });

  if (isTerminalTarget) await startTerminalMediaCleanup(db, workItemId);
  return { applied: true, workItem: updated.rows[0] };
}

/** Open the next segment (seq = max+1) for a work item. */
export async function openSegment(db, segment) {
  const {
    workItemId,
    kind,
    queueId = null,
    agentId = null,
    startedAt = null,
    answeredAt = null,
  } = segment;
  if (!workItemId) throw new Error("openSegment: workItemId is required");
  if (!kind) throw new Error("openSegment: kind is required");

  const result = await db.query(
    `INSERT INTO acd_segments (
       id, work_item_id, seq, kind, queue_id, agent_id, started_at, answered_at
     )
     SELECT $1, $2, COALESCE(MAX(seq), 0) + 1, $3, $4, $5,
            COALESCE($6::timestamptz, now()), $7::timestamptz
       FROM acd_segments WHERE work_item_id = $2
     RETURNING *`,
    [randomUUID(), workItemId, kind, queueId, agentId, startedAt, answeredAt],
  );
  if (kind === "queue_wait") {
    const work = (await db.query("SELECT * FROM acd_work_items WHERE id=$1", [workItemId])).rows[0];
    await startSlaMeasurement(db, work, result.rows[0]);
  }
  return result.rows[0];
}

/** Close the open segment (if any) with an outcome. Returns the closed row or null. */
export async function closeOpenSegment(db, workItemId, { outcome, answeredAt = null, endedAt = null }) {
  const result = await db.query(
    `UPDATE acd_segments
        SET ended_at = COALESCE($3::timestamptz, now()),
            answered_at = COALESCE($4::timestamptz, answered_at),
            outcome = $2
      WHERE id = (
        SELECT id FROM acd_segments
         WHERE work_item_id = $1 AND ended_at IS NULL
         ORDER BY seq DESC LIMIT 1
         FOR UPDATE
      )
      RETURNING *`,
    [workItemId, outcome, endedAt, answeredAt],
  );
  const closed = result.rows[0];
  if (closed?.kind === "queue_wait" && outcome === "answered")
    await recordSlaService(db, { workItemId, serviceEvent: "human_answer", occurredAt: closed.answered_at || closed.ended_at, evidenceId: closed.id, segmentId: closed.id });
  return closed || null;
}

/** Invariant queries (doc §11.3) — usable in tests and as a PROD monitor. */
export const INVARIANT_QUERIES = Object.freeze({
  live_leg_without_owner: `
    SELECT l.id, l.work_item_id FROM acd_legs l JOIN acd_work_items w ON w.id = l.work_item_id
    WHERE l.ended_at IS NULL AND w.terminal_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM acd_sagas s WHERE s.work_item_id = w.id AND s.state IN ('running', 'compensating'))`,
  inconsistent_leg_end: `SELECT id FROM acd_legs WHERE (state = 'ended') IS DISTINCT FROM (ended_at IS NOT NULL)`,
  active_voice_without_handler: `
    SELECT w.id FROM acd_work_items w WHERE w.state = 'active' AND w.channel = 'voice'
      AND NOT EXISTS (SELECT 1 FROM acd_reservations r WHERE r.work_item_id = w.id AND r.state = 'active')
      AND NOT EXISTS (SELECT 1 FROM acd_sagas s WHERE s.work_item_id = w.id AND s.state IN ('running', 'compensating'))`,
  live_reservation_on_terminal_work_item: `
    SELECT r.id FROM acd_reservations r
      JOIN acd_work_items w ON w.id = r.work_item_id
     WHERE r.state <> 'released' AND w.terminal_at IS NOT NULL
       AND NOT (r.release_requested_at IS NOT NULL AND EXISTS (
         SELECT 1 FROM acd_sagas s WHERE s.work_item_id=r.work_item_id
           AND s.type='reservation_cleanup' AND s.data->>'reservationId'=r.id::text
           AND s.state IN ('running','compensating')))`,
  terminal_timestamp_nonterminal_state: `
    SELECT id FROM acd_work_items
     WHERE terminal_at IS NOT NULL
       AND state NOT IN ('completed', 'abandoned', 'failed')`,
  state_terminal_without_timestamp: `
    SELECT id FROM acd_work_items
     WHERE state IN ('completed', 'abandoned', 'failed')
       AND terminal_at IS NULL`,
  capacity_exceeded: `
    SELECT r.agent_id
      FROM acd_reservations r
      JOIN acd_agent_state a ON a.agent_id = r.agent_id
     WHERE r.state <> 'released'
       AND (r.state = 'active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at > now())
     GROUP BY r.agent_id, a.capacity
    HAVING SUM(r.weight) > a.capacity`,
  multiple_active_sagas_per_effect: `
    SELECT work_item_id, conflict_key FROM acd_sagas
     WHERE state IN ('running', 'compensating')
     GROUP BY work_item_id, conflict_key
    HAVING COUNT(*) > 1`,
  // The unique index allows several reservations per work item so a consult or
  // transfer target can be held alongside its source agent. Queue assignment is
  // still exclusive, and nothing but this check enforces that any more.
  multiple_queue_reservations_per_work_item: `
    SELECT work_item_id FROM acd_reservations
     WHERE state <> 'released' AND purpose = 'queue' AND work_item_id IS NOT NULL
       -- A reservation awaiting device-end evidence is no longer an
       -- assignment: the customer may already be offered to another agent
       -- while its cleanup runs.
       AND release_requested_at IS NULL
     GROUP BY work_item_id
    HAVING COUNT(*) > 1`,
  // An execution lease with no owner is exactly what sweepOrphanedClaims
  // repairs; a grace period past the reconciler tick means the sweep itself
  // has stopped working.
  orphaned_execution_claim: `
    SELECT r.id, r.agent_id FROM acd_reservations r
     WHERE r.state IN ('reserved', 'ringing')
       AND r.lease_expires_at < now() - interval '1 minute'
       AND NOT EXISTS (
         SELECT 1 FROM acd_sagas s WHERE s.work_item_id = r.work_item_id
           AND s.state IN ('running', 'compensating'))`,
});

export async function checkInvariants(db) {
  const violations = {};
  for (const [name, sql] of Object.entries(INVARIANT_QUERIES)) {
    const result = await db.query(sql);
    if (result.rows.length > 0) violations[name] = result.rows;
  }
  return violations;
}
