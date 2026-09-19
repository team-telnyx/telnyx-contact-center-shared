import { createTelnyxProvider } from "./provider.mjs";
import { applySagaEvent, driveSaga, SagaConflictError } from "./saga-engine.mjs";
import {
  startBlindTransferSaga,
  startConsultSaga,
  startQueueTransferSaga,
} from "./sagas/transfers.mjs";
import { loadConsultHoldSettings } from "./consult-hold-settings.mjs";

const START_ACTIONS = new Set(["blind_transfer", "queue_transfer", "consult_start"]);
const CONSULT_EVENTS = Object.freeze({
  consult_switch_customer: "intent.switch_customer",
  consult_switch_consultant: "intent.switch_consultant",
  consult_cancel: "intent.cancel",
  consult_complete: "intent.complete",
});

const E164 = /^\+[1-9]\d{6,14}$/;

export function resolveTransferFromNumber(
  context,
  fallback = process.env.TELNYX_MAIN_FROM_NUMBER,
) {
  return [context?.cc_address, context?.owner_voice_number, fallback]
    .map((value) => String(value || "").trim())
    .find((value) => E164.test(value)) || null;
}

export class AcdIntentError extends Error {
  constructor(message, status = 400, code = "ACD_INTENT_INVALID") {
    super(message);
    this.name = "AcdIntentError";
    this.status = status;
    this.code = code;
  }
}

function encodedClientState(workItem, preserveRoutingOptions) {
  const source =
    workItem.attributes?.client_state && typeof workItem.attributes.client_state === "object"
      ? { ...workItem.attributes.client_state }
      : {};
  if (preserveRoutingOptions) {
    if (Number(workItem.priority) > 0) source.call_priority = Number(workItem.priority);
    if (workItem.required_skills && Object.keys(workItem.required_skills).length > 0) {
      source.required_skills = workItem.required_skills;
    }
  } else {
    delete source.call_priority;
    delete source.required_skills;
  }
  return Object.keys(source).length > 0
    ? Buffer.from(JSON.stringify(source)).toString("base64")
    : null;
}

async function loadOwnedContext(db, interactionId, username, { forUpdate = false } = {}) {
  const lock = forUpdate ? "FOR UPDATE OF w" : "";
  const result = await db.query(
    `SELECT w.*, w.id::text AS interaction_id,
            source_queue.name AS source_queue_name,
            source_queue.queue_audio_media_name AS source_queue_audio_media_name,
            s.agent_id, owner.username AS owner_username,
            owner.voice_number AS owner_voice_number,
            r.id AS reservation_id,
            offer.id AS offer_id,
            customer.provider_call_id AS customer_provider_call_id,
            agent.provider_call_id AS agent_provider_call_id
       FROM acd_work_items w
       LEFT JOIN cc_queues source_queue ON source_queue.id = w.queue_id
       LEFT JOIN LATERAL (
         SELECT agent_id FROM acd_segments
          WHERE work_item_id = w.id AND kind = 'agent' AND ended_at IS NULL
          ORDER BY seq DESC LIMIT 1
       ) s ON true
       LEFT JOIN users owner ON owner.id = s.agent_id
       LEFT JOIN LATERAL (
         SELECT id FROM acd_reservations
          WHERE work_item_id = w.id AND state = 'active'
          ORDER BY created_at DESC LIMIT 1
       ) r ON true
       LEFT JOIN LATERAL (
         SELECT id FROM acd_offers
          WHERE work_item_id = w.id AND state = 'accepted'
          ORDER BY generation DESC LIMIT 1
       ) offer ON true
       LEFT JOIN LATERAL (
         SELECT provider_call_id FROM acd_legs
          WHERE work_item_id = w.id AND role = 'customer' AND ended_at IS NULL
          ORDER BY created_at DESC LIMIT 1
       ) customer ON true
       LEFT JOIN LATERAL (
         SELECT provider_call_id FROM acd_legs
          WHERE work_item_id = w.id AND role = 'agent_device' AND ended_at IS NULL
          ORDER BY created_at DESC LIMIT 1
       ) agent ON true
      WHERE w.id::text = $1
      ${lock}`,
    [String(interactionId)],
  );
  const row = result.rows[0];
  if (!row) throw new AcdIntentError("Core ACD interaction not found", 404, "ACD_NOT_FOUND");
  // Authorization comes from the authoritative live Core segment.
  if (!row.owner_username || String(row.owner_username) !== String(username)) {
    throw new AcdIntentError("This interaction belongs to another agent", 403, "ACD_NOT_OWNER");
  }
  if (row.state !== "active") {
    throw new AcdIntentError("Interaction is not active", 409, "ACD_NOT_ACTIVE");
  }
  if (!row.customer_provider_call_id || !row.agent_provider_call_id || !row.agent_id) {
    if (
      row.attributes?.voice_occupancy_kind === "direct_inbound" &&
      !row.customer_provider_call_id &&
      row.agent_provider_call_id
    ) {
      throw new AcdIntentError(
        "Direct credential calls do not expose a controllable customer leg. Route the direct DID through Voice API to enable transfers.",
        409,
        "ACD_TOPOLOGY_INCOMPLETE",
      );
    }
    throw new AcdIntentError(
      "Active Core call topology is incomplete",
      409,
      "ACD_TOPOLOGY_INCOMPLETE",
    );
  }
  return row;
}

async function activeIntent(db, workItemId) {
  const result = await db.query(
    `SELECT id, type, work_item_id, state, step, data, deadline_at, last_error, created_at, terminal_at
       FROM acd_sagas
      WHERE work_item_id = $1 AND conflict_key = 'call-control'
      ORDER BY created_at DESC LIMIT 1`,
    [workItemId],
  );
  return result.rows[0] || null;
}

function publicIntent(row) {
  if (!row) return null;
  const presentationState =
    row.type === "consult" &&
    row.data?.consultState === "failed" &&
    ["running", "compensating"].includes(row.state)
      ? "failed"
      : row.state;
  const browserCall =
    row.type === "consult" && row.step === "await_browser_originator"
      ? {
          destinationNumber: row.data?.target || null,
          callerNumber: row.data?.fromNumber || null,
          customHeaders: [
            {
              name: "X-CC-Work-Item-Id",
              value: String(row.work_item_id || ""),
            },
            { name: "X-CC-Leg-Role", value: "agent_device" },
            { name: "X-CC-Saga-Id", value: String(row.id) },
          ],
        }
      : null;
  return {
    sagaId: row.id,
    intent: row.type,
    state: presentationState,
    step: row.step,
    activeLeg: row.data?.activeLeg || null,
    target: row.data?.target || null,
    targetKind: row.data?.targetKind || null,
    targetLabel: row.data?.targetLabel || null,
    deadlineAt: row.deadline_at || null,
    error: row.last_error || null,
    browserCall,
  };
}

export async function getTransferIntent(pool, { interactionId, username }) {
  const context = await loadOwnedContext(pool, interactionId, username);
  return publicIntent(await activeIntent(pool, context.id));
}

export async function executeTransferIntent(
  pool,
  {
    interactionId,
    username,
    action,
    target = null,
    targetKind = null,
    targetUserId = null,
    targetUsername = null,
    targetLabel = null,
    preserveRoutingOptions = true,
    node = "intent-api",
  },
) {
  if (!START_ACTIONS.has(action) && !CONSULT_EVENTS[action]) {
    throw new AcdIntentError("Unsupported Core ACD intent action");
  }

  if (CONSULT_EVENTS[action]) {
    const context = await loadOwnedContext(pool, interactionId, username);
    const current = await activeIntent(pool, context.id);
    if (!current || current.type !== "consult" || !["running", "compensating"].includes(current.state)) {
      throw new AcdIntentError("No active consult", 409, "ACD_NO_ACTIVE_CONSULT");
    }
    let handoffAddedForComplete = false;
    if (action === "consult_complete") {
      const marked = await pool.query(
        `UPDATE acd_work_items
            SET handoff_saga_id = $2, version = version + 1
          WHERE id = $1
            AND handoff_saga_id IS NULL
        RETURNING id`,
        [context.id, current.id],
      );
      handoffAddedForComplete = marked.rowCount > 0;
    }
    const provider = createTelnyxProvider();
    let applied;
    try {
      applied = await applySagaEvent(pool, {
        workItemId: context.id,
        name: CONSULT_EVENTS[action],
        payload: { actor_username: username },
        provider,
        node,
        actor: `agent:${username}`,
      });
    } catch (error) {
      if (handoffAddedForComplete) {
        await pool.query(
          `UPDATE acd_work_items
              SET handoff_saga_id = NULL, version = version + 1
            WHERE id = $1
              AND handoff_saga_id = $2`,
          [context.id, current.id],
        );
      }
      throw error;
    }
    if (!applied) {
      if (handoffAddedForComplete) {
        await pool.query(
          `UPDATE acd_work_items
              SET handoff_saga_id = NULL, version = version + 1
            WHERE id = $1
              AND handoff_saga_id = $2`,
          [context.id, current.id],
        );
      }
      throw new AcdIntentError(
        `Consult action is not valid while the intent is in '${current.step}'`,
        409,
        "ACD_INTENT_STEP_CONFLICT",
      );
    }
    return publicIntent(await activeIntent(pool, context.id));
  }

  if (!target || !String(target).trim()) {
    throw new AcdIntentError("Transfer target is required");
  }

  const client = await pool.connect();
  let sagaId;
  try {
    await client.query("BEGIN");
    const context = await loadOwnedContext(client, interactionId, username, { forUpdate: true });
    const consultHold = await loadConsultHoldSettings(client);
    const data = {
      workItemId: context.id,
      interactionId: context.interaction_id,
      agentId: context.agent_id,
      agentUsername: context.owner_username,
      reservationId: context.reservation_id,
      offerId: context.offer_id,
      customerProviderCallId: context.customer_provider_call_id,
      agentProviderCallId: context.agent_provider_call_id,
      connectionId: process.env.TELNYX_CALL_CONTROL_ID || null,
      // Inbound work carries its owned DID in cc_address. Manual outbound work
      // carries a WebRTC credential there, which bridge_intent previously
      // replaced implicitly. Once Core owns the bridge, select an explicit
      // E.164 caller id instead of attempting to originate from that username.
      fromNumber: resolveTransferFromNumber(context),
      target: String(target).trim(),
      targetKind: targetKind || "manual",
      targetUserId: targetUserId ? String(targetUserId) : null,
      targetUsername: targetUsername ? String(targetUsername) : null,
      targetLabel: targetLabel ? String(targetLabel).trim() : null,
      clientState: encodedClientState(context, preserveRoutingOptions),
      sourceQueueId: context.queue_id,
      sourceQueueName: context.source_queue_name,
      sourceQueueAudioMediaName: context.source_queue_audio_media_name || null,
      consultHoldMediaName:
        context.source_queue_audio_media_name || consultHold.media_name || null,
      consultHoldAnnouncementEnabled:
        consultHold.announcement_enabled === true,
      consultHoldAnnouncementText: consultHold.announcement_text || null,
      consultHoldAnnouncementVoice: consultHold.announcement_voice || null,
      consultHoldAnnouncementLanguage:
        consultHold.announcement_language || null,
      consultHoldAnnouncementVoiceApiKeyRef:
        consultHold.announcement_voice_api_key_ref || null,
      consultHoldAnnouncementIntervalSeconds:
        consultHold.announcement_interval_seconds,
    };

    let started;
    if (action === "queue_transfer") {
      const queue = await client.query(
        `SELECT id, name FROM cc_queues
          WHERE id = $1 AND enabled = true LIMIT 1`,
        [String(target)],
      );
      const targetQueue = queue.rows[0];
      if (!targetQueue) throw new AcdIntentError("Target queue not found", 404, "ACD_QUEUE_NOT_FOUND");
      started = await startQueueTransferSaga(client, {
        ...data,
        target: targetQueue.id,
        targetQueueId: targetQueue.id,
        targetQueueName: targetQueue.name,
        preserveRoutingOptions,
      });
    } else if (action === "consult_start") {
      if (!data.connectionId) {
        throw new AcdIntentError(
          "TELNYX_CALL_CONTROL_ID is not configured",
          500,
          "ACD_CONNECTION_MISSING",
        );
      }
      if (!data.fromNumber) {
        throw new AcdIntentError(
          "An E.164 caller ID is required for consultation calls",
          500,
          "ACD_CALLER_ID_MISSING",
        );
      }
      started = await startConsultSaga(client, data);
    } else {
      if (!data.fromNumber) {
        throw new AcdIntentError(
          "An E.164 caller ID is required for transfer calls",
          500,
          "ACD_CALLER_ID_MISSING",
        );
      }
      started = await startBlindTransferSaga(client, data);
    }
    sagaId = started.sagaId;

    // startConsultSaga owns its handoff fence because consult can also be
    // started outside this API. Other transfer sagas are fenced here.
    if (action !== "consult_start") {
      await client.query(
        `UPDATE acd_work_items
            SET handoff_saga_id = $2, version = version + 1
          WHERE id = $1`,
        [context.id, sagaId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof SagaConflictError) {
      throw new AcdIntentError(
        "Another transfer or consult is already active",
        409,
        error.code,
      );
    }
    throw error;
  } finally {
    client.release();
  }

  const provider = createTelnyxProvider();
  await driveSaga(pool, sagaId, { provider, node });
  const saga = await pool.query(
    `SELECT id, type, work_item_id, state, step, data, deadline_at, last_error
       FROM acd_sagas WHERE id = $1`,
    [sagaId],
  );
  return publicIntent(saga.rows[0]);
}
