import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { contactCenterErrorPayload, queuesLogger } from "@/lib/contact-center/logging.mjs";
import {
  enrichAcdRealtimeCalls,
  getAcdRealtimeQueueCalls,
} from "@/lib/acd/realtime-queue-calls.mjs";
import { withPermission } from "@/lib/authz/guard";
import { queueInScope } from "@/lib/authz/scope.mjs";

/**
 * GET /api/contact-center/queues/[queueId]/calls
 * Get all calls/interactions for a specific queue with detailed statistics
 */
async function GET_handler(request, { params }, authz) {
  try {
    const user = authz.user;

    // Only supervisors and admins can view queue calls

    const { queueId } = await params;
    if (queueId && !queueInScope(authz.scope, queueId)) {
      return NextResponse.json({ ok: false, error: "Queue not found" }, { status: 404 });
    }
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

    const calls = await enrichAcdRealtimeCalls(
      pool,
      await getAcdRealtimeQueueCalls(pool, queueId),
      { queues: [queue] },
    );

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

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("monitor:read", GET_handler, { route: "/api/contact-center/queues/[queueId]/calls" });
