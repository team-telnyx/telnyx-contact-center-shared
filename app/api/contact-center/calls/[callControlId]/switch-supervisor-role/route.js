import { supervisionLogger, callPayload, agentPayload, contactCenterErrorPayload } from "@/lib/contact-center/logging.mjs";
/**
 * API endpoint to switch supervisor role
 * POST /api/contact-center/calls/[callControlId]/switch-supervisor-role
 */

import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { withPermission } from "@/lib/authz/guard";

function getTelnyxApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

async function POST_handler(request, { params }, authz) {
  try {
    const user = authz.user;

    // Only supervisors and admins can switch supervisor roles

    // Await params in Next.js 15+
    const resolvedParams = await params;
    const { callControlId } = resolvedParams;
    
    if (!callControlId) {
      return NextResponse.json(
        { error: "callControlId is required" },
        { status: 400 }
      );
    }

    supervisionLogger.debug("supervision_diagnostic_0", {});

    const body = await request.json();
    // Accept both 'role' and 'supervisor_role' for backward compatibility
    const roleParam = body.role || body.supervisor_role;

    if (!roleParam) {
      return NextResponse.json(
        { error: "role is required" },
        { status: 400 }
      );
    }

    const validRoles = ["monitor", "whisper", "barge"];
    const role = String(roleParam).toLowerCase();
    if (!validRoles.includes(role)) {
      return NextResponse.json(
        {
          error: `Invalid role. Must be one of: ${validRoles.join(", ")}`,
        },
        { status: 400 }
      );
    }
    // Each mode is its own operation (calls:supervise.listen | whisper | barge).
    if (!authz.can(SUPERVISION_PERMISSION[role])) {
      return NextResponse.json({ error: "Forbidden", permission: SUPERVISION_PERMISSION[role] }, { status: 403 });
    }

    // Call Telnyx API to switch supervisor role
    const apiKey = getTelnyxApiKey();
    const url = buildTelnyxV2Url(
      `/calls/${encodeURIComponent(callControlId)}/actions/switch_supervisor_role`
    );

    // Telnyx API expects 'role', not 'supervisor_role'
    const payload = {
      role: role,
    };

    supervisionLogger.debug("supervision_diagnostic_1", {});

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
        `Failed to parse Telnyx response: ${responseText.substring(0, 200)}`
      );
    }

    if (!response.ok) {
      supervisionLogger.error("supervision_error_2", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof hangupError !== "undefined" ? hangupError : typeof e !== "undefined" ? e : undefined) });
      
      const errorMsg =
        data?.errors?.[0]?.detail ||
        data?.errors?.[0]?.message ||
        data?.message ||
        `HTTP ${response.status}: Failed to switch supervisor role`;
      return NextResponse.json({ error: errorMsg }, { status: response.status });
    }

    supervisionLogger.debug("supervision_diagnostic_3", {});

    return NextResponse.json({
      ok: true,
      supervisorRole: role,
      message: `Supervisor role switched to ${role}`,
    });
  } catch (error) {
    supervisionLogger.error("supervision_error_4", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof hangupError !== "undefined" ? hangupError : typeof e !== "undefined" ? e : undefined) });
    return NextResponse.json(
      { error: error.message || "Failed to switch supervisor role" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
const SUPERVISION_PERMISSION = { monitor: "calls:supervise.listen", whisper: "calls:supervise.whisper", barge: "calls:supervise.barge" };
export const POST = withPermission(Object.values(SUPERVISION_PERMISSION), POST_handler, { route: "/api/contact-center/calls/[callControlId]/switch-supervisor-role" });
