import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { PgDb } from "@/lib/pgdb";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/contact-center/interactions/[id]/consult
 * Cancel/cleanup consult state and optionally hangup parked call
 * Used when consult fails or is cancelled
 */
export async function DELETE(request, { params }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { id } = await params;
    const url = new URL(request.url);
    const hangupParked = url.searchParams.get("hangupParked") === "true";

    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
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

    const metadata = interaction.metadata || {};
    const consultState = metadata.consult_state;

    console.log(
      `[Consult] DELETE - Cleaning up consult state for interaction ${id}, hangupParked=${hangupParked}, consultState=${JSON.stringify(consultState)}`,
    );

    // Clear consult_state from metadata
    delete metadata.consult_state;

    await PgDb.updateInteractionById(interaction.id, {
      metadata,
    });

    console.log(
      `[Consult] Cleared consult_state from interaction ${id} metadata`,
    );

    // Optionally hangup the parked call (customer leg)
    if (hangupParked && consultState?.parkedCallControlId) {
      const apiKey = process.env.TELNYX_API_KEY;
      if (apiKey) {
        try {
          const hangupUrl = buildTelnyxV2Url(
            `/calls/${encodeURIComponent(consultState.parkedCallControlId)}/actions/hangup`,
          );
          
          console.log(
            `[Consult] Hanging up parked call ${consultState.parkedCallControlId}`,
          );
          
          const hangupResponse = await fetch(hangupUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          });

          if (!hangupResponse.ok) {
            const errorText = await hangupResponse.text();
            console.error(
              `[Consult] Failed to hangup parked call: ${errorText}`,
            );
          } else {
            console.log(
              `[Consult] Successfully hung up parked call ${consultState.parkedCallControlId}`,
            );
          }
        } catch (hangupError) {
          console.error(
            `[Consult] Error hanging up parked call:`,
            hangupError,
          );
        }
      }
    }

    return NextResponse.json({
      ok: true,
      message: "Consult state cleared",
      clearedState: consultState || null,
    });
  } catch (err) {
    console.error("[Consult] DELETE Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 },
    );
  }
}

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

    console.log(
      `[Consult] Interaction ${id}: Agent call control ID: ${agentCallControlId} (from metadata: ${interaction.metadata?.agent_call_control_id}, from call_control_id: ${interaction.call_control_id})`,
    );

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

    console.log(
      `[Consult] Interaction ${id}: Parked call control ID: ${parkedCallControlId} (from metadata: ${interaction.metadata?.original_call_control_id}, from call_control_id: ${interaction.call_control_id})`,
    );

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
    console.log(
      `[Consult] Agent lookup for ${user.username}: found=${!!agent}, telephony_credentials_id=${agent?.telephony_credentials_id}, telephony_user_name=${agent?.telephony_user_name || agent?.telephonyUserName}`,
    );
    if (!agent || !agent.telephony_credentials_id) {
      console.error(
        `[Consult] Agent ${user.username} does not have WebRTC connection configured. telephony_credentials_id: ${agent?.telephony_credentials_id}, agent object keys: ${agent ? Object.keys(agent).join(", ") : "null"}`,
      );
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

    console.log(
      `[Consult] Agent ${user.username}: connection_id=${connectionId}, telephony_user_name=${telephonyUserName}, agent_call_control_id=${agentCallControlId}`,
    );

    // Step 1: Set consult_state FIRST (before hangup) to prevent webhook handler from hanging up original leg
    // This tells the webhook handler that we're in a consult process
    const metadata = interaction.metadata || {};
    metadata.consult_state = {
      isActive: false, // Will be set to true when consult call is initiated
      pendingConsult: true, // Indicates we're waiting for hangup to complete
      parkedCallControlId: parkedCallControlId,
      agentCallControlId: agentCallControlId,
      consultantTarget: target.trim(),
      connectionId: connectionId,
      telephonyUserName: telephonyUserName,
      startedAt: new Date().toISOString(),
    };

    await PgDb.updateInteractionById(interaction.id, {
      metadata,
    });

    console.log(
      `[Consult] Set consult_state in metadata BEFORE hangup to prevent original leg disconnect.`,
    );

    // Step 2: Hangup the agent's call leg
    // This will park the caller due to park_after_unbridge setting
    const hangupUrl = buildTelnyxV2Url(
      `/calls/${encodeURIComponent(agentCallControlId)}/actions/hangup`,
    );
    const hangupBody = {};

    console.log(
      `[Consult] Step 2: Hanging up agent's call leg: ${JSON.stringify({
        url: hangupUrl,
        method: "POST",
        callControlId: agentCallControlId,
        body: hangupBody,
      })}`,
    );

    const hangupResponse = await fetch(hangupUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(hangupBody),
    });

    if (!hangupResponse.ok) {
      const errorText = await hangupResponse.text();
      console.error(
        `[Consult] Failed to hangup agent's call leg: ${errorText}`,
      );
      // Rollback consult_state on error
      delete metadata.consult_state;
      await PgDb.updateInteractionById(interaction.id, {
        metadata,
      });
      return NextResponse.json(
        {
          ok: false,
          error: `Failed to hangup agent's call leg: ${errorText}`,
        },
        { status: hangupResponse.status },
      );
    }

    const hangupData = await hangupResponse.json();
    console.log(
      `[Consult] Hangup response: ${JSON.stringify(hangupData)}`,
    );

    console.log(
      `[Consult] Set consult_state in metadata. Waiting for hangup webhook to initiate consult call.`,
    );

    // Return success - the frontend will initiate the WebRTC call
    return NextResponse.json({
      ok: true,
      message: "Agent call leg hangup initiated. Please initiate WebRTC call to consultant.",
      agentCallControlId: agentCallControlId,
      parkedCallControlId: parkedCallControlId,
      consultantTarget: target.trim(), // Return target for frontend to use
    });
  } catch (err) {
    console.error("[Consult] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 },
    );
  }
}
