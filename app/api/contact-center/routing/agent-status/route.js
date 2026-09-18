import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  ensureAgentState,
  readEffectiveAgentStatus,
  setManualAgentStatus,
} from "@/lib/acd/agent-state.mjs";
import { setAgentQueueActivation } from "@/lib/acd/queue-membership.mjs";
import { contactCenterErrorPayload, statusLogger } from "@/lib/contact-center/logging.mjs";
import { withPermission } from "@/lib/authz/guard";

async function POST_handler(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const userId = String(session.user.id);
    const body = await request.json();
    statusLogger.debug("routing_status_update_requested", {
      agentUserId: userId,
      requestedStatus: body.status || null,
      queueCount: Array.isArray(body.queueIds) ? body.queueIds.length : null,
    });
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ error: "Database not available" }, { status: 503 });
    await ensureAgentState(pool, userId);

    let effectiveStatus = await readEffectiveAgentStatus(pool, userId, "Offline");
    if (body.status) {
      const valid = await pool.query(
        `SELECT 1 FROM cc_user_statuses
          WHERE name = $1 AND is_active = true AND user_selectable = true`,
        [body.status],
      );
      if (!valid.rowCount) {
        return NextResponse.json({ error: "Invalid user-selectable status" }, { status: 400 });
      }
      effectiveStatus = await setManualAgentStatus(pool, {
        agentId: userId,
        status: body.status,
        actor: `agent:${userId}`,
        expectedVersion: body.expectedVersion ?? null,
      });
    }

    let changedQueues = [];
    if (Array.isArray(body.queueIds)) {
      changedQueues = await setAgentQueueActivation(pool, {
        agentId: userId,
        queueIds: body.queueIds,
        enabled: body.isActive !== false,
        actor: `agent:${userId}`,
      });
    }
    statusLogger.info("routing_status_update_completed", {
      agentUserId: userId,
      effectiveStatus,
      queueCount: changedQueues.length,
    });
    return NextResponse.json({
      success: true,
      status: effectiveStatus,
      queues: changedQueues.map((queue) => String(queue.id)),
    });
  } catch (error) {
    statusLogger.error("routing_status_update_failed", contactCenterErrorPayload(error));
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: error.status || 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("agent:self", POST_handler, { route: "/api/contact-center/routing/agent-status" });
