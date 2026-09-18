import { defineSaga, startSaga } from "../saga-engine.mjs";
import { releaseReservation } from "../reservations.mjs";
import { appendEvent } from "../events.mjs";

async function resolved(tx, ctx) {
  const reservation = (await tx.query(`SELECT state FROM acd_reservations WHERE id = $1`, [ctx.data.reservationId])).rows[0];
  if (!reservation || reservation.state === "released") return true;
  const legs = (await tx.query(`SELECT * FROM acd_legs WHERE owner_saga_id = $1 AND role IN ('consult_target', 'transfer_target')`, [ctx.data.ownerSagaId])).rows;
  const rejected = (await tx.query(`SELECT status FROM acd_commands WHERE saga_id = $1
    AND operation IN ('consult_dial', 'blind_transfer') ORDER BY created_at DESC LIMIT 1`, [ctx.data.ownerSagaId])).rows[0]?.status === "failed";
  if ((legs.length && legs.every(leg => leg.ended_at)) || (!legs.length && rejected)) {
    await releaseReservation(tx, ctx.data.reservationId, rejected ? "target_dial_rejected" : "target_end_confirmed", { actor: "saga:target_cleanup" });
    return true;
  }
  return false;
}

defineSaga("target_cleanup", {
  initialStep: "verify",
  steps: {
    verify: { run: async (tx, ctx) => {
      if (await resolved(tx, ctx)) return "succeeded";
      const live = await tx.query(`SELECT 1 FROM acd_legs WHERE owner_saga_id = $1 AND role IN ('consult_target', 'transfer_target') AND ended_at IS NULL`, [ctx.data.ownerSagaId]);
      return live.rowCount ? "hangup" : "wait";
    } },
    hangup: {
      run: async (tx, ctx) => await resolved(tx, ctx) ? "succeeded" : null,
      cmd: async ctx => {
        const target = (await ctx.tx.query(`SELECT provider_call_id FROM acd_legs WHERE owner_saga_id = $1
          AND role IN ('consult_target', 'transfer_target') AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1`, [ctx.data.ownerSagaId])).rows[0];
        if (!target) throw new Error("Target changed before cleanup; retry the evidence check");
        return { operation: "target_cleanup_hangup", endpoint: `/calls/${encodeURIComponent(target.provider_call_id)}/actions/hangup`, request: {} };
      },
      on: { accepted: "wait", "leg.ended:consult_target": "wait", "leg.ended:transfer_target": "wait" },
      deadlineMs: 10000, onDeadline: "alarm", onFailure: "alarm",
    },
    wait: {
      run: async (tx, ctx) => await resolved(tx, ctx) ? "succeeded" : null,
      on: { "leg.initiated:consult_target": "verify", "leg.initiated:transfer_target": "verify", "leg.ended:consult_target": "verify", "leg.ended:transfer_target": "verify" },
      deadlineMs: 60000, onDeadline: "alarm",
    },
    alarm: { run: async (tx, ctx) => {
      const prior = await tx.query(`SELECT 1 FROM acd_events WHERE type = 'manual_intervention_required' AND payload->>'saga_id' = $1`, [ctx.saga.id]);
      if (!prior.rowCount) await appendEvent(tx, { workItemId: ctx.workItem.id, agentId: ctx.data.agentId, type: "manual_intervention_required",
        payload: { saga_id: ctx.saga.id, reason: "target_end_evidence_missing", reservation_preserved: true }, actor: "saga:target_cleanup" });
      return "wait";
    } },
  },
});

export async function startUnresolvedTargetCleanup(pool) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const claims = (await tx.query(`SELECT r.* FROM acd_reservations r JOIN acd_sagas s ON s.id = r.owner_saga_id
      WHERE r.purpose IN ('consult', 'transfer') AND r.state <> 'released' AND s.state IN ('succeeded', 'failed', 'cancelled')
      AND NOT EXISTS (SELECT 1 FROM acd_sagas c WHERE c.work_item_id = r.work_item_id AND c.conflict_key = 'target-cleanup:' || r.id::text AND c.state IN ('running', 'compensating'))
      ORDER BY r.created_at LIMIT 20 FOR UPDATE OF r SKIP LOCKED`)).rows;
    for (const claim of claims) await startSaga(tx, { type: "target_cleanup", workItemId: claim.work_item_id, conflictKey: `target-cleanup:${claim.id}`,
      data: { reservationId: claim.id, ownerSagaId: claim.owner_saga_id, agentId: claim.agent_id } });
    await tx.query("COMMIT");
    return claims.length;
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}
