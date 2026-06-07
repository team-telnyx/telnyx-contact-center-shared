import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { randomUUID } from "crypto";
import { offerQueuedCallForAgent } from "@/lib/contact-center/queued-call-router";
import { contactCenterErrorPayload, queuesLogger } from "@/lib/contact-center/logging.mjs";

/**
 * POST /api/contact-center/agent/queues/activate
 * Activate agent in specified queues
 * If userId is provided and requester is supervisor/admin, activate for that user
 */
export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const body = await request.json();
    const { queueIds, userId: targetUserId } = body;

    // Determine which user's queues to activate
    // If userId is provided and requester is supervisor/admin, use that userId
    // Otherwise, use the authenticated user's id
    let targetUserIdFinal = user.id;
    if (targetUserId && targetUserId !== user.id) {
      if (!isSupervisorOrAdmin(user)) {
        return NextResponse.json(
          {
            ok: false,
            error: "Only supervisors and admins can manage other users' queues",
          },
          { status: 403 },
        );
      }
      targetUserIdFinal = targetUserId;
    }

    if (!Array.isArray(queueIds)) {
      return NextResponse.json(
        { ok: false, error: "queueIds must be an array" },
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

    const activated = [];

    for (const queueId of queueIds) {
      const queueRes = await pool.query(
        `SELECT * FROM cc_queues WHERE id = $1`,
        [queueId],
      );
      const queue = queueRes.rows?.[0];

      if (!queue) {
        continue;
      }

      if (!queue.enabled) {
        continue;
      }

      // Check if this is a new activation (was previously deactivated)
      const existingAssignment = await pool.query(
        `SELECT enabled, activated_at, deactivated_at, priority FROM cc_queue_user_assignments
         WHERE queue_id = $1 AND user_id = $2`,
        [queueId, targetUserIdFinal],
      );
      const wasDeactivated =
        existingAssignment.rows.length > 0 &&
        existingAssignment.rows[0].enabled === false;
      // Preserve existing priority or use default of 1 (constraint requires >= 1)
      const existingPriority =
        existingAssignment.rows.length > 0 &&
        existingAssignment.rows[0].priority
          ? existingAssignment.rows[0].priority
          : 1;

      // Create or update assignment
      await pool.query(
        `INSERT INTO cc_queue_user_assignments (id, queue_id, user_id, priority, enabled, activated_at, deactivated_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NULL, NOW(), NOW())
         ON CONFLICT (queue_id, user_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           activated_at = CASE WHEN EXCLUDED.enabled THEN NOW() ELSE cc_queue_user_assignments.activated_at END,
           deactivated_at = CASE WHEN EXCLUDED.enabled THEN NULL ELSE cc_queue_user_assignments.deactivated_at END,
           updated_at = NOW()`,
        [
          randomUUID(),
          queueId,
          targetUserIdFinal,
          existingPriority, // preserve existing priority or use default of 1
          true, // enabled
        ],
      );

      // Log queue activation activity
      try {
        const { PgDb } = await import("@/lib/pgdb");
        let previousDeactivationTime = null;
        if (wasDeactivated && existingAssignment.rows[0].deactivated_at) {
          previousDeactivationTime = existingAssignment.rows[0].deactivated_at;
        }

        await PgDb.logUserActivity({
          userId: String(targetUserIdFinal),
          activityType: "queue_activate",
          activityValue: queue.name,
          queueId: queueId,
          startedAt: previousDeactivationTime || new Date().toISOString(),
          endedAt: new Date().toISOString(),
          metadata: {
            queueName: queue.name,
            queueDisplayName: queue.display_name,
            managedBy: targetUserIdFinal !== user.id ? user.id : null,
          },
        });
      } catch (activityError) {
        queuesLogger.error("queue", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
        // Don't fail the request if activity logging fails
      }

      activated.push(queueId);
    }

    // Update agent state in state manager
    if (activated.length > 0) {
      try {
        const { updateAgentQueues, updateAgentStatus } =
          await import("@/lib/contact-center/state-manager");
        // Get target user identity and Contact Center authoritative status for state manager
        const targetUserRes = await pool.query(
          `SELECT u.id, u.username, s.agent_status AS current_agent_status
             FROM users u
             LEFT JOIN cc_agent_state s ON s.user_id = u.id
            WHERE u.id = $1`,
          [targetUserIdFinal],
        );
        const targetUser = targetUserRes.rows[0];

        if (targetUser) {
          updateAgentQueues(targetUserIdFinal, activated, true);
          // Ensure agent status is set if not already
          if (
            targetUser.current_agent_status &&
            targetUser.current_agent_status !== "Offline"
          ) {
            await updateAgentStatus(
              targetUserIdFinal,
              targetUser.current_agent_status,
              targetUser.username,
            );
          }

          if (targetUser.current_agent_status === "Available") {
            try {
              await offerQueuedCallForAgent({
                userId: targetUserIdFinal,
                queueIds: activated,
              });
            } catch (error) {
              queuesLogger.error("queue", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
            }
          }
        }
      } catch (stateError) {
        queuesLogger.error("queue", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
      }
    }

    // Re-evaluate waiting reasons for queued calls in activated queues
    // This updates the waiting reason display when agents become available
    if (activated.length > 0) {
      try {
        const { reEvaluateWaitingReasonsForQueues } =
          await import("@/lib/contact-center/waiting-reason-re-evaluator.js");
        // Run asynchronously - don't wait for it to complete
        reEvaluateWaitingReasonsForQueues(activated).catch((error) => {
          queuesLogger.error("queue", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
        });
      } catch (reEvalError) {
        // Log but don't fail the queue activation
        queuesLogger.error("queue", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
      }
    }

    // Broadcast queue activation event to all agent users and monitors
    if (activated.length > 0) {
      try {
        const { broadcastToAllAgents, broadcastToKey } =
          await import("@/lib/sse");
        const queueRes = await pool.query(
          `SELECT * FROM cc_queues WHERE id = ANY($1::text[])`,
          [activated],
        );
        const queues = queueRes.rows || [];
        // Get target user info for broadcast
        const targetUserRes = await pool.query(
          `SELECT id, username, first_name, last_name FROM users WHERE id = $1`,
          [targetUserIdFinal],
        );
        const targetUser = targetUserRes.rows[0] || {
          id: targetUserIdFinal,
          username: user.username,
          first_name: user.first_name,
          last_name: user.last_name,
        };

        const queueChangeEvent = {
          type: "queue_activation_changed",
          userId: targetUser.id,
          username: targetUser.username,
          firstName: targetUser.first_name,
          lastName: targetUser.last_name,
          queueIds: activated,
          queues: queues.map((q) => ({
            id: q.id,
            name: q.name,
            displayName: q.display_name || q.name,
          })),
          activated: true,
          timestamp: new Date().toISOString(),
        };

        // Broadcast to agents
        await broadcastToAllAgents(queueChangeEvent, "queue_changed");

        // Broadcast to all monitor streams (supervisors/admins)
        const supervisors = await pool.query(
          `SELECT id FROM users WHERE 'supervisor' = ANY(roles) OR 'admin' = ANY(roles) OR 'owner' = ANY(roles)`,
        );
        for (const supervisor of supervisors.rows || []) {
          await broadcastToKey(
            `monitor:${supervisor.id}`,
            queueChangeEvent,
            "queue_changed",
          );
        }
      } catch (sseError) {
        queuesLogger.error("queues", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
        // Don't fail the request if SSE fails
      }
    }

    return NextResponse.json({ ok: true, activated });
  } catch (err) {
    queuesLogger.error("queue_activate", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
    return NextResponse.json(
      { ok: false, error: err.message || "Server error" },
      { status: 500 },
    );
  }
}
