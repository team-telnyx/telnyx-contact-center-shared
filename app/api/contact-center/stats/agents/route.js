/**
 * API endpoint for agent statistics
 * GET /api/contact-center/stats/agents?userId=xxx
 */

import { NextResponse } from "next/server";
import { getAgentStatistics } from "@/lib/acd/stats-aggregator";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { agentInScope } from "@/lib/authz/scope.mjs";

async function GET_handler(request, _context, authz) {
  try {
    const session = { user: { id: String(authz.user.id) } };

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    // Everyone sees their own statistics; `authz.elevated` (agents:read) sees every agent
    let stats;
    if (userId) {
      if (!authz.elevated && userId !== session.user.id) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      if (authz.elevated && !agentInScope(authz.scope, userId)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      stats = await getAgentStatistics(userId, { restriction: authz.scope });
    } else {
      if (!authz.elevated) {
        // Agents can only see their own stats
        stats = await getAgentStatistics(session.user.id, { restriction: authz.scope });
      } else {
        stats = await getAgentStatistics(null, { restriction: authz.scope });
        // Narrow the list to the caller's data scope (Phase 3a).
        if (Array.isArray(stats)) stats = stats.filter((row) => agentInScope(authz.scope, row.userId));
      }
    }

    return NextResponse.json({
      stats: Array.isArray(stats) ? stats : [stats].filter(Boolean),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error.message,
      },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission(["reports:read", "agents:read", "agent:self"], GET_handler, { elevated: ["reports:read", "agents:read"], route: "/api/contact-center/stats/agents" });
