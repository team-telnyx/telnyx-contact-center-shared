/**
 * Agent Assist Workflow - AI Context API
 * GET /api/agent-assist/workflow/ai-context?interactionId=xxx
 * 
 * Fetches AI context data for an interaction.
 * Used as a polling fallback when webhook data hasn't arrived yet.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getAiContextForInteraction } from "@/lib/agent-assist/ai-handoff-processor";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent-assist/workflow/ai-context
 * 
 * Query params:
 * - interactionId: Required. The interaction ID to get AI context for.
 * 
 * Returns:
 * - status: "available" | "pending" | "not_applicable" | "error"
 * - data: AI context data (when available)
 * - message: Status message
 */
export async function GET(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const interactionId = searchParams.get("interactionId");

    if (!interactionId) {
      return NextResponse.json(
        { error: "interactionId query parameter is required" },
        { status: 400 }
      );
    }

    const result = await getAiContextForInteraction(interactionId);

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error("[AI Context] Error:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to get AI context" },
      { status: 500 }
    );
  }
}
