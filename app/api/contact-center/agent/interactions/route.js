import { mobilePaging, mobileInbox } from "@/lib/acd/mobile-monitor-pages.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { listAgentInteractionViews } from "@/lib/acd/work-item-repository.mjs";
import { readTextInteractions } from "@/lib/acd/text-desktop.mjs";
import { NATIVE_LIFECYCLE_CHANNELS } from "@/lib/acd/channel-registry.mjs";
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

    let interactions = await listAgentInteractionViews(pool, user.id, {
      state,
      activeOnly,
      limit: mobilePaging(searchParams) ? null : limit,
    });

    if (activeOnly) {
      // Native messaging assignments include offers and wrap-up, including a
      // terminal work item whose agent still owes disposition.
      const text = await readTextInteractions(pool, String(user.id));
      interactions = [...interactions.filter(row => !NATIVE_LIFECYCLE_CHANNELS.includes(row.channel)),
        ...text.interactions.filter(row => !state || row.state === state)];
      if (!mobilePaging(searchParams)) interactions = interactions.slice(0, Math.min(100, Math.max(1, limit || 50)));
    }
    return NextResponse.json(mobilePaging(searchParams) ? mobileInbox(interactions, searchParams) : { ok: true, interactions }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/agent/interactions" });
