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
import {
  addTimelineEvent,
  TimelineEventTypes,
} from "@/lib/contact-center/call-timeline-tracker.js";
import { voiceRuntimePayload, voiceWebhookLogger } from "@/lib/voice/logging.mjs";

// WS4-T1: transition/flow-completion dedupe is replay-safe across nodes and
// restarts. The helper keeps the previous in-memory 5-minute TTL semantics as
// a fast path and adds DB-backed idempotency (cc_processed_events) guarded by
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

async function updateConversationMetadata(conversationId, metadata) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey || !conversationId) return null;
  const baseUrl = buildTelnyxV2Url(
    `/ai/conversations/${encodeURIComponent(conversationId)}`,
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
      return null;
    }
    const currentData = await currentRes.json();
    const currentMetadata =
      currentData?.data?.metadata &&
      typeof currentData.data.metadata === "object"
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
      return null;
    }
    return await updateRes.json();
  } catch (err) {
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
    const isValid = await verifyTelnyxSignature(request, rawBody);
    const enforceSignature = String(process.env.TELNYX_ENFORCE_WEBHOOK_SIGNATURE || "true").toLowerCase() === "true";
    if (!isValid) {
      voiceWebhookLogger.warn("voice_webhook_incoming_flow_webhook", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
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
    const webhookEventId = body?.data?.id || null;

    // Log call event to database
    try {
      await logCallEvent(body);
    } catch (err) {
      voiceWebhookLogger.error("voice_webhook_incoming_flow_webhook", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    }

    // Store webhook in memory for monitoring
    const callControlId = body?.data?.payload?.call_control_id;
    if (callControlId) {
      addWebhookEvent(callControlId, event, body, flowId);
    }

    // Extract webhook data into variables (needed for call.enqueued handling)
    const payload = body?.data?.payload || {};

    if (
      callControlId &&
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
      callControlId &&
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

    // Handle call.initiated - Check for transfer legs (both incoming and outbound directions)
    // Transfer legs to WebRTC clients can be either direction
    if (event === "call.initiated") {
      // Check if this is a transfer leg first (before checking direction)
      const toField = payload.to || "";
      const isTransferLeg =
        toField.startsWith("sip:") && toField.includes("@sip.telnyx.com");

      if (isTransferLeg) {
        // Handle transfer leg regardless of direction
        try {
          const { PgDb } = await import("@/lib/pgdb.js");
          // This is a transfer leg to an agent's WebRTC client
          // Find the original interaction using custom headers or call_session_id
          let originalInteraction = null;

          // Try to find by custom headers first (from transfer)
          const customHeaders = payload.custom_headers || [];
          const originalCallControlIdHeader = customHeaders.find(
            (h) => h.name === "X-Original-Call-Control-Id",
          );
          const originalCallSessionIdHeader = customHeaders.find(
            (h) => h.name === "X-Original-Call-Session-Id",
          );

          if (originalCallControlIdHeader?.value) {
            originalInteraction = await PgDb.findInteractionByCallControlId(
              originalCallControlIdHeader.value,
            );
          }

          // Fallback: try by call_session_id (both legs share the same session)
          if (!originalInteraction && payload.call_session_id) {
            originalInteraction = await PgDb.findInteractionByCallSessionId(
              payload.call_session_id,
            );
          }

          if (originalInteraction) {
            // Extract AI call ID from custom headers if present
            const aiCallHeader = findCustomHeader(
              customHeaders,
              AI_CALL_ID_HEADER,
            );
            const aiCallControlId = aiCallHeader?.value || null;

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

            // Store AI call control ID if present and not already set
            if (aiCallControlId && !metadata.ai_call_control_id) {
              metadata.ai_call_control_id = aiCallControlId;
            }

            await PgDb.updateInteractionById(originalInteraction.id, {
              metadata,
            });

            // Broadcast incoming_call_info to WebRTC client now that we have the agent's call_control_id
            // This is critical for the WebRTC client to show the ringing state
            if (originalInteraction.agent_username) {
              try {
                const { broadcastToKey } = await import("@/lib/sse");
                const { storeIncomingCallData } =
                  await import("@/lib/incoming-call-store");
                const { PgDb: PgDbForUser } = await import("@/lib/pgdb.js");

                // Get agent user ID for SSE broadcast
                const agent = await PgDbForUser.findUserByUsername(
                  originalInteraction.agent_username,
                );

                if (agent?.id) {
                  // Get caller info from interaction
                  const fromNumber = originalInteraction.from_number;
                  const fromName = originalInteraction.from_name;

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
                        aiCallControlId: metadata.ai_call_control_id || null,
                      },
                    );
                  }

                  storeIncomingCallData(payload.call_control_id, {
                    fromNumber: fromNumber,
                    fromName: fromName,
                    callControlId: payload.call_control_id,
                    originalCallControlId: metadata.original_call_control_id,
                    callSessionId: payload.call_session_id,
                    interactionId: originalInteraction.id,
                    aiCallControlId: metadata.ai_call_control_id || null,
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
                    aiCallControlId: metadata.ai_call_control_id || null,
                    contactCenter: {
                      interactionId: originalInteraction.id,
                      queueName: originalInteraction.queue_name,
                      queuedAt:
                        originalInteraction.enqueued_at ||
                        originalInteraction.created_at,
                      assignedAt:
                        originalInteraction.assigned_at ||
                        new Date().toISOString(),
                      aiCallControlId: metadata.ai_call_control_id || null,
                    },
                  });
                }
              } catch (err) {
                // Error broadcasting incoming_call_info
              }
            }
          }

          // Don't process transfer legs further
          return NextResponse.json({
            ok: true,
            message: "Transfer leg ignored",
          });
        } catch (err) {
          // Don't fail the webhook, just log the error
        }
      }

      // Handle regular incoming calls (not transfer legs)
      if (payload.direction === "incoming" && !isTransferLeg) {
        try {
          const { PgDb } = await import("@/lib/pgdb.js");
          const aiCallHeader = findCustomHeader(
            payload.custom_headers || [],
            AI_CALL_ID_HEADER,
          );
          const aiCallControlId = aiCallHeader?.value || null;

          // Check if interaction already exists for this call_control_id
          const existingInteraction = await PgDb.findInteractionByCallControlId(
            payload.call_control_id,
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
              },
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
              payload.call_control_id,
            );
          }
          if (!interaction && payload.call_session_id) {
            interaction = await PgDb.findInteractionByCallSessionId(
              payload.call_session_id,
            );
          }
          if (!interaction && payload.call_leg_id) {
            interaction = await PgDb.findInteractionByCallLegId(
              payload.call_leg_id,
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
        // Error linking conversation metadata
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
            const { handleContactCenterEnqueue } =
              await import("@/lib/contact-center/webhook-handler.js");
            const { isContactCenterQueue } =
              await import("@/lib/contact-center/queue-utils.js");

            if (isContactCenterQueue(queueName)) {
              // Get flow owner username
              const flow = await VoiceFlowDb.getFlowById(flowId, null);
              const flowOwner = flow?.username || null;

              // Try to find existing interaction to extract original caller number from timeline
              const { PgDb } = await import("@/lib/pgdb.js");
              let originalFromNumber = payload.from;

              // Check if payload.from is a SIP endpoint (indicates transferred call)
              const isSipEndpoint =
                payload.from &&
                (payload.from.includes("@sip.") ||
                  payload.from.startsWith("sip:") ||
                  payload.from.includes("username@"));

              // If it's a SIP endpoint or missing, try to get original number from existing interaction's timeline
              if (isSipEndpoint || !payload.from) {
                try {
                  const existingInteraction =
                    await PgDb.findInteractionByCallControlId(
                      payload.call_control_id,
                    );

                  if (existingInteraction?.routing_metadata?.timeline) {
                    const initiatedEvent =
                      existingInteraction.routing_metadata.timeline.find(
                        (e) => e.type === "initiated" && e.from,
                      );
                    if (
                      initiatedEvent?.from &&
                      initiatedEvent.from.trim() !== ""
                    ) {
                      originalFromNumber = initiatedEvent.from;
                    }
                  }
                } catch (err) {
                  // Error extracting original caller number
                }
              }

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
                fromNumber: originalFromNumber || payload.from,
                toNumber: payload.to,
                direction: payload.direction,
              });
            }
          } catch (err) {
            // Don't fail the webhook, just log the error
          }
        }
      } catch (err) {
        // Don't fail the webhook, just log the error
      }
    }

    // Handle other Contact Center events (call.answered, call.bridged, call.dequeued, call.held, call.unheld, call.hangup, call.speak.ended, call.recording.transcription.saved)
    if (
      event === "call.answered" ||
      event === "call.bridged" ||
      event === "call.dequeued" ||
      event === "call.held" ||
      event === "call.unheld" ||
      event === "call.hangup" ||
      event === "call.speak.ended" ||
      event === "call.recording.transcription.saved"
    ) {
      try {
        const { handleContactCenterEvent } =
          await import("@/lib/contact-center/webhook-handler.js");
        await handleContactCenterEvent(event, payload, { eventId: webhookEventId });
      } catch (err) {
        // Don't fail the webhook, just log the error
      }
    }

    // Handle call.transcription for Agent Assist
    if (event === "call.transcription") {
      try {
        const { handleTranscriptionEvent } =
          await import("@/lib/contact-center/webhook-handler.js");
        await handleTranscriptionEvent(payload);
      } catch (err) {
        // Don't fail the webhook, just log the error
      }
    }
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
                    // Always set client_state for flow tracking
                    client_state: Buffer.from(
                      JSON.stringify({
                        flowId,
                        currentNodeId: node.id,
                      }),
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

    // Handle call.hangup - remove from Interactions and update phone state
    if (event === "call.hangup") {
      try {
        const { PgDb } = await import("@/lib/pgdb.js");
        const { broadcastToKey } = await import("@/lib/sse.js");
        const { callTelnyxAction } = await import("@/lib/voice-flow-engine.js");

        const callControlId = payload.call_control_id;
        const callSessionId = payload.call_session_id;
        const hangupCause = payload.hangup_cause;

        // Check if this is a rejected WebRTC call (user_busy or timeout)
        // In this case, we need to hangup the original incoming call leg
        if (
          (hangupCause === "user_busy" || hangupCause === "timeout") &&
          callSessionId
        ) {
          try {
            const { getPostgresPool } = await import("@/lib/postgres.mjs");
            const pool = getPostgresPool();

            if (pool) {
              // Find all call legs in this session from cc_interactions table
              const calls = await pool.query(
                "SELECT call_control_id, direction, state FROM cc_interactions WHERE call_session_id = $1 ORDER BY created_at ASC",
                [callSessionId],
              );

              // Find the other call leg (the one that's not the current WebRTC leg that hung up)
              // This works for both incoming and outgoing calls transferred to agents
              const originalCall = calls.rows?.find(
                (call) => call.call_control_id !== callControlId,
              );

              if (originalCall) {
                // Hangup the original call leg
                const result = await callTelnyxAction(
                  flowId,
                  "hangup",
                  originalCall.call_control_id,
                  {},
                );

                // Hangup result handled
              }

              // Update the interaction state instead of calls table
              try {
                const { PgDb } = await import("@/lib/pgdb.js");
                const interaction =
                  await PgDb.findInteractionByCallControlId(callControlId);
                if (interaction) {
                  await PgDb.updateInteractionById(interaction.id, {
                    state: "completed",
                  });
                }
              } catch (err) {
                // Error updating interaction state
              }
            }
          } catch (err) {
            // Don't fail the webhook processing
          }
        }

        // Note: The actual interaction update, timeline event, and SSE broadcast
        // are all handled by handleContactCenterEvent which is called above.
      } catch (err) {
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
        const { handleContactCenterEvent } =
          await import("@/lib/contact-center/webhook-handler.js");
        await handleContactCenterEvent(event, payload, { eventId: webhookEventId });
      } catch (err) {
        // Error handling call.recording.saved
      }
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
                mergedClientState = { ...mergedClientState, ...flowTracking };

                const configuredNextNode = {
                  ...nextNode,
                  data: {
                    ...nextNode.data,
                    config: {
                      ...existingConfig,
                      // Merge client_state: preserve routing params, add flow tracking
                      client_state: Buffer.from(
                        JSON.stringify(mergedClientState),
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
    mergedClientState = { ...mergedClientState, ...flowTracking };

    const configuredNode = {
      ...nextNode,
      data: {
        ...nextNode.data,
        config: {
          ...existingConfig,
          // Merge client_state: preserve routing params, add flow tracking
          client_state: Buffer.from(JSON.stringify(mergedClientState)).toString(
            "base64",
          ),
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
                client_state: Buffer.from(
                  JSON.stringify({
                    flowId,
                    currentNodeId: node.id,
                  }),
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
