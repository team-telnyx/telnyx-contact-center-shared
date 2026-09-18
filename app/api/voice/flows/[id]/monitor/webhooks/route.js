/**
 * GET /api/voice/flows/[id]/monitor/webhooks
 * Get webhook events for a specific flow
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { NextResponse } from "next/server";
import { getFlowEvents } from "@/lib/call-monitor-store";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";

async function GET_handler(request, { params }) {
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
    voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to get webhooks" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("call_flows:monitor", GET_handler, { route: "/api/voice/flows/[id]/monitor/webhooks" });
