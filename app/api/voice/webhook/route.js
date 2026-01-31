import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { verifyTelnyxSignature } from "@/lib/telnyx-webhooks";
import {
  storeWebrtcCallLegMapping,
  getWebrtcCallLegMappingBySessionId,
} from "@/lib/mobile-call-leg-store";

async function dialAndBridge({ to, from, linkTo, connectionId, isConsultCall = false }) {
  const url = buildTelnyxV2Url("/calls");
  const body = {
    to,
    from,
    connection_id: connectionId,
    link_to: linkTo,
    bridge_intent: true,
    bridge_on_answer: true,
  };
  
  // For consult calls, add park_after_unbridge so switching between call legs
  // doesn't disconnect the consultant - they stay parked instead
  // Valid value per Telnyx OpenAPI spec: "self" (parks current leg after unbridge)
  if (isConsultCall) {
    body.park_after_unbridge = "self";
    console.log("[voice-webhook] 📞 dialAndBridge for consult call - adding park_after_unbridge=self");
  }
  
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
  metadata: additionalMetadata = {},
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
          ...additionalMetadata,
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

        // Check if this is a consult call by looking for pending consult
        // Try multiple lookup methods: username, consultantTarget (SIP URI), or telephonyUserName
        let consultInteraction = null;
        try {
          const { PgDb } = await import("@/lib/pgdb.js");
          const { getPostgresPool } = await import("@/lib/postgres.mjs");
          const pool = getPostgresPool();
          if (pool) {
            // Extract the destination for matching
            const toValue = to?.phone_number || to || "";
            const toSipUser = toValue.includes("@") ? toValue.split("@")[0] : toValue;
            
            console.log(`[voice-webhook] 🔍 Looking for pending consult. username=${username}, to=${toValue}, toSipUser=${toSipUser}`);
            
            // Try lookup by username first (if available)
            if (username) {
              const result = await pool.query(
                `SELECT * FROM cc_interactions 
                 WHERE agent_username = $1 
                   AND metadata->>'consult_state' IS NOT NULL
                   AND (metadata->'consult_state'->>'pendingConsult')::boolean = true
                 ORDER BY created_at DESC LIMIT 1`,
                [username],
              );
              if (result.rows?.[0]) {
                consultInteraction = result.rows[0];
                console.log(`[voice-webhook] 🔍 Found pending consult by username: ${username}`);
              }
            }
            
            // If not found by username, try by consultantTarget matching the 'to' field
            if (!consultInteraction && toValue) {
              // Match by full SIP URI or just the SIP username part
              const result = await pool.query(
                `SELECT * FROM cc_interactions 
                 WHERE metadata->>'consult_state' IS NOT NULL
                   AND (metadata->'consult_state'->>'pendingConsult')::boolean = true
                   AND (
                     metadata->'consult_state'->>'consultantTarget' = $1
                     OR metadata->'consult_state'->>'consultantTarget' LIKE $2
                   )
                 ORDER BY created_at DESC LIMIT 1`,
                [toValue, `%${toSipUser}@%`],
              );
              if (result.rows?.[0]) {
                consultInteraction = result.rows[0];
                console.log(`[voice-webhook] 🔍 Found pending consult by consultantTarget: ${toValue}`);
              }
            }
            
            // If not found, try by telephonyUserName (agent's WebRTC connection)
            if (!consultInteraction && payloadConnectionId) {
              const result = await pool.query(
                `SELECT * FROM cc_interactions 
                 WHERE metadata->>'consult_state' IS NOT NULL
                   AND (metadata->'consult_state'->>'pendingConsult')::boolean = true
                   AND metadata->'consult_state'->>'connectionId' = $1
                 ORDER BY created_at DESC LIMIT 1`,
                [payloadConnectionId],
              );
              if (result.rows?.[0]) {
                consultInteraction = result.rows[0];
                console.log(`[voice-webhook] 🔍 Found pending consult by connectionId: ${payloadConnectionId}`);
              }
            }
            
            // Parse the interaction if found
            if (consultInteraction) {
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
              consultInteraction = {
                ...consultInteraction,
                metadata: safeParse(consultInteraction.metadata),
              };
              const consultantTarget =
                consultInteraction.metadata?.consult_state?.consultantTarget;
              console.log(
                `[voice-webhook] 🔵 Consult call detected for interaction ${consultInteraction.id} (consultantTarget: ${consultantTarget}, webhook to: ${toValue})`,
              );
            } else {
              console.log(`[voice-webhook] 🔍 No pending consult found for this call`);
            }
          }
        } catch (consultCheckErr) {
          console.error(
            "[voice-webhook] Error checking for consult call:",
            consultCheckErr,
          );
        }

        // Create outbound interaction for WebRTC leg
        // If this is a consult call, mark it accordingly
        const interactionMetadata = consultInteraction
          ? {
              is_consult_call: true,
              consult_interaction_id: consultInteraction.id,
              original_interaction_id: consultInteraction.id,
            }
          : {};

        await createOutboundInteraction({
          callControlId,
          callSessionId,
          fromNumber: from,
          toNumber: to,
          username,
          webrtcCallControlId: callControlId,
          pstnCallControlId: null,
          connectionId,
          metadata: interactionMetadata,
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
        // For consult calls, pass isConsultCall=true to enable park_after_unbridge
        console.log(
          "[voice-webhook] 📞 Calling dialAndBridge to create second leg...",
          consultInteraction ? "(consult call)" : "(regular outbound)"
        );
        const pstnCallControlId = await dialAndBridge({
          to,
          from,
          linkTo: callControlId,
          connectionId,
          isConsultCall: !!consultInteraction,
        });

        console.log("[voice-webhook] 📞 dialAndBridge response:", {
          pstnCallControlId,
          webrtcCallControlId: callControlId,
        });

        // If this is a consult call, update the original interaction's consult_state
        // Update even if pstnCallControlId is null - we still need to save agentCallControlId
        if (consultInteraction) {
          console.log(`[voice-webhook] 🔵 Updating consult_state for interaction ${consultInteraction.id} with agentCallControlId=${callControlId}, pstnCallControlId=${pstnCallControlId}`);
          try {
            const { PgDb } = await import("@/lib/pgdb.js");
            const { addTimelineEvent, TimelineEventTypes } = await import(
              "@/lib/contact-center/call-timeline-tracker.js"
            );
            const consultState = consultInteraction.metadata?.consult_state || {};
            const updatedMetadata = {
              ...consultInteraction.metadata,
              consult_state: {
                ...consultState,
                isActive: true,
                pendingConsult: false,
                // Store the new agent call control ID for the consult call
                // This is the WebRTC leg that connects agent to consultant
                agentCallControlId: callControlId,
                consultantCallControlId: callControlId, // Same as agentCallControlId for WebRTC leg
                pstnCallControlId: pstnCallControlId, // PSTN leg to consultant
                consultantCallInitiatedAt: new Date().toISOString(),
              },
            };
            const updatedRoutingMetadata = addTimelineEvent(
              consultInteraction.routing_metadata || {},
              TimelineEventTypes.CONSULT_INITIATED,
              {
                consultantCallControlId: callControlId,
                consultantTarget: consultState.consultantTarget,
                agentCallControlId: callControlId,
              },
            );
            await PgDb.updateInteractionById(consultInteraction.id, {
              metadata: updatedMetadata,
              routingMetadata: updatedRoutingMetadata,
            });
            console.log(
              `[voice-webhook] ✅ Updated consult interaction ${consultInteraction.id} with active consult state`,
            );
          } catch (consultUpdateErr) {
            console.error(
              "[voice-webhook] Error updating consult interaction:",
              consultUpdateErr,
            );
          }
        }

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

    // Handle call.recording.saved - store recording payload for outbound calls
    if (eventType === "call.recording.saved" && callControlId) {
      try {
        const { PgDb } = await import("@/lib/pgdb.js");
        const interaction = await PgDb.findInteractionByCallControlId(
          callControlId
        );

        if (interaction && interaction.metadata?.is_outbound_call) {
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
          await PgDb.updateInteractionById(interaction.id, {
            recordingUrl: recordingUrl || interaction.recording_url || null,
            metadata: updatedMetadata,
          });
          if (recordingUrl) {
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
