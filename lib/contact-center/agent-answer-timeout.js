/**
 * Agent Answer Timeout Handler
 * Checks for calls in "ringing" state that have exceeded the queue's agent_answer_timeout_secs
 * and handles re-enqueueing, stopping agent phone ringing, and updating agent status
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { enqueueCall, removeCallFromAgent } from "./state-manager.js";
import { releaseByInteraction } from "./reservation-manager.js";
import {
  addTimelineEvent,
  TimelineEventTypes,
} from "./call-timeline-tracker.js";

/**
 * Check and handle timeouts for ringing calls
 * @returns {Promise<Object>} Summary of processed timeouts
 */
export async function checkAndHandleAgentAnswerTimeouts() {
  const pool = getPostgresPool();
  if (!pool) {
    console.error("[AgentAnswerTimeout] Database not available");
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

    console.log(
      `[AgentAnswerTimeout] Found ${timedOutInteractions.length} timed out ringing calls:`,
      timedOutInteractions.map((i) => ({
        id: i.id,
        agent: i.agent_username,
        agentUserId: i.agent_user_id,
        assignedAt: i.assigned_at,
        timeoutSecs: i.agent_answer_timeout_secs,
      })),
    );

    const errors = [];
    let processed = 0;

    for (const interaction of timedOutInteractions) {
      try {
        await handleTimeoutForInteraction(interaction);
        processed++;
      } catch (error) {
        console.error(
          `[AgentAnswerTimeout] Error handling timeout for interaction ${interaction.id}:`,
          error,
        );
        errors.push({
          interactionId: interaction.id,
          error: error.message,
        });
      }
    }

    return { processed, errors };
  } catch (error) {
    console.error("[AgentAnswerTimeout] Error checking timeouts:", error);
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
    return;
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
    console.log(
      `[AgentAnswerTimeout] Interaction ${interaction.id} not found for immediate no-answer handling`,
    );
    return;
  }

  await handleTimeoutForInteraction(hydratedInteraction);
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

  // Double-check that the call hasn't been answered (race condition protection)
  // Re-fetch the interaction to ensure we have the latest state
  const currentInteraction = await pool.query(
    `SELECT state, answered_at FROM cc_interactions WHERE id = $1`,
    [interactionId],
  );

  if (!currentInteraction.rows || currentInteraction.rows.length === 0) {
    console.log(
      `[AgentAnswerTimeout] Interaction ${interactionId} no longer exists, skipping timeout`,
    );
    return;
  }

  const currentState = currentInteraction.rows[0].state;
  const answeredAt = currentInteraction.rows[0].answered_at;

  // If call has been answered or is in a connected/answered state, skip timeout
  // Check for various states that indicate the call was answered
  const answeredStates = ["answered", "connected", "active", "on_call"];
  if (answeredAt || answeredStates.includes(currentState)) {
    console.log(
      `[AgentAnswerTimeout] Interaction ${interactionId} has been answered (answered_at: ${answeredAt}) or is in state "${currentState}", skipping timeout`,
    );
    return;
  }

  // Only proceed if still in ringing state
  if (currentState !== "ringing") {
    console.log(
      `[AgentAnswerTimeout] Interaction ${interactionId} is in state "${currentState}" (not ringing), skipping timeout`,
    );
    return;
  }

  console.log(
    `[AgentAnswerTimeout] Handling timeout for interaction ${interactionId}, agent ${agentUsername}`,
  );

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

  // Use atomic UPDATE with WHERE clause to prevent race conditions
  // Only update if state is still "ringing" and answered_at is still NULL
  // This ensures we don't overwrite an answered call
  const updateResult = await pool.query(
    `UPDATE cc_interactions 
     SET state = 'queued',
         agent_username = NULL,
         assigned_at = NULL,
         routing_metadata = $1,
         metadata = $2
     WHERE id = $3
       AND state = 'ringing'
       AND answered_at IS NULL
     RETURNING id, state, answered_at`,
    [
      JSON.stringify(routingMetadataWithTimeout),
      JSON.stringify({
        ...(interactionMetadata || {}),
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
        console.log(
          `[AgentAnswerTimeout] Interaction ${interactionId} was answered before timeout update (answered_at: ${verifyAnsweredAt}, state: ${verifyState}), aborting timeout`,
        );
        return;
      }

      console.log(
        `[AgentAnswerTimeout] Interaction ${interactionId} state changed to "${verifyState}" before timeout update, aborting timeout`,
      );
      return;
    }

    console.log(
      `[AgentAnswerTimeout] Interaction ${interactionId} not found or already updated, aborting timeout`,
    );
    return;
  }

  // Release the active reservation before the caller is offered again.
  // Without this, the attempted agent can remain at capacity after an
  // immediate WebRTC/browser-leg disconnect.
  try {
    await releaseByInteraction(interactionId, { pool });
  } catch (error) {
    console.error(
      `[AgentAnswerTimeout] Failed to release reservation for interaction ${interactionId}:`,
      error,
    );
    // Continue with re-enqueue even if reservation cleanup fails; the lease
    // will eventually expire and sweepExpiredReservations can correct counts.
  }

  // Small delay to ensure database update is committed before hangup webhook arrives
  await new Promise((resolve) => setTimeout(resolve, 100));

  // 2. Change agent status to "Agent Not Answering"
  if (agentUserId) {
    try {
      console.log(
        `[AgentAnswerTimeout] Setting agent ${agentUserId} (${agentUsername}) status to "Agent Not Answering"`,
      );
      await updateAgentStatus(agentUserId, "Agent Not Answering");
      console.log(
        `[AgentAnswerTimeout] Successfully set agent ${agentUserId} status to "Agent Not Answering"`,
      );
    } catch (error) {
      console.error(
        `[AgentAnswerTimeout] Failed to update agent status for user ${agentUserId}:`,
        error,
      );
      // Continue with re-enqueue even if status update fails
    }
  } else {
    console.warn(
      `[AgentAnswerTimeout] No agent_user_id found for agent ${agentUsername}, cannot update status`,
    );
  }

  // 3. Stop ringing the agent's phone (hangup the agent leg)
  try {
    await hangupAgentLeg(interaction);
  } catch (error) {
    console.error(
      `[AgentAnswerTimeout] Failed to hangup agent leg for interaction ${interactionId}:`,
      error,
    );
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
    console.log(
      `[AgentAnswerTimeout] Successfully called Telnyx enqueue API for call ${callControlId}`,
    );
  } catch (error) {
    console.error(
      `[AgentAnswerTimeout] Failed to re-enqueue call via Telnyx API:`,
      error,
    );
    // Continue even if Telnyx API call fails
    // The webhook handler will update the state when call.enqueued webhook arrives
  }

  // Remove from agent's active calls in state manager
  if (agentUserId && queueId) {
    removeCallFromAgent(queueId, interactionId, agentUserId);
  }

  // Re-add to queue in state manager (will be updated again by webhook handler)
  enqueueCall(queueId, interactionId, new Date(reEnqueuedAt), queueName);

  console.log(
    `[AgentAnswerTimeout] Successfully re-enqueued interaction ${interactionId}`,
  );
}

/**
 * Hangup the agent leg of a call
 * @param {Object} interaction - Interaction record
 */
async function hangupAgentLeg(interaction) {
  const { metadata } = interaction;
  const agentCallControlId =
    metadata?.agent_call_control_id || metadata?.agentCallControlId;

  // Only the WebRTC agent leg may be hung up during no-answer cleanup.
  // The original caller leg must remain alive so it can be requeued.
  if (!agentCallControlId) {
    console.warn(
      `[AgentAnswerTimeout] No agent leg call control ID found for interaction ${interaction.id}; leaving original caller leg alive for requeue`,
    );
    return;
  }

  try {
    await hangupCallLeg(agentCallControlId);
    console.log(
      `[AgentAnswerTimeout] Hung up agent leg ${agentCallControlId}`,
    );
  } catch (error) {
    console.error(
      `[AgentAnswerTimeout] Failed to hangup agent leg ${agentCallControlId}:`,
      error,
    );
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
  const pool = getPostgresPool();
  if (!pool) {
    throw new Error("Database not available");
  }

  // Update user's agent_status
  await pool.query(
    `UPDATE users SET agent_status = $1, updated_at = NOW() WHERE id = $2`,
    [status, userId],
  );

  // Update cc_agent_state if it exists
  // When setting to "Agent Not Answering", preserve available_since to maintain idle time continuity
  // (Don't update available_since column - it will be preserved automatically)
  await pool.query(
    `UPDATE cc_agent_state 
     SET agent_status = $1, last_status_change = NOW(), last_activity = NOW() 
     WHERE user_id = $2`,
    [status, userId],
  );

  // Also update in-memory state cache
  try {
    const { updateAgentStatus: updateStateManagerStatus } =
      await import("./state-manager.js");
    updateStateManagerStatus(userId, status);
  } catch (error) {
    console.error(
      `[AgentAnswerTimeout] Failed to update in-memory state:`,
      error,
    );
    // Continue even if state manager update fails
  }

  // Broadcast status change via SSE
  // Need to broadcast to both userId-based key and username-based key
  try {
    const { broadcastToKey } = await import("@/lib/sse");
    const { PgDb } = await import("@/lib/pgdb");

    // Get username for username-based broadcast
    const user = await PgDb.findUserById(userId);
    const username = user?.username;

    // Broadcast to userId-based key (for status-stream endpoint)
    await broadcastToKey(
      `user:status:${userId}`,
      {
        type: "status_changed",
        status: status,
        userId: userId,
        username: username,
        timestamp: new Date().toISOString(),
      },
      "status_changed",
    );

    // Also broadcast to username-based key (for contact-center agent stream)
    if (username) {
      await broadcastToKey(`contact-center:agent:${username}`, {
        type: "status_changed",
        status: status,
        previousStatus: null, // We don't track previous status here
        userId: userId,
        username: username,
      });
    }

    console.log(
      `[AgentAnswerTimeout] Broadcasted status change to SSE: userId=${userId}, username=${username}, status=${status}`,
    );
  } catch (error) {
    console.error(
      `[AgentAnswerTimeout] Failed to broadcast status change:`,
      error,
    );
    // Don't fail if SSE broadcast fails
  }

  console.log(
    `[AgentAnswerTimeout] Updated agent ${userId} status to ${status}`,
  );
}

/**
 * Reset agent status from "Agent Not Answering" back to "Available"
 * This should be called when:
 * - Agent answers a new call
 * - Agent manually changes their status
 * - After a grace period (e.g., 5 minutes)
 * @param {string} userId - User ID
 */
export async function resetAgentNotAnsweringStatus(userId) {
  const pool = getPostgresPool();
  if (!pool) {
    throw new Error("Database not available");
  }

  // Check current status
  const result = await pool.query(
    `SELECT agent_status FROM users WHERE id = $1`,
    [userId],
  );

  const currentStatus = result.rows?.[0]?.agent_status;

  if (currentStatus === "Agent Not Answering") {
    await updateAgentStatus(userId, "Available");
    console.log(
      `[AgentAnswerTimeout] Reset agent ${userId} status from "Agent Not Answering" to "Available"`,
    );
  }
}
