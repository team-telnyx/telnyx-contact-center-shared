import { VERIFIED_INBOX_REPLAY } from "@/lib/acd/replay-effects.mjs";
import { handleAcdMediaEvent } from "@/lib/acd/media-events.mjs";
import { NextResponse } from "next/server";
import { VoiceFlowDb } from "@/lib/pgdb-voice-flows.js";
import { verifyTelnyxSignature } from "@/lib/telnyx-webhooks.js";
import {
  executeFlowNode,
  shouldContinueImmediately,
  determineNextNodes,
} from "@/lib/voice-flow-engine.js";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { addNodeExecutionEvent, addWebhookEvent } from "@/lib/call-monitor-store.js";
import { logCallEvent } from "@/lib/call-logger.js";
import {
  DEFAULT_INCOMING_CALL_PAYLOAD_VARIABLE,
  getValueByPath,
} from "@/lib/variable-utils.js";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { VOICE_FLOW_NODES } from "@/config/voice-flow-nodes.js";
import { findNextEdges, findNextNodes } from "@/lib/voice-flow-routing.js";
import { finalizeAgentlessAttemptByWebhook, handleOutboundMachineDetection } from "@/lib/outbound-dialer/execution";
import { voiceRuntimePayload, voiceWebhookLogger } from "@/lib/voice/logging.mjs";
import {
  decodeAcdClientState,
  encodeAcdClientState,
  materializeAcdIntakeState,
  mergeAcdClientState,
} from "@/lib/acd/intake-source.mjs";

// WS4-T1: transition/flow-completion dedupe is replay-safe across nodes and
// restarts. The helper keeps the previous in-memory 5-minute TTL semantics as
// a fast path and adds DB-backed idempotency guarded by
// WEBHOOK_IDEMPOTENCY_DB (default on, fail-open to memory on DB errors).
import {
  claimOnce as claimWebhookKeyOnce,
  wasProcessed as webhookKeyProcessed,
  markProcessed as markWebhookKeyProcessed,
} from "@/lib/events/webhook-dedupe.js";

const DEDUPE_KIND_TRANSITION = "voice:transition";
const DEDUPE_KIND_FLOW_COMPLETE = "voice:flow-complete";

const AI_CALL_ID_HEADER = "X-AI-Call-ID";

function canContinueAfterFailedImmediateNode(nodeType, result) {
  const nodeDef = VOICE_FLOW_NODES[nodeType];
  return (
    result?.success === false &&
    typeof result.output === "number" &&
    result.output > 0 &&
    (nodeDef?.outputs || 0) > 1
  );
}

function findCustomHeader(headers, name) {
  if (!Array.isArray(headers)) return null;
  return headers.find(
    (header) =>
      String(header?.name || "").toLowerCase() === String(name).toLowerCase(),
  );
}

function decodeClientState(clientState) {
  if (!clientState) return null;
  try {
    return JSON.parse(Buffer.from(clientState, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

function mergeFlowClientState(base, ...updates) {
  let merged = decodeAcdClientState(base);
  for (const update of updates) {
    merged = mergeAcdClientState(merged, update);
  }
  return encodeAcdClientState(merged);
}

async function hangupVoicemailDropCall(callControlId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey || !callControlId) return false;

  try {
    const response = await fetch(
      buildTelnyxV2Url(`/calls/${encodeURIComponent(callControlId)}/actions/hangup`),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function lookupOutboundContactRecord(payload = {}) {
  const pool = getPostgresPool();
  if (!pool) return null;

  const metadata = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const callControlId = payload?.call_control_id || null;
  const ledgerId = metadata?.outbound_ledger_id || null;

  try {
    let query = `
      SELECT r.row_data, l.contact_record_id, l.campaign_id
      FROM outbound_attempt_ledger l
      LEFT JOIN outbound_contact_records r ON r.id = l.contact_record_id
      WHERE l.call_control_id = $1
      LIMIT 1`;
    let params = [callControlId];

    if (ledgerId) {
      query = `
        SELECT r.row_data, l.contact_record_id, l.campaign_id
        FROM outbound_attempt_ledger l
        LEFT JOIN outbound_contact_records r ON r.id = l.contact_record_id
        WHERE l.id = $1
        LIMIT 1`;
      params = [ledgerId];
    }

    const { rows } = await pool.query(query, params);
    const row = rows?.[0];
    if (!row) return null;
    return {
      contactRecord: row.row_data && typeof row.row_data === "object" ? row.row_data : {},
      contactRecordId: row.contact_record_id || null,
      campaignId: row.campaign_id || null,
    };
  } catch {
    return null;
  }
}

function recordOutboundCampaignInitiatorMonitorEvent({ callControlId, flowId, initiatorNode, event, variables }) {
  if (!callControlId || !flowId || initiatorNode?.data?.nodeType !== "outbound_campaign") return;

  addNodeExecutionEvent(
    callControlId,
    "outbound_campaign",
    initiatorNode.id,
    initiatorNode.data?.label || "Outbound Campaign",
    {
      event_type: event,
      description: "Outbound campaign initiator received a Telnyx webhook and exposed these variables to the flow.",
      variables: {
        ...variables,
        call_control_id: variables?.call_control_id || callControlId,
        contact_record: variables?.contact_record || {},
        outbound_campaign_id: variables?.outbound_campaign_id || null,
      },
    },
    true,
    0,
    flowId,
  );
}

/**
 * Incoming Call Webhook Handler
 * This webhook should be configured in the Telnyx voice application
 * It triggers flows with an "incoming_call" initiator node
 */

export async function POST(request, context) {
  const { params } = context;
  const replay = context[VERIFIED_INBOX_REPLAY];
  try {
    const { flowId } = await params;
    if (!flowId) {
      return NextResponse.json(
        { ok: false, error: "Flow ID is required" },
        { status: 400 },
      );
    }

    // Get raw body for signature verification
    const rawBody = await request.text();

    // Verify Telnyx signature (optional but recommended)
    const isValid = replay || await verifyTelnyxSignature(request, rawBody);
    const enforceSignature = String(process.env.TELNYX_ENFORCE_WEBHOOK_SIGNATURE || "true").toLowerCase() === "true";
    if (!isValid) {
      voiceWebhookLogger.warn("voice_webhook_incoming_flow_webhook", voiceRuntimePayload({ flowId, reason: "invalid_signature" }));
      if (enforceSignature) {
        return NextResponse.json(
          { ok: false, error: "Invalid signature" },
          { status: 401 },
        );
      }
    }

    // Parse the body
    const body = JSON.parse(rawBody || "{}");
    const event = body?.data?.event_type;
    const payload = body?.data?.payload || {};
    const callControlId = payload.call_control_id;

    // Log call event to database
    try {
      await logCallEvent(body);
    } catch (err) {
      voiceWebhookLogger.error("voice_webhook_incoming_flow_webhook", voiceRuntimePayload({ error: err, eventType: event, callControlId, callSessionId: payload.call_session_id, flowId }));
    }

    // Store webhook in memory for monitoring
    if (callControlId) {
      addWebhookEvent(callControlId, event, body, flowId);
    }

    // The worker re-enters this adapter only after committing Core state. Most
    // Core events need adapter-only media effects and stop here. Agentless
    // outbound flows are the exception: Core authorizes their initial answered
    // replay and subsequent events while the Flow is active.
    if (replay) {
      await handleAcdMediaEvent(event, payload);
      if (event === "call.hangup" && callControlId) {
        await VoiceFlowDb.completeFlowExecution(flowId, callControlId, body.data.occurred_at);
      }
      if (!(replay.outboundCore && replay.adapterEventType)) {
        return NextResponse.json({ ok: true, durable: true, replayed: true });
      }
    }

    // Bind the generator's signed ingress identity before Core admission.
    // Direct-to-agent generator calls use this durable binding to select the
    // exact agent while preserving a separately controllable Voice API
    // customer leg for transfer and consult operations.
    if (event === "call.initiated" && payload.direction === "incoming") {
      const aiCallControlId = findCustomHeader(
        payload.custom_headers || [],
        AI_CALL_ID_HEADER,
      )?.value || null;
      const { bindGeneratedInbound } = await import(
        "@/lib/call-generator/inbound-identity.mjs"
      );
      const generatorClientState = await bindGeneratedInbound(
        getPostgresPool(),
        payload,
        flowId,
      );
      const marker = decodeClientState(generatorClientState);
      const generatorIdentity =
        marker?.callGenerator === true && marker.runId && marker.ledgerId
          ? {
              runId: marker.runId,
              ledgerId: marker.ledgerId,
              flowId,
              ...(marker.directAgentId
                ? { directAgentId: marker.directAgentId }
                : {}),
            }
          : null;
      const sourceClientState = aiCallControlId
        ? mergeAcdClientState(payload.client_state, {
            ai_call_control_id: aiCallControlId,
          })
        : payload.client_state;
      payload.client_state = encodeAcdClientState(
        materializeAcdIntakeState({
          clientState: sourceClientState,
          payload,
          flowId,
          generatorIdentity,
        }),
      );
    }

    // Durable Core intake runs before domain-specific flow effects. Every
    // configured CC queue is Core-owned; unrelated flow events pass through.
    let acdIntakeResult = replay || null;
    if (!replay) try {
      const acdPool = getPostgresPool();
      if (!acdPool) return NextResponse.json({ ok: false, error: "Database unavailable" }, { status: 503 });
      if (acdPool) {
        const acdEvent = {
          eventId: body?.data?.id || null,
          eventType: event,
          occurredAt: body?.data?.occurred_at || null,
          payload,
          sourceRoute: "incoming",
          sourceFlowId: flowId,
        };
        const { admitAcdVoiceEvent } = await import("@/lib/acd/admission.mjs");
        acdIntakeResult = await admitAcdVoiceEvent(acdPool, acdEvent);
        if (acdIntakeResult?.retryable) {
          return NextResponse.json(
            { ok: false, error: "ACD durable intake unavailable", retryable: true },
            {
              status: acdIntakeResult.httpStatus || 503,
              headers: { "Retry-After": "1" },
            },
          );
        }
        if (acdIntakeResult?.handled) return NextResponse.json({ ok: true, durable: true });
      }
    } catch {
      return NextResponse.json({ ok: false, error: "ACD durable intake unavailable" }, { status: 503 });
    }

    if (event === "call.hangup" && callControlId) {
      await VoiceFlowDb.completeFlowExecution(flowId, callControlId, body.data.occurred_at);
    }

    if (
      !replay?.outboundCore && callControlId &&
      (event === "call.answered" || event === "call.bridged" || event === "call.hangup")
    ) {
      try {
        const pool = getPostgresPool();
        if (pool) {
          await finalizeAgentlessAttemptByWebhook(pool, {
            callControlId,
            eventType: event,
            hangupCause: payload?.hangup_cause || null,
            sipHangupCause: payload?.sip_hangup_cause || null,
            eventId: body?.data?.id || body?.id || null,
          });
        }
      } catch (err) {
        voiceWebhookLogger.error("voice_webhook_incoming_flow_webhook", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      }
    }

    // WS5-T2: AMD result for outbound campaign calls — human → connect path,
    // machine/beep → campaign voicemailAction (hangup / drop_message). No-op
    // for calls that don't belong to an outbound attempt.
    if (
      !replay?.outboundCore && callControlId &&
      (event === "call.machine.detection.ended" ||
        event === "call.machine.premium.detection.ended" ||
        event === "call.machine.premium.greeting.ended")
    ) {
      try {
        const pool = getPostgresPool();
        if (pool) {
          await handleOutboundMachineDetection(pool, {
            callControlId,
            amdResult: payload?.result || null,
            eventId: body?.data?.id || body?.id || null,
            eventType: event,
          });
        }
      } catch (err) {
        voiceWebhookLogger.error("voice_webhook_outbound_amd", voiceRuntimePayload({ error: err, eventType: event, callControlId, flowId }));
      }
    }

    if (callControlId && event === "call.speak.ended") {
      const decodedClientState = decodeClientState(payload?.client_state);
      if (decodedClientState?.voicemailDrop) {
        const hangupIssued = await hangupVoicemailDropCall(callControlId);
        return NextResponse.json({
          ok: true,
          message: "Voicemail drop completed",
          hangupIssued,
        });
      }
    }

    // Get the flow (without username filter to allow any user's flow to be triggered)
    const flow = await VoiceFlowDb.getFlowById(flowId, null);

    if (!flow) {
      return NextResponse.json(
        { ok: false, error: "Flow not found" },
        { status: 404 },
      );
    }

    // Find initiator nodes for this flow
    const incomingCallNode = flow.nodes?.find(
      (node) => node.data?.nodeType === "incoming_call",
    );
    const outboundCampaignNode = flow.nodes?.find(
      (node) => node.data?.nodeType === "outbound_campaign",
    );

    if (!incomingCallNode && !outboundCampaignNode) {
      return NextResponse.json(
        {
          ok: false,
          error: "Flow does not have a supported trigger (incoming_call or outbound_campaign)",
        },
        { status: 400 },
      );
    }

    const outboundMetadataPresent = Boolean(
      payload?.metadata?.outbound_campaign_id || payload?.metadata?.outbound_ledger_id,
    );
    const outboundContact = outboundCampaignNode
      ? await lookupOutboundContactRecord(payload)
      : null;
    const isOutboundCampaignEvent = Boolean(outboundMetadataPresent || outboundContact?.campaignId);

    const initiatorNode =
      isOutboundCampaignEvent && outboundCampaignNode
        ? outboundCampaignNode
        : incomingCallNode;

    if (!initiatorNode) {
      return NextResponse.json({
        ok: true,
        message: "No matching initiator in flow for this webhook event",
      });
    }

    // Verify that the voice application ID matches (if configured on incoming_call initiator)
    const configuredAppId = initiatorNode.data?.config?.voice_application_id;
    const receivedAppId = body?.data?.payload?.connection_id;

    if (
      initiatorNode.data?.nodeType === "incoming_call" &&
      configuredAppId &&
      receivedAppId &&
      configuredAppId !== receivedAppId
    ) {
      voiceWebhookLogger.warn("voice_application_mismatch_expected_configuredappid_received_receivedappid", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      // We'll still process it, but log the warning
    }

    const outboundPayloadVariable =
      initiatorNode.data?.config?.payloadVariable || "contact_record";
    const incomingPayloadVariable =
      initiatorNode.data?.config?.payloadVariable ||
      initiatorNode.data?.config?.payloadVariableName ||
      DEFAULT_INCOMING_CALL_PAYLOAD_VARIABLE;

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
      trigger_type: initiatorNode.data?.nodeType,
      flow_id: flowId,
      outbound_campaign_id: outboundContact?.campaignId || payload?.metadata?.outbound_campaign_id || null,
      outbound_contact_record_id: outboundContact?.contactRecordId || null,
    };

    if (initiatorNode.data?.nodeType === "outbound_campaign") {
      const contactRecord = outboundContact?.contactRecord || {};
      variables[outboundPayloadVariable] = contactRecord;
      variables.contact_record = contactRecord;
      variables.contact_data = contactRecord;
      recordOutboundCampaignInitiatorMonitorEvent({
        callControlId: payload.call_control_id,
        flowId,
        initiatorNode,
        event,
        variables,
      });
    } else if (initiatorNode.data?.nodeType === "incoming_call") {
      variables[incomingPayloadVariable] = payload;
    }

    // Persist before sending commands: a fast hangup can arrive while a
    // provider command is still returning. Retries reuse this record, and
    // late events cannot restart an execution finalized by hangup.
    if (event !== "call.hangup" && callControlId) {
      const execution = await VoiceFlowDb.createFlowExecution(
        flowId, callControlId, initiatorNode.id, variables,
      );
      if (execution.status !== "active") {
        return NextResponse.json({ ok: true, message: "Flow already completed" });
      }
    }

    // Handle different event types
    if (event === "call.initiated") {
      if (
        initiatorNode.data?.nodeType === "incoming_call" &&
        payload.direction !== "incoming"
      ) {
        return NextResponse.json({
          ok: true,
          message: `Call initiated but direction is ${payload.direction}, expected "incoming"`,
          variables,
        });
      }

      if (
        initiatorNode.data?.nodeType === "outbound_campaign" &&
        payload.direction !== "outgoing"
      ) {
        return NextResponse.json({
          ok: true,
          message: `Call initiated but direction is ${payload.direction}, expected "outgoing"`,
          variables,
        });
      }

      // Find next nodes for the actual initiation event only. This is critical for
      // outbound campaign flows where the initiator may have a call.answered edge
      // to an AI assistant start node; executing every outgoing edge on call.initiated
      // attempts to start the assistant before the PSTN leg is answered.
      const nextNodes = findNextNodes(flow, initiatorNode.id, event);

      // Process edge variable mappings only for the edge(s) selected by this webhook event.
      const matchingEdges = findNextEdges(flow, initiatorNode.id, event);

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
                    // Preserve immutable Core intake correlation while adding
                    // the next flow position.
                    client_state: mergeFlowClientState(
                      payload.client_state,
                      existingConfig.client_state,
                      { flowId, currentNodeId: node.id },
                    ),
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
                executionState,
              );

              return { node, result };
            }),
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
              flowId,
            );
          }

          // After executing initial nodes, check if any are logical nodes that should continue immediately
          // Logical nodes: http_request, set_variable, condition, switch, logic_gate
          // Telephony nodes: answer, speak, playback, etc. - these STOP and WAIT for webhook

          for (const { node, result } of results) {
            const nodeType = node.data?.nodeType || node.type;

            // Check if this is a logical node that should continue immediately
            const logicalNodeTypes = [
              "http_request_action",
              "data_action",
              "mcp_tool",
              "set_variable",
              "condition",
              "switch",
              "logic_gate",
              "flow_end",
              "set_queue_options",
              "client_state_update",
              "agent_assist",
              "transcription_start",
            ];

            const isLogical = logicalNodeTypes.includes(nodeType);
            const shouldContinueChain =
              result.success ||
              (isLogical && canContinueAfterFailedImmediateNode(nodeType, result));

            if (!shouldContinueChain) {
              continue;
            }

            if (isLogical) {
              // Logical nodes execute and immediately continue to next node
              // For set_queue_options and agent_assist, add a small delay to ensure client_state_update is processed
              if (["set_queue_options", "client_state_update", "agent_assist"].includes(nodeType)) {
                await new Promise((resolve) => setTimeout(resolve, 500));

                // Update body payload with the new client_state from the result
                // This ensures the next node receives the updated client_state (including agent_assist_config)
                if (result.client_state && body?.data?.payload) {
                  body.data.payload.client_state = result.client_state;
                }
              }

              await executeNodeChain(
                node,
                result,
                flow,
                payload.call_control_id,
                body,
                variables,
                flowId,
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
              payload.call_control_id,
            );
            await VoiceFlowDb.updateFlowExecution(payload.call_control_id, {
              variables,
              execution_history: [],
            });
          } catch (error) {
            voiceWebhookLogger.error("voice_webhook_incomingwebhook", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
          }

          return NextResponse.json({
            ok: true,
            message: "Call initiated - flow execution started",
            executed_nodes: results.map((r) => r.node.data?.nodeType),
            results: results.map((r) => r.result),
          });
        } catch (error) {
          voiceWebhookLogger.error("voice_webhook_incoming_call", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
          return NextResponse.json(
            {
              ok: false,
              error: "Failed to execute flow node",
              details: error.message,
            },
            { status: 500 },
          );
        }
      } else {
        voiceWebhookLogger.warn("voice_webhook_incoming_call", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));

        // Store variables in database for persistence between webhook calls
        try {
          // Create execution record if it doesn't exist
          await VoiceFlowDb.createFlowExecution(
            flowId,
            payload.call_control_id,
          );
          await VoiceFlowDb.updateFlowExecution(payload.call_control_id, {
            current_node_id: initiatorNode.id,
            variables,
            execution_history: [],
          });
        } catch (error) {
          voiceWebhookLogger.error("voice_webhook_incomingwebhook", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
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
    if (await webhookKeyProcessed(flowCompletionKey)) {
      return NextResponse.json({
        ok: true,
        message: "Flow already completed",
        variables,
      });
    }

    // A terminal event ends an ordinary Voice Flow. Core-owned hangups have
    // already returned through the durable replay branch above.
    if (event === "call.hangup") {
      return NextResponse.json({
        ok: true,
        message: "Call ended",
        variables,
      });
    }

    // Try to decode client_state to get current execution info
    let currentNodeId = null;
    let persistedExecution = null;
    try {
      const clientState = payload.client_state;
      if (clientState) {
        const decoded = decodeClientState(clientState);
        currentNodeId = decoded?.currentNodeId || null;
      }
    } catch (e) {
      // Ignore client_state decode errors
    }

    // Outbound campaign webhooks are not guaranteed to carry the client_state
    // created by the flow engine, especially when the flow is intentionally
    // waiting on the initiator's call.answered edge. Fall back to the persisted
    // execution cursor so call.answered can start the next node (for example an
    // AI assistant) instead of returning "No execution context".
    if (!currentNodeId && payload.call_control_id) {
      persistedExecution = await VoiceFlowDb.getFlowExecution(payload.call_control_id);
      if (persistedExecution?.current_node_id) {
        currentNodeId = persistedExecution.current_node_id;
      } else if (isOutboundCampaignEvent && outboundCampaignNode) {
        currentNodeId = outboundCampaignNode.id;
      }
      if (persistedExecution?.variables) {
        Object.assign(variables, persistedExecution.variables);
      }
    }

    // If we have a current node, find the next one(s) and execute them
    if (currentNodeId) {
      const currentNode = flow.nodes.find((n) => n.id === currentNodeId);
      if (currentNode) {
        // Retrieve latest variables from database to ensure we have the most up-to-date values
        const execution = await VoiceFlowDb.getFlowExecution(
          payload.call_control_id,
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
              10,
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
          // Filter out nodes that have already been executed for this event.
          // claimOnce is atomic (DB INSERT … ON CONFLICT when enabled), so two
          // nodes processing the same replayed webhook cannot both claim it.
          const nodesToExecute = [];
          for (const nextNode of nextNodes) {
            const transitionKey = `${payload.call_control_id}:${currentNode.id}:${nextNode.id}:${event}`;
            const defaultTransitionKey = `${payload.call_control_id}:${currentNode.id}:${nextNode.id}:default`;
            // Check the default transition key first (read-only), then
            // atomically claim the event-specific key.
            if (await webhookKeyProcessed(defaultTransitionKey)) {
              continue;
            }
            const claimed = await claimWebhookKeyOnce(
              transitionKey,
              DEDUPE_KIND_TRANSITION,
            );
            if (claimed) {
              nodesToExecute.push(nextNode);
            }
          }

          if (nodesToExecute.length === 0) {
            return NextResponse.json({
              ok: true,
              message: "All transitions already executed",
              variables,
            });
          }

          // Execute all nodes in parallel
          try {
            const results = await Promise.all(
              nodesToExecute.map(async (nextNode) => {
                // Prepare node with client_state for flow tracking
                // Merge client_state from webhook payload (set by previous nodes like Set Queue Options),
                // node config (if any), and flow tracking
                const existingConfig = nextNode.data?.config || {};
                const flowTracking = { flowId, currentNodeId: nextNode.id };

                // Start with client_state from webhook payload (contains queue options from Set Queue Options node)
                let mergedClientState = {};
                if (payload?.client_state) {
                  try {
                    const decoded = Buffer.from(
                      payload.client_state,
                      "base64",
                    ).toString();
                    const payloadClientState = JSON.parse(decoded);
                    // Use payload client_state as base (contains queue_name, priority, required_skills from Set Queue Options)
                    mergedClientState = { ...payloadClientState };
                  } catch (err) {
                    voiceWebhookLogger.warn("voice_webhook_flowwebhook", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
                  }
                }

                // Merge with node config client_state if it exists (may have additional routing params)
                if (existingConfig.client_state) {
                  try {
                    const decoded = Buffer.from(
                      existingConfig.client_state,
                      "base64",
                    ).toString();
                    const configClientState = JSON.parse(decoded);
                    // Merge config client_state into payload client_state (config takes precedence for conflicting fields)
                    mergedClientState = {
                      ...mergedClientState,
                      ...configClientState,
                    };
                  } catch (err) {
                    voiceWebhookLogger.warn("voice_webhook_flowwebhook", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
                  }
                }

                // Finally, merge flow tracking (must be last to ensure correct flowId/currentNodeId)
                mergedClientState = mergeAcdClientState(
                  payload?.client_state,
                  { ...mergedClientState, ...flowTracking },
                );

                const configuredNextNode = {
                  ...nextNode,
                  data: {
                    ...nextNode.data,
                    config: {
                      ...existingConfig,
                      // Merge client_state: preserve routing params, add flow tracking
                      client_state: encodeAcdClientState(mergedClientState),
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
                  executionState,
                );

                return { node: nextNode, result };
              }),
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
                flowId,
              );
            }

            // After executing webhook-triggered nodes, check if any are logical nodes that should continue immediately

            for (const { node, result } of results) {
              const nodeType = node.data?.nodeType || node.type;

              // Check if this is a logical node that should continue immediately
              const logicalNodeTypes = [
                "http_request_action",
                "data_action",
                "mcp_tool",
                "set_variable",
                "condition",
                "switch",
                "logic_gate",
                "flow_end",
                "set_queue_options",
                "client_state_update",
                "agent_assist",
                "transcription_start",
              ];

              const isLogical = logicalNodeTypes.includes(nodeType);
              const shouldContinueChain =
                result.success ||
                (isLogical && canContinueAfterFailedImmediateNode(nodeType, result));

              if (!shouldContinueChain) {
                continue;
              }

              if (isLogical) {
                // Logical nodes execute and immediately continue to next node
                // For set_queue_options and agent_assist, add a small delay to ensure client_state_update is processed
                // and update body with the new client_state
                if (["set_queue_options", "client_state_update", "agent_assist"].includes(nodeType)) {
                  await new Promise((resolve) => setTimeout(resolve, 500));

                  // Update body payload with the new client_state from the result
                  // This ensures the next node receives the updated client_state
                  if (result.client_state && body?.data?.payload) {
                    body.data.payload.client_state = result.client_state;
                  }
                }

                await executeNodeChain(
                  node,
                  result,
                  flow,
                  payload.call_control_id,
                  body,
                  variables,
                  flowId,
                );
              }
            }

            // Store variables in database for persistence between webhook calls
            try {
              // Create execution record if it doesn't exist
              await VoiceFlowDb.createFlowExecution(
                flowId,
                payload.call_control_id,
              );
              await VoiceFlowDb.updateFlowExecution(payload.call_control_id, {
                variables,
                execution_history: [],
              });
            } catch (error) {
              voiceWebhookLogger.error("voice_webhook_incomingwebhook", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
            }

            return NextResponse.json({
              ok: true,
              message: `Event ${event} processed - executed ${nodesToExecute.length} node(s)`,
              executed_nodes: results.map((r) => r.node.data?.nodeType),
              results: results.map((r) => r.result),
            });
          } catch (error) {
            voiceWebhookLogger.error("voice_webhook_incoming_call", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
            return NextResponse.json(
              {
                ok: false,
                error: "Failed to execute flow nodes",
                details: error.message,
              },
              { status: 500 },
            );
          }
        } else {
          const hasAnyEdges = flow.edges?.some(
            (e) => e.source === currentNode.id,
          );

          if (!hasAnyEdges) {
            const flowCompletionKey = `${payload.call_control_id}:${flowId}`;
            await markWebhookKeyProcessed(
              flowCompletionKey,
              DEDUPE_KIND_FLOW_COMPLETE,
            );

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
    voiceWebhookLogger.error("voice_webhook_incoming_call_webhook_error", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    return NextResponse.json(
      { ok: false, error: error.message || "Internal server error" },
      { status: 500 },
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
  flowId,
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

    // Atomically claim this transition; skip if already executed (replay-safe)
    const transitionKey = `${callControlId}:${currentNode.id}:${nextNode.id}:${
      currentResult.output || 0
    }`;
    const claimed = await claimWebhookKeyOnce(
      transitionKey,
      DEDUPE_KIND_TRANSITION,
    );
    if (!claimed) {
      continue;
    }

    // Configure node with client_state for flow tracking
    // Merge client_state from webhook payload (set by previous nodes like Set Queue Options),
    // node config (if any), and flow tracking
    const existingConfig = nextNode.data?.config || {};
    const flowTracking = { flowId, currentNodeId: nextNode.id };

    // Start with client_state from webhook payload (contains queue options from Set Queue Options node)
    let mergedClientState = {};
    if (body?.data?.payload?.client_state) {
      try {
        const decoded = Buffer.from(
          body.data.payload.client_state,
          "base64",
        ).toString();
        const payloadClientState = JSON.parse(decoded);
        // Use payload client_state as base (contains queue_name, priority, required_skills from Set Queue Options)
        mergedClientState = { ...payloadClientState };
      } catch (err) {
        voiceWebhookLogger.warn("voice_webhook_flowwebhook", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      }
    }

    // Merge with node config client_state if it exists (may have additional routing params)
    if (existingConfig.client_state) {
      try {
        const decoded = Buffer.from(
          existingConfig.client_state,
          "base64",
        ).toString();
        const configClientState = JSON.parse(decoded);
        // Merge config client_state into payload client_state (config takes precedence for conflicting fields)
        mergedClientState = { ...mergedClientState, ...configClientState };
      } catch (err) {
        voiceWebhookLogger.warn("voice_webhook_flowwebhook", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      }
    }

    // Finally, merge flow tracking (must be last to ensure correct flowId/currentNodeId)
    mergedClientState = mergeAcdClientState(
      body?.data?.payload?.client_state,
      { ...mergedClientState, ...flowTracking },
    );

    const configuredNode = {
      ...nextNode,
      data: {
        ...nextNode.data,
        config: {
          ...existingConfig,
          // Merge client_state: preserve routing params, add flow tracking
          client_state: encodeAcdClientState(mergedClientState),
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
      nodeExecutionState,
    );

    // Merge variables
    Object.assign(variables, result.variables || {});

    // Check if we should continue with this node's chain
    // Logical nodes execute and immediately continue
    // Telephony nodes send command and STOP (wait for webhook)
    const logicalNodeTypes = [
      "http_request_action",
      "data_action",
      "mcp_tool",
      "set_variable",
      "condition",
      "switch",
      "logic_gate",
      "flow_end",
      "set_queue_options",
      "client_state_update",
      "agent_assist",
      "transcription_start",
    ];
    const isLogicalNode = logicalNodeTypes.includes(nextNodeType);

    const shouldContinueChain =
      result.success ||
      (isLogicalNode &&
        canContinueAfterFailedImmediateNode(nextNodeType, result));

    if (shouldContinueChain && isLogicalNode) {
      // Logical node - continue chain immediately after execution
      // For nodes that update client_state, add a small delay and update body with new client_state
      if (["set_queue_options", "client_state_update", "agent_assist"].includes(nextNodeType)) {
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Update body payload with the new client_state from the result
        // This ensures the next node receives the updated client_state (including agent_assist_config)
        if (result.client_state && body?.data?.payload) {
          body.data.payload.client_state = result.client_state;
        }
      }

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
        flowId,
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
  flowId,
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
    executionState,
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
                client_state: mergeFlowClientState(
                  body?.data?.payload?.client_state,
                  node.data?.config?.client_state,
                  { flowId, currentNodeId: node.id },
                ),
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
            nodeExecutionState,
          );

          return { node, result };
        }),
      );

      return true; // Handled
    } catch (error) {
      voiceWebhookLogger.error("voice_webhook_incomingwebhook", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      return false;
    }
  }

  return true; // Handled (no nodes on output 0)
}
