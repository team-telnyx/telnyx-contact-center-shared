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
import { VOICE_FLOW_NODES } from "@/config/voice-flow-nodes.js";

// Track executed transitions to prevent duplicate execution
// Key: `${call_control_id}:${from_node_id}:${to_node_id}`
// Value: timestamp
const executedTransitions = new Map();

// Track completed flows (flows that reached a terminal node with no outgoing edges)
// Key: `${call_control_id}:${flowId}`
// Value: timestamp
const completedFlows = new Map();

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

    // Handle call.initiated (incoming) - Register all incoming calls to cc_interactions
    if (event === "call.initiated" && payload.direction === "incoming") {
      try {
        const { PgDb } = await import("@/lib/pgdb.js");

        // Check if this is a transfer leg (TO field is a SIP URI like sip:username@sip.telnyx.com)
        // Transfer legs should NOT be presented in Interactions panel
        const toField = payload.to || "";
        const isTransferLeg =
          toField.startsWith("sip:") && toField.includes("@sip.telnyx.com");

        if (isTransferLeg) {
          // This is a transfer leg - insert into cc_interactions for call flow management
          // but mark it as not visible to agents
          const existingTransferLeg = await PgDb.findInteractionByCallControlId(
            payload.call_control_id
          );

          if (!existingTransferLeg) {
            await PgDb.insertInteraction({
              interactionType: "voice",
              queueName: "TRANSFER_LEG", // Special marker for transfer legs
              callControlId: payload.call_control_id,
              callSessionId: payload.call_session_id || null,
              callLegId: payload.call_leg_id || null,
              direction: "inbound",
              state: "initiated",
              isContactCenter: false, // Not visible to agents
              fromNumber: payload.from || null,
              toNumber: payload.to || null,
              flowId: flowId,
              metadata: {
                flow_owner: flow?.username || null,
                initiated_at: payload.occurred_at || new Date().toISOString(),
                is_transfer_leg: true, // Mark as transfer leg
              },
            });

            console.log(
              `[IncomingFlowWebhook] ✅ Registered transfer leg ${payload.call_control_id} (not visible to agents)`
            );
          }
          // Don't process transfer legs further - they're just for tracking
          return NextResponse.json({
            ok: true,
            message: "Transfer leg registered (not visible to agents)",
          });
        }

        // Check if interaction already exists for this call_control_id
        const existingInteraction = await PgDb.findInteractionByCallControlId(
          payload.call_control_id
        );

        if (!existingInteraction) {
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
            state: "initiated",
            isContactCenter: false, // Not yet enqueued, so not visible to agents
            fromNumber: payload.from || null,
            toNumber: payload.to || null,
            flowId: flowId,
            metadata: {
              flow_owner: flow?.username || null,
              initiated_at: payload.occurred_at || new Date().toISOString(),
            },
          });

          console.log(
            `[IncomingFlowWebhook] ✅ Registered incoming call ${payload.call_control_id} to cc_interactions (ID: ${interactionId})`
          );
        }
      } catch (err) {
        console.error(
          "[IncomingFlowWebhook] Error registering incoming call:",
          err
        );
        // Don't fail the webhook, just log the error
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
          // Contact center queue handling - simplified for contact center app
          // The contact center app has its own webhook handler for enqueued calls
          try {
            const { handleContactCenterEvent } = await import(
              "@/lib/contact-center/webhook-handler.js"
            );
            await handleContactCenterEvent("call.enqueued", payload);
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
              // Find all call legs in this session
              const calls = await pool.query(
                "SELECT call_control_id, direction, state FROM calls WHERE call_session_id = $1 ORDER BY created_at ASC",
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

              // Update the WebRTC call leg state to "completed"
              try {
                await pool.query(
                  "UPDATE calls SET state = $1, updated_at = NOW() WHERE call_control_id = $2",
                  ["completed", callControlId]
                );
                console.log(
                  `[IncomingFlowWebhook] Updated WebRTC call leg state to completed: ${callControlId}`
                );
              } catch (err) {
                console.error(
                  "[IncomingFlowWebhook] Error updating WebRTC call leg state:",
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

        if (callControlId) {
          // Find interaction by call_control_id
          let interaction = await PgDb.findInteractionByCallControlId(
            callControlId
          );

          // Fallback: Also try to find by agent_call_control_id in metadata
          // This handles the case where the agent's WebRTC leg hangs up after transfer
          if (!interaction) {
            try {
              const { getPostgresPool } = await import("@/lib/postgres.mjs");
              const pool = getPostgresPool();
              if (pool) {
                const result = await pool.query(
                  "SELECT * FROM cc_interactions WHERE metadata->>'agent_call_control_id' = $1 AND is_contact_center = true ORDER BY created_at DESC LIMIT 1",
                  [callControlId]
                );
                if (result.rows?.[0]) {
                  const row = result.rows[0];
                  // Parse JSON fields
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
                    `[IncomingFlowWebhook] Found interaction by agent_call_control_id: ${callControlId}`
                  );
                }
              }
            } catch (err) {
              console.warn(
                "[IncomingFlowWebhook] Error looking up by agent_call_control_id:",
                err
              );
            }
          }

          if (interaction && interaction.is_contact_center) {
            // Update interaction state to completed/abandoned
            const updates = {
              state: interaction.state === "queued" ? "abandoned" : "completed",
            };

            if (updates.state === "completed") {
              updates.completedAt = new Date().toISOString();
              // Calculate handle time and talk time
              if (interaction.answered_at) {
                const handleTime = Math.floor(
                  (new Date().getTime() -
                    new Date(interaction.answered_at).getTime()) /
                    1000
                );
                updates.handleTimeSeconds = handleTime;
              }
            } else {
              updates.abandonedAt = new Date().toISOString();
            }

            await PgDb.updateInteractionById(interaction.id, updates);

            // Notify agent to remove from Interactions list
            if (interaction.agent_username) {
              broadcastToKey(
                `contact-center:agent:${interaction.agent_username}`,
                {
                  type: "interaction_ended",
                  interactionId: interaction.id,
                  callControlId: callControlId,
                }
              );
            }

            console.log(
              `[IncomingFlowWebhook] ✅ Handled call.hangup for interaction ${interaction.id}`
            );
          }
        }
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
