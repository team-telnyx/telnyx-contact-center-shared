import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { setAgentQueueActivation } from "@/lib/acd/queue-membership.mjs";
import { broadcastToAllAgents } from "@/lib/sse";
import { contactCenterErrorPayload, queuesLogger } from "@/lib/contact-center/logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { agentInScope } from "@/lib/authz/scope.mjs";

async function POST_handler(request, _context, authz) {
  try {
    const user = authz.user;
    const body = await request.json();
    const targetUserId = String(body.userId || user.id);
    if (targetUserId !== String(user.id) && !authz.elevated) {
      return NextResponse.json({ ok: false, error: "Only supervisors and admins can manage other users' queues" }, { status: 403 });
    }
    if (targetUserId !== String(user.id) && !agentInScope(authz.scope, targetUserId)) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
    if (!Array.isArray(body.queueIds)) {
      return NextResponse.json({ ok: false, error: "queueIds must be an array" }, { status: 400 });
    }
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 503 });
    const queues = await setAgentQueueActivation(pool, {
      agentId: targetUserId,
      queueIds: body.queueIds,
      enabled: true,
      actor: targetUserId === String(user.id) ? `agent:${user.id}` : `supervisor:${user.id}`,
    });
    const activated = queues.map((queue) => String(queue.id));
    queuesLogger.info("queue_memberships_activated", {
      agentUserId: targetUserId,
      queueIds: activated,
      changedBy: String(user.id),
    });
    if (activated.length > 0) {
      await broadcastToAllAgents({
        type: "queue_activation_changed",
        userId: targetUserId,
        queueIds: activated,
        queues: queues.map((queue) => ({
          id: queue.id,
          name: queue.name,
          displayName: queue.display_name || queue.name,
        })),
        activated: true,
        timestamp: new Date().toISOString(),
      }, "queue_changed");
    }
    return NextResponse.json({ ok: true, activated });
  } catch (error) {
    queuesLogger.error("queue_memberships_activation_failed", contactCenterErrorPayload(error));
    return NextResponse.json({ ok: false, error: error.message || "Server error" }, { status: error.status || 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission(["agents:queues.set","agent:self"], POST_handler, { route: "/api/contact-center/agent/queues/activate", elevated: "agents:queues.set" });
