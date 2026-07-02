/**
 * Agent Answer Timeout Handler
 * Checks for calls in "ringing" state that have exceeded the queue's agent_answer_timeout_secs
 * and handles re-enqueueing, stopping agent phone ringing, and updating agent status
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { broadcastToKey } from "@/lib/sse";
import { enqueueCall, removeCallFromAgent } from "./state-manager.js";
import { releaseByInteraction } from "./reservation-manager.js";
import {
  agentPayload,
  callPayload,
  contactCenterErrorPayload,
  queuePayload,
  reasonPayload,
  timeoutLogger,
} from "./logging.mjs";
import {
  addTimelineEvent,
  TimelineEventTypes,
} from "./call-timeline-tracker.js";

async function broadcastAgentCallsChanged({
  interactionId,
  queueId,
  previousAgentUserId,
  previousAgentUsername,
  reason,
}) {
  if (!previousAgentUserId) return;

  try {
    const pool = getPostgresPool();
    if (!pool) return;

    const supervisors = await pool.query(
      `SELECT id FROM users WHERE 'supervisor' = ANY(roles) OR 'admin' = ANY(roles) OR 'owner' = ANY(roles)`,
    );
    const payload = {
      type: "interaction_updated",
      action: "agent_calls_changed",
      reason,
      interactionId: String(interactionId),
      queueId: queueId ? String(queueId) : null,
      previousAgentUserId: String(previousAgentUserId),
      previousAgentUsername: previousAgentUsername || null,
      timestamp: new Date().toISOString(),
    };

    await Promise.all(
      (supervisors.rows || []).map((supervisor) =>
        broadcastToKey(`monitor:${supervisor.id}`, payload, "interaction_updated"),
      ),
    );
  } catch (error) {
    timeoutLogger.error("agent_call_removal_broadcast_failed", {
      ...callPayload({ interactionId }),
      ...queuePayload({ queueId }),
      previousAgentUserId: previousAgentUserId ? String(previousAgentUserId) : undefined,
      previousAgentUsername,
      reason,
      ...contactCenterErrorPayload(error),
    });
  }
}

/**
 * Check and handle timeouts for ringing calls
 * @returns {Promise<Object>} Summary of processed timeouts
 */
export async function checkAndHandleAgentAnswerTimeouts() {
  const pool = getPostgresPool();
  if (!pool) {
    timeoutLogger.error("database_not_available", reasonPayload("agent_answer_timeout_check"));
    return { processed: 0, errors: [] };
  }

  try {
    // Find all interactions in "ringing" state with assigned_at timestamp
    // that have exceeded the queue's agent_answer_timeout_secs
    // IMPORTANT: Exclude calls that have been answered (answered_at IS NOT NULL) OR are in answered/connected states
    // This ensures we stop checking timeout once the call is answered
    const query = `
      SELECT 
        i.id,
        i.call_control_id,
        i.call_session_id,
        i.queue_id,
        i.queue_name,
        i.agent_username,
        i.assigned_at,
        i.priority,
        i.routing_metadata,
        i.metadata,
        q.agent_answer_timeout_secs,
        u.id as agent_user_id
      FROM cc_interactions i
      JOIN cc_queues q ON i.queue_id = q.id
      LEFT JOIN users u ON i.agent_username = u.username
      WHERE i.state = 'ringing'
        AND i.assigned_at IS NOT NULL
        AND i.agent_username IS NOT NULL
        AND i.answered_at IS NULL
        AND q.agent_answer_timeout_secs IS NOT NULL
        AND q.agent_answer_timeout_secs > 0
        AND (EXTRACT(EPOCH FROM (NOW() - i.assigned_at))::INTEGER) >= q.agent_answer_timeout_secs
        -- Only exclude timeout_re_enqueued if it's still set (call hasn't been re-assigned)
        -- If call was re-assigned, the flag should be cleared, so we can check timeout again
        AND COALESCE(i.metadata->>'timeout_re_enqueued', '') != 'true'
    `;

    const result = await pool.query(query);
    const timedOutInteractions = result.rows || [];

    if (timedOutInteractions.length === 0) {
      return { processed: 0, errors: [] };
    }

    timeoutLogger.info("timed_out_ringing_calls_found", { count: timedOutInteractions.length });

    const errors = [];
    let processed = 0;

    for (const interaction of timedOutInteractions) {
      try {
        await handleTimeoutForInteraction(interaction);
        processed++;
      } catch (error) {
        timeoutLogger.error("timeout_interaction_handling_failed", {
          ...callPayload({
            interactionId: interaction.id,
            callControlId: interaction.call_control_id,
            callSessionId: interaction.call_session_id,
          }),
          ...queuePayload({ queueId: interaction.queue_id, queueName: interaction.queue_name }),
          ...agentPayload({ agentUserId: interaction.agent_user_id, agentUsername: interaction.agent_username }),
          ...contactCenterErrorPayload(error),
        });
        errors.push({
          interactionId: interaction.id,
          error: error.message,
        });
      }
    }

    return { processed, errors };
  } catch (error) {
    timeoutLogger.error("timeout_check_failed", contactCenterErrorPayload(error));
    return { processed: 0, errors: [error.message] };
  }
}

/**
 * Handle an agent leg disconnecting before the agent answered.
 *
 * Telnyx can emit a call.hangup for the WebRTC/agent leg before the queue's
 * configured answer timeout expires (for example when the browser device is
 * unavailable or rejects the leg). That must be treated like an immediate
 * no-answer: keep the caller leg alive, release the reservation, mark the
 * attempted agent as not answering, and re-enqueue the original caller leg.
 *
 * @param {Object} interaction - Current interaction record from webhook lookup.
 */
export async function handleAgentLegNoAnswerDisconnect(interaction) {
  if (!interaction?.id) {
    return false;
  }

  const pool = getPostgresPool();
  if (!pool) {
    throw new Error("Database not available");
  }

  const result = await pool.query(
    `SELECT
       i.id,
       i.call_control_id,
       i.call_session_id,
       i.queue_id,
       i.queue_name,
       i.agent_username,
       i.assigned_at,
       i.priority,
       i.routing_metadata,
       i.metadata,
       q.agent_answer_timeout_secs,
       u.id as agent_user_id
     FROM cc_interactions i
     JOIN cc_queues q ON i.queue_id = q.id
     LEFT JOIN users u ON i.agent_username = u.username
     WHERE i.id = $1`,
    [interaction.id],
  );

  const hydratedInteraction = result.rows?.[0];
  if (!hydratedInteraction) {
    timeoutLogger.debug("interaction_not_found_for_immediate_no_answer", callPayload({ interactionId: interaction.id }));
    return false;
  }

  return handleTimeoutForInteraction(hydratedInteraction);
}

/**
 * Handle timeout for a specific interaction
 * @param {Object} interaction - Interaction record with timeout details
 */
async function handleTimeoutForInteraction(interaction) {
  const pool = getPostgresPool();
  if (!pool) {
    throw new Error("Database not available");
  }

  const {
    id: interactionId,
    call_control_id: callControlId,
    call_session_id: callSessionId,
    queue_id: queueId,
    queue_name: queueName,
    agent_username: agentUsername,
    agent_user_id: agentUserId,
    assigned_at: assignedAt,
    priority: interactionPriority,
    routing_metadata: routingMetadata,
    metadata: interactionMetadata,
  } = interaction;
  const timeoutContext = {
    ...callPayload({ interactionId, callControlId, callSessionId }),
    ...queuePayload({ queueId, queueName }),
    ...agentPayload({ agentUserId, agentUsername }),
  };

  // Double-check that the call hasn't been answered (race condition protection)
  // Re-fetch the interaction to ensure we have the latest state
  const currentInteraction = await pool.query(
    `SELECT state, answered_at FROM cc_interactions WHERE id = $1`,
    [interactionId],
  );

  if (!currentInteraction.rows || currentInteraction.rows.length === 0) {
    timeoutLogger.debug("interaction_no_longer_exists_skipping_timeout", timeoutContext);
    return false;
  }

  const currentState = currentInteraction.rows[0].state;
  const answeredAt = currentInteraction.rows[0].answered_at;

  // If call has been answered or is in a connected/answered state, skip timeout
  // Check for various states that indicate the call was answered
  const answeredStates = ["answered", "connected", "active", "on_call"];
  if (answeredAt || answeredStates.includes(currentState)) {
    timeoutLogger.debug("interaction_already_answered_skipping_timeout", {
      ...timeoutContext,
      currentState,
      answeredAt,
    });
    return false;
  }

  // Proceed for ringing or already-requeued pre-answer rows. Telnyx/webhook
  // ordering can move the caller back to queued before the timeout/no-answer
  // cleanup runs; we must still release the attempted agent's reservation and
  // clear stale agent-leg metadata so capacity is not poisoned at 1/1.
  if (!["ringing", "queued"].includes(currentState)) {
    timeoutLogger.debug("interaction_state_not_timeout_eligible", {
      ...timeoutContext,
      currentState,
    });
    return false;
  }

  timeoutLogger.info("agent_answer_timeout_handling_started", {
    ...timeoutContext,
    assignedAt,
    timeoutSeconds: interaction.agent_answer_timeout_secs,
  });

  const reEnqueuedAt = new Date().toISOString();
  const routingMetadataWithTimeout = addTimelineEvent(
    routingMetadata || {},
    TimelineEventTypes.AGENT_TIMEOUT,
    {
      timestamp: reEnqueuedAt,
      agentUsername: agentUsername,
      agentId: agentUserId,
      timeoutSeconds: interaction.agent_answer_timeout_secs,
      originalAssignedAt: assignedAt,
    },
  );

  const sanitizedMetadata = { ...(interactionMetadata || {}) };
  delete sanitizedMetadata.agent_call_control_id;
  delete sanitizedMetadata.agentCallControlId;
  delete sanitizedMetadata.reservationId;
  delete sanitizedMetadata.reservation_id;

  // Use atomic UPDATE with WHERE clause to prevent race conditions.
  // Accept both ringing and already-requeued queued rows: the latter happens
  // when webhook ordering requeues the caller before timeout cleanup runs.
  const updateResult = await pool.query(
    `UPDATE cc_interactions 
     SET state = 'queued',
         agent_username = NULL,
         assigned_at = NULL,
         routing_metadata = $1,
         metadata = $2,
         updated_at = NOW()
     WHERE id = $3
       AND state IN ('ringing', 'queued')
       AND answered_at IS NULL
       AND completed_at IS NULL
       AND abandoned_at IS NULL
     RETURNING id, state, answered_at`,
    [
      JSON.stringify(routingMetadataWithTimeout),
      JSON.stringify({
        ...sanitizedMetadata,
        timeout_re_enqueued: true,
        timeout_re_enqueued_at: reEnqueuedAt,
        previous_agent: agentUsername,
      }),
      interactionId,
    ],
  );

  // If no rows were updated, the call was answered or state changed
  if (!updateResult.rows || updateResult.rows.length === 0) {
    // Double-check what happened
    const verifyCheck = await pool.query(
      `SELECT state, answered_at FROM cc_interactions WHERE id = $1`,
      [interactionId],
    );

    if (verifyCheck.rows && verifyCheck.rows.length > 0) {
      const verifyState = verifyCheck.rows[0].state;
      const verifyAnsweredAt = verifyCheck.rows[0].answered_at;
      const answeredStates = ["answered", "connected", "active", "on_call"];

      if (verifyAnsweredAt || answeredStates.includes(verifyState)) {
        timeoutLogger.debug("interaction_answered_before_timeout_update", {
          ...timeoutContext,
          verifyState,
          verifyAnsweredAt,
        });
        return false;
      }

      timeoutLogger.debug("interaction_state_changed_before_timeout_update", {
        ...timeoutContext,
        verifyState,
      });
      return false;
    }

    timeoutLogger.debug("interaction_missing_or_already_updated_before_timeout", timeoutContext);
    return false;
  }

  // Release the active reservation before the caller is offered again.
  // Without this, the attempted agent can remain at capacity after an
  // immediate WebRTC/browser-leg disconnect.
  try {
    await releaseByInteraction(interactionId, { pool });
  } catch (error) {
    timeoutLogger.error("reservation_release_for_timeout_failed", {
      ...timeoutContext,
      ...contactCenterErrorPayload(error),
    });
    // Continue with re-enqueue even if reservation cleanup fails; the lease
    // will eventually expire and sweepExpiredReservations can correct counts.
  }

  // Small delay to ensure database update is committed before hangup webhook arrives
  await new Promise((resolve) => setTimeout(resolve, 100));

  // 2. Change agent status to "Agent Not Answering"
  if (agentUserId) {
    try {
      timeoutLogger.debug("agent_status_update_for_timeout_started", {
        ...timeoutContext,
        nextStatus: "Agent Not Answering",
      });
      await updateAgentStatus(agentUserId, "Agent Not Answering");
      timeoutLogger.info("agent_status_update_for_timeout_completed", {
        ...timeoutContext,
        nextStatus: "Agent Not Answering",
      });
    } catch (error) {
      timeoutLogger.error("agent_status_update_for_timeout_failed", {
        ...timeoutContext,
        nextStatus: "Agent Not Answering",
        ...contactCenterErrorPayload(error),
      });
      // Continue with re-enqueue even if status update fails
    }
  } else {
    timeoutLogger.warn("agent_user_id_missing_for_timeout_status_update", timeoutContext);
  }

  // 3. Stop ringing the agent's phone (hangup the agent leg)
  try {
    await hangupAgentLeg(interaction);
  } catch (error) {
    timeoutLogger.error("agent_leg_hangup_for_timeout_failed", {
      ...timeoutContext,
      ...contactCenterErrorPayload(error),
    });
    // Continue with re-enqueue even if hangup fails
  }

  // 4. Re-enqueue the call using Telnyx API
  // Get queue name (don't pass max_size or max_wait_time_secs as they can't be modified for existing queues)
  const queueResult = await pool.query(
    `SELECT name FROM cc_queues WHERE id = $1`,
    [queueId],
  );
  const queue = queueResult.rows?.[0];

  if (!queue) {
    throw new Error(`Queue ${queueId} not found`);
  }

  // Get original call priority and required skills from routing_metadata (client_state) or interaction priority
  // Priority should be in routing_metadata.call_priority (from client_state), fallback to interaction.priority
  const originalPriority =
    routingMetadata?.call_priority || interactionPriority || null;
  const originalRequiredSkills = routingMetadata?.required_skills || null;

  // Build client_state with routing parameters if they exist
  let clientState = null;
  if (originalPriority || originalRequiredSkills) {
    const clientStateObj = {};
    if (originalPriority) {
      clientStateObj.call_priority = originalPriority;
    }
    if (originalRequiredSkills) {
      clientStateObj.required_skills = originalRequiredSkills;
    }
    clientState = Buffer.from(JSON.stringify(clientStateObj)).toString(
      "base64",
    );
  }

  // Call Telnyx enqueue API on the original call control ID
  // Note: Don't pass max_size or max_wait_time_secs as Telnyx doesn't allow modifying these for existing queues
  try {
    await reEnqueueCallViaTelnyx(
      callControlId,
      queue.name || queueName,
      clientState,
    );
    timeoutLogger.info("telnyx_enqueue_for_timeout_requeue_completed", {
      ...timeoutContext,
      priority: originalPriority,
      requiredSkillCount: originalRequiredSkills ? Object.keys(originalRequiredSkills).length : undefined,
    });
  } catch (error) {
    timeoutLogger.error("telnyx_enqueue_for_timeout_requeue_failed", {
      ...timeoutContext,
      ...contactCenterErrorPayload(error),
    });
    // Continue even if Telnyx API call fails
    // The webhook handler will update the state when call.enqueued webhook arrives
  }

  // Remove from agent's active calls in state manager
  if (agentUserId && queueId) {
    removeCallFromAgent(queueId, interactionId, agentUserId);
  }

  await broadcastAgentCallsChanged({
    interactionId,
    queueId,
    previousAgentUserId: agentUserId,
    previousAgentUsername: agentUsername,
    reason: "agent_answer_timeout",
  });

  // Re-add to queue in state manager (will be updated again by webhook handler)
  enqueueCall(queueId, interactionId, new Date(reEnqueuedAt), queueName);

  timeoutLogger.info("agent_answer_timeout_reenqueue_completed", timeoutContext);
  return true;
}

/**
 * Hangup the agent leg of a call
 * @param {Object} interaction - Interaction record
 */
async function hangupAgentLeg(interaction) {
  const { metadata } = interaction;
  const context = {
    ...callPayload({
      interactionId: interaction.id,
      callControlId: interaction.call_control_id,
      callSessionId: interaction.call_session_id,
    }),
    ...queuePayload({ queueId: interaction.queue_id, queueName: interaction.queue_name }),
    ...agentPayload({ agentUserId: interaction.agent_user_id, agentUsername: interaction.agent_username }),
  };
  const agentCallControlId =
    metadata?.agent_call_control_id || metadata?.agentCallControlId;

  // Only the WebRTC agent leg may be hung up during no-answer cleanup.
  // The original caller leg must remain alive so it can be requeued.
  if (!agentCallControlId) {
    timeoutLogger.warn("agent_leg_call_control_id_missing_for_timeout_hangup", context);
    return;
  }

  try {
    await hangupCallLeg(agentCallControlId);
    timeoutLogger.debug("agent_leg_hangup_completed", context);
  } catch (error) {
    timeoutLogger.error("agent_leg_hangup_failed", {
      ...context,
      ...contactCenterErrorPayload(error),
    });
  }
}

/**
 * Hangup a call leg using Telnyx API
 * @param {string} callControlId - Call control ID to hangup
 */
async function hangupCallLeg(callControlId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY not configured");
  }

  const url = buildTelnyxV2Url(
    `/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to hangup call: ${errorText}`);
  }

  return await response.json();
}

/**
 * Re-enqueue a call using Telnyx API
 * @param {string} callControlId - Original call control ID (caller's leg)
 * @param {string} queueName - Queue name to enqueue to
 * @param {string|null} clientState - Base64 encoded client state with routing params
 * Note: max_size and max_wait_time_secs are not included as Telnyx doesn't allow
 * modifying these parameters for existing queues (they are queue-level configuration)
 */
async function reEnqueueCallViaTelnyx(
  callControlId,
  queueName,
  clientState = null,
) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY not configured");
  }

  const url = buildTelnyxV2Url(
    `/calls/${encodeURIComponent(callControlId)}/actions/enqueue`,
  );

  const body = {
    queue_name: queueName,
  };

  if (clientState) {
    body.client_state = clientState;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to re-enqueue call: ${errorText}`);
  }

  return await response.json();
}

/**
 * Update agent status
 * @param {string} userId - User ID
 * @param {string} status - New status
 */
async function updateAgentStatus(userId, status) {
  const { handleAgentCallLifecycleStatus } = await import(
    "@/lib/contact-center/agent-call-lifecycle-status"
  );
  const event = status === "Agent Not Answering" ? "no-answer" : null;
  if (!event) {
    return { changed: false, reason: "unsupported_timeout_status", status };
  }

  await handleAgentCallLifecycleStatus({
    event,
    userId: String(userId),
  });

  timeoutLogger.debug("timeout_agent_status_updated", {
    ...agentPayload({ agentUserId: userId }),
    status,
  });
}

/**
 * Legacy compatibility no-op.
 * Agent Not Answering is no longer reset by call.answered/timeouts. The agent
 * must either change status manually from the dropdown or be moved by the
 * central call lifecycle handler for a new explicit lifecycle transition.
 * @param {string} userId - User ID
 */
export async function resetAgentNotAnsweringStatus(userId) {
  timeoutLogger.debug("legacy_agent_not_answering_reset_ignored", {
    ...agentPayload({ agentUserId: userId }),
    reason: "legacy_reset_disabled",
  });
  return { changed: false, reason: "legacy_reset_disabled" };
}
