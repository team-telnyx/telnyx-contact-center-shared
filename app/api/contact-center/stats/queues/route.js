/**
 * API endpoint for queue statistics
 * GET /api/contact-center/stats/queues?queueId=xxx
 */

import { NextResponse } from "next/server";
import { getQueueStatistics } from "@/lib/acd/stats-aggregator";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { queueInScope } from "@/lib/authz/scope.mjs";

async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;

    const { searchParams } = new URL(request.url);
    const queueId = searchParams.get("queueId");

    // Admins can see all queues, agents can only see their assigned queues
    let stats;
    if (queueId) {
      if (authz.elevated && !queueInScope(authz.scope, queueId)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      if (!authz.elevated) {
        // Check if agent is assigned to this queue
        const { getPostgresPool } = await import("@/lib/postgres.mjs");
        const pool = getPostgresPool();
        const assignmentResult = await pool.query(
          `SELECT 1 FROM cc_queue_user_assignments 
           WHERE queue_id = $1 AND user_id = $2 AND enabled = true`,
          [queueId, user.id]
        );
        if (!assignmentResult.rows || assignmentResult.rows.length === 0) {
          return NextResponse.json({ error: "Access denied" }, { status: 403 });
        }
      }
      stats = await getQueueStatistics(queueId, { restriction: authz.scope });
    } else {
      if (!authz.elevated) {
        // Agents can only see their assigned queues
        const { getPostgresPool } = await import("@/lib/postgres.mjs");
        const pool = getPostgresPool();
        const queuesResult = await pool.query(
          `SELECT queue_id FROM cc_queue_user_assignments 
           WHERE user_id = $1 AND enabled = true`,
          [user.id]
        );
        const queueIds = queuesResult.rows.map((r) => r.queue_id);
        if (queueIds.length === 0) {
          return NextResponse.json({ stats: [] });
        }
        stats = await Promise.all(queueIds.map((id) => getQueueStatistics(id, { restriction: authz.scope })));
        stats = stats.filter(Boolean);
      } else {
        stats = await getQueueStatistics(null, { restriction: authz.scope });
        // Narrow the list to the caller's data scope (Phase 3a).
        if (Array.isArray(stats)) stats = stats.filter((row) => queueInScope(authz.scope, row.queueId));
      }
    }

    return NextResponse.json({
      stats,
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
export const GET = withPermission(["reports:read", "queues:read", "agent:self"], GET_handler, { elevated: ["reports:read", "queues:read"], route: "/api/contact-center/stats/queues" });
