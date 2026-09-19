import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { findPendingAcdWrapupForAgent } from "@/lib/acd/wrapup-context.mjs";
import { withPermission } from "@/lib/authz/guard";

async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Postgres not configured" },
        { status: 503 },
      );
    }

    const segment = await findPendingAcdWrapupForAgent(pool, {
      agentId: user.id,
      interactionId: request?.url ? new URL(request.url).searchParams.get('interactionId') : null,
    });
    return NextResponse.json({
      ok: true,
      pendingWrapup: segment
        ? {
            interactionId: segment.interaction_id,
            workItemId: segment.work_item_id,
            segmentId: segment.id,
            answeredAt: segment.answered_at,
            completedAt: segment.ended_at,
            waitingForCallEnd: Boolean(segment.outbound_attempt_id && segment.outcome !== 'transferred' && (!segment.terminal_at || !segment.outbound_released_at)),
            campaignAssignment: segment.outbound_attempt_id && segment.terminal_at && segment.outbound_released_at
              ? { id: segment.outbound_attempt_id, campaign_id: segment.outbound_campaign_id, to_number: segment.customer_address }
              : null,
          }
        : null,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/agent/pending-wrapup" });
