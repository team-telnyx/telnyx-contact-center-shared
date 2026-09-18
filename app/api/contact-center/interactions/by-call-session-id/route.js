import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { findInteractionViewByCallSessionId } from "@/lib/acd/work-item-repository.mjs";
import { contactCenterRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { workItemInScope } from "@/lib/authz/scope.mjs";

/**
 * GET /api/contact-center/interactions/by-call-session-id?callSessionId=...
 * Find interaction by call_session_id
 */
async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;

    const { searchParams } = new URL(request.url);
    const callSessionId = searchParams.get("callSessionId");

    if (!callSessionId || callSessionId.trim() === "") {
      return NextResponse.json(
        { ok: false, error: "callSessionId is required" },
        { status: 400 },
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 503 },
      );
    }

    const interaction = await findInteractionViewByCallSessionId(
      pool,
      callSessionId,
    );

    if (!interaction || !(await workItemInScope(pool, authz.scope, interaction.work_item_id || interaction.id, { queueId: interaction.queue_id, agentId: interaction.agent_id, channel: interaction.interaction_type }))) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      interaction,
    });
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", {
      ...runtimePayload({ error }),
    });
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("interactions:read", GET_handler, { route: "/api/contact-center/interactions/by-call-session-id" });
