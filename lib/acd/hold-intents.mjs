import { createHash, randomUUID } from "node:crypto";
import { appendEvent } from "./events.mjs";
import { applySagaEvent, driveSaga } from "./saga-engine.mjs";
import { normalizeAgentHoldSettings } from "./consult-hold-settings.mjs";
import { startAgentHoldSaga } from "./sagas/agent-hold.mjs";

function fail(message, status) {
  throw Object.assign(new Error(message), { status });
}

function fingerprint({ interactionId, action }) {
  return createHash("sha256")
    .update(JSON.stringify({ interactionId: String(interactionId), action }))
    .digest("hex");
}

/**
 * Apply a browser WebRTC hold transition as an authenticated Core intent.
 * The SDK performs the local WebRTC hold; Core owns authorization,
 * idempotency, leg state, timestamps and customer-side hold media.
 */
export async function recordHoldIntent(pool, {
  interactionId,
  agentId,
  action,
  requestId = randomUUID(),
  provider = null,
  holdSettings = {},
}) {
  if (!pool) fail("ACD database unavailable", 503);
  if (!interactionId) fail("Work item is required", 400);
  if (!agentId) fail("Agent identity is required", 401);
  if (!['hold', 'unhold'].includes(action)) fail("Unsupported hold intent", 400);
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) fail("Invalid hold request id", 400);
  const requestFingerprint = fingerprint({ interactionId, action });

  const db = await pool.connect();
  let sagaId = null;
  let sagaStarted = false;
  let workItemId = null;
  let result = null;
  try {
    await db.query("BEGIN");
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [requestId]);
    const prior = (
      await db.query(`SELECT * FROM acd_action_requests WHERE request_id = $1`, [requestId])
    ).rows[0];
    if (prior) {
      if (prior.agent_id !== agentId || prior.fingerprint !== requestFingerprint) {
        fail("Request id already used", 409);
      }
      await db.query("COMMIT");
      return {
        accepted: true,
        requestId,
        eventId: prior.event_id == null ? null : Number(prior.event_id),
        idempotent: true,
      };
    }

    const item = (
      await db.query(
        `SELECT * FROM acd_work_items
          WHERE id::text = $1
            AND channel = 'voice'
          LIMIT 1
          FOR UPDATE`,
        [String(interactionId)],
      )
    ).rows[0];
    if (!item) fail("Work item not found", 404);
    if (item.handoff_saga_id) fail("Wait for the device move or transfer to finish before changing hold.",409);
    if (item.state !== "active" || item.terminal_at) fail("Call is not active", 409);

    const owner = await db.query(
      `SELECT 1 FROM acd_segments
        WHERE work_item_id = $1 AND agent_id = $2
          AND kind = 'agent' AND ended_at IS NULL`,
      [item.id, agentId],
    );
    if (!owner.rowCount) fail("Call belongs to another agent", 403);

    const leg = (
      await db.query(
        `SELECT * FROM acd_legs
          WHERE work_item_id = $1 AND role = 'agent_device'
            AND agent_id = $2 AND ended_at IS NULL AND state <> 'ended'
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [item.id, agentId],
      )
    ).rows[0];
    if (!leg?.provider_call_id) fail("Live agent leg unavailable", 409);
    workItemId = item.id;

    const activeHold = (
      await db.query(
        `SELECT id FROM acd_sagas
          WHERE work_item_id = $1 AND type = 'agent_hold'
            AND state IN ('running', 'compensating')
          ORDER BY created_at DESC LIMIT 1
          FOR UPDATE`,
        [item.id],
      )
    ).rows[0];
    sagaId = activeHold?.id || null;

    const latest = (
      await db.query(
        `SELECT id, type, occurred_at
           FROM acd_events
          WHERE work_item_id = $1
            AND type IN ('hold_started', 'hold_ended')
            AND payload->>'leg_id' = $2
          ORDER BY id DESC
          LIMIT 1`,
        [item.id, leg.id],
      )
    ).rows[0];
    const desiredType = action === "hold" ? "hold_started" : "hold_ended";
    let recorded = null;
    if (latest?.type !== desiredType) {
      const durationSeconds = action === "unhold" && latest?.type === "hold_started"
        ? Math.max(0, Math.floor((Date.now() - new Date(latest.occurred_at).getTime()) / 1000))
        : null;
      recorded = await appendEvent(db, {
        workItemId: item.id,
        agentId,
        type: desiredType,
        actor: `agent:${agentId}`,
        payload: {
          request_id: requestId,
          leg_id: leg.id,
          provider_call_id: leg.provider_call_id,
          previous_leg_state: leg.state,
          ...(durationSeconds == null ? {} : { duration_seconds: durationSeconds }),
        },
      });
      await db.query(
        `UPDATE acd_legs
            SET state = CASE
              WHEN $2 = 'hold' THEN 'held'
              WHEN bridged_at IS NOT NULL THEN 'bridged'
              ELSE 'answered'
            END
          WHERE id = $1 AND ended_at IS NULL`,
        [leg.id, action],
      );
    }

    if (provider && action === "hold" && !sagaId) {
      const customer = (
        await db.query(
          `SELECT provider_call_id FROM acd_legs
            WHERE work_item_id = $1 AND role = 'customer'
              AND ended_at IS NULL AND state <> 'ended'
            ORDER BY created_at DESC LIMIT 1`,
          [item.id],
        )
      ).rows[0];
      if (!customer?.provider_call_id) fail("Live customer leg unavailable", 409);
      const started = await startAgentHoldSaga(db, {
        workItemId: item.id,
        customerProviderCallId: customer.provider_call_id,
        settings: normalizeAgentHoldSettings(holdSettings),
      });
      sagaId = started.sagaId;
      sagaStarted = true;
    }

    const eventId = recorded?.eventId || latest?.id || null;
    await db.query(
      `INSERT INTO acd_action_requests
         (request_id, agent_id, work_item_id, action, fingerprint, saga_id, leg_id, event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [requestId, agentId, item.id, action, requestFingerprint, sagaId, leg.id, eventId],
    );
    await db.query("COMMIT");
    result = {
      accepted: true,
      requestId,
      workItemId: item.id,
      legId: leg.id,
      sagaId,
      eventId: eventId == null ? null : Number(eventId),
      state: action === "hold" ? "held" : "active",
      idempotent: false,
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }

  if (provider && sagaId) {
    if (action === "hold" && sagaStarted) {
      await driveSaga(pool, sagaId, { provider, node: "hold-intent" });
    } else if (action === "unhold") {
      await applySagaEvent(pool, {
        workItemId,
        name: "intent.unhold",
        provider,
        node: "hold-intent",
        actor: `agent:${agentId}`,
      });
    }
  }
  return result;
}
