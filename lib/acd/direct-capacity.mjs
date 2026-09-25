import { randomUUID } from "node:crypto";
import { tryReserveCapacity } from "./capacity.mjs";
import {
  promoteReservation,
  releaseReservation,
  tryOfferAndReserve,
} from "./reservations.mjs";
import { appendEvent } from "./events.mjs";
import {
  applyTransition,
  closeOpenSegment,
  createWorkItem,
  openSegment,
} from "./lifecycle.mjs";
import {
  buildQueueLessVoiceWorkItem,
  resolveDirectAgentAddress,
  sipUser,
  voiceAddressMatches,
  VOICE_OCCUPANCY_KINDS,
} from "./voice-occupancy-contract.mjs";
import { applySagaEvent, driveSaga } from "./saga-engine.mjs";
import { startConnectSaga } from "./sagas/connect.mjs";
import { startManualOutboundSaga } from "./sagas/manual-outbound.mjs";
import { parseGeneratorInboundIdentity } from "../call-generator/inbound-identity.mjs";
import { decodeAcdClientState } from "./intake-source.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SUPERVISOR_ROLES = new Set(["monitor", "whisper", "barge"]);

function ownsStandaloneLifecycle(purpose) {
  return [
    VOICE_OCCUPANCY_KINDS.MANUAL_OUTBOUND,
    VOICE_OCCUPANCY_KINDS.SUPERVISION,
    "direct",
  ].includes(purpose);
}

function lifecycleEventPrefix(purpose) {
  return purpose === VOICE_OCCUPANCY_KINDS.SUPERVISION
    ? "supervision"
    : "manual_outbound";
}

function headerValue(payload, name) {
  return (Array.isArray(payload?.custom_headers) ? payload.custom_headers : [])
    .find((header) => String(header?.name || "").toLowerCase() === name.toLowerCase())
    ?.value || null;
}

function isInbound(payload) {
  return ["incoming", "inbound"].includes(
    String(payload?.direction || "").toLowerCase(),
  );
}

function isOutbound(payload) {
  return ["outgoing", "outbound"].includes(
    String(payload?.direction || "").toLowerCase(),
  );
}

function directConnectionIds() {
  return [process.env.TELNYX_SIP_CONNECTION_ID].filter(Boolean).map(String);
}

function usablePstnCallerNumber(value) {
  const number = typeof value === "string" ? value.trim() : "";
  return /^\+?[1-9]\d{6,14}$/.test(number) ? number : null;
}

function directSagaEvent(eventType) {
  return ({
    "call.answered": "leg.answered",
    "call.bridged": "leg.bridged",
    "call.hangup": "leg.ended",
  })[eventType] || null;
}

export async function resolveDirectAgentForPayload(
  pool,
  payload = {},
  { sourceFlowId = null } = {},
) {
  const generatorIdentity = parseGeneratorInboundIdentity(payload.custom_headers);
  if (generatorIdentity?.directAgentId) {
    if (!sourceFlowId || String(generatorIdentity.flowId) !== String(sourceFlowId)) {
      return {
        status: "unmatched",
        agent: null,
        matchedBy: "signed_generator",
        directHintPresent: true,
        transferCapable: true,
      };
    }
    const match = (await pool.query(
      `SELECT u.id, u.username, u.telephony_user_name, u.telephony_credentials_id,
              u.voice_number, u.mobile, u.first_name, u.last_name
         FROM cg_call_ledger l
         JOIN users u ON u.id::text = $4
        WHERE l.id::text = $1
          AND l.run_id::text = $2
          AND l.result->>'flow_id' = $3
          AND l.result->>'direct_agent_id' = $4
          AND l.result->>'inbound_call_control_id' = $5
        LIMIT 1`,
      [
        generatorIdentity.ledgerId,
        generatorIdentity.runId,
        generatorIdentity.flowId,
        generatorIdentity.directAgentId,
        payload.call_control_id || null,
      ],
    )).rows[0];
    return match
      ? {
          status: "matched",
          agent: match,
          matchedBy: "signed_generator",
          directHintPresent: true,
          transferCapable: true,
        }
      : {
          status: "unmatched",
          agent: null,
          matchedBy: "signed_generator",
          directHintPresent: true,
          transferCapable: true,
        };
  }

  const users = (await pool.query(
    `SELECT id, username, telephony_user_name, telephony_credentials_id,
            voice_number, mobile, first_name, last_name
       FROM users
      WHERE telephony_user_name IS NOT NULL
         OR username IS NOT NULL
         OR voice_number IS NOT NULL
         OR mobile IS NOT NULL`,
  )).rows;
  const destination = payload.to || payload.to_number;
  const sipDestination = Boolean(sipUser(destination));
  const result = resolveDirectAgentAddress(users, destination, sipDestination
    ? {
        connectionId: payload.connection_id || null,
        allowedCredentialConnectionIds: directConnectionIds(),
      }
    : {});
  return {
    ...result,
    directHintPresent: false,
    transferCapable: result.status === "matched" && result.matchedBy === "e164",
  };
}

export async function reserveDirectVoice(pool, {
  agentId,
  requestId = randomUUID(),
  target,
}) {
  const destination = typeof target === "string" ? target.trim() : "";
  if (!agentId || !UUID_PATTERN.test(String(requestId || "")) || !destination || destination.length > 300) {
    throw Object.assign(new Error("Invalid direct call intent"), { status: 400 });
  }
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [requestId]);
    const previous = (await tx.query(`SELECT * FROM acd_direct_intents WHERE id = $1`, [requestId])).rows[0];
    if (previous) {
      if (previous.agent_id !== agentId || previous.target !== destination || ["ended", "revoked"].includes(previous.state)) throw Object.assign(new Error("Intent already used"), { status: 409 });
      await tx.query("COMMIT"); return previous;
    }
    const agent = (await tx.query(
      `SELECT id, username, telephony_user_name, voice_number
         FROM users WHERE id = $1`,
      [agentId],
    )).rows[0];
    if (!agent) throw Object.assign(new Error("Agent not found"), { status: 404 });
    const spec = buildQueueLessVoiceWorkItem({
      kind: VOICE_OCCUPANCY_KINDS.MANUAL_OUTBOUND,
      customerAddress: destination,
      contactCenterAddress:
        agent.voice_number || agent.telephony_user_name || agent.username,
      attributes: {
        direct_intent_id: requestId,
        suppress_wrapup: true,
      },
    });
    const workItem = await createWorkItem(tx, {
      ...spec,
      actor: `agent:${agentId}`,
    });
    const reservationId = await tryReserveCapacity(tx, {
      agentId,
      workItemId: workItem.id,
      purpose: VOICE_OCCUPANCY_KINDS.MANUAL_OUTBOUND,
      leaseMs: 60000,
      actor: `agent:${agentId}`,
    });
    if (!reservationId) throw Object.assign(new Error("Another voice or video call is already in progress or the phone is not ready"), { status: 409 });
    await applyTransition(tx, {
      workItemId: workItem.id,
      to: "offered",
      eventType: "manual_outbound_reserved",
      actor: `agent:${agentId}`,
      payload: { agent_id: agentId, reservation_id: reservationId },
    });
    const row = (await tx.query(`INSERT INTO acd_direct_intents
      (id, agent_id, reservation_id, work_item_id, target, purpose)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [requestId, agentId, reservationId, workItem.id, destination,
        VOICE_OCCUPANCY_KINDS.MANUAL_OUTBOUND])).rows[0];
    // The browser/provider effect follows this commit. Its outcome can be
    // unknown, so a time-based reservation expiry must not permit a second call.
    await promoteReservation(tx, { reservationId, to: "active", handlingSessionId: row.id, actor: "direct:intent" });
    await tx.query("COMMIT");
    return row;
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}

export async function reserveSupervisionVoice(pool, {
  agentId,
  requestId = randomUUID(),
  target,
  supervisedCallControlId,
  role,
}) {
  const destination = typeof target === "string" ? target.trim() : "";
  const supervisedCall = typeof supervisedCallControlId === "string"
    ? supervisedCallControlId.trim()
    : "";
  const supervisorRole = String(role || "").toLowerCase();
  if (
    !agentId ||
    !UUID_PATTERN.test(String(requestId || "")) ||
    !destination ||
    destination.length > 300 ||
    !supervisedCall ||
    supervisedCall.length > 300 ||
    !SUPERVISOR_ROLES.has(supervisorRole)
  ) {
    throw Object.assign(new Error("Invalid supervision intent"), { status: 400 });
  }

  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [requestId]);
    const previous = (await tx.query(
      `SELECT d.*, w.attributes AS work_attributes
         FROM acd_direct_intents d
         LEFT JOIN acd_work_items w ON w.id = d.work_item_id
        WHERE d.id = $1`,
      [requestId],
    )).rows[0];
    if (previous) {
      if (
        previous.agent_id !== agentId ||
        previous.target !== destination ||
        previous.purpose !== VOICE_OCCUPANCY_KINDS.SUPERVISION ||
        previous.work_attributes?.supervised_call_control_id !== supervisedCall ||
        previous.work_attributes?.supervisor_role !== supervisorRole ||
        ["ended", "revoked"].includes(previous.state)
      ) {
        throw Object.assign(new Error("Intent already used"), { status: 409 });
      }
      await tx.query("COMMIT");
      return previous;
    }

    const agent = (await tx.query(
      `SELECT id, username, telephony_user_name, voice_number
         FROM users WHERE id = $1`,
      [agentId],
    )).rows[0];
    if (!agent) throw Object.assign(new Error("Supervisor not found"), { status: 404 });

    const spec = buildQueueLessVoiceWorkItem({
      kind: VOICE_OCCUPANCY_KINDS.SUPERVISION,
      customerAddress: `call:${supervisedCall}`,
      contactCenterAddress: destination,
      attributes: {
        direct_intent_id: requestId,
        supervised_call_control_id: supervisedCall,
        supervisor_role: supervisorRole,
        supervisor_agent_id: String(agentId),
        suppress_wrapup: true,
      },
    });
    const workItem = await createWorkItem(tx, {
      ...spec,
      actor: `supervisor:${agentId}`,
    });
    const reservationId = await tryReserveCapacity(tx, {
      agentId,
      workItemId: workItem.id,
      purpose: VOICE_OCCUPANCY_KINDS.SUPERVISION,
      leaseMs: 60000,
      actor: `supervisor:${agentId}`,
    });
    if (!reservationId) {
      throw Object.assign(
        new Error("Another voice or video call is already in progress or the supervisor phone is not ready"),
        { status: 409 },
      );
    }
    await applyTransition(tx, {
      workItemId: workItem.id,
      to: "offered",
      eventType: "supervision_reserved",
      actor: `supervisor:${agentId}`,
      payload: {
        agent_id: String(agentId),
        reservation_id: reservationId,
        supervised_call_control_id: supervisedCall,
        supervisor_role: supervisorRole,
      },
    });
    const row = (await tx.query(
      `INSERT INTO acd_direct_intents
        (id, agent_id, reservation_id, work_item_id, target, purpose)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        requestId,
        agentId,
        reservationId,
        workItem.id,
        destination,
        VOICE_OCCUPANCY_KINDS.SUPERVISION,
      ],
    )).rows[0];
    // Reservation ownership starts before the external Dial. A network error
    // after request transmission has an unknown outcome, so only provider
    // evidence may release it.
    await promoteReservation(tx, {
      reservationId,
      to: "active",
      handlingSessionId: row.id,
      actor: "supervision:intent",
    });
    await tx.query("COMMIT");
    return row;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}

export async function applyDirectCapacityEvent(pool, event, { provider = null } = {}) {
  const payload = event.payload || {};
  const intentId = headerValue(payload, "x-cc-direct-intent-id");
  let manualSaga = null;
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const row = (await tx.query(`SELECT * FROM acd_direct_intents WHERE provider_call_id = $1
      OR ($2::text IS NOT NULL AND id::text = $2) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [payload.call_control_id || null, intentId || null])).rows[0];
    if (!row) { await tx.query("COMMIT"); return null; }
    const manual = row.purpose === VOICE_OCCUPANCY_KINDS.MANUAL_OUTBOUND
      || row.purpose === "direct";
    if (row.state === "revoked") {
      // Capacity for this intent was already released against provider
      // evidence. A call appearing now is an origination the browser started
      // after that proof, so it is unauthorized: never silently allowed to
      // run unreserved. Tear it down through the ordinary rejection path.
      if (event.eventType === "call.hangup") {
        // The rogue leg is confirmed gone: only now may the agent be offered
        // work again. The rejection path recorded this leg against a synthetic
        // work item, and this handler stops the event before ordinary leg
        // translation runs — so close the leg here too, or its media_cleanup
        // saga keeps waiting on a leg that has already ended and eventually
        // raises a false alarm.
        if (row.reservation_id) {
          await releaseReservation(tx, row.reservation_id, "revoked_origination_ended", { actor: "provider:direct" });
        }
        const closed = await tx.query(
          `UPDATE acd_legs SET state = 'ended', ended_at = COALESCE(ended_at, now()),
             ended_reason = COALESCE(ended_reason, $2)
           WHERE provider_call_id = $1 AND ended_at IS NULL
           RETURNING id, work_item_id, role`,
          [payload.call_control_id || null, payload.hangup_cause || "revoked_origination"],
        );
        await tx.query(`UPDATE acd_direct_intents SET state = 'ended', ended_at = now() WHERE id = $1`, [row.id]);
        await appendEvent(tx, { agentId: row.agent_id, type: "direct_call_revoked_origination", actor: "provider",
          payload: { intent_id: row.id, event_type: event.eventType, call_control_id: payload.call_control_id || null,
            guard_released: true, closed_leg_id: closed.rows[0]?.id || null } });
        await tx.query("COMMIT");
        return { handled: true, outcome: "applied", skipAdapterEffects: true,
          closedLeg: closed.rows[0] || null };
      }
      // Issuing a hangup is a request, not an ending. Recording the leg keeps
      // the agent occupied through the arbiter until the provider confirms it
      // is gone. A reservation cannot do that job here: the agent may be
      // offline at this instant and become routable moments later, which is
      // exactly when the router would otherwise hand them a second call.
      await tx.query(`UPDATE acd_direct_intents SET provider_call_id = COALESCE(provider_call_id, $2) WHERE id = $1`,
        [row.id, payload.call_control_id || null]);
      await appendEvent(tx, { agentId: row.agent_id, type: "direct_call_revoked_origination", actor: "provider",
        payload: { intent_id: row.id, event_type: event.eventType, call_control_id: payload.call_control_id || null,
          capacity_retained: true } });
      await tx.query("COMMIT");
      return { handled: true, outcome: "applied", skipAdapterEffects: true, rejectLeg: true };
    }
    if (row.state === "ended") {
      // Only the intent's own leg is settled here. A sibling leg that carries
      // the intent header (the manual outbound customer leg, a supervision
      // transport) still belongs to the saga that dialed it, exactly as it
      // does while the intent is live.
      if (row.provider_call_id && payload.call_control_id && row.provider_call_id !== payload.call_control_id) {
        const supervisionSibling = row.purpose === VOICE_OCCUPANCY_KINDS.SUPERVISION && intentId === String(row.id);
        await tx.query("COMMIT");
        return supervisionSibling ? { handled: true, outcome: "noop", skipAdapterEffects: true } : null;
      }
      // A worker can crash after this handler commits the leg end but before
      // the wrapper forwards it to the manual-outbound saga. Reconstruct the
      // durable correlation on retry so the inbox event is not acknowledged
      // while the saga and its reservation remain stuck in handling.
      let existingManualSaga = null;
      if (manual && provider && event.eventType === "call.hangup") {
        existingManualSaga = (await tx.query(
          `SELECT id FROM acd_sagas
            WHERE work_item_id = $1 AND type = 'manual_outbound'
            ORDER BY created_at
            LIMIT 1`,
          [row.work_item_id],
        )).rows[0] || null;
      }
      await tx.query("COMMIT");
      return {
        handled: true,
        outcome: "noop",
        skipAdapterEffects: event.eventType !== "call.hangup",
        ...(existingManualSaga
          ? {
              manualSagaId: existingManualSaga.id,
              manualSagaCreated: false,
              manualSagaEvent: "leg.ended",
              manualSagaRole: "agent_device",
              manualWorkItemId: row.work_item_id,
            }
          : {}),
      };
    }
    const supervision = row.purpose === VOICE_OCCUPANCY_KINDS.SUPERVISION;
    const requiresInboundDeviceLeg = supervision || (!manual && /@/.test(row.target));
    if (!row.provider_call_id && (
      !voiceAddressMatches(payload.to || payload.to_number, row.target) ||
      (requiresInboundDeviceLeg && !isInbound(payload)) ||
      (manual && payload.direction && !isOutbound(payload))
    )) {
      await tx.query("COMMIT"); return { handled: true, outcome: "noop", skipAdapterEffects: true };
    }
    // First durable binding wins; sibling legs cannot release another leg's claim.
    if (row.provider_call_id && row.provider_call_id !== payload.call_control_id) {
      await tx.query("COMMIT");
      // Telnyx reports both the outgoing supervise transport and the incoming
      // WebRTC device leg with the intent header. Only the incoming device leg
      // owns Core capacity; its sibling is correlated but must be a no-op.
      if (supervision && intentId === String(row.id)) {
        return { handled: true, outcome: "noop", skipAdapterEffects: true };
      }
      return null;
    }
    await tx.query(`UPDATE acd_direct_intents SET provider_call_id = COALESCE(provider_call_id, $2),
      provider_session_id = COALESCE(provider_session_id, $3), state = CASE WHEN state = 'pending' THEN 'dialing' ELSE state END WHERE id = $1`,
      [row.id, payload.call_control_id, payload.call_session_id || null]);
    const role = supervision
      ? "supervisor"
      : manual
        ? "agent_device"
        : row.purpose === VOICE_OCCUPANCY_KINDS.CONSULT_TARGET
          ? "consult_target"
          : "transfer_target";
    const mediaStarted = ["call.initiated", "call.answered", "call.bridged"]
      .includes(event.eventType);
    const answeredEvent = ["call.answered", "call.bridged"].includes(event.eventType);
    const eventAt = event.occurredAt || new Date().toISOString();
    if (mediaStarted) {
      const legState = event.eventType === "call.bridged"
        ? "bridged"
        : event.eventType === "call.answered"
          ? "answered"
          : "ringing";
      await tx.query(`INSERT INTO acd_legs
        (id, work_item_id, role, agent_id, provider_call_id, provider_session_id,
         state, answered_at, bridged_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,
          CASE WHEN $7 IN ('answered','bridged') THEN $8::timestamptz ELSE NULL END,
          CASE WHEN $7='bridged' THEN $8::timestamptz ELSE NULL END)
        ON CONFLICT (provider_call_id) DO UPDATE SET
          provider_session_id=COALESCE(acd_legs.provider_session_id,EXCLUDED.provider_session_id),
          state=CASE
            WHEN acd_legs.ended_at IS NOT NULL THEN acd_legs.state
            WHEN EXCLUDED.state='bridged' THEN 'bridged'
            WHEN EXCLUDED.state='answered' AND acd_legs.state='ringing' THEN 'answered'
            ELSE acd_legs.state
          END,
          answered_at=COALESCE(acd_legs.answered_at,EXCLUDED.answered_at),
          bridged_at=COALESCE(acd_legs.bridged_at,EXCLUDED.bridged_at)`,
        [randomUUID(), row.work_item_id, role, row.agent_id,
          payload.call_control_id, payload.call_session_id || null, legState, eventAt]);

      if (manual && provider) {
        const agent = (await tx.query(
          `SELECT voice_number, first_name, last_name
             FROM users WHERE id = $1`,
          [row.agent_id],
        )).rows[0] || {};
        const displayName = [agent.first_name, agent.last_name]
          .filter(Boolean)
          .join(" ")
          .trim() || null;
        manualSaga = await startManualOutboundSaga(tx, {
          workItemId: row.work_item_id,
          directIntentId: row.id,
          reservationId: row.reservation_id,
          agentId: row.agent_id,
          agentProviderCallId: payload.call_control_id,
          agentProviderSessionId: payload.call_session_id || null,
          target: row.target,
          fromNumber: usablePstnCallerNumber(payload.from)
            || usablePstnCallerNumber(agent.voice_number)
            || usablePstnCallerNumber(process.env.TELNYX_MAIN_FROM_NUMBER),
          fromDisplayName: displayName,
          connectionId: process.env.TELNYX_CALL_CONTROL_ID || null,
        });
      }
      await tx.query(`UPDATE acd_work_items SET
        provider_session_id=COALESCE(provider_session_id,$2),
        attributes=attributes || jsonb_strip_nulls(jsonb_build_object(
          'agent_device_call_control_id',CASE WHEN $3 THEN $5::text ELSE NULL END,
          'supervisor_device_call_control_id',CASE WHEN $4 THEN $5::text ELSE NULL END,
          'direct_provider_call_id',$5::text))
        WHERE id=$1`, [row.work_item_id, payload.call_session_id || null, manual,
        supervision, payload.call_control_id || null]);
      // Once provider media exists, execution TTL no longer frees this slot.
      await promoteReservation(tx, { reservationId: row.reservation_id, to: "active", handlingSessionId: row.id, actor: "provider:direct" });
      if (ownsStandaloneLifecycle(row.purpose)) {
        const prefix = lifecycleEventPrefix(row.purpose);
        const work = (await tx.query(`SELECT state FROM acd_work_items WHERE id=$1`, [row.work_item_id])).rows[0];
        if (work?.state === "offered") {
          await applyTransition(tx, { workItemId: row.work_item_id, to: "active",
            eventType: `${prefix}_started`, actor: "provider:direct",
            payload: { agent_id: row.agent_id } });
          await openSegment(tx, { workItemId: row.work_item_id, kind: "agent",
            agentId: row.agent_id, startedAt: eventAt,
            answeredAt: answeredEvent && !manualSaga?.sagaId ? eventAt : null });
        } else if (work?.state === "active" && answeredEvent && !manualSaga?.sagaId) {
          await tx.query(`UPDATE acd_segments
            SET answered_at=COALESCE(answered_at,$2::timestamptz)
            WHERE work_item_id=$1 AND kind='agent' AND ended_at IS NULL`,
          [row.work_item_id, eventAt]);
        }
      }
    }
    if (event.eventType === "call.hangup") {
      if (manual && provider && !manualSaga) {
        const existingSaga = (await tx.query(
          `SELECT id FROM acd_sagas
            WHERE work_item_id = $1 AND type = 'manual_outbound'
            ORDER BY created_at
            LIMIT 1`,
          [row.work_item_id],
        )).rows[0];
        if (existingSaga) manualSaga = { sagaId: existingSaga.id, created: false };
      }
      const previousLeg = (await tx.query(
        `SELECT answered_at,bridged_at FROM acd_legs WHERE provider_call_id=$1`,
        [payload.call_control_id],
      )).rows[0];
      const answered = Boolean(previousLeg?.answered_at || previousLeg?.bridged_at);
      await tx.query(`UPDATE acd_legs SET state='ended',ended_at=COALESCE(ended_at,$2::timestamptz,now()),
        ended_reason=COALESCE(ended_reason,$3) WHERE provider_call_id=$1`,
        [payload.call_control_id, event.occurredAt || null, payload.hangup_cause || "normal_clearing"]);
      if (ownsStandaloneLifecycle(row.purpose) && !manualSaga?.sagaId) {
        const prefix = lifecycleEventPrefix(row.purpose);
        const work = (await tx.query(`SELECT state FROM acd_work_items WHERE id=$1 FOR UPDATE`, [row.work_item_id])).rows[0];
        if (work?.state === "active") {
          await closeOpenSegment(tx, row.work_item_id, {
            outcome: answered ? "completed" : "no_answer",
            endedAt: event.occurredAt || null,
          });
          await applyTransition(tx, { workItemId: row.work_item_id,
            to: answered ? "completed" : "failed",
            eventType: answered ? `${prefix}_ended` : `${prefix}_unanswered`,
            actor: "provider:direct",
            patch: { terminalReason: payload.hangup_cause || "normal_clearing" } });
        } else if (work?.state === "offered") {
          await applyTransition(tx, { workItemId: row.work_item_id, to: "failed",
            eventType: `${prefix}_failed`, actor: "provider:direct",
            patch: { terminalReason: payload.hangup_cause || "origination_failed" } });
        }
      }
      if (!manualSaga?.sagaId) {
        await releaseReservation(
          tx,
          row.reservation_id,
          supervision ? "supervision_leg_ended" : "direct_leg_ended",
          { actor: "provider:direct" },
        );
      }
      // The intent's own leg is confirmed gone: that is what ended_at records,
      // whichever saga still owns the reservation and the work item. A manual
      // outbound call that finishes through a transfer or consult saga never
      // reaches manual_outbound.finalize, so the intent must not wait for it.
      await tx.query(`UPDATE acd_direct_intents SET state = 'ended', ended_at = COALESCE(ended_at, $2::timestamptz, now())
        WHERE id = $1 AND ended_at IS NULL`, [row.id, event.occurredAt || null]);
    } else if (["call.answered", "call.bridged"].includes(event.eventType)) {
      await tx.query(`UPDATE acd_direct_intents SET state = 'active' WHERE id = $1`, [row.id]);
    }
    await appendEvent(tx, { workItemId: row.work_item_id, agentId: row.agent_id,
      type: supervision ? "supervision_call_event" : "direct_call_event", actor: "provider",
      payload: { intent_id: row.id, event_type: event.eventType,
        call_control_id: payload.call_control_id || null } });
    await tx.query("COMMIT");
    return {
      handled: true,
      outcome: "applied",
      directIntentId: row.id,
      ...(manualSaga?.sagaId
        ? {
            manualSagaId: manualSaga.sagaId,
            manualSagaCreated: manualSaga.created,
            manualSagaEvent: directSagaEvent(event.eventType),
            manualSagaRole: "agent_device",
            manualWorkItemId: row.work_item_id,
          }
        : {}),
    };
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}

async function findDirectAgentLeg(db, callControlId) {
  if (!callControlId) return null;
  return (await db.query(
    `SELECT l.*, w.state AS work_state, w.attributes, w.direction,
            r.id AS reservation_id, r.agent_id AS reserved_agent_id
       FROM acd_legs l
       JOIN acd_work_items w ON w.id=l.work_item_id
      LEFT JOIN acd_reservations r ON r.work_item_id=w.id
         AND r.state<>'released'
      WHERE l.provider_call_id=$1
        AND l.role='agent_device'
        AND (w.attributes->>'voice_occupancy_kind'=$2
          OR w.attributes->>'direct_rejected'='true')
      ORDER BY r.created_at DESC NULLS LAST
      LIMIT 1`,
    [callControlId, VOICE_OCCUPANCY_KINDS.DIRECT_INBOUND],
  )).rows[0] || null;
}

async function applyExistingDirectAgentLeg(pool, event, existing, { provider = null } = {}) {
  const payload = event.payload || {};
  const tx = await pool.connect();
  let endedLeg = null;
  try {
    await tx.query("BEGIN");
    const leg = await findDirectAgentLeg(tx, payload.call_control_id);
    if (!leg) { await tx.query("COMMIT"); return null; }
    if (event.eventType === "call.hangup") {
      endedLeg = (await tx.query(
        `UPDATE acd_legs SET state='ended',ended_at=COALESCE(ended_at,$2::timestamptz,now()),
            ended_reason=COALESCE(ended_reason,$3)
          WHERE id=$1 RETURNING id,work_item_id,role`,
        [leg.id, event.occurredAt || null, payload.hangup_cause || "normal_clearing"],
      )).rows[0];
      if (leg.attributes?.direct_rejected !== true && leg.attributes?.direct_rejected !== "true") {
        const answered = Boolean(leg.answered_at || leg.bridged_at);
        await closeOpenSegment(tx, leg.work_item_id, {
          outcome: answered ? "completed" : "no_answer",
          endedAt: event.occurredAt || null,
        });
        const work = (await tx.query(
          `SELECT state FROM acd_work_items WHERE id=$1 FOR UPDATE`,
          [leg.work_item_id],
        )).rows[0];
        if (work?.state === "active") {
          await applyTransition(tx, { workItemId: leg.work_item_id, to: "completed",
            eventType: "direct_inbound_ended", actor: "provider:direct",
            patch: { terminalReason: payload.hangup_cause || "normal_clearing" } });
        } else if (["open", "offered"].includes(work?.state)) {
          await applyTransition(tx, { workItemId: leg.work_item_id, to: "abandoned",
            eventType: "direct_inbound_unanswered", actor: "provider:direct",
            patch: { terminalReason: payload.hangup_cause || "caller_hangup" } });
        }
        if (leg.reservation_id) {
          await releaseReservation(tx, leg.reservation_id, "direct_leg_ended", {
            actor: "provider:direct",
          });
        }
      }
    } else if (["call.answered", "call.bridged"].includes(event.eventType)) {
      const nextState = event.eventType === "call.bridged" ? "bridged" : "answered";
      const at = event.occurredAt || new Date().toISOString();
      await tx.query(
        `UPDATE acd_legs SET state=$2,
            answered_at=COALESCE(answered_at,$3::timestamptz),
            bridged_at=CASE WHEN $2='bridged' THEN COALESCE(bridged_at,$3::timestamptz) ELSE bridged_at END
          WHERE id=$1 AND ended_at IS NULL`,
        [leg.id, nextState, at],
      );
      if (leg.reservation_id) {
        await promoteReservation(tx, { reservationId: leg.reservation_id, to: "active",
          handlingSessionId: payload.call_session_id || payload.call_control_id,
          actor: "provider:direct" });
      }
      const work = (await tx.query(
        `SELECT state FROM acd_work_items WHERE id=$1 FOR UPDATE`,
        [leg.work_item_id],
      )).rows[0];
      if (work?.state === "offered") {
        await applyTransition(tx, { workItemId: leg.work_item_id, to: "active",
          eventType: "direct_inbound_answered", actor: "provider:direct",
          payload: { agent_id: leg.reserved_agent_id } });
      }
      await tx.query(`UPDATE acd_segments SET answered_at=COALESCE(answered_at,$2::timestamptz)
        WHERE work_item_id=$1 AND kind='agent' AND ended_at IS NULL`, [leg.work_item_id, at]);
    }
    await appendEvent(tx, { workItemId: leg.work_item_id,
      agentId: leg.reserved_agent_id || leg.agent_id || null,
      type: "direct_call_event", actor: "provider",
      payload: { event_type: event.eventType, call_control_id: payload.call_control_id } });
    await tx.query("COMMIT");
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
  if (endedLeg && provider) {
    const { applySagaEvent } = await import("./saga-engine.mjs");
    await applySagaEvent(pool, { workItemId: endedLeg.work_item_id, name: "leg.ended",
      role: endedLeg.role, payload: { event_id: event.eventId || null,
        provider_call_id: payload.call_control_id }, provider, actor: "provider" });
  }
  return { handled: true, outcome: "applied", directWorkItemId: existing.work_item_id };
}

async function applyTransferableDirectInbound(
  pool,
  event,
  resolution,
  { provider = null } = {},
) {
  const payload = event.payload || {};
  const agent = resolution.agent;
  const telephonyUserName =
    agent.telephony_user_name || String(agent.username || "").split("@")[0];
  const tx = await pool.connect();
  let workItemId = null;
  let sagaId = null;
  let rejected = false;
  try {
    await tx.query("BEGIN");
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `direct-customer:${payload.call_control_id}`,
    ]);
    const duplicate = (await tx.query(
      `SELECT work_item_id
         FROM acd_legs
        WHERE provider_call_id = $1
        LIMIT 1`,
      [payload.call_control_id],
    )).rows[0];
    if (duplicate) {
      await tx.query("COMMIT");
      return {
        handled: true,
        outcome: "noop",
        directWorkItemId: duplicate.work_item_id,
      };
    }

    const decodedClientState = decodeAcdClientState(payload.client_state);
    const spec = buildQueueLessVoiceWorkItem({
      kind: VOICE_OCCUPANCY_KINDS.DIRECT_INBOUND,
      customerAddress: payload.from || "unknown",
      contactCenterAddress: payload.to || payload.to_number,
      attributes: {
        direct_agent_id: String(agent.id),
        direct_match: resolution.matchedBy,
        transfer_capable: true,
        suppress_wrapup: true,
        client_state: decodedClientState,
        ...(payload.caller_id_name
          ? { customer_name: payload.caller_id_name }
          : {}),
      },
    });
    const work = await createWorkItem(tx, {
      ...spec,
      providerSessionId: payload.call_session_id || null,
      actor: "provider:direct",
    });
    workItemId = work.id;
    await tx.query(
      `INSERT INTO acd_legs
         (id, work_item_id, role, provider_call_id, provider_session_id, state)
       VALUES ($1, $2, 'customer', $3, $4, 'parked')`,
      [
        randomUUID(),
        work.id,
        payload.call_control_id,
        payload.call_session_id || null,
      ],
    );

    const offer = telephonyUserName && agent.telephony_credentials_id
      ? await tryOfferAndReserve(tx, {
          workItemId: work.id,
          agentId: String(agent.id),
          channel: "voice",
          offerDeadlineMs: 30_000,
          reserveLeaseMs: 30_000,
          purpose: VOICE_OCCUPANCY_KINDS.DIRECT_INBOUND,
          actor: "provider:direct",
        })
      : null;
    if (!offer) {
      rejected = true;
      await tx.query(
        `UPDATE acd_work_items
            SET attributes = attributes || jsonb_build_object(
              'direct_rejected', true,
              'direct_rejection_reason', $2::text
            )
          WHERE id = $1`,
        [work.id, telephonyUserName ? "agent_unavailable" : "agent_telephony_missing"],
      );
      await applyTransition(tx, {
        workItemId: work.id,
        to: "failed",
        eventType: "direct_call_rejected",
        actor: "direct:capacity",
        patch: {
          terminalReason: telephonyUserName
            ? "agent_unavailable"
            : "agent_telephony_missing",
        },
        payload: { agent_id: String(agent.id) },
      });
    } else {
      await applyTransition(tx, {
        workItemId: work.id,
        to: "offered",
        eventType: "direct_inbound_reserved",
        actor: "provider:direct",
        payload: {
          agent_id: String(agent.id),
          reservation_id: offer.reservationId,
          offer_id: offer.offerId,
        },
      });
      await openSegment(tx, {
        workItemId: work.id,
        kind: "park",
        startedAt: event.occurredAt || null,
      });
      const started = await startConnectSaga(tx, {
        workItem: work,
        routeResult: {
          agentId: String(agent.id),
          reservationId: offer.reservationId,
          offerId: offer.offerId,
          generation: offer.generation,
        },
        customerProviderCallId: payload.call_control_id,
        agentSipUri: `sip:${telephonyUserName}@sip.telnyx.com`,
        agentDisplayName: [agent.first_name, agent.last_name]
          .filter(Boolean)
          .join(" ") || null,
        connectionId: agent.telephony_credentials_id,
        agentUsername: agent.username,
        customerNumber: payload.from || null,
        customerName: payload.caller_id_name || null,
        customerSessionId: payload.call_session_id || null,
        interactionId: work.id,
        queueName: null,
        enqueuedAt: null,
        interactionMetadata: {},
        clientState: payload.client_state || null,
        skipQueuePlayback: true,
      });
      sagaId = started.sagaId;
    }
    await appendEvent(tx, {
      workItemId: work.id,
      agentId: String(agent.id),
      type: rejected ? "direct_call_capacity_rejected" : "direct_call_admitted",
      actor: "provider:direct",
      payload: {
        call_control_id: payload.call_control_id,
        matched_by: resolution.matchedBy,
        transfer_capable: true,
        ...(sagaId ? { connect_saga_id: sagaId } : {}),
      },
    });
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }

  if (rejected) {
    await rejectUnreservedDirectCall(pool, payload, provider, {
      reason: telephonyUserName
        ? "agent_unavailable"
        : "agent_telephony_missing",
    });
  } else if (sagaId && provider) {
    await driveSaga(pool, sagaId, {
      provider,
      node: "direct-capacity:direct-inbound",
    });
  }
  return {
    handled: true,
    outcome: "applied",
    rejected,
    directAgentId: String(agent.id),
    directWorkItemId: workItemId,
    connectSagaId: sagaId,
    transferCapable: true,
  };
}

async function applyUnsolicitedDirectAgentEvent(pool, event, { provider = null } = {}) {
  const payload = event.payload || {};
  if (!["call.initiated", "call.answered", "call.bridged", "call.hangup"].includes(event.eventType)
      || !payload.call_control_id) return null;
  // Queue delivery and transfer/consult sagas carry their own durable Core
  // identity. Their inbound WebRTC device leg can look exactly like an
  // unsolicited direct call, so leave it to live-intake instead of creating a
  // second queue-less work item.
  if ([
    "x-cc-work-item-id",
    "x-cc-offer-generation",
    "x-cc-saga-id",
    "x-cc-leg-role",
  ].some((name) => headerValue(payload, name))) return null;
  const existing = await findDirectAgentLeg(pool, payload.call_control_id);
  if (existing) return applyExistingDirectAgentLeg(pool, event, existing, { provider });
  if (event.eventType !== "call.initiated" || !isInbound(payload)) return null;

  const resolution = await resolveDirectAgentForPayload(pool, payload, {
    sourceFlowId: event.sourceFlowId || null,
  });
  const configuredConnections = directConnectionIds();
  const recognizedConnection = configuredConnections.length > 0
    && configuredConnections.includes(String(payload.connection_id || ""));
  if (resolution.status !== "matched") {
    if (!recognizedConnection && !resolution.directHintPresent
        && resolution.status === "outside_connection") return null;
    if (!recognizedConnection && !resolution.directHintPresent
        && resolution.status === "unmatched") return null;
    await rejectUnreservedDirectCall(pool, payload, provider, {
      reason: resolution.status === "ambiguous"
        ? "ambiguous_agent_destination"
        : "unknown_agent_destination",
    });
    return { handled: true, outcome: "applied", rejected: true,
      directResolution: resolution.status };
  }

  if (resolution.transferCapable) {
    return applyTransferableDirectInbound(pool, event, resolution, { provider });
  }

  const agent = resolution.agent;
  const tx = await pool.connect();
  let reject = false;
  let admittedInfo = null;
  try {
    await tx.query("BEGIN");
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`direct-agent:${payload.call_control_id}`]);
    const duplicate = await findDirectAgentLeg(tx, payload.call_control_id);
    if (duplicate) { await tx.query("COMMIT"); return { handled: true, outcome: "noop" }; }
    const spec = buildQueueLessVoiceWorkItem({
      kind: VOICE_OCCUPANCY_KINDS.DIRECT_INBOUND,
      customerAddress: payload.from || "unknown",
      contactCenterAddress: payload.to || payload.to_number,
      attributes: {
        direct_agent_id: String(agent.id),
        direct_match: resolution.matchedBy,
        suppress_wrapup: true,
      },
    });
    const work = await createWorkItem(tx, { ...spec,
      providerSessionId: payload.call_session_id || null, actor: "provider:direct" });
    const reservationId = await tryReserveCapacity(tx, {
      agentId: String(agent.id), workItemId: work.id,
      purpose: VOICE_OCCUPANCY_KINDS.DIRECT_INBOUND,
      leaseMs: 60000, actor: "provider:direct",
    });
    await tx.query(`INSERT INTO acd_legs
      (id,work_item_id,role,agent_id,provider_call_id,provider_session_id,state)
      VALUES($1,$2,'agent_device',$3,$4,$5,'ringing')`,
      [randomUUID(), work.id, String(agent.id), payload.call_control_id,
        payload.call_session_id || null]);
    if (!reservationId) {
      reject = true;
      await tx.query(`UPDATE acd_work_items SET attributes=attributes || '{"direct_rejected":true}'::jsonb WHERE id=$1`, [work.id]);
      await applyTransition(tx, { workItemId: work.id, to: "failed",
        eventType: "direct_call_rejected", actor: "direct:capacity",
        patch: { terminalReason: "agent_unavailable" },
        payload: { agent_id: String(agent.id) } });
    } else {
      await applyTransition(tx, { workItemId: work.id, to: "offered",
        eventType: "direct_inbound_reserved", actor: "provider:direct",
        payload: { agent_id: String(agent.id), reservation_id: reservationId } });
      await promoteReservation(tx, { reservationId, to: "ringing", leaseMs: 60000,
        actor: "provider:direct" });
      await openSegment(tx, { workItemId: work.id, kind: "agent",
        agentId: String(agent.id), startedAt: event.occurredAt || null });
      admittedInfo = {
        fromNumber: payload.from || null,
        fromName: payload.caller_id_name || null,
        callControlId: payload.call_control_id,
        originalCallControlId: payload.call_control_id,
        callSessionId: payload.call_session_id || null,
        interactionId: work.id,
        queueName: null,
        queuedAt: null,
        assignedAt: event.occurredAt || new Date().toISOString(),
        metadata: {
          voice_occupancy_kind: VOICE_OCCUPANCY_KINDS.DIRECT_INBOUND,
          direct_agent_id: String(agent.id),
        },
      };
    }
    await appendEvent(tx, { workItemId: work.id, agentId: String(agent.id),
      type: reject ? "direct_call_capacity_rejected" : "direct_call_admitted",
      actor: "provider:direct", payload: { call_control_id: payload.call_control_id,
        matched_by: resolution.matchedBy } });
    await tx.query("COMMIT");
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
  if (reject) {
    await rejectUnreservedDirectCall(pool, payload, provider, {
      reason: "agent_unavailable",
    });
  } else if (admittedInfo) {
    try {
      const { broadcastToKey } = await import("../sse.js");
      const { storeIncomingCallData } = await import("../incoming-call-store.js");
      if (admittedInfo.callSessionId) {
        storeIncomingCallData(`session:${admittedInfo.callSessionId}`, admittedInfo);
      }
      storeIncomingCallData(admittedInfo.callControlId, admittedInfo);
      if (admittedInfo.fromNumber) {
        storeIncomingCallData(`phone:${admittedInfo.fromNumber}`, admittedInfo);
      }
      await broadcastToKey(`user:status:${agent.id}`, {
        type: "incoming_call_info",
        ...admittedInfo,
        contactCenter: {
          interactionId: admittedInfo.interactionId,
          queueName: null,
          queuedAt: null,
          assignedAt: admittedInfo.assignedAt,
        },
      }, "incoming_call_info");
    } catch {
      // The browser also recovers by provider call/session lookup.
    }
  }
  return { handled: true, outcome: "applied", rejected: reject,
    directAgentId: String(agent.id) };
}

/**
 * Apply a direct-capacity event and, when it named a revoked intent, hang up
 * the leg that intent was never allowed to create. The rejection runs after
 * the commit through the journalled cleanup executor.
 */
export async function applyDirectCapacityEventWithRejection(pool, event, { provider = null } = {}) {
  const result = await applyDirectCapacityEvent(pool, event, { provider });
  if (result?.manualSagaId && provider) {
    if (result.manualSagaCreated) {
      await driveSaga(pool, result.manualSagaId, {
        provider,
        node: "direct-capacity:manual-outbound",
      });
    }
    if (result.manualSagaEvent) {
      await applySagaEvent(pool, {
        workItemId: result.manualWorkItemId,
        name: result.manualSagaEvent,
        role: result.manualSagaRole,
        payload: {
          event_id: event.eventId || null,
          provider_call_id: event.payload?.call_control_id || null,
          owner_saga_id: result.manualSagaId,
        },
        provider,
        node: "direct-capacity:manual-outbound-event",
        actor: "provider",
      });
    }
  }
  if (result?.rejectLeg && provider && event.payload?.call_control_id) {
    await rejectUnreservedDirectCall(pool, event.payload, provider);
  }
  // Hand the leg end to whichever saga owns that synthetic work item, so the
  // cleanup executor settles instead of timing out into manual intervention.
  if (result?.closedLeg?.work_item_id && provider) {
    await applySagaEvent(pool, {
      workItemId: result.closedLeg.work_item_id,
      name: "leg.ended",
      role: result.closedLeg.role,
      payload: { event_id: event.eventId || null, provider_call_id: event.payload?.call_control_id || null },
      provider,
      actor: "provider",
    });
  }
  return result || applyUnsolicitedDirectAgentEvent(pool, event, { provider });
}

export async function reserveCoreTarget(pool, {
  target,
  targetUserId = null,
  sourceInteractionId,
  username,
  requestId = randomUUID(),
  purpose = VOICE_OCCUPANCY_KINDS.BLIND_TRANSFER_TARGET,
}) {
  const destination = typeof target === 'string' ? target.trim() : '';
  if (!UUID_PATTERN.test(String(requestId || '')) || !sourceInteractionId
      || !username || !destination || destination.length > 300) {
    throw Object.assign(new Error('Invalid Core target intent'), { status: 400 });
  }
  const workItem = (await pool.query(`SELECT * FROM acd_work_items
    WHERE id::text=$1 LIMIT 1`, [sourceInteractionId])).rows[0];
  if (!workItem) throw Object.assign(new Error('Core work item not found'), { status: 404 });
  const { authorizePersistedInteractionControl } = await import('../voice/interaction-control-policy.mjs');
  const access = await authorizePersistedInteractionControl(
    pool,
    { id: workItem.id, work_item_id: workItem.id },
    { username },
  );
  if (!access.ok) throw Object.assign(new Error(access.error), { status: access.status });
  const users = (await pool.query(`SELECT id,username,telephony_user_name,voice_number,mobile FROM users`)).rows;
  const resolved = resolveDirectAgentAddress(users, destination);
  const agent = resolved.status === 'matched' ? resolved.agent : null;
  if (!agent) {
    if (targetUserId) throw Object.assign(new Error('Configured agent destination required'), { status: 400 });
    return null;
  }
  if (targetUserId && agent.id !== targetUserId) throw Object.assign(new Error('Destination does not match agent'), { status: 400 });
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [requestId]);
    const previous = (await tx.query(`SELECT * FROM acd_direct_intents WHERE id=$1`, [requestId])).rows[0];
    if (previous) {
      if (previous.agent_id !== agent.id || previous.target !== destination || ['ended','revoked'].includes(previous.state)) {
        throw Object.assign(new Error('Intent already used'), { status: 409 });
      }
      await tx.query('COMMIT');
      return previous;
    }
    const reservationId = await tryReserveCapacity(tx, { agentId: agent.id,
      workItemId: workItem.id, purpose, leaseMs: 60000, actor: `agent:${username}` });
    if (!reservationId) throw Object.assign(new Error('Agent has no available voice capacity'), { status: 409 });
    const intent = (await tx.query(`INSERT INTO acd_direct_intents
      (id,agent_id,reservation_id,work_item_id,target,purpose)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [requestId, agent.id, reservationId, workItem.id, destination, purpose])).rows[0];
    await promoteReservation(tx, { reservationId, to: 'active',
      handlingSessionId: intent.id, actor: 'direct:intent' });
    await tx.query('COMMIT');
    return intent;
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}

export async function cancelUnstartedDirectIntent(pool, {
  id,
  agentId = null,
  workItemId = null,
}) {
  if (!UUID_PATTERN.test(String(id || '')) || (!agentId && !workItemId)) {
    throw Object.assign(new Error('Invalid direct call cancellation'), { status: 400 });
  }
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const intent = (await tx.query(`UPDATE acd_direct_intents
      SET state = 'ended', ended_at = now()
      WHERE id = $1 AND provider_call_id IS NULL AND state = 'pending'
        AND (($2::text IS NOT NULL AND agent_id = $2)
          OR ($3::uuid IS NOT NULL AND work_item_id = $3::uuid))
      RETURNING reservation_id,work_item_id,purpose`, [id, agentId, workItemId])).rows[0];
    if (intent) {
      await releaseReservation(tx, intent.reservation_id, 'origination_not_started', {
        actor: 'browser:direct',
      });
      if (ownsStandaloneLifecycle(intent.purpose)) {
        const prefix = lifecycleEventPrefix(intent.purpose);
        const work = (await tx.query(`SELECT state FROM acd_work_items WHERE id=$1 FOR UPDATE`, [intent.work_item_id])).rows[0];
        if (work?.state === 'offered') await applyTransition(tx, {
          workItemId: intent.work_item_id, to: 'failed',
          eventType: `${prefix}_cancelled`, actor: 'browser:direct',
          patch: { terminalReason: 'origination_not_started' },
        });
      }
    }
    await tx.query('COMMIT');
    return Boolean(intent);
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}

export async function rejectDirectIntent(pool, id, httpStatus) {
  if (![400,401,403,404,405,409,410,422].includes(httpStatus) || !id) return;
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const intent = (await tx.query(`UPDATE acd_direct_intents SET state = 'ended', ended_at = now()
      WHERE id = $1 AND provider_call_id IS NULL AND state = 'pending'
      RETURNING reservation_id,work_item_id,purpose`, [id])).rows[0];
    if (intent) {
      await releaseReservation(tx, intent.reservation_id, 'provider_definitively_rejected');
      if (ownsStandaloneLifecycle(intent.purpose)) {
        const prefix = lifecycleEventPrefix(intent.purpose);
        const work = (await tx.query(`SELECT state FROM acd_work_items WHERE id=$1 FOR UPDATE`, [intent.work_item_id])).rows[0];
        if (work?.state === 'offered') await applyTransition(tx, {
          workItemId: intent.work_item_id, to: 'failed',
          eventType: `${prefix}_rejected`, actor: 'provider:direct',
          patch: { terminalReason: 'provider_definitively_rejected' },
        });
      }
    }
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}

// A browser that stopped reporting is NOT evidence that the call it was asked
// to place does not exist: a throttled tab, a lost heartbeat or a delayed
// call.initiated all look identical from here, and releasing on that alone
// would let the agent be offered a second call over a live one. The expired
// session only selects candidates cheaply; the release itself requires the
// provider to confirm that the agent's own credential carries no active call.
export async function sweepAbandonedDirectIntents(pool, { provider = null, node = 'reconciler' } = {}) {
  const candidates = (await pool.query(`SELECT d.id, d.agent_id, d.reservation_id, u.telephony_credentials_id
    FROM acd_direct_intents d
    JOIN users u ON u.id = d.agent_id
    WHERE d.state = 'pending' AND d.provider_call_id IS NULL
      AND d.created_at < now() - interval '2 minutes'
      AND u.telephony_credentials_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM acd_agent_sessions s
        WHERE s.agent_id = d.agent_id AND s.state = 'online' AND s.expires_at > now())
      AND NOT EXISTS (SELECT 1 FROM acd_legs l
        WHERE l.agent_id = d.agent_id AND l.ended_at IS NULL)
    ORDER BY d.created_at
    LIMIT 5`)).rows;
  if (!candidates.length || !provider) return 0;

  let released = 0;
  for (const candidate of candidates) {
    let evidence = null;
    try {
      const result = await provider.send({
        operation: 'verify_direct_agent_absence',
        endpoint: '/provider-evidence/active-calls',
        request: { credentialId: candidate.telephony_credentials_id },
        commandId: `direct-absence:${candidate.id}`,
      });
      evidence = result?.outcome === 'accepted' ? result.response?.data : null;
    } catch {
      evidence = null; // an unread inventory is not a confirmation
    }
    if (evidence?.ended !== true) continue;

    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      // Re-check under lock: the browser may have started the call while the
      // read-only inventory was in flight.
      const intent = (await tx.query(`SELECT * FROM acd_direct_intents
        WHERE id = $1 AND state = 'pending' AND provider_call_id IS NULL FOR UPDATE`, [candidate.id])).rows[0];
      if (intent) {
        await tx.query(`UPDATE acd_direct_intents SET state = 'revoked' WHERE id = $1`, [intent.id]);
        await appendEvent(tx, { workItemId: intent.work_item_id, agentId: intent.agent_id, type: 'agent_media_absence_verified', actor: `reconciler:${node}`,
          payload: { intent_id: intent.id, reservation_id: intent.reservation_id, ...evidence } });
        await releaseReservation(tx, intent.reservation_id, 'direct_origination_absence_verified', { actor: 'reconciler' });
        if (ownsStandaloneLifecycle(intent.purpose)) {
          const prefix = lifecycleEventPrefix(intent.purpose);
          const work = (await tx.query(`SELECT state FROM acd_work_items WHERE id=$1 FOR UPDATE`, [intent.work_item_id])).rows[0];
          if (work?.state === 'offered') await applyTransition(tx, {
            workItemId: intent.work_item_id, to: 'failed',
            eventType: `${prefix}_absence_verified`, actor: 'reconciler',
            patch: { terminalReason: 'origination_not_started' },
          });
        }
        await appendEvent(tx, { workItemId: intent.work_item_id, agentId: intent.agent_id, type: 'reconciler_corrected', actor: 'reconciler',
          payload: { kind: 'direct_intent_never_started', intent_id: intent.id, reservation_id: intent.reservation_id } });
        released += 1;
      }
      await tx.query('COMMIT');
    } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  }
  return released;
}

// A direct intent ends with its own provider leg. Any path that closes that
// leg without passing through the direct handler (a transfer or consult saga,
// a hangup settled by 90018, a recovery) leaves the intent open; this sweep
// closes it from leg evidence alone, before the unconfirmed-intent alarm can
// misread a finished call as missing evidence.
export async function settleEndedDirectIntents(pool, { node = 'reconciler' } = {}) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const rows = (await tx.query(`UPDATE acd_direct_intents d
        SET state = 'ended', ended_at = COALESCE(d.ended_at, l.ended_at, now())
       FROM acd_legs l
      WHERE l.provider_call_id = d.provider_call_id AND l.ended_at IS NOT NULL
        AND d.ended_at IS NULL
      RETURNING d.id, d.agent_id, d.work_item_id, d.reservation_id, l.id AS leg_id, l.ended_at AS leg_ended_at`)).rows;
    for (const row of rows) await appendEvent(tx, { workItemId: row.work_item_id, agentId: row.agent_id, type: 'reconciler_corrected', actor: `reconciler:${node}`,
      payload: { kind: 'direct_intent_leg_ended', intent_id: row.id, reservation_id: row.reservation_id, leg_id: row.leg_id, leg_ended_at: row.leg_ended_at } });
    await tx.query('COMMIT');
    return rows.length;
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}

// Browser origination can fail between intent commit and receipt of provider
// evidence. Keep the slot and surface it instead of freeing it on a timer.
export async function alarmUnconfirmedDirectIntents(pool) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const rows = (await tx.query(`UPDATE acd_direct_intents SET alarm_at=now()
      WHERE state <> 'ended' AND (state <> 'revoked' OR provider_call_id IS NOT NULL) AND alarm_at IS NULL AND
        ((provider_call_id IS NULL AND created_at < now()-interval '1 minute')
          OR created_at < now()-interval '8 hours') RETURNING id,agent_id,provider_call_id`)).rows;
    for (const row of rows) await appendEvent(tx, { agentId:row.agent_id,type:'manual_intervention_required',actor:'reconciler',
      payload:{intent_id:row.id,provider_call_id:row.provider_call_id,reason:'direct_call_evidence_missing',reservation_preserved:true} });
    await tx.query('COMMIT'); return rows.length;
  } catch(error) {await tx.query('ROLLBACK');throw error;} finally {tx.release();}
}

// An unsolicited SIP call can arrive while another assignment owns the agent.
// Reject only that new leg through the same journal and cleanup executor.
export async function rejectUnreservedDirectCall(pool, payload, provider, {
  reason = "agent_unavailable",
} = {}) {
  const {driveSaga}=await import('./saga-engine.mjs');
  const tx=await pool.connect();
  let sagaId;
  let workId;
  try {
    await tx.query('BEGIN');
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`reject-direct:${payload.call_control_id}`]);
    workId=(await tx.query(`SELECT work_item_id FROM acd_legs WHERE provider_call_id=$1`,[payload.call_control_id])).rows[0]?.work_item_id;
    if(!workId) {
      const work=await createWorkItem(tx,{channel:'voice',direction:'inbound',customerAddress:payload.from,ccAddress:payload.to,attributes:{direct_rejected:true,direct_rejection_reason:reason},actor:'direct:capacity'});
      workId=work.id;
      await tx.query(`INSERT INTO acd_legs (id,work_item_id,role,provider_call_id,state) VALUES ($1,$2,'customer',$3,'ringing')`,[randomUUID(),workId,payload.call_control_id]);
      await applyTransition(tx,{workItemId:workId,to:'failed',eventType:'direct_call_rejected',actor:'direct:capacity',patch:{terminalReason:reason}});
    }
    sagaId=(await tx.query(`SELECT s.id FROM acd_sagas s JOIN acd_work_items w ON w.id=s.work_item_id
      WHERE w.id=$1 AND w.attributes->>'direct_rejected'='true' AND s.type='media_cleanup' ORDER BY s.created_at DESC LIMIT 1`,[workId])).rows[0]?.id;
    await tx.query('COMMIT');
  } catch(error) {await tx.query('ROLLBACK');throw error;} finally {tx.release();}
  if(sagaId && provider) await driveSaga(pool,sagaId,{provider,node:'direct:reject'});
  return {workItemId:workId,sagaId:sagaId||null};
}
