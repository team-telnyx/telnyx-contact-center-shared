import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { PgDb } from "@/lib/pgdb";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import {
  addTimelineEvent,
  TimelineEventTypes,
} from "@/lib/contact-center/call-timeline-tracker.js";

/**
 * POST /api/contact-center/interactions/[id]/consult
 * Create a consult call by parking the current call and initiating a new call
 */
export async function POST(request, { params }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { id } = await params;
    const body = await request.json();
    const { type, target } = body; // type: 'external', target: phone number or SIP URI

    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
        { status: 400 },
      );
    }

    if (!type || !target) {
      return NextResponse.json(
        { ok: false, error: "type and target are required" },
        { status: 400 },
      );
    }

    // Find interaction by ID
    const interaction = await PgDb.findInteractionById(id);
    if (!interaction) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 },
      );
    }

    // Get agent's WebRTC call control ID (the agent's leg)
    const agentCallControlId =
      interaction.metadata?.agent_call_control_id ||
      interaction.call_control_id;

    if (!agentCallControlId) {
      return NextResponse.json(
        { ok: false, error: "Cannot find agent's call leg" },
        { status: 400 },
      );
    }

    // Get the original caller's call control ID (parked leg)
    const parkedCallControlId =
      interaction.metadata?.original_call_control_id ||
      interaction.call_control_id;

    if (!parkedCallControlId) {
      return NextResponse.json(
        { ok: false, error: "Cannot find caller's call leg" },
        { status: 400 },
      );
    }

    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "TELNYX_API_KEY not configured" },
        { status: 500 },
      );
    }

    // Note: The agent's WebRTC call leg should be disconnected from the client side
    // This will park the caller due to park_after_unbridge setting
    // The agentCallControlId passed here is the agent's WebRTC leg that was disconnected

    // Step 1: Initiate new call to consultant and bridge to agent's WebRTC connection
    // Get agent's WebRTC connection ID
    const agent = await PgDb.findUserByUsername(user.username);
    if (!agent || !agent.telephony_credentials_id) {
      return NextResponse.json(
        { ok: false, error: "Agent does not have WebRTC connection configured" },
        { status: 400 },
      );
    }

    const connectionId = agent.telephony_credentials_id;
    const telephonyUserName =
      agent.telephony_user_name ||
      agent.telephonyUserName ||
      user.username.split("@")[0];

    // Determine from number (use agent's number or interaction's from_number)
    const fromNumber =
      agent.voice_number ||
      interaction.from_number ||
      interaction.to_number;

    // Create new call to consultant using dial API
    // This will create a call that goes to the agent's WebRTC connection
    const dialUrl = buildTelnyxV2Url("/calls");
    const dialBody = {
      to: target.trim(), // Consultant's number
      from: fromNumber,
      connection_id: connectionId, // Agent's WebRTC connection
    };

    const dialResponse = await fetch(dialUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(dialBody),
    });

    if (!dialResponse.ok) {
      const errorText = await dialResponse.text();
      console.error("[Consult] Failed to dial consultant:", errorText);
      return NextResponse.json(
        { ok: false, error: `Failed to call consultant: ${errorText}` },
        { status: dialResponse.status },
      );
    }

    const dialData = await dialResponse.json();
    // The dial returns the call control ID for the consultant call
    // This call will be received by the agent's WebRTC client
    const consultantCallControlId =
      dialData?.data?.call_control_id || null;

    if (!consultantCallControlId) {
      return NextResponse.json(
        { ok: false, error: "Failed to get consultant call control ID" },
        { status: 500 },
      );
    }

    // Step 2: Update interaction metadata with consult information
    const metadata = interaction.metadata || {};
    metadata.consult_state = {
      isActive: true,
      parkedCallControlId: parkedCallControlId,
      consultantCallControlId: consultantCallControlId,
      agentCallControlId: agentCallControlId,
      consultantTarget: target.trim(),
      startedAt: new Date().toISOString(),
    };

    // Mark consultant call interaction as internal (not shown in supervisor monitoring)
    // Create a separate interaction record for the consultant call that's marked as internal
    try {
      await PgDb.createInteraction({
        call_control_id: consultantCallControlId,
        call_session_id: dialData?.data?.call_session_id || null,
        direction: "outbound",
        from_number: fromNumber,
        to_number: target.trim(),
        agent_username: user.username,
        state: "initiated",
        is_contact_center: false, // Not a contact center call
        metadata: {
          is_consult_call: true, // Mark as consult call
          consult_interaction_id: interaction.id, // Link to original interaction
          original_interaction_id: interaction.id,
        },
      });
    } catch (consultInteractionErr) {
      // Don't fail if consultant interaction creation fails
      console.error("[Consult] Failed to create consultant interaction:", consultInteractionErr);
    }

    // Add timeline events
    const updatedRoutingMetadata = addTimelineEvent(
      interaction.routing_metadata || {},
      TimelineEventTypes.CALL_PARKED,
      {
        reason: "consult",
        parkedCallControlId: parkedCallControlId,
        agentCallControlId: agentCallControlId,
      },
    );

    const finalRoutingMetadata = addTimelineEvent(
      updatedRoutingMetadata,
      TimelineEventTypes.CONSULT_INITIATED,
      {
        consultantCallControlId: consultantCallControlId,
        consultantTarget: target.trim(),
        agentCallControlId: consultantCallControlId, // New agent call leg
      },
    );

    await PgDb.updateInteractionById(interaction.id, {
      metadata,
      routingMetadata: finalRoutingMetadata,
    });

    // Return consult state information
    return NextResponse.json({
      ok: true,
      parkedCall: {
        callControlId: parkedCallControlId,
        fromNumber: interaction.from_number,
        fromName: interaction.from_name,
      },
      consultantCall: {
        callControlId: consultantCallControlId,
        toNumber: target.trim(),
        toName: null, // Could be enhanced to lookup contact name
      },
      agentCallControlId: consultantCallControlId, // Agent's new call leg (consultant)
    });
  } catch (err) {
    console.error("[Consult] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 },
    );
  }
}
