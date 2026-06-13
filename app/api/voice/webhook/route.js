import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { verifyTelnyxSignature } from "@/lib/telnyx-webhooks";
import {
  storeWebrtcCallLegMapping,
  getWebrtcCallLegMappingBySessionId,
} from "@/lib/mobile-call-leg-store";
import { finalizeAgentlessAttemptByWebhook } from "@/lib/outbound-dialer/execution";
import { startAgentlessAiAssistantForCall } from "@/lib/outbound-dialer/ai-assistant";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

async function dialAndBridge({
  to,
  from,
  linkTo,
  connectionId,
  isConsultCall = false,
  fromDisplayName = null,
}) {
  const url = buildTelnyxV2Url("/calls");
  const body = {
    to,
    from,
    connection_id: connectionId,
    link_to: linkTo,
    bridge_intent: true,
    bridge_on_answer: true,
  };

  // Add caller ID display name if provided
  if (fromDisplayName) {
    body.from_display_name = fromDisplayName;
  }

  // For consult calls, add park_after_unbridge so switching between call legs
  // doesn't disconnect the consultant - they stay parked instead
  // Valid value per Telnyx OpenAPI spec: "self" (parks current leg after unbridge)
  if (isConsultCall) {
    body.park_after_unbridge = "self";

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

    return null;
  }
  const result = await resp.json();
  // Return the call_control_id from the dial response
  return result?.data?.call_control_id || null;
}

async function findHardphoneByConnectionId(connectionId) {
  if (!connectionId) return null;
  try {
    const { getPostgresPool } = await import("@/lib/postgres.mjs");
    const pool = getPostgresPool();
    if (!pool) return null;
    const { rows } = await pool.query(
      `SELECT hp.id, hp.phone_name, hp.label, hp.mac, hp.vendor, hp.model,
              hp.agent_id, hp.telnyx_connection_id, hp.assigned_phone_number,
              hp.sip_username,
              u.username, u.voice_number, u.first_name, u.last_name
       FROM hp_phones hp
       LEFT JOIN users u ON u.id::text = hp.agent_id OR u.username = hp.agent_id
       WHERE hp.telnyx_connection_id = $1
       LIMIT 1`,
      [connectionId],
    );
    return rows?.[0] || null;
  } catch {
    return null;
  }
}

async function updateHardphoneOutboundPstnLegBySession({ callSessionId, pstnCallControlId }) {
  if (!callSessionId || !pstnCallControlId) return false;
  try {
    const { getPostgresPool } = await import("@/lib/postgres.mjs");
    const pool = getPostgresPool();
    if (!pool) return false;
    const { rowCount } = await pool.query(
      `UPDATE cc_interactions
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
           updated_at = NOW()
       WHERE call_session_id = $2
         AND metadata->>'is_hardphone_outbound_call' = 'true'
         AND (metadata->>'pstn_call_control_id' IS NULL OR metadata->>'pstn_call_control_id' = '')`,
      [JSON.stringify({ pstn_call_control_id: pstnCallControlId }), callSessionId],
    );
    return rowCount > 0;
  } catch {
    return false;
  }
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
  hardphoneCallControlId,
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

          }
        }
      } catch (err) {

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
          hardphone_call_control_id: hardphoneCallControlId || null,
          pstn_call_control_id: pstnCallControlId || null,
          is_outbound_call: true,
          ...additionalMetadata,
        },
      });


      return interactionId;
    } else {
      // Update existing interaction with PSTN leg info if available
      if (pstnCallControlId && !interaction.metadata?.pstn_call_control_id) {
        const metadata = interaction.metadata || {};
        metadata.pstn_call_control_id = pstnCallControlId;
        await PgDb.updateInteractionById(interaction.id, {
          metadata,
        });

      }
      return interaction.id;
    }
  } catch (err) {

    return null;
  }
}

export async function POST(request) {
  try {
    const raw = await request.text();
    const ok = await verifyTelnyxSignature(request, raw);
    const enforceSignature = String(process.env.TELNYX_ENFORCE_WEBHOOK_SIGNATURE || "true").toLowerCase() === "true";
    if (!ok) {

      if (enforceSignature) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    }

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



    let handledHardphoneOutboundInitiated = false;

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
            const toSipUser = toValue.includes("@")
              ? toValue.split("@")[0]
              : toValue;



            // Try lookup by username first (if available)
            if (username) {
              const result = await pool.query(
                `SELECT * FROM cc_interactions 
                 WHERE agent_username = $1 
                   AND metadata->>'consult_state' IS NOT NULL
                   AND (metadata->'consult_state'->>'pendingConsult')::boolean = true
                 ORDER BY created_at DESC LIMIT 1`,
                [username]
              );
              if (result.rows?.[0]) {
                consultInteraction = result.rows[0];

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
                [toValue, `%${toSipUser}@%`]
              );
              if (result.rows?.[0]) {
                consultInteraction = result.rows[0];

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
                [payloadConnectionId]
              );
              if (result.rows?.[0]) {
                consultInteraction = result.rows[0];

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

            } else {

            }
          }
        } catch (consultCheckErr) {

        }

        // Get user's phone number and display name for the PSTN leg
        // Use voice_number from profile, or fallback to TELNYX_MAIN_FROM_NUMBER
        let effectiveFromNumber = from;
        let fromDisplayName = null;



        if (username || payloadConnectionId) {
          try {
            const { getPostgresPool } = await import("@/lib/postgres.mjs");
            const pool = getPostgresPool();
            if (pool) {
              let userQuery;
              let userParams;

              if (username) {
                userQuery =
                  "SELECT voice_number, first_name, last_name FROM users WHERE username = $1 LIMIT 1";
                userParams = [username];

              } else {
                userQuery =
                  "SELECT voice_number, first_name, last_name FROM users WHERE telephony_credentials_id = $1 LIMIT 1";
                userParams = [payloadConnectionId];

              }

              const userResult = await pool.query(userQuery, userParams);


              if (userResult.rows?.[0]) {
                const user = userResult.rows[0];
                // Use voice_number or fallback to TELNYX_MAIN_FROM_NUMBER
                effectiveFromNumber =
                  user.voice_number ||
                  process.env.TELNYX_MAIN_FROM_NUMBER ||
                  from;

                // Build display name from first_name and last_name
                const nameParts = [user.first_name, user.last_name].filter(
                  Boolean
                );
                if (nameParts.length > 0) {
                  fromDisplayName = nameParts.join(" ");
                }


              } else {

              }
            }
          } catch (userLookupErr) {

          }
        }

        // Always check if we need to use TELNYX_MAIN_FROM_NUMBER as fallback
        // This handles cases where:
        // 1. User lookup failed
        // 2. User has no voice_number
        // 3. From is a SIP URI (WebRTC username)
        if (
          !effectiveFromNumber ||
          effectiveFromNumber.includes("@sip.") ||
          effectiveFromNumber.startsWith("sip:")
        ) {
          const mainFromNumber = process.env.TELNYX_MAIN_FROM_NUMBER;
          if (mainFromNumber) {

            effectiveFromNumber = mainFromNumber;
          } else {

          }
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
          fromNumber: effectiveFromNumber, // Use effective from number
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
            fromNumber: effectiveFromNumber, // Use effective from number
            toNumber: to,
            username,
            connectionId: payloadConnectionId,
          });
        }

        // Initiate dialAndBridge to create second leg
        // For consult calls, pass isConsultCall=true to enable park_after_unbridge

        const pstnCallControlId = await dialAndBridge({
          to,
          from: effectiveFromNumber,
          linkTo: callControlId,
          connectionId,
          isConsultCall: !!consultInteraction,
          fromDisplayName,
        });



        // If this is a consult call, update the original interaction's consult_state
        // Update even if pstnCallControlId is null - we still need to save agentCallControlId
        if (consultInteraction) {

          try {
            const { PgDb } = await import("@/lib/pgdb.js");
            const { addTimelineEvent, TimelineEventTypes } = await import(
              "@/lib/contact-center/call-timeline-tracker.js"
            );
            const consultState =
              consultInteraction.metadata?.consult_state || {};
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
              }
            );
            await PgDb.updateInteractionById(consultInteraction.id, {
              metadata: updatedMetadata,
              routingMetadata: updatedRoutingMetadata,
            });

          } catch (consultUpdateErr) {

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

      }
    }

    // Handle first leg from a physical hardphone credential connection.
    // These calls have no X-RTC-CALLID, because the SIP device originated them
    // directly. With call_parking_enabled=true Telnyx parks this leg and waits
    // for our Call Control action, so reuse dialAndBridge with link_to just like
    // the WebRTC path, but skip WebRTC-specific leg mapping/headers.
    if (
      eventType === "call.initiated" &&
      callControlId &&
      direction === "outgoing" &&
      !rtcCallId &&
      payloadConnectionId
    ) {
      const hardphone = await findHardphoneByConnectionId(payloadConnectionId);
      if (hardphone) {
        handledHardphoneOutboundInitiated = true;
        const callSessionId = payload?.call_session_id;
        const effectiveFromNumber = hardphone.assigned_phone_number || hardphone.voice_number || from || process.env.TELNYX_MAIN_FROM_NUMBER || null;
        const nameParts = [hardphone.first_name, hardphone.last_name].filter(Boolean);
        const fromDisplayName = nameParts.length
          ? nameParts.join(" ")
          : hardphone.phone_name || hardphone.label || null;
        const hardphoneUsername = hardphone.username || null;

        await createOutboundInteraction({
          callControlId,
          callSessionId,
          fromNumber: effectiveFromNumber,
          toNumber: to,
          username: hardphoneUsername,
          webrtcCallControlId: null,
          hardphoneCallControlId: callControlId,
          pstnCallControlId: null,
          connectionId: payloadConnectionId,
          metadata: {
            is_hardphone_outbound_call: true,
            source: "hardphone",
            hardphone_id: hardphone.id,
            hardphone_mac: hardphone.mac,
            hardphone_connection_id: payloadConnectionId,
          },
        });

        const pstnCallControlId = await dialAndBridge({
          to,
          from: effectiveFromNumber,
          linkTo: callControlId,
          connectionId,
          fromDisplayName,
        });

        if (pstnCallControlId) {
          await createOutboundInteraction({
            callControlId,
            callSessionId,
            fromNumber: effectiveFromNumber,
            toNumber: to,
            username: hardphoneUsername,
            webrtcCallControlId: null,
            hardphoneCallControlId: callControlId,
            pstnCallControlId: pstnCallControlId,
            connectionId: payloadConnectionId,
            metadata: {
              is_hardphone_outbound_call: true,
              source: "hardphone",
              hardphone_id: hardphone.id,
              hardphone_mac: hardphone.mac,
              hardphone_connection_id: payloadConnectionId,
            },
          });
        }
      }
    }

    // Handle second leg (PSTN leg) call.initiated webhook
    // This leg will NOT have X-RTC-CALLID header but will share the same call_session_id
    if (
      eventType === "call.initiated" &&
      callControlId &&
      direction === "outgoing" &&
      !rtcCallId && // No X-RTC-CALLID means this is the PSTN leg
      !handledHardphoneOutboundInitiated &&
      payload?.call_session_id
    ) {
      const callSessionId = payload?.call_session_id;


      // Try to find the WebRTC leg by call_session_id
      const mapping = getWebrtcCallLegMappingBySessionId(callSessionId);
      if (mapping) {
        // Update mapping with PSTN leg's call_control_id
        storeWebrtcCallLegMapping(mapping.rtcCallId, {
          ...mapping,
          pstnCallControlId: callControlId,
        });


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
        const updatedHardphoneInteraction = await updateHardphoneOutboundPstnLegBySession({
          callSessionId,
          pstnCallControlId: callControlId,
        });
        if (!updatedHardphoneInteraction) {

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

          }
        }
      } catch (err) {

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
        const { getPostgresPool } = await import("@/lib/postgres.mjs");
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

          }
        }

        const pool = getPostgresPool();
        if (pool) {
          const finalizedLedger = await finalizeAgentlessAttemptByWebhook(pool, {
            callControlId,
            eventType,
            hangupCause: payload?.hangup_cause || null,
            sipHangupCause: payload?.sip_hangup_cause || null,
            eventId: json?.data?.id || json?.id || null,
          });

          const finalizedMetadata = finalizedLedger?.metadata && typeof finalizedLedger.metadata === "object"
            ? finalizedLedger.metadata
            : {};
          const payloadMetadata = payload?.metadata && typeof payload.metadata === "object"
            ? payload.metadata
            : {};
          const outboundHandlerType = finalizedMetadata?.outbound_handler_type || finalizedLedger?.handler_type || payloadMetadata?.outbound_handler_type;
          const outboundHandlerRef = finalizedMetadata?.outbound_handler_ref || finalizedLedger?.handler_ref || payloadMetadata?.outbound_handler_ref;

          if (
            eventType === "call.answered" &&
            outboundHandlerType === "ai_assistant" &&
            outboundHandlerRef &&
            callControlId
          ) {
            const startedAt = finalizedMetadata?.ai_assistant_started_at;
            if (!startedAt) {
              try {
                const assistantStart = await startAgentlessAiAssistantForCall({
                  callControlId,
                  assistantId: outboundHandlerRef,
                  eventType,
                  ledgerId: finalizedLedger?.id || payloadMetadata?.outbound_ledger_id || null,
                  campaignId: finalizedLedger?.campaign_id || payloadMetadata?.outbound_campaign_id || null,
                });

                if (assistantStart.ok) {
                  if (finalizedLedger?.id) {
                    await pool.query(
                      `UPDATE outbound_attempt_ledger
                       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
                           updated_at = NOW()
                       WHERE id = $2`,
                      [
                        JSON.stringify({
                          ai_assistant_started_at: new Date().toISOString(),
                          ai_assistant_id: outboundHandlerRef,
                          ai_assistant_start_command_id: assistantStart.request?.command_id || null,
                        }),
                        finalizedLedger.id,
                      ],
                    );
                  }

                } else {

                }
              } catch (assistErr) {

              }
            }
          }

          if (finalizedLedger) {

          }
        }
      } catch (err) {

      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Check if it's a missing environment variable error
    if (err.code === "MISSING_CALL_CONTROL_ID") {

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


    voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
