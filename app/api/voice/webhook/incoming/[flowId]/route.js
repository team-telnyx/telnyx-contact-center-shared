import { NextResponse } from "next/server";
import { VoiceFlowDb } from "@/lib/pgdb-voice-flows.js";
import { verifyTelnyxSignature } from "@/lib/telnyx-webhooks.js";
import {
  executeFlowNode,
  shouldContinueImmediately,
  determineNextNodes,
} from "@/lib/voice-flow-engine.js";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { addWebhookEvent } from "@/lib/call-monitor-store.js";
import { logCallEvent } from "@/lib/call-logger.js";
import { getValueByPath } from "@/lib/variable-utils.js";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { VOICE_FLOW_NODES } from "@/config/voice-flow-nodes.js";
import {
  addTimelineEvent,
  TimelineEventTypes,
} from "@/lib/contact-center/call-timeline-tracker.js";

// Track executed transitions to prevent duplicate execution
// Key: `${call_control_id}:${from_node_id}:${to_node_id}`
// Value: timestamp
const executedTransitions = new Map();

// Track completed flows (flows that reached a terminal node with no outgoing edges)
// Key: `${call_control_id}:${flowId}`
// Value: timestamp
const completedFlows = new Map();

const AI_CALL_ID_HEADER = "X-AI-Call-ID";

function findCustomHeader(headers, name) {
  if (!Array.isArray(headers)) return null;
  return headers.find(
    (header) =>
      String(header?.name || "").toLowerCase() === String(name).toLowerCase()
  );
}

async function updateConversationMetadata(conversationId, metadata) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey || !conversationId) return null;
  const baseUrl = buildTelnyxV2Url(
    `/ai/conversations/${encodeURIComponent(conversationId)}`
  );
  try {
    const currentRes = await fetch(baseUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!currentRes.ok) {
      const text = await currentRes.text();
      console.warn(
        "[IncomingFlowWebhook] Failed to fetch conversation metadata:",
        currentRes.status,
        text
      );
      return null;
    }
    const currentData = await currentRes.json();
    const currentMetadata =
      currentData?.data?.metadata && typeof currentData.data.metadata === "object"
        ? currentData.data.metadata
        : {};
    const merged = {
      ...currentMetadata,
      ...metadata,
    };
    const updateRes = await fetch(baseUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ metadata: merged }),
    });
    if (!updateRes.ok) {
      const text = await updateRes.text();
      console.warn(
        "[IncomingFlowWebhook] Failed to update conversation metadata:",
        updateRes.status,
        text
      );
      return null;
    }
    return await updateRes.json();
  } catch (err) {
    console.warn(
      "[IncomingFlowWebhook] Error updating conversation metadata:",
      err
    );
    return null;
  }
}

/**
 * Incoming Call Webhook Handler
 * This webhook should be configured in the Telnyx voice application
 * It triggers flows with an "incoming_call" initiator node
 */

export async function POST(request, { params }) {
  try {
    // Clean up old transitions and completed flows (older than 5 minutes)
    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    for (const [key, timestamp] of executedTransitions.entries()) {
      if (timestamp < fiveMinutesAgo) {
        executedTransitions.delete(key);
      }
    }
    for (const [key, timestamp] of completedFlows.entries()) {
      if (timestamp < fiveMinutesAgo) {
        completedFlows.delete(key);
      }
    }

    const { flowId } = await params;
    if (!flowId) {
      return NextResponse.json(
        { ok: false, error: "Flow ID is required" },
        { status: 400 }
      );
    }

    // Get raw body for signature verification
    const rawBody = await request.text();

    // Verify Telnyx signature (optional but recommended)
    const isValid = await verifyTelnyxSignature(request, rawBody);
    if (!isValid) {
      console.warn("Invalid Telnyx signature - proceeding anyway");
      // Uncomment to enforce signature validation:
      return NextResponse.json(
        { ok: false, error: "Invalid signature" },
        { status: 401 }
      );
    }

    // Parse the body
    const body = JSON.parse(rawBody || "{}");
    const event = body?.data?.event_type;

    // Log call event to database
    try {
      await logCallEvent(body);
    } catch (err) {
      console.error("[incoming-flow-webhook] Error logging call:", err);
    }

    // Store webhook in memory for monitoring
    const callControlId = body?.data?.payload?.call_control_id;
    if (callControlId) {
      addWebhookEvent(callControlId, event, body, flowId);
    }

    // Extract webhook data into variables (needed for call.enqueued handling)
    const payload = body?.data?.payload || {};

    // Get the flow (without username filter to allow any user's flow to be triggered)
    const flow = await VoiceFlowDb.getFlowById(flowId, null);

    // Handle call.initiated - Check for transfer legs (both incoming and outbound directions)
    // Transfer legs to WebRTC clients can be either direction
    if (event === "call.initiated") {
      // Check if this is a transfer leg first (before checking direction)
      const toField = payload.to || "";
      const isTransferLeg =
        toField.startsWith("sip:") && toField.includes("@sip.telnyx.com");

      console.log(`[IncomingFlowWebhook] call.initiated received:`, {
        callControlId: payload.call_control_id,
        direction: payload.direction,
        to: payload.to,
        from: payload.from,
        isTransferLeg,
      });

      if (isTransferLeg) {
        console.log(
          `[IncomingFlowWebhook] ✅ Detected transfer leg (direction: ${payload.direction}): ${payload.call_control_id}, to: ${payload.to}, from: ${payload.from}`
        );
        // Handle transfer leg regardless of direction
        try {
          const { PgDb } = await import("@/lib/pgdb.js");
          // This is a transfer leg to an agent's WebRTC client
          // Find the original interaction using custom headers or call_session_id
          let originalInteraction = null;

          // Try to find by custom headers first (from transfer)
          const customHeaders = payload.custom_headers || [];
          const originalCallControlIdHeader = customHeaders.find(
            (h) => h.name === "X-Original-Call-Control-Id"
          );
          const originalCallSessionIdHeader = customHeaders.find(
            (h) => h.name === "X-Original-Call-Session-Id"
          );

          if (originalCallControlIdHeader?.value) {
            originalInteraction = await PgDb.findInteractionByCallControlId(
              originalCallControlIdHeader.value
            );
          }

          // Fallback: try by call_session_id (both legs share the same session)
          if (!originalInteraction && payload.call_session_id) {
            originalInteraction = await PgDb.findInteractionByCallSessionId(
              payload.call_session_id
            );
          }

          if (originalInteraction) {
            // Update the original interaction with the agent's call_control_id
            // Keep call_control_id as the original incoming leg.
            const metadata = originalInteraction.metadata || {};
            metadata.agent_call_control_id = payload.call_control_id;

            // Store the ORIGINAL queued call's call_control_id (before transfer)
            // This is needed for issuing commands to the original call leg
            // If original_call_control_id is not already set, use the interaction's current call_control_id
            if (!metadata.original_call_control_id) {
              metadata.original_call_control_id =
                originalInteraction.call_control_id;
            }

            await PgDb.updateInteractionById(originalInteraction.id, {
              metadata,
            });

            console.log(
              `[IncomingFlowWebhook] ✅ Linked transfer leg ${payload.call_control_id} to interaction ${originalInteraction.id}, original_call_control_id: ${metadata.original_call_control_id}`
            );

            // Broadcast incoming_call_info to WebRTC client now that we have the agent's call_control_id
            // This is critical for the WebRTC client to show the ringing state
            if (originalInteraction.agent_username) {
              try {
                const { broadcastToKey } = await import("@/lib/sse");
                const { storeIncomingCallData } = await import(
                  "@/lib/incoming-call-store"
                );
                const { PgDb: PgDbForUser } = await import("@/lib/pgdb.js");

                // Get agent user ID for SSE broadcast
                const agent = await PgDbForUser.findUserByUsername(
                  originalInteraction.agent_username
                );

                if (agent?.id) {
                  // Get caller info from interaction
                  const fromNumber = originalInteraction.from_number;
                  const fromName = originalInteraction.from_name;

                  console.log(
                    `[IncomingFlowWebhook] Preparing to broadcast incoming_call_info:`,
                    {
                      agentUsername: originalInteraction.agent_username,
                      agentId: agent.id,
                      callControlId: payload.call_control_id,
                      fromNumber,
                      fromName,
                      originalCallControlId: metadata.original_call_control_id,
                    }
                  );

                  // Store caller info for WebRTC client lookup
                  if (payload.call_session_id) {
                    storeIncomingCallData(
                      `session:${payload.call_session_id}`,
                      {
                        fromNumber: fromNumber,
                        fromName: fromName,
                        callControlId: payload.call_control_id,
                        originalCallControlId:
                          metadata.original_call_control_id,
                        callSessionId: payload.call_session_id,
                        interactionId: originalInteraction.id,
                      }
                    );
                  }

                  storeIncomingCallData(payload.call_control_id, {
                    fromNumber: fromNumber,
                    fromName: fromName,
                    callControlId: payload.call_control_id,
                    originalCallControlId: metadata.original_call_control_id,
                    callSessionId: payload.call_session_id,
                    interactionId: originalInteraction.id,
                  });

                  // Broadcast to WebRTC client via SSE
                  broadcastToKey(`user:status:${agent.id}`, {
                    type: "incoming_call_info",
                    callControlId: payload.call_control_id,
                    fromNumber: fromNumber,
                    fromName: fromName,
                    originalCallControlId: metadata.original_call_control_id,
                    callSessionId: payload.call_session_id,
                    interactionId: originalInteraction.id,
                    contactCenter: {
                      interactionId: originalInteraction.id,
                      queueName: originalInteraction.queue_name,
                      queuedAt:
                        originalInteraction.enqueued_at ||
                        originalInteraction.created_at,
                      assignedAt:
                        originalInteraction.assigned_at ||
                        new Date().toISOString(),
                    },
                  });

                  console.log(
                    `[IncomingFlowWebhook] ✅ Broadcasted incoming_call_info to agent ${originalInteraction.agent_username} (call_control_id: ${payload.call_control_id})`
                  );
                }
              } catch (err) {
                console.error(
                  "[IncomingFlowWebhook] Error broadcasting incoming_call_info:",
                  err
                );
              }
            }
          } else {
            console.warn(
              `[IncomingFlowWebhook] Transfer leg ${payload.call_control_id} but could not find original interaction`
            );
          }

          // Don't process transfer legs further
          return NextResponse.json({
            ok: true,
            message: "Transfer leg ignored",
          });
        } catch (err) {
          console.error(
            "[IncomingFlowWebhook] Error handling transfer leg:",
            err
          );
          // Don't fail the webhook, just log the error
        }
      }

      // Handle regular incoming calls (not transfer legs)
      if (payload.direction === "incoming" && !isTransferLeg) {
        try {
          const { PgDb } = await import("@/lib/pgdb.js");
          const aiCallHeader = findCustomHeader(
            payload.custom_headers || [],
            AI_CALL_ID_HEADER
          );
          const aiCallControlId = aiCallHeader?.value || null;

          // Check if interaction already exists for this call_control_id
          const existingInteraction = await PgDb.findInteractionByCallControlId(
            payload.call_control_id
          );

          if (!existingInteraction) {
            // Add timeline event for initiated
            const routingMetadata = addTimelineEvent(
              null,
              TimelineEventTypes.INITIATED,
              {
                from: payload.from,
                to: payload.to,
                direction: payload.direction,
                flowId: flowId,
              }
            );

            // Create interaction record for incoming call
            // This will be updated when call.enqueued is received
            // For now, mark it as not visible to agents (is_contact_center: false, state: "initiated")
            // queue_name is required by DB schema, so we use "PENDING" as placeholder until enqueued
            const interactionId = await PgDb.insertInteraction({
              interactionType: "voice",
              queueName: "PENDING", // Placeholder, will be updated when call.enqueued is received
              callControlId: payload.call_control_id,
              callSessionId: payload.call_session_id || null,
              callLegId: payload.call_leg_id || null,
              direction: "inbound",
              state: "queued", // Use valid state (will be updated when enqueued)
              isContactCenter: false, // Not yet enqueued, so not visible to agents
              fromNumber: payload.from || null,
              toNumber: payload.to || null,
              flowId: flowId,
              routingMetadata: routingMetadata,
              metadata: {
                flow_owner: flow?.username || null,
                initiated_at: payload.occurred_at || new Date().toISOString(),
                ...(aiCallControlId
                  ? { ai_call_control_id: aiCallControlId }
                  : {}),
              },
            });

            console.log(
              `[IncomingFlowWebhook] ✅ Registered incoming call ${payload.call_control_id} to cc_interactions (ID: ${interactionId})`
            );
          }
          if (
            existingInteraction &&
            aiCallControlId &&
            !existingInteraction?.metadata?.ai_call_control_id
          ) {
            const metadata = {
              ...(existingInteraction.metadata || {}),
              ai_call_control_id: aiCallControlId,
            };
            await PgDb.updateInteractionById(existingInteraction.id, {
              metadata,
            });
          }
        } catch (err) {
          console.error(
            "[IncomingFlowWebhook] Error registering incoming call:",
            err
          );
          // Don't fail the webhook, just log the error
        }
      }
    }

    if (event === "call.conversation.created") {
      try {
        const conversationId =
          payload.conversation_id ||
          payload.conversationId ||
          payload?.conversation?.id ||
          null;
        if (conversationId) {
          const { PgDb } = await import("@/lib/pgdb.js");
          let interaction = null;
          if (payload.call_control_id) {
            interaction = await PgDb.findInteractionByCallControlId(
              payload.call_control_id
            );
          }
          if (!interaction && payload.call_session_id) {
            interaction = await PgDb.findInteractionByCallSessionId(
              payload.call_session_id
            );
          }
          if (!interaction && payload.call_leg_id) {
            interaction = await PgDb.findInteractionByCallLegId(
              payload.call_leg_id
            );
          }
          const aiCallControlId =
            interaction?.metadata?.ai_call_control_id || null;

          if (aiCallControlId) {
            await updateConversationMetadata(conversationId, {
              call_control_id: String(aiCallControlId),
            });

            if (interaction?.id) {
              const metadata = {
                ...(interaction?.metadata || {}),
                ai_call_control_id: aiCallControlId,
                ai_conversation_id: conversationId,
              };
              await PgDb.updateInteractionById(interaction.id, {
                metadata,
              });
            }
          }
        }
      } catch (err) {
        console.error(
          "[IncomingFlowWebhook] Error linking conversation metadata:",
          err
        );
      }
    }

    // Handle Contact Center events (call.enqueued, call.bridged, etc.)
    // Note: Contact center event handling is integrated into the main flow execution
    // Additional contact center-specific handlers can be added here if needed

    // Handle Contact Center call.enqueued events
    if (event === "call.enqueued") {
      try {
        const queueName = payload.queue;
        if (queueName) {
          try {
            const { handleContactCenterEnqueue } = await import(
              "@/lib/contact-center/webhook-handler.js"
            );
            const { isContactCenterQueue } = await import(
              "@/lib/contact-center/queue-utils.js"
            );

            if (isContactCenterQueue(queueName)) {
              // Get flow owner username
              const flow = await VoiceFlowDb.getFlowById(flowId, null);
              const flowOwner = flow?.username || null;

              console.log("[IncomingFlowWebhook] call.enqueued payload:", {
                call_control_id: payload.call_control_id,
                call_session_id: payload.call_session_id,
                from: payload.from,
                to: payload.to,
                direction: payload.direction,
                queue: queueName,
              });

              await handleContactCenterEnqueue({
                callControlId: payload.call_control_id,
                callSessionId: payload.call_session_id,
                callLegId: payload.call_leg_id,
                queueName,
                currentPosition: payload.current_position,
                queueAvgWaitTimeSecs: payload.queue_avg_wait_time_secs,
                clientState: payload.client_state,
                flowId,
                flowOwnerUsername: flowOwner,
                fromNumber: payload.from,
                toNumber: payload.to,
                direction: payload.direction,
              });
            }
          } catch (err) {
            console.error(
              "[IncomingFlowWebhook] Error handling contact center enqueue:",
              err
            );
            // Don't fail the webhook, just log the error
          }
        }
      } catch (err) {
        console.error(
          "[IncomingFlowWebhook] Error handling contact center enqueue:",
          err
        );
        // Don't fail the webhook, just log the error
      }
    }

    // Handle other Contact Center events (call.answered, call.bridged, call.dequeued, call.held, call.unheld, call.hangup)
    if (
      event === "call.answered" ||
      event === "call.bridged" ||
      event === "call.dequeued" ||
      event === "call.held" ||
      event === "call.unheld" ||
      event === "call.hangup"
    ) {
      try {
        const { handleContactCenterEvent } = await import(
          "@/lib/contact-center/webhook-handler.js"
        );
        await handleContactCenterEvent(event, payload);
      } catch (err) {
        console.error(
          `[IncomingFlowWebhook] Error handling contact center event ${event}:`,
          err
        );
        // Don't fail the webhook, just log the error
      }
    }

    // Handle call.transcription for Agent Assist
    if (event === "call.transcription") {
      try {
        const { handleTranscriptionEvent } = await import(
          "@/lib/contact-center/webhook-handler.js"
        );
        await handleTranscriptionEvent(payload);
      } catch (err) {
        console.error(
          "[IncomingFlowWebhook] Error handling transcription event:",
          err
        );
        // Don't fail the webhook, just log the error
      }
    }
    if (!flow) {
      return NextResponse.json(
        { ok: false, error: "Flow not found" },
        { status: 404 }
      );
    }

    // Find the incoming call initiator node
    const incomingCallNode = flow.nodes?.find(
      (node) => node.data?.nodeType === "incoming_call"
    );

    if (!incomingCallNode) {
      return NextResponse.json(
        {
          ok: false,
          error: "Flow does not have an incoming call trigger",
        },
        { status: 400 }
      );
    }

    // Verify that the voice application ID matches (if configured)
    const configuredAppId = incomingCallNode.data?.config?.voice_application_id;
    const receivedAppId = body?.data?.payload?.connection_id;

    if (configuredAppId && receivedAppId && configuredAppId !== receivedAppId) {
      console.warn(
        `Voice application mismatch: expected ${configuredAppId}, received ${receivedAppId}`
      );
      // We'll still process it, but log the warning
    }

    // Extract webhook data into variables (payload already extracted above)
    const variables = {
      // Event information
      event_type: event,
      occurred_at: body?.data?.occurred_at,
      record_type: body?.data?.record_type,

      // Call information
      call_control_id: payload.call_control_id,
      call_leg_id: payload.call_leg_id,
      call_session_id: payload.call_session_id,
      connection_id: payload.connection_id,
      client_state: payload.client_state,

      // Caller information
      from: payload.from,
      to: payload.to,
      direction: payload.direction,

      // State
      state: payload.state,

      // Full payload for advanced use cases
      payload: payload,

      // Metadata
      trigger_type: "incoming_call",
      flow_id: flowId,
    };

    // Handle different event types
    if (event === "call.initiated") {
      // Only trigger for incoming calls, not outgoing calls (e.g., from transfer nodes)
      if (payload.direction !== "incoming") {
        return NextResponse.json({
          ok: true,
          message: `Call initiated but direction is ${payload.direction}, expected "incoming"`,
          variables,
        });
      }

      // Find all next nodes after the incoming_call initiator (supports parallel execution)
      const nextNodes = findNextNodes(flow, incomingCallNode.id);

      // Process edge variable mappings for edges from incoming_call node
      const edges = flow.edges || [];
      const matchingEdges = edges.filter(
        (e) => e.source === incomingCallNode.id
      );

      // Process edge variable mappings
      matchingEdges.forEach((edge) => {
        if (
          edge.data?.variableMappings &&
          Array.isArray(edge.data.variableMappings)
        ) {
          const extractedVariables = {};
          edge.data.variableMappings.forEach((mapping) => {
            const { variableName, sourcePath } = mapping;
            if (!variableName || !sourcePath) return;

            const value = getValueByPath({ payload }, sourcePath);
            if (value !== undefined) {
              extractedVariables[variableName] = value;
            }
          });
          // Merge extracted variables into the main variables object
          Object.assign(variables, extractedVariables);
        }
      });

      if (nextNodes.length > 0) {
        // If there are multiple nodes, execute them in parallel
        try {
          const results = await Promise.all(
            nextNodes.map(async (node) => {
              // Configure node with client_state for flow continuation
              const existingConfig = node.data?.config || {};
              const configuredNode = {
                ...node,
                data: {
                  ...node.data,
                  config: {
                    ...existingConfig,
                    // Always set client_state for flow tracking
                    client_state: Buffer.from(
                      JSON.stringify({
                        flowId,
                        currentNodeId: node.id,
                      })
                    ).toString("base64"),
                  },
                },
              };

              // Execute the node
              const executionState = {
                variables: { ...variables },
                flowId,
                currentNodeId: node.id,
              };

              const result = await executeFlowNode(
                configuredNode,
                payload.call_control_id,
                body,
                executionState
              );

              return { node, result };
            })
          );

          // Check if any of the executed nodes was record_start with output 0
          for (const { node, result } of results) {
            const handled = await handleRecordStartNode(
              node,
              result,
              flow,
              payload.call_control_id,
              body,
              variables,
              flowId
            );
          }

          // After executing initial nodes, check if any are logical nodes that should continue immediately
          // Logical nodes: http_request, set_variable, condition, switch, logic_gate
          // Telephony nodes: answer, speak, playback, etc. - these STOP and WAIT for webhook

          for (const { node, result } of results) {
            const nodeType = node.data?.nodeType || node.type;

            if (!result.success) {
              continue;
            }

            // Check if this is a logical node that should continue immediately
            const logicalNodeTypes = [
              "http_request_action",
              "set_variable",
              "condition",
              "switch",
              "logic_gate",
              "flow_end",
            ];

            const isLogical = logicalNodeTypes.includes(nodeType);

            if (isLogical) {
              // Logical nodes execute and immediately continue to next node

              await executeNodeChain(
                node,
                result,
                flow,
                payload.call_control_id,
                body,
                variables,
                flowId
              );
            } else {
              // Telephony node - execution sent command, now STOP and WAIT for webhook
            }
          }

          // Store variables in database for persistence between webhook calls
          try {
            // Create execution record if it doesn't exist
            await VoiceFlowDb.createFlowExecution(
              flowId,
              payload.call_control_id
            );
            await VoiceFlowDb.updateFlowExecution(payload.call_control_id, {
              variables,
              execution_history: [],
            });
          } catch (error) {
            console.error(
              `[IncomingWebhook] Failed to store variables in database:`,
              error
            );
          }

          return NextResponse.json({
            ok: true,
            message: "Call initiated - flow execution started",
            executed_nodes: results.map((r) => r.node.data?.nodeType),
            results: results.map((r) => r.result),
          });
        } catch (error) {
          console.error(`[Incoming Call] Error executing node:`, error);
          return NextResponse.json(
            {
              ok: false,
              error: "Failed to execute flow node",
              details: error.message,
            },
            { status: 500 }
          );
        }
      } else {
        console.warn(`[Incoming Call] No next node configured after initiator`);

        // Store variables in database for persistence between webhook calls
        try {
          // Create execution record if it doesn't exist
          await VoiceFlowDb.createFlowExecution(
            flowId,
            payload.call_control_id
          );
          await VoiceFlowDb.updateFlowExecution(payload.call_control_id, {
            variables,
            execution_history: [],
          });
        } catch (error) {
          console.error(
            `[IncomingWebhook] Failed to store variables in database:`,
            error
          );
        }

        return NextResponse.json({
          ok: true,
          message: "Call initiated but no next node configured",
          variables,
        });
      }
    }

    // Check if this flow has already completed
    const flowCompletionKey = `${payload.call_control_id}:${flowId}`;
    if (completedFlows.has(flowCompletionKey)) {
      return NextResponse.json({
        ok: true,
        message: "Flow already completed",
        variables,
      });
    }

    // Handle call.hangup - remove from Interactions and update phone state
    if (event === "call.hangup") {
      try {
        const { PgDb } = await import("@/lib/pgdb.js");
        const { broadcastToKey } = await import("@/lib/sse.js");
        const { callTelnyxAction } = await import("@/lib/voice-flow-engine.js");

        const callControlId = payload.call_control_id;
        const callSessionId = payload.call_session_id;
        const hangupCause = payload.hangup_cause;

        console.log("[IncomingFlowWebhook] call.hangup received:", {
          callControlId,
          callSessionId,
          hangupCause,
        });

        // Check if this is a rejected WebRTC call (user_busy or timeout)
        // In this case, we need to hangup the original incoming call leg
        if (
          (hangupCause === "user_busy" || hangupCause === "timeout") &&
          callSessionId
        ) {
          console.log(
            "[IncomingFlowWebhook] Detected rejected WebRTC call, looking for original call leg..."
          );

          try {
            const { getPostgresPool } = await import("@/lib/postgres.mjs");
            const pool = getPostgresPool();

            if (pool) {
              // Find all call legs in this session from cc_interactions table
              const calls = await pool.query(
                "SELECT call_control_id, direction, state FROM cc_interactions WHERE call_session_id = $1 ORDER BY created_at ASC",
                [callSessionId]
              );

              console.log(
                `[IncomingFlowWebhook] Found ${
                  calls.rows?.length || 0
                } call legs in session:`,
                {
                  currentCallControlId: callControlId,
                  legs: calls.rows?.map((c) => ({
                    call_control_id: c.call_control_id,
                    direction: c.direction,
                    state: c.state,
                    matches: c.call_control_id !== callControlId,
                  })),
                }
              );

              // Find the other call leg (the one that's not the current WebRTC leg that hung up)
              // This works for both incoming and outgoing calls transferred to agents
              const originalCall = calls.rows?.find(
                (call) => call.call_control_id !== callControlId
              );

              if (originalCall) {
                console.log(
                  `[IncomingFlowWebhook] Found original call leg: ${originalCall.call_control_id}, hanging up...`
                );

                // Hangup the original call leg
                const result = await callTelnyxAction(
                  flowId,
                  "hangup",
                  originalCall.call_control_id,
                  {}
                );

                if (result.success) {
                  console.log(
                    `[IncomingFlowWebhook] ✅ Successfully hung up original call leg: ${originalCall.call_control_id}`
                  );
                } else {
                  console.warn(
                    `[IncomingFlowWebhook] ⚠️ Failed to hangup original call leg: ${result.error}`
                  );
                }
              } else {
                console.log(
                  "[IncomingFlowWebhook] No original call leg found to hangup"
                );
              }

              // Update the interaction state instead of calls table
              try {
                const { PgDb } = await import("@/lib/pgdb.js");
                const interaction = await PgDb.findInteractionByCallControlId(
                  callControlId
                );
                if (interaction) {
                  await PgDb.updateInteractionById(interaction.id, {
                    state: "completed",
                  });
                  console.log(
                    `[IncomingFlowWebhook] Updated interaction state to completed: ${interaction.id}`
                  );
                }
              } catch (err) {
                console.error(
                  "[IncomingFlowWebhook] Error updating interaction state:",
                  err
                );
              }
            } else {
              console.warn("[IncomingFlowWebhook] Postgres pool not available");
            }
          } catch (err) {
            console.error(
              "[IncomingFlowWebhook] Error hanging up original call leg:",
              err
            );
            // Don't fail the webhook processing
          }
        }

        // Note: The actual interaction update, timeline event, and SSE broadcast
        // are all handled by handleContactCenterEvent which is called above.
      } catch (err) {
        console.error("[IncomingFlowWebhook] Error handling call.hangup:", err);
        // Don't fail the webhook, just log the error
      }

      return NextResponse.json({
        ok: true,
        message: "Call ended",
        variables,
      });
    }

    // Handle call.recording.saved - store recording payload in metadata
    if (event === "call.recording.saved") {
      try {
        const { handleContactCenterEvent } = await import(
          "@/lib/contact-center/webhook-handler.js"
        );
        await handleContactCenterEvent(event, payload);
      } catch (err) {
        console.error(
          "[IncomingFlowWebhook] Error handling call.recording.saved:",
          err
        );
      }
    }

    // Try to decode client_state to get current execution info
    let currentNodeId = null;
    try {
      const clientState = payload.client_state;
      if (clientState) {
        const decoded = JSON.parse(
          Buffer.from(clientState, "base64").toString("utf-8")
        );
        currentNodeId = decoded.currentNodeId;
      }
    } catch (e) {
      // Ignore client_state decode errors
    }

    // If we have a current node, find the next one(s) and execute them
    if (currentNodeId) {
      const currentNode = flow.nodes.find((n) => n.id === currentNodeId);
      if (currentNode) {
        // Retrieve latest variables from database to ensure we have the most up-to-date values
        const execution = await VoiceFlowDb.getFlowExecution(
          payload.call_control_id
        );
        if (execution && execution.variables) {
          Object.assign(variables, execution.variables);
        }
        // Find all next nodes by following connected edges for this specific event (supports parallel)
        const nextNodes = findNextNodes(flow, currentNode.id, event);

        // Process edge variable mappings for all matching edges
        const edges = flow.edges || [];
        const matchingEdges = edges.filter((e) => {
          if (e.source !== currentNode.id) return false;
          if (!e.sourceHandle || e.sourceHandle === "default") return true;
          if (e.sourceHandle === event) return true;
          if (e.sourceHandle && e.sourceHandle.startsWith("output-")) {
            const nodeDef = VOICE_FLOW_NODES[currentNode.data?.nodeType];
            const outputEvents = nodeDef?.outputEvents || [];
            const outputIndex = parseInt(
              e.sourceHandle.replace("output-", ""),
              10
            );
            if (!isNaN(outputIndex) && outputEvents[outputIndex] === event) {
              return true;
            }
          }
          return false;
        });

        // Process edge variable mappings
        matchingEdges.forEach((edge) => {
          if (
            edge.data?.variableMappings &&
            Array.isArray(edge.data.variableMappings)
          ) {
            const extractedVariables = {};
            edge.data.variableMappings.forEach((mapping) => {
              const { variableName, sourcePath } = mapping;
              if (!variableName || !sourcePath) return;

              const value = getValueByPath({ payload }, sourcePath);
              if (value !== undefined) {
                extractedVariables[variableName] = value;
              }
            });
            // Merge extracted variables into the main variables object
            Object.assign(variables, extractedVariables);
          }
        });

        if (nextNodes.length > 0) {
          // Filter out nodes that have already been executed for this event
          const nodesToExecute = nextNodes.filter((nextNode) => {
            const transitionKey = `${payload.call_control_id}:${currentNode.id}:${nextNode.id}:${event}`;
            const defaultTransitionKey = `${payload.call_control_id}:${currentNode.id}:${nextNode.id}:default`;
            // Check both event-specific and default transition keys
            if (
              executedTransitions.has(transitionKey) ||
              executedTransitions.has(defaultTransitionKey)
            ) {
              return false;
            }
            return true;
          });

          if (nodesToExecute.length === 0) {
            return NextResponse.json({
              ok: true,
              message: "All transitions already executed",
              variables,
            });
          }

          // Mark all transitions as executed
          nodesToExecute.forEach((nextNode) => {
            const transitionKey = `${payload.call_control_id}:${currentNode.id}:${nextNode.id}:${event}`;
            executedTransitions.set(transitionKey, Date.now());
          });

          // Execute all nodes in parallel
          try {
            const results = await Promise.all(
              nodesToExecute.map(async (nextNode) => {
                // Prepare node with client_state for flow tracking
                const existingConfig = nextNode.data?.config || {};
                const configuredNextNode = {
                  ...nextNode,
                  data: {
                    ...nextNode.data,
                    config: {
                      ...existingConfig,
                      // Always set client_state for flow tracking
                      client_state: Buffer.from(
                        JSON.stringify({
                          flowId,
                          currentNodeId: nextNode.id,
                        })
                      ).toString("base64"),
                    },
                  },
                };

                const executionState = {
                  variables: { ...variables },
                  flowId,
                  currentNodeId: nextNode.id,
                };

                const result = await executeFlowNode(
                  configuredNextNode,
                  payload.call_control_id,
                  body,
                  executionState
                );

                return { node: nextNode, result };
              })
            );

            // Check if any of the executed nodes was record_start with output 0
            for (const { node, result } of results) {
              const handled = await handleRecordStartNode(
                node,
                result,
                flow,
                payload.call_control_id,
                body,
                variables,
                flowId
              );
            }

            // After executing webhook-triggered nodes, check if any are logical nodes that should continue immediately

            for (const { node, result } of results) {
              const nodeType = node.data?.nodeType || node.type;

              if (!result.success) {
                continue;
              }

              // Check if this is a logical node that should continue immediately
              const logicalNodeTypes = [
                "http_request_action",
                "set_variable",
                "condition",
                "switch",
                "logic_gate",
                "flow_end",
              ];

              const isLogical = logicalNodeTypes.includes(nodeType);

              if (isLogical) {
                // Logical nodes execute and immediately continue to next node

                await executeNodeChain(
                  node,
                  result,
                  flow,
                  payload.call_control_id,
                  body,
                  variables,
                  flowId
                );
              }
            }

            // Store variables in database for persistence between webhook calls
            try {
              // Create execution record if it doesn't exist
              await VoiceFlowDb.createFlowExecution(
                flowId,
                payload.call_control_id
              );
              await VoiceFlowDb.updateFlowExecution(payload.call_control_id, {
                variables,
                execution_history: [],
              });
            } catch (error) {
              console.error(
                `[IncomingWebhook] Failed to store variables in database:`,
                error
              );
            }

            return NextResponse.json({
              ok: true,
              message: `Event ${event} processed - executed ${nodesToExecute.length} node(s)`,
              executed_nodes: results.map((r) => r.node.data?.nodeType),
              results: results.map((r) => r.result),
            });
          } catch (error) {
            console.error("[Incoming Call] Error executing nodes:", error);
            return NextResponse.json(
              {
                ok: false,
                error: "Failed to execute flow nodes",
                details: error.message,
              },
              { status: 500 }
            );
          }
        } else {
          const hasAnyEdges = flow.edges?.some(
            (e) => e.source === currentNode.id
          );

          if (!hasAnyEdges) {
            const flowCompletionKey = `${payload.call_control_id}:${flowId}`;
            completedFlows.set(flowCompletionKey, Date.now());

            return NextResponse.json({
              ok: true,
              message: "Flow completed - last node reached",
              variables,
            });
          } else {
            return NextResponse.json({
              ok: true,
              message: `No edge for event ${event}`,
              variables,
            });
          }
        }
      } else {
        return NextResponse.json({
          ok: true,
          message: "Current node not found",
          variables,
        });
      }
    } else {
      return NextResponse.json({
        ok: true,
        message: "No execution context",
        variables,
      });
    }
  } catch (error) {
    console.error("Incoming call webhook error:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * Recursively execute chain of nodes that should continue immediately
 * This handles logical nodes like http_request, set_variable, condition, etc.
 */
async function executeNodeChain(
  currentNode,
  currentResult,
  flow,
  callControlId,
  body,
  variables,
  flowId
) {
  // Retrieve latest variables from database to ensure we have the most up-to-date values
  const execution = await VoiceFlowDb.getFlowExecution(callControlId);
  if (execution && execution.variables) {
    Object.assign(variables, execution.variables);
  }

  // Merge variables from current result
  Object.assign(variables, currentResult.variables || {});

  // Determine next nodes
  const executionState = {
    variables: { ...variables },
    lastOutput: currentResult.output || 0,
  };

  const nextNodes = determineNextNodes(flow, currentNode, body, executionState);

  if (nextNodes.length === 0) {
    return;
  }

  // Execute each next node
  for (const nextNode of nextNodes) {
    const nextNodeType = nextNode.data?.nodeType || nextNode.type;

    // Check if this transition was already executed
    const transitionKey = `${callControlId}:${currentNode.id}:${nextNode.id}:${
      currentResult.output || 0
    }`;
    if (executedTransitions.has(transitionKey)) {
      continue;
    }

    // Mark this transition as executed
    executedTransitions.set(transitionKey, Date.now());

    // Configure node with client_state for flow tracking
    const existingConfig = nextNode.data?.config || {};
    const configuredNode = {
      ...nextNode,
      data: {
        ...nextNode.data,
        config: {
          ...existingConfig,
          // Set client_state so webhooks can route back to this node
          client_state: Buffer.from(
            JSON.stringify({
              flowId,
              currentNodeId: nextNode.id,
            })
          ).toString("base64"),
        },
      },
    };

    const nodeExecutionState = {
      variables: { ...variables },
      flowId,
      currentNodeId: nextNode.id,
      callControlId,
    };

    const result = await executeFlowNode(
      configuredNode,
      callControlId,
      body,
      nodeExecutionState
    );

    // Merge variables
    Object.assign(variables, result.variables || {});

    // Check if we should continue with this node's chain
    // Logical nodes execute and immediately continue
    // Telephony nodes send command and STOP (wait for webhook)
    const logicalNodeTypes = [
      "http_request_action",
      "set_variable",
      "condition",
      "switch",
      "logic_gate",
      "flow_end",
    ];
    const isLogicalNode = logicalNodeTypes.includes(nextNodeType);

    if (result.success && isLogicalNode) {
      // Logical node - continue chain immediately after execution

      // Store variables in database before continuing chain
      await VoiceFlowDb.updateFlowExecution(callControlId, {
        variables,
        execution_history: [],
      });

      await executeNodeChain(
        nextNode,
        result,
        flow,
        callControlId,
        body,
        variables,
        flowId
      );
    } else if (result.success && !isLogicalNode) {
      // Telephony node - command sent, STOP and wait for webhook

      // Store variables in database before stopping chain
      await VoiceFlowDb.updateFlowExecution(callControlId, {
        variables,
        execution_history: [],
      });
    } else {
    }
  }
}

/**
 * Handle special case for record_start node with dual outputs
 * Executes output 0 (Started) chain immediately while keeping track for output 1 (Saved) webhook
 */
async function handleRecordStartNode(
  recordStartNode,
  recordStartResult,
  flow,
  callControlId,
  body,
  variables,
  flowId
) {
  const nodeType = recordStartNode.data?.nodeType;

  if (
    nodeType !== "record_start" ||
    !recordStartResult.success ||
    recordStartResult.output !== 0
  ) {
    return false; // Not a record_start with successful output 0
  }

  // Find nodes on output 0 (Started) edge
  const executionState = {
    variables: { ...variables },
    lastOutput: 0,
  };

  const output0Nodes = determineNextNodes(
    flow,
    recordStartNode,
    body,
    executionState
  );

  if (output0Nodes.length > 0) {
    // Execute all output 0 nodes immediately
    try {
      const results = await Promise.all(
        output0Nodes.map(async (node) => {
          const configuredNode = {
            ...node,
            data: {
              ...node.data,
              config: {
                ...(node.data?.config || {}),
                client_state: Buffer.from(
                  JSON.stringify({
                    flowId,
                    currentNodeId: node.id,
                  })
                ).toString("base64"),
              },
            },
          };

          const nodeExecutionState = {
            variables: { ...variables },
            flowId,
            currentNodeId: node.id,
            callControlId,
          };

          const result = await executeFlowNode(
            configuredNode,
            callControlId,
            body,
            nodeExecutionState
          );

          return { node, result };
        })
      );

      return true; // Handled
    } catch (error) {
      console.error("[IncomingWebhook] Error executing output 0 chain:", error);
      return false;
    }
  }

  return true; // Handled (no nodes on output 0)
}

/**
 * Find all next nodes connected to a given node for a specific event (supports parallel execution)
 * @param {Object} flow - The flow object containing nodes and edges
 * @param {string} nodeId - The current node ID
 * @param {string} event - The webhook event type (e.g., "call.speak.ended")
 * @returns {Array<Object>} - Array of next nodes to execute (empty if no matching edges found)
 */
function findNextNodes(flow, nodeId, event = null) {
  const edges = flow.edges || [];
  const nodes = flow.nodes || [];

  if (!event) {
    const matchingEdges = edges.filter((e) => e.source === nodeId);
    return matchingEdges
      .map((edge) => nodes.find((n) => n.id === edge.target))
      .filter(Boolean);
  }

  const sourceNode = nodes.find((n) => n.id === nodeId);
  if (!sourceNode) return [];

  const nodeDef = VOICE_FLOW_NODES[sourceNode.data?.nodeType];
  // Use dynamic output events if available (for dial/switch nodes with conditional exits), otherwise use nodeDef
  const outputEvents =
    sourceNode.data?.dynamicOutputEvents || nodeDef?.outputEvents || [];

  const matchingEdges = edges.filter((e) => {
    if (e.source !== nodeId) return false;

    if (!e.sourceHandle || e.sourceHandle === "default") return true;

    if (e.sourceHandle === event) return true;

    if (e.sourceHandle && e.sourceHandle.startsWith("output-")) {
      const outputIndex = parseInt(e.sourceHandle.replace("output-", ""), 10);
      if (!isNaN(outputIndex) && outputEvents[outputIndex] === event) {
        return true;
      }
    }

    return false;
  });

  if (matchingEdges.length === 0) {
    return [];
  }

  return matchingEdges
    .map((edge) => nodes.find((n) => n.id === edge.target))
    .filter(Boolean);
}
