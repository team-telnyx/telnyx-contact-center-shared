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
 * POST /api/contact-center/interactions/[id]/transfer
 * Transfer a call by interaction ID
 */
export async function POST(request, { params }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { id } = await params;
    const body = await request.json();
    const { type, target } = body; // type: 'agent' | 'queue' | 'external', target: username/queueId/number

    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
        { status: 400 }
      );
    }

    if (!type || !target) {
      return NextResponse.json(
        { ok: false, error: "type and target are required" },
        { status: 400 }
      );
    }

    // Find interaction by ID
    const interaction = await PgDb.findInteractionById(id);
    if (!interaction) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 }
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
        `[TransferById] ✅ Using original_call_control_id from metadata: ${transferCallControlId} (interaction.call_control_id is WebRTC leg: ${interaction.call_control_id})`
      );
    } else if (!isInbound && interaction.metadata?.pstn_call_control_id) {
      // Priority 2: Outbound call - use PSTN leg from metadata
      transferCallControlId = interaction.metadata.pstn_call_control_id;
      console.log(
        `[TransferById] ✅ Outbound call - Using PSTN leg call_control_id: ${transferCallControlId}`
      );
    } else {
      // Fallback: Use interaction.call_control_id (should only happen if call wasn't transferred to agent)
      console.warn(
        `[TransferById] ⚠️ No original_call_control_id in metadata, using interaction.call_control_id: ${transferCallControlId}. This may fail if call was transferred to agent.`
      );
    }

    console.log(`[TransferById] Transfer call leg selection:`, {
      interactionId: id,
      interactionCallControlId: interaction.call_control_id,
      metadataOriginalCallControlId:
        interaction.metadata?.original_call_control_id,
      metadataAgentCallControlId: interaction.metadata?.agent_call_control_id,
      metadataPstnCallControlId: interaction.metadata?.pstn_call_control_id,
      finalTransferCallControlId: transferCallControlId,
      direction: interaction.direction,
      isInbound,
    });

    console.log(`[Transfer] Transfer call leg selection:`, {
      interactionId: id,
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
        { status: 500 }
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
          { status: 500 }
        );
      }

      const agentResult = await pool.query(
        "SELECT * FROM users WHERE username = $1 LIMIT 1",
        [target]
      );
      const targetAgent = agentResult.rows?.[0];

      if (!targetAgent || !targetAgent.telephony_user_name) {
        return NextResponse.json(
          {
            ok: false,
            error: "Target agent not found or has no telephony_user_name",
          },
          { status: 400 }
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
      // Transfer to another queue
      const queue = await PgDb.findQueueById(target);
      if (!queue) {
        return NextResponse.json(
          { ok: false, error: "Queue not found" },
          { status: 400 }
        );
      }

      // Use bridge with queue parameter
      const url = buildTelnyxV2Url(
        `/calls/${encodeURIComponent(transferCallControlId)}/actions/bridge`
      );
      const bridgeBody = {
        queue: queue.name,
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bridgeBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return NextResponse.json(
          { ok: false, error: errorText },
          { status: response.status }
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
        }
      );

      await PgDb.updateInteractionById(interaction.id, {
        transferCount: (interaction.transfer_count || 0) + 1,
        transferHistory,
        routingMetadata: updatedRoutingMetadata,
        state: "transferred",
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
        { status: 400 }
      );
    }

    // Execute transfer using Telnyx Call Control API
    const url = buildTelnyxV2Url(
      `/calls/${encodeURIComponent(transferCallControlId)}/actions/transfer`
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
        { status: response.status }
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
      }
    );

    await PgDb.updateInteractionById(interaction.id, {
      transferCount: (interaction.transfer_count || 0) + 1,
      transferHistory,
      routingMetadata: updatedRoutingMetadata,
      state: "transferred",
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
    console.error("[TransferById] Error:", err);
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}
