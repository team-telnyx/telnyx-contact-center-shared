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
      `SELECT id, enqueued_at, assigned_at, routing_metadata FROM cc_interactions 
       WHERE call_control_id = $1 
       ORDER BY created_at DESC LIMIT 1`,
      [call_control_id]
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
          (new Date(answeredAt) - new Date(interaction.enqueued_at)) / 1000
        )
      : 0;

    let updatedRoutingMetadata =
      safeParse(interaction.routing_metadata) || {};
    const existingTimeline = updatedRoutingMetadata.timeline || [];
    if (interaction.assigned_at) {
      const alertingSeconds = Math.max(
        0,
        Math.floor(
          (new Date(answeredAt) - new Date(interaction.assigned_at)) / 1000
        )
      );
      const hasAlerting = existingTimeline.some(
        (event) => event.type === "alerting"
      );
      if (!hasAlerting) {
        updatedRoutingMetadata = addTimelineEvent(
          updatedRoutingMetadata,
          "alerting",
          {
            timestamp: interaction.assigned_at,
            alertingDurationSeconds: alertingSeconds,
          }
        );
      }
    }
    const updatedTimeline = updatedRoutingMetadata.timeline || [];
    const hasAnswered = updatedTimeline.some(
      (event) => event.type === TimelineEventTypes.ANSWERED
    );
    if (!hasAnswered) {
      updatedRoutingMetadata = addTimelineEvent(
        updatedRoutingMetadata,
        TimelineEventTypes.ANSWERED,
        {
          timestamp: new Date(answeredAt).toISOString(),
        }
      );
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

  console.log("[ContactCenter] Handling enqueue:", {
    queueName,
    callControlId,
  });

  // Parse client_state for routing metadata
  let routingMetadata = {};
  if (clientState) {
    try {
      const decoded = JSON.parse(Buffer.from(clientState, "base64").toString());
      routingMetadata = decoded;
    } catch (err) {
      console.warn("[ContactCenter] Failed to parse client_state:", err);
    }
  }

  // Find queue (queues must be created in Admin - Queues screen, never auto-created)
  const { getOrCreateQueue, resolveQueueName } = await import(
    "./queue-utils.js"
  );
  const resolved = resolveQueueName(queueName, flowOwnerUsername);
  const queue = await getOrCreateQueue(queueName, resolved.owner);

  if (!queue) {
    console.error(
      `[ContactCenter] Queue "${queueName}" (resolved: "${resolved.name}") not found. Queue must be created in Admin - Queues screen before calls can be enqueued.`
    );
    return;
  }

  console.log(
    `[ContactCenter] Found queue: ${queue.name} (${queue.id}) for queueName: ${queueName}`
  );

  // Find existing interaction created from call.initiated
  let existingInteraction = await PgDb.findInteractionByCallControlId(
    callControlId
  );

  // If not found by call_control_id, try by call_session_id
  if (!existingInteraction && callSessionId) {
    existingInteraction = await PgDb.findInteractionByCallSessionId(
      callSessionId
    );
    if (existingInteraction) {
      console.log(
        `[ContactCenter] Found interaction by call_session_id: ${callSessionId}`
      );
    }
  }

  // Log what we have for debugging
  console.log("[ContactCenter] Contact lookup context:", {
    fromNumberInParams: fromNumber,
    existingInteractionFromNumber: existingInteraction?.from_number,
    existingInteractionId: existingInteraction?.id,
    callControlId,
    callSessionId,
  });

  let interactionId;

  const enqueuedAt = new Date().toISOString();

  // Use current queue stats for avg wait time instead of payload value
  const realtimeQueueMetrics = getRealtimeQueueMetrics(queue.id);
  const computedQueueAvgWaitTimeSecs = Math.round(
    Number(realtimeQueueMetrics?.avgWaitSeconds || 0)
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
    }
  );

  // Determine effective fromNumber: use params, or fall back to existing interaction's from_number
  // This ensures we have the phone number even if call.enqueued webhook doesn't include it
  const effectiveFromNumber = fromNumber || existingInteraction?.from_number;

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
      metadata: {
        ...(existingInteraction.metadata || {}),
        current_position: currentPosition,
        queue_avg_wait_time_secs: effectiveQueueAvgWaitTimeSecs,
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
    console.log(
      "[ContactCenter] Updated existing interaction:",
      interactionId,
      "fromNumber:",
      effectiveFromNumber,
      "(from params:",
      fromNumber,
      "from existing:",
      existingInteraction.from_number,
      ")"
    );
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
      metadata: {
        current_position: currentPosition,
        queue_avg_wait_time_secs: effectiveQueueAvgWaitTimeSecs,
      },
    });
    console.log(
      "[ContactCenter] Created new interaction:",
      interactionId,
      "fromNumber:",
      effectiveFromNumber
    );
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

  // Lookup customer by phone number to get caller name (if contacts table exists)
  // Use effectiveFromNumber which combines params and existing interaction
  let callerName = null;
  if (effectiveFromNumber) {
    try {
      console.log(
        "[ContactCenter] 🔍 Looking up contact for phone number:",
        effectiveFromNumber,
        "interactionId:",
        interactionId
      );
      // Use findContactByPhoneNumber which checks all phone columns
      const contact = await PgDb.findContactByPhoneNumber(effectiveFromNumber);
      if (contact) {
        console.log("[ContactCenter] ✅ Contact found, extracting name from:", {
          display_name: contact.display_name,
          first_name: contact.first_name,
          last_name: contact.last_name,
        });

        // Prefer display_name if available, otherwise use first_name + last_name
        if (contact.display_name) {
          callerName = contact.display_name;
          console.log("[ContactCenter] Using display_name:", callerName);
        } else if (contact.first_name && contact.last_name) {
          callerName = `${contact.first_name} ${contact.last_name}`;
          console.log(
            "[ContactCenter] Using first_name + last_name:",
            callerName
          );
        } else if (contact.first_name) {
          callerName = contact.first_name;
          console.log("[ContactCenter] Using first_name only:", callerName);
        } else if (contact.last_name) {
          callerName = contact.last_name;
          console.log("[ContactCenter] Using last_name only:", callerName);
        } else {
          console.warn(
            "[ContactCenter] ⚠️ Contact found but no name fields available:",
            contact
          );
        }

        if (callerName) {
          console.log(
            "[ContactCenter] 📝 Updating interaction",
            interactionId,
            "with caller name:",
            callerName
          );
          await PgDb.updateInteractionById(interactionId, {
            fromName: callerName,
          });
          console.log(
            "[ContactCenter] ✅ Successfully updated interaction with caller name:",
            callerName,
            "for number:",
            effectiveFromNumber
          );
        } else {
          console.warn(
            "[ContactCenter] ⚠️ Contact found but callerName is empty/null"
          );
        }
      } else {
        console.log(
          "[ContactCenter] ❌ No contact found for phone number:",
          effectiveFromNumber
        );
      }
    } catch (err) {
      // Contacts table might not exist, that's okay
      console.error("[ContactCenter] ❌ Error looking up customer:", err);
      console.error("[ContactCenter] Error stack:", err.stack);
    }
  } else {
    console.log(
      "[ContactCenter] ⚠️ No fromNumber provided (params:",
      fromNumber,
      "existing:",
      existingInteraction?.from_number,
      "), skipping contact lookup"
    );
  }

  // Trigger routing engine
  const { routeCall } = await import("./routing-engine.js");
  const interaction = await PgDb.findInteractionById(interactionId);
  const routingResult = await routeCall(queue.id, {
    required_skills: routingMetadata.required_skills || {},
    priority: routingMetadata.priority || 0,
    callControlId,
    callSessionId,
  });

  const selectedAgent = routingResult.success ? routingResult.agent : null;

  console.log(`[ContactCenter] Routing result for queue ${queueName}:`, {
    success: routingResult.success,
    agent: selectedAgent ? selectedAgent.username : null,
    reason: routingResult.reason || null,
    queueId: queue.id,
  });

  if (selectedAgent) {
    const agentDisplayName = [
      selectedAgent.first_name,
      selectedAgent.last_name,
    ]
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
      }
    );

    // Assign interaction to agent
    await PgDb.updateInteractionById(interactionId, {
      agentUsername: selectedAgent.username,
      state: "ringing",
      toName: agentDisplayName || selectedAgent.username,
      routingMetadata: routingMetadataWithAlerting,
      assignedAt,
    });

    assignCallToAgent(queue.id, interactionId, selectedAgent.id, assignedAt);

    // Calculate wait time
    const waitTime = Math.floor(
      (new Date().getTime() - new Date(interaction.enqueued_at).getTime()) /
        1000
    );
    await PgDb.updateInteractionById(interactionId, {
      waitTimeSeconds: waitTime,
    });

    // Automatically transfer call to agent's WebRTC client
    try {
      const { bridgeCallToAgent } = await import("./webrtc-bridge.js");
      const bridgeResult = await bridgeCallToAgent(
        callSessionId,
        callControlId,
        selectedAgent.username,
        fromNumber,
        callerName
      );

      console.log(
        `[ContactCenter] Automatically transferred call to agent ${selectedAgent.username}'s WebRTC client`,
        {
          agentCallControlId: bridgeResult.agentCallControlId,
          originalCallControlId: callControlId,
        }
      );

      // Note: bridgeCallToAgent already updates the interaction with agent_call_control_id
      // and original_call_control_id in metadata, so we don't need to update here
    } catch (bridgeError) {
      console.error(
        `[ContactCenter] Failed to automatically transfer call to agent ${selectedAgent.username}:`,
        bridgeError
      );
      // Don't fail the routing if transfer fails - agent can still answer manually
    }

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
        queuedAt: interaction.enqueued_at,
        assignedAt: new Date().toISOString(),
      },
    });

    console.log("[ContactCenter] Routed to agent:", selectedAgent.username);
  } else {
    console.log("[ContactCenter] No agent available for queue:", queueName);
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

  // For call.bridged, try to find by call_session_id first
  let interaction = null;
  if (callSessionId && eventType === "call.bridged") {
    interaction = await PgDb.findInteractionByCallSessionId(callSessionId);
  }

  // Fallback to call_control_id if not found by session
  if (!interaction && callControlId) {
    interaction = await PgDb.findInteractionByCallControlId(callControlId);
  }

  // For call.hangup, also try to find by agent_call_control_id or original_call_control_id in metadata
  // This handles cases where the interaction's call_control_id was updated to the agent's leg
  // but we receive hangup webhooks for either the agent leg or the original PSTN leg
  if (!interaction && callControlId && eventType === "call.hangup") {
    try {
      const pool = getPostgresPool();
      if (pool) {
        // Try to find by agent_call_control_id (WebRTC leg hangup)
        let result = await pool.query(
          "SELECT * FROM cc_interactions WHERE metadata->>'agent_call_control_id' = $1 AND is_contact_center = true ORDER BY created_at DESC LIMIT 1",
          [callControlId]
        );

        // If not found, try to find by original_call_control_id (PSTN leg hangup)
        if (!result.rows?.[0]) {
          result = await pool.query(
            "SELECT * FROM cc_interactions WHERE metadata->>'original_call_control_id' = $1 AND is_contact_center = true ORDER BY created_at DESC LIMIT 1",
            [callControlId]
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
          console.log(
            `[ContactCenter] Found interaction by metadata lookup (call_control_id: ${callControlId}): ${interaction.id}`
          );
        }
      }
    } catch (err) {
      console.warn(
        "[ContactCenter] Error looking up by metadata call_control_id:",
        err
      );
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
      (event) => event.type === TimelineEventTypes.ANSWERED
    );
    if (!hasAnswered) {
      const answeredAt =
        answeredTimestamp || interaction.answered_at || new Date().toISOString();
      if (interaction.assigned_at) {
        const assignedAtMs = new Date(interaction.assigned_at).getTime();
        const answeredAtMs = new Date(answeredAt).getTime();
        if (!Number.isNaN(assignedAtMs) && !Number.isNaN(answeredAtMs)) {
          const durationSeconds = Math.max(
            0,
            Math.floor((answeredAtMs - assignedAtMs) / 1000)
          );
          const hasAlerting = timeline.some(
            (event) => event.type === "alerting"
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
        }
      );
    }
    return nextMetadata;
  };

  switch (eventType) {
    case "call.answered":
      // call.answered fires when the agent actually answers
      // For transferred calls, this is when we should set state to "connected"
      if (!interaction.answered_at) {
        const answeredAt = payload?.answered_at || new Date().toISOString();
        updates.answeredAt = answeredAt;
        updates.state = "connected";
        // Ensure alerting (ringing) segment exists before answered
        if (interaction.assigned_at) {
          const assignedAtMs = new Date(interaction.assigned_at).getTime();
          const answeredAtMs = new Date(answeredAt).getTime();
          if (!Number.isNaN(assignedAtMs) && !Number.isNaN(answeredAtMs)) {
            const durationSeconds = Math.max(
              0,
              Math.floor((answeredAtMs - assignedAtMs) / 1000)
            );
            const existingTimeline = updatedRoutingMetadata.timeline || [];
            const hasAlerting = existingTimeline.some(
              (event) => event.type === "alerting"
            );
            if (!hasAlerting) {
              updatedRoutingMetadata = addTimelineEvent(
                updatedRoutingMetadata,
                "alerting",
                {
                  timestamp: interaction.assigned_at,
                  alertingDurationSeconds: durationSeconds,
                }
              );
            }
          }
        }
        // Add timeline event for answered
        updatedRoutingMetadata = addTimelineEvent(
          updatedRoutingMetadata,
          TimelineEventTypes.ANSWERED,
          {
            timestamp: answeredAt,
            agentUsername: interaction.agent_username,
          }
        );
        updates.routingMetadata = updatedRoutingMetadata;
      }
      break;

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
            callState.toLowerCase()
          ));

      if (shouldSetConnected) {
        const answeredAt =
          interaction.answered_at || new Date().toISOString();
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
              Math.floor((answeredAtMs - assignedAtMs) / 1000)
            );
            const existingTimeline = updatedRoutingMetadata.timeline || [];
            const hasAlerting = existingTimeline.some(
              (event) => event.type === "alerting"
            );
            if (!hasAlerting) {
              updatedRoutingMetadata = addTimelineEvent(
                updatedRoutingMetadata,
                "alerting",
                {
                  timestamp: interaction.assigned_at,
                  alertingDurationSeconds: durationSeconds,
                }
              );
            }
          }
        }
        // Add timeline event for answered if missing
        const existingTimeline = updatedRoutingMetadata.timeline || [];
        const hasAnswered = existingTimeline.some(
          (event) => event.type === TimelineEventTypes.ANSWERED
        );
        if (!hasAnswered) {
          updatedRoutingMetadata = addTimelineEvent(
            updatedRoutingMetadata,
            TimelineEventTypes.ANSWERED,
            {
              timestamp: answeredAt,
              agentUsername: interaction.agent_username,
            }
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
          (event) => event.type === TimelineEventTypes.CONNECTED
        );
        if (!hasConnectedEvent) {
          updatedRoutingMetadata = addTimelineEvent(
            updatedRoutingMetadata,
            TimelineEventTypes.CONNECTED,
            {
              agentUsername: interaction.agent_username,
            }
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
        console.log(
          `[ContactCenter] call.bridged for transferred call (still ringing), keeping state as "ringing". callControlId: ${callControlId}, isAgentLeg: ${isAgentLeg}, callState: ${callState}, wasAlreadyAnswered: ${wasAlreadyAnswered}`
        );
      }
      updates.routingMetadata = updatedRoutingMetadata;
      break;

    case "call.hangup":
      console.log(
        `[ContactCenter] call.hangup received for interaction ${interaction.id} (call_control_id: ${callControlId}, state: ${interaction.state}, completed_at: ${interaction.completed_at}, abandoned_at: ${interaction.abandoned_at})`
      );

      // Skip if already completed or abandoned (prevents duplicate processing from multiple leg hangups)
      if (
        interaction.state === "completed" ||
        interaction.state === "abandoned" ||
        interaction.completed_at ||
        interaction.abandoned_at
      ) {
        console.log(
          `[ContactCenter] Skipping hangup - interaction ${interaction.id} already ${interaction.state}`
        );
        return; // Already processed
      }

      const finalState =
        interaction.state === "queued" ? "abandoned" : "completed";
      updates.state = finalState;
      console.log(
        `[ContactCenter] Marking interaction ${interaction.id} as ${finalState}`
      );

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
                  (enqueuedAtMs || new Date(interaction.created_at).getTime())) /
                  1000
              )
            : enqueuedAtMs
              ? Math.floor((completedAtMs - enqueuedAtMs) / 1000)
              : 0);

        let holdDurationSeconds = interaction.hold_duration_seconds || 0;
        if (interaction.metadata?.current_hold_started_at) {
          const holdStartMs = new Date(
            interaction.metadata.current_hold_started_at
          ).getTime();
          if (!Number.isNaN(holdStartMs)) {
            holdDurationSeconds += Math.max(
              0,
              Math.floor((completedAtMs - holdStartMs) / 1000)
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
          handleTimeSeconds - Math.max(0, waitTimeSeconds) - holdDurationSeconds
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
          }
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
                1000
            )
          );
        }
        // Add timeline event for disconnected (abandoned)
        updatedRoutingMetadata = addTimelineEvent(
          updatedRoutingMetadata,
          TimelineEventTypes.DISCONNECTED,
          {
            reason: "abandoned",
            hangupCause: payload?.hangup_cause || null,
          }
        );
      }
      updates.routingMetadata = updatedRoutingMetadata;
      break;

    case "call.dequeued":
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
        holdTimestamp
      );
      updatedRoutingMetadata = addTimelineEvent(
        updatedRoutingMetadata,
        TimelineEventTypes.HOLD,
        {
          timestamp: holdTimestamp,
          holdNumber: holdCount,
        }
      );
      updates.routingMetadata = updatedRoutingMetadata;
      break;
    }

    case "call.unheld": {
      const resumeTimestamp = payload?.occurred_at || new Date().toISOString();
      updatedRoutingMetadata = ensureAnsweredTimeline(
        updatedRoutingMetadata,
        resumeTimestamp
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
              1000
          )
        );
        holdDurationSeconds += duration;
        updatedRoutingMetadata = addTimelineEvent(
          updatedRoutingMetadata,
          TimelineEventTypes.RESUME,
          {
            timestamp: resumeTimestamp,
            holdDuration: duration,
          }
        );
      } else {
        updatedRoutingMetadata = addTimelineEvent(
          updatedRoutingMetadata,
          TimelineEventTypes.RESUME,
          {
            timestamp: resumeTimestamp,
            holdDuration: null,
          }
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
        console.log(
          `[ContactCenter] Recording saved for interaction ${interaction.id}: ${recordingUrl}`
        );
      }
      break;
  }

  if (Object.keys(updates).length > 0) {
    await PgDb.updateInteractionById(interaction.id, updates);

    // Update in-memory state for realtime metrics
    if (eventType === "call.answered" && updates.answeredAt) {
      answerCall(interaction.id, updates.answeredAt);
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
    console.warn("[TranscriptionHandler] Missing required data");
    return;
  }

  // Only process final transcriptions
  if (!transcriptionData.is_final) {
    return;
  }

  console.log("[TranscriptionHandler] Processing transcription:", {
    callControlId,
    transcript: transcriptionData.transcript,
    track: transcriptionData.transcription_track,
  });

  // Find the interaction by call_control_id
  // Try call_control_id first, then call_session_id as fallback (like in demo portal)
  let interaction = await PgDb.findInteractionByCallControlId(callControlId);

  // If not found by call_control_id, try by call_session_id
  // (in case the call_control_id format differs between webhooks)
  if ((!interaction || !interaction.is_contact_center) && payload?.call_session_id) {
    interaction = await PgDb.findInteractionByCallSessionId(payload.call_session_id);
    if (interaction) {
      console.log(
        `[TranscriptionHandler] Found interaction by call_session_id: ${payload.call_session_id}`
      );
    }
  }

  if (!interaction || !interaction.is_contact_center) {
    console.log(
      "[TranscriptionHandler] Not a contact center interaction, skipping"
    );
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

    console.log(
      "[TranscriptionHandler] Broadcasted transcription to agent:",
      interaction.agent_username
    );
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
