/**
 * API endpoint to get supervisor number configuration
 * GET /api/config/supervisor-number
 * Returns the supervisor number used for call monitoring (public config)
 */

import { NextResponse } from "next/server";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

export async function GET() {
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
