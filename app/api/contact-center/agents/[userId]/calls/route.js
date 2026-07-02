import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

/**
 * GET /api/contact-center/agents/[userId]/calls
 * Get all active calls for a specific agent with detailed statistics
 */
export async function GET(request, { params }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    // Only supervisors and admins can view agent calls
    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    const { userId } = await params;
    if (!userId) {
      return NextResponse.json(
        { ok: false, error: "User ID is required" },
        { status: 400 },
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 },
      );
    }

    // Get agent info
    const agentResult = await pool.query(
      `SELECT
         u.id,
         u.username,
         u.first_name,
         u.last_name,
         ast.agent_status,
         u.max_concurrent_calls
       FROM users u
       LEFT JOIN cc_agent_state ast ON ast.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    );

    if (agentResult.rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Agent not found" },
        { status: 404 },
      );
    }

    const agent = agentResult.rows[0];
    const agentName =
      agent.first_name || agent.last_name
        ? `${agent.first_name || ""} ${agent.last_name || ""}`.trim()
        : agent.username;

    // Get all active/interactions for this agent
    // Exclude completed, abandoned, and re-enqueued calls to avoid showing ghost calls
    // Also exclude calls that are in "queued" state (they've been re-enqueued and are no longer assigned)
    const callsResult = await pool.query(
      `SELECT 
        i.id,
        i.call_control_id,
        i.call_session_id,
        i.from_number,
        i.to_number,
        i.state,
        i.queue_id,
        i.queue_name,
        i.enqueued_at,
        i.assigned_at,
        i.answered_at,
        i.completed_at,
        i.abandoned_at,
        i.created_at,
        i.updated_at,
        i.wait_time_seconds,
        i.talk_time_seconds,
        i.handle_time_seconds,
        i.hold_count,
        i.hold_duration_seconds,
        i.transfer_count,
        i.metadata,
        q.name as queue_display_name,
        q.display_name as queue_name
      FROM cc_interactions i
      LEFT JOIN cc_queues q ON i.queue_id = q.id
      LEFT JOIN users agent_user ON agent_user.username = i.agent_username
      LEFT JOIN cc_agent_state agent_state ON agent_state.user_id = agent_user.id
      WHERE i.agent_username = $1
        AND i.completed_at IS NULL
        AND i.abandoned_at IS NULL
        AND i.state != 'queued'
        AND COALESCE(agent_state.agent_status, '') <> 'Agent Not Answering'
        AND COALESCE(i.metadata->>'timeout_re_enqueued', '') != 'true'
        AND COALESCE(i.metadata->>'is_consult_call', 'false') <> 'true'
        AND i.assigned_at IS NOT NULL
      ORDER BY i.created_at DESC
      LIMIT 1000`,
      [agent.username],
    );

    // Helper function to safely parse JSONB fields
    const safeParse = (value) => {
      if (!value) return null;
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return value;
    };

    const calls = callsResult.rows.map((call) => {
      const metadata = safeParse(call.metadata) || {};
      // For supervision, use agent's call leg ID when call is answered (agent leg exists)
      // Otherwise, use original call leg ID for queued calls
      const agentCallControlId = metadata.agent_call_control_id || null;
      const originalCallControlId =
        metadata.original_call_control_id || call.call_control_id;
      // Prefer agent call leg for supervision when call is answered, otherwise use original leg
      const supervisionCallControlId =
        agentCallControlId || originalCallControlId;

      return {
        id: call.id,
        callControlId: call.call_control_id,
        originalCallControlId: originalCallControlId,
        agentCallControlId: agentCallControlId, // Agent's call leg (WebRTC leg)
        supervisionCallControlId: supervisionCallControlId, // Use this for supervision (prefers agent leg when available)
        callSessionId: call.call_session_id,
        fromNumber: call.from_number,
        toNumber: call.to_number,
        state: call.state,
        queueId: call.queue_id,
        queueName:
          call.queue_name || call.queue_display_name || call.queue_name,
        enqueuedAt: call.enqueued_at,
        assignedAt: call.assigned_at,
        answeredAt: call.answered_at,
        completedAt: call.completed_at,
        abandonedAt: call.abandoned_at,
        createdAt: call.created_at,
        updatedAt: call.updated_at,
        waitSeconds: call.wait_time_seconds || 0,
        talkSeconds: call.talk_time_seconds || 0,
        handleSeconds: call.handle_time_seconds || 0,
        holdCount: call.hold_count || 0,
        holdDurationSeconds: call.hold_duration_seconds || 0,
        transferCount: call.transfer_count || 0,
      };
    });

    // Filter active calls (not completed or abandoned)
    const activeCalls = calls.filter(
      (call) =>
        call.state &&
        !["completed", "abandoned", "failed"].includes(
          call.state.toLowerCase(),
        ),
    );

    // Get time tracking data for today
    const today = new Date().toISOString().split("T")[0];
    const timeTrackingResult = await pool.query(
      `SELECT 
        COALESCE(SUM(call_seconds), 0) as total_call_seconds,
        COALESCE(SUM(break_seconds), 0) as total_break_seconds,
        COALESCE(SUM(active_seconds), 0) as total_active_seconds,
        COALESCE(SUM(logged_in_seconds), 0) as total_logged_in_seconds
      FROM cc_user_time_tracking
      WHERE user_id = $1 AND tracking_date = $2`,
      [userId, today],
    );

    const timeTracking = timeTrackingResult.rows[0] || {
      total_call_seconds: 0,
      total_break_seconds: 0,
      total_active_seconds: 0,
      total_logged_in_seconds: 0,
    };

    // Calculate total work time (use active_seconds if available, otherwise logged_in_seconds)
    const totalWorkSeconds =
      timeTracking.total_active_seconds > 0
        ? timeTracking.total_active_seconds
        : timeTracking.total_logged_in_seconds;

    return NextResponse.json({
      ok: true,
      agent: {
        id: agent.id,
        username: agent.username,
        name: agentName,
        firstName: agent.first_name,
        lastName: agent.last_name,
        status: agent.agent_status,
        maxConcurrentCalls: agent.max_concurrent_calls,
      },
      calls,
      activeCalls,
      timeTracking: {
        callSeconds: parseInt(timeTracking.total_call_seconds) || 0,
        breakSeconds: parseInt(timeTracking.total_break_seconds) || 0,
        workSeconds: parseInt(totalWorkSeconds) || 0,
      },
    });
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: "Failed to fetch agent calls" },
      { status: 500 },
    );
  }
}
