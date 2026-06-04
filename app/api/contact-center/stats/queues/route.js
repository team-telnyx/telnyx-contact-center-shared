/**
 * API endpoint for queue statistics
 * GET /api/contact-center/stats/queues?queueId=xxx
 */

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getQueueStatistics } from "@/lib/contact-center/stats-aggregator";
import { isAdmin } from "@/lib/role-utils";

export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const queueId = searchParams.get("queueId");

    // Admins can see all queues, agents can only see their assigned queues
    let stats;
    if (queueId) {
      if (!isAdmin(user)) {
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
      stats = await getQueueStatistics(queueId);
    } else {
      if (!isAdmin(user)) {
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
        stats = await Promise.all(queueIds.map((id) => getQueueStatistics(id)));
        stats = stats.filter(Boolean);
      } else {
        stats = await getQueueStatistics();
      }
    }

    return NextResponse.json({
      stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Stats] Error getting queue statistics:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error.message,
      },
      { status: 500 }
    );
  }
}
