/**
 * API endpoint to get supervisor number configuration
 * GET /api/config/supervisor-number
 * Returns the supervisor number used for call monitoring (public config)
 */

import { NextResponse } from "next/server";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

import { withPermission } from "@/lib/authz/guard";
async function GET_handler() {
  try {
    // Return supervisor number from environment or fallback
    const supervisorNumber = process.env.TELNYX_SUPERVISOR_FROM_NUMBER || null;

    return NextResponse.json({
      supervisorNumber,
    });
  } catch (error) {
    platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to get supervisor number configuration" },
      { status: 500 },
    );
  }
}

// Phase 0 hardening: every export goes through the permission guard (the internal documentation).
export const GET = withPermission(["calls:supervise.listen","agent:self"], GET_handler, { route: "/api/config/supervisor-number" });
