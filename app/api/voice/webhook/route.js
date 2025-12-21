import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { verifyTelnyxSignature } from "@/lib/telnyx-webhooks";
import {
  storeWebrtcCallLegMapping,
  getWebrtcCallLegMappingBySessionId,
} from "@/lib/mobile-call-leg-store";

async function dialAndBridge({ to, from, linkTo, connectionId }) {
  const url = buildTelnyxV2Url("/calls");
  const body = {
    to,
    from,
    connection_id: connectionId,
    link_to: linkTo,
    bridge_intent: true,
    bridge_on_answer: true,
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    console.error("[voice-webhook] dial failed", resp.status, t);
    return null;
  }
  const result = await resp.json();
  // Return the call_control_id from the dial response
  return result?.data?.call_control_id || null;
}

/**
 * Create or update interaction record for outbound call
 */
async function createOutboundInteraction({
  callControlId,
  callSessionId,
  fromNumber,
  toNumber,
  username,
  webrtcCallControlId,
  pstnCallControlId,
  connectionId,
}) {
  try {
    const { PgDb } = await import("@/lib/pgdb.js");

    // Try to get username from connection lookup if not provided
    // Use connectionId (user's WebRTC connection) for lookup, not the call control connection
    let agentUsername = username;
    if (!agentUsername && connectionId) {
      try {
        // Lookup user by telephony_credentials_id (WebRTC connection ID)
        const { getPostgresPool } = await import("@/lib/postgres.mjs");
        const pool = getPostgresPool();
        if (pool) {
          const result = await pool.query(
            "SELECT username FROM users WHERE telephony_credentials_id = $1 LIMIT 1",
            [connectionId]
          );
          if (result.rows?.[0]?.username) {
            agentUsername = result.rows[0].username;
            console.log(
              `[voice-webhook] Found username from WebRTC connection: ${agentUsername}`
            );
          }
        }
      } catch (err) {
        console.warn(
          "[voice-webhook] Could not lookup user by connection ID:",
          err
        );
      }
    }

    // Check if interaction already exists
    let interaction = await PgDb.findInteractionByCallControlId(callControlId);

    if (!interaction) {
      // Create new outbound interaction
      const interactionId = await PgDb.insertInteraction({
        interactionType: "voice",
        queueName: "OUTBOUND", // Special queue name for outbound calls
        callControlId,
        callSessionId,
        direction: "outbound",
        state: "ringing",
        isContactCenter: false, // Outbound calls are not part of contact center queues
        fromNumber: fromNumber || null,
        toNumber: toNumber || null,
        agentUsername: agentUsername || null,
        metadata: {
          webrtc_call_control_id: webrtcCallControlId || null,
          pstn_call_control_id: pstnCallControlId || null,
          is_outbound_call: true,
        },
      });

      console.log(
        `[voice-webhook] ✅ Created outbound interaction: ${interactionId}`
      );
      return interactionId;
    } else {
      // Update existing interaction with PSTN leg info if available
      if (pstnCallControlId && !interaction.metadata?.pstn_call_control_id) {
        const metadata = interaction.metadata || {};
        metadata.pstn_call_control_id = pstnCallControlId;
        await PgDb.updateInteractionById(interaction.id, {
          metadata,
        });
        console.log(
          `[voice-webhook] ✅ Updated interaction ${interaction.id} with PSTN leg`
        );
      }
      return interaction.id;
    }
  } catch (err) {
    console.error("[voice-webhook] Error creating outbound interaction:", err);
    return null;
  }
}

export async function POST(request) {
  try {
    const raw = await request.text();
    const ok = await verifyTelnyxSignature(request, raw);
    if (!ok)
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    const json = JSON.parse(raw || "{}");

    const eventType = json?.data?.event_type || json?.event_type || "";
    const payload = json?.data?.payload || json?.data || {};
    const callControlId = payload?.call_control_id || null;
    const direction = String(payload?.direction || "").toLowerCase();
    const state = String(payload?.state || "").toLowerCase();

    // REQUIRED: TELNYX_CALL_CONTROL_ID must be configured
    const connectionId = process.env.TELNYX_CALL_CONTROL_ID;
    if (!connectionId) {
      const error = new Error(
        "TELNYX_CALL_CONTROL_ID environment variable is required but not configured. " +
          "Please set this environment variable to a valid Telnyx call control connection ID."
      );
      error.code = "MISSING_CALL_CONTROL_ID";
      throw error;
    }

    const to = payload?.to || null;
    const from = payload?.from || null;
    const payloadConnectionId = payload?.connection_id || null; // User's WebRTC connection ID

    // Extract X-RTC-CALLID from custom headers (present in WebRTC calls)
    const customHeaders = payload?.custom_headers || [];
    const rtcCallIdHeader = customHeaders.find(
      (header) => header?.name === "X-RTC-CALLID"
    );
    const rtcCallId = rtcCallIdHeader?.value || null;

    // Extract username from custom headers
    let username = null;
    const usernameHeader = customHeaders.find(
      (header) =>
        header?.name === "X-Username" || header?.name === "X-Agent-Username"
    );
    username = usernameHeader?.value || null;

    // If username not in headers, try to get from connection lookup
    if (!username && payloadConnectionId) {
      try {
        const { getPostgresPool } = await import("@/lib/postgres.mjs");
        const pool = getPostgresPool();
        if (pool) {
          const result = await pool.query(
            "SELECT username FROM users WHERE telephony_credentials_id = $1 LIMIT 1",
            [payloadConnectionId]
          );
          if (result.rows?.[0]?.username) {
            username = result.rows[0].username;
          }
        }
      } catch (err) {
        // Ignore errors, username will remain null
      }
    }

    console.log("[voice-webhook] 📞 Webhook received:", {
      eventType,
      callControlId,
      direction,
      state,
      hasRtcCallId: !!rtcCallId,
      rtcCallId,
      callSessionId: payload?.call_session_id,
      to,
      from,
      username,
    });

    // Handle first leg (WebRTC leg) call.initiated webhook
    // This leg has X-RTC-CALLID header - we need to initiate dialAndBridge
    if (
      eventType === "call.initiated" &&
      callControlId &&
      direction === "outgoing" &&
      rtcCallId
    ) {
      try {
        const callSessionId = payload?.call_session_id;
        console.log(
          "[voice-webhook] 🔵 First leg (WebRTC) call.initiated detected:",
          {
            rtcCallId,
            callControlId,
            callSessionId,
            to,
            from,
            username,
          }
        );

        // Create outbound interaction for WebRTC leg
        await createOutboundInteraction({
          callControlId,
          callSessionId,
          fromNumber: from,
          toNumber: to,
          username,
          webrtcCallControlId: callControlId,
          pstnCallControlId: null,
          connectionId,
        });

        // Store initial mapping with X-RTC-CALLID
        if (callSessionId) {
          storeWebrtcCallLegMapping(rtcCallId, {
            rtcCallId,
            callSessionId,
            webrtcCallControlId: callControlId,
            pstnCallControlId: null, // Will be updated when second leg arrives
            fromNumber: from,
            toNumber: to,
            username,
            connectionId: payloadConnectionId,
          });
        }

        // Initiate dialAndBridge to create second leg
        console.log(
          "[voice-webhook] 📞 Calling dialAndBridge to create second leg..."
        );
        const pstnCallControlId = await dialAndBridge({
          to,
          from,
          linkTo: callControlId,
          connectionId,
        });

        console.log("[voice-webhook] 📞 dialAndBridge response:", {
          pstnCallControlId,
          webrtcCallControlId: callControlId,
        });

        // Update mapping if we got PSTN leg call_control_id from dial response
        if (pstnCallControlId && callSessionId) {
          storeWebrtcCallLegMapping(rtcCallId, {
            rtcCallId,
            callSessionId,
            webrtcCallControlId: callControlId,
            pstnCallControlId,
            fromNumber: from,
            toNumber: to,
            username,
            connectionId: payloadConnectionId,
          });
          console.log(
            "[voice-webhook] ✅ Updated mapping with PSTN leg from dial response:",
            {
              rtcCallId,
              pstnCallControlId,
            }
          );

          // Update interaction with PSTN leg
          await createOutboundInteraction({
            callControlId: callControlId, // Use WebRTC leg's ID to find existing interaction
            callSessionId,
            fromNumber: from,
            toNumber: to,
            username,
            webrtcCallControlId: callControlId,
            pstnCallControlId,
            connectionId: payloadConnectionId, // User's WebRTC connection ID
          });
        }
      } catch (err) {
        console.error("[voice-webhook] ❌ Error in dialAndBridge:", err);
      }
    }

    // Handle second leg (PSTN leg) call.initiated webhook
    // This leg will NOT have X-RTC-CALLID header but will share the same call_session_id
    if (
      eventType === "call.initiated" &&
      callControlId &&
      direction === "outgoing" &&
      !rtcCallId && // No X-RTC-CALLID means this is the PSTN leg
      payload?.call_session_id
    ) {
      const callSessionId = payload?.call_session_id;
      console.log(
        "[voice-webhook] 🟢 Second leg (PSTN) call.initiated detected:",
        {
          callControlId,
          callSessionId,
          to,
          from,
        }
      );

      // Try to find the WebRTC leg by call_session_id
      const mapping = getWebrtcCallLegMappingBySessionId(callSessionId);
      if (mapping) {
        // Update mapping with PSTN leg's call_control_id
        storeWebrtcCallLegMapping(mapping.rtcCallId, {
          ...mapping,
          pstnCallControlId: callControlId,
        });
        console.log(
          "[voice-webhook] ✅ Updated mapping with PSTN leg call_control_id:",
          {
            rtcCallId: mapping.rtcCallId,
            webrtcCallControlId: mapping.webrtcCallControlId,
            pstnCallControlId: callControlId,
            callSessionId,
          }
        );

        // Update interaction with PSTN leg info
        await createOutboundInteraction({
          callControlId: mapping.webrtcCallControlId, // Use WebRTC leg's ID to find existing interaction
          callSessionId,
          fromNumber: mapping.fromNumber || from,
          toNumber: mapping.toNumber || to,
          username: mapping.username,
          webrtcCallControlId: mapping.webrtcCallControlId,
          pstnCallControlId: callControlId,
          connectionId: payloadConnectionId || mapping.connectionId, // User's WebRTC connection ID
        });
      } else {
        console.warn(
          "[voice-webhook] ⚠️ Second leg received but no mapping found for call_session_id:",
          callSessionId
        );
        // Still create interaction for PSTN leg if mapping not found
        await createOutboundInteraction({
          callControlId,
          callSessionId,
          fromNumber: from,
          toNumber: to,
          username: null,
          webrtcCallControlId: null,
          pstnCallControlId: callControlId,
          connectionId: payloadConnectionId, // User's WebRTC connection ID
        });
      }
    }

    // Handle call.recording.saved - store recording URL for outbound calls
    if (eventType === "call.recording.saved" && callControlId) {
      try {
        const { PgDb } = await import("@/lib/pgdb.js");
        const interaction = await PgDb.findInteractionByCallControlId(
          callControlId
        );

        if (interaction && interaction.metadata?.is_outbound_call) {
          const recordingUrl =
            payload?.recording_urls?.public_recording_urls?.[0] ||
            payload?.recording_urls?.recording_urls?.[0] ||
            payload?.public_recording_urls?.[0] ||
            payload?.recording_url ||
            null;
          if (recordingUrl) {
            await PgDb.updateInteractionById(interaction.id, {
              recordingUrl,
            });
            console.log(
              `[voice-webhook] ✅ Stored recording URL for outbound interaction ${interaction.id}: ${recordingUrl}`
            );
          }
        }
      } catch (err) {
        console.error(
          "[voice-webhook] Error handling call.recording.saved:",
          err
        );
      }
    }

    // Handle call state updates for outbound calls
    if (
      (eventType === "call.answered" ||
        eventType === "call.bridged" ||
        eventType === "call.hangup") &&
      callControlId
    ) {
      try {
        const { PgDb } = await import("@/lib/pgdb.js");
        const interaction = await PgDb.findInteractionByCallControlId(
          callControlId
        );

        if (interaction && interaction.metadata?.is_outbound_call) {
          const updates = {};
          if (eventType === "call.answered" || eventType === "call.bridged") {
            updates.state = "connected";
            if (!interaction.answered_at) {
              updates.answeredAt = new Date().toISOString();
            }
          } else if (eventType === "call.hangup") {
            updates.state = "completed";
            updates.completedAt = new Date().toISOString();
            if (interaction.answered_at) {
              const handleTime = Math.floor(
                (new Date().getTime() -
                  new Date(interaction.answered_at).getTime()) /
                  1000
              );
              updates.handleTimeSeconds = handleTime;
              // Note: talk time, hold count/duration, and transfer count/history
              // are tracked in the WebRTC client store and synced via /api/contact-center/interactions/[id]/metrics
            }
          }

          if (Object.keys(updates).length > 0) {
            await PgDb.updateInteractionById(interaction.id, updates);
            console.log(
              `[voice-webhook] ✅ Updated outbound interaction ${interaction.id}:`,
              updates
            );
          }
        }
      } catch (err) {
        console.error(
          "[voice-webhook] Error updating outbound interaction:",
          err
        );
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Check if it's a missing environment variable error
    if (err.code === "MISSING_CALL_CONTROL_ID") {
      console.error("[voice-webhook] MISSING_CALL_CONTROL_ID:", err.message);
      return NextResponse.json(
        {
          error: "Configuration Error",
          code: "MISSING_CALL_CONTROL_ID",
          details:
            "TELNYX_CALL_CONTROL_ID environment variable is not configured",
        },
        { status: 500 }
      );
    }

    console.error("[voice-webhook] Server error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
