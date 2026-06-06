export const dynamic = "force-dynamic";

/**
 * API endpoint to get supervisor number configuration
 * GET /api/config/supervisor-number
 * Returns the supervisor number used for call monitoring (public config)
 */

import { NextResponse } from "next/server";

export async function GET() {
  try {
    // Return supervisor number from environment or fallback
    const supervisorNumber = process.env.TELNYX_SUPERVISOR_FROM_NUMBER || null;

    return NextResponse.json({
      supervisorNumber,
    });
  } catch (error) {
    console.error("[Config] Error getting supervisor number:", error);
    return NextResponse.json(
      { error: "Failed to get supervisor number configuration" },
      { status: 500 },
    );
  }
}
