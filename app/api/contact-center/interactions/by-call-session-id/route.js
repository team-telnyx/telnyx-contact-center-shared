export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { PgDb } from "@/lib/pgdb";

/**
 * GET /api/contact-center/interactions/by-call-session-id?callSessionId=...
 * Find interaction by call_session_id
 */
export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { searchParams } = new URL(request.url);
    const callSessionId = searchParams.get("callSessionId");

    if (!callSessionId || callSessionId.trim() === "") {
      return NextResponse.json(
        { ok: false, error: "callSessionId is required" },
        { status: 400 },
      );
    }

    const interaction = await PgDb.findInteractionByCallSessionId(callSessionId);

    if (!interaction) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      interaction,
    });
  } catch (err) {
    console.error(
      "[FindInteractionByCallSessionId] Error:",
      err,
    );
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 },
    );
  }
}
