import { buildTelnyxV2Url } from "@/lib/telnyx";
import { PgDb } from "@/lib/pgdb";
import { contactCenterErrorPayload, webrtcBridgeLogger } from "./logging.mjs";

/**
 * Transfer a queued call to an agent's WebRTC client
 * @param {string} queuedCallSessionId - The call session ID of the queued call
 * @param {string} queuedCallControlId - The call control ID of the queued call (from call.enqueued webhook)
 * @param {string} agentUsername - The username of the agent
 * @param {string} fromNumber - The caller's number (FROM field from initial incoming call)
 * @param {string} fromDisplayName - Optional display name for the caller (from contacts table)
 * @returns {Promise<Object>} Result with success status and agentCallControlId
 */
export async function bridgeCallToAgent(
  queuedCallSessionId,
  queuedCallControlId,
  agentUsername,
  fromNumber = null,
  fromDisplayName = null,
) {
  try {
    // Get agent's WebRTC credentials
    const agent = await PgDb.findUserByUsername(agentUsername);
    if (!agent || !agent.telephony_credentials_id) {
      throw new Error(
        `Agent ${agentUsername} does not have a WebRTC connection configured`,
      );
    }

    const connectionId = agent.telephony_credentials_id;

    // Get agent's telephony_user_name (username for the credentials)
    // This is typically the username part of the email (e.g., "jsmith" from "jsmith@example.com")
    const telephonyUserName =
      agent.telephony_user_name ||
      agent.telephonyUserName ||
      agentUsername.split("@")[0];

    if (!telephonyUserName) {
      throw new Error(
        `Agent ${agentUsername} does not have a telephony_user_name configured`,
      );
    }

    // Build SIP URI for transfer: sip:{telephony_user_name}@sip.telnyx.com
    const sipUri = `sip:${telephonyUserName}@sip.telnyx.com`;

    // Transfer the call to the agent's WebRTC credentials
    // Use the transfer action with SIP URI
    const url = buildTelnyxV2Url(
      `/calls/${encodeURIComponent(queuedCallControlId)}/actions/transfer`,
    );

    const body = {
      to: sipUri, // SIP URI format: sip:{telephony_user_name}@sip.telnyx.com
      connection_id: connectionId, // Agent's WebRTC connection (telephony_credentials_id)
      timeout_secs: 60, // Optional: Timeout for the transfer
      park_after_unbridge: "self", // Park the current leg after unbridge instead of hanging up
      custom_headers: [
        { name: "X-Original-Call-Session-Id", value: queuedCallSessionId },
        { name: "X-Original-Call-Control-Id", value: queuedCallControlId },
        { name: "X-Transfer-To-Agent", value: agentUsername },
      ],
    };

    // Add FROM field if provided (caller's number from initial incoming call)
    if (fromNumber) {
      body.from = fromNumber;
    }

    // Add caller_id_name if customer found
    if (fromDisplayName) {
      body.caller_id_name = fromDisplayName;
    }

    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      throw new Error("TELNYX_API_KEY not configured");
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
      throw new Error(`Failed to transfer call: ${errorText}`);
    }

    const result = await response.json();

    // The transfer API returns the agent's call_control_id
    const agentCallControlId = result.data?.call_control_id || null;

    // Find interaction by the queued call's call_control_id
    let interaction = null;
    try {
      interaction =
        await PgDb.findInteractionByCallControlId(queuedCallControlId);
    } catch (err) {
      // Error finding interaction
    }

    // Update interaction metadata with call control IDs
    // IMPORTANT: Keep call_control_id as the ORIGINAL incoming leg for consistency.
    // Store agent_call_control_id in metadata for WebRTC leg lookups.
    if (interaction) {
      try {
        const metadata = interaction.metadata || {};
        metadata.original_call_control_id = queuedCallControlId; // Original incoming leg

        if (agentCallControlId) {
          metadata.agent_call_control_id = agentCallControlId;
        }
        await PgDb.updateInteractionById(interaction.id, { metadata });
      } catch (err) {
        // Error updating interaction metadata
      }
    }

    // Prewarm the outbound/agent-leg Telnyx STT path as soon as Telnyx returns
    // the agent call_control_id. Waiting for call.answered means the first agent
    // TTS frames can beat streaming_start + provider WS setup and get clipped in
    // the Agent Assist bubble. This is best-effort: if Telnyx rejects
    // streaming_start while the leg is still ringing, the call.answered handler
    // retries the same idempotent command.
    if (interaction && agentCallControlId) {
      try {
        const callerStreamSession = globalThis.__telnyxSttStreamSessions?.get(queuedCallControlId);
        const sttConfig = callerStreamSession?.clientState?.telnyx_stt_config;
        if (sttConfig?.enabled) {
          const { prewarmTelnyxSttAgentLeg } = await import("@/lib/telnyx-stt-handler.mjs");
          prewarmTelnyxSttAgentLeg(
            agentCallControlId,
            sttConfig,
            interaction.id,
            agentUsername,
          ).catch((err) => {
            webrtcBridgeLogger.warn("webrtcbridge", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
          });
        }
      } catch (err) {
        webrtcBridgeLogger.warn("webrtcbridge", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
      }
    }

    // Broadcast caller info to agent via SSE so WebRTC client can show proper toast
    try {
      const { broadcastToKey } = await import("@/lib/sse");
      const { storeIncomingCallData } =
        await import("@/lib/incoming-call-store");

      // Store caller info by the call_session_id
      if (queuedCallSessionId) {
        storeIncomingCallData(`session:${queuedCallSessionId}`, {
          fromNumber: fromNumber,
          fromName: fromDisplayName,
          callControlId: agentCallControlId,
          originalCallControlId: queuedCallControlId,
          callSessionId: queuedCallSessionId,
          interactionId: interaction?.id,
        });
      }

      // Store caller info by the new agent call_control_id (if available)
      if (agentCallControlId) {
        storeIncomingCallData(agentCallControlId, {
          fromNumber: fromNumber,
          fromName: fromDisplayName,
          callControlId: agentCallControlId,
          originalCallControlId: queuedCallControlId,
          callSessionId: queuedCallSessionId,
          interactionId: interaction?.id,
        });
      }

      // Also store by phone number for fallback matching
      if (fromNumber) {
        storeIncomingCallData(`phone:${fromNumber}`, {
          fromNumber: fromNumber,
          fromName: fromDisplayName,
          callControlId: agentCallControlId || queuedCallControlId,
          originalCallControlId: queuedCallControlId,
          callSessionId: queuedCallSessionId,
          interactionId: interaction?.id,
        });
      }

      // Broadcast to agent via SSE with caller info
      // NOTE: Only broadcast if we have agentCallControlId
      // If agentCallControlId is null, the transfer leg webhook handler will broadcast
      // when it receives the call.initiated webhook for the agent leg
      if (agent?.id && agentCallControlId) {
        broadcastToKey(`user:status:${agent.id}`, {
          type: "incoming_call_info",
          callControlId: agentCallControlId,
          fromNumber: fromNumber,
          fromName: fromDisplayName,
          originalCallControlId: queuedCallControlId,
          callSessionId: queuedCallSessionId,
          interactionId: interaction?.id,
          // Contact center metadata for call store
          contactCenter: {
            interactionId: interaction?.id,
            queueName: interaction?.queue_name,
            queuedAt: interaction?.created_at || interaction?.queued_at,
            assignedAt: Date.now(),
            customerId: interaction?.customer_id,
            customerData: null,
          },
        });
      }
    } catch (err) {
      // Don't fail the transfer if broadcast fails
    }

    return {
      success: true,
      agentCallControlId,
    };
  } catch (err) {
    throw err;
  }
}

/**
 * Alternative: Use bridge API directly (if we have the agent's call control ID)
 * This is used when agent already has an active WebRTC call
 */
export async function bridgeCalls(callControlIdA, callControlIdB) {
  try {
    const url = buildTelnyxV2Url(
      `/calls/${encodeURIComponent(callControlIdA)}/actions/bridge`,
    );

    const body = {
      call_control_id: callControlIdB,
    };

    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      throw new Error("TELNYX_API_KEY not configured");
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
      webrtcBridgeLogger.error("webrtcbridge", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
      throw new Error(`Failed to bridge calls: ${errorText}`);
    }

    const result = await response.json();
    return {
      success: true,
      data: result.data,
    };
  } catch (err) {
    webrtcBridgeLogger.error("webrtcbridge", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
    throw err;
  }
}
