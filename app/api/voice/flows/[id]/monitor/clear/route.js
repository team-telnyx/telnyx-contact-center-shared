/**
 * POST /api/voice/flows/[id]/monitor/clear
 * Clear monitoring data for a specific flow or all flows
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { NextResponse } from "next/server";
import {
  clearCallEvents,
  clearAllEvents,
  clearFlowExecutionEvents,
} from "@/lib/call-monitor-store";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

import { withPermission } from "@/lib/authz/guard";
export const dynamic = "force-dynamic";

async function POST_handler(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { id: flowId } = await params;
    const body = await request.json();
    const { callControlId, clearAll } = body;

    if (clearAll) {
      clearAllEvents();
      if (flowId) {
        clearFlowExecutionEvents(flowId);
      }
    } else if (callControlId) {
      clearCallEvents(callControlId);
    } else if (flowId) {
      // Clear all events for this flow
      // Note: This requires iterating through all events, which is less efficient
      // For now, we'll clear execution events for the flow
      clearFlowExecutionEvents(flowId);
    }

    return NextResponse.json({
      ok: true,
      message: "Monitoring data cleared",
    });
  } catch (error) {
    voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to clear monitoring data" },
      { status: 500 }
    );
  }
}

// Phase 0 hardening: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("call_flows:monitor", POST_handler, { route: "/api/voice/flows/[id]/monitor/clear" });
