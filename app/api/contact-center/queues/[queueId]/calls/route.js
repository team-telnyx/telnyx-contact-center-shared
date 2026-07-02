import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { contactCenterErrorPayload, queuesLogger } from "@/lib/contact-center/logging.mjs";

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
        { status: 401 },
      );
    }

    // Only supervisors and admins can view queue calls
    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    const { queueId } = await params;
    if (!queueId) {
      return NextResponse.json(
        { ok: false, error: "Queue ID is required" },
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

    // Get queue info with relaxation settings and routing strategy
    const queueResult = await pool.query(
      `SELECT 
        id, 
        name, 
        display_name,
        routing_strategy,
        skill_relaxation_enabled,
        skill_relaxation_after_seconds,
        skill_relaxation_strategy
      FROM cc_queues WHERE id = $1`,
      [queueId],
    );

    if (queueResult.rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Queue not found" },
        { status: 404 },
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
        i.priority,
        i.routing_metadata,
        i.metadata,
        u.first_name,
        u.last_name,
        u.id as agent_user_id
      FROM cc_interactions i
      LEFT JOIN users u ON i.agent_username = u.username
      WHERE i.queue_id = $1
        AND i.completed_at IS NULL
        AND i.abandoned_at IS NULL
        AND COALESCE(i.metadata->>'is_consult_call', 'false') <> 'true'
      ORDER BY i.created_at DESC
      LIMIT 1000`,
      [queueId],
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

    // Import relaxation function
    const { getAdjustedSkillRequirements } =
      await import("@/lib/contact-center/routing-engine.js");

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

      const requiredSkills = safeParse(call.required_skills);

      // Calculate relaxed skills if relaxation is enabled and call is queued
      let relaxedSkills = null;
      let isRelaxed = false;
      if (
        requiredSkills &&
        Object.keys(requiredSkills).length > 0 &&
        call.enqueued_at &&
        queue.skill_relaxation_enabled
      ) {
        // Calculate wait time: stop at answered_at if call is answered, otherwise use current time
        const enqueuedAt = new Date(call.enqueued_at).getTime();
        const endTime = call.answered_at
          ? new Date(call.answered_at).getTime()
          : new Date().getTime();
        const waitTimeSeconds = Math.floor((endTime - enqueuedAt) / 1000);

        relaxedSkills = getAdjustedSkillRequirements(
          requiredSkills,
          waitTimeSeconds,
          {
            skill_relaxation_enabled: queue.skill_relaxation_enabled,
            skill_relaxation_after_seconds:
              queue.skill_relaxation_after_seconds || 60,
            skill_relaxation_strategy:
              queue.skill_relaxation_strategy || "progressive",
          },
        );

        // Check if relaxation was actually applied (skills changed)
        isRelaxed =
          JSON.stringify(requiredSkills) !== JSON.stringify(relaxedSkills);
      }

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
        requiredSkills: requiredSkills,
        relaxedSkills: relaxedSkills, // Relaxed skills (null if not relaxed)
        isRelaxed: isRelaxed, // Whether relaxation was applied
        priority: call.priority || null, // Call priority (1-5 stars)
        routingMetadata: safeParse(call.routing_metadata),
        metadata: metadata,
      };
    });

    return NextResponse.json({
      ok: true,
      queue: {
        id: queue.id,
        name: queue.name,
        displayName: queue.display_name || queue.name,
        routingStrategy: queue.routing_strategy || "FIFO",
      },
      calls,
    });
  } catch (error) {
    queuesLogger.error("queuecalls", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
    return NextResponse.json(
      { ok: false, error: "Failed to fetch queue calls" },
      { status: 500 },
    );
  }
}
