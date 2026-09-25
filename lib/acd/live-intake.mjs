// Core-only voice intake. Every configured CC queue is routed by ACD Core:
// call.enqueued builds or reuses one work item and leg webhooks are correlated
// by exact provider identifiers or generation-fenced command headers.

import { randomUUID } from "node:crypto";
import {
  claimInboxEvent,
  completeInboxEvent,
  failInboxEvent,
  hasInboxEvent,
  persistWebhookEvent,
  startInboxLeaseHeartbeat,
} from "./inbox.mjs";
import { createWorkItem, applyTransition, openSegment, closeOpenSegment } from "./lifecycle.mjs";
import { routeOne } from "./router.mjs";
import { applySagaEvent, driveSaga } from "./saga-engine.mjs";
import { startConnectSaga } from "./sagas/connect.mjs";
import "./sagas/transfers.mjs";
import { resolveCallerIdentity } from "../contact-center/caller-identity.mjs";
import { applyTransferCapacityEvidence } from "./transfer-capacity.mjs";
import { normalizeSkills, requiredSkillsFor } from './skills.mjs';
import {
  bindAcdIntakeWorkItem,
  encodeAcdClientState,
  extractAcdIntakeContext,
  materializeAcdIntakeState,
} from "./intake-source.mjs";

const DEFAULT_ANSWER_TIMEOUT_SECS = 30;

async function acquireInboxEvent(pool, event, context) {
  if (context.workerOwned) return true;
  await persistWebhookEvent(pool, event);
  context.durableInbox = true;
  context.persistedInbox = true;
  const claimed = await claimInboxEvent(pool, {
    eventId: event.eventId,
    node: context.leaseOwner,
  });
  context.claimed = Boolean(claimed);
  if (context.claimed) {
    context.leaseHeartbeat = startInboxLeaseHeartbeat(pool, event.eventId, {
      node: context.leaseOwner,
    });
  }
  return context.claimed;
}

function unclaimedInboxResult(context, { enqueued = false } = {}) {
  return {
    handled: true,
    ...(enqueued ? { handledEnqueued: true } : {}),
    outcome: "duplicate",
  };
}

async function markInbox(pool, eventId, outcome, context) {
  if (context.workerOwned) return;
  const leaseHeld = context.leaseHeartbeat
    ? await context.leaseHeartbeat.stop()
    : true;
  context.leaseHeartbeat = null;
  if (!leaseHeld) throw new Error(`ACD inbox lease lost for ${eventId}`);
  const completed = await completeInboxEvent(pool, eventId, outcome, {
    node: context.leaseOwner,
  });
  if (!completed) throw new Error(`ACD inbox lease lost for ${eventId}`);
  context.claimed = false;
}

function markCoreOwned(context, { enqueued = false, persisted = false } = {}) {
  context.coreOwned = true;
  context.persistedInbox = persisted;
  if (enqueued) context.handledEnqueued = true;
}

function customHeader(payload, name) {
  const headers = Array.isArray(payload?.custom_headers) ? payload.custom_headers : [];
  const match = headers.find((h) => String(h?.name || "").toLowerCase() === name.toLowerCase());
  return match?.value ?? null;
}

function interactionMetadataFromAttributes(attributes = {}) {
  return Object.fromEntries(
    [
      ["agent_assist_config", attributes.agent_assist_config],
      ["telnyx_stt_config", attributes.telnyx_stt_config],
      ["workflow_data", attributes.workflow_data],
      ["caller_language", attributes.caller_language],
      ["agent_language", attributes.agent_language],
    ].filter(([, value]) => value !== undefined && value !== null),
  );
}

async function loadQueueByName(pool, queueName, { includeDisabled = false } = {}) {
  // Full row: queue audio needs the queue's media configuration.
  const result = await pool.query(
    `SELECT * FROM cc_queues
      WHERE name = $1 AND ($2::boolean OR enabled = true)
      LIMIT 1`,
    [queueName, includeDisabled],
  );
  return result.rows[0] || null;
}

async function startCoreQueueAudio(
  pool,
  { callControlId, queue, workItemId, clientState = null, logger },
) {
  try {
    const position = await pool.query(
      `SELECT count(*)::int AS ahead FROM acd_work_items
        WHERE queue_id = $1 AND state = 'queued'
          AND enqueued_at < (SELECT enqueued_at FROM acd_work_items WHERE id = $2)`,
      [queue.id, workItemId],
    );
    const { startQueueAudio } = await import("../contact-center/queue-audio-service.js");
    void startQueueAudio(
      callControlId,
      queue.id,
      queue,
      (position.rows[0]?.ahead ?? 0) + 1,
      { clientState, deduplicate: true },
    );
  } catch (error) {
    logger?.warn?.("acd_queue_audio_start_failed", { error: String(error?.message || error) });
  }
}

async function stopCoreQueueAudio(callControlId, logger) {
  try {
    const { stopQueueAudio } = await import("../contact-center/queue-audio-service.js");
    await stopQueueAudio(callControlId);
  } catch (error) {
    logger?.warn?.("acd_queue_audio_stop_failed", { error: String(error?.message || error) });
  }
}

async function findWorkItemBySession(db, callSessionId) {
  const result = await db.query(
    `SELECT * FROM acd_work_items
      WHERE provider_session_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [callSessionId],
  );
  return result.rows[0] || null;
}

async function verifyGeneratorContext(
  db,
  generator,
  { callControlId, callSessionId },
) {
  if (
    generator?.verified !== true ||
    !generator.runId ||
    !generator.ledgerId ||
    !generator.flowId
  ) {
    return null;
  }
  const result = await db.query(
    `SELECT 1
       FROM cg_call_ledger
      WHERE id = $1
        AND run_id = $2
        AND result->>'flow_id' = $3
        AND result->>'inbound_call_control_id' = $4
        AND ($5::text IS NULL OR result->>'inbound_call_session_id' = $5)
      LIMIT 1`,
    [
      generator.ledgerId,
      generator.runId,
      generator.flowId,
      callControlId,
      callSessionId,
    ],
  );
  return result.rowCount ? generator : null;
}

async function handleLiveEnqueued(pool, provider, event, context) {
  const { node } = context;
  const payload = event.payload || {};
  const queueName = payload.queue;
  const callSessionId = payload.call_session_id || null;
  const callControlId = payload.call_control_id || null;
  if (!queueName || !callSessionId || !callControlId) return { handled: false };

  const persistedCoreEvent = context.persistedInbox;
  const queue = await loadQueueByName(pool, queueName, {
    includeDisabled: persistedCoreEvent,
  });
  if (!queue) {
    if (persistedCoreEvent) {
      throw new Error(`Persisted Core inbox event references missing queue ${queueName}`);
    }
    return { handled: false };
  }
  markCoreOwned(context, { enqueued: true, persisted: persistedCoreEvent });

  if (!(await acquireInboxEvent(pool, event, context))) {
    return unclaimedInboxResult(context, { enqueued: true });
  }

  const client = await pool.connect();
  let workItemId = null;
  let queueClientState = payload.client_state || null;
  try {
    await client.query("BEGIN");
    const existing = await findWorkItemBySession(client, callSessionId);
    if (existing) {
      // An agentless flow can enqueue its already-owned outbound customer.
      if (existing.outbound_attempt_id && existing.attributes?.outbound_mode === 'agentless_flow' && existing.state === 'active') {
        const assigned = await client.query(`SELECT 1 FROM acd_segments WHERE work_item_id=$1 AND kind='agent' AND ended_at IS NULL`,[existing.id]);
        if (!assigned.rowCount) {
          await closeOpenSegment(client,existing.id,{outcome:'transferred'});
          await applyTransition(client,{workItemId:existing.id,to:'queued',
            eventType:'outbound_flow_queued',actor:'provider',patch:{queueId:queue.id,enqueuedAt:new Date().toISOString()}});
          await openSegment(client,{workItemId:existing.id,kind:'queue_wait',queueId:queue.id});
        }
      }
      // Provider redelivery with a fresh event id — the work item already
      // exists and the core owns its lifecycle; nothing to do.
      await client.query("COMMIT");
      let outcome = "noop";
      if (!existing.terminal_at) {
        const advanced = await applySagaEvent(pool, {
          workItemId: existing.id,
          name: "leg.enqueued",
          role: "customer",
          payload: { event_id: event.eventId, provider_call_id: callControlId },
          provider,
          node,
          actor: "provider",
        });
        outcome = advanced ? "applied" : "noop";
      }
      const fresh = (
        await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [existing.id])
      ).rows[0];
      if (fresh?.state === "queued") {
        void startCoreQueueAudio(pool, {
          callControlId,
          queue,
          workItemId: existing.id,
          clientState: payload.client_state || null,
          logger: event.logger,
        });
        // Queue transfers reuse the existing work item. The transfer saga
        // commits the new queue_wait segment before this provider event is
        // handled, so route the continuing call just like a freshly-created
        // Core work item instead of waiting for an eventually-consistent
        // worker tick.
        await routeAndConnect(pool, provider, existing.id, { node });
      }
      await markInbox(pool, event.eventId, outcome, context);
      return { handled: true, handledEnqueued: true, outcome };
    }

    const initialClientState = extractAcdIntakeContext(payload.client_state)
      ? payload.client_state
      : encodeAcdClientState(
          materializeAcdIntakeState({
            clientState: payload.client_state,
            payload,
            flowId: event.sourceFlowId || null,
          }),
        );
    const intake = extractAcdIntakeContext(initialClientState);
    const verifiedGenerator = await verifyGeneratorContext(
      client,
      intake?.source?.generator,
      { callControlId, callSessionId },
    );
    const selectedSkills = requiredSkillsFor(
      intake?.routing?.requiredSkills,
      queue.skill_requirements,
    );
    const skillCatalog = (await client.query('SELECT id, name, is_active FROM skills')).rows;
    const normalizedSkills = normalizeSkills(selectedSkills.value, skillCatalog, { requirements: true });
    const requiredSkills = normalizedSkills.skills;

    const customerAddress =
      intake?.source?.originalCustomerAddress || payload.from || null;
    const ccAddress =
      intake?.source?.originalContactCenterAddress || payload.to || null;
    const callerIdentity = await resolveCallerIdentity(client, customerAddress);
    const customerName = callerIdentity?.name || null;
    const workItemIdCandidate = randomUUID();
    const clientState = bindAcdIntakeWorkItem(initialClientState, {
      id: workItemIdCandidate,
      provider_session_id: callSessionId,
      customer_address: customerAddress,
      cc_address: ccAddress,
    });
    queueClientState = encodeAcdClientState(clientState);

    const workItem = await createWorkItem(client, {
      id: workItemIdCandidate,
      channel: "voice",
      direction: "inbound",
      queueId: queue.id,
      priority: intake?.routing?.priority || 0,
      requiredSkills,
      customerAddress,
      ccAddress,
      attributes: {
        routing_requirements: { source: selectedSkills.source, original: requiredSkills,
          unknown: normalizedSkills.unknown, invalid: normalizedSkills.invalid },
        ...(verifiedGenerator
          ? { call_generator_ledger_id: String(verifiedGenerator.ledgerId), call_generator_run_id: String(verifiedGenerator.runId) }
          : {}),
        call_session_id: callSessionId,
        customer_call_control_id: callControlId,
        ...(customerName ? { customer_name: customerName } : {}),
        ...(callerIdentity?.source
          ? { customer_identity_source: callerIdentity.source }
          : {}),
        ...(callerIdentity?.id ? { customer_identity_id: callerIdentity.id } : {}),
        client_state: clientState,
        ...(Object.keys(intake?.agentAssistConfig || {}).length
          ? { agent_assist_config: intake.agentAssistConfig }
          : {}),
        ...(Object.keys(intake?.transcriptionConfig || {}).length
          ? { telnyx_stt_config: intake.transcriptionConfig }
          : {}),
        ...(Object.keys(intake?.workflowData || {}).length
          ? { workflow_data: intake.workflowData }
          : {}),
        ...(intake?.aiCallControlId
          ? { ai_call_control_id: intake.aiCallControlId }
          : {}),
        ...(intake?.callerLanguage
          ? { caller_language: intake.callerLanguage }
          : {}),
        ...(intake?.agentLanguage
          ? { agent_language: intake.agentLanguage }
          : {}),
      },
      actor: "live-intake",
    });
    workItemId = workItem.id;

    await client.query(
      `INSERT INTO acd_legs (id, work_item_id, role, provider_call_id, provider_session_id, state, answered_at)
       VALUES ($1, $2, 'customer', $3, $4, 'answered', now())
       ON CONFLICT (provider_call_id) DO NOTHING`,
      [randomUUID(), workItemId, callControlId, callSessionId],
    );
    await applyTransition(client, {
      workItemId,
      to: "queued",
      eventType: "work_item_queued",
      payload: { queue_id: queue.id },
      actor: "live-intake",
      patch: { queueId: queue.id, enqueuedAt: new Date().toISOString() },
    });
    await openSegment(client, { workItemId, kind: "queue_wait", queueId: queue.id });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await markInbox(pool, event.eventId, "applied", context);

  // Queue media starts after the Core queue transition; the connect saga
  // stops it before the agent bridge is established.
  void startCoreQueueAudio(pool, {
    callControlId,
    queue,
    workItemId,
    clientState: queueClientState,
    logger: event.logger,
  });

  // Route immediately for latency; the router worker is the fallback for
  // no-agent-now and crash-between cases (reconciler covers orphaned claims).
  try {
    await routeAndConnect(pool, provider, workItemId, { node });
  } catch {
    /* worker retries on its next drain; failure already recorded in events */
  }
  return { handled: true, handledEnqueued: true, outcome: "applied", workItemId };
}

async function bindAgentLegFromHeaders(pool, event, context) {
  const payload = event.payload || {};
  const workItemId = customHeader(payload, "X-CC-Work-Item-Id");
  const generation = Number(customHeader(payload, "X-CC-Offer-Generation") || 0);
  const callControlId = payload.call_control_id || null;
  if (!workItemId || !generation || !callControlId) return { handled: false };

  markCoreOwned(context, { persisted: context.persistedInbox });

  if (!(await acquireInboxEvent(pool, event, context))) {
    return unclaimedInboxResult(context);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const intent = await client.query(
      `SELECT i.*, r.state AS reservation_state, r.owner_saga_id FROM acd_leg_intents i
        LEFT JOIN acd_reservations r ON r.id=i.reservation_id
        WHERE i.work_item_id = $1 AND i.offer_generation = $2
        FOR UPDATE OF i`,
      [workItemId, generation],
    );
    if (!intent.rows[0] || (!['pending','bound'].includes(intent.rows[0].state) && !['reserved','ringing','active'].includes(intent.rows[0].reservation_state))) {
      await client.query("ROLLBACK");
      await markInbox(pool, event.eventId, "unmatched", context);
      return { handled: true, outcome: "unmatched" };
    }
    const direction = String(payload.direction || "").toLowerCase();
    const role = ["outgoing", "outbound"].includes(direction)
      ? "agent_transport"
      : "agent_device";
    const insertedLeg = await client.query(
      `INSERT INTO acd_legs (id, work_item_id, role, provider_call_id, offer_generation, state, agent_id, owner_saga_id)
       VALUES ($1, $2, $3, $4, $5, 'ringing', $6, $7)
       ON CONFLICT (provider_call_id) DO UPDATE SET
         provider_session_id = COALESCE(acd_legs.provider_session_id, EXCLUDED.provider_session_id)
       RETURNING id`,
      [randomUUID(), workItemId, role, callControlId, generation, intent.rows[0].agent_id, intent.rows[0].owner_saga_id],
    );
    await client.query(
      `UPDATE acd_legs SET provider_session_id = COALESCE(provider_session_id, $2)
        WHERE provider_call_id = $1`,
      [callControlId, payload.call_session_id || null],
    );
    if (role === "agent_device") {
      await client.query(
        `UPDATE acd_leg_intents
            SET state = 'bound', bound_leg_id = $3
          WHERE work_item_id = $1 AND offer_generation = $2
            AND state IN ('pending', 'bound')`,
        [workItemId, generation, insertedLeg.rows[0]?.id || null],
      );
    } else {
      await client.query(
        `UPDATE acd_leg_intents
            SET transport_call_id = COALESCE(transport_call_id, $3)
          WHERE work_item_id = $1 AND offer_generation = $2
            AND state IN ('pending', 'bound')`,
        [workItemId, generation, callControlId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await markInbox(pool, event.eventId, "applied", context);
  return { handled: true, outcome: "applied" };
}

async function bindCallControlLegFromHeaders(pool, provider, event, context) {
  const payload = event.payload || {};
  const workItemId = customHeader(payload, "X-CC-Work-Item-Id");
  let role = customHeader(payload, "X-CC-Leg-Role");
  const sagaId = customHeader(payload, "X-CC-Saga-Id");
  const callControlId = payload.call_control_id || null;
  if (
    !workItemId ||
    !sagaId ||
    !callControlId ||
    !["consult_target", "transfer_target", "customer", "agent_device", "handoff_target"].includes(role)
  ) {
    return { handled: false };
  }

  markCoreOwned(context, { persisted: context.persistedInbox });
  if (!(await acquireInboxEvent(pool, event, context))) {
    return unclaimedInboxResult(context);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const saga = await client.query(
      `SELECT id, type, data, state FROM acd_sagas
        WHERE id = $1 AND work_item_id = $2
          AND (state IN ('running', 'compensating') OR type='device_handoff' OR EXISTS (
            SELECT 1 FROM acd_reservations r WHERE r.owner_saga_id = acd_sagas.id AND r.state <> 'released'))
        FOR UPDATE`,
      [sagaId, workItemId],
    );
    if (!saga.rows[0]) {
      await client.query("ROLLBACK");
      await markInbox(pool, event.eventId, "unmatched", context);
      return { handled: true, outcome: "unmatched" };
    }
    if (role === "handoff_target") {
      const journal=await client.query("SELECT 1 FROM acd_commands WHERE saga_id=$1 AND operation='device_handoff_dial'",[sagaId]);
      if (saga.rows[0].type !== "device_handoff" || !journal.rowCount || customHeader(payload,"X-CC-Handoff-Nonce")!==saga.rows[0].data.nonce) {
        await client.query("ROLLBACK"); await markInbox(pool,event.eventId,"unmatched",context); return {handled:true,outcome:"unmatched"};
      }
      if (["outgoing","outbound"].includes(String(payload.direction||"").toLowerCase())) role="handoff_transport";
      if (saga.rows[0].state==='cancelled') role='handoff_source';
    }
    if (role === "customer" && saga.rows[0].type !== "manual_outbound") {
      await client.query("ROLLBACK");
      await markInbox(pool, event.eventId, "unmatched", context);
      return { handled: true, outcome: "unmatched" };
    }
    if (
      role === "agent_device" &&
      (saga.rows[0].type !== "consult" ||
        !["outgoing", "outbound"].includes(
          String(payload.direction || "").toLowerCase(),
        ))
    ) {
      await client.query("ROLLBACK");
      await markInbox(pool, event.eventId, "unmatched", context);
      return { handled: true, outcome: "unmatched" };
    }
    if (["consult_target", "transfer_target"].includes(role)
        && saga.rows[0].data?.targetUserId && /^sip:/i.test(saga.rows[0].data.target || "")
        && ["outgoing", "outbound"].includes(String(payload.direction || "").toLowerCase())) {
      role = role === "consult_target" ? "consult_transport" : "transfer_transport";
    }
    await client.query(
      `INSERT INTO acd_legs
         (id, work_item_id, role, agent_id, provider_call_id, provider_session_id,
          owner_saga_id, state)
       VALUES ($1, $2, $3, $7, $4, $5, $6, 'dialing')
       ON CONFLICT (provider_call_id) DO UPDATE SET
         provider_session_id = COALESCE(acd_legs.provider_session_id, EXCLUDED.provider_session_id),
         owner_saga_id = COALESCE(acd_legs.owner_saga_id, EXCLUDED.owner_saga_id)`,
      [
        randomUUID(),
        workItemId,
        role,
        callControlId,
        payload.call_session_id || null,
        sagaId,
        role === "consult_target"
          ? saga.rows[0].data?.targetUserId || null
          : ["agent_device","handoff_target","handoff_transport"].includes(role)
            ? saga.rows[0].data?.agentId || null
            : null,
      ],
    );
    if (role === "agent_device" && saga.rows[0].type === "consult") {
      await client.query(
        `UPDATE acd_sagas
            SET data = data || jsonb_build_object(
              'agentProviderCallId', $2::text,
              'agentProviderSessionId', $3::text,
              'browserOriginatedConsult', true
            )
          WHERE id = $1`,
        [sagaId, callControlId, payload.call_session_id || null],
      );
      await client.query(
        `UPDATE acd_work_items
            SET attributes = attributes || jsonb_build_object(
              'agent_device_call_control_id', $2::text
            )
          WHERE id = $1`,
        [workItemId, callControlId],
      );
    }
    if (role === "customer" && saga.rows[0].type === "manual_outbound") {
      await client.query(
        `UPDATE acd_sagas
            SET data = data || jsonb_build_object('customerProviderCallId', $2::text)
          WHERE id = $1`,
        [sagaId, callControlId],
      );
      await client.query(
        `UPDATE acd_work_items
            SET provider_session_id = COALESCE(provider_session_id, $2),
                attributes = attributes || jsonb_build_object(
                  'customer_call_control_id', $3::text
                )
          WHERE id = $1`,
        [workItemId, payload.call_session_id || null, callControlId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await applySagaEvent(pool, {
    workItemId,
    name: "leg.initiated",
    role,
    payload: { event_id: event.eventId, provider_call_id: callControlId, owner_saga_id: sagaId },
    provider,
    node: context.node,
    actor: "provider",
  });
  await markInbox(pool, event.eventId, "applied", context);
  return { handled: true, outcome: "applied", skipAdapterEffects: true };
}

/** Customer hangup while queued (no saga yet): terminal abandon in one txn. */
async function abandonIfQueued(pool, leg, event) {
  if (leg.role !== "customer" || event.eventType !== "call.hangup") return false;
  const client = await pool.connect();
  let applied = false;
  try {
    await client.query("BEGIN");
    const wiResult = await client.query(
      `SELECT * FROM acd_work_items WHERE id = $1 FOR UPDATE`,
      [leg.work_item_id],
    );
    const workItem = wiResult.rows[0];
    if (workItem && ["open", "queued"].includes(workItem.state)) {
      await closeOpenSegment(client, workItem.id, { outcome: "abandoned" });
      await applyTransition(client, {
        workItemId: workItem.id,
        to: "abandoned",
        eventType: "work_item_abandoned",
        payload: { reason: "customer_hangup_in_queue", event_id: event.eventId },
        actor: "provider",
        patch: { terminalReason: "customer_hangup_in_queue" },
      });
      applied = true;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (applied) {
    await stopCoreQueueAudio(leg.provider_call_id);
  }
  return applied;
}

const LEG_EVENT_MAP = Object.freeze({
  "call.answered": { legState: "answered", sagaEvent: "leg.answered" },
  "call.bridged": { legState: "bridged", sagaEvent: "leg.bridged" },
  "call.hangup": { legState: "ended", sagaEvent: "leg.ended" },
  "call.speak.ended": { legState: null, sagaEvent: "media.speak_ended" },
  "call.initiated": { legState: null, sagaEvent: null },
});

async function translateLegEvent(pool, provider, event, context) {
  const { node } = context;
  const payload = event.payload || {};
  const callControlId = payload.call_control_id || null;
  if (!callControlId) return { handled: false };

  const legResult = await pool.query(
    `SELECT l.*
       FROM acd_legs l
      WHERE l.provider_call_id = $1`,
    [callControlId],
  );
  const leg = legResult.rows[0];

  if (!leg) {
    if (event.eventType === "call.initiated") {
      const callControlLeg = await bindCallControlLegFromHeaders(pool, provider, event, context);
      if (callControlLeg.handled) return callControlLeg;
      return bindAgentLegFromHeaders(pool, event, context);
    }
    return { handled: false };
  }

  markCoreOwned(context, { persisted: context.persistedInbox });

  // Dial responses for PSTN/manual consult destinations can bind the target
  // before Telnyx delivers call.initiated. Preserve that initiated edge so the
  // consult saga can bridge the agent away from the customer before answer.
  // WebRTC user transports keep their separate consult_transport role and do
  // not advance the target state machine here.
  const mapping =
    event.eventType === "call.initiated" && leg.role === "consult_target"
      ? { legState: null, sagaEvent: "leg.initiated" }
      : LEG_EVENT_MAP[event.eventType];
  if (!mapping) return { handled: true, outcome: "noop" }; // adapter effects still replay for known core legs

  if (!(await acquireInboxEvent(pool, event, context))) {
    return unclaimedInboxResult(context);
  }

  if (mapping.legState) {
    const updated = await pool.query(
      `UPDATE acd_legs
          SET state = CASE WHEN state = 'bridged' AND $2 = 'answered' THEN state ELSE $2 END,
              answered_at = CASE WHEN $2 = 'answered' THEN COALESCE(answered_at, now()) ELSE answered_at END,
              bridged_at = CASE WHEN $2 = 'bridged' THEN now() ELSE bridged_at END,
              bridged_peer_call_id = CASE WHEN $2 = 'bridged' THEN $4 ELSE bridged_peer_call_id END,
              bridged_event_id = CASE WHEN $2 = 'bridged' THEN $5 ELSE bridged_event_id END,
              ended_at = CASE WHEN $2 = 'ended' THEN COALESCE(ended_at, now()) ELSE ended_at END,
              ended_reason = CASE WHEN $2 = 'ended' THEN COALESCE(ended_reason, $3) ELSE ended_reason END
        WHERE id = $1 AND (ended_at IS NULL OR $2 = 'ended') RETURNING id`,
      [leg.id, mapping.legState, payload.hangup_cause || payload.hangup_source || null,
        typeof payload.bridged_call_control_id === 'string' ? payload.bridged_call_control_id : null, event.eventId],
    );
    if (!updated.rowCount) {
      await markInbox(pool, event.eventId, "noop", context);
      return { handled: true, outcome: "noop" };
    }
  }

  let outcome = "applied";
  await applyTransferCapacityEvidence(pool, leg, event.eventType);
  if (mapping.sagaEvent) {
    const advanced = await applySagaEvent(pool, {
      workItemId: leg.work_item_id,
      name: mapping.sagaEvent,
      role: leg.role,
      payload: { event_id: event.eventId, provider_call_id: callControlId,
        offer_generation: leg.offer_generation, owner_saga_id: leg.owner_saga_id,
        agent_id: leg.agent_id },
      provider,
      node,
      actor: "provider",
    });
    // A cleanup saga may observe the same customer hangup. Its observation
    // does not own the queued work lifecycle or make the caller live again.
    const abandoned = await abandonIfQueued(pool, leg, event);
    outcome = abandoned || advanced ? "applied" : "noop";
  }

  await markInbox(pool, event.eventId, outcome, context);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
  } finally {
    client.release();
  }
  return { handled: true, outcome };
}

async function applyAcdVoiceEvent(pool, provider, event, context) {
  if (!event?.eventId || !event?.eventType) return { handled: false };
  if (!context.workerOwned) {
    const persisted = await hasInboxEvent(pool, event.eventId);
    if (persisted) {
      markCoreOwned(context, {
        enqueued: event.eventType === "call.enqueued",
        persisted: true,
      });
      context.durableInbox = true;
    }
  }
  if (event.eventType === "call.enqueued") {
    const result = await handleLiveEnqueued(pool, provider, event, context);
    if (context.coreOwned && !result.handled) {
      return { ...result, handled: true, handledEnqueued: true };
    }
    return result;
  }
  const result = await translateLegEvent(pool, provider, event, context);
  return context.coreOwned && !result.handled
    ? { ...result, handled: true, outcome: LEG_EVENT_MAP[event.eventType] ? "unmatched" : "noop" }
    : result;
}

/** Apply a row already leased by the durable inbox worker. Throws on failure. */
export async function applyClaimedAcdVoiceEvent(
  pool,
  provider,
  event,
  { node = "inbox-worker" } = {},
) {
  return applyAcdVoiceEvent(pool, provider, event, {
    node,
    workerOwned: true,
    claimed: true,
    coreOwned: true,
    persistedInbox: true,
    handledEnqueued: event?.eventType === "call.enqueued",
  });
}

/**
 * Authoritative entry point wired into both voice webhook routes.
 * Once Core admission is known, a failure before the durable inbox
 * INSERT is reported as { retryable: true, httpStatus: 503 }; webhook routes
 * must propagate that non-2xx so the provider redelivers instead of
 * acknowledging an event that cannot be replayed.
 */
export async function routeAcdVoiceEvent(pool, provider, event, { node = "web", logger = null } = {}) {
  const context = {
    node,
    leaseOwner: `${node}:${randomUUID()}`,
    workerOwned: false,
    claimed: false,
    leaseHeartbeat: null,
    coreOwned: false,
    persistedInbox: false,
    durableInbox: false,
    handledEnqueued: false,
  };
  try {
    return await applyAcdVoiceEvent(pool, provider, event, context);
  } catch (error) {
    if (context.claimed && event?.eventId) {
      const leaseHeld = context.leaseHeartbeat
        ? await context.leaseHeartbeat.stop().catch(() => false)
        : true;
      context.leaseHeartbeat = null;
      if (leaseHeld) {
        await failInboxEvent(pool, event.eventId, error, {
          node: context.leaseOwner,
        }).catch(() => {});
      }
      context.claimed = false;
    }
    logger?.warn?.("acd_live_intake_failed", {
      error: String(error?.message || error),
      eventType: event?.eventType,
    });
    const admissionFailed = context.coreOwned && !context.durableInbox;
    return {
      handled: context.coreOwned,
      ...(context.handledEnqueued && !admissionFailed ? { handledEnqueued: true } : {}),
      ...(admissionFailed ? { retryable: true, httpStatus: 503 } : {}),
      error: true,
      reason: String(error?.message || error),
    };
  }
}

/**
 * Route a queued core work item and start the connect saga. Used by the
 * immediate path (post-enqueue) and by the router worker's drain.
 */
export async function routeAndConnect(pool, provider, workItemId, { node = "router" } = {}) {
  const wiResult = await pool.query(`SELECT * FROM acd_work_items WHERE id = $1`, [workItemId]);
  const workItem = wiResult.rows[0];
  if (!workItem || workItem.state !== "queued") return { routed: false, reason: "not_queued" };
  if (workItem.channel !== "voice") return { routed: false, reason: "unsupported_channel" };

  const route = await routeOne(pool, workItemId);
  if (!route.routed) return route;

  const agentResult = await pool.query(
    `SELECT id, username, first_name, last_name, telephony_credentials_id, telephony_user_name
       FROM users WHERE id = $1`,
    [route.agentId],
  );
  const agent = agentResult.rows[0];
  const customerLeg = (
    await pool.query(
      `SELECT provider_call_id, provider_session_id FROM acd_legs
        WHERE work_item_id = $1 AND role = 'customer' ORDER BY created_at DESC LIMIT 1`,
      [workItemId],
    )
  ).rows[0];
  const queue = (
    await pool.query(`SELECT name, agent_answer_timeout_secs, queue_audio_media_name FROM cc_queues WHERE id = $1`, [
      workItem.queue_id,
    ])
  ).rows[0];

  if (!agent || !customerLeg) {
    return { routed: true, sagaId: null, error: "missing_agent_or_customer_leg" };
  }

  const telephonyUserName =
    agent.telephony_user_name || String(agent.username || "").split("@")[0];
  const answerTimeoutSecs =
    Number(route.answerTimeoutSecs) > 0
      ? Number(route.answerTimeoutSecs)
      : Number(queue?.agent_answer_timeout_secs) > 0
        ? Number(queue.agent_answer_timeout_secs)
        : DEFAULT_ANSWER_TIMEOUT_SECS;
  const clientStatePayload = {
    ...(workItem.attributes?.client_state &&
    typeof workItem.attributes.client_state === "object"
      ? workItem.attributes.client_state
      : {}),
  };
  if (workItem.priority) clientStatePayload.call_priority = workItem.priority;
  if (workItem.required_skills && Object.keys(workItem.required_skills).length > 0) {
    clientStatePayload.required_skills = workItem.required_skills;
  }
  const clientState =
    Object.keys(clientStatePayload).length > 0
      ? Buffer.from(JSON.stringify(clientStatePayload)).toString("base64")
      : null;
  const callerIdentity = workItem.attributes?.customer_name
    ? null
    : await resolveCallerIdentity(pool, workItem.customer_address);
  const customerName =
    workItem.attributes?.customer_name || callerIdentity?.name || null;
  const customerFirstMode = ["power", "predictive"].includes(String(workItem.attributes?.outbound_mode || ""));
  const outboundSaga = customerFirstMode
    ? (await pool.query(`SELECT id,data FROM acd_sagas WHERE work_item_id=$1 AND type='outbound_connect' ORDER BY created_at LIMIT 1`,[workItemId])).rows[0]
    : null;
  const outboundDialPayload = outboundSaga?.data?.dialPayload || null;
  if (customerFirstMode && (!outboundSaga || !outboundDialPayload?.connection_id || !outboundDialPayload?.webhook_url)) {
    return { routed: true, sagaId: null, error: "missing_outbound_bridge_context" };
  }

  const client = await pool.connect();
  let sagaId = null;
  try {
    await client.query("BEGIN");
    const started = await startConnectSaga(client, {
      workItem,
      routeResult: route,
      customerProviderCallId: customerLeg.provider_call_id,
      agentSipUri: `sip:${telephonyUserName}@sip.telnyx.com`,
      agentDisplayName: [agent.first_name, agent.last_name].filter(Boolean).join(" ") || null,
      answerTimeoutMs: answerTimeoutSecs * 1000,
      connectionId: agent.telephony_credentials_id || null,
      agentUsername: agent.username,
      customerNumber: workItem.customer_address,
      customerName,
      customerSessionId: customerLeg.provider_session_id,
      interactionId: workItem.id,
      queueName: queue?.name || null,
      enqueuedAt: workItem.enqueued_at || null,
      interactionMetadata: interactionMetadataFromAttributes(workItem.attributes),
      clientState,
      queueAudioMediaName: queue?.queue_audio_media_name || null,
      // Power/predictive remain customer-first: this path runs only after the
      // PSTN customer answers. Use a separate WebRTC agent leg and explicit
      // bridge, matching Telnyx's outbound-dialer media topology. Transferring
      // the PSTN leg directly exposed agent ringback and did not carry the
      // browser microphone reliably to the receiver.
      agentFirst: customerFirstMode,
      customerReady: customerFirstMode,
      outboundSagaId: outboundSaga?.id || null,
      agentDialPayload: customerFirstMode ? {
        connection_id: outboundDialPayload.connection_id,
        webhook_url: outboundDialPayload.webhook_url,
        webhook_url_method: outboundDialPayload.webhook_url_method,
        from: outboundDialPayload.from,
      } : null,
    });
    sagaId = started.sagaId;
    if (customerFirstMode && outboundSaga?.id) {
      await client.query(
        `UPDATE acd_sagas
            SET data = data || jsonb_build_object(
              'connectSagaId', $2::text,
              'customerFirstAgentBridge', true
            )
          WHERE id = $1`,
        [outboundSaga.id, started.sagaId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // Saga conflict = another node already connected it; anything else leaves
    // an orphaned claim which the reconciler repairs and requeues.
    return { routed: true, sagaId: null, error: String(error?.message || error) };
  } finally {
    client.release();
  }

  // Cancel local queue-audio timers only after the durable assignment saga
  // exists. If saga creation fails, the caller remains queued and must keep
  // hearing queue media while the orphan claim is reconciled.
  try {
    const { cancelQueueAudioSession } = await import(
      "../contact-center/queue-audio-service.js"
    );
    cancelQueueAudioSession(
      workItem.attributes?.customer_call_control_id || null,
    );
  } catch {
    /* the saga's provider stop step remains authoritative */
  }

  const driven = await driveSaga(pool, sagaId, { provider, node });
  return { routed: true, sagaId, driven };
}
