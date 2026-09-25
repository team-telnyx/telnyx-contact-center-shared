// ACD saga engine (the internal documentation §5.4) — ONE executor for every
// multi-step operation. Guarantees, uniform for all definitions:
//   • provider commands are journaled (acd_commands) BEFORE network I/O and
//     reuse the same command_id only while retrying the same intended effect
//     within the provider's dedupe window (Telnyx: 60 s);
//   • progress is event-driven: HTTP acceptance ≠ success unless a step
//     explicitly advances `on: { accepted: … }`;
//   • every step has a deadline; deadline/definitive failure enters the
//     definition's compensation path or fails the saga with a
//     manual_intervention_required event — never silently;
//   • execution is lease-based: any node can claim; crash mid-step is resumed
//     from the journal by another node (reconciler sweeps expired leases).
//
// Step spec (definition.steps[name]):
//   { prepare?(tx, ctx),                 // txn hook run when planning the step
//     cmd?(ctx) -> {operation, endpoint, request, targetLegId?},
//     run?(tx, ctx) -> nextStep|null,    // pure-DB step, atomic with advance
//     on?: { [eventKey]: nextStep },     // eventKey: 'leg.answered', 'leg.ended:role', 'accepted'
//     deadlineMs?: number | (ctx) => number,
//     onDeadline?: nextStep,             // default: fail saga
//     onFailure?: nextStep }             // definitive provider failure; default: fail saga
// Terminal pseudo-steps: 'succeeded' | 'failed' | 'cancelled'.
// definition.compensationSteps: Set/array of step names that flip state to 'compensating'.

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { appendEvent } from "./events.mjs";
import { hangupEndpointCallId, isAlreadyEndedResponse, isHangupEndpoint } from "./provider.mjs";

export const SAGA_LEASE_MS = 15_000;
export const PROVIDER_DEDUPE_WINDOW_MS = 60_000;

// Caller owns the transaction. Serialize cancellation with the saga runner;
// once a send step starts, its provider commitment cannot be revoked locally.
export async function cancelWaitingSaga(db, sagaId, {type,step}) {
  const saga=(await db.query('SELECT * FROM acd_sagas WHERE id=$1 FOR UPDATE',[sagaId])).rows[0];
  if(saga?.state==='cancelled')return true;
  if(saga?.state!=='running'||saga.type!==type||saga.step!==step)return false;
  await advance(db,getSagaDefinition(saga.type),saga,'cancelled');
  return true;
}
const TERMINAL_STEPS = new Set(["succeeded", "failed", "cancelled"]);
const MAX_DRIVE_ITERATIONS = 12;
const LOCAL_DEADLINE_WAKE_LIMIT_MS = 60_000;

const registry = new Map();
const localDeadlineWakeups = (globalThis.__acdSagaDeadlineWakeups ||= new Map());

/** Cancel every pending local deadline wake-up (tests and shutdown). */
export function clearSagaDeadlineWakeups() {
  for (const timer of localDeadlineWakeups.values()) clearTimeout(timer);
  localDeadlineWakeups.clear();
}

async function scheduleLocalDeadlineWake(pool, sagaId, { provider, node }) {
  const previous = localDeadlineWakeups.get(sagaId);
  if (previous) clearTimeout(previous);
  localDeadlineWakeups.delete(sagaId);
  const saga = (await pool.query(`SELECT state,deadline_at FROM acd_sagas WHERE id=$1`,[sagaId])).rows[0];
  if (!saga || !['running','compensating'].includes(saga.state) || !saga.deadline_at) return;
  const delay = Math.max(0, new Date(saga.deadline_at).getTime() - Date.now() + 10);
  if (delay > LOCAL_DEADLINE_WAKE_LIMIT_MS) return;
  const timer = setTimeout(async () => {
    localDeadlineWakeups.delete(sagaId);
    try {
      await sweepDueSagas(pool, { provider, node: `${node}:deadline`, limit: 100 });
    } catch (error) {
      console.error("[ACD Saga] Local deadline wake failed:", error);
    }
  }, delay);
  timer.unref?.();
  localDeadlineWakeups.set(sagaId, timer);
}

export function defineSaga(type, definition) {
  if (!definition?.initialStep) throw new Error(`defineSaga(${type}): initialStep is required`);
  if (!definition?.steps?.[definition.initialStep]) {
    throw new Error(`defineSaga(${type}): initialStep is not in steps`);
  }
  const compensationSteps = new Set(definition.compensationSteps || []);
  const normalized = { type, ...definition, compensationSteps };
  registry.set(type, normalized);
  return normalized;
}

export function getSagaDefinition(type) {
  const definition = registry.get(type);
  if (!definition) throw new Error(`Unknown saga type: ${type}`);
  return definition;
}

export class SagaConflictError extends Error {
  constructor(workItemId, conflictKey) {
    super(`saga conflict: work item ${workItemId} already has an active '${conflictKey}' saga`);
    this.name = "SagaConflictError";
    this.code = "ACD_SAGA_CONFLICT";
  }
}

/** Insert a saga row inside the caller's transaction. Throws SagaConflictError on mutex. */
export async function startSaga(db, params) {
  const {
    type,
    workItemId,
    conflictKey,
    data = {},
    deadlineMs,
    actor = `saga:${params.type}`,
    initialStep = null,
  } = params;
  const definition = getSagaDefinition(type);
  if (!workItemId || !conflictKey) throw new Error("startSaga: workItemId and conflictKey required");

  const id = randomUUID();
  const firstStep = initialStep || definition.initialStep;
  if (!definition.steps[firstStep]) throw new Error("Invalid initial saga step");
  const stepDeadline = resolveDeadlineMs(definition, firstStep, { data });
  const effectiveDeadline = deadlineMs ?? stepDeadline ?? 30_000;
  try {
    await db.query(
      `INSERT INTO acd_sagas (id, type, work_item_id, conflict_key, state, step, data, deadline_at)
       VALUES ($1, $2, $3, $4, 'running', $5, $6::jsonb,
               now() + ($7::text || ' milliseconds')::interval)`,
      [id, type, workItemId, conflictKey, firstStep, JSON.stringify(data), String(effectiveDeadline)],
    );
  } catch (error) {
    if (error?.code === "23505") throw new SagaConflictError(workItemId, conflictKey);
    throw error;
  }
  if (["connect", "outbound_connect"].includes(type) && data.reservationId) {
    await db.query(`UPDATE acd_reservations SET owner_saga_id = $2 WHERE id = $1 AND state <> 'released'`, [data.reservationId, id]);
  }
  if (data.targetReservationId) await db.query(`UPDATE acd_reservations SET owner_saga_id = $2 WHERE id = $1 AND state <> 'released'`, [data.targetReservationId, id]);
  await appendEvent(db, {
    workItemId,
    type: "saga_started",
    payload: { saga_id: id, saga_type: type, conflict_key: conflictKey, step: firstStep },
    actor,
  });
  return { sagaId: id, step: firstStep };
}

function resolveDeadlineMs(definition, stepName, ctx) {
  const spec = definition.steps[stepName];
  if (!spec) return null;
  if (typeof spec.deadlineMs === "function") return spec.deadlineMs(ctx);
  return spec.deadlineMs ?? null;
}

function requestHash(request) {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 32);
}

async function claimSaga(client, sagaId, node) {
  const result = await client.query(
    `SELECT * FROM acd_sagas
      WHERE id = $1 AND state IN ('running', 'compensating')
        AND (lease_owner IS NULL OR lease_owner = $2 OR lease_expires_at < now())
      FOR UPDATE SKIP LOCKED`,
    [sagaId, node],
  );
  const saga = result.rows[0];
  if (!saga) return null;
  await client.query(
    `UPDATE acd_sagas
        SET lease_owner = $2,
            lease_expires_at = now() + ($3::text || ' milliseconds')::interval,
            attempt_count = attempt_count + 1, last_driven_at = now()
      WHERE id = $1`,
    [sagaId, node, String(SAGA_LEASE_MS)],
  );
  return saga;
}

// The execution lease exists to serialize ACTIVE driving. Whenever the engine
// stops (waiting for webhook evidence / events), it releases the lease so the
// reconciler and other nodes can act immediately on deadlines.
async function releaseLease(client, sagaId) {
  await client.query(
    `UPDATE acd_sagas SET lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND state IN ('running', 'compensating')`,
    [sagaId],
  );
}

async function loadContext(client, saga) {
  const workItem = (
    await client.query(`SELECT * FROM acd_work_items WHERE id = $1`, [saga.work_item_id])
  ).rows[0];
  return { saga, workItem, data: saga.data || {} };
}

/**
 * Move a claimed saga to `nextStep` inside the caller's transaction.
 * Handles terminal pseudo-steps, compensation flagging and step deadlines.
 */
async function advance(client, definition, saga, nextStep, { reason = null, actor } = {}) {
  const workItemId = saga.work_item_id;
  if (TERMINAL_STEPS.has(nextStep)) {
    await client.query(
      `UPDATE acd_sagas
          SET state = $2, terminal_at = now(), lease_owner = NULL, lease_expires_at = NULL,
              last_error = CASE WHEN $2 = 'failed' THEN COALESCE($3, last_error) ELSE last_error END
        WHERE id = $1`,
      [saga.id, nextStep, reason],
    );
    await appendEvent(client, {
      workItemId,
      type: `saga_${nextStep}`,
      payload: { saga_id: saga.id, saga_type: saga.type, from_step: saga.step, reason },
      actor: actor || `saga:${saga.type}`,
    });
    if (nextStep === "failed") {
      await appendEvent(client, {
        workItemId,
        type: "manual_intervention_required",
        payload: { saga_id: saga.id, saga_type: saga.type, step: saga.step, reason },
        actor: actor || `saga:${saga.type}`,
      });
    }
    return { terminal: true, step: nextStep };
  }

  if (!definition.steps[nextStep]) {
    throw new Error(`saga ${saga.type}: advance to unknown step '${nextStep}'`);
  }
  const compensating = definition.compensationSteps.has(nextStep);
  const deadlineMs = resolveDeadlineMs(definition, nextStep, { saga, data: saga.data }) ?? 30_000;
  await client.query(
    `UPDATE acd_sagas
        SET step = $2,
            step_sequence = step_sequence + 1,
            state = CASE WHEN $3 THEN 'compensating' ELSE state END,
            deadline_at = now() + ($4::text || ' milliseconds')::interval,
            last_error = CASE WHEN $3 THEN COALESCE($5, last_error) ELSE last_error END
      WHERE id = $1`,
    [saga.id, nextStep, compensating, String(deadlineMs), reason],
  );
  await appendEvent(client, {
    workItemId,
    type: "saga_step",
    payload: {
      saga_id: saga.id,
      saga_type: saga.type,
      from: saga.step,
      to: nextStep,
      step_sequence: Number(saga.step_sequence) + 1,
      reason,
    },
    actor: actor || `saga:${saga.type}`,
  });
  return { terminal: false, step: nextStep };
}

async function latestCommandForStep(client, sagaId, step, stepSequence) {
  const result = await client.query(
    `SELECT * FROM acd_commands
      WHERE saga_id = $1 AND step = $2 AND step_sequence = $3
      ORDER BY created_at DESC LIMIT 1`,
    [sagaId, step, stepSequence],
  );
  return result.rows[0] || null;
}

/**
 * One transactional attempt to progress a saga. Every path releases its client
 * exactly once (finally). Returns a directive:
 *   { kind: 'return', result }   — stop driving, hand `result` to the caller
 *   { kind: 'continue' }         — a step advanced; drive again
 *   { kind: 'send', planned }    — a command is planned/resendable; perform I/O
 */
async function driveOnce(client, sagaId, { provider, node, postCommit }) {
  const device=(await client.query("SELECT data FROM acd_sagas WHERE id=$1 AND type='device_handoff'",[sagaId])).rows[0];
  if(device) {
    const lock=await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`cc-voice-owner:${device.data.agentId}`]);
    if(!lock.rows[0].acquired)return {kind:'return',result:{state:'running',waiting:'device_control'}};
    await client.query('SELECT pg_advisory_xact_lock(741901,5)');
  }
  const saga = await claimSaga(client, sagaId, node);
  if (!saga) return { kind: "return", result: { state: "not_claimable" } };

  const definition = getSagaDefinition(saga.type);
  const spec = definition.steps[saga.step];
  if (!spec) {
    await advance(client, definition, saga, "failed", { reason: `unknown_step:${saga.step}` });
    return { kind: "return", result: { state: "failed", step: saga.step } };
  }
  const ctx = await loadContext(client, saga);
  ctx.defer = (callback) => {
    if (typeof callback === "function") postCommit.push(callback);
  };

  if (spec.run) {
    const nextStep = await spec.run(client, ctx);
    if (!nextStep) {
      await releaseLease(client, saga.id);
      return { kind: "return", result: { state: saga.state, step: saga.step, waiting: "event" } };
    }
    const moved = await advance(client, definition, saga, nextStep);
    if (moved.terminal) return { kind: "return", result: { state: moved.step, step: moved.step } };
    return { kind: "continue" };
  }

  if (!spec.cmd) {
    // Pure wait step.
    await releaseLease(client, saga.id);
    return { kind: "return", result: { state: saga.state, step: saga.step, waiting: "event" } };
  }

  const existing = await latestCommandForStep(
    client,
    saga.id,
    saga.step,
    saga.step_sequence,
  );
  if (existing && ["accepted", "confirmed"].includes(existing.status)) {
    await releaseLease(client, saga.id);
    return { kind: "return", result: { state: saga.state, step: saga.step, waiting: "confirmation" } };
  }
  if (existing && ["sent", "ambiguous"].includes(existing.status)) {
    const ageMs = Date.now() - new Date(existing.created_at).getTime();
    if (ageMs > (spec.dedupeWindowMs ?? PROVIDER_DEDUPE_WINDOW_MS)) {
      // Outside the dedupe window a resend could double the effect:
      // wait for webhook evidence or the step deadline (design §5.4).
      await releaseLease(client, saga.id);
      return { kind: "return", result: { state: saga.state, step: saga.step, waiting: "evidence" } };
    }
    return { kind: "send", planned: existing }; // safe idempotent resend, SAME command_id
  }
  if (existing && existing.status === "planned") {
    // No send has happened yet. Revalidate admission after a restart: campaign
    // pause, agent readiness or inbound demand may have changed since planning.
    const next = spec.guard ? await spec.guard(client, ctx) : null;
    if (next) {
      await client.query(`UPDATE acd_commands SET status = 'failed', last_error = 'guard_rejected_before_send'
        WHERE command_id = $1 AND status = 'planned'`, [existing.command_id]);
      await advance(client, definition, saga, next);
      return { kind: "continue" };
    }
    return { kind: "send", planned: existing }; // crash between plan and send — send now
  }
  if (existing && existing.status === "failed") {
    // Definitive failure was already recorded; route to compensation.
    const moved = await advance(client, definition, saga, spec.onFailure || "failed", {
      reason: existing.last_error || "provider_rejected",
    });
    if (moved.terminal) return { kind: "return", result: { state: moved.step, step: moved.step } };
    return { kind: "continue" };
  }

  if (spec.guard) {
    const next = await spec.guard(client, ctx);
    if (next) {
      await advance(client, definition, saga, next);
      return { kind: "continue" };
    }
  }
  const commandId = `${saga.id}:${saga.step}:${saga.step_sequence}`;
  const cmdCtx = { ...ctx, tx: client, commandId };
  if (spec.prepare) await spec.prepare(client, cmdCtx);
  const descriptor = await spec.cmd(cmdCtx);
  await client.query(
    `INSERT INTO acd_commands
       (command_id, saga_id, step, step_sequence, provider, operation, target_leg_id, endpoint,
        request, request_hash, status, deadline_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'planned',
             now() + ($11::text || ' milliseconds')::interval)`,
    [
      commandId,
      saga.id,
      saga.step,
      saga.step_sequence,
      provider.name || "telnyx",
      descriptor.operation,
      descriptor.targetLegId || null,
      descriptor.endpoint,
      JSON.stringify(descriptor.request || {}),
      requestHash(descriptor.request || {}),
      String(resolveDeadlineMs(definition, saga.step, ctx) ?? 30_000),
    ],
  );
  return {
    kind: "send",
    planned: {
      command_id: commandId,
      endpoint: descriptor.endpoint,
      request: descriptor.request || {},
      operation: descriptor.operation,
    },
  };
}

/**
 * Drive a saga forward: plan/send provider commands, execute pure-DB steps,
 * honor acceptance-advance. Returns { state, step, waiting } after it can make
 * no further progress without an external event.
 */
export async function driveSaga(pool, sagaId, options) {
  const { provider, node = "node-0" } = options;
  if (!provider) throw new Error("driveSaga: provider adapter is required");
  const finish = async (result) => {
    if (result?.waiting) await scheduleLocalDeadlineWake(pool, sagaId, { provider, node });
    else {
      const timer = localDeadlineWakeups.get(sagaId);
      if (timer) clearTimeout(timer);
      localDeadlineWakeups.delete(sagaId);
    }
    return result;
  };

  for (let i = 0; i < MAX_DRIVE_ITERATIONS; i += 1) {
    const client = await pool.connect();
    const postCommit = [];
    let directive;
    try {
      await client.query("BEGIN");
      directive = await driveOnce(client, sagaId, { provider, node, postCommit });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    for (const callback of postCommit) {
      try {
        await callback();
      } catch (error) {
        console.error("[ACD Saga] Post-commit callback failed:", error);
      }
    }

    if (directive.kind === "return") return finish(directive.result);
    if (directive.kind === "continue") continue;

    // ---- provider I/O OUTSIDE any transaction ----
    const { planned } = directive;
    // A previously suspended worker must not send a plan that another worker
    // has since cancelled or completed.
    if (!await markCommand(pool, planned.command_id, "sent")) {
      return finish({ state: "running", waiting: "command_not_sendable" });
    }
    const result = await provider.send({
      endpoint: planned.endpoint,
      request: planned.request,
      commandId: planned.command_id,
      operation: planned.operation,
    });

    const recorded = await recordCommandResult(pool, sagaId, planned.command_id, result, node);
    if (recorded.advancedTo && TERMINAL_STEPS.has(recorded.advancedTo)) {
      return finish({ state: recorded.advancedTo, step: recorded.advancedTo });
    }
    if (!recorded.advancedTo) {
      return finish({ state: "running", step: recorded.step, waiting: recorded.waiting });
    }
    // advanced (acceptance-advance or failure-compensation) → loop to execute next step
  }
  return finish({ state: "running", waiting: "iteration_budget" });
}

async function markCommand(pool, commandId, status) {
  const marked = await pool.query(
    `UPDATE acd_commands
        SET status = $2, attempt_count = attempt_count + 1
      WHERE command_id = $1 AND status IN ('planned', 'sent', 'ambiguous')
      RETURNING command_id`,
    [commandId, status],
  );
  return marked.rowCount > 0;
}

// A hangup rejected because the call has already ended is not a failed
// effect: the leg is gone, which is exactly what the step wanted. Record the
// evidence on the leg and continue along the step's leg.ended path so the
// saga neither compensates nor waits for a webhook that may have been
// processed before the command was even sent.
async function settleAlreadyEndedHangup(client, { saga, commandId, meta, spec }) {
  const callId = hangupEndpointCallId(meta?.endpoint);
  const leg = (await client.query(
    `UPDATE acd_legs
        SET state = 'ended',
            ended_at = COALESCE(ended_at, now()),
            ended_reason = COALESCE(ended_reason, 'provider_already_ended')
      WHERE ($1::uuid IS NOT NULL AND id = $1::uuid)
         OR ($1::uuid IS NULL AND $2::text IS NOT NULL AND provider_call_id = $2::text)
      RETURNING id, role, work_item_id`,
    [meta?.target_leg_id || null, callId],
  )).rows[0] || null;
  await appendEvent(client, {
    workItemId: saga.work_item_id,
    type: "hangup_target_already_ended",
    actor: `saga:${saga.type}`,
    payload: {
      saga_id: saga.id,
      saga_type: saga.type,
      step: saga.step,
      command_id: commandId,
      operation: meta?.operation || null,
      leg_id: leg?.id || null,
      role: leg?.role || null,
      provider_call_id: callId,
    },
  });
  const roleKey = leg?.role ? `leg.ended:${leg.role}` : null;
  const key = roleKey && spec.on?.[roleKey]
    ? roleKey
    : spec.on?.["leg.ended"]
      ? "leg.ended"
      : spec.on?.accepted
        ? "accepted"
        : null;
  return { key, nextStep: key ? spec.on[key] : null, leg };
}

async function recordCommandResult(pool, sagaId, commandId, providerResult, node) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const meta = (await client.query(
      `SELECT endpoint, target_leg_id, operation FROM acd_commands WHERE command_id = $1`,
      [commandId],
    )).rows[0] || null;
    const alreadyEnded = providerResult.outcome === "failed"
      && isHangupEndpoint(meta?.endpoint)
      && isAlreadyEndedResponse(providerResult.response);
    const result = alreadyEnded ? { ...providerResult, outcome: "accepted" } : providerResult;
    const saga = await claimSaga(client, sagaId, node);
    if (!saga) {
      // Someone else finalized meanwhile; still record the provider outcome.
      await client.query(
        `UPDATE acd_commands SET status = CASE WHEN $2 = 'accepted' THEN 'accepted' ELSE status END,
                response = $3::jsonb, http_status = $4,
                accepted_at = CASE WHEN $2 = 'accepted' THEN now() ELSE accepted_at END
          WHERE command_id = $1`,
        [commandId, result.outcome, JSON.stringify(result.response ?? {}), result.httpStatus],
      );
      await client.query("COMMIT");
      return { advancedTo: null, waiting: "not_claimable" };
    }
    const commandResult = await client.query(
      `UPDATE acd_commands
          SET status = $2, response = $3::jsonb, http_status = $4,
              accepted_at = CASE WHEN $2 = 'accepted' THEN now() ELSE accepted_at END,
              last_error = CASE WHEN $2 IN ('failed', 'ambiguous') THEN $5 ELSE last_error END
        WHERE command_id = $1
      RETURNING step, step_sequence`,
      [
        commandId,
        result.outcome,
        JSON.stringify(result.response ?? {}),
        result.httpStatus,
        result.response?.error ? String(result.response.error) : null,
      ],
    );
    const command = commandResult.rows[0] || null;
    const isCurrentVisit =
      command &&
      command.step === saga.step &&
      Number(command.step_sequence) === Number(saga.step_sequence);
    if (!isCurrentVisit) {
      await releaseLease(client, saga.id);
      await client.query("COMMIT");
      return { advancedTo: null, waiting: "stale_result", step: saga.step };
    }
    const definition = getSagaDefinition(saga.type);
    const spec = definition.steps[saga.step] || {};

    let advancedTo = null;
    let waiting = null;
    if (alreadyEnded) {
      const settled = await settleAlreadyEndedHangup(client, { saga, commandId, meta, spec });
      if (settled.nextStep) {
        const moved = await advance(client, definition, saga, settled.nextStep, {
          reason: `already_ended:${settled.key}`,
        });
        advancedTo = moved.step;
      } else {
        waiting = "confirmation";
      }
    } else if (result.outcome === "accepted") {
      if (spec.onAccepted) {
        await spec.onAccepted(client, { saga, response: result.response });
      }
      if (spec.on?.accepted) {
        const moved = await advance(client, definition, saga, spec.on.accepted);
        advancedTo = moved.step;
      } else {
        waiting = "confirmation";
      }
    } else if (result.outcome === "failed") {
      const moved = await advance(client, definition, saga, spec.onFailure || "failed", {
        reason: `provider_rejected:${result.httpStatus}`,
      });
      advancedTo = moved.step;
    } else {
      waiting = "evidence"; // ambiguous — webhook evidence or deadline resolves
    }
    if (!advancedTo && waiting) {
      await releaseLease(client, saga.id);
    }
    await client.query("COMMIT");
    return { advancedTo, waiting, step: saga.step };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Advance sagas on a core event (translated webhook or UI intent).
 * eventKey matching: '<name>:<role>' first, then '<name>'.
 * Also confirms this step's outstanding command (webhook evidence resolves
 * 'sent'/'ambiguous' commands even after provider timeouts).
 */
export async function applySagaEvent(pool, params) {
  const { workItemId, name, role = null, payload = {}, provider, node = "node-0", actor = "provider" } = params;
  const client = await pool.connect();
  const advancedSagas = [];
  try {
    await client.query("BEGIN");
    const sagas = await client.query(
      `SELECT s.*, w.handoff_saga_id AS work_handoff_saga_id, (SELECT type FROM acd_sagas h WHERE h.id=w.handoff_saga_id) AS handoff_type
         FROM acd_sagas s
         JOIN acd_work_items w ON w.id = s.work_item_id
        WHERE s.work_item_id = $1 AND s.state IN ('running', 'compensating')
        ORDER BY s.created_at
        FOR UPDATE`,
      [workItemId],
    );
    for (const saga of sagas.rows) {
      if (saga.type === 'device_handoff' && ['handoff_target','handoff_transport','handoff_source'].includes(role)
          && payload.owner_saga_id !== saga.id) continue;
      if (['connect','manual_outbound'].includes(saga.type) && saga.handoff_type === 'device_handoff'
          && role?.startsWith('agent_')) continue;

      // A manual outbound lifecycle owns the original two provider legs until
      // a transfer/consult saga takes the handoff fence. While fenced, source
      // leg events belong to the call-control saga; allowing both sagas to
      // consume them would make manual_outbound tear down the customer during
      // an otherwise valid transfer.
      if (
        saga.type === "manual_outbound" &&
        saga.work_handoff_saga_id && saga.handoff_type !== 'device_handoff' &&
        String(saga.work_handoff_saga_id) !== String(saga.id)
      ) {
        continue;
      }
      if (saga.type === "connect" && role?.startsWith("agent_") && payload.offer_generation != null
          && Number(saga.data?.generation) !== Number(payload.offer_generation)) continue;
      // After transfer adoption, the receiving connect owns only its own
      // agent legs. A delayed source-consultation hangup may have no offer
      // generation (manual outbound), so generation fencing alone is unsafe.
      if (saga.type === "connect" && role?.startsWith("agent_")
          && payload.owner_saga_id && payload.owner_saga_id !== saga.id) continue;
      if (["consult_target", "consult_transport", "transfer_target", "transfer_transport"].includes(role)
          && payload.owner_saga_id && payload.owner_saga_id !== saga.id && saga.type !== "media_cleanup"
          && !(['target_cleanup','reservation_cleanup'].includes(saga.type) && saga.data.ownerSagaId === payload.owner_saga_id)) continue;
      // A browser-originated consultation replaces the source agent's old
      // WebRTC leg with a fresh leg owned by the consult saga. Delayed events
      // from the superseded connect/manual-outbound leg must not cancel the
      // new consultation.
      if (
        saga.type === "consult" &&
        role === "agent_device" &&
        payload.owner_saga_id &&
        payload.owner_saga_id !== saga.id
      ) continue;
      const definition = getSagaDefinition(saga.type);
      const spec = definition.steps[saga.step] || {};
      const key = role && spec.on?.[`${name}:${role}`] ? `${name}:${role}` : name;
      const nextStep = spec.on?.[key];
      if (!nextStep) continue;

      await client.query(
        `UPDATE acd_commands
            SET status = 'confirmed', confirmed_at = now(), confirmation_event_id = $3
          WHERE saga_id = $1 AND step = $2 AND step_sequence = $4
            AND status IN ('sent', 'accepted', 'ambiguous')`,
        [saga.id, saga.step, payload.event_id || null, saga.step_sequence],
      );
      if (spec.onEvent) await spec.onEvent(client, { saga, name, role, payload });
      const moved = await advance(client, definition, saga, nextStep, {
        reason: key,
        actor,
      });
      advancedSagas.push({ sagaId: saga.id, moved });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (advancedSagas.length === 0) return null;

  const results = [];
  for (const advanced of advancedSagas) {
    if (advanced.moved.terminal || !provider) {
      results.push({
        sagaId: advanced.sagaId,
        state: advanced.moved.terminal ? advanced.moved.step : "running",
        step: advanced.moved.step,
      });
      continue;
    }
    let driven = await driveSaga(pool, advanced.sagaId, { provider, node });
    if (driven.state === "not_claimable") {
      // Simultaneous leg events can hold the saga row lock exactly when we try
      // to drive (the PROD finalize-stall). One short retry closes the common
      // race; the reconciler's stalled-saga sweep is the durable backstop.
      await new Promise((resolve) => setTimeout(resolve, 150));
      driven = await driveSaga(pool, advanced.sagaId, { provider, node });
    }
    results.push({ sagaId: advanced.sagaId, ...driven });
  }
  return { ...results[0], sagas: results };
}

/**
 * Drive running/compensating sagas whose execution lease is free — the durable
 * backstop for a saga parked on a run/cmd step after its immediate drive lost
 * a claim race or its node died (PROD 2026-08-02 finalize-stall). Wait-steps
 * return immediately, so sweeping them is cheap.
 */
export async function sweepStalledSagas(pool, { provider, node = "reconciler", limit = 20 }) {
  const stalled = await pool.query(
    `SELECT id FROM acd_sagas
      WHERE state IN ('running', 'compensating')
        AND (lease_owner IS NULL OR lease_expires_at < now())
      ORDER BY last_driven_at NULLS FIRST, created_at
      LIMIT $1`,
    [limit],
  );
  let driven = 0;
  for (const row of stalled.rows) {
    const result = await driveSaga(pool, row.id, { provider, node });
    if (result.state !== "not_claimable") driven += 1;
  }
  return driven;
}

/**
 * Deadline sweep (called by the reconciler): claim due sagas and route them to
 * their step's onDeadline (or fail them). Returns the number of sagas acted on.
 */
export async function sweepDueSagas(pool, { provider, node = "reconciler", limit = 20 }) {
  const due = await pool.query(
    `SELECT id FROM acd_sagas
      WHERE state IN ('running', 'compensating') AND deadline_at < now()
      ORDER BY deadline_at
      LIMIT $1`,
    [limit],
  );
  let acted = 0;
  for (const row of due.rows) {
    const client = await pool.connect();
    let moved = null;
    try {
      await client.query("BEGIN");
      const saga = await claimSaga(client, row.id, node);
      if (!saga || new Date(saga.deadline_at).getTime() > Date.now()) {
        await client.query("ROLLBACK");
      } else {
        const definition = getSagaDefinition(saga.type);
        const spec = definition.steps[saga.step] || {};
        if (spec.run && !spec.onDeadline) {
          // A pure-DB step must be EXECUTED, not failed, when its deadline
          // passes without a drive (the drive was lost, not the step).
          await client.query(
            `UPDATE acd_sagas
                SET deadline_at = now() + interval '30 seconds',
                    lease_owner = NULL, lease_expires_at = NULL
              WHERE id = $1`,
            [saga.id],
          );
          await client.query("COMMIT");
          moved = { terminal: false, step: saga.step }; // drive below
          acted += 1;
        } else {
          moved = await advance(client, definition, saga, spec.onDeadline || "failed", {
            reason: `deadline:${saga.step}`,
            actor: "reconciler",
          });
          await client.query("COMMIT");
          acted += 1;
        }
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (moved && !moved.terminal && provider) {
      await driveSaga(pool, row.id, { provider, node });
    }
  }
  return acted;
}
