export const dynamic = "force-dynamic";

/**
 * API endpoint to switch supervisor role
 * POST /api/contact-center/calls/[callControlId]/switch-supervisor-role
 */

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { buildTelnyxV2Url } from "@/lib/telnyx";

function getTelnyxApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

export async function POST(request, { params }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only supervisors and admins can switch supervisor roles
    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json(
        { error: "Access denied. Supervisor or admin privileges required." },
        { status: 403 }
      );
    }

    // Await params in Next.js 15+
    const resolvedParams = await params;
    const { callControlId } = resolvedParams;
    
    if (!callControlId) {
      return NextResponse.json(
        { error: "callControlId is required" },
        { status: 400 }
      );
    }

    console.log("[SwitchSupervisorRole] Switching role for supervisor call:", {
      supervisorCallControlId: callControlId,
      supervisorId: user.id,
      supervisorUsername: user.username,
    });

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

    // Call Telnyx API to switch supervisor role
    const apiKey = getTelnyxApiKey();
    const url = buildTelnyxV2Url(
      `/calls/${encodeURIComponent(callControlId)}/actions/switch_supervisor_role`
    );

    // Telnyx API expects 'role', not 'supervisor_role'
    const payload = {
      role: role,
    };

    console.log("[SwitchSupervisorRole] Telnyx API request:", {
      url,
      payload: JSON.stringify(payload, null, 2),
    });

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
      console.error("[SwitchSupervisorRole] Telnyx API error response:", {
        status: response.status,
        statusText: response.statusText,
        errorData: data,
        supervisorCallControlId: callControlId,
      });
      
      const errorMsg =
        data?.errors?.[0]?.detail ||
        data?.errors?.[0]?.message ||
        data?.message ||
        `HTTP ${response.status}: Failed to switch supervisor role`;
      return NextResponse.json({ error: errorMsg }, { status: response.status });
    }

    console.log("[SwitchSupervisorRole] ✅ Supervisor role switched successfully:", {
      supervisorCallControlId: callControlId,
      newRole: role,
    });

    return NextResponse.json({
      ok: true,
      supervisorRole: role,
      message: `Supervisor role switched to ${role}`,
    });
  } catch (error) {
    console.error("[SwitchSupervisorRole] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to switch supervisor role" },
      { status: 500 }
    );
  }
}

