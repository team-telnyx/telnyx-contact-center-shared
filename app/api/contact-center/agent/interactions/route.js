import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { listAgentInteractionViews } from "@/lib/acd/work-item-repository.mjs";
import { withPermission } from "@/lib/authz/guard";

/**
 * GET /api/contact-center/agent/interactions
 * List Core work items assigned to the authenticated agent.
 */
async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;

    const { searchParams } = new URL(request.url);
    const state = searchParams.get("state");
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const activeOnly = searchParams.get("activeOnly") !== "false";

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 503 },
      );
    }

    const interactions = await listAgentInteractionViews(pool, user.id, {
      state,
      activeOnly,
      limit,
    });

    return NextResponse.json({ ok: true, interactions });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/agent/interactions" });
