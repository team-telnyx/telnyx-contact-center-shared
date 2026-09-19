import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { withPermission } from "@/lib/authz/guard";
import { agentInScope } from "@/lib/authz/scope.mjs";

/**
 * GET /api/contact-center/agent/queues/list?userId=xxx
 * Get all queues for a specific user with their assignment and activation status
 * Requires supervisor or admin role
 */
async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;

    // Only supervisors and admins can view other users' queue assignments

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { ok: false, error: "userId parameter is required" },
        { status: 400 }
      );
    }

    if (!agentInScope(authz.scope, userId)) {
      return NextResponse.json({ ok: false, error: "Agent not found" }, { status: 404 });
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

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agents:read", GET_handler, { route: "/api/contact-center/agent/queues/list" });
