export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { randomUUID } from "crypto";

/**
 * POST /api/contact-center/agent/queues/deactivate
 * Deactivate agent from specified queues
 * If userId is provided and requester is supervisor/admin, deactivate for that user
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

    // Determine which user's queues to deactivate
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

    const deactivated = [];

    for (const queueId of queueIds) {
      const queueRes = await pool.query(
        `SELECT * FROM cc_queues WHERE id = $1`,
        [queueId],
      );
      const queue = queueRes.rows?.[0];

      if (!queue) {
        continue;
      }

      // Check when this queue was activated to calculate duration
      const existingAssignment = await pool.query(
        `SELECT enabled, activated_at, priority FROM cc_queue_user_assignments
         WHERE queue_id = $1 AND user_id = $2`,
        [queueId, targetUserIdFinal],
      );
      const wasActivated =
        existingAssignment.rows.length > 0 &&
        existingAssignment.rows[0].enabled === true;
      const activationTime = wasActivated
        ? existingAssignment.rows[0].activated_at
        : null;
      // Preserve existing priority or use default of 1 (constraint requires >= 1)
      const existingPriority =
        existingAssignment.rows.length > 0 &&
        existingAssignment.rows[0].priority
          ? existingAssignment.rows[0].priority
          : 1;

      // Update assignment to disabled
      await pool.query(
        `INSERT INTO cc_queue_user_assignments (id, queue_id, user_id, priority, enabled, deactivated_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NOW())
         ON CONFLICT (queue_id, user_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           deactivated_at = CASE WHEN NOT EXCLUDED.enabled THEN NOW() ELSE cc_queue_user_assignments.deactivated_at END,
           updated_at = NOW()`,
        [
          randomUUID(),
          queueId,
          targetUserIdFinal,
          existingPriority, // preserve existing priority or use default of 1
          false, // disabled
        ],
      );

      // Log queue deactivation activity
      try {
        const { PgDb } = await import("@/lib/pgdb");
        const deactivationTime = new Date().toISOString();
        let durationSeconds = null;
        if (activationTime) {
          durationSeconds = Math.floor(
            (new Date(deactivationTime) - new Date(activationTime)) / 1000,
          );
        }

        await PgDb.logUserActivity({
          userId: String(targetUserIdFinal),
          activityType: "queue_deactivate",
          activityValue: queue.name,
          queueId: queueId,
          startedAt: activationTime || deactivationTime,
          endedAt: deactivationTime,
          durationSeconds: durationSeconds,
          metadata: {
            queueName: queue.name,
            queueDisplayName: queue.display_name,
            managedBy: targetUserIdFinal !== user.id ? user.id : null,
          },
        });
      } catch (activityError) {
        console.error(
          "[Queue] Failed to log deactivation activity:",
          activityError,
        );
        // Don't fail the request if activity logging fails
      }

      deactivated.push(queueId);
    }

    // Update agent state in state manager
    if (deactivated.length > 0) {
      try {
        const { updateAgentQueues } =
          await import("@/lib/contact-center/state-manager");
        updateAgentQueues(targetUserIdFinal, deactivated, false);
      } catch (stateError) {
        console.error("[Queue] Failed to update agent state:", stateError);
      }
    }

    // Re-evaluate waiting reasons for queued calls in deactivated queues
    // This updates the waiting reason display when agents become unavailable
    if (deactivated.length > 0) {
      try {
        const { reEvaluateWaitingReasonsForQueues } =
          await import("@/lib/contact-center/waiting-reason-re-evaluator.js");
        // Run asynchronously - don't wait for it to complete
        reEvaluateWaitingReasonsForQueues(deactivated).catch((error) => {
          console.error("[Queue] Error re-evaluating waiting reasons:", error);
        });
      } catch (reEvalError) {
        // Log but don't fail the queue deactivation
        console.error(
          "[Queue] Failed to trigger waiting reason re-evaluation:",
          reEvalError,
        );
      }
    }

    // Broadcast queue deactivation event to all agent users and monitors
    if (deactivated.length > 0) {
      try {
        const { broadcastToAllAgents, broadcastToKey } =
          await import("@/lib/sse");
        const queueRes = await pool.query(
          `SELECT * FROM cc_queues WHERE id = ANY($1::text[])`,
          [deactivated],
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
          queueIds: deactivated,
          queues: queues.map((q) => ({
            id: q.id,
            name: q.name,
            displayName: q.display_name || q.name,
          })),
          activated: false,
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
        console.error(
          "[Queues] Failed to broadcast queue deactivation:",
          sseError,
        );
        // Don't fail the request if SSE fails
      }
    }

    return NextResponse.json({ ok: true, deactivated });
  } catch (err) {
    console.error("[Queue Deactivate] Error:", err);
    return NextResponse.json(
      { ok: false, error: err.message || "Server error" },
      { status: 500 },
    );
  }
}
