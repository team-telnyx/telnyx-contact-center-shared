import { NextResponse } from "next/server";
import { getOutboundPool } from "@/lib/outbound-dialer/api";
import { buildOutboundLiveCallsPayload, OUTBOUND_LIVE_CALLS_SQL } from "@/lib/outbound-dialer/live-calls";
import { liveCallsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { campaignInScope } from "@/lib/authz/scope.mjs";

export const dynamic = "force-dynamic";

async function GET_handler(_request, _context, authz) {
  try {
    const user = authz.user;

    const pool = getOutboundPool();
    if (!pool) return NextResponse.json({ error: "Postgres is not configured" }, { status: 503 });

    const { rows } = await pool.query(OUTBOUND_LIVE_CALLS_SQL);
    // Only calls of campaigns inside the caller's scope (RBAC review fix).
    return NextResponse.json(buildOutboundLiveCallsPayload(rows.filter((row) => campaignInScope(authz.scope, row.campaign_id))));
  } catch (error) {
    liveCallsLogger.error("live_calls_load_failed", { ...outboundErrorPayload(error) });
    return NextResponse.json({ error: error?.message || "Failed to load live calls" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("campaigns:read", GET_handler, { route: "/api/contact-center/outbound-dialer/live-calls" });
