/**
 * GET /api/voice/flows/[id]/monitor/webhooks
 * Get webhook events for a specific flow
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { NextResponse } from "next/server";
import { getFlowEvents } from "@/lib/call-monitor-store";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { id: flowId } = await params;

    if (!flowId) {
      return NextResponse.json(
        { ok: false, error: "Flow ID is required" },
        { status: 400 }
      );
    }

    const webhooks = getFlowEvents(flowId);

    return NextResponse.json({
      ok: true,
      webhooks,
    });
  } catch (error) {
    console.error("[Monitor Webhooks] Error:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to get webhooks" },
      { status: 500 }
    );
  }
}
