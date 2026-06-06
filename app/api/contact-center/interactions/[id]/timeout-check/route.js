export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { getAuthenticatedUser } from "@/lib/auth-server";

/**
 * GET /api/contact-center/interactions/[id]/timeout-check
 * Check if an interaction was timeout re-enqueued
 * Used to prevent wrapup sheet from opening
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
        { status: 400 },
      );
    }

    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const interaction = await PgDb.findInteractionById(id);
    if (!interaction) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 },
      );
    }

    const metadata = interaction.metadata || {};
    const wasTimeoutReEnqueued = metadata.timeout_re_enqueued === true;

    return NextResponse.json({
      ok: true,
      timeoutReEnqueued: wasTimeoutReEnqueued,
      metadata: metadata,
    });
  } catch (err) {
    console.error("[TimeoutCheck] Error:", err);
    return NextResponse.json(
      { ok: false, error: "Failed to check timeout status" },
      { status: 500 },
    );
  }
}
