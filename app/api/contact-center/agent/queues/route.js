export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";

/**
 * GET /api/contact-center/agent/queues
 * List all available queues and agent's activation status
 */
export async function GET() {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 }
      );
    }

    // Get all enabled queues
    const queuesRes = await pool.query(
      `SELECT * FROM cc_queues WHERE enabled = true ORDER BY priority DESC, name ASC`
    );
    const allQueues = queuesRes.rows || [];

    // Get user's queue assignments
    const assignmentsRes = await pool.query(
      `SELECT * FROM cc_queue_user_assignments WHERE user_id = $1`,
      [user.id]
    );
    const assignments = assignmentsRes.rows || [];
    const assignmentMap = new Map(assignments.map((a) => [a.queue_id, a]));

    // Format queues with activation status
    const queues = allQueues.map((q) => ({
      id: q.id,
      name: q.name,
      displayName: q.display_name || q.name,
      description: q.description,
      routingStrategy: q.routing_strategy,
      enabled: q.enabled,
      activated: assignmentMap.has(q.id) && assignmentMap.get(q.id).enabled,
      assignment: assignmentMap.get(q.id) || null,
    }));

    return NextResponse.json({ ok: true, queues });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}
