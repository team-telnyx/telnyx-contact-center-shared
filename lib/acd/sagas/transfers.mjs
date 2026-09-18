// Phase C transfer/consult sagas. Provider acceptance is never treated as the
// outcome: target answer/bridge, queue enqueue and leg end webhooks are the
// authoritative evidence that advances these state machines.

import { randomUUID } from "node:crypto";
import { defineSaga, startSaga } from "../saga-engine.mjs";
import { applyTransition, closeOpenSegment, openSegment } from "../lifecycle.mjs";
import { releaseReservation, resolveOffer } from "../reservations.mjs";
import { setSystemAgentStatus, setWorkflowState } from "../agent-state.mjs";
import { loadAgentLifecycleSettings } from "../agent-lifecycle-settings.mjs";
import { appendEvent } from "../events.mjs";
import { reserveTransferTarget, adoptTransferTarget, transferTargetReadyForAdoption } from "../transfer-capacity.mjs";
import { startConnectSaga } from "./connect.mjs";
import { normalizeSkills, requiredSkillsFor } from "../skills.mjs";

const TARGET_TIMEOUT_MS = 30_000;
const WRAPUP_DEADLINE_MS = 120_000;
const CONSULT_GUARD_MS = 8 * 60 * 60 * 1000;
const TRANSFER_GUARD_MS = 8 * 60 * 60 * 1000;
const CONSULT_RESTORE_RETRY_DELAY_MS = 300;

function consultRestoreCommand(ctx, operation) {
  // Before the first consultation connects, the fresh browser INVITE is
  // unanswered. The answered customer must initiate Bridge so the provider
  // answers that peer; sending Bridge to the ringing browser returns 90034.
  const fromCustomer = ctx.data.restoreFromAnsweredCustomer === true;
  return {
    operation,
    endpoint: `/calls/${encodeURIComponent(fromCustomer ? ctx.data.customerProviderCallId : ctx.data.agentProviderCallId)}/actions/bridge`,
    request: {
      call_control_id: fromCustomer ? ctx.data.agentProviderCallId : ctx.data.customerProviderCallId,
      park_after_unbridge: "self",
    },
  };
}

function consultHoldMediaName(ctx) {
  return ctx.data.consultHoldMediaName || ctx.data.sourceQueueAudioMediaName || null;
}

function hasConsultHoldAnnouncement(ctx) {
  return Boolean(
    ctx.data.consultHoldAnnouncementEnabled &&
      ctx.data.consultHoldAnnouncementText &&
      ctx.data.consultHoldAnnouncementVoice,
  );
}

function consultHoldAnnouncementIntervalMs(ctx) {
  const seconds = Number(ctx.data.consultHoldAnnouncementIntervalSeconds) || 60;
  return Math.min(300, Math.max(10, seconds)) * 1000;
}

function consultHoldSpeakRequest(ctx) {
  const request = {
    payload: String(ctx.data.consultHoldAnnouncementText || "").slice(0, 3000),
    voice: ctx.data.consultHoldAnnouncementVoice,
    target_legs: "self",
  };
  if (ctx.data.consultHoldAnnouncementLanguage) {
    request.language = ctx.data.consultHoldAnnouncementLanguage;
  }
  if (
    /^ElevenLabs\./i.test(String(ctx.data.consultHoldAnnouncementVoice || "")) &&
    ctx.data.consultHoldAnnouncementVoiceApiKeyRef
  ) {
    request.voice_settings = {
      type: "elevenlabs",
      api_key_ref: ctx.data.consultHoldAnnouncementVoiceApiKeyRef,
    };
  }
  return request;
}

async function notifyIntent(ctx, status, extra = {}) {
  const interactionId = ctx.data.interactionId || ctx.workItem.id;
  const payload = {
    type: "acd_intent_updated",
    interactionId,
    workItemId: ctx.workItem.id,
    sagaId: ctx.saga.id,
    intent: ctx.saga.type,
    status,
    target: ctx.data.target || null,
    targetKind: ctx.data.targetKind || null,
    targetLabel: ctx.data.targetLabel || null,
    ...extra,
  };
  ctx.defer(async () => {
    try {
      const { broadcastToKey } = await import("../../sse.js");
      if (ctx.data.agentUsername) {
        await broadcastToKey(`contact-center:agent:${ctx.data.agentUsername}`, payload);
      }
    } catch {
      // DB state is authoritative; the modal also recovers through GET/poll.
    }
  });
}

async function updateIntentMetadata(_tx, ctx, state, extra = {}) {
  await notifyIntent(ctx, state, extra);
}

async function clearHandoff(tx, workItemId) {
  await tx.query(
    `UPDATE acd_work_items
        SET handoff_saga_id = NULL, version = version + 1
      WHERE id = $1`,
    [workItemId],
  );
}

async function supersedeSourceMediaSaga(tx, workItemId, reason) {
  const rows = await tx.query(
    `UPDATE acd_sagas
        SET state = 'succeeded', step = 'succeeded', terminal_at = now(),
            lease_owner = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, $2)
      WHERE work_item_id = $1 AND type IN ('connect', 'manual_outbound')
        AND state IN ('running', 'compensating')
      RETURNING id, type`,
    [workItemId, reason],
  );
  for (const row of rows.rows) {
    await appendEvent(tx, {
      workItemId,
      type: "saga_succeeded",
      payload: { saga_id: row.id, saga_type: row.type, reason },
      actor: "saga:call-control",
    });
  }
}

async function finalizeAgent(tx, ctx, reason, { wrapup = true } = {}) {
  wrapup = wrapup && ctx.workItem.attributes?.suppress_wrapup !== true;
  const closedSegment = await closeOpenSegment(tx, ctx.workItem.id, {
    outcome: "transferred",
  });
  if (ctx.data.reservationId) {
    await releaseReservation(tx, ctx.data.reservationId, reason, {
      actor: `saga:${ctx.saga.type}`,
    });
  }
  if (ctx.data.offerId) {
    await resolveOffer(tx, ctx.data.offerId, "cancelled", {
      reason,
      actor: `saga:${ctx.saga.type}`,
    });
  }
  if (ctx.data.agentId) {
    if (wrapup && ctx.data.afterWrapupStatus === "available") {
      await setSystemAgentStatus(tx, ctx.data.agentId, "Available", {
        actor: `saga:${ctx.saga.type}`,
        workItemId: ctx.workItem.id,
        reason: "after_wrapup_policy",
      });
    }
    await setWorkflowState(tx, ctx.data.agentId, wrapup ? "wrapup" : "idle", {
      deadlineAt: wrapup
        ? new Date(
            Date.now() + (ctx.data.wrapupDeadlineMs || WRAPUP_DEADLINE_MS),
          ).toISOString()
        : null,
      actor: `saga:${ctx.saga.type}`,
      workItemId: ctx.workItem.id,
      reason,
    });

  }
  return closedSegment;
}

async function notifyInteractionEnded(ctx) {
  if (!ctx.data.agentUsername) return;
  const interactionId = ctx.data.interactionId || ctx.workItem.id;
  ctx.defer(async () => {
    try {
      const { broadcastToKey } = await import("../../sse.js");
      await broadcastToKey(`contact-center:agent:${ctx.data.agentUsername}`, {
        type: "interaction_ended",
        interactionId,
        callControlId: ctx.data.customerProviderCallId,
        reason: "queue_transfer",
      });
    } catch {
      // Interaction list re-sync is the fallback.
    }
  });
}

async function completeTransferredWork(tx, ctx, reason) {
  await supersedeSourceMediaSaga(tx, ctx.workItem.id, reason);
  await finalizeAgent(tx, ctx, reason);
  await clearHandoff(tx, ctx.workItem.id);
  const adopted = await adoptTransferTarget(tx, ctx);
  if (!adopted) await applyTransition(tx, {
    workItemId: ctx.workItem.id,
    to: "completed",
    eventType: "work_item_transferred",
    payload: {
      agent_id: ctx.data.agentId,
      target: ctx.data.target,
      target_kind: ctx.data.targetKind,
      target_label: ctx.data.targetLabel || null,
    },
    actor: `saga:${ctx.saga.type}`,
    patch: { terminalReason: reason },
  });
  await updateIntentMetadata(tx, ctx, "succeeded");
  if (adopted) await notifyInteractionEnded(ctx);
  return adopted;
}

async function recoverToSourceQueue(tx, ctx, reason) {
  await supersedeSourceMediaSaga(tx, ctx.workItem.id, reason);
  // The source agent already handled the customer. Requeueing after a failed
  // handoff must retain that segment's wrap-up barrier as well.
  await finalizeAgent(tx, ctx, reason);
  await applyTransition(tx, {
    workItemId: ctx.workItem.id,
    to: "queued",
    eventType: "work_item_transfer_recovered",
    payload: {
      agent_id: ctx.data.agentId,
      queue_id: ctx.data.sourceQueueId,
      queue_name: ctx.data.sourceQueueName,
      reason,
    },
    actor: `saga:${ctx.saga.type}`,
    patch: {
      queueId: ctx.data.sourceQueueId,
      enqueuedAt: new Date().toISOString(),
    },
  });
  await openSegment(tx, {
    workItemId: ctx.workItem.id,
    kind: "queue_wait",
    queueId: ctx.data.sourceQueueId,
  });
  await clearHandoff(tx, ctx.workItem.id);
  await notifyInteractionEnded(ctx);
}

async function markLegFromResponse(tx, saga, role, response) {
  const providerCallId = response?.data?.call_control_id || null;
  if (!providerCallId) return;
  await tx.query(
    `INSERT INTO acd_legs
       (id, work_item_id, role, provider_call_id, owner_saga_id, state)
     VALUES ($1, $2, $3, $4, $5, 'dialing')
     ON CONFLICT (provider_call_id) DO UPDATE SET
       owner_saga_id = COALESCE(acd_legs.owner_saga_id, EXCLUDED.owner_saga_id)`,
    [randomUUID(), saga.work_item_id, role, providerCallId, saga.id],
  );
}

async function rememberConsultTargetForCancellation(tx, ctx) {
  let target = await tx.query(
    `SELECT id, provider_call_id FROM acd_legs
      WHERE work_item_id = $1
        AND role IN ('consult_target', 'consult_transport')
        AND ended_at IS NULL
      ORDER BY CASE WHEN role = 'consult_target' THEN 0 ELSE 1 END,
               created_at DESC LIMIT 1`,
    [ctx.workItem.id],
  );
  let row = target.rows[0] || null;

  if (!row) {
    const command = await tx.query(
      `SELECT response->'data'->>'call_control_id' AS provider_call_id
         FROM acd_commands
        WHERE saga_id = $1 AND step = 'dial_target'
          AND response->'data'->>'call_control_id' IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [ctx.saga.id],
    );
    const providerCallId = command.rows[0]?.provider_call_id || null;
    if (providerCallId) {
      const legId = randomUUID();
      const recovered = await tx.query(
        `INSERT INTO acd_legs
           (id, work_item_id, role, provider_call_id, owner_saga_id, state)
         VALUES ($1, $2, 'consult_target', $3, $4, 'dialing')
         ON CONFLICT (provider_call_id) DO UPDATE SET
           owner_saga_id = COALESCE(acd_legs.owner_saga_id, EXCLUDED.owner_saga_id)
         RETURNING id, provider_call_id`,
        [legId, ctx.workItem.id, providerCallId, ctx.saga.id],
      );
      row = recovered.rows[0] || null;
    }
  }

  if (!row?.provider_call_id) return null;
  await tx.query(
    `UPDATE acd_sagas
        SET data = COALESCE(data, '{}'::jsonb) ||
          jsonb_build_object('cancelTargetProviderCallId', $2::text)
      WHERE id = $1`,
    [ctx.saga.id, row.provider_call_id],
  );
  return row;
}

function isWebRtcUserTarget(ctx) {
  return (
    ctx.data.targetKind === "agents" &&
    Boolean(ctx.data.targetUserId) &&
    /^sip:/i.test(String(ctx.data.target || "").trim())
  );
}

function targetHeaders(ctx, role) {
  const headers = [
    { name: "X-CC-Work-Item-Id", value: String(ctx.workItem.id) },
    { name: "X-CC-Leg-Role", value: role },
    { name: "X-CC-Saga-Id", value: String(ctx.saga.id) },
  ];
  // A user can be selected with either their WebRTC/SIP destination or an
  // external PSTN number. Only the SIP variant creates the extra transport +
  // inbound device-leg topology. Treat a user's PSTN/mobile number exactly
  // like Manual/Contact PSTN so the Dial response itself is the consult target.
  if (isWebRtcUserTarget(ctx)) {
    headers.push(
      { name: "X-CC-Direct-Agent-Call", value: "true" },
      { name: "X-CC-Direct-Agent-User-Id", value: String(ctx.data.targetUserId) },
    );
    if (ctx.data.targetUsername) {
      headers.push({
        name: "X-CC-Direct-Agent-Username",
        value: String(ctx.data.targetUsername),
      });
    }
  }
  return headers;
}

async function consultMediaLeg(tx, ctx, { requireAnswered = false } = {}) {
  const result = await tx.query(
    `SELECT id, provider_call_id, role
       FROM acd_legs
      WHERE work_item_id = $1
        AND owner_saga_id = $2
        AND role IN ('consult_target', 'consult_transport')
        AND ended_at IS NULL
        AND ($3::boolean = false OR answered_at IS NOT NULL OR bridged_at IS NOT NULL)
      ORDER BY
        CASE
          WHEN $4::boolean AND role = 'consult_transport' THEN 0
          WHEN NOT $4::boolean AND role = 'consult_target' THEN 0
          ELSE 1
        END,
        created_at DESC
      LIMIT 1`,
    [
      ctx.workItem.id,
      ctx.saga.id,
      requireAnswered,
      isWebRtcUserTarget(ctx),
    ],
  );
  return result.rows[0] || null;
}

// WebRTC consults have two provider legs: the outbound transport used for
// bridge/media commands and the inbound device leg owned by the consultant.
// Cancelling the consult must hang up the device leg. Hanging up the linked
// transport while it is bridged to the source agent can tear down the whole
// consultation bridge, including the source agent/customer legs.
async function consultDisconnectLeg(tx, ctx) {
  const result = await tx.query(
    `SELECT id, provider_call_id, role
       FROM acd_legs
      WHERE work_item_id = $1
        AND owner_saga_id = $2
        AND role IN ('consult_target', 'consult_transport')
        AND ($3::boolean = false OR role = 'consult_target')
        AND ended_at IS NULL
      ORDER BY CASE WHEN role = 'consult_target' THEN 0 ELSE 1 END,
               created_at DESC
      LIMIT 1`,
    [ctx.workItem.id, ctx.saga.id, isWebRtcUserTarget(ctx)],
  );
  return result.rows[0] || null;
}

// Transfer media remains owned until every surviving endpoint has end evidence.
function transferredMediaSteps(role, prefix, suffix = "") {
  const customer = `hangup_customer${suffix}`;
  const target = `hangup_target${suffix}`;
  const evidence = { "leg.ended:customer": "verify_transfer_end", [`leg.ended:${role}`]: "verify_transfer_end" };
  return {
    monitor_transfer: { on: evidence, deadlineMs: 60 * 60 * 1000, onDeadline: "verify_transfer_end" },
    verify_transfer_end: { run: async (tx, ctx) => {
      const legs = (await tx.query(`SELECT role, ended_at FROM acd_legs WHERE work_item_id = $1
        AND (role = 'customer' OR (role = $2 AND owner_saga_id = $3))`, [ctx.workItem.id, role, ctx.saga.id])).rows;
      const a = legs.find(l => l.role === "customer");
      const b = legs.find(l => l.role === role);
      if (a?.ended_at && b?.ended_at) return "succeeded";
      if (a?.ended_at && b && !b.ended_at) return target;
      if (b?.ended_at && a && !a.ended_at) return customer;
      return "await_transfer_end";
    } },
    [customer]: { cmd: ctx => ({ operation: `${prefix}_hangup_customer`,
      endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/hangup`, request: {} }),
      on: { accepted: "await_transfer_end", ...evidence }, deadlineMs: 10000,
      onDeadline: "await_transfer_end", onFailure: "await_transfer_end" },
    [target]: { cmd: async ctx => {
      const leg = (await ctx.tx.query(`SELECT provider_call_id FROM acd_legs WHERE owner_saga_id = $1 AND role = $2 AND ended_at IS NULL LIMIT 1`, [ctx.saga.id, role])).rows[0];
      if (!leg) throw new Error("Awaiting transferred target correlation");
      return { operation: `${prefix}_hangup_target`, endpoint: `/calls/${encodeURIComponent(leg.provider_call_id)}/actions/hangup`, request: {} };
    }, on: { accepted: "await_transfer_end", ...evidence }, deadlineMs: 10000,
      onDeadline: "await_transfer_end", onFailure: "await_transfer_end" },
    await_transfer_end: { run: async (tx,ctx) => {
      const legs=(await tx.query(`SELECT role,ended_at FROM acd_legs WHERE work_item_id=$1 AND (role='customer' OR role=$2 AND owner_saga_id=$3)`,[ctx.workItem.id,role,ctx.saga.id])).rows;
      return legs.some(l=>l.role==='customer' && l.ended_at) && legs.some(l=>l.role===role && l.ended_at) ? 'succeeded' : null;
    }, on:evidence,deadlineMs:60000,onDeadline:'transfer_end_alarm' },
    transfer_end_alarm: {run:async(tx,ctx)=>{
      const alarm = await tx.query(`SELECT 1 FROM acd_events WHERE work_item_id = $1 AND type = 'manual_intervention_required' AND payload->>'saga_id' = $2 AND payload->>'reason' = 'transfer_end_unconfirmed'`, [ctx.workItem.id, ctx.saga.id]);
      if (!alarm.rowCount) await appendEvent(tx, { workItemId: ctx.workItem.id, type: "manual_intervention_required", actor: "saga:transfer", payload: { saga_id: ctx.saga.id, reason: "transfer_end_unconfirmed" } });
      return 'verify_transfer_end';
    } },
  };
}

export const blindTransferSaga = defineSaga("blind_transfer", {
  initialStep: "transfer_target",
  compensationSteps: [
    "transfer_rejected",
    "enqueue_source",
    "requeue_failed",
    "customer_ended",
  ],
  steps: {
    transfer_target: {
      cmd: (ctx) => ({
        operation: "blind_transfer",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/transfer`,
        request: {
          to: ctx.data.target,
          from: ctx.data.fromNumber || undefined,
          connection_id: ctx.data.connectionId || undefined,
          timeout_secs: Math.ceil((ctx.data.targetTimeoutMs || TARGET_TIMEOUT_MS) / 1000),
          park_after_unbridge: "self",
          target_leg_client_state: ctx.data.clientState || undefined,
          custom_headers: targetHeaders(ctx, "transfer_target"),
        },
      }),
      onAccepted: (tx, { saga, response }) => markLegFromResponse(tx, saga, isWebRtcUserTarget({ data: saga.data }) ? "transfer_transport" : "transfer_target", response),
      on: {
        accepted: "await_target",
        "leg.answered:transfer_target": "complete_transfer",
        "leg.ended:customer": "customer_ended",
      },
      deadlineMs: (ctx) => ctx.data?.targetTimeoutMs || TARGET_TIMEOUT_MS,
      // A definitive command rejection means the original bridge was not
      // changed. Keep the agent/customer conversation intact.
      onFailure: "transfer_rejected",
      // An ambiguous timeout may have changed topology; recover through the
      // source queue instead of guessing that the old bridge still exists.
      onDeadline: "enqueue_source",
    },
    await_target: {
      on: {
        "leg.initiated:transfer_transport": "complete_transfer",
        "leg.bridged:transfer_transport": "complete_transfer",
        "leg.answered:transfer_target": "complete_transfer",
        "leg.bridged:transfer_target": "complete_transfer",
        "leg.ended:transfer_target": "enqueue_source",
        "leg.ended:customer": "customer_ended",
      },
      deadlineMs: (ctx) => ctx.data?.targetTimeoutMs || TARGET_TIMEOUT_MS,
      onDeadline: "enqueue_source",
    },
    complete_transfer: {
      run: async (tx, ctx) => {
        if (!(await transferTargetReadyForAdoption(tx,ctx))) return "await_target";
        const adopted = await completeTransferredWork(tx, ctx, "blind_transfer");
        // The source agent is finished at this point, but Core must continue
        // owning the two surviving provider legs. `park_after_unbridge=self`
        // deliberately keeps the customer alive when the destination hangs
        // up, so this monitor provides the missing symmetric teardown.
        return adopted ? "succeeded" : "monitor_transfer";
      },
    },
    ...transferredMediaSteps("transfer_target", "blind_transfer"),
    transfer_rejected: {
      run: async (tx, ctx) => {
        await clearHandoff(tx, ctx.workItem.id);
        await updateIntentMetadata(tx, ctx, "failed", {
          reason: "provider_rejected",
          originalCallPreserved: true,
        });
        return "cancelled";
      },
    },
    enqueue_source: {
      cmd: (ctx) => ({
        operation: "blind_transfer_requeue_source",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/enqueue`,
        request: {
          queue_name: ctx.data.sourceQueueName,
          client_state: ctx.data.clientState || undefined,
        },
      }),
      on: {
        "leg.enqueued:customer": "restore_source_queue",
        "leg.ended:customer": "customer_ended",
      },
      deadlineMs: 15_000,
      onFailure: "requeue_failed",
      onDeadline: "requeue_failed",
    },
    restore_source_queue: {
      run: async (tx, ctx) => {
        await recoverToSourceQueue(tx, ctx, "blind_transfer_requeued");
        await updateIntentMetadata(tx, ctx, "failed", {
          reason: "target_unavailable",
          recoveredToQueue: true,
        });
        return "cancelled";
      },
    },
    requeue_failed: {
      run: async (tx, ctx) => {
        await clearHandoff(tx, ctx.workItem.id);
        await updateIntentMetadata(tx, ctx, "failed", {
          reason: "source_queue_recovery_failed",
          manualInterventionRequired: true,
        });
        return "failed";
      },
    },
    customer_ended: {
      run: async (tx, ctx) => {
        await supersedeSourceMediaSaga(tx, ctx.workItem.id, "customer_hangup_during_transfer");
        await finalizeAgent(tx, ctx, "customer_hangup_during_transfer");
        await clearHandoff(tx, ctx.workItem.id);
        await applyTransition(tx, {
          workItemId: ctx.workItem.id,
          to: "completed",
          eventType: "work_item_completed",
          payload: { agent_id: ctx.data.agentId },
          actor: "saga:blind_transfer",
          patch: { terminalReason: "customer_hangup_during_transfer" },
        });
        await updateIntentMetadata(tx, ctx, "cancelled", { reason: "customer_hangup" });
              return "cancelled";
      },
    },
  },
});

export const queueTransferSaga = defineSaga("queue_transfer", {
  initialStep: "enqueue_target",
  compensationSteps: ["enqueue_rejected", "enqueue_ambiguous", "customer_ended"],
  steps: {
    enqueue_target: {
      cmd: (ctx) => ({
        operation: "queue_transfer",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/enqueue`,
        request: {
          queue_name: ctx.data.targetQueueName,
          client_state: ctx.data.clientState || undefined,
        },
      }),
      on: {
        "leg.enqueued:customer": "complete_enqueue",
        "leg.ended:customer": "customer_ended",
      },
      deadlineMs: 15_000,
      onFailure: "enqueue_rejected",
      onDeadline: "enqueue_ambiguous",
    },
    complete_enqueue: {
      run: async (tx, ctx) => {
        await supersedeSourceMediaSaga(tx, ctx.workItem.id, "queue_transfer");
        // A queue transfer ends this agent's interaction segment even though
        // the customer work item continues. Keep the source agent in wrap-up
        // until that segment is dispositioned; the target queue can route the
        // call independently to another available agent.
        await finalizeAgent(
          tx,
          ctx,
          "queue_transfer",
          { wrapup: true },
        );
        await applyTransition(tx, {
          workItemId: ctx.workItem.id,
          to: "queued",
          eventType: "work_item_queue_transferred",
          payload: {
            agent_id: ctx.data.agentId,
            queue_id: ctx.data.targetQueueId,
            queue_name: ctx.data.targetQueueName,
            target_label: ctx.data.targetQueueName,
          },
          actor: "saga:queue_transfer",
          patch: {
            queueId: ctx.data.targetQueueId,
            enqueuedAt: new Date().toISOString(),
            ...(ctx.data.routingReset ? {
              priority: 0,
              requiredSkills: ctx.data.routingReset.skills,
              attributes: {
                client_state: ctx.data.routingReset.clientState,
                routing_requirements: ctx.data.routingReset.requirements,
              },
            } : {}),
          },
        });
        await clearHandoff(tx, ctx.workItem.id);
        await notifyInteractionEnded(ctx);
        await openSegment(tx, {
          workItemId: ctx.workItem.id,
          kind: "queue_wait",
          queueId: ctx.data.targetQueueId,
        });
        await updateIntentMetadata(tx, ctx, "succeeded");
              // The durable queue worker owns the next assignment. Keeping routing
        // outside this saga also makes a crash after enqueue harmless.
        return "succeeded";
      },
    },
    enqueue_rejected: {
      run: async (tx, ctx) => {
        await clearHandoff(tx, ctx.workItem.id);
        await updateIntentMetadata(tx, ctx, "failed", {
          reason: "enqueue_rejected",
          originalCallPreserved: true,
        });
        return "cancelled";
      },
    },
    enqueue_ambiguous: {
      run: async (tx, ctx) => {
        // Provider accepted the command, but no queue evidence arrived. The
        // customer may already be in the target queue, so neither the old
        // bridge nor a second enqueue is safe to assume automatically.
        await updateIntentMetadata(tx, ctx, "failed", {
          reason: "enqueue_confirmation_missing",
          manualInterventionRequired: true,
        });
        return "failed";
      },
    },
    customer_ended: {
      run: async (tx, ctx) => {
        await supersedeSourceMediaSaga(tx, ctx.workItem.id, "customer_hangup_during_queue_transfer");
        await finalizeAgent(tx, ctx, "customer_hangup_during_queue_transfer");
        await clearHandoff(tx, ctx.workItem.id);
        await applyTransition(tx, {
          workItemId: ctx.workItem.id,
          to: "completed",
          eventType: "work_item_completed",
          payload: { agent_id: ctx.data.agentId },
          actor: "saga:queue_transfer",
          patch: { terminalReason: "customer_hangup_during_queue_transfer" },
        });
              return "cancelled";
      },
    },
  },
});

function consultEventType(ctx, state, activeLeg) {
  if (state === "ringing") return "consult_ringing";
  if (state === "completed") return "consult_completed";
  if (state === "failed") return "consult_failed";
  if (state === "cancelled") return "consult_customer_restored";
  if (state === "active" && activeLeg === "parked") {
    return "consult_customer_active";
  }
  if (state === "active" && activeLeg === "consultant") {
    return ctx.data.consultState === "ringing"
      ? "consult_connected"
      : "consult_consultant_active";
  }
  return null;
}

function consultEventReason(reason) {
  if (reason === "leg.ended:consult_target") {
    return "Consult target disconnected";
  }
  return reason || null;
}

async function appendConsultEvent(tx, ctx, type, extra = {}) {
  if (!type) return;
  await appendEvent(tx, {
    workItemId: ctx.workItem.id,
    agentId: ctx.data.agentId || null,
    type,
    payload: {
      saga_id: ctx.saga.id,
      agent_id: ctx.data.agentId || null,
      agent_username: ctx.data.agentUsername || null,
      target: ctx.data.target || null,
      target_kind: ctx.data.targetKind || null,
      target_label: ctx.data.targetLabel || null,
      target_username: ctx.data.targetUsername || null,
      ...extra,
    },
    actor: `saga:${ctx.saga.type}`,
  });
}

async function setConsultState(
  tx,
  ctx,
  state,
  activeLeg = null,
) {
  await tx.query(
    `UPDATE acd_sagas SET data = data || $2::jsonb WHERE id = $1`,
    [ctx.saga.id, JSON.stringify({ consultState: state, activeLeg })],
  );
  await appendConsultEvent(tx, ctx, consultEventType(ctx, state, activeLeg), {
    state,
    active_leg: activeLeg,
    reason:
      ctx.data.consultRestoreReason ||
      consultEventReason(ctx.saga.last_error),
  });
  await notifyIntent(ctx, state, { activeLeg });
}

async function finishConsultAfterCustomerHangup(tx, ctx) {
  const reason = "customer_hangup_during_consult";
  if(ctx.data.targetReservationId)await releaseReservation(tx,ctx.data.targetReservationId,reason,{actor:"saga:consult"});
  await supersedeSourceMediaSaga(tx, ctx.workItem.id, reason);
  await finalizeAgent(tx, ctx, reason);
  await clearHandoff(tx, ctx.workItem.id);
  const state = (await tx.query(
    `SELECT state FROM acd_work_items WHERE id = $1 FOR UPDATE`,
    [ctx.workItem.id],
  )).rows[0]?.state;
  if (state === "active") {
    await applyTransition(tx, {
      workItemId: ctx.workItem.id,
      to: "completed",
      eventType: "work_item_completed",
      payload: { agent_id: ctx.data.agentId },
      actor: "saga:consult",
      patch: { terminalReason: reason },
    });
  }
  await setConsultState(tx, ctx, "cancelled", null);
}

async function resumeConnectedAssignment(tx, ctx) {
  const existing = await tx.query(
    `SELECT id
       FROM acd_sagas
      WHERE work_item_id = $1
        AND type IN ('connect', 'manual_outbound')
        AND state IN ('running', 'compensating')
      ORDER BY created_at DESC
      LIMIT 1`,
    [ctx.workItem.id],
  );
  if (existing.rowCount) return existing.rows[0].id;

  const work = (
    await tx.query(
      `SELECT * FROM acd_work_items
        WHERE id = $1 AND state = 'active' AND terminal_at IS NULL
        FOR UPDATE`,
      [ctx.workItem.id],
    )
  ).rows[0];
  if (!work) return null;

  const generation = Number(
    (
      await tx.query(
        `SELECT generation FROM acd_offers
          WHERE id = $1 AND work_item_id = $2
          LIMIT 1`,
        [ctx.data.offerId, ctx.workItem.id],
      )
    ).rows[0]?.generation || 1,
  );
  const resumed = await startConnectSaga(tx, {
    workItem: work,
    routeResult: {
      agentId: ctx.data.agentId,
      reservationId: ctx.data.reservationId,
      offerId: ctx.data.offerId,
      generation,
    },
    customerProviderCallId: ctx.data.customerProviderCallId,
    agentSipUri: null,
    agentUsername: ctx.data.agentUsername || null,
    interactionId: ctx.data.interactionId || ctx.workItem.id,
    clientState: ctx.data.clientState || null,
    connected: true,
  });
  await tx.query(
    `UPDATE acd_legs
        SET owner_saga_id = $2, offer_generation = COALESCE(offer_generation, $3)
      WHERE work_item_id = $1
        AND role = 'agent_device'
        AND provider_call_id = $4
        AND ended_at IS NULL`,
    [
      ctx.workItem.id,
      resumed.sagaId,
      generation,
      ctx.data.agentProviderCallId,
    ],
  );
  await appendEvent(tx, {
    workItemId: ctx.workItem.id,
    agentId: ctx.data.agentId || null,
    type: "consult_assignment_resumed",
    payload: {
      consult_saga_id: ctx.saga.id,
      assignment_saga_id: resumed.sagaId,
      agent_call_control_id: ctx.data.agentProviderCallId,
    },
    actor: "saga:consult",
  });
  return resumed.sagaId;
}

// Hangup acceptance is not media-end evidence. Keep saga/capacity ownership
// until the exact consultant device ends or an authenticated provider read
// confirms it is inactive. A missing webhook or failed probe never frees it.
function consultCleanupSteps(step,next,operation="consult_cancel_target") {
  const wait=`${step}_wait`,probe=`${step}_probe`,apply=`${step}_evidence`,alarm=`${step}_alarm`;
  const customerEnded=next==="finalize_customer_ended";
  const events={"leg.ended:consult_target":wait,"leg.ended:consult_transport":wait,
    "leg.ended:customer":customerEnded?wait:"customer_ended",
    "leg.ended:agent_device":customerEnded?wait:"agent_crashed"};
  return {
    [step]: {
      guard:async(tx,ctx)=>(await consultDisconnectLeg(tx,ctx))?null:next,
      cmd:async ctx=>{
        const target=await consultDisconnectLeg(ctx.tx,ctx);
        return {operation,targetLegId:target.id,
          endpoint:`/calls/${encodeURIComponent(target.provider_call_id)}/actions/hangup`,request:{}};
      },
      on:{accepted:wait,...events},deadlineMs:10000,onFailure:wait,onDeadline:wait,
    },
    [wait]: {
      run:async(tx,ctx)=>(await consultDisconnectLeg(tx,ctx))?null:next,
      on:events,deadlineMs:10000,onDeadline:probe,
    },
    [probe]: {
      guard:async(tx,ctx)=>(await consultDisconnectLeg(tx,ctx))?null:next,
      cmd:async ctx=>{
        const target=await consultDisconnectLeg(ctx.tx,ctx);
        return {operation:"verify_agent_leg_end",targetLegId:target.id,endpoint:"/provider-evidence/call-ended",
          request:{callControlId:target.provider_call_id}};
      },
      on:{accepted:apply,...events},deadlineMs:10000,onFailure:alarm,onDeadline:alarm,
    },
    [apply]: {
      run:async(tx,ctx)=>{
        const command=(await tx.query(`SELECT command_id,request,response FROM acd_commands
          WHERE saga_id=$1 AND step=$2 AND status IN ('accepted','confirmed')
          ORDER BY step_sequence DESC LIMIT 1`,[ctx.saga.id,probe])).rows[0];
        const evidence=command?.response?.data;
        if(evidence?.ended===true && evidence.conclusive===true && evidence.callControlId===command.request?.callControlId) {
          const ended=await tx.query(`UPDATE acd_legs SET state='ended',ended_at=now(),ended_reason='provider_verified_ended'
            WHERE work_item_id=$1 AND owner_saga_id=$2 AND provider_call_id=$3
              AND role IN ('consult_target','consult_transport') AND ended_at IS NULL RETURNING id`,
            [ctx.workItem.id,ctx.saga.id,evidence.callControlId]);
          if(ended.rowCount)await appendEvent(tx,{workItemId:ctx.workItem.id,type:"consult_media_end_verified",actor:"saga:consult",
            payload:{saga_id:ctx.saga.id,provider_call_id:evidence.callControlId,probe_command_id:command.command_id}});
          return wait;
        }
        return alarm;
      },
    },
    [alarm]: {
      run:async(tx,ctx)=>{
        const exists=await tx.query(`SELECT 1 FROM acd_events WHERE work_item_id=$1
          AND type='manual_intervention_required' AND payload->>'saga_id'=$2
          AND payload->>'reason'='consult_target_end_unconfirmed'`,[ctx.workItem.id,ctx.saga.id]);
        if(!exists.rowCount)await appendEvent(tx,{workItemId:ctx.workItem.id,type:"manual_intervention_required",actor:"saga:consult",
          payload:{saga_id:ctx.saga.id,reason:"consult_target_end_unconfirmed",reservation_preserved:true}});
        return null;
      },
      on:events,deadlineMs:30000,onDeadline:step,
    },
  };
}

export const consultSaga = defineSaga("consult", {
  initialStep: "release_source_agent",
  compensationSteps: [
    "dial_failed",
    "cancel_ringing_target",
    "await_cancel_target",
    "hangup_ringing_target",
    "cancel_target",
    "stop_hold_before_cancel_restore",
    "restore_customer_before_cancel",
    "restore_customer_before_cancel_retry",
    "hangup_cancel_target",
    "hangup_cancel_target_after_restore",
    "finalize_customer_ended",
    "stop_hold_before_restore",
    "restore_customer",
    "restore_customer_retry",
    "agent_crashed",
    "requeue_customer",
    "requeue_failed",
    "await_failed_recovery_end",
    "failed_recovery_alarm",
  ],
  steps: {
    release_source_agent: {
      cmd: (ctx) => ({
        operation: "consult_release_source_agent",
        endpoint: `/calls/${encodeURIComponent(ctx.data.agentProviderCallId)}/actions/hangup`,
        request: {},
      }),
      on: {
        accepted: "route_initial_hold_before_browser",
        "leg.ended:customer": "customer_ended",
        "intent.cancel": "requeue_customer",
      },
      deadlineMs: 10_000,
      onFailure: "requeue_customer",
      onDeadline: "requeue_customer",
    },
    route_initial_hold_before_browser: {
      run: async (tx, ctx) => {
        await setConsultState(tx, ctx, "ringing", "consultant");
        if (consultHoldMediaName(ctx)) return "start_initial_browser_hold_audio";
        if (hasConsultHoldAnnouncement(ctx)) return "speak_initial_browser_hold_announcement";
        return "await_browser_originator";
      },
    },
    start_initial_browser_hold_audio: {
      cmd: (ctx) => ({
        operation: "consult_start_customer_hold_audio",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_start`,
        request: {
          media_name: consultHoldMediaName(ctx),
          loop: "infinity",
          overlay: false,
          target_legs: "self",
          client_state: ctx.data.clientState || undefined,
        },
      }),
      on: {
        accepted: "await_browser_originator",
        "leg.ended:customer": "customer_ended",
        "intent.cancel": "requeue_customer",
      },
      deadlineMs: 5_000,
      onFailure: "await_browser_originator",
      onDeadline: "await_browser_originator",
    },
    speak_initial_browser_hold_announcement: {
      cmd: (ctx) => ({
        operation: "consult_speak_customer_hold_announcement",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/speak`,
        request: consultHoldSpeakRequest(ctx),
      }),
      on: {
        accepted: "await_browser_originator",
        "leg.ended:customer": "customer_ended",
        "intent.cancel": "requeue_customer",
      },
      deadlineMs: 10_000,
      onFailure: "await_browser_originator",
      onDeadline: "await_browser_originator",
    },
    await_browser_originator: {
      on: {
        "leg.initiated:agent_device": "dial_target",
        "leg.ended:customer": "customer_ended",
        "intent.cancel": "requeue_customer",
      },
      deadlineMs: (ctx) => ctx.data?.targetTimeoutMs || TARGET_TIMEOUT_MS,
      onDeadline: "requeue_customer",
    },
    dial_target: {
      cmd: (ctx) => ({
        operation: "consult_dial",
        endpoint: "/calls",
        request: {
          to: ctx.data.target,
          from: ctx.data.fromNumber,
          connection_id: ctx.data.connectionId,
          // Both PSTN and WebRTC consult Dial legs must be independent of
          // the source browser. A linked SIP transport also ends its device
          // peer when that browser switches back to the customer. The
          // explicit post-answer bridge supplies media and the park policy;
          // custom headers retain the WebRTC target's Core correlation.
          // Telnyx rejects Dial-level park_after_unbridge unless Dial also
          // performs the automatic bridge. Core establishes the bridge itself
          // after answer, so the survival policy belongs on that explicit
          // Bridge command instead of this Dial request.
          client_state: ctx.data.clientState || undefined,
          custom_headers: targetHeaders(ctx, "consult_target"),
        },
      }),
      // A Dial to a WebRTC user returns the outbound transport leg. The
      // independently controlled inbound device leg arrives with our custom
      // headers and is the leg that must drive consult state. Keeping the
      // transport separate prevents its normal answer-time hangup from being
      // interpreted as the consultant hanging up.
      onAccepted: (tx, { saga, response }) =>
        markLegFromResponse(
          tx,
          saga,
          isWebRtcUserTarget({ data: saga.data || {} })
            ? "consult_transport"
            : "consult_target",
          response,
        ),
      on: {
        accepted: "await_target",
        "leg.answered:consult_target": "bridge_initial_consultant",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: (ctx) => ctx.data?.targetTimeoutMs || TARGET_TIMEOUT_MS,
      onFailure: "dial_failed",
      onDeadline: "dial_failed",
    },
    await_target: {
      // A target's device/transport bridge may be reported before its answer.
      // It does not connect the fresh source browser. Always issue Core's
      // initial bridge after answer before accepting bridge confirmation.
      on: {
        "leg.answered:consult_target": "bridge_initial_consultant",
        "leg.ended:consult_target": "dial_failed",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
        "intent.cancel": "cancel_ringing_target",
      },
      deadlineMs: (ctx) => ctx.data?.targetTimeoutMs || TARGET_TIMEOUT_MS,
      onDeadline: "dial_failed",
    },
    bridge_initial_consultant: {
      cmd: async (ctx) => {
        const target = await consultMediaLeg(ctx.tx, ctx, {
          requireAnswered: true,
        });
        return {
          operation: "consult_bridge_initial_target",
          endpoint: `/calls/${encodeURIComponent(target?.provider_call_id || "unknown")}/actions/bridge`,
          request: {
            call_control_id: ctx.data.agentProviderCallId,
            park_after_unbridge: "self",
          },
        };
      },
      on: {
        accepted: "await_target_bridge",
        "leg.bridged:consult_target": "route_initial_hold_audio",
        "leg.ended:consult_target": "dial_failed",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
        "intent.cancel": "cancel_target",
      },
      deadlineMs: 10_000,
      onFailure: "cancel_target",
      onDeadline: "cancel_target",
    },
    await_target_bridge: {
      on: {
        "leg.bridged:consult_target": "route_initial_hold_audio",
        "leg.bridged:consult_transport": "route_initial_hold_audio",
        "leg.bridged:agent_device": "route_initial_hold_audio",
        "leg.ended:consult_target": "dial_failed",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
        "intent.cancel": "cancel_target",
      },
      deadlineMs: 10_000,
      onDeadline: "cancel_target",
    },
    cancel_ringing_target: {
      run: async (tx, ctx) => {
        await tx.query(`UPDATE acd_sagas SET data=data || '{"restoreFromAnsweredCustomer":true}'::jsonb WHERE id=$1`, [ctx.saga.id]);
        const target = await rememberConsultTargetForCancellation(tx, ctx);
        return target ? "hangup_ringing_target" : "await_cancel_target";
      },
    },
    await_cancel_target: {
      on: {
        "leg.initiated:consult_target": "cancel_ringing_target",
        "leg.answered:consult_target": "cancel_ringing_target",
        "leg.ended:consult_target": "stop_hold_before_restore",
      },
      // Keep ownership until the generation-fenced call.initiated webhook
      // supplies the real call-control id. Never terminally cancel a saga
      // while a provider-created target leg could still be ringing.
      deadlineMs: 10_000,
      onDeadline: "cancel_ringing_target",
    },
    hangup_ringing_target: {
      cmd: async (ctx) => {
        const target = await ctx.tx.query(
          `SELECT id FROM acd_legs
            WHERE work_item_id = $1
              AND role IN ('consult_target', 'consult_transport')
              AND provider_call_id = $2
            ORDER BY created_at DESC LIMIT 1`,
          [ctx.workItem.id, ctx.data.cancelTargetProviderCallId],
        );
        return {
          operation: "consult_cancel_ringing_target",
          targetLegId: target.rows[0]?.id || null,
          endpoint: `/calls/${encodeURIComponent(ctx.data.cancelTargetProviderCallId)}/actions/hangup`,
          request: {},
        };
      },
      // Ending the unanswered target does not reconnect the parked customer
      // to the fresh source browser. Confirm that bridge before cancellation.
      on: { accepted: "stop_hold_before_restore", "leg.ended:consult_target": "stop_hold_before_restore" },
      deadlineMs: 10_000,
      onFailure: "stop_hold_before_restore",
      onDeadline: "stop_hold_before_restore",
    },
    route_initial_hold_audio: {
      run: async (_tx, ctx) => {
        // The explicit bridge webhook proves that the agent has left the
        // customer and that the consultant owns its park-after-unbridge
        // policy. Hold media can now start without racing that transition.
        if (hasConsultHoldAnnouncement(ctx)) {
          return "stop_initial_hold_audio";
        }
        // Music, when configured, already started before the replacement
        // browser leg was created and continues while the customer is parked.
        return "consult_active";
      },
    },
    stop_initial_hold_audio: {
      cmd: (ctx) => ({
        operation: "consult_stop_customer_hold_audio",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_stop`,
        request: { stop: "all" },
      }),
      on: {
        accepted: "speak_initial_hold_announcement",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
        "intent.cancel": "cancel_target",
      },
      deadlineMs: 5_000,
      onFailure: "speak_initial_hold_announcement",
      onDeadline: "speak_initial_hold_announcement",
    },
    speak_initial_hold_announcement: {
      cmd: (ctx) => ({
        operation: "consult_speak_customer_hold_announcement",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/speak`,
        request: consultHoldSpeakRequest(ctx),
      }),
      on: {
        accepted: "await_initial_hold_announcement",
        "media.speak_ended:customer": "route_after_initial_hold_announcement",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
        "intent.cancel": "cancel_target",
      },
      deadlineMs: 10_000,
      onFailure: "route_after_initial_hold_announcement",
      onDeadline: "route_after_initial_hold_announcement",
    },
    await_initial_hold_announcement: {
      on: {
        "media.speak_ended:customer": "route_after_initial_hold_announcement",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
        "intent.cancel": "cancel_target",
      },
      deadlineMs: 30_000,
      onDeadline: "route_after_initial_hold_announcement",
    },
    route_after_initial_hold_announcement: {
      run: async (_tx, ctx) =>
        consultHoldMediaName(ctx)
          ? "start_initial_hold_audio"
          : "consult_active",
    },
    start_initial_hold_audio: {
      cmd: (ctx) => ({
        operation: "consult_start_customer_hold_audio",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_start`,
        request: {
          media_name: consultHoldMediaName(ctx),
          loop: "infinity",
          overlay: false,
          target_legs: "self",
          client_state: ctx.data.clientState || undefined,
        },
      }),
      on: {
        accepted: "consult_active",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
        "intent.cancel": "cancel_target",
      },
      deadlineMs: 5_000,
      onFailure: "consult_active",
      onDeadline: "consult_active",
    },
    consult_active: {
      run: async (tx, ctx) => {
        await setConsultState(tx, ctx, "active", "consultant");
        return "in_consult";
      },
    },
    in_consult: {
      on: {
        "intent.switch_customer": "stop_hold_before_customer_switch",
        "intent.switch_consultant": "route_stop_before_consultant_switch",
        "intent.cancel": "cancel_target",
        "intent.complete": "route_stop_before_complete",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: (ctx) =>
        hasConsultHoldAnnouncement(ctx)
          ? consultHoldAnnouncementIntervalMs(ctx)
          : CONSULT_GUARD_MS,
      onDeadline: "route_repeat_hold_announcement",
    },
    route_repeat_hold_announcement: {
      run: async (_tx, ctx) => {
        if (!hasConsultHoldAnnouncement(ctx)) return "cancel_target";
        if (ctx.data.activeLeg === "parked") {
          return consultHoldMediaName(ctx)
            ? "pause_consultant_hold_for_announcement"
            : "speak_repeat_consultant_hold_announcement";
        }
        if (ctx.data.activeLeg !== "consultant") return "in_consult";
        return consultHoldMediaName(ctx)
          ? "pause_hold_for_announcement"
          : "speak_repeat_hold_announcement";
      },
    },
    pause_hold_for_announcement: {
      cmd: (ctx) => ({
        operation: "consult_pause_customer_hold_audio",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_stop`,
        request: { stop: "all" },
      }),
      on: {
        accepted: "speak_repeat_hold_announcement",
        "intent.switch_customer": "bridge_customer",
        "intent.cancel": "cancel_target",
        "intent.complete": "complete_bridge",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 5_000,
      onFailure: "speak_repeat_hold_announcement",
      onDeadline: "speak_repeat_hold_announcement",
    },
    speak_repeat_hold_announcement: {
      cmd: (ctx) => ({
        operation: "consult_speak_customer_hold_announcement",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/speak`,
        request: consultHoldSpeakRequest(ctx),
      }),
      on: {
        accepted: "await_repeat_hold_announcement",
        "media.speak_ended:customer": "route_after_repeat_hold_announcement",
        "intent.switch_customer": "stop_hold_before_customer_switch",
        "intent.cancel": "cancel_target",
        "intent.complete": "stop_hold_before_complete",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 10_000,
      onFailure: "route_after_repeat_hold_announcement",
      onDeadline: "route_after_repeat_hold_announcement",
    },
    await_repeat_hold_announcement: {
      on: {
        "media.speak_ended:customer": "route_after_repeat_hold_announcement",
        "intent.switch_customer": "stop_hold_before_customer_switch",
        "intent.cancel": "cancel_target",
        "intent.complete": "stop_hold_before_complete",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 30_000,
      onDeadline: "route_after_repeat_hold_announcement",
    },
    route_after_repeat_hold_announcement: {
      run: async (_tx, ctx) =>
        consultHoldMediaName(ctx)
          ? "resume_hold_after_announcement"
          : "in_consult",
    },
    resume_hold_after_announcement: {
      cmd: (ctx) => ({
        operation: "consult_resume_customer_hold_audio",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_start`,
        request: {
          media_name: consultHoldMediaName(ctx),
          loop: "infinity",
          overlay: false,
          target_legs: "self",
          client_state: ctx.data.clientState || undefined,
        },
      }),
      on: {
        accepted: "in_consult",
        "intent.switch_customer": "stop_hold_before_customer_switch",
        "intent.cancel": "cancel_target",
        "intent.complete": "stop_hold_before_complete",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 5_000,
      onFailure: "in_consult",
      onDeadline: "in_consult",
    },
    pause_consultant_hold_for_announcement: {
      cmd: async (ctx) => {
        const target = await consultMediaLeg(ctx.tx, ctx, { requireAnswered: true });
        return {
          operation: "consult_pause_consultant_hold_audio",
          endpoint: `/calls/${encodeURIComponent(target?.provider_call_id || "unknown")}/actions/playback_stop`,
          request: { stop: "all" },
        };
      },
      on: {
        accepted: "speak_repeat_consultant_hold_announcement",
        "intent.switch_consultant": "bridge_consultant",
        "intent.cancel": "cancel_target",
        "intent.complete": "complete_bridge",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 5_000,
      onFailure: "speak_repeat_consultant_hold_announcement",
      onDeadline: "speak_repeat_consultant_hold_announcement",
    },
    speak_repeat_consultant_hold_announcement: {
      cmd: async (ctx) => {
        const target = await consultMediaLeg(ctx.tx, ctx, { requireAnswered: true });
        return {
          operation: "consult_speak_consultant_hold_announcement",
          endpoint: `/calls/${encodeURIComponent(target?.provider_call_id || "unknown")}/actions/speak`,
          request: consultHoldSpeakRequest(ctx),
        };
      },
      on: {
        accepted: "await_repeat_consultant_hold_announcement",
        "media.speak_ended:consult_target": "route_after_repeat_consultant_hold_announcement",
        "media.speak_ended:consult_transport": "route_after_repeat_consultant_hold_announcement",
        "intent.switch_consultant": "route_stop_before_consultant_switch",
        "intent.cancel": "cancel_target",
        "intent.complete": "route_stop_before_complete",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 10_000,
      onFailure: "route_after_repeat_consultant_hold_announcement",
      onDeadline: "route_after_repeat_consultant_hold_announcement",
    },
    await_repeat_consultant_hold_announcement: {
      on: {
        "media.speak_ended:consult_target": "route_after_repeat_consultant_hold_announcement",
        "media.speak_ended:consult_transport": "route_after_repeat_consultant_hold_announcement",
        "intent.switch_consultant": "route_stop_before_consultant_switch",
        "intent.cancel": "cancel_target",
        "intent.complete": "route_stop_before_complete",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 30_000,
      onDeadline: "route_after_repeat_consultant_hold_announcement",
    },
    route_after_repeat_consultant_hold_announcement: {
      run: async (_tx, ctx) =>
        consultHoldMediaName(ctx)
          ? "resume_consultant_hold_after_announcement"
          : "in_consult",
    },
    resume_consultant_hold_after_announcement: {
      cmd: async (ctx) => {
        const target = await consultMediaLeg(ctx.tx, ctx, { requireAnswered: true });
        return {
          operation: "consult_resume_consultant_hold_audio",
          endpoint: `/calls/${encodeURIComponent(target?.provider_call_id || "unknown")}/actions/playback_start`,
          request: {
            media_name: consultHoldMediaName(ctx),
            loop: "infinity",
            overlay: false,
            target_legs: "self",
            client_state: ctx.data.clientState || undefined,
          },
        };
      },
      on: {
        accepted: "in_consult",
        "intent.switch_consultant": "route_stop_before_consultant_switch",
        "intent.cancel": "cancel_target",
        "intent.complete": "route_stop_before_complete",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 5_000,
      onFailure: "in_consult",
      onDeadline: "in_consult",
    },
    stop_hold_before_customer_switch: {
      cmd: (ctx) => ({
        operation: "consult_stop_customer_hold_audio",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_stop`,
        request: { stop: "all" },
      }),
      on: {
        accepted: "bridge_customer",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
        "intent.cancel": "cancel_target",
      },
      deadlineMs: 5_000,
      onFailure: "bridge_customer",
      onDeadline: "bridge_customer",
    },
    bridge_customer: {
      cmd: (ctx) => ({
        operation: "consult_switch_customer",
        // Telnyx applies park_after_unbridge=self to the command leg named in
        // the endpoint. Protect the customer here so that moving the browser
        // back to the consultant parks the customer instead of ending it.
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/bridge`,
        request: {
          call_control_id: ctx.data.agentProviderCallId,
          park_after_unbridge: "self",
        },
      }),
      on: {
        "leg.bridged:customer": "customer_active",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
        "intent.cancel": "cancel_target",
      },
      deadlineMs: 10_000,
      onFailure: "cancel_target",
      onDeadline: "cancel_target",
    },
    customer_active: {
      run: async (tx, ctx) => {
        if (!(await consultMediaLeg(tx, ctx, { requireAnswered: true }))) {
          return "stop_hold_before_restore";
        }
        await setConsultState(tx, ctx, "active", "parked");
        return "route_consultant_hold_audio";
      },
    },
    route_consultant_hold_audio: {
      run: async (_tx, ctx) => {
        if (hasConsultHoldAnnouncement(ctx)) {
          return "speak_consultant_hold_announcement";
        }
        return consultHoldMediaName(ctx)
          ? "start_consultant_hold_audio"
          : "in_consult";
      },
    },
    speak_consultant_hold_announcement: {
      cmd: async (ctx) => {
        const target = await consultMediaLeg(ctx.tx, ctx, { requireAnswered: true });
        return {
          operation: "consult_speak_consultant_hold_announcement",
          endpoint: `/calls/${encodeURIComponent(target?.provider_call_id || "unknown")}/actions/speak`,
          request: consultHoldSpeakRequest(ctx),
        };
      },
      on: {
        accepted: "await_consultant_hold_announcement",
        "media.speak_ended:consult_target": "route_after_consultant_hold_announcement",
        "media.speak_ended:consult_transport": "route_after_consultant_hold_announcement",
        "intent.switch_consultant": "route_stop_before_consultant_switch",
        "intent.cancel": "cancel_target",
        "intent.complete": "route_stop_before_complete",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 10_000,
      onFailure: "route_after_consultant_hold_announcement",
      onDeadline: "route_after_consultant_hold_announcement",
    },
    await_consultant_hold_announcement: {
      on: {
        "media.speak_ended:consult_target": "route_after_consultant_hold_announcement",
        "media.speak_ended:consult_transport": "route_after_consultant_hold_announcement",
        "intent.switch_consultant": "route_stop_before_consultant_switch",
        "intent.cancel": "cancel_target",
        "intent.complete": "route_stop_before_complete",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 30_000,
      onDeadline: "route_after_consultant_hold_announcement",
    },
    route_after_consultant_hold_announcement: {
      run: async (_tx, ctx) =>
        consultHoldMediaName(ctx) ? "start_consultant_hold_audio" : "in_consult",
    },
    start_consultant_hold_audio: {
      cmd: async (ctx) => {
        const target = await consultMediaLeg(ctx.tx, ctx, { requireAnswered: true });
        return {
          operation: "consult_start_consultant_hold_audio",
          endpoint: `/calls/${encodeURIComponent(target?.provider_call_id || "unknown")}/actions/playback_start`,
          request: {
            media_name: consultHoldMediaName(ctx),
            loop: "infinity",
            overlay: false,
            target_legs: "self",
            client_state: ctx.data.clientState || undefined,
          },
        };
      },
      on: {
        accepted: "in_consult",
        "intent.switch_consultant": "route_stop_before_consultant_switch",
        "intent.cancel": "cancel_target",
        "intent.complete": "route_stop_before_complete",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 5_000,
      onFailure: "in_consult",
      onDeadline: "in_consult",
    },
    route_stop_before_consultant_switch: {
      run: async (_tx, ctx) =>
        ctx.data.activeLeg === "parked"
          ? "stop_consultant_hold_before_switch"
          : "bridge_consultant",
    },
    stop_consultant_hold_before_switch: {
      cmd: async (ctx) => {
        const target = await consultMediaLeg(ctx.tx, ctx, { requireAnswered: true });
        return {
          operation: "consult_stop_consultant_hold_audio",
          endpoint: `/calls/${encodeURIComponent(target?.provider_call_id || "unknown")}/actions/playback_stop`,
          request: { stop: "all" },
        };
      },
      on: {
        accepted: "bridge_consultant",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
        "intent.cancel": "cancel_target",
      },
      deadlineMs: 5_000,
      onFailure: "bridge_consultant",
      onDeadline: "bridge_consultant",
    },
    bridge_consultant: {
      cmd: async (ctx) => {
        const target = await consultMediaLeg(ctx.tx, ctx, {
          requireAnswered: true,
        });
        return {
          operation: "consult_switch_target",
          // Match the initial bridge direction that establishes working RTP:
          // the independent PSTN consultant is the command leg and the live
          // browser device is its peer. Re-bridging in the opposite direction
          // was acknowledged but left the browser without incoming media.
          endpoint: `/calls/${encodeURIComponent(target?.provider_call_id || "unknown")}/actions/bridge`,
          request: {
            call_control_id: ctx.data.agentProviderCallId,
            park_after_unbridge: "self",
          },
        };
      },
      on: {
        accepted: "route_switched_hold_audio",
        "leg.bridged:consult_target": "route_switched_hold_audio",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
        "intent.cancel": "cancel_target",
      },
      deadlineMs: 10_000,
      onFailure: "stop_hold_before_restore",
      onDeadline: "stop_hold_before_restore",
    },
    route_switched_hold_audio: {
      run: async (_tx, ctx) =>
        hasConsultHoldAnnouncement(ctx)
          ? "speak_switched_hold_announcement"
          : consultHoldMediaName(ctx)
          ? "start_switched_hold_audio"
          : "verify_switched_consult_bridge",
    },
    speak_switched_hold_announcement: {
      cmd: (ctx) => ({
        operation: "consult_speak_customer_hold_announcement",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/speak`,
        request: consultHoldSpeakRequest(ctx),
      }),
      on: {
        accepted: "await_switched_hold_announcement",
        "media.speak_ended:customer": "route_after_switched_hold_announcement",
        "intent.switch_customer": "stop_hold_before_customer_switch",
        "intent.cancel": "cancel_target",
        "intent.complete": "stop_hold_before_complete",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 10_000,
      onFailure: "route_after_switched_hold_announcement",
      onDeadline: "route_after_switched_hold_announcement",
    },
    await_switched_hold_announcement: {
      on: {
        "media.speak_ended:customer": "route_after_switched_hold_announcement",
        "intent.switch_customer": "stop_hold_before_customer_switch",
        "intent.cancel": "cancel_target",
        "intent.complete": "stop_hold_before_complete",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 30_000,
      onDeadline: "route_after_switched_hold_announcement",
    },
    route_after_switched_hold_announcement: {
      run: async (_tx, ctx) =>
        consultHoldMediaName(ctx)
          ? "start_switched_hold_audio"
          : "verify_switched_consult_bridge",
    },
    start_switched_hold_audio: {
      cmd: (ctx) => ({
        operation: "consult_start_customer_hold_audio",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_start`,
        request: {
          media_name: consultHoldMediaName(ctx),
          loop: "infinity",
          overlay: false,
          target_legs: "self",
          client_state: ctx.data.clientState || undefined,
        },
      }),
      on: {
        accepted: "verify_switched_consult_bridge",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
        "intent.cancel": "cancel_target",
      },
      deadlineMs: 5_000,
      onFailure: "verify_switched_consult_bridge",
      onDeadline: "verify_switched_consult_bridge",
    },
    verify_switched_consult_bridge: {
      run: async (tx, ctx) => {
        const proof = await tx.query(
          `SELECT EXISTS (
             SELECT 1
               FROM acd_legs l
               JOIN LATERAL (
                 SELECT created_at
                   FROM acd_commands
                  WHERE saga_id = $1 AND step = 'bridge_consultant'
                  ORDER BY step_sequence DESC
                  LIMIT 1
               ) c ON TRUE
              WHERE l.work_item_id = $2 AND l.role = 'consult_target'
                AND l.bridged_at >= c.created_at AND l.ended_at IS NULL
           ) AS bridged`,
          [ctx.saga.id, ctx.workItem.id],
        );
        return proof.rows[0]?.bridged
          ? "consultant_active"
          : "await_switched_consult_bridge";
      },
    },
    await_switched_consult_bridge: {
      on: {
        "leg.bridged:consult_target": "verify_switched_consult_bridge",
        "leg.ended:consult_target": "stop_hold_before_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
        "intent.cancel": "cancel_target",
      },
      deadlineMs: 10_000,
      onDeadline: "stop_hold_before_restore",
    },
    consultant_active: {
      run: async (tx, ctx) => {
        if (!(await consultMediaLeg(tx, ctx, { requireAnswered: true }))) {
          return "stop_hold_before_restore";
        }
        await setConsultState(tx, ctx, "active", "consultant");
        return "in_consult";
      },
    },
    cancel_target: {
      run: async (_tx, ctx) =>
        // When the source agent is still speaking with the consultant, the
        // consultant is the command leg of the active provider bridge. A
        // direct Hangup on that leg also ends its browser peer. Move the
        // browser back to the protected customer leg first, wait for bridge
        // evidence, and only then end the now-parked consultant.
        ctx.data.activeLeg === "parked"
          ? "hangup_cancel_target"
          : "stop_hold_before_cancel_restore",
    },
    stop_hold_before_cancel_restore: {
      cmd: (ctx) => ({
        operation: "consult_stop_customer_hold_before_cancel",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_stop`,
        request: { stop: "all" },
      }),
      on: {
        accepted: "restore_customer_before_cancel",
        "leg.ended:consult_target": "restore_customer_before_cancel",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 5_000,
      onFailure: "restore_customer_before_cancel",
      onDeadline: "restore_customer_before_cancel",
    },
    restore_customer_before_cancel: {
      cmd: (ctx) => ({
        operation: "consult_restore_customer_before_cancel",
        endpoint: `/calls/${encodeURIComponent(ctx.data.agentProviderCallId)}/actions/bridge`,
        request: {
          call_control_id: ctx.data.customerProviderCallId,
          park_after_unbridge: "self",
        },
      }),
      on: {
        "leg.bridged:customer": "hangup_cancel_target_after_restore",
        "leg.bridged:agent_device": "hangup_cancel_target_after_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 10_000,
      onFailure: "restore_customer_before_cancel_retry",
      onDeadline: "restore_customer_before_cancel_retry",
    },
    restore_customer_before_cancel_retry: {
      prepare: (_tx, ctx) =>
        ctx.defer(
          () =>
            new Promise((resolve) => {
              setTimeout(resolve, CONSULT_RESTORE_RETRY_DELAY_MS);
            }),
        ),
      cmd: (ctx) => ({
        operation: "consult_restore_customer_before_cancel_retry",
        endpoint: `/calls/${encodeURIComponent(ctx.data.agentProviderCallId)}/actions/bridge`,
        request: {
          call_control_id: ctx.data.customerProviderCallId,
          park_after_unbridge: "self",
        },
      }),
      on: {
        "leg.bridged:customer": "hangup_cancel_target_after_restore",
        "leg.bridged:agent_device": "hangup_cancel_target_after_restore",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 10_000,
      onFailure: "requeue_customer",
      onDeadline: "requeue_customer",
    },
    ...consultCleanupSteps("hangup_cancel_target","stop_hold_before_restore"),
    ...consultCleanupSteps("hangup_cancel_target_after_restore","consult_cancelled"),
    ...consultCleanupSteps("cleanup_requeue_target","requeue_customer"),
    stop_hold_before_restore: {
      prepare: async (tx, ctx) => {
        if (ctx.saga.last_error !== "leg.ended:consult_target") return;
        const reason = consultEventReason(ctx.saga.last_error);
        await tx.query(
          `UPDATE acd_sagas
              SET data = COALESCE(data, '{}'::jsonb) ||
                jsonb_build_object('consultRestoreReason', $2::text)
            WHERE id = $1`,
          [ctx.saga.id, reason],
        );
      },
      cmd: (ctx) => ({
        operation: "consult_stop_customer_hold_audio",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_stop`,
        request: { stop: "all" },
      }),
      on: {
        accepted: "restore_customer",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 5_000,
      onFailure: "restore_customer",
      onDeadline: "restore_customer",
    },
    restore_customer: {
      cmd: (ctx) => consultRestoreCommand(ctx, "consult_restore_customer"),
      on: {
        "leg.bridged:customer": "consult_cancelled",
        "leg.bridged:agent_device": "consult_cancelled",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 10_000,
      // A consultant-originated hangup can reach us a moment before the
      // provider has made the surviving agent leg bridgeable again. Retry the
      // customer bridge once instead of immediately abandoning the active
      // agent/customer topology and requeueing the caller.
      onFailure: "restore_customer_retry",
      onDeadline: "restore_customer_retry",
    },
    restore_customer_retry: {
      // Keep the retry delay outside the DB transaction. Remote hangup
      // webhooks can precede completion of the provider's internal unbridge,
      // so an immediate second bridge can hit the same transient conflict.
      prepare: (_tx, ctx) =>
        ctx.defer(
          () =>
            new Promise((resolve) => {
              setTimeout(resolve, CONSULT_RESTORE_RETRY_DELAY_MS);
            }),
        ),
      cmd: (ctx) => consultRestoreCommand(ctx, "consult_restore_customer_retry"),
      on: {
        "leg.bridged:customer": "consult_cancelled",
        "leg.bridged:agent_device": "consult_cancelled",
        "leg.ended:customer": "customer_ended",
        "leg.ended:agent_device": "agent_crashed",
      },
      deadlineMs: 10_000,
      onFailure: "requeue_customer",
      onDeadline: "requeue_customer",
    },
    consult_cancelled: {
      guard:async(tx,ctx)=>(await consultDisconnectLeg(tx,ctx))?"hangup_cancel_target_after_restore":null,
      run: async (tx, ctx) => {
        if (ctx.data.targetReservationId) {
          await releaseReservation(
            tx,
            ctx.data.targetReservationId,
            "consult_cancelled",
            { actor: "saga:consult" },
          );
        }
        await setConsultState(tx, ctx, "cancelled", "parked");
        // Target hangup is a handled consult outcome once the original
        // customer conversation has been restored. Do not leak the recovery
        // transition reason to the UI as a failed consult toast.
        await tx.query(`UPDATE acd_sagas SET last_error = NULL WHERE id = $1`, [ctx.saga.id]);
        await clearHandoff(tx, ctx.workItem.id);
        await resumeConnectedAssignment(tx, ctx);
        return "cancelled";
      },
    },
    route_stop_before_complete: {
      run: async (_tx, ctx) =>
        ctx.data.activeLeg === "parked"
          ? "stop_consultant_hold_before_complete"
          : "stop_hold_before_complete",
    },
    stop_consultant_hold_before_complete: {
      cmd: async (ctx) => {
        const target = await consultMediaLeg(ctx.tx, ctx, { requireAnswered: true });
        return {
          operation: "consult_stop_consultant_hold_audio",
          endpoint: `/calls/${encodeURIComponent(target?.provider_call_id || "unknown")}/actions/playback_stop`,
          request: { stop: "all" },
        };
      },
      on: {
        accepted: "complete_bridge",
        "leg.ended:customer": "customer_ended",
        "leg.ended:consult_target": "stop_hold_before_restore",
      },
      deadlineMs: 5_000,
      onFailure: "complete_bridge",
      onDeadline: "complete_bridge",
    },
    stop_hold_before_complete: {
      cmd: (ctx) => ({
        operation: "consult_stop_customer_hold_audio",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/playback_stop`,
        request: { stop: "all" },
      }),
      on: {
        accepted: "complete_bridge",
        "leg.ended:customer": "customer_ended",
        "leg.ended:consult_target": "stop_hold_before_restore",
      },
      deadlineMs: 5_000,
      onFailure: "complete_bridge",
      onDeadline: "complete_bridge",
    },
    complete_bridge: {
      cmd: async (ctx) => {
        const target = await consultMediaLeg(ctx.tx, ctx, {
          requireAnswered: true,
        });
        return {
          operation: "consult_complete_bridge",
          endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/bridge`,
          request: {
            call_control_id: target?.provider_call_id,
            park_after_unbridge: "self",
          },
        };
      },
      on: {
        "leg.bridged:customer": "verify_complete_bridge_event",
        "leg.bridged:consult_target": "verify_complete_bridge_event",
        "leg.bridged:consult_transport": "verify_complete_bridge_event",
        "leg.ended:agent_device": "verify_complete_bridge",
        "leg.ended:customer": "customer_ended",
        "leg.ended:consult_target": "stop_hold_before_restore",
      },
      deadlineMs: 10_000,
      onFailure: "stop_hold_before_restore",
      onDeadline: "verify_complete_bridge",
    },
    verify_complete_bridge_event: {
      run: async (tx, ctx) => {
        const proof = await tx.query(
          `SELECT EXISTS (
             SELECT 1
               FROM acd_commands command
               JOIN acd_legs leg ON leg.work_item_id = $2
                AND (
                  leg.role = 'customer'
                  OR leg.owner_saga_id = $1
                    AND leg.role IN ('consult_target', 'consult_transport')
                )
                AND leg.bridged_at >= command.created_at
                AND leg.ended_at IS NULL
              WHERE command.saga_id = $1
                AND command.operation = 'consult_complete_bridge'
                AND command.status IN ('accepted', 'confirmed')
           ) AS bridged`,
          [ctx.saga.id, ctx.workItem.id],
        );
        return proof.rows[0]?.bridged
          ? "hangup_agent"
          : "verify_complete_bridge";
      },
    },
    verify_complete_bridge: {
      cmd: async (ctx) => {
        const target = await ctx.tx.query(
          `SELECT provider_call_id
             FROM acd_legs
            WHERE work_item_id = $1
              AND owner_saga_id = $2
              AND role IN ('consult_target', 'consult_transport')
            ORDER BY CASE WHEN role = 'consult_target' THEN 0 ELSE 1 END,
                     created_at DESC
            LIMIT 1`,
          [ctx.workItem.id, ctx.saga.id],
        );
        return {
          operation: "verify_consult_completion",
          endpoint: "/provider-evidence/consult-completion",
          request: {
            customerCallId: ctx.data.customerProviderCallId,
            targetCallId: target.rows[0]?.provider_call_id || null,
            agentCallId: ctx.data.agentProviderCallId,
          },
        };
      },
      on: {
        accepted: "apply_complete_bridge_evidence",
        "leg.bridged:customer": "verify_complete_bridge_event",
        "leg.bridged:consult_target": "verify_complete_bridge_event",
        "leg.bridged:consult_transport": "verify_complete_bridge_event",
        "leg.ended:customer": "customer_ended",
        "leg.ended:consult_target": "stop_hold_before_restore",
      },
      deadlineMs: 10_000,
      onFailure: "stop_hold_before_restore",
      onDeadline: "stop_hold_before_restore",
    },
    apply_complete_bridge_evidence: {
      run: async (tx, ctx) => {
        const command = (
          await tx.query(
            `SELECT command_id, response
               FROM acd_commands
              WHERE saga_id = $1
                AND operation = 'verify_consult_completion'
                AND status IN ('accepted', 'confirmed')
              ORDER BY created_at DESC
              LIMIT 1`,
            [ctx.saga.id],
          )
        ).rows[0];
        const evidence = command?.response?.data;
        if (!evidence?.conclusive) return "stop_hold_before_restore";

        for (const [role, call] of Object.entries(evidence.calls || {})) {
          if (call?.isAlive !== false || !call.callControlId) continue;
          await tx.query(
            `UPDATE acd_legs
                SET state = 'ended',
                    ended_at = COALESCE(ended_at, $2::timestamptz),
                    ended_reason = COALESCE(ended_reason, 'provider_absence_verified')
              WHERE provider_call_id = $1 AND ended_at IS NULL`,
            [call.callControlId, evidence.checkedAt || new Date().toISOString()],
          );
          await appendEvent(tx, {
            workItemId: ctx.workItem.id,
            agentId: role === "agent" ? ctx.data.agentId : null,
            type: "provider_leg_absence_verified",
            actor: "saga:consult",
            payload: {
              saga_id: ctx.saga.id,
              role,
              provider_call_id: call.callControlId,
              probe_command_id: command.command_id,
            },
          });
        }

        if (evidence.transferred) {
          await appendEvent(tx, {
            workItemId: ctx.workItem.id,
            agentId: ctx.data.agentId || null,
            type: "consult_completion_reconciled",
            actor: "saga:consult",
            payload: {
              saga_id: ctx.saga.id,
              probe_command_id: command.command_id,
              reason: "bridge_webhook_missing",
            },
          });
          return "complete_consult";
        }
        if (evidence.allEnded) return "finalize_customer_ended";
        if (evidence.calls?.customer?.isAlive === false) return "customer_ended";
        if (evidence.calls?.target?.isAlive === false) {
          return evidence.calls?.agent?.isAlive === false
            ? "requeue_customer"
            : "stop_hold_before_restore";
        }
        if (evidence.calls?.agent?.isAlive === false) return "requeue_customer";
        return "stop_hold_before_restore";
      },
    },
    hangup_agent: {
      cmd: (ctx) => ({
        operation: "consult_complete_hangup_agent",
        endpoint: `/calls/${encodeURIComponent(ctx.data.agentProviderCallId)}/actions/hangup`,
        request: {},
      }),
      on: { accepted: "complete_consult", "leg.ended:agent_device": "complete_consult" },
      deadlineMs: 10_000,
      onFailure: "complete_consult",
      onDeadline: "complete_consult",
    },
    complete_consult: {
      run: async (tx, ctx) => {
        await setConsultState(tx, ctx, "completed", "consultant");
        const adopted = await completeTransferredWork(tx, ctx, "consult_transfer");
        // The source agent is finished, but both surviving provider legs use
        // park_after_unbridge=self. Keep Core ownership until either party
        // ends so the other leg is explicitly released as well.
        return adopted ? "succeeded" : "monitor_transfer";
      },
    },
    ...transferredMediaSteps("consult_target", "consult_transfer", "_after_complete"),
    dial_failed: {
      run: async (tx, ctx) => {
        if (ctx.data.consultState === "ringing") {
          await tx.query(`UPDATE acd_sagas SET data=data || '{"restoreFromAnsweredCustomer":true}'::jsonb WHERE id=$1`, [ctx.saga.id]);
        }
        await setConsultState(tx, ctx, "failed", "parked");
        // The original browser leg was intentionally released before dialing.
        // Restore the parked customer to the fresh browser-originated source
        // leg rather than leaving both parties isolated after no-answer.
        return "stop_hold_before_restore";
      },
    },
    ...consultCleanupSteps("customer_ended","finalize_customer_ended","consult_customer_hangup_cleanup"),
    finalize_customer_ended: {
      guard:async(tx,ctx)=>(await consultDisconnectLeg(tx,ctx))?"customer_ended":null,
      run: async (tx, ctx) => {
        await finishConsultAfterCustomerHangup(tx, ctx);
        return "cancelled";
      },
    },
    requeue_customer: {
      guard:async(tx,ctx)=>(await consultDisconnectLeg(tx,ctx))?"cleanup_requeue_target":null,
      cmd: (ctx) => ({
        operation: "consult_requeue_source",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/enqueue`,
        request: {
          queue_name: ctx.data.sourceQueueName,
          client_state: ctx.data.clientState || undefined,
        },
      }),
      on: {
        "leg.enqueued:customer": "consult_requeued",
        "leg.ended:customer": "customer_ended",
      },
      deadlineMs: 15_000,
      onFailure: "requeue_failed",
      onDeadline: "requeue_failed",
    },
    consult_requeued: {
      run: async (tx, ctx) => {
        await recoverToSourceQueue(tx, ctx, "consult_requeued");
        await setConsultState(tx, ctx, "failed", null);
        await updateIntentMetadata(tx, ctx, "failed", {
          reason: "consult_topology_lost",
          recoveredToQueue: true,
        });
        return "cancelled";
      },
    },
    requeue_failed: {
      run: async (tx, ctx) => {
        await setConsultState(tx, ctx, "failed", null);
        await updateIntentMetadata(tx, ctx, "failed", {
          reason: "source_queue_recovery_failed",
          manualInterventionRequired: true,
        });
        // Keep the handoff fence and the saga alive long enough to consume a
        // late customer hangup/enqueue. Previously the terminal failure made
        // those authoritative events no-ops and leaked the source reservation.
        return "await_failed_recovery_end";
      },
    },
    await_failed_recovery_end: {
      on: {
        "leg.enqueued:customer": "consult_requeued",
        "leg.ended:customer": "customer_ended",
        "leg.ended:consult_target": "await_failed_recovery_end",
        "leg.ended:consult_transport": "await_failed_recovery_end",
        "leg.ended:agent_device": "await_failed_recovery_end",
      },
      deadlineMs: 30_000,
      onDeadline: "failed_recovery_alarm",
    },
    failed_recovery_alarm: {
      run: async (tx, ctx) => {
        const prior = await tx.query(
          `SELECT 1 FROM acd_events
            WHERE work_item_id = $1
              AND type = 'manual_intervention_required'
              AND payload->>'saga_id' = $2
              AND payload->>'reason' = 'source_queue_recovery_failed'`,
          [ctx.workItem.id, ctx.saga.id],
        );
        if (!prior.rowCount) {
          await appendEvent(tx, {
            workItemId: ctx.workItem.id,
            agentId: ctx.data.agentId || null,
            type: "manual_intervention_required",
            actor: "saga:consult",
            payload: {
              saga_id: ctx.saga.id,
              reason: "source_queue_recovery_failed",
              reservation_preserved: true,
            },
          });
        }
        return "await_failed_recovery_end";
      },
    },
    agent_crashed: {
      cmd: async (ctx) => {
        const target = await ctx.tx.query(
          `SELECT provider_call_id FROM acd_legs
            WHERE work_item_id = $1
              AND role IN ('consult_target', 'consult_transport')
              AND ended_at IS NULL
            ORDER BY CASE WHEN role = 'consult_target' THEN 0 ELSE 1 END,
                     created_at DESC LIMIT 1`,
          [ctx.workItem.id],
        );
        return {
          operation: "consult_agent_crash_cleanup",
          endpoint: `/calls/${encodeURIComponent(target.rows[0]?.provider_call_id || ctx.data.customerProviderCallId)}/actions/hangup`,
          request: {},
        };
      },
      on: { accepted: "requeue_customer", "leg.ended:consult_target": "requeue_customer" },
      deadlineMs: 10_000,
      onFailure: "requeue_customer",
      onDeadline: "requeue_customer",
    },
    cancelled: {
      run: async (tx, ctx) => {
        await setConsultState(tx, ctx, "cancelled", null);
        await clearHandoff(tx, ctx.workItem.id);
        return "cancelled";
      },
    },
  },
});

function baseData(params) {
  return {
    agentId: params.agentId,
    agentUsername: params.agentUsername,
    reservationId: params.reservationId,
    offerId: params.offerId,
    interactionId: params.interactionId,
    customerProviderCallId: params.customerProviderCallId,
    agentProviderCallId: params.agentProviderCallId,
    connectionId: params.connectionId,
    fromNumber: params.fromNumber,
    target: params.target,
    targetKind: params.targetKind,
    targetUserId: params.targetUserId || null,
    targetUsername: params.targetUsername || null,
    targetReservationId: params.targetReservationId || null,
    targetLabel: params.targetLabel || null,
    targetTimeoutMs: params.targetTimeoutMs ?? TARGET_TIMEOUT_MS,
    wrapupDeadlineMs: params.wrapupDeadlineMs ?? WRAPUP_DEADLINE_MS,
    afterWrapupStatus: params.afterWrapupStatus || "available",
    clientState: params.clientState || null,
    sourceQueueId: params.sourceQueueId || null,
    sourceQueueName: params.sourceQueueName || null,
    sourceQueueAudioMediaName: params.sourceQueueAudioMediaName || null,
    consultHoldMediaName:
      params.consultHoldMediaName || params.sourceQueueAudioMediaName || null,
    consultHoldAnnouncementEnabled:
      params.consultHoldAnnouncementEnabled === true,
    consultHoldAnnouncementText:
      params.consultHoldAnnouncementText || null,
    consultHoldAnnouncementVoice:
      params.consultHoldAnnouncementVoice || null,
    consultHoldAnnouncementLanguage:
      params.consultHoldAnnouncementLanguage || null,
    consultHoldAnnouncementVoiceApiKeyRef:
      params.consultHoldAnnouncementVoiceApiKeyRef || null,
    consultHoldAnnouncementIntervalSeconds: Math.min(
      300,
      Math.max(10, Number(params.consultHoldAnnouncementIntervalSeconds) || 60),
    ),
  };
}

async function withAgentLifecycleDefaults(db, params) {
  const lifecycle = await loadAgentLifecycleSettings(db);
  return {
    ...params,
    targetTimeoutMs:
      params.targetTimeoutMs ?? lifecycle.default_answer_timeout_seconds * 1_000,
    wrapupDeadlineMs:
      params.wrapupDeadlineMs ?? lifecycle.wrapup_timeout_seconds * 1_000,
    afterWrapupStatus:
      params.afterWrapupStatus ?? lifecycle.after_wrapup_status,
  };
}

export async function startBlindTransferSaga(db, params) {
  params = await withAgentLifecycleDefaults(db, params);
  params = await reserveTransferTarget(db, params, "transfer");
  return startSaga(db, {
    type: "blind_transfer",
    workItemId: params.workItemId,
    conflictKey: "call-control",
    data: baseData(params),
  });
}

export async function startQueueTransferSaga(db, params) {
  params = await withAgentLifecycleDefaults(db, params);
  let routingReset = null;
  if (params.preserveRoutingOptions === false) {
    // Persist the destination requirements with the intent; apply them atomically
    // with the queue change only after the provider confirms enqueue.
    const queue = (await db.query(`SELECT skill_requirements FROM cc_queues WHERE id=$1`, [params.targetQueueId])).rows[0];
    const work = (await db.query(`SELECT attributes FROM acd_work_items WHERE id=$1`, [params.workItemId])).rows[0];
    const catalog = (await db.query(`SELECT id,name,is_active FROM skills`)).rows;
    const selected = requiredSkillsFor({}, queue?.skill_requirements);
    const normalized = normalizeSkills(selected.value, catalog, { requirements: true });
    const clientState = { ...work?.attributes?.client_state };
    delete clientState.call_priority;
    delete clientState.required_skills;
    routingReset = {
      skills: normalized.skills,
      clientState,
      requirements: { source: selected.source, original: normalized.skills,
        unknown: normalized.unknown, invalid: normalized.invalid },
    };
  }
  return startSaga(db, {
    type: "queue_transfer",
    workItemId: params.workItemId,
    conflictKey: "call-control",
    data: {
      ...baseData(params),
      targetQueueId: params.targetQueueId,
      targetQueueName: params.targetQueueName,
      routingReset,
    },
  });
}

export async function startConsultSaga(db, params) {
  params = await withAgentLifecycleDefaults(db, params);
  params = await reserveTransferTarget(db, params, "consult");
  const started = await startSaga(db, {
    type: "consult",
    workItemId: params.workItemId,
    conflictKey: "call-control",
    data: baseData(params),
  });
  // A consult changes the live agent/customer topology while the connect saga
  // is still present. Fence connect immediately so it cannot interpret those
  // leg events as an agent crash and hang up the customer.
  await db.query(
    `UPDATE acd_work_items
        SET handoff_saga_id = $2, version = version + 1
      WHERE id = $1`,
    [params.workItemId, started.sagaId],
  );
  await appendEvent(db, {
    workItemId: params.workItemId,
    agentId: params.agentId || null,
    type: "consult_started",
    payload: {
      saga_id: started.sagaId,
      agent_id: params.agentId || null,
      agent_username: params.agentUsername || null,
      target: params.target || null,
      target_kind: params.targetKind || null,
      target_label: params.targetLabel || null,
      target_username: params.targetUsername || null,
      state: "starting",
      active_leg: "customer",
    },
    actor: "intent:consult_start",
  });
  return started;
}
