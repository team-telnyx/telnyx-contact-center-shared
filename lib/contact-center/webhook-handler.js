/**
 * Webhook handler for Telnyx call events
 * Integrates with routing engine to handle incoming calls
 */

import { routeCall } from "./routing-engine";
import {
  enqueueCall,
  assignCallToAgent,
  answerCall,
  completeCall,
} from "./state-manager";
import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { randomUUID } from "crypto";

/**
 * Handle incoming call webhook from Telnyx
 * @param {Object} webhookData - Telnyx webhook payload
 * @returns {Promise<Object>} Response
 */
export async function handleIncomingCall(webhookData) {
  try {
    const {
      data: {
        event_type,
        payload: {
          call_control_id,
          call_session_id,
          from,
          to,
          direction,
          queue_name,
          queue_id,
          metadata = {},
        } = {},
      } = {},
    } = webhookData;

    if (event_type !== "call.initiated" && event_type !== "call.queued") {
      return { handled: false, reason: "not_an_incoming_call_event" };
    }

    // Extract queue information
    const targetQueueId =
      queue_id ||
      metadata.queue_id ||
      (queue_name ? await findQueueByName(queue_name) : null);

    if (!targetQueueId) {
      console.warn("[WebhookHandler] No queue specified for incoming call");
      return { handled: false, reason: "no_queue_specified" };
    }

    // Create interaction record
    const interactionId = randomUUID();
    const enqueuedAt = new Date();

    await PgDb.insertInteraction({
      id: interactionId,
      interactionType: "voice",
      queueName: queue_name,
      queueId: targetQueueId,
      callControlId: call_control_id,
      callSessionId: call_session_id,
      direction: direction || "inbound",
      state: "queued",
      fromNumber: from?.phone_number,
      toNumber: to?.phone_number,
      fromName: from?.display_name,
      toName: to?.display_name,
      requiredSkills: metadata.required_skills || {},
      metadata: {
        ...metadata,
        priority: metadata.priority || 0,
        webhook_event: event_type,
      },
      enqueuedAt,
    });

    // Update state manager
    enqueueCall(targetQueueId, interactionId, enqueuedAt);

    // Attempt to route the call
    const routingResult = await routeCall(targetQueueId, {
      required_skills: metadata.required_skills || {},
      priority: metadata.priority || 0,
      callControlId: call_control_id,
      callSessionId: call_session_id,
    });

    if (routingResult.success && routingResult.agent) {
      // Assign call to agent
      const assignedAt = new Date();

      await PgDb.updateInteraction(interactionId, {
        agentUsername: routingResult.agent.username,
        state: "ringing",
        assignedAt,
      });

      assignCallToAgent(
        targetQueueId,
        interactionId,
        routingResult.agent.id,
        assignedAt
      );

      // Broadcast routing event
      try {
        const { broadcastToKey } = await import("@/lib/sse");
        await broadcastToKey(
          `user:${routingResult.agent.id}`,
          {
            type: "call_routed",
            interactionId,
            queueId: targetQueueId,
            callControlId: call_control_id,
            fromNumber: from?.phone_number,
            toNumber: to?.phone_number,
            routingMetadata: routingResult.routingMetadata,
            timestamp: new Date().toISOString(),
          },
          "call_routed"
        );
      } catch (sseError) {
        console.error("[WebhookHandler] Failed to broadcast:", sseError);
      }

      return {
        handled: true,
        routed: true,
        interactionId,
        agent: routingResult.agent,
      };
    } else {
      // Call is queued
      return {
        handled: true,
        routed: false,
        queued: true,
        interactionId,
        reason: routingResult.reason || "no_available_agents",
      };
    }
  } catch (error) {
    console.error("[WebhookHandler] Error handling incoming call:", error);
    return {
      handled: false,
      error: error.message,
    };
  }
}

/**
 * Handle call answered event
 */
export async function handleCallAnswered(webhookData) {
  try {
    const { data: { payload: { call_control_id, answered_at } = {} } = {} } =
      webhookData;

    if (!call_control_id) {
      return { handled: false, reason: "no_call_control_id" };
    }

    const pool = getPostgresPool();
    if (!pool) {
      return { handled: false, reason: "database_unavailable" };
    }

    // Find interaction by call_control_id
    const result = await pool.query(
      `SELECT id, enqueued_at FROM cc_interactions 
       WHERE call_control_id = $1 
       ORDER BY created_at DESC LIMIT 1`,
      [call_control_id]
    );

    if (!result.rows || result.rows.length === 0) {
      return { handled: false, reason: "interaction_not_found" };
    }

    const interaction = result.rows[0];
    const answeredAt = answered_at || new Date();

    // Update interaction
    await PgDb.updateInteraction(interaction.id, {
      state: "answered",
      answeredAt,
      waitTimeSeconds: interaction.enqueued_at
        ? Math.floor(
            (new Date(answeredAt) - new Date(interaction.enqueued_at)) / 1000
          )
        : 0,
    });

    // Update state manager
    answerCall(interaction.id, answeredAt);

    return {
      handled: true,
      interactionId: interaction.id,
    };
  } catch (error) {
    console.error("[WebhookHandler] Error handling call answered:", error);
    return {
      handled: false,
      error: error.message,
    };
  }
}

/**
 * Handle call completed/ended event
 */
export async function handleCallEnded(webhookData) {
  try {
    const {
      data: { payload: { call_control_id, ended_at, hangup_cause } = {} } = {},
    } = webhookData;

    if (!call_control_id) {
      return { handled: false, reason: "no_call_control_id" };
    }

    const pool = getPostgresPool();
    if (!pool) {
      return { handled: false, reason: "database_unavailable" };
    }

    // Find interaction
    const result = await pool.query(
      `SELECT id, answered_at, enqueued_at FROM cc_interactions 
       WHERE call_control_id = $1 
       ORDER BY created_at DESC LIMIT 1`,
      [call_control_id]
    );

    if (!result.rows || result.rows.length === 0) {
      return { handled: false, reason: "interaction_not_found" };
    }

    const interaction = result.rows[0];
    const completedAt = ended_at || new Date();
    const wasAbandoned =
      !interaction.answered_at ||
      hangup_cause === "CALL_REJECTED" ||
      hangup_cause === "NO_ANSWER";

    // Calculate times
    const waitTimeSeconds = interaction.enqueued_at
      ? Math.floor(
          (new Date(interaction.answered_at || completedAt) -
            new Date(interaction.enqueued_at)) /
            1000
        )
      : 0;

    const talkTimeSeconds =
      interaction.answered_at && !wasAbandoned
        ? Math.floor(
            (new Date(completedAt) - new Date(interaction.answered_at)) / 1000
          )
        : 0;

    const handleTimeSeconds = waitTimeSeconds + talkTimeSeconds;

    // Update interaction
    await PgDb.updateInteraction(interaction.id, {
      state: wasAbandoned ? "abandoned" : "completed",
      completedAt: wasAbandoned ? null : completedAt,
      abandonedAt: wasAbandoned ? completedAt : null,
      waitTimeSeconds,
      talkTimeSeconds,
      handleTimeSeconds,
    });

    // Update state manager
    completeCall(interaction.id, completedAt, wasAbandoned);

    return {
      handled: true,
      interactionId: interaction.id,
      wasAbandoned,
    };
  } catch (error) {
    console.error("[WebhookHandler] Error handling call ended:", error);
    return {
      handled: false,
      error: error.message,
    };
  }
}

/**
 * Find queue by name
 */
async function findQueueByName(queueName) {
  try {
    const pool = getPostgresPool();
    if (!pool) return null;

    const result = await pool.query(
      `SELECT id FROM cc_queues WHERE name = $1 AND enabled = true LIMIT 1`,
      [queueName]
    );

    return result.rows?.[0]?.id || null;
  } catch (error) {
    console.error("[WebhookHandler] Error finding queue:", error);
    return null;
  }
}
