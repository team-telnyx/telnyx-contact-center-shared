/**
 * API endpoint for supervisory console dashboard
 * GET /api/contact-center/monitor/dashboard
 * Returns comprehensive real-time statistics for monitoring
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import {
  getQueueStatistics,
  getAgentStatistics,
  getOverallStatistics,
} from "@/lib/acd/stats-aggregator";
import { PgDb } from "@/lib/pgdb";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { restrictMonitorSnapshot } from "@/lib/authz/scope.mjs";

async function GET_handler(request, _context, authz) {
  const params=new URL(request.url).searchParams;
  const reportOptions={restriction:authz.scope,channel:params.get("channel")||"all",timezone:params.get("timezone")||"UTC"};
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Supervisors and admins can access the supervisory console
    const user = await PgDb.findUserById(session.user.id);

    // Get all statistics, narrowed to the caller's data scope (Phase 3a)
    const snapshot = restrictMonitorSnapshot({
      queues: await getQueueStatistics(null,reportOptions),
      agents: await getAgentStatistics(null,reportOptions),
      overall: await getOverallStatistics(reportOptions),
    }, authz.scope, { prefiltered: true });
    const [queueStats, agentStats, overallStats] = [snapshot.queues, snapshot.agents, snapshot.overall];

    return NextResponse.json({
      overall: overallStats,
      queues: {
        stats: Array.isArray(queueStats)
          ? queueStats
          : [queueStats].filter(Boolean),
        states: {},
      },
      agents: {
        stats: Array.isArray(agentStats)
          ? agentStats
          : [agentStats].filter(Boolean),
        states: {},
      },
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
export const GET = withPermission("monitor:read", GET_handler, { route: "/api/contact-center/monitor/dashboard" });
