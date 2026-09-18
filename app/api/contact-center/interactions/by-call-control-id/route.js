import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  findInteractionViewByCallControlId,
  findInteractionViewByCallSessionId,
} from "@/lib/acd/work-item-repository.mjs";
import {
  contactCenterRuntimeLogger,
  runtimePayload,
} from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { workItemInScope } from "@/lib/authz/scope.mjs";

/** Find a Core work item by any provider leg id or provider session id. */
async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;

    const { searchParams } = new URL(request.url);
    const callControlId = searchParams.get("callControlId")?.trim();
    if (!callControlId) {
      return NextResponse.json(
        { ok: false, error: "callControlId is required" },
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

    const interaction =
      (await findInteractionViewByCallControlId(pool, callControlId)) ||
      (await findInteractionViewByCallSessionId(pool, callControlId));
    if (interaction && !(await workItemInScope(pool, authz.scope, interaction.work_item_id || interaction.id, { queueId: interaction.queue_id, agentId: interaction.agent_id, channel: interaction.interaction_type }))) {
      return NextResponse.json({ ok: true, interaction: null });
    }

    return NextResponse.json({ ok: true, interaction });
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
export const GET = withPermission("interactions:read", GET_handler, { route: "/api/contact-center/interactions/by-call-control-id" });
