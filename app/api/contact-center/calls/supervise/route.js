import { supervisionLogger, callPayload, agentPayload, contactCenterErrorPayload } from "@/lib/contact-center/logging.mjs";
/**
 * API endpoint to initiate supervisor call
 * POST /api/contact-center/calls/supervise
 */

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { getPostgresPool } from "@/lib/postgres.mjs";

function getTelnyxApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only supervisors and admins can supervise calls
    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json(
        { error: "Access denied. Supervisor or admin privileges required." },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { supervise_call_control_id, supervisor_role } = body;

    supervisionLogger.debug("supervision_diagnostic_0", {});

    if (!supervise_call_control_id || !supervisor_role) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: supervise_call_control_id, supervisor_role",
        },
        { status: 400 },
      );
    }

    const validRoles = ["monitor", "whisper", "barge"];
    const role = String(supervisor_role).toLowerCase();
    if (!validRoles.includes(role)) {
      return NextResponse.json(
        {
          error: `Invalid supervisor_role. Must be one of: ${validRoles.join(", ")}`,
        },
        { status: 400 },
      );
    }

    // Get connection ID from environment (Call Control Application ID)
    const connectionId = process.env.TELNYX_CALL_CONTROL_ID;
    if (!connectionId) {
      return NextResponse.json(
        { error: "TELNYX_CALL_CONTROL_ID not configured" },
        { status: 500 },
      );
    }

    // Get supervisor's telephony_user_name for 'to' field (SIP URI format)
    // This is the username used for WebRTC login - where to call the supervisor
    supervisionLogger.debug("supervision_diagnostic_1", {});

    const telephonyUserName =
      user.telephony_user_name ||
      user.telephonyUserName ||
      user.username?.split("@")[0] ||
      null;

    if (!telephonyUserName) {
      supervisionLogger.error("supervision_error_2", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof hangupError !== "undefined" ? hangupError : typeof e !== "undefined" ? e : undefined) });
      return NextResponse.json(
        {
          error:
            "Supervisor does not have telephony_user_name configured. Please set up your telephony credentials in profile settings.",
        },
        { status: 400 },
      );
    }

    // Build SIP URI for 'to' field: sip:{telephony_user_name}@sip.telnyx.com
    // This is where the supervisor will receive the call (their WebRTC endpoint)
    const supervisorSipUri = `sip:${telephonyUserName}@sip.telnyx.com`;

    // Phone number for 'from' field - use environment variable or fallback
    const fromNumber = process.env.TELNYX_SUPERVISOR_FROM_NUMBER || null;
    const fromDisplayName = "Supervisor";

    // Create supervisor call using Telnyx API
    const apiKey = getTelnyxApiKey();
    const url = buildTelnyxV2Url("/calls");

    const payload = {
      to: supervisorSipUri, // Supervisor's SIP URI (WebRTC endpoint)
      connection_id: connectionId, // Use Call Control Application ID from environment
      supervise_call_control_id,
      supervisor_role: role,
      from: fromNumber, // Static phone number
      from_display_name: fromDisplayName, // Display name for caller ID
      custom_headers: [{ name: "X-Supervisor-Call", value: "true" }],
    };

    supervisionLogger.debug("supervision_diagnostic_3", {});
    supervisionLogger.debug("supervision_diagnostic_4", {});

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      throw new Error(
        `Failed to parse Telnyx response: ${responseText.substring(0, 200)}`,
      );
    }

    if (!response.ok) {
      const telnyxError = data?.errors?.[0] || {};
      const telnyxErrorMessage =
        telnyxError.detail ||
        telnyxError.message ||
        data?.message ||
        null;

      supervisionLogger.error("supervision_error_5", {
        telnyxStatus: response.status,
        telnyxStatusText: response.statusText,
        telnyxErrorCode: telnyxError.code,
        telnyxErrorTitle: telnyxError.title,
        telnyxErrorMessage,
        superviseCallControlId: supervise_call_control_id,
        supervisorRole: role,
      });

      const errorMsg =
        telnyxErrorMessage ||
        `HTTP ${response.status}: Failed to create supervisor call`;
      return NextResponse.json(
        { error: errorMsg },
        { status: response.status },
      );
    }

    supervisionLogger.debug("supervision_diagnostic_6", {});

    const supervisorCall = data?.data;
    if (!supervisorCall || !supervisorCall.call_control_id) {
      return NextResponse.json(
        { error: "Invalid response from Telnyx: missing call_control_id" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      supervisorCallControlId: supervisorCall.call_control_id,
      supervisorRole: role,
      message: `Supervisor call initiated in ${role} mode`,
    });
  } catch (error) {
    supervisionLogger.error("supervision_error_7", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof hangupError !== "undefined" ? hangupError : typeof e !== "undefined" ? e : undefined) });
    return NextResponse.json(
      { error: error.message || "Failed to initiate supervisor call" },
      { status: 500 },
    );
  }
}
