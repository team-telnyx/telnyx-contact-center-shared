// `connect` saga — inbound offer → answer → in-call → finalize, with
// no-answer and customer-abandon compensations (the internal documentation §8.1).
//
// conflict_key: 'assignment' — it owns the assignment effect for the whole
// call, while 'call-control' stays free for future transfer/consult sagas.
//
// data: { agentId, reservationId, offerId, generation, queueId,
//         customerProviderCallId, agentSipUri, agentDisplayName,
//         answerTimeoutMs, wrapupDeadlineMs }

import { randomUUID } from "node:crypto";
import { defineSaga, startSaga } from "../saga-engine.mjs";
import { applyTransition, openSegment, closeOpenSegment } from "../lifecycle.mjs";
import { promoteReservation, releaseReservation, resolveOffer } from "../reservations.mjs";
import { setWorkflowState, setAgentRoutability, setSystemAgentStatus } from "../agent-state.mjs";
import { appendEvent } from "../events.mjs";
import { prewarmAgentAssistTransport } from "../agent-assist-prewarm.mjs";
import { loadAgentLifecycleSettings } from "../agent-lifecycle-settings.mjs";

async function startQueueAudioAfterRequeue(tx, ctx) {
  if (!ctx.data.queueAudioMediaName) return;

  const [queueResult, positionResult] = await Promise.all([
    tx.query(`SELECT * FROM cc_queues WHERE id = $1`, [ctx.data.queueId]),
    tx.query(
      `SELECT count(*)::int AS ahead
         FROM acd_work_items
        WHERE queue_id = $1
          AND state = 'queued'
          AND enqueued_at < (SELECT enqueued_at FROM acd_work_items WHERE id = $2)`,
      [ctx.data.queueId, ctx.workItem.id],
    ),
  ]);
  const queue = queueResult.rows[0];
  if (!queue) return;

  const queueConfig = {
    ...queue,
    queue_audio_media_name:
      ctx.data.queueAudioMediaName || queue.queue_audio_media_name,
  };
  const position = Number(positionResult.rows[0]?.ahead || 0) + 1;
  const callControlId = ctx.data.customerProviderCallId;
  const clientState = ctx.data.clientState || null;

  ctx.defer(async () => {
    const { startQueueAudio } = await import(
      "../../contact-center/queue-audio-service.js"
    );
    // The requeue command has already stopped provider media. A local session
    // may belong to a different web node/generation and is not evidence that
    // anything is still audible, so force a fresh provider start here.
    await startQueueAudio(
      callControlId,
      ctx.data.queueId,
      queueConfig,
      position,
      { clientState, deduplicate: false },
    );
  });
}

const DEFAULT_ANSWER_TIMEOUT_MS = 30_000;
const DEFAULT_WRAPUP_DEADLINE_MS = 120_000; // design §13 Q3 proposal
const MAX_CALL_GUARD_MS = 8 * 60 * 60 * 1000;

async function liveAgentLeg(tx, workItemId) {
  const result = await tx.query(
    `SELECT id, provider_call_id FROM acd_legs
      WHERE work_item_id = $1
        AND role IN ('agent_device', 'agent_transport')
        AND ended_at IS NULL
      ORDER BY CASE WHEN role = 'agent_device' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
    [workItemId],
  );
  return result.rows[0] || null;
}

async function customerEnded(tx, ctx) {
  if(ctx.data.agentFirst) {
    const parent=(await tx.query("SELECT data,state FROM acd_sagas WHERE id=$1",[ctx.data.outboundSagaId])).rows[0];
    const campaign=(await tx.query("SELECT status FROM outbound_campaigns WHERE id=$1",[parent?.data?.campaignId])).rows[0];
    const ready=(await tx.query("SELECT 1 FROM acd_agent_state a JOIN acd_reservations r ON r.agent_id=a.agent_id AND r.id=$2 WHERE a.agent_id=$1 AND a.presence='online' AND a.manual_status='Available' AND r.state<>'released' AND EXISTS(SELECT 1 FROM acd_agent_sessions s WHERE s.agent_id=a.agent_id AND s.state='online' AND s.expires_at>now() AND s.capabilities->>'voice'='true')",[ctx.data.agentId,ctx.data.reservationId])).rowCount;
    // Pause is a drain operation. Once a customer leg exists, the in-flight
    // interaction must still be allowed to reach its reserved agent. A pause
    // before the customer Dial remains blocked by outbound-connect's own
    // pre-send guards, while Stop continues to cancel here.
    const customerStarted=Boolean(ctx.data.customerReady||parent?.data?.customerProviderCallId);
    const campaignAllowsDrain=campaign?.status==="running"||(campaign?.status==="paused"&&customerStarted);
    if(!ready||ctx.data.cancelRequested||parent?.data?.cancelRequested||parent?.state!=="running"||!campaignAllowsDrain) return "agent_first_cancel";
  }
  const result = await tx.query(`SELECT 1 FROM acd_legs WHERE work_item_id=$1
    AND role='customer' AND ended_at IS NOT NULL LIMIT 1`, [ctx.workItem.id]);
  return result.rowCount > 0 ? "abandon_during_offer" : null;
}

// A rejected command is not a signed media-end event. Stop issuing customer
// commands after 90018, but retain ownership until intake persists the hangup.
function customerCommandFailure(operation, fallback) {
  return async (tx, ctx) => {
    const ended = await customerEnded(tx, ctx);
    if (ended) return ended;
    const result = await tx.query(`SELECT response FROM acd_commands
      WHERE saga_id=$1 AND operation=$2 AND status='failed'
      ORDER BY created_at DESC LIMIT 1`, [ctx.saga.id, operation]);
    return result.rows[0]?.response?.errors?.some(error => String(error.code) === "90018")
      ? "await_customer_end" : fallback;
  };
}

export const connectSaga = defineSaga("connect", {
  initialStep: "stop_queue_playback",
  compensationSteps: [
    "cancel_agent_leg",
    "send_cancel",
    "prepare_requeue",
    "fail_direct_inbound",
    "enqueue_customer",
    "complete_requeue",
    "requeue_failed",
    "abandon_during_offer",
  ],
  steps: {
    stop_queue_playback: {
      guard: customerEnded,
      cmd: (ctx) => ({
        operation: "stop_queue_playback",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_stop`,
        request: { stop: "all" },
      }),
      // playback_stop with stop:all also stops active speech, so this single
      // provider command covers both queue music and position TTS.
      on: { accepted: "dial_agent", "leg.ended:customer": "abandon_during_offer" },
      deadlineMs: 5_000,
      onDeadline: "dial_agent",
      onFailure: "check_playback_failure",
    },

    dial_agent: {
      guard: customerEnded,
      // Durable expectation BEFORE the command (design principle 2): the
      // transfer response may prove only a transport sibling; the device leg
      // binds later from a signed webhook against this intent.
      prepare: async (tx, ctx) => {
        await tx.query(
          `INSERT INTO acd_leg_intents
             (id, work_item_id, reservation_id, agent_id, offer_generation,
              expected_role, command_id, state, deadline_at)
           VALUES ($1, $2, $3, $4, $5, 'agent_device', $6, 'pending',
                   now() + ($7::text || ' milliseconds')::interval)
           ON CONFLICT (work_item_id, expected_role, offer_generation) DO NOTHING`,
          [
            randomUUID(),
            ctx.workItem.id,
            ctx.data.reservationId,
            ctx.data.agentId,
            ctx.data.generation,
            ctx.commandId,
            String(ctx.data.answerTimeoutMs || DEFAULT_ANSWER_TIMEOUT_MS),
          ],
        );
        await promoteReservation(tx, {
          reservationId: ctx.data.reservationId,
          to: "ringing",
          leaseMs: (ctx.data.answerTimeoutMs || DEFAULT_ANSWER_TIMEOUT_MS) + 10_000,
          actor: "saga:connect",
        });
        await resolveOffer(tx, ctx.data.offerId, "ringing", { actor: "saga:connect" });
      },
      cmd: (ctx) => ctx.data.agentFirst ? ({
        operation: "outbound_agent_dial", endpoint: "/calls",
        request: {...ctx.data.agentDialPayload,to:ctx.data.agentSipUri,timeout_secs:Math.ceil((ctx.data.answerTimeoutMs||DEFAULT_ANSWER_TIMEOUT_MS)/1000),
          client_state:Buffer.from(JSON.stringify({acdWorkItemId:ctx.workItem.id,acdRole:"agent_transport"})).toString("base64"),
          custom_headers:[{name:"X-CC-Work-Item-Id",value:String(ctx.workItem.id)},{name:"X-CC-Offer-Generation",value:String(ctx.data.generation)},{name:"X-CC-Connect-Command-Id",value:String(ctx.commandId)}]},
      }) : ({
        operation: "transfer_to_agent",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/transfer`,
        request: {
          to: ctx.data.agentSipUri,
          connection_id: ctx.data.connectionId || undefined,
          from: ctx.workItem.customer_address || undefined,
          caller_id_name: ctx.data.customerName || undefined,
          // Core owns the earlier deadline. Provider timeout is deliberately
          // later so the reconciler has time to cancel and re-enqueue the
          // customer before Telnyx tears down the transfer topology.
          timeout_secs: Math.ceil((ctx.data.answerTimeoutMs || DEFAULT_ANSWER_TIMEOUT_MS) / 1000) + 15,
          park_after_unbridge: "self",
          // The customer leg already carries the call-flow client state, but
          // Telnyx does not implicitly copy it to the new transfer leg. Agent
          // Assist starts standalone STT on that controllable transport leg,
          // so explicitly propagate the state to every webhook for the leg.
          target_leg_client_state: ctx.data.clientState || undefined,
          custom_headers: [
            { name: "X-CC-Work-Item-Id", value: String(ctx.workItem.id) },
            { name: "X-CC-Offer-Generation", value: String(ctx.data.generation) },
            { name: "X-CC-Connect-Command-Id", value: String(ctx.commandId) },
          ],
        },
      }),
      // A standalone agent Dial returns the new transport call_control_id, while
      // the transfer command normally returns only { result: "ok" }. Persist and
      // prewarm only when the provider actually supplies an id; transferred legs
      // are bound later from their signed webhook events.
      onAccepted: async (client, { saga, response }) => {
        const data = saga.data || {};
        const agentLegProviderId = response?.data?.call_control_id || null;
        if (agentLegProviderId) {
          // The transfer response can prove only the TRANSPORT sibling of the
          // agent's WebRTC device leg (design principle 2). Role it as
          // agent_transport; the device leg binds from its own call.initiated
          // headers. Intake normalizes transport→device for saga events.
          await client.query(
            `INSERT INTO acd_legs
               (id, work_item_id, role, provider_call_id, offer_generation, owner_saga_id, state, agent_id)
             VALUES ($1, $2, 'agent_transport', $3, $4, $5, 'ringing', $6)
             ON CONFLICT (provider_call_id) DO NOTHING`,
            [randomUUID(), saga.work_item_id, agentLegProviderId, data.generation ?? null, saga.id, data.agentId],
          );
          await client.query(
            `UPDATE acd_leg_intents
                SET transport_call_id = $3
              WHERE work_item_id = $1 AND offer_generation = $2
                AND state IN ('pending', 'bound')`,
            [saga.work_item_id, data.generation ?? null, agentLegProviderId],
          );
          // This is reachable for agent-first Dial. Transfer responses do not
          // include the target leg id; their answered event starts the same
          // idempotent media command once the webhook identifies the transport.
          void prewarmAgentAssistTransport({
            callControlId: agentLegProviderId,
            clientState: data.clientState,
            interactionId: data.interactionId || saga.work_item_id,
            agentUsername: data.agentUsername,
          }).catch(() => {});
        }
        try {
            const { broadcastToKey } = await import("../../sse.js");
            const { storeIncomingCallData } = await import("../../incoming-call-store.js");
            const info = {
              fromNumber: data.customerNumber || null,
              fromName: data.customerName || null,
              callControlId: agentLegProviderId,
              originalCallControlId: data.customerProviderCallId || null,
              callSessionId: data.customerSessionId || null,
              interactionId: data.interactionId || saga.work_item_id,
              queueName: data.queueName || null,
              queuedAt: data.enqueuedAt || null,
              assignedAt: new Date().toISOString(),
              metadata: data.interactionMetadata || {},
            };
            if (data.customerSessionId) storeIncomingCallData(`session:${data.customerSessionId}`, info);
            if (agentLegProviderId) storeIncomingCallData(agentLegProviderId, info);
            if (data.customerNumber) storeIncomingCallData(`phone:${data.customerNumber}`, info);
            await broadcastToKey(`user:status:${data.agentId}`, {
              type: "incoming_call_info",
              ...info,
              contactCenter: {
                interactionId: info.interactionId,
                queueName: info.queueName,
                queuedAt: info.queuedAt,
                assignedAt: info.assignedAt,
              },
            }, "incoming_call_info");
        } catch {
          /* softphone toast is best-effort */
        }
      },
      on: {
        "leg.answered:agent_device": "await_bridge",
        "leg.ended:agent_device": "prepare_requeue", // agent rejected / device leg died pre-answer
        "leg.ended:customer": "abandon_during_offer",
      },
      deadlineMs: (ctx) => ctx.data?.answerTimeoutMs || DEFAULT_ANSWER_TIMEOUT_MS,
      onDeadline: "cancel_agent_leg",
      onFailure: "check_transfer_failure",
    },

    await_bridge: {
      run: async (tx, ctx) => {
        if (ctx.data.agentFirst) {
          if (!ctx.data.customerReady) return "agent_first_wait_customer";
          if (!ctx.data.bridgeRequested) return "agent_first_bridge";
        }
        const customer = await tx.query(
          `SELECT state, ended_at FROM acd_legs
            WHERE work_item_id = $1 AND role = 'customer'
            ORDER BY created_at DESC LIMIT 1`,
          [ctx.workItem.id],
        );
        if (customer.rows[0]?.ended_at) return "abandon_during_offer";
        if (customer.rows[0]?.state === "bridged") return "establish";
        return null;
      },
      on: {
        "leg.bridged:customer": "establish",
        "leg.ended:agent_device": "prepare_requeue",
        "leg.ended:customer": "abandon_during_offer",
      },
      deadlineMs: 10_000,
      onDeadline: "cancel_agent_leg",
    },

    agent_first_wait_customer: {
      run: async(tx,ctx)=>{
        const cancelled=await customerEnded(tx,ctx);if(cancelled)return 'agent_first_cancel';
        if(ctx.data.cancelRequested)return 'agent_first_cancel';
        const device=(await tx.query("SELECT * FROM acd_legs WHERE work_item_id=$1 AND owner_saga_id=$2 AND role='agent_device' ORDER BY created_at DESC LIMIT 1",[ctx.workItem.id,ctx.saga.id])).rows[0];
        if(device?.ended_at)return 'agent_first_cancel';
        if(ctx.data.customerReady&&device?.answered_at)return 'agent_first_bridge';
        return null;
      },
      on:{'leg.ended:agent_device':'agent_first_cancel','leg.ended:agent_transport':'agent_first_cancel','leg.ended:customer':'agent_first_cancel'},
      deadlineMs:1000,
    },
    agent_first_bridge: {
      guard:async(tx,ctx)=>{
        const dead=await customerEnded(tx,ctx);if(dead)return 'agent_first_cancel';
        const ready=(await tx.query("SELECT 1 FROM acd_legs WHERE work_item_id=$1 AND owner_saga_id=$2 AND role='agent_device' AND answered_at IS NOT NULL AND ended_at IS NULL",[ctx.workItem.id,ctx.saga.id])).rowCount;
        return ready?null:'agent_first_cancel';
      },
      prepare: async (tx, ctx) => {
        await tx.query(
          `UPDATE acd_sagas
              SET data = data || '{"bridgeRequested":true}'::jsonb
            WHERE id = $1`,
          [ctx.saga.id],
        );
      },
      cmd:async ctx=>{
        const transport=(await ctx.tx.query("SELECT provider_call_id FROM acd_legs WHERE work_item_id=$1 AND owner_saga_id=$2 AND role='agent_transport' AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1",[ctx.workItem.id,ctx.saga.id])).rows[0];
        if(!transport)throw new Error('Answered agent transport is missing');
        return {operation:'outbound_agent_bridge',endpoint:`/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/bridge`,request:{call_control_id:transport.provider_call_id}};
      },
      on:{accepted:'await_bridge','leg.bridged:customer':'establish','leg.ended:customer':'agent_first_cancel','leg.ended:agent_device':'agent_first_cancel'},
      deadlineMs:10000,onDeadline:'agent_first_cancel',onFailure:'agent_first_cancel',
    },
    agent_first_cancel: {run:async(tx,ctx)=>{
      await tx.query("UPDATE acd_sagas SET data=data || '{\"connectionFailed\":true}'::jsonb WHERE id=$1",[ctx.data.outboundSagaId]);
      await tx.query("UPDATE acd_leg_intents SET state='cancelled' WHERE work_item_id=$1 AND offer_generation=$2 AND state='pending'",[ctx.workItem.id,ctx.data.generation]);
      await resolveOffer(tx,ctx.data.offerId,'cancelled',{reason:'outbound_agent_not_connected',actor:'saga:connect'});
      await releaseReservation(tx,ctx.data.reservationId,'outbound_agent_not_connected',{actor:'saga:connect'});
      return 'succeeded';
    }},

    establish: {
      run: async (tx, ctx) => {
        // A late bridge must not promote an assignment the origination owner
        // has already abandoned; that would leave the ledger 'abandoned' while
        // the work item goes 'active', after promoting the reservation and
        // accepting the offer. This applies to every ordering an outbound
        // attempt can use, not only the customer-first one, so it keys on the
        // owning outbound saga rather than on the leg order. Only an explicit
        // cancellation blocks promotion — agent presence or a pending manual
        // status must not, or a status picked mid-call would tear down an
        // established bridge.
        if (ctx.data.outboundSagaId || ctx.data.cancelRequested) {
          const parent = ctx.data.outboundSagaId
            ? (await tx.query(`SELECT data FROM acd_sagas WHERE id = $1`, [ctx.data.outboundSagaId])).rows[0]
            : null;
          if (ctx.data.cancelRequested || parent?.data?.cancelRequested) {
            return ctx.data.agentFirst ? "agent_first_cancel" : "abandon_during_offer";
          }
        }
        const handlingSessionId = randomUUID();
        await promoteReservation(tx, {
          reservationId: ctx.data.reservationId,
          to: "active",
          handlingSessionId,
          actor: "saga:connect",
        });
        await resolveOffer(tx, ctx.data.offerId, "accepted", { actor: "saga:connect" });
        const answeredAt = new Date().toISOString();
        await closeOpenSegment(tx, ctx.workItem.id, {
          outcome: "answered",
          answeredAt,
          endedAt: answeredAt,
        });
        await openSegment(tx, {
          workItemId: ctx.workItem.id,
          kind: "agent",
          agentId: ctx.data.agentId,
          queueId: ctx.data.queueId,
          startedAt: answeredAt,
          answeredAt,
        });
        const transition = await applyTransition(tx, {
          workItemId: ctx.workItem.id,
          to: "active",
          eventType: "work_item_answered",
          payload: { agent_id: ctx.data.agentId, handling_session_id: handlingSessionId },
          actor: "saga:connect",
        });
        if (!transition.applied) return "finalize"; // terminal race — finalize cleans up
        await setWorkflowState(tx, ctx.data.agentId, "handling", {
          actor: "saga:connect",
          workItemId: ctx.workItem.id,
        });
        return "in_call";
      },
    },

    in_call: {
      on: {
        "leg.ended:customer": "finalize",
        // A transfer intent is persisted before provider I/O. If unbridging
        // ends the old device leg, the transfer saga owns the surviving
        // customer; otherwise preserve the normal hangup behaviour.
        "leg.ended:agent_device": "agent_ended_or_handoff",
      },
      deadlineMs: (ctx) => ctx.data?.maxCallDurationMs || MAX_CALL_GUARD_MS,
      onDeadline: "hangup_customer",
    },

    // An elapsed guard is not evidence that media stopped. Keep the assignment
    // and reservation until a signed end event or an audited recovery proves it.
    verify_call_end: {
      run: async (tx, ctx) => {
        const legs = await tx.query(
          `SELECT state, ended_at FROM acd_legs
            WHERE work_item_id = $1 AND role = 'customer'`,
          [ctx.workItem.id],
        );
        if (legs.rows.length > 0 && legs.rows.every(leg => leg.state === "ended" && leg.ended_at)) {
          return "finalize";
        }
        const previous = await tx.query(
          `SELECT 1 FROM acd_events WHERE work_item_id = $1
            AND type = 'manual_intervention_required'
            AND payload->>'saga_id' = $2
            AND payload->>'reason' = 'call_end_evidence_missing' LIMIT 1`,
          [ctx.workItem.id, ctx.saga.id],
        );
        if (!previous.rows.length) await appendEvent(tx, {
          workItemId: ctx.workItem.id,
          agentId: ctx.data.agentId,
          type: "manual_intervention_required",
          payload: { saga_id: ctx.saga.id, reason: "call_end_evidence_missing", reservation_preserved: true },
          actor: "reconciler",
        });
        return "await_call_end_evidence";
      },
    },

    await_call_end_evidence: {
      on: {
        "leg.ended:customer": "finalize",
        "leg.ended:agent_device": "agent_ended_or_handoff",
      },
      deadlineMs: 60 * 60 * 1000,
      onDeadline: "verify_call_end",
    },

    agent_ended_or_handoff: {
      run: async (tx, ctx) => {
        const current = await tx.query(
          `SELECT handoff_saga_id FROM acd_work_items WHERE id = $1`,
          [ctx.workItem.id],
        );
        return current.rows[0]?.handoff_saga_id
          ? "handoff"
          : "hangup_customer";
      },
    },

    // A Phase C call-control saga has taken ownership. Do not finalize the
    // work item or hang up the customer from the old assignment saga.
    handoff: {
      run: async () => "succeeded",
    },

    hangup_customer: {
      run: async (tx, ctx) => {
        const live = await tx.query(
          `SELECT 1 FROM acd_legs
            WHERE work_item_id = $1 AND role = 'customer' AND ended_at IS NULL`,
          [ctx.workItem.id],
        );
        return live.rows.length > 0 ? "send_hangup_customer" : "finalize";
      },
    },

    send_hangup_customer: {
      cmd: (ctx) => ({
        operation: "hangup_customer_leg",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/hangup`,
        request: {},
      }),
      on: { accepted: "await_call_end_evidence", "leg.ended:customer": "finalize" },
      deadlineMs: 10_000,
      onDeadline: "verify_call_end",
      onFailure: "verify_call_end",
    },

    finalize: {
      run: async (tx, ctx) => {
        await closeOpenSegment(tx, ctx.workItem.id, { outcome: "completed" });
        await releaseReservation(tx, ctx.data.reservationId, "completed", { actor: "saga:connect" });
        const suppressWrapup = ctx.workItem.attributes?.suppress_wrapup === true;
        const wrapupMs = ctx.data.wrapupDeadlineMs || DEFAULT_WRAPUP_DEADLINE_MS;
        if (!suppressWrapup && ctx.data.afterWrapupStatus === "available") {
          await setSystemAgentStatus(tx, ctx.data.agentId, "Available", {
            actor: "saga:connect",
            workItemId: ctx.workItem.id,
            reason: "after_wrapup_policy",
          });
        }
        await setWorkflowState(tx, ctx.data.agentId, suppressWrapup ? "idle" : "wrapup", {
          deadlineAt: suppressWrapup
            ? null
            : new Date(Date.now() + wrapupMs).toISOString(),
          actor: "saga:connect",
          workItemId: ctx.workItem.id,
          reason: suppressWrapup ? "wrapup_suppressed" : undefined,
        });
        await applyTransition(tx, {
          workItemId: ctx.workItem.id,
          to: "completed",
          eventType: "work_item_completed",
          payload: { agent_id: ctx.data.agentId },
          actor: "saga:connect",
          patch: { terminalReason: "call_ended" },
        });
        return "succeeded";
      },
    },

    // ---- compensations ----

    cancel_agent_leg: {
      run: async (tx, ctx) => {
        await tx.query(
          `UPDATE acd_leg_intents SET state = 'cancelled'
            WHERE work_item_id = $1 AND offer_generation = $2 AND state = 'pending'`,
          [ctx.workItem.id, ctx.data.generation],
        );
        const leg = await liveAgentLeg(tx, ctx.workItem.id);
        return leg ? "send_cancel" : "prepare_requeue";
      },
    },

    send_cancel: {
      cmd: async (ctx) => {
        const leg = await liveAgentLeg(ctx.tx, ctx.workItem.id);
        return {
          operation: "hangup_agent_leg",
          targetLegId: leg?.id || null,
          endpoint: `/calls/${encodeURIComponent(leg?.provider_call_id || "unknown")}/actions/hangup`,
          request: {},
        };
      },
      on: { accepted: "prepare_requeue", "leg.ended:agent_device": "prepare_requeue" },
      deadlineMs: 10_000,
      onDeadline: "prepare_requeue",
      onFailure: "prepare_requeue", // 404 = already gone — exactly what we want
    },

    prepare_requeue: {
      run: async (tx, ctx) => {
        if(ctx.data.agentFirst)return "agent_first_cancel";
        const ended = await customerEnded(tx, ctx);
        if (ended) return ended;
        const rejected = (await tx.query(`SELECT 1 FROM acd_legs l
          WHERE l.work_item_id=$1 AND l.owner_saga_id=$2 AND l.offer_generation=$3
            AND l.role='agent_device' AND l.ended_at IS NOT NULL AND l.answered_at IS NULL
            AND l.ended_reason IN ('user_busy','call_rejected')
            AND NOT EXISTS(SELECT 1 FROM acd_commands c WHERE c.saga_id=$2 AND c.operation='hangup_agent_leg')`,
        [ctx.workItem.id,ctx.saga.id,ctx.data.generation])).rowCount > 0;
        const outcome=rejected?'rejected':'no_answer';
        const reason=rejected?'agent_rejected':'agent_no_answer';
        await tx.query(`UPDATE acd_sagas SET data=data || jsonb_build_object('requeueReason',$2::text) WHERE id=$1`,[ctx.saga.id,reason]);
        await resolveOffer(tx, ctx.data.offerId, outcome, {
          reason,
          actor: "saga:connect",
        });
        await releaseReservation(tx, ctx.data.reservationId, outcome, { actor: "saga:connect" });
        await setWorkflowState(tx, ctx.data.agentId, "idle", {
          actor: "saga:connect",
          workItemId: ctx.workItem.id,
          reason: outcome,
        });
        if (outcome === "no_answer" && ctx.data.noAnswerStatus === "available") {
          await setSystemAgentStatus(tx, ctx.data.agentId, "Available", {
            actor: "saga:connect",
            workItemId: ctx.workItem.id,
            reason: outcome,
          });
        } else if (outcome === "no_answer") {
          await setSystemAgentStatus(tx, ctx.data.agentId, "Agent Not Answering", {
            actor: "saga:connect",
            workItemId: ctx.workItem.id,
            reason: outcome,
          });
        } else {
          await setAgentRoutability(tx, ctx.data.agentId, false, {
            actor: "saga:connect",
            reason: outcome,
          });
        }
        if (!ctx.data.queueName && ctx.workItem.outbound_attempt_id) {
          // Preview/progressive may have no queue. The origination owner ends
          // the customer call; do not issue an enqueue with an empty queue.
          await tx.query(`UPDATE acd_sagas SET data=data || '{"connectionFailed":true}'::jsonb
            WHERE work_item_id=$1 AND type='outbound_connect' AND state IN ('running','compensating')`,[ctx.workItem.id]);
          return 'await_outbound_end';
        }
        if (!ctx.data.queueName
            && ctx.workItem.attributes?.voice_occupancy_kind === "direct_inbound") {
          return "fail_direct_inbound";
        }
        return "enqueue_customer";
      },
    },

    fail_direct_inbound: {
      run: async (tx, ctx) => {
        await closeOpenSegment(tx, ctx.workItem.id, {
          outcome: ctx.data.requeueReason === "agent_rejected"
            ? "no_answer"
            : "failed",
        });
        await applyTransition(tx, {
          workItemId: ctx.workItem.id,
          to: "failed",
          eventType: "direct_inbound_unanswered",
          payload: {
            agent_id: ctx.data.agentId,
            reason: ctx.data.requeueReason || "agent_no_answer",
          },
          actor: "saga:connect",
          patch: {
            terminalReason: ctx.data.requeueReason || "agent_no_answer",
          },
        });
        return "succeeded";
      },
    },

    await_outbound_end: {
      run: async (tx,ctx) => {
        const customer=(await tx.query(`SELECT ended_at FROM acd_legs WHERE work_item_id=$1 AND role='customer'`,[ctx.workItem.id])).rows[0];
        return customer?.ended_at ? 'abandon_during_offer' : null;
      },
      on:{'leg.ended:customer':'abandon_during_offer'},deadlineMs:60000,onDeadline:'outbound_end_alarm',
    },
    outbound_end_alarm: {run:async(tx,ctx)=>{
      const prior=await tx.query(`SELECT 1 FROM acd_events WHERE type='manual_intervention_required' AND payload->>'saga_id'=$1`,[ctx.saga.id]);
      if(!prior.rowCount) await appendEvent(tx,{workItemId:ctx.workItem.id,agentId:ctx.data.agentId,type:'manual_intervention_required',actor:'saga:connect',payload:{saga_id:ctx.saga.id,reason:'outbound_end_unconfirmed'}});
      return 'await_outbound_end';
    }},

    enqueue_customer: {
      guard: customerEnded,
      cmd: (ctx) => ({
        operation: "enqueue_customer_leg",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/enqueue`,
        request: {
          queue_name: ctx.data.queueName,
          client_state: ctx.data.clientState || undefined,
        },
      }),
      on: {
        accepted: "complete_requeue",
        "leg.enqueued:customer": "complete_requeue",
        "leg.ended:customer": "abandon_during_offer",
      },
      deadlineMs: 10_000,
      onDeadline: "requeue_failed",
      onFailure: "check_enqueue_failure",
    },

    complete_requeue: {
      run: async (tx, ctx) => {
        const ended = await customerEnded(tx, ctx);
        if (ended) return ended;
        // Original enqueued_at is preserved: the caller keeps their queue position.
        await applyTransition(tx, {
          workItemId: ctx.workItem.id,
          to: "queued",
          eventType: "work_item_requeued",
          payload: { agent_id: ctx.data.agentId, reason: ctx.data.requeueReason || "agent_no_answer" },
          actor: "saga:connect",
        });
        await startQueueAudioAfterRequeue(tx, ctx);
        // `succeeded` is committed in this same transaction as `queued`.
        // A worker can therefore never reserve the next agent while this
        // assignment saga still owns the conflict key.
        return "succeeded";
      },
    },

    requeue_failed: {
      run: async (tx, ctx) => {
        const ended = await customerEnded(tx, ctx);
        if (ended) return ended;
        await closeOpenSegment(tx, ctx.workItem.id, { outcome: "failed" });
        await applyTransition(tx, {
          workItemId: ctx.workItem.id,
          to: "failed",
          eventType: "work_item_requeue_failed",
          payload: { agent_id: ctx.data.agentId, reason: "provider_enqueue_failed" },
          actor: "saga:connect",
          patch: { terminalReason: "provider_enqueue_failed" },
        });
        return "failed";
      },
    },

    abandon_during_offer: {
      run: async (tx, ctx) => {
        await tx.query(`UPDATE acd_leg_intents SET state='cancelled'
          WHERE work_item_id=$1 AND offer_generation=$2 AND state='pending'`,
        [ctx.workItem.id, ctx.data.generation]);
        await resolveOffer(tx, ctx.data.offerId, "cancelled", {
          reason: "customer_abandoned",
          actor: "saga:connect",
        });
        await releaseReservation(tx, ctx.data.reservationId, "customer_abandoned", {
          actor: "saga:connect",
        });
        await setWorkflowState(tx, ctx.data.agentId, "idle", {
          actor: "saga:connect",
          workItemId: ctx.workItem.id,
          reason: "customer_abandoned",
        });
        await closeOpenSegment(tx, ctx.workItem.id, { outcome: "abandoned" });
        await applyTransition(tx, {
          workItemId: ctx.workItem.id,
          to: "abandoned",
          eventType: "work_item_abandoned",
          payload: { agent_id: ctx.data.agentId },
          actor: "saga:connect",
          patch: { terminalReason: "customer_abandoned_during_offer" },
        });
        return "succeeded";
      },
    },

    check_playback_failure: { run: customerCommandFailure("stop_queue_playback", "dial_agent") },
    check_transfer_failure: { run: customerCommandFailure("transfer_to_agent", "prepare_requeue") },
    check_enqueue_failure: { run: customerCommandFailure("enqueue_customer_leg", "requeue_failed") },
    await_customer_end: {
      run: customerEnded,
      on: { "leg.ended:customer": "abandon_during_offer" },
      deadlineMs: 60_000,
      onDeadline: "customer_end_alarm",
    },
    customer_end_alarm: {
      run: async (tx, ctx) => {
        const ended = await customerEnded(tx, ctx);
        if (ended) return ended;
        const prior = await tx.query(`SELECT 1 FROM acd_events WHERE work_item_id=$1
          AND type='manual_intervention_required' AND payload->>'saga_id'=$2
          AND payload->>'reason'='customer_end_evidence_missing' LIMIT 1`, [ctx.workItem.id, ctx.saga.id]);
        if (!prior.rowCount) await appendEvent(tx, {
          workItemId: ctx.workItem.id, agentId: ctx.data.agentId,
          type: "manual_intervention_required", actor: "saga:connect",
          payload: { saga_id: ctx.saga.id, reason: "customer_end_evidence_missing" },
        });
        return "await_customer_end";
      },
    },
  },
});

/** Start `connect` for a successful routeOne result, inside the caller's txn. */
export async function startConnectSaga(db, params) {
  const lifecycle = await loadAgentLifecycleSettings(db);
  const {
    workItem,
    routeResult,
    customerProviderCallId,
    agentSipUri,
    agentDisplayName = null,
    answerTimeoutMs = lifecycle.default_answer_timeout_seconds * 1000,
    wrapupDeadlineMs = lifecycle.wrapup_timeout_seconds * 1000,
    maxCallDurationMs = lifecycle.max_call_duration_seconds * 1000,
    afterWrapupStatus = lifecycle.after_wrapup_status,
    noAnswerStatus = lifecycle.no_answer_status,
    // live-mode extras (Phase B)
    connectionId = null,
    agentUsername = null,
    customerNumber = null,
    customerName = null,
    customerSessionId = null,
    interactionId = null,
    queueName = null,
    enqueuedAt = null,
    interactionMetadata = null,
    clientState = null,
    queueAudioMediaName = null,
    skipQueuePlayback = params.skipQueuePlayback || false,
    agentFirst = params.agentFirst || false,
    customerReady = params.customerReady || false,
    outboundSagaId = params.outboundSagaId || null,
    agentDialPayload = params.agentDialPayload || null,
  } = params;
  return startSaga(db, {
    type: "connect",
    initialStep: params.connected
      ? "in_call"
      : params.agentFirst || skipQueuePlayback
        ? "dial_agent"
        : null,
    workItemId: workItem.id,
    conflictKey: "assignment",
    data: {
      agentFirst,
      customerReady,
      outboundSagaId,
      agentDialPayload,
      agentId: routeResult.agentId,
      reservationId: routeResult.reservationId,
      offerId: routeResult.offerId,
      generation: routeResult.generation,
      queueId: workItem.queue_id,
      customerProviderCallId,
      agentSipUri,
      agentDisplayName,
      answerTimeoutMs,
      wrapupDeadlineMs,
      maxCallDurationMs,
      afterWrapupStatus,
      noAnswerStatus,
      connectionId,
      agentUsername,
      customerNumber,
      customerName,
      customerSessionId,
      interactionId,
      queueName,
      enqueuedAt,
      interactionMetadata,
      clientState,
      queueAudioMediaName,
      skipQueuePlayback,
    },
  });
}
