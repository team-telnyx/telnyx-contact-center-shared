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
  getInteractionState,
  getRealtimeQueueMetrics,
} from "./state-manager";
import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { randomUUID } from "crypto";
import { addTimelineEvent, TimelineEventTypes } from "./call-timeline-tracker";
import { analyzeTranscription } from "@/lib/agent-assist/sentiment-analysis";
import { buildTelnyxV2Url } from "@/lib/telnyx";

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
    enqueueCall(targetQueueId, interactionId, enqueuedAt, queue_name);

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

      // Get current interaction to clear timeout flag if present
      const currentInteraction = await PgDb.findInteractionById(interactionId);
      const currentMetadata = currentInteraction?.metadata || {};
      const updatedMetadata = { ...currentMetadata };
      if (updatedMetadata.timeout_re_enqueued) {
        delete updatedMetadata.timeout_re_enqueued;
        delete updatedMetadata.timeout_re_enqueued_at;
        delete updatedMetadata.previous_agent;
      }

      await PgDb.updateInteraction(interactionId, {
        agentUsername: routingResult.agent.username,
        state: "ringing",
        assignedAt,
        metadata: updatedMetadata,
      });

      assignCallToAgent(
        targetQueueId,
        interactionId,
        routingResult.agent.id,
        assignedAt,
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
          "call_routed",
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
      `SELECT id, enqueued_at, assigned_at, routing_metadata, agent_username FROM cc_interactions 
       WHERE call_control_id = $1 
       ORDER BY created_at DESC LIMIT 1`,
      [call_control_id],
    );

    if (!result.rows || result.rows.length === 0) {
      return { handled: false, reason: "interaction_not_found" };
    }

    const interaction = result.rows[0];
    const safeParse = (value) => {
      if (!value) return null;
      if (typeof value === "object") return value;
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    };
    const answeredAt = answered_at || new Date();

    const waitTimeSeconds = interaction.enqueued_at
      ? Math.floor(
          (new Date(answeredAt) - new Date(interaction.enqueued_at)) / 1000,
        )
      : 0;

    let updatedRoutingMetadata = safeParse(interaction.routing_metadata) || {};
    const existingTimeline = updatedRoutingMetadata.timeline || [];
    if (interaction.assigned_at) {
      const alertingSeconds = Math.max(
        0,
        Math.floor(
          (new Date(answeredAt) - new Date(interaction.assigned_at)) / 1000,
        ),
      );
      const hasAlerting = existingTimeline.some(
        (event) => event.type === "alerting",
      );
      if (!hasAlerting) {
        updatedRoutingMetadata = addTimelineEvent(
          updatedRoutingMetadata,
          "alerting",
          {
            timestamp: interaction.assigned_at,
            alertingDurationSeconds: alertingSeconds,
          },
        );
      }
    }
    const updatedTimeline = updatedRoutingMetadata.timeline || [];
    const hasAnswered = updatedTimeline.some(
      (event) => event.type === TimelineEventTypes.ANSWERED,
    );
    if (!hasAnswered) {
      updatedRoutingMetadata = addTimelineEvent(
        updatedRoutingMetadata,
        TimelineEventTypes.ANSWERED,
        {
          timestamp: new Date(answeredAt).toISOString(),
        },
      );
    }

    // Record SLA metric
    try {
      const { recordCallSLA } = await import("./sla-tracker.js");
      const interactionResult = await pool.query(
        `SELECT queue_id FROM cc_interactions WHERE id = $1`,
        [interaction.id],
      );
      if (interactionResult.rows[0]?.queue_id) {
        await recordCallSLA(
          interaction.id,
          interactionResult.rows[0].queue_id,
          waitTimeSeconds,
          true, // answered
        );
      }
    } catch (slaError) {
      // Don't fail the answer if SLA recording fails
      console.error("[WebhookHandler] Error recording SLA:", slaError);
    }

    // Update interaction
    await PgDb.updateInteraction(interaction.id, {
      state: "answered",
      answeredAt,
      waitTimeSeconds,
      routingMetadata: updatedRoutingMetadata,
    });

    // Update state manager
    answerCall(interaction.id, answeredAt);

    // Reset "Agent Not Answering" status if agent was in that status
    if (interaction.agent_username) {
      try {
        const { resetAgentNotAnsweringStatus } =
          await import("./agent-answer-timeout.js");
        const agentUser = await PgDb.findUserByUsername(
          interaction.agent_username,
        );
        if (agentUser?.id) {
          await resetAgentNotAnsweringStatus(agentUser.id);
        }
      } catch (error) {
        console.error(
          "[WebhookHandler] Failed to reset agent not answering status:",
          error,
        );
        // Don't fail the answer if status reset fails
      }
    }

    // Broadcast to monitor streams so supervisors see the update immediately
    try {
      const { broadcastToKey } = await import("@/lib/sse");
      const { getPostgresPool } = await import("@/lib/postgres.mjs");
      const pool = getPostgresPool();
      if (pool) {
        const supervisors = await pool.query(
          `SELECT id FROM users WHERE 'supervisor' = ANY(roles) OR 'admin' = ANY(roles) OR 'owner' = ANY(roles)`,
        );
        for (const supervisor of supervisors.rows || []) {
          await broadcastToKey(
            `monitor:${supervisor.id}`,
            {
              type: "interaction_updated",
              interactionId: interaction.id,
              queueId: interaction.queue_id,
              updates: {
                state: "answered",
                answeredAt,
                waitTimeSeconds,
              },
            },
            "interaction_updated",
          );
        }
      }
    } catch (monitorError) {
      // Don't fail the answer if monitor broadcast fails
      console.error(
        "[WebhookHandler] Failed to broadcast to monitors:",
        monitorError,
      );
    }

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
      [call_control_id],
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
            1000,
        )
      : 0;

    const talkTimeSeconds =
      interaction.answered_at && !wasAbandoned
        ? Math.floor(
            (new Date(completedAt) - new Date(interaction.answered_at)) / 1000,
          )
        : 0;

    const handleTimeSeconds = waitTimeSeconds + talkTimeSeconds;

    // Record SLA metric
    try {
      const { recordCallSLA } = await import("./sla-tracker.js");
      const interactionResult = await pool.query(
        `SELECT queue_id FROM cc_interactions WHERE id = $1`,
        [interaction.id],
      );
      if (interactionResult.rows[0]?.queue_id) {
        // For abandoned calls, use wait time; for completed calls, use wait time before answer
        const slaWaitTime = wasAbandoned
          ? waitTimeSeconds
          : interaction.answered_at
            ? Math.floor(
                (new Date(interaction.answered_at) -
                  new Date(interaction.enqueued_at)) /
                  1000,
              )
            : waitTimeSeconds;
        await recordCallSLA(
          interaction.id,
          interactionResult.rows[0].queue_id,
          slaWaitTime,
          !wasAbandoned, // answered = true if not abandoned
        );
      }
    } catch (slaError) {
      // Don't fail the completion if SLA recording fails
      console.error("[WebhookHandler] Error recording SLA:", slaError);
    }

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
 * Handle call.enqueued webhook for contact center
 * @param {Object} params - Webhook parameters
 */
export async function handleContactCenterEnqueue(params) {
  const {
    callControlId,
    callSessionId,
    callLegId,
    queueName,
    currentPosition,
    queueAvgWaitTimeSecs,
    clientState,
    flowId,
    flowOwnerUsername,
    fromNumber,
    toNumber,
    direction,
  } = params;

  // Parse client_state for routing metadata
  let routingMetadata = {};
  if (clientState) {
    try {
      const decoded = JSON.parse(Buffer.from(clientState, "base64").toString());
      routingMetadata = decoded;
    } catch (err) {
      console.error(
        `[WebhookHandler] handleContactCenterEnqueue - Failed to parse client_state:`,
        err,
      );
      // Failed to parse client_state
    }
  }

  // Find queue (queues must be created in Admin - Queues screen, never auto-created)
  const { getOrCreateQueue, resolveQueueName } =
    await import("./queue-utils.js");
  const resolved = resolveQueueName(queueName, flowOwnerUsername);
  const queue = await getOrCreateQueue(queueName, resolved.owner);

  if (!queue) {
    return;
  }

  // Find existing interaction created from call.initiated
  let existingInteraction =
    await PgDb.findInteractionByCallControlId(callControlId);

  // If not found by call_control_id, try by call_session_id
  if (!existingInteraction && callSessionId) {
    existingInteraction =
      await PgDb.findInteractionByCallSessionId(callSessionId);
  }

  let interactionId;

  const enqueuedAt = new Date().toISOString();

  // Use current queue stats for avg wait time instead of payload value
  const realtimeQueueMetrics = getRealtimeQueueMetrics(queue.id);
  const computedQueueAvgWaitTimeSecs = Math.round(
    Number(realtimeQueueMetrics?.avgWaitSeconds || 0),
  );
  const effectiveQueueAvgWaitTimeSecs =
    Number.isFinite(computedQueueAvgWaitTimeSecs) &&
    computedQueueAvgWaitTimeSecs >= 0
      ? computedQueueAvgWaitTimeSecs
      : Number(queueAvgWaitTimeSecs) || 0;

  // Add timeline event for enqueued
  const updatedRoutingMetadata = addTimelineEvent(
    existingInteraction?.routing_metadata || routingMetadata,
    TimelineEventTypes.ENQUEUED,
    {
      queueName: queue.name,
      queueId: queue.id,
      currentPosition,
      queueAvgWaitTimeSecs: effectiveQueueAvgWaitTimeSecs,
    },
  );

  // Determine effective fromNumber: use params, or fall back to existing interaction's from_number
  // Also check routing_metadata.timeline for original caller number if current fromNumber is a SIP endpoint
  let effectiveFromNumber = fromNumber || existingInteraction?.from_number;

  // If effectiveFromNumber is a SIP endpoint or missing, try to extract from timeline
  const isSipEndpoint =
    effectiveFromNumber &&
    (effectiveFromNumber.includes("@sip.") ||
      effectiveFromNumber.startsWith("sip:") ||
      effectiveFromNumber.includes("username@"));

  if (
    (isSipEndpoint || !effectiveFromNumber) &&
    existingInteraction?.routing_metadata?.timeline
  ) {
    const initiatedEvent = existingInteraction.routing_metadata.timeline.find(
      (e) => e.type === "initiated" && e.from,
    );
    if (initiatedEvent?.from && initiatedEvent.from.trim() !== "") {
      effectiveFromNumber = initiatedEvent.from;
    }
  }

  // Also check routingMetadata (from client_state) if still missing
  if (!effectiveFromNumber && routingMetadata?.timeline) {
    const initiatedEvent = routingMetadata.timeline.find(
      (e) => e.type === "initiated" && e.from,
    );
    if (initiatedEvent?.from && initiatedEvent.from.trim() !== "") {
      effectiveFromNumber = initiatedEvent.from;
    }
  }

  // Get call priority from routingMetadata or queue default (1-5 star scale)
  const callPriority =
    routingMetadata.call_priority || queue.default_call_priority || 3; // Default to 3 (Normal)

  if (existingInteraction) {
    // Update existing interaction with queue information
    const updateData = {
      queueName,
      queueId: queue.id,
      state: "queued",
      isContactCenter: true,
      requiredSkills: routingMetadata.required_skills || null,
      routingMetadata: updatedRoutingMetadata,
      enqueuedAt,
      priority: callPriority, // Set call priority (1-5 stars)
      metadata: {
        ...(existingInteraction.metadata || {}),
        current_position: currentPosition,
        queue_avg_wait_time_secs: effectiveQueueAvgWaitTimeSecs,
        // Add agent assist config from call flow node if present
        ...(routingMetadata.agent_assist_config ? { agent_assist_config: routingMetadata.agent_assist_config } : {}),
      },
    };

    // Update fromNumber if provided and different
    if (
      effectiveFromNumber &&
      effectiveFromNumber !== existingInteraction.from_number
    ) {
      updateData.fromNumber = effectiveFromNumber;
    }

    await PgDb.updateInteractionById(existingInteraction.id, updateData);
    interactionId = existingInteraction.id;
  } else {
    // Create new interaction record if not found
    interactionId = await PgDb.insertInteraction({
      interactionType: "voice",
      queueName,
      queueId: queue.id,
      callControlId,
      callSessionId,
      callLegId,
      direction: direction || "inbound",
      state: "queued",
      isContactCenter: true,
      fromNumber: effectiveFromNumber, // Use effectiveFromNumber (might be from params or null)
      toNumber,
      requiredSkills: routingMetadata.required_skills || null,
      routingMetadata: updatedRoutingMetadata,
      flowId,
      enqueuedAt,
      priority: callPriority, // Set call priority (1-5 stars)
      metadata: {
        current_position: currentPosition,
        queue_avg_wait_time_secs: effectiveQueueAvgWaitTimeSecs,
        // Add agent assist config from call flow node if present
        ...(routingMetadata.agent_assist_config ? { agent_assist_config: routingMetadata.agent_assist_config } : {}),
      },
    });
  }

  // Update in-memory state for realtime stats/queueing
  const cachedInteraction = getInteractionState(interactionId);
  if (!cachedInteraction) {
    enqueueCall(queue.id, interactionId, enqueuedAt, queue.name);
  } else {
    cachedInteraction.queueId = queue.id;
    cachedInteraction.queueName = queue.name;
    cachedInteraction.state = "queued";
    cachedInteraction.enqueuedAt = enqueuedAt;
  }

  // Start queue audio if configured
  try {
    const { startQueueAudio } = await import("./queue-audio-service.js");
    // Normalize position: ensure it's at least 1 (not 0)
    // If position is 0 or null/undefined, set it to 1 for a single call in queue
    const normalizedPosition =
      currentPosition !== null &&
      currentPosition !== undefined &&
      currentPosition > 0
        ? currentPosition
        : 1; // Default to 1 if position is 0, null, or undefined
    await startQueueAudio(callControlId, queue.id, queue, normalizedPosition);
  } catch (audioError) {
    // Don't fail the enqueue if audio fails
  }

  // Lookup customer by phone number to get caller name (if contacts table exists)
  // Use effectiveFromNumber which combines params and existing interaction
  let callerName = null;
  if (effectiveFromNumber) {
    try {
      // Use findContactByPhoneNumber which checks all phone columns
      const contact = await PgDb.findContactByPhoneNumber(effectiveFromNumber);
      if (contact) {
        // Prefer display_name if available, otherwise use first_name + last_name
        if (contact.display_name) {
          callerName = contact.display_name;
        } else if (contact.first_name && contact.last_name) {
          callerName = `${contact.first_name} ${contact.last_name}`;
        } else if (contact.first_name) {
          callerName = contact.first_name;
        } else if (contact.last_name) {
          callerName = contact.last_name;
        }

        if (callerName) {
          await PgDb.updateInteractionById(interactionId, {
            fromName: callerName,
          });
        }
      }
    } catch (err) {
      // Contacts table might not exist, that's okay
    }
  }

  // Trigger routing engine
  const { routeCall } = await import("./routing-engine.js");
  const interaction = await PgDb.findInteractionById(interactionId);

  // Get call priority from routingMetadata (client_state) or use the one we set on interaction
  const callPriorityForRouting =
    routingMetadata.call_priority ||
    interaction?.priority ||
    queue.default_call_priority ||
    3;

  const routingResult = await routeCall(queue.id, {
    required_skills: routingMetadata.required_skills || {},
    priority: callPriorityForRouting, // Pass call priority (1-5 stars) to routing engine
    callControlId,
    callSessionId,
  });

  const selectedAgent = routingResult.success ? routingResult.agent : null;

  // Store routing metadata even when no agent is found (for skills matching info)
  if (!selectedAgent && routingResult.routingMetadata) {
    const routingMetadataWithResult = {
      ...updatedRoutingMetadata,
      ...routingResult.routingMetadata,
    };

    await PgDb.updateInteractionById(interactionId, {
      routingMetadata: routingMetadataWithResult,
    });
  }

  if (selectedAgent) {
    const agentDisplayName = [selectedAgent.first_name, selectedAgent.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();

    // Add timeline event for alerting (agent ringing)
    const assignedAt = new Date().toISOString();
    const interaction = await PgDb.findInteractionById(interactionId);
    const routingMetadataWithAlerting = addTimelineEvent(
      interaction?.routing_metadata || updatedRoutingMetadata,
      "alerting",
      {
        timestamp: assignedAt,
        agentUsername: selectedAgent.username,
        agentId: selectedAgent.id,
        routingAlgorithm: routingResult.routingMetadata?.algorithm,
      },
    );

    // Clear timeout_re_enqueued flag when re-assigning (call is being offered again)
    const currentMetadata = interaction?.metadata || {};
    const updatedMetadata = { ...currentMetadata };
    if (updatedMetadata.timeout_re_enqueued) {
      delete updatedMetadata.timeout_re_enqueued;
      delete updatedMetadata.timeout_re_enqueued_at;
      delete updatedMetadata.previous_agent;
    }

    // Assign interaction to agent
    await PgDb.updateInteractionById(interactionId, {
      agentUsername: selectedAgent.username,
      state: "ringing",
      toName: agentDisplayName || selectedAgent.username,
      routingMetadata: routingMetadataWithAlerting,
      assignedAt,
      metadata: updatedMetadata,
    });

    assignCallToAgent(queue.id, interactionId, selectedAgent.id, assignedAt);

    // Calculate wait time
    const waitTime = Math.floor(
      (new Date().getTime() - new Date(interaction.enqueued_at).getTime()) /
        1000,
    );
    await PgDb.updateInteractionById(interactionId, {
      waitTimeSeconds: waitTime,
    });

    // Stop queue audio before transferring to agent
    try {
      const { stopQueueAudio } = await import("./queue-audio-service.js");
      await stopQueueAudio(callControlId);
    } catch (audioError) {
      // Continue with transfer even if audio stop fails
    }

    // Automatically transfer call to agent's WebRTC client
    try {
      const { bridgeCallToAgent } = await import("./webrtc-bridge.js");
      const bridgeResult = await bridgeCallToAgent(
        callSessionId,
        callControlId,
        selectedAgent.username,
        fromNumber,
        callerName,
      );

      // Note: bridgeCallToAgent already updates the interaction with agent_call_control_id
      // and original_call_control_id in metadata, so we don't need to update here
    } catch (bridgeError) {
      // Don't fail the routing if transfer fails - agent can still answer manually
    }

    // Refresh interaction from DB to get latest metadata (including agent_assist_config)
    const freshInteraction = await PgDb.findInteractionById(interactionId);
    const freshMetadata = freshInteraction?.metadata || interaction.metadata || {};

    // Notify agent via SSE
    const { broadcastToKey } = await import("@/lib/sse");
    broadcastToKey(`contact-center:agent:${selectedAgent.username}`, {
      type: "new_interaction",
      interaction: {
        id: interactionId,
        queueName,
        fromNumber,
        toNumber,
        fromName: callerName,
        state: "ringing",
        callControlId,
        callSessionId,
        // Include full call details for the calls store
        callerName,
        callerNumber: fromNumber,
        queueId: queue.id,
        queuedAt: freshInteraction?.enqueued_at || interaction.enqueued_at,
        assignedAt: new Date().toISOString(),
        aiCallControlId: freshMetadata.ai_call_control_id || null,
        metadata: freshMetadata,
      },
    });
  }
}

/**
 * Handle subsequent contact center webhook events
 * @param {string} eventType - Event type
 * @param {Object} payload - Webhook payload
 */
export async function handleContactCenterEvent(eventType, payload) {
  const callControlId = payload?.call_control_id;
  const callSessionId = payload?.call_session_id;
  if (!callControlId && !callSessionId) return;

  // Handle call.speak.ended immediately for queue audio and speak queue (doesn't need interaction)
  if (eventType === "call.speak.ended") {
    if (callControlId) {
      // Advance chunked speak queue — if there's a next chunk, send it
      try {
        const { advanceQueue } = await import("./speak-queue.js");
        const wasQueued = await advanceQueue(callControlId);
        if (wasQueued) {
          // This speak.ended was from a chunked speak — don't resume queue media
          // (the next chunk is already being sent, or the queue just finished)
          return;
        }
      } catch (speakQueueError) {
        // Failed to advance speak queue
      }

      try {
        const { resumeQueueMedia } = await import("./queue-audio-service.js");
        const result = await resumeQueueMedia(callControlId);
      } catch (audioError) {
        // Failed to resume queue media after speak
      }
    }
    // Continue to check for interaction for other updates, but don't require it
  }

  // For call.bridged, try to find by call_session_id first
  let interaction = null;
  if (callSessionId && eventType === "call.bridged") {
    interaction = await PgDb.findInteractionByCallSessionId(callSessionId);
  }

  // Fallback to call_control_id if not found by session
  if (!interaction && callControlId) {
    interaction = await PgDb.findInteractionByCallControlId(callControlId);
  }

  // For call.answered and call.hangup, also try to find by agent_call_control_id or original_call_control_id in metadata
  // This handles cases where the webhook is for the agent's leg (WebRTC) rather than the original call leg
  // When agent answers via WebRTC, call.answered webhook arrives with agent's call_control_id, not the original call's
  if (
    !interaction &&
    callControlId &&
    (eventType === "call.answered" || eventType === "call.hangup")
  ) {
    try {
      const pool = getPostgresPool();
      if (pool) {
        // Try to find by agent_call_control_id (WebRTC leg - agent's call when they answer)
        let result = await pool.query(
          "SELECT * FROM cc_interactions WHERE metadata->>'agent_call_control_id' = $1 AND is_contact_center = true ORDER BY created_at DESC LIMIT 1",
          [callControlId],
        );

        // If not found, try to find by original_call_control_id (PSTN leg)
        if (!result.rows?.[0]) {
          result = await pool.query(
            "SELECT * FROM cc_interactions WHERE metadata->>'original_call_control_id' = $1 AND is_contact_center = true ORDER BY created_at DESC LIMIT 1",
            [callControlId],
          );
        }

        if (result.rows?.[0]) {
          const row = result.rows[0];
          const safeParse = (value) => {
            if (!value) return null;
            if (typeof value === "object") return value;
            if (typeof value === "string") {
              try {
                return JSON.parse(value);
              } catch {
                return value;
              }
            }
            return value;
          };
          interaction = {
            ...row,
            required_skills: safeParse(row.required_skills),
            routing_metadata: safeParse(row.routing_metadata),
            transfer_history: safeParse(row.transfer_history),
            tags: safeParse(row.tags),
            metadata: safeParse(row.metadata),
          };
        }
      }
    } catch (err) {
      // Error looking up by metadata call_control_id
    }
  }

  if (!interaction || !interaction.is_contact_center) {
    return; // Not a contact center interaction
  }

  const updates = {};
  let updatedRoutingMetadata = interaction.routing_metadata || {};
  const ensureAnsweredTimeline = (baseMetadata, answeredTimestamp) => {
    let nextMetadata = baseMetadata || {};
    const timeline = nextMetadata.timeline || [];
    const hasAnswered = timeline.some(
      (event) => event.type === TimelineEventTypes.ANSWERED,
    );
    if (!hasAnswered) {
      const answeredAt =
        answeredTimestamp ||
        interaction.answered_at ||
        new Date().toISOString();
      if (interaction.assigned_at) {
        const assignedAtMs = new Date(interaction.assigned_at).getTime();
        const answeredAtMs = new Date(answeredAt).getTime();
        if (!Number.isNaN(assignedAtMs) && !Number.isNaN(answeredAtMs)) {
          const durationSeconds = Math.max(
            0,
            Math.floor((answeredAtMs - assignedAtMs) / 1000),
          );
          const hasAlerting = timeline.some(
            (event) => event.type === "alerting",
          );
          if (!hasAlerting) {
            nextMetadata = addTimelineEvent(nextMetadata, "alerting", {
              timestamp: interaction.assigned_at,
              alertingDurationSeconds: durationSeconds,
            });
          }
        }
      }
      nextMetadata = addTimelineEvent(
        nextMetadata,
        TimelineEventTypes.ANSWERED,
        {
          timestamp: new Date(answeredAt).toISOString(),
          agentUsername: interaction.agent_username,
        },
      );
    }
    return nextMetadata;
  };

  switch (eventType) {
    case "call.answered": {
      // call.answered fires when the agent actually answers
      // For transferred calls, this is when we should set state to "connected"
      // Also handle cases where call was answered in previous queue and transferred
      const wasAlreadyAnsweredInAnswered = !!interaction.answered_at;
      const isCurrentlyQueuedOrRinging = ["queued", "ringing"].includes(
        interaction.state,
      );

      // Update answered_at if not set, or if call is currently queued/ringing (transferred call being answered again)
      if (!wasAlreadyAnsweredInAnswered || isCurrentlyQueuedOrRinging) {
        const answeredAt = payload?.answered_at || new Date().toISOString();
        if (!wasAlreadyAnsweredInAnswered) {
          updates.answeredAt = answeredAt;
        }
        // Always set state to "connected" when answered, especially for transferred calls
        updates.state = "connected";
        // Ensure alerting (ringing) segment exists before answered
        if (interaction.assigned_at) {
          const assignedAtMs = new Date(interaction.assigned_at).getTime();
          const answeredAtMs = new Date(answeredAt).getTime();
          if (!Number.isNaN(assignedAtMs) && !Number.isNaN(answeredAtMs)) {
            const durationSeconds = Math.max(
              0,
              Math.floor((answeredAtMs - assignedAtMs) / 1000),
            );
            const existingTimeline = updatedRoutingMetadata.timeline || [];
            const hasAlerting = existingTimeline.some(
              (event) => event.type === "alerting",
            );
            if (!hasAlerting) {
              updatedRoutingMetadata = addTimelineEvent(
                updatedRoutingMetadata,
                "alerting",
                {
                  timestamp: interaction.assigned_at,
                  alertingDurationSeconds: durationSeconds,
                },
              );
            }
          }
        }
        // Add timeline event for answered (only if not already added for this answer)
        const existingTimeline = updatedRoutingMetadata.timeline || [];
        const recentAnsweredEvent = existingTimeline
          .filter((e) => e.type === TimelineEventTypes.ANSWERED)
          .pop();
        // Only add if this is a new answer (transferred call) or no answered event exists
        if (
          isCurrentlyQueuedOrRinging ||
          !recentAnsweredEvent ||
          (recentAnsweredEvent.agentUsername !== interaction.agent_username &&
            interaction.agent_username)
        ) {
          updatedRoutingMetadata = addTimelineEvent(
            updatedRoutingMetadata,
            TimelineEventTypes.ANSWERED,
            {
              timestamp: answeredAt,
              agentUsername: interaction.agent_username,
            },
          );
        }
        updates.routingMetadata = updatedRoutingMetadata;
      }
      break;
    }

    case "call.bridged":
      // For calls transferred to agents, call.bridged fires when the transfer leg is created
      // We should only set state to "connected" if the call was already answered
      // Otherwise, keep it as "ringing" until call.answered fires
      const isTransferredCall =
        !!interaction.metadata?.original_call_control_id;
      const isAgentLeg =
        interaction.metadata?.agent_call_control_id === callControlId;
      const callState = payload?.state;

      // Only set to "connected" if:
      // 1. Call was already answered (answered_at exists), OR
      // 2. This is NOT a transferred call (direct call, not through transfer), OR
      // 3. It's the agent's leg AND the call state indicates it's actually connected (not ringing/parked)
      const wasAlreadyAnswered = !!interaction.answered_at;
      const shouldSetConnected =
        wasAlreadyAnswered ||
        !isTransferredCall ||
        (isAgentLeg &&
          callState &&
          !["ringing", "parked", "trying", "initiated"].includes(
            callState.toLowerCase(),
          ));

      if (shouldSetConnected) {
        const answeredAt = interaction.answered_at || new Date().toISOString();
        if (!wasAlreadyAnswered) {
          updates.answeredAt = answeredAt;
        }
        // Ensure alerting (ringing) segment exists before answered
        if (interaction.assigned_at) {
          const assignedAtMs = new Date(interaction.assigned_at).getTime();
          const answeredAtMs = new Date(answeredAt).getTime();
          if (!Number.isNaN(assignedAtMs) && !Number.isNaN(answeredAtMs)) {
            const durationSeconds = Math.max(
              0,
              Math.floor((answeredAtMs - assignedAtMs) / 1000),
            );
            const existingTimeline = updatedRoutingMetadata.timeline || [];
            const hasAlerting = existingTimeline.some(
              (event) => event.type === "alerting",
            );
            if (!hasAlerting) {
              updatedRoutingMetadata = addTimelineEvent(
                updatedRoutingMetadata,
                "alerting",
                {
                  timestamp: interaction.assigned_at,
                  alertingDurationSeconds: durationSeconds,
                },
              );
            }
          }
        }
        // Add timeline event for answered if missing
        const existingTimeline = updatedRoutingMetadata.timeline || [];
        const hasAnswered = existingTimeline.some(
          (event) => event.type === TimelineEventTypes.ANSWERED,
        );
        if (!hasAnswered) {
          updatedRoutingMetadata = addTimelineEvent(
            updatedRoutingMetadata,
            TimelineEventTypes.ANSWERED,
            {
              timestamp: answeredAt,
              agentUsername: interaction.agent_username,
            },
          );
        }
      }

      if (shouldSetConnected) {
        updates.state = "connected";
        // Add timeline event for connected/bridged
        // Check if "connected" event already exists to avoid duplicates
        // (call.bridged fires for both PSTN and WebRTC legs)
        const existingTimeline = updatedRoutingMetadata.timeline || [];
        const hasConnectedEvent = existingTimeline.some(
          (event) => event.type === TimelineEventTypes.CONNECTED,
        );
        if (!hasConnectedEvent) {
          updatedRoutingMetadata = addTimelineEvent(
            updatedRoutingMetadata,
            TimelineEventTypes.CONNECTED,
            {
              agentUsername: interaction.agent_username,
            },
          );
        }
      } else {
        // For transferred calls that are still ringing, keep state as "ringing"
        if (
          interaction.state !== "ringing" &&
          interaction.state !== "connected"
        ) {
          updates.state = "ringing";
        }
      }
      updates.routingMetadata = updatedRoutingMetadata;
      break;

    case "call.hangup":
      // Cancel any active speak queue for this call
      try {
        const { cancelQueue } = await import("./speak-queue.js");
        cancelQueue(callControlId);
      } catch (_cancelErr) {
        // Speak queue cancel failed — not critical
      }

      // Skip if this is an agent leg hangup due to timeout (agent didn't answer)
      // Check if this is the agent's leg and if timeout_re_enqueued flag is set
      const isAgentLegHangup =
        interaction.metadata?.agent_call_control_id === callControlId;
      const wasTimeoutReEnqueued =
        interaction.metadata?.timeout_re_enqueued === true;

      if (isAgentLegHangup && wasTimeoutReEnqueued) {
        // This is an agent leg hangup due to timeout - don't process as normal hangup
        // The call has already been re-enqueued and agent status set to "Agent Not Answering"
        console.log(
          `[WebhookHandler] Skipping agent leg hangup for timeout scenario, interaction ${interaction.id}`,
        );
        return;
      }

      // If agent leg hangs up and we used park_after_unbridge, hangup the original call leg
      // BUT NOT if we're in a consult process - the original call should stay parked
      // Reload interaction to ensure we have the latest consult_state (avoid race conditions)
      let latestInteraction = interaction;
      if (isAgentLegHangup) {
        try {
          const reloaded = await PgDb.findInteractionById(interaction.id);
          if (reloaded) {
            latestInteraction = reloaded;
            console.log(
              `[WebhookHandler] Reloaded interaction ${interaction.id} to check consult_state: ${JSON.stringify(latestInteraction.metadata?.consult_state)}`,
            );
          }
        } catch (reloadErr) {
          console.warn(
            `[WebhookHandler] Failed to reload interaction, using cached version:`,
            reloadErr,
          );
        }
      }

      const hasConsultState = !!latestInteraction.metadata?.consult_state;
      const isPendingConsult =
        latestInteraction.metadata?.consult_state?.pendingConsult === true;

      console.log(
        `[WebhookHandler] Agent leg hangup check: isAgentLegHangup=${isAgentLegHangup}, hasConsultState=${hasConsultState}, isPendingConsult=${isPendingConsult}, original_call_control_id=${latestInteraction.metadata?.original_call_control_id}`,
      );

      if (
        isAgentLegHangup &&
        latestInteraction.metadata?.original_call_control_id &&
        !hasConsultState
      ) {
        const originalCallControlId =
          latestInteraction.metadata.original_call_control_id;
        try {
          const apiKey = process.env.TELNYX_API_KEY;
          if (apiKey) {
            const hangupUrl = buildTelnyxV2Url(
              `/calls/${encodeURIComponent(originalCallControlId)}/actions/hangup`,
            );
            console.log(
              `[WebhookHandler] Hanging up original call leg ${originalCallControlId} after agent leg disconnect (not in consult process)`,
            );
            await fetch(hangupUrl, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
            });
            console.log(
              `[WebhookHandler] Hung up original call leg ${originalCallControlId} after agent leg disconnect`,
            );
          }
        } catch (hangupError) {
          // Log but don't fail - the call may have already been hung up
          console.error(
            `[WebhookHandler] Failed to hangup original call leg ${originalCallControlId}:`,
            hangupError,
          );
        }
      } else if (isAgentLegHangup && hasConsultState) {
        console.log(
          `[WebhookHandler] Skipping original leg hangup - consult process active for interaction ${latestInteraction.id}`,
        );
      }
      
      // Handle pending consult - signal frontend to initiate WebRTC call
      if (isAgentLegHangup && isPendingConsult) {
        // Agent leg hung up and we have a pending consult
        // The frontend will initiate the WebRTC call, which will trigger call.initiated webhook
        // We just need to return early to prevent further processing
        console.log(
          `[WebhookHandler] Agent leg hung up for pending consult on interaction ${latestInteraction.id}. Frontend will initiate WebRTC call. Returning early to prevent hangup processing.`,
        );
        // Return early - the frontend will initiate the consult call via WebRTC
        // This prevents hanging up the original leg and triggering wrapup
        return;
      }

      // Skip if already completed or abandoned (prevents duplicate processing from multiple leg hangups)
      // Also skip if we're in a consult process - don't complete the interaction yet
      if (
        latestInteraction.state === "completed" ||
        latestInteraction.state === "abandoned" ||
        latestInteraction.completed_at ||
        latestInteraction.abandoned_at ||
        hasConsultState
      ) {
        if (hasConsultState) {
          console.log(
            `[WebhookHandler] Skipping hangup processing - consult process active for interaction ${latestInteraction.id}`,
          );
        }
        return; // Already processed or in consult process
      }

      const finalState =
        interaction.state === "queued" ? "abandoned" : "completed";
      updates.state = finalState;

      if (finalState === "completed") {
        updates.completedAt = new Date().toISOString();
        // Calculate wait/handle/talk times (exclude holds from talk time)
        const completedAtMs = new Date(updates.completedAt).getTime();
        const enqueuedAtMs = interaction.enqueued_at
          ? new Date(interaction.enqueued_at).getTime()
          : null;
        const answeredAtMs = interaction.answered_at
          ? new Date(interaction.answered_at).getTime()
          : null;

        const waitTimeSeconds =
          interaction.wait_time_seconds ??
          (interaction.assigned_at
            ? Math.floor(
                (new Date(interaction.assigned_at).getTime() -
                  (enqueuedAtMs ||
                    new Date(interaction.created_at).getTime())) /
                  1000,
              )
            : enqueuedAtMs
              ? Math.floor((completedAtMs - enqueuedAtMs) / 1000)
              : 0);

        let holdDurationSeconds = interaction.hold_duration_seconds || 0;
        if (interaction.metadata?.current_hold_started_at) {
          const holdStartMs = new Date(
            interaction.metadata.current_hold_started_at,
          ).getTime();
          if (!Number.isNaN(holdStartMs)) {
            holdDurationSeconds += Math.max(
              0,
              Math.floor((completedAtMs - holdStartMs) / 1000),
            );
          }
        }

        const handleTimeSeconds = enqueuedAtMs
          ? Math.floor((completedAtMs - enqueuedAtMs) / 1000)
          : answeredAtMs
            ? Math.floor((completedAtMs - answeredAtMs) / 1000) +
              Math.max(0, waitTimeSeconds)
            : 0;

        const talkTimeSeconds = Math.max(
          0,
          handleTimeSeconds -
            Math.max(0, waitTimeSeconds) -
            holdDurationSeconds,
        );

        updates.waitTimeSeconds = waitTimeSeconds;
        updates.handleTimeSeconds = handleTimeSeconds;
        updates.holdDurationSeconds = holdDurationSeconds;
        updates.talkTimeSeconds = talkTimeSeconds;
        // Add timeline event for disconnected
        updatedRoutingMetadata = addTimelineEvent(
          updatedRoutingMetadata,
          TimelineEventTypes.DISCONNECTED,
          {
            reason: "completed",
            hangupCause: payload?.hangup_cause || null,
          },
        );
      } else {
        updates.abandonedAt = new Date().toISOString();
        // Calculate wait time for abandoned calls
        if (interaction.enqueued_at) {
          updates.waitTimeSeconds = Math.max(
            0,
            Math.floor(
              (new Date(updates.abandonedAt).getTime() -
                new Date(interaction.enqueued_at).getTime()) /
                1000,
            ),
          );
        }
        // Add timeline event for disconnected (abandoned)
        updatedRoutingMetadata = addTimelineEvent(
          updatedRoutingMetadata,
          TimelineEventTypes.DISCONNECTED,
          {
            reason: "abandoned",
            hangupCause: payload?.hangup_cause || null,
          },
        );
      }
      updates.routingMetadata = updatedRoutingMetadata;
      break;

    case "call.dequeued":
      // Stop queue audio when call is dequeued
      try {
        const { stopQueueAudio } = await import("./queue-audio-service.js");
        await stopQueueAudio(interaction.call_control_id);
      } catch (audioError) {
        // Failed to stop queue audio on dequeued
      }

      // Call was dequeued (e.g., transferred out of queue)
      // Note: "dequeued" is not a valid state in the database constraint
      // Instead, mark as "ringing" or keep current state if already progressed
      if (interaction.state === "queued") {
        // If call was dequeued but not yet answered, set to ringing
        // If already answered/connected, keep current state
        if (!interaction.answered_at) {
          updates.state = "ringing";
        }
        // Otherwise, keep current state (don't update)
      }
      break;

    case "call.held": {
      const holdTimestamp = payload?.occurred_at || new Date().toISOString();
      const holdCount = (interaction.hold_count || 0) + 1;
      const updatedMetadata = {
        ...(interaction.metadata || {}),
        current_hold_started_at: holdTimestamp,
      };

      updates.holdCount = holdCount;
      updates.metadata = updatedMetadata;
      updatedRoutingMetadata = ensureAnsweredTimeline(
        updatedRoutingMetadata,
        holdTimestamp,
      );
      updatedRoutingMetadata = addTimelineEvent(
        updatedRoutingMetadata,
        TimelineEventTypes.HOLD,
        {
          timestamp: holdTimestamp,
          holdNumber: holdCount,
        },
      );
      updates.routingMetadata = updatedRoutingMetadata;
      break;
    }

    case "call.unheld": {
      const resumeTimestamp = payload?.occurred_at || new Date().toISOString();
      updatedRoutingMetadata = ensureAnsweredTimeline(
        updatedRoutingMetadata,
        resumeTimestamp,
      );
      const currentHoldStartedAt =
        interaction.metadata?.current_hold_started_at;
      let holdDurationSeconds = interaction.hold_duration_seconds || 0;

      if (currentHoldStartedAt) {
        const duration = Math.max(
          0,
          Math.floor(
            (new Date(resumeTimestamp).getTime() -
              new Date(currentHoldStartedAt).getTime()) /
              1000,
          ),
        );
        holdDurationSeconds += duration;
        updatedRoutingMetadata = addTimelineEvent(
          updatedRoutingMetadata,
          TimelineEventTypes.RESUME,
          {
            timestamp: resumeTimestamp,
            holdDuration: duration,
          },
        );
      } else {
        updatedRoutingMetadata = addTimelineEvent(
          updatedRoutingMetadata,
          TimelineEventTypes.RESUME,
          {
            timestamp: resumeTimestamp,
            holdDuration: null,
          },
        );
      }

      const updatedMetadata = {
        ...(interaction.metadata || {}),
      };
      delete updatedMetadata.current_hold_started_at;

      updates.holdDurationSeconds = holdDurationSeconds;
      updates.metadata = updatedMetadata;
      updates.routingMetadata = updatedRoutingMetadata;
      break;
    }

    case "call.recording.transcription.saved":
      // Store transcription_text in metadata and generate summary
      const transcriptionText = payload?.transcription_text || null;
      if (transcriptionText) {
        // Generate call summary asynchronously (don't block webhook response)
        (async () => {
          try {
            const { generateCallSummary } = await import("./call-summary.js");
            const summary = await generateCallSummary(transcriptionText);
            if (summary) {
              const updatedMetadata = {
                ...(interaction.metadata || {}),
                transcription_text: transcriptionText,
                transcription_summary: summary,
              };
              await PgDb.updateInteractionById(interaction.id, {
                metadata: updatedMetadata,
              });
            } else {
              // Still save transcription even if summary generation fails
              const updatedMetadata = {
                ...(interaction.metadata || {}),
                transcription_text: transcriptionText,
              };
              await PgDb.updateInteractionById(interaction.id, {
                metadata: updatedMetadata,
              });
            }
          } catch (summaryError) {
            // Error generating call summary
            // Still save transcription even if summary generation fails
            const updatedMetadata = {
              ...(interaction.metadata || {}),
              transcription_text: transcriptionText,
            };
            await PgDb.updateInteractionById(interaction.id, {
              metadata: updatedMetadata,
            });
          }
        })();

        // Update metadata immediately with transcription (summary will be added async)
        const updatedMetadata = {
          ...(interaction.metadata || {}),
          transcription_text: transcriptionText,
        };
        updates.metadata = updatedMetadata;
      }
      break;

    case "call.recording.saved":
      // Store recording URL
      const recordingUrl =
        payload?.recording_urls?.mp3 ||
        payload?.recording_urls?.public_recording_urls?.[0] ||
        payload?.recording_urls?.recording_urls?.[0] ||
        payload?.public_recording_urls?.[0] ||
        payload?.recording_url ||
        null;
      const updatedMetadata = {
        ...(interaction.metadata || {}),
        recording: {
          recording_id: payload?.recording_id || null,
          call_leg_id: payload?.call_leg_id || null,
          call_session_id: payload?.call_session_id || null,
          format: payload?.format || null,
          channels: payload?.channels || null,
          recording_started_at: payload?.recording_started_at || null,
          recording_ended_at: payload?.recording_ended_at || null,
          recording_urls: payload?.recording_urls || null,
          public_recording_urls: payload?.public_recording_urls || null,
          recording_url: recordingUrl,
        },
      };
      updates.metadata = updatedMetadata;
      if (recordingUrl) {
        updates.recordingUrl = recordingUrl;
      }
      break;

    case "call.speak.ended":
      // Note: Queue media resume is handled at the top of handleContactCenterEvent
      // before interaction lookup, so it works even if no interaction is found
      break;
  }

  if (Object.keys(updates).length > 0) {
    // For call.answered events, use atomic UPDATE to set answered_at immediately
    // This prevents race conditions with the timeout check
    if (eventType === "call.answered" && updates.answeredAt) {
      const pool = getPostgresPool();
      if (pool) {
        // Atomically set answered_at only if it's still NULL
        // This ensures we don't overwrite if already set, and prevents timeout race conditions
        const atomicUpdate = await pool.query(
          `UPDATE cc_interactions 
           SET answered_at = $1,
               state = COALESCE($2, state),
               routing_metadata = COALESCE($3::jsonb, routing_metadata)
           WHERE id = $4
             AND answered_at IS NULL
           RETURNING id`,
          [
            updates.answeredAt,
            updates.state || null,
            updates.routingMetadata
              ? JSON.stringify(updates.routingMetadata)
              : null,
            interaction.id,
          ],
        );

        if (atomicUpdate.rows && atomicUpdate.rows.length > 0) {
          // Successfully updated - now update other fields if needed
          const remainingUpdates = { ...updates };
          delete remainingUpdates.answeredAt;
          delete remainingUpdates.state;
          delete remainingUpdates.routingMetadata;

          if (Object.keys(remainingUpdates).length > 0) {
            await PgDb.updateInteractionById(interaction.id, remainingUpdates);
          }

          // Update in-memory state
          answerCall(interaction.id, updates.answeredAt);
        } else {
          // Call was already answered (answered_at was already set)
          // Just update other fields without answered_at
          const remainingUpdates = { ...updates };
          delete remainingUpdates.answeredAt;
          if (Object.keys(remainingUpdates).length > 0) {
            await PgDb.updateInteractionById(interaction.id, remainingUpdates);
          }
        }
      } else {
        // Fallback to regular update if pool not available
        await PgDb.updateInteractionById(interaction.id, updates);
        answerCall(interaction.id, updates.answeredAt);
      }
    } else {
      // For other events, use regular update
      await PgDb.updateInteractionById(interaction.id, updates);

      // Update in-memory state for realtime metrics
      if (eventType === "call.answered" && updates.answeredAt) {
        answerCall(interaction.id, updates.answeredAt);
      }
    }
    if (
      eventType === "call.bridged" &&
      updates.answeredAt &&
      updates.state === "connected"
    ) {
      answerCall(interaction.id, updates.answeredAt);
    }
    if (eventType === "call.hangup" && updates.state) {
      const completedAt =
        updates.completedAt || updates.abandonedAt || new Date().toISOString();
      const wasAbandoned = updates.state === "abandoned";
      completeCall(interaction.id, completedAt, wasAbandoned);
    }

    // Notify agent if assigned
    if (interaction.agent_username) {
      const { broadcastToKey } = await import("@/lib/sse");
      broadcastToKey(`contact-center:agent:${interaction.agent_username}`, {
        type: "interaction_updated",
        interactionId: interaction.id,
        updates,
      });

      // If call ended, also send interaction_ended event
      if (eventType === "call.hangup") {
        broadcastToKey(`contact-center:agent:${interaction.agent_username}`, {
          type: "interaction_ended",
          interactionId: interaction.id,
          callControlId: callControlId || interaction.call_control_id,
        });
      }
    }

    // Handle consult call wrapup - when parked call leg ends, trigger wrapup
    if (eventType === "call.hangup" && interaction.metadata?.consult_state?.isActive) {
      const consultState = interaction.metadata.consult_state;
      const isParkedCallEnding = callControlId === consultState.parkedCallControlId;
      
      if (isParkedCallEnding) {
        // Parked call leg ended - trigger wrapup for the original interaction
        try {
          const { addTimelineEvent, TimelineEventTypes } = await import(
            "./call-timeline-tracker.js"
          );
          const updatedRoutingMetadata = addTimelineEvent(
            interaction.routing_metadata || {},
            TimelineEventTypes.WRAPUP_START,
            {
              agentUsername: interaction.agent_username,
              reason: "consult_parked_call_ended",
            },
          );

          await PgDb.updateInteractionById(interaction.id, {
            metadata: {
              ...interaction.metadata,
              consult_state: {
                ...consultState,
                isActive: false,
                parkedCallEndedAt: new Date().toISOString(),
              },
              wrapup_started_at: new Date().toISOString(),
            },
            routingMetadata: updatedRoutingMetadata,
          });

          // Set agent status to Wrapup
          if (interaction.agent_username) {
            const { setUserStatus } = await import("./user-status.js");
            const { PgDb } = await import("@/lib/pgdb.js");
            const agent = await PgDb.findUserByUsername(interaction.agent_username);
            if (agent) {
              await setUserStatus({
                userId: agent.id,
                username: interaction.agent_username,
                status: "Wrapup",
              });
            }
          }

          // Trigger wrapup sheet via SSE
          const { broadcastToKey } = await import("@/lib/sse");
          broadcastToKey(`contact-center:agent:${interaction.agent_username}`, {
            type: "wrapup_required",
            interactionId: interaction.id,
            reason: "consult_parked_call_ended",
          });
        } catch (wrapupError) {
          console.error("[WebhookHandler] Error triggering consult wrapup:", wrapupError);
        }
      }
      // Don't broadcast consult call events to monitors
      return;
    }

    // Skip broadcasting consult calls to monitors
    if (interaction.metadata?.is_consult_call) {
      return;
    }

    // Broadcast to monitor streams for state changes (answered, completed, etc.)
    if (
      (eventType === "call.answered" ||
        eventType === "call.bridged" ||
        eventType === "call.hangup") &&
      interaction.queue_id &&
      !interaction.metadata?.is_consult_call
    ) {
      try {
        const { broadcastToKey } = await import("@/lib/sse");
        const { getPostgresPool } = await import("@/lib/postgres.mjs");
        const pool = getPostgresPool();
        if (pool) {
          const supervisors = await pool.query(
            `SELECT id FROM users WHERE 'supervisor' = ANY(roles) OR 'admin' = ANY(roles) OR 'owner' = ANY(roles)`,
          );
          for (const supervisor of supervisors.rows || []) {
            await broadcastToKey(
              `monitor:${supervisor.id}`,
              {
                type: "interaction_updated",
                interactionId: interaction.id,
                queueId: interaction.queue_id,
                updates,
              },
              "interaction_updated",
            );
          }
        }
      } catch (monitorError) {
        // Don't fail if monitor broadcast fails
        console.error(
          "[WebhookHandler] Failed to broadcast to monitors:",
          monitorError,
        );
      }
    }
  }
}

/**
 * Handle call.transcription webhook for Agent Assist
 * @param {Object} payload - Webhook payload
 */
export async function handleTranscriptionEvent(payload) {
  const callControlId = payload?.call_control_id;
  const transcriptionData = payload?.transcription_data;

  if (!callControlId || !transcriptionData) {
    return;
  }

  // Only process final transcriptions
  if (!transcriptionData.is_final) {
    return;
  }

  // Find the interaction by call_control_id
  // Try call_control_id first, then call_session_id as fallback (like in demo portal)
  let interaction = await PgDb.findInteractionByCallControlId(callControlId);

  // If not found by call_control_id, try by call_session_id
  // (in case the call_control_id format differs between webhooks)
  if (
    (!interaction || !interaction.is_contact_center) &&
    payload?.call_session_id
  ) {
    interaction = await PgDb.findInteractionByCallSessionId(
      payload.call_session_id,
    );
  }

  if (!interaction || !interaction.is_contact_center) {
    return;
  }

  // Analyze transcription for intent and sentiment
  const analysis = await analyzeTranscription(transcriptionData.transcript);

  // Broadcast transcription to the assigned agent via SSE
  if (interaction.agent_username) {
    const { broadcastToKey } = await import("@/lib/sse");
    broadcastToKey(`contact-center:agent:${interaction.agent_username}`, {
      type: "transcription",
      interactionId: interaction.id,
      callControlId,
      transcription: {
        transcript: transcriptionData.transcript,
        track: transcriptionData.transcription_track,
        is_final: transcriptionData.is_final,
        timestamp: new Date().toISOString(),
        // Include analysis results
        intent: analysis.intent,
        sentiment: analysis.sentiment,
        sentimentScore: analysis.sentimentScore,
        tags: analysis.tags || [],
      },
    });
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
      [queueName],
    );

    return result.rows?.[0]?.id || null;
  } catch (error) {
    console.error("[WebhookHandler] Error finding queue:", error);
    return null;
  }
}
