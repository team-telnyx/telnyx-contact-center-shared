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
} from "@/lib/contact-center/stats-aggregator";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { PgDb } from "@/lib/pgdb";
import {
  getAllQueueStates,
  getAllAgentStates,
} from "@/lib/contact-center/state-manager";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

export async function GET(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Supervisors and admins can access the supervisory console
    const user = await PgDb.findUserById(session.user.id);
    if (!user || !isSupervisorOrAdmin(user)) {
      return NextResponse.json(
        { error: "Access denied. Supervisor or admin privileges required." },
        { status: 403 }
      );
    }

    // Get all statistics
    const [queueStats, agentStats, overallStats] = await Promise.all([
      getQueueStatistics(),
      getAgentStatistics(),
      getOverallStatistics(),
    ]);

    // Get real-time state
    const queueStates = getAllQueueStates();
    const agentStates = getAllAgentStates();

    return NextResponse.json({
      overall: overallStats,
      queues: {
        stats: Array.isArray(queueStats)
          ? queueStats
          : [queueStats].filter(Boolean),
        states: queueStates,
      },
      agents: {
        stats: Array.isArray(agentStats)
          ? agentStats
          : [agentStats].filter(Boolean),
        states: agentStates,
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
