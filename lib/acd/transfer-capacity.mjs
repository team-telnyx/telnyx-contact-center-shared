import { randomUUID } from "node:crypto";
import { tryReserveCapacity } from "./capacity.mjs";
import { promoteReservation, releaseReservation } from "./reservations.mjs";
import { openSegment } from "./lifecycle.mjs";
import { startConnectSaga } from "./sagas/connect.mjs";
import { setWorkflowState } from "./agent-state.mjs";

export async function reserveTransferTarget(db, params, purpose) {
  // Capacity belongs to an explicitly selected CC agent. Manual numbers,
  // contacts and assistants are external destinations even when their E.164
  // address happens to match a phone field on a user record.
  if (params.targetKind !== "agents" && !params.targetUserId) return params;

  const target = String(params.target || "");
  const sipName = target.match(/^sip:([^@]+)@/i)?.[1] || "";
  const found = (await db.query(`SELECT u.id, u.username, u.telephony_user_name, to_jsonb(u)->>'voice_number' AS voice_number, to_jsonb(u)->>'mobile' AS mobile_number FROM users u
    WHERE ($1::text IS NOT NULL AND u.id = $1)
       OR ($2 <> '' AND (u.telephony_user_name = $2 OR u.username = $2))
       OR ((to_jsonb(u)->>'voice_number' = $3 OR to_jsonb(u)->>'mobile' = $3) AND $3 <> '') ORDER BY (u.id = $1) DESC NULLS LAST LIMIT 1`,
    [params.targetUserId || null, sipName, target])).rows[0];
  if (!found) throw Object.assign(new Error("Target agent not found"), { status: 404 });
  const actualSip = found.telephony_user_name || String(found.username || "").split("@")[0];
  if (params.targetUserId && target !== found.voice_number && target !== found.mobile_number && sipName !== actualSip) {
    throw Object.assign(new Error("Target address does not belong to the selected agent"), { status: 400 });
  }
  const reservationId = await tryReserveCapacity(db, { agentId: found.id, workItemId: params.workItemId,
    purpose, leaseMs: params.targetTimeoutMs || 30000, actor: `intent:${purpose}` });
  if (!reservationId) throw Object.assign(new Error("Target agent is unavailable or has no voice capacity"), { status: 409, code: "ACD_TARGET_UNAVAILABLE" });
  return { ...params, targetKind: "agents", targetUserId: found.id, targetUsername: found.username, targetReservationId: reservationId };
}

// Once transfer media is proven, the receiving agent gets a normal connect
// owner. They can then transfer again; the old call-control saga can terminate.
export async function transferTargetReadyForAdoption(tx, ctx) {
  if (!ctx.data.targetReservationId) return true;
  const targets=(await tx.query(`SELECT * FROM acd_legs WHERE owner_saga_id=$1 AND work_item_id=$2
    AND role IN ('consult_target','transfer_target') AND ended_at IS NULL`,[ctx.saga.id,ctx.workItem.id])).rows;
  if(targets.length!==1||!targets[0].answered_at)return false;
  if(targets[0].bridged_at||!/^sip:/i.test(ctx.data.target||''))return true;
  const transports=(await tx.query(`SELECT id FROM acd_legs WHERE owner_saga_id=$1 AND work_item_id=$2
    AND role IN ('consult_transport','transfer_transport') AND ended_at IS NULL`,[ctx.saga.id,ctx.workItem.id])).rows;
  return transports.length===1;
}

export async function adoptTransferTarget(tx, ctx) {
  if (!ctx.data.targetReservationId) return false;
  const target = (await tx.query(`SELECT * FROM acd_legs WHERE owner_saga_id = $1
    AND role IN ('consult_target', 'transfer_target') AND ended_at IS NULL
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [ctx.saga.id])).rows[0];
  if (!target) throw new Error("Answered transfer target leg is missing");
  const transports=(await tx.query(`SELECT * FROM acd_legs WHERE owner_saga_id=$1 AND work_item_id=$2
    AND role IN ('consult_transport','transfer_transport') AND ended_at IS NULL FOR UPDATE`,[ctx.saga.id,ctx.workItem.id])).rows;
  if(transports.length>1)throw new Error('Transfer transport identity is ambiguous');
  const res = (await tx.query(`SELECT * FROM acd_reservations WHERE id = $1 AND state <> 'released' FOR UPDATE`, [ctx.data.targetReservationId])).rows[0];
  if (!res) throw new Error("Target assignment no longer owns capacity");
  if (res.state !== "active") await promoteReservation(tx, { reservationId: res.id, to: "active", handlingSessionId: randomUUID(), actor: `saga:${ctx.saga.type}` });
  const generation = Number((await tx.query(`SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM acd_offers WHERE work_item_id = $1`, [ctx.workItem.id])).rows[0].generation);
  const offerId = randomUUID();
  await tx.query(`INSERT INTO acd_offers (id, work_item_id, agent_id, generation, state, deadline_at)
    VALUES ($1, $2, $3, $4, 'accepted', now())`, [offerId, ctx.workItem.id, res.agent_id, generation]);
  await openSegment(tx, { workItemId: ctx.workItem.id, kind: "agent", agentId: res.agent_id, queueId: ctx.workItem.queue_id,
    startedAt: new Date().toISOString(), answeredAt: new Date().toISOString() });
  const { sagaId } = await startConnectSaga(tx, {
    workItem: ctx.workItem, routeResult: { agentId: res.agent_id, reservationId: res.id, offerId, generation },
    customerProviderCallId: ctx.data.customerProviderCallId, connected: true, agentUsername: ctx.data.targetUsername,
    agentSipUri: ctx.data.target, interactionId: ctx.data.interactionId, connectionId: ctx.data.connectionId,
  });
  await tx.query(`UPDATE acd_legs SET role = 'agent_device', agent_id = $2, offer_generation = $3, owner_saga_id = $4 WHERE id = $1`,
    [target.id, res.agent_id, generation, sagaId]);
  if(transports[0]) {
    // Adopt both halves of the exact SIP target. Preserve raw bridge events;
    // the bound intent lets the normal connect owner verify their topology.
    await tx.query(`UPDATE acd_legs SET role='agent_transport',agent_id=$2,offer_generation=$3,owner_saga_id=$4 WHERE id=$1`,
      [transports[0].id,res.agent_id,generation,sagaId]);
    await tx.query(`INSERT INTO acd_leg_intents(id,work_item_id,reservation_id,agent_id,offer_generation,
      expected_role,command_id,state,transport_call_id,bound_leg_id,deadline_at)
      VALUES($1,$2,$3,$4,$5,'agent_device',$6,'bound',$7,$8,now())`,
    [randomUUID(),ctx.workItem.id,res.id,res.agent_id,generation,`adoption:${ctx.saga.id}`,transports[0].provider_call_id,target.id]);
  }
  await setWorkflowState(tx, res.agent_id, "handling", { workItemId: ctx.workItem.id, actor: `saga:${ctx.saga.type}` });
  return true;
}

export async function applyTransferCapacityEvidence(pool, leg, eventType) {
  if (!["consult_target", "transfer_target"].includes(leg.role) || !leg.owner_saga_id) return;
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const claims = (await tx.query(`SELECT * FROM acd_reservations WHERE owner_saga_id = $1 AND purpose IN ('consult', 'transfer') AND state <> 'released' FOR UPDATE`, [leg.owner_saga_id])).rows;
    for (const claim of claims) {
      if (eventType === "call.hangup") await releaseReservation(tx, claim.id, "target_leg_ended", { actor: "provider" });
      else if (["call.answered", "call.bridged"].includes(eventType) && claim.state !== "active") {
        await promoteReservation(tx, { reservationId: claim.id, to: "active", handlingSessionId: randomUUID(), actor: "provider" });
      }
    }
    await tx.query("COMMIT");
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}
