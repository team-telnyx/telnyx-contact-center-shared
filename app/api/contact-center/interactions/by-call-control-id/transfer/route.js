import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { PgDb } from "@/lib/pgdb";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { broadcastToKey } from "@/lib/sse";
import {
  addTimelineEvent,
  TimelineEventTypes,
} from "@/lib/contact-center/call-timeline-tracker.js";

/**
 * POST /api/contact-center/interactions/by-call-control-id/transfer?callControlId=...
 * Transfer a call by call_control_id
 */
export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { searchParams } = new URL(request.url);
    const callControlId = searchParams.get("callControlId");
    const body = await request.json();
    const { type, target, preserveRoutingOptions = false } = body; // type: 'agent' | 'queue' | 'external', target: username/queueId/number

    if (!callControlId) {
      return NextResponse.json(
        { ok: false, error: "callControlId is required" },
        { status: 400 },
      );
    }

    if (!type || !target) {
      return NextResponse.json(
        { ok: false, error: "type and target are required" },
        { status: 400 },
      );
    }

    console.log(
      `[Transfer] Looking up interaction for callControlId: ${callControlId}`,
    );

    // Find interaction by call_control_id using the same logic as GET endpoint
    // Note: This may find the interaction even if callControlId is the WebRTC leg
    // (because webrtc-bridge.js updates interaction.call_control_id to the agent's WebRTC leg)
    let interaction = await PgDb.findInteractionByCallControlId(callControlId);
    console.log(
      `[Transfer] Direct lookup by callControlId: ${
        interaction ? "found" : "not found"
      }`,
    );

    // If not found, check incoming call store and calls store
    if (!interaction) {
      try {
        // First check incoming call store
        const { getIncomingCallData } =
          await import("@/lib/incoming-call-store");
        const callData = getIncomingCallData(callControlId);

        if (callData?.originalCallControlId) {
          console.log(
            `[Transfer] Found originalCallControlId in incoming call store: ${callData.originalCallControlId}`,
          );
          interaction = await PgDb.findInteractionByCallControlId(
            callData.originalCallControlId,
          );
          console.log(
            `[Transfer] Lookup by originalCallControlId: ${
              interaction ? "found" : "not found"
            }`,
          );
        }

        if (!interaction && callData?.interactionId) {
          console.log(
            `[Transfer] Found interactionId in incoming call store: ${callData.interactionId}`,
          );
          interaction = await PgDb.findInteractionById(callData.interactionId);
          console.log(
            `[Transfer] Lookup by interactionId: ${
              interaction ? "found" : "not found"
            }`,
          );
        }

        // Also check calls store (client-side store, but we can check if callControlId matches)
        // The calls store is client-side only, so we can't directly access it here
        // But we can try looking up by the originalCallControlId if we find it in metadata
      } catch (err) {
        console.warn("[Transfer] Error checking incoming call store:", err);
      }
    }

    // If still not found, try looking up by call_session_id or by metadata.agent_call_control_id
    // (in case the callControlId is the agent's WebRTC leg)
    if (!interaction) {
      try {
        const { getPostgresPool } = await import("@/lib/postgres.mjs");
        const pool = getPostgresPool();
        if (pool) {
          // Try lookup by metadata.agent_call_control_id first (for WebRTC legs)
          let result = await pool.query(
            `SELECT * FROM cc_interactions 
             WHERE metadata->>'agent_call_control_id' = $1 
             AND is_contact_center = true
             ORDER BY created_at DESC
             LIMIT 1`,
            [callControlId],
          );

          if (!result.rows?.[0]) {
            // Also try lookup by metadata.original_call_control_id (in case it's stored there)
            result = await pool.query(
              `SELECT * FROM cc_interactions 
               WHERE metadata->>'original_call_control_id' = $1 
               AND is_contact_center = true
               ORDER BY created_at DESC
               LIMIT 1`,
              [callControlId],
            );
          }

          if (!result.rows?.[0]) {
            // Fallback: lookup by call_session_id using subquery
            result = await pool.query(
              `SELECT * FROM cc_interactions 
               WHERE call_session_id IN (
                 SELECT call_session_id FROM cc_interactions 
                 WHERE call_control_id = $1 
                 LIMIT 1
               )
               AND is_contact_center = true
               ORDER BY created_at ASC
               LIMIT 1`,
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
            console.log(
              `[Transfer] Found interaction by metadata.agent_call_control_id or call_session_id`,
            );
          }
        }
      } catch (err) {
        console.warn(
          "[Transfer] Error looking up by metadata or call_session_id:",
          err,
        );
      }
    }

    if (!interaction) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found for this call" },
        { status: 404 },
      );
    }

    // Determine which call leg to transfer
    // CRITICAL: For inbound calls transferred to agents, interaction.call_control_id is the agent's WebRTC leg
    // We MUST use metadata.original_call_control_id which is the original PSTN leg that should be transferred
    const isInbound =
      interaction.direction === "inbound" ||
      interaction.direction === "incoming";

    let transferCallControlId = interaction.call_control_id;

    // Priority 1: Check metadata.original_call_control_id (ALWAYS use this for inbound calls transferred to agents)
    // This is stored in webrtc-bridge.js when the call is transferred to the agent
    if (interaction.metadata?.original_call_control_id) {
      transferCallControlId = interaction.metadata.original_call_control_id;
      console.log(
        `[Transfer] ✅ Using original_call_control_id from metadata: ${transferCallControlId} (interaction.call_control_id is WebRTC leg: ${interaction.call_control_id})`,
      );
    } else if (!isInbound && interaction.metadata?.pstn_call_control_id) {
      // Priority 2: Outbound call - use PSTN leg from metadata
      transferCallControlId = interaction.metadata.pstn_call_control_id;
      console.log(
        `[Transfer] ✅ Outbound call - Using PSTN leg call_control_id: ${transferCallControlId}`,
      );
    } else {
      // Fallback: Use interaction.call_control_id (should only happen if call wasn't transferred to agent)
      console.warn(
        `[Transfer] ⚠️ No original_call_control_id in metadata, using interaction.call_control_id: ${transferCallControlId}. This may fail if call was transferred to agent.`,
      );
    }

    console.log(`[Transfer] Transfer call leg selection:`, {
      receivedCallControlId: callControlId,
      interactionCallControlId: interaction.call_control_id,
      metadataOriginalCallControlId:
        interaction.metadata?.original_call_control_id,
      metadataAgentCallControlId: interaction.metadata?.agent_call_control_id,
      metadataPstnCallControlId: interaction.metadata?.pstn_call_control_id,
      finalTransferCallControlId: transferCallControlId,
      direction: interaction.direction,
      isInbound,
    });

    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "TELNYX_API_KEY not configured" },
        { status: 500 },
      );
    }

    let transferParams = {};

    if (type === "agent") {
      // Transfer to another agent
      const { getPostgresPool } = await import("@/lib/postgres.mjs");
      const pool = getPostgresPool();
      if (!pool) {
        return NextResponse.json(
          { ok: false, error: "Database not available" },
          { status: 500 },
        );
      }

      const agentResult = await pool.query(
        "SELECT * FROM users WHERE username = $1 LIMIT 1",
        [target],
      );
      const targetAgent = agentResult.rows?.[0];

      if (!targetAgent || !targetAgent.telephony_user_name) {
        return NextResponse.json(
          {
            ok: false,
            error: "Target agent not found or has no telephony_user_name",
          },
          { status: 400 },
        );
      }

      // Transfer to agent's WebRTC client using SIP URI
      const sipUri = `sip:${targetAgent.telephony_user_name}@sip.telnyx.com`;
      transferParams = {
        to: sipUri,
        from: interaction?.to_number || user.voice_number || null,
        custom_headers: [
          { name: "X-Original-Call-Control-Id", value: transferCallControlId },
          { name: "X-Transfer-From-Agent", value: user.username },
        ],
      };
    } else if (type === "queue") {
      // Transfer to another queue using enqueue command
      const queue = await PgDb.findQueueById(target);
      if (!queue) {
        return NextResponse.json(
          { ok: false, error: "Queue not found" },
          { status: 400 },
        );
      }

      // If preserveRoutingOptions is enabled, update client_state first
      if (preserveRoutingOptions) {
        // Get current interaction's routing options
        // Check both interaction.priority and routing_metadata.call_priority
        const routingMetadata = interaction.routing_metadata || {};
        const currentPriority =
          interaction.priority || routingMetadata.call_priority || null;
        const currentRequiredSkills =
          interaction.required_skills || routingMetadata.required_skills || {};

        // Build client_state with routing options
        const clientStateObj = {};

        // Add priority if available
        if (currentPriority && currentPriority >= 1 && currentPriority <= 5) {
          clientStateObj.call_priority = currentPriority;
        }

        // Add required_skills if available and not empty
        if (
          currentRequiredSkills &&
          typeof currentRequiredSkills === "object" &&
          Object.keys(currentRequiredSkills).length > 0
        ) {
          clientStateObj.required_skills = currentRequiredSkills;
        }

        // Only update client_state if we have routing options to preserve
        if (Object.keys(clientStateObj).length > 0) {
          // Encode client_state as base64 JSON
          const clientStateBase64 = Buffer.from(
            JSON.stringify(clientStateObj),
          ).toString("base64");

          // Update client_state first
          const clientStateUrl = buildTelnyxV2Url(
            `/calls/${encodeURIComponent(transferCallControlId)}/actions/client_state_update`,
          );

          const clientStateResponse = await fetch(clientStateUrl, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ client_state: clientStateBase64 }),
          });

          if (!clientStateResponse.ok) {
            const errorText = await clientStateResponse.text();
            console.error(
              "[Transfer] Failed to update client_state:",
              errorText,
            );
            return NextResponse.json(
              {
                ok: false,
                error: `Failed to update client state: ${errorText}`,
              },
              { status: clientStateResponse.status },
            );
          }
        }
      }

      // Use enqueue command to transfer to queue
      const enqueueUrl = buildTelnyxV2Url(
        `/calls/${encodeURIComponent(transferCallControlId)}/actions/enqueue`,
      );
      const enqueueBody = {
        queue_name: queue.name,
      };

      const response = await fetch(enqueueUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(enqueueBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return NextResponse.json(
          { ok: false, error: errorText },
          { status: response.status },
        );
      }

      // Update interaction
      // Parse transfer_history if it's a string (from DB)
      let transferHistory = [];
      if (interaction.transfer_history) {
        if (Array.isArray(interaction.transfer_history)) {
          transferHistory = [...interaction.transfer_history];
        } else if (typeof interaction.transfer_history === "string") {
          try {
            transferHistory = JSON.parse(interaction.transfer_history);
            if (!Array.isArray(transferHistory)) {
              transferHistory = [];
            }
          } catch (e) {
            console.warn("[Transfer] Failed to parse transfer_history:", e);
            transferHistory = [];
          }
        }
      }

      transferHistory.push({
        timestamp: new Date().toISOString(),
        to: queue.name,
        type: "queue",
        callControlId: transferCallControlId,
      });

      // Add timeline event for transfer
      const updatedRoutingMetadata = addTimelineEvent(
        interaction.routing_metadata || {},
        TimelineEventTypes.TRANSFER,
        {
          to: queue.name,
          type: "queue",
          transferredBy: user.username,
          callControlId: transferCallControlId,
        },
      );

      // Update interaction - when transferring to queue, the call will be re-enqueued
      // so we update the queue_id and set state to queued
      await PgDb.updateInteractionById(interaction.id, {
        transferCount: (interaction.transfer_count || 0) + 1,
        transferHistory,
        routingMetadata: updatedRoutingMetadata,
        queueId: queue.id,
        queueName: queue.name,
        state: "queued", // Call is being re-enqueued in the new queue
        enqueuedAt: new Date().toISOString(),
      });

      // Notify agent to remove interaction from Interactions panel
      if (interaction.agent_username) {
        broadcastToKey(`contact-center:agent:${interaction.agent_username}`, {
          type: "interaction_ended",
          interactionId: interaction.id,
          callControlId: interaction.call_control_id,
        });
      }

      return NextResponse.json({ ok: true });
    } else if (type === "external") {
      // Transfer to external number
      transferParams = {
        to: target, // E.164 format number
        from: interaction?.to_number || user.voice_number || null,
        custom_headers: [
          { name: "X-Original-Call-Control-Id", value: transferCallControlId },
          { name: "X-Transfer-From-Agent", value: user.username },
        ],
      };
    } else {
      return NextResponse.json(
        { ok: false, error: "Invalid transfer type" },
        { status: 400 },
      );
    }

    // Execute transfer using Telnyx Call Control API
    const url = buildTelnyxV2Url(
      `/calls/${encodeURIComponent(transferCallControlId)}/actions/transfer`,
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(transferParams),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Transfer] Telnyx API error:", errorText);
      return NextResponse.json(
        { ok: false, error: errorText },
        { status: response.status },
      );
    }

    // Update interaction
    // Parse transfer_history if it's a string (from DB)
    let transferHistory = [];
    if (interaction.transfer_history) {
      if (Array.isArray(interaction.transfer_history)) {
        transferHistory = [...interaction.transfer_history];
      } else if (typeof interaction.transfer_history === "string") {
        try {
          transferHistory = JSON.parse(interaction.transfer_history);
          if (!Array.isArray(transferHistory)) {
            transferHistory = [];
          }
        } catch (e) {
          console.warn("[Transfer] Failed to parse transfer_history:", e);
          transferHistory = [];
        }
      }
    }

    transferHistory.push({
      timestamp: new Date().toISOString(),
      to: target,
      type: type,
      callControlId: transferCallControlId,
    });

    // Add timeline event for transfer
    const updatedRoutingMetadata = addTimelineEvent(
      interaction.routing_metadata || {},
      TimelineEventTypes.TRANSFER,
      {
        to: target,
        type: type,
        transferredBy: user.username,
        callControlId: transferCallControlId,
      },
    );

    await PgDb.updateInteractionById(interaction.id, {
      transferCount: (interaction.transfer_count || 0) + 1,
      transferHistory,
      routingMetadata: updatedRoutingMetadata,
      state: "completed", // Use "completed" instead of "transferred" (not a valid state)
      completedAt: new Date().toISOString(),
    });

    // Notify agent to remove interaction from Interactions panel
    if (interaction.agent_username) {
      broadcastToKey(`contact-center:agent:${interaction.agent_username}`, {
        type: "interaction_ended",
        interactionId: interaction.id,
        callControlId: interaction.call_control_id,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[TransferByCallControlId] Error:", err);
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 },
    );
  }
}
