import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildTelnyxV2Url } from "@/lib/telnyx";

/**
 * POST /api/contact-center/interactions/by-call-control-id/consult
 * Create a consult call by parking the current call and initiating a new call
 * (for calls without interaction ID)
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
    const { type, target, agentCallControlId: bodyAgentCallControlId } = body; // type: 'external', target: phone number or SIP URI

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

    // Find interaction ONLY by agent_call_control_id in metadata
    // This is the agent's WebRTC call control ID, not the rtcCallId or original caller's ID
    const pool = getPostgresPool();
    let interaction = null;
    
    if (pool) {
      const r = await pool.query(
        `SELECT * FROM cc_interactions 
         WHERE metadata->>'agent_call_control_id' = $1
         ORDER BY created_at DESC LIMIT 1`,
        [callControlId],
      );
      if (r.rows?.[0]) {
        const row = r.rows[0];
        // Helper to safely parse JSON
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
          wrapup_codes: safeParse(row.wrapup_codes),
          metadata: safeParse(row.metadata),
        };
      }
    }
    
    if (!interaction) {
      console.error(
        `[Consult] Interaction not found for agent_call_control_id: ${callControlId}. Searched ONLY in metadata->>'agent_call_control_id'`,
      );
      return NextResponse.json(
        {
          ok: false,
          error: `Interaction not found for agent call control ID: ${callControlId}`,
        },
        { status: 404 },
      );
    }

    // Get agent's WebRTC call control ID (the agent's leg)
    // Since we searched by agent_call_control_id, callControlId IS the agent's call control ID
    // Prefer the one from body if provided and matches, otherwise use from metadata or query param
    const agentCallControlId =
      bodyAgentCallControlId ||
      interaction.metadata?.agent_call_control_id ||
      callControlId; // callControlId is the agent_call_control_id we searched for

    // Get the original caller's call control ID (parked leg)
    const parkedCallControlId =
      interaction.metadata?.original_call_control_id ||
      interaction.call_control_id;

    console.log(
      `[Consult] Found interaction ${interaction.id} by agent_call_control_id=${callControlId}. Agent call control ID: ${agentCallControlId} (from body: ${bodyAgentCallControlId}, from metadata: ${interaction.metadata?.agent_call_control_id}, from query: ${callControlId}), Parked: ${parkedCallControlId}`,
    );

    if (!agentCallControlId) {
      return NextResponse.json(
        { ok: false, error: "Cannot find agent's call leg" },
        { status: 400 },
      );
    }

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

    await PgDb.updateInteractionById(interaction.id, {
      metadata,
    });

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
