export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { getPostgresPool } from "@/lib/postgres.mjs";

/**
 * GET /api/contact-center/agent/queues/list?userId=xxx
 * Get all queues for a specific user with their assignment and activation status
 * Requires supervisor or admin role
 */
export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Only supervisors and admins can view other users' queue assignments
    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json(
        { ok: false, error: "Access denied" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { ok: false, error: "userId parameter is required" },
        { status: 400 }
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 }
      );
    }

    // Get all queues assigned to this user with their activation status
    const result = await pool.query(
      `SELECT 
        q.id,
        q.name,
        q.display_name,
        q.description,
        q.routing_strategy,
        qa.enabled as is_assigned,
        qa.activated_at,
        qa.deactivated_at,
        qa.priority,
        CASE 
          WHEN qa.enabled = true 
            AND qa.activated_at IS NOT NULL 
            AND qa.deactivated_at IS NULL 
          THEN true 
          ELSE false 
        END as is_activated
      FROM cc_queue_user_assignments qa
      INNER JOIN cc_queues q ON q.id = qa.queue_id
      WHERE qa.user_id = $1
      ORDER BY q.name ASC`,
      [userId]
    );

    const assignedQueues = result.rows;

    return NextResponse.json({
      ok: true,
      queues: assignedQueues.map((q) => ({
        id: q.id,
        name: q.name,
        displayName: q.display_name || q.name,
        description: q.description,
        routingType: q.routing_strategy,
        isAssigned: q.is_assigned === true,
        isActivated: q.is_activated === true,
        activatedAt: q.activated_at,
        deactivatedAt: q.deactivated_at,
        priority: q.priority || 0,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}
