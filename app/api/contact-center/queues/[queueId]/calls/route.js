import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";

/**
 * GET /api/contact-center/queues/[queueId]/calls
 * Get all calls/interactions for a specific queue with detailed statistics
 */
export async function GET(request, { params }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Only supervisors and admins can view queue calls
    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 }
      );
    }

    const { queueId } = await params;
    if (!queueId) {
      return NextResponse.json(
        { ok: false, error: "Queue ID is required" },
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

    // Get queue info
    const queueResult = await pool.query(
      `SELECT id, name, display_name FROM cc_queues WHERE id = $1`,
      [queueId]
    );

    if (queueResult.rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Queue not found" },
        { status: 404 }
      );
    }

    const queue = queueResult.rows[0];

    // Get all interactions for this queue with detailed stats
    // Note: agent_user_id might not exist, so we'll join on agent_username if needed
    const callsResult = await pool.query(
      `SELECT 
        i.id,
        i.call_control_id,
        i.call_session_id,
        i.from_number,
        i.to_number,
        i.state,
        i.agent_username,
        i.enqueued_at,
        i.answered_at,
        i.completed_at,
        i.abandoned_at,
        i.created_at,
        i.updated_at,
        i.wait_time_seconds,
        i.talk_time_seconds,
        i.required_skills,
        i.routing_metadata,
        u.first_name,
        u.last_name,
        u.id as agent_user_id
      FROM cc_interactions i
      LEFT JOIN users u ON i.agent_username = u.username
      WHERE i.queue_id = $1
        AND i.completed_at IS NULL
        AND i.abandoned_at IS NULL
      ORDER BY i.created_at DESC
      LIMIT 1000`,
      [queueId]
    );

    // Helper function to safely parse JSONB fields
    const safeParse = (value) => {
      if (!value) return null;
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return value;
    };

    const calls = callsResult.rows.map((call) => ({
      id: call.id,
      callControlId: call.call_control_id,
      callSessionId: call.call_session_id,
      fromNumber: call.from_number,
      toNumber: call.to_number,
      state: call.state,
      agentUsername: call.agent_username,
      agentUserId: call.agent_user_id,
      agentName:
        call.first_name || call.last_name
          ? `${call.first_name || ""} ${call.last_name || ""}`.trim()
          : call.agent_username || null,
      enqueuedAt: call.enqueued_at,
      answeredAt: call.answered_at,
      completedAt: call.completed_at,
      abandonedAt: call.abandoned_at,
      createdAt: call.created_at,
      updatedAt: call.updated_at,
      waitSeconds: call.wait_time_seconds || 0,
      talkSeconds: call.talk_time_seconds || 0,
      requiredSkills: safeParse(call.required_skills),
      routingMetadata: safeParse(call.routing_metadata),
    }));

    return NextResponse.json({
      ok: true,
      queue: {
        id: queue.id,
        name: queue.name,
        displayName: queue.display_name || queue.name,
      },
      calls,
    });
  } catch (error) {
    console.error("[QueueCalls] Error fetching queue calls:", error);
    return NextResponse.json(
      { ok: false, error: "Failed to fetch queue calls" },
      { status: 500 }
    );
  }
}
