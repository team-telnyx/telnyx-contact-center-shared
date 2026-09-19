// Capacity arbiter — the ONE ledger of agent busyness (the internal documentation §4.2, §6).
// All functions expect to run inside the caller's transaction.
//
// Occupancy predicate (used consistently everywhere):
//   state <> 'released' AND (state = 'active' OR owner_saga_id IS NOT NULL OR lease_expires_at > now())
// 'active' has no lease by design: it is owned by a handling session and is
// finalized from provider evidence, never by age (design principle 8).

import { randomUUID } from "node:crypto";
import { appendEvent } from "./events.mjs";
import { channelProfile } from "./channels.mjs";
import { tryReserveCapacity } from "./capacity.mjs";
import { setWorkflowState } from "./agent-state.mjs";
import { agentMediaEvidence } from "./agent-media-evidence.mjs";

export const DEFAULT_RESERVE_LEASE_MS = 30_000;

const LIVE_PREDICATE = `r.state <> 'released' AND (r.state = 'active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at > now())`;

export async function agentLiveOccupancy(db, agentId) {
  const result = await db.query(
    `SELECT COALESCE(SUM(r.weight), 0)::numeric AS live_weight,
            COUNT(*) FILTER (WHERE ${LIVE_PREDICATE}) AS live_count,
            bool_or(r.channel = 'voice' AND ${LIVE_PREDICATE}) AS has_live_voice
       FROM acd_reservations r
      WHERE r.agent_id = $1 AND ${LIVE_PREDICATE}`,
    [agentId],
  );
  const row = result.rows[0] || {};
  return {
    liveWeight: Number(row.live_weight || 0),
    liveCount: Number(row.live_count || 0),
    hasLiveVoice: Boolean(row.has_live_voice),
  };
}

/**
 * Atomically create a generation-fenced offer + capacity reservation for one
 * agent (doc §5.2 `tryOfferAndReserve`). MUST run in the router's transaction,
 * which already holds the work-item row lock.
 *
 * Returns { offerId, reservationId, generation } or null when the agent lost
 * the race / has no capacity — the router then tries the next candidate.
 */
export async function tryOfferAndReserve(db, params) {
  const {
    workItemId,
    agentId,
    channel,
    weight = null,
    reserveLeaseMs = DEFAULT_RESERVE_LEASE_MS,
    offerDeadlineMs,
    purpose = "queue",
    actor = "router",
  } = params;
  if (!workItemId || !agentId || !channel) {
    throw new Error("tryOfferAndReserve: workItemId, agentId and channel are required");
  }
  if (!offerDeadlineMs) throw new Error("tryOfferAndReserve: offerDeadlineMs is required");

  const profile = channelProfile(channel);
  let effectiveWeight = weight ?? profile.weight;

  const generationResult = await db.query(
    `SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM acd_offers WHERE work_item_id = $1`,
    [workItemId],
  );
  const generation = Number(generationResult.rows[0].next);

  const offerId = randomUUID();
  const reservationId = randomUUID();
  await db.query("SAVEPOINT acd_reserve_attempt");
  try {
    const reserved = await tryReserveCapacity(db, { id: reservationId, agentId, workItemId, channel,
      weight, leaseMs: reserveLeaseMs, purpose, actor });
    if (!reserved) { await db.query("RELEASE SAVEPOINT acd_reserve_attempt"); return null; }
    effectiveWeight = Number((await db.query("SELECT weight FROM acd_reservations WHERE id=$1", [reservationId])).rows[0].weight);
    await db.query(
      `INSERT INTO acd_offers (id, work_item_id, agent_id, generation, state, deadline_at)
       VALUES ($1, $2, $3, $4, 'created', now() + ($5::text || ' milliseconds')::interval)`,
      [offerId, workItemId, agentId, generation, String(offerDeadlineMs)],
    );
    await db.query("RELEASE SAVEPOINT acd_reserve_attempt");
  } catch (error) {
    // 23505 = unique violation on acd_offer_one_live / acd_res_one_per_work_item:
    // another router won this work item between our candidate query and here.
    await db.query("ROLLBACK TO SAVEPOINT acd_reserve_attempt");
    await db.query("RELEASE SAVEPOINT acd_reserve_attempt");
    if (error?.code === "23505") return null;
    throw error;
  }

  await appendEvent(db, {
    workItemId,
    agentId,
    type: "offer_created",
    payload: {
      offer_id: offerId,
      reservation_id: reservationId,
      generation,
      channel,
      weight: effectiveWeight,
      purpose,
    },
    actor,
  });

  return { offerId, reservationId, generation };
}

const RESERVATION_PROMOTIONS = Object.freeze({
  ringing: ["reserved"],
  active: ["reserved", "ringing"],
});

/**
 * Promote a reservation. Promotion to 'active' requires a handlingSessionId and
 * clears the execution lease (ownership moves to the handling session).
 */
export async function promoteReservation(db, params) {
  const { reservationId, to, leaseMs = null, handlingSessionId = null, actor = "saga:connect" } = params;
  const fromStates = RESERVATION_PROMOTIONS[to];
  if (!fromStates) throw new Error(`promoteReservation: illegal target state ${to}`);
  if (to === "active" && !handlingSessionId) {
    throw new Error("promoteReservation: promotion to active requires handlingSessionId");
  }

  const result = await db.query(
    `UPDATE acd_reservations
        SET state = $2,
            lease_expires_at = CASE
              WHEN $2 = 'active' THEN NULL
              WHEN $3::text IS NOT NULL THEN now() + ($3::text || ' milliseconds')::interval
              ELSE lease_expires_at
            END,
            handling_session_id = COALESCE($4, handling_session_id),
            last_provider_event_at = now()
      WHERE id = $1 AND state = ANY($5)
      RETURNING agent_id, work_item_id`,
    [reservationId, to, leaseMs === null ? null : String(leaseMs), handlingSessionId, fromStates],
  );
  const row = result.rows[0];
  if (!row) return null;

  await appendEvent(db, {
    workItemId: row.work_item_id,
    agentId: row.agent_id,
    type: "reservation_promoted",
    payload: { reservation_id: reservationId, to, handling_session_id: handlingSessionId },
    actor,
  });
  await setWorkflowState(db, row.agent_id, to === "active" ? "handling" : "offered", { workItemId: row.work_item_id, actor });
  return row;
}

export async function renewReservationLease(db, reservationId, leaseMs) {
  const result = await db.query(
    `UPDATE acd_reservations
        SET lease_expires_at = now() + ($2::text || ' milliseconds')::interval
      WHERE id = $1 AND state IN ('reserved', 'ringing')
      RETURNING id`,
    [reservationId, String(leaseMs)],
  );
  return Boolean(result.rows[0]);
}

/** Release a reservation with a mandatory reason. Idempotent. */
export async function releaseReservation(db, reservationId, reason, { actor = "saga" } = {}) {
  if (!reason) throw new Error("releaseReservation: reason is required");
  const reservation = (await db.query(`SELECT * FROM acd_reservations WHERE id=$1 AND state <> 'released' FOR UPDATE`, [reservationId])).rows[0];
  if (!reservation) return null;
  const mediaEvidence = await agentMediaEvidence(db, reservation);
  if (!mediaEvidence.ended) {
    await db.query(`UPDATE acd_reservations SET release_requested_at=COALESCE(release_requested_at,now()),
      release_requested_reason=COALESCE(release_requested_reason,$2) WHERE id=$1`, [reservationId,reason]);
    const { startReservationCleanup } = await import('./sagas/reservation-cleanup.mjs');
    await startReservationCleanup(db, reservation);
    return { agent_id: reservation.agent_id, work_item_id: reservation.work_item_id, pending: true };
  }
  const result = await db.query(
    `UPDATE acd_reservations
        SET state = 'released', released_at = now(), released_reason = $2
      WHERE id = $1 AND state <> 'released'
      RETURNING agent_id, work_item_id`,
    [reservationId, reason],
  );
  const row = result.rows[0];
  if (!row) return null;

  await appendEvent(db, {
    workItemId: row.work_item_id,
    agentId: row.agent_id,
    type: "reservation_released",
    payload: { reservation_id: reservationId, reason, ...(mediaEvidence.proof ? { media_end_evidence: mediaEvidence.proof } : {}) },
    actor,
  });
  await setWorkflowState(db, row.agent_id, "idle", { workItemId: row.work_item_id, actor, reason });
  return row;
}

/** Terminal offer outcomes. Returns the updated row or null (already terminal). */
export async function resolveOffer(db, offerId, state, { reason = null, actor = "saga" } = {}) {
  if (!["accepted", "rejected", "no_answer", "cancelled", "ringing"].includes(state)) {
    throw new Error(`resolveOffer: illegal offer state ${state}`);
  }
  const terminal = state !== "ringing" && state !== "accepted";
  const legalFrom = state === "ringing" ? ["created"] : ["created", "ringing", "accepted"];
  const result = await db.query(
    `UPDATE acd_offers
        SET state = $2,
            outcome_reason = COALESCE($3, outcome_reason),
            terminal_at = CASE WHEN $4 THEN now() ELSE terminal_at END
      WHERE id = $1 AND state = ANY($5)
      RETURNING work_item_id, agent_id, generation`,
    [offerId, state, reason, terminal, legalFrom],
  );
  const row = result.rows[0];
  if (!row) return null;

  await appendEvent(db, {
    workItemId: row.work_item_id,
    agentId: row.agent_id,
    type: `offer_${state}`,
    payload: { offer_id: offerId, generation: Number(row.generation), reason },
    actor,
  });
  return row;
}
