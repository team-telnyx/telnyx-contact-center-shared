import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { claimNextAgentCampaignRecord } from "@/lib/outbound-dialer/agent-campaigns";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

function usernameFor(user) {
  return user?.username || user?.email || null;
}

async function GET_handler(_request, _context, authz) {
  try {
    const user = authz.user;
    const agentUsername = usernameFor(user);
    if (!agentUsername) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    const assignment = await claimNextAgentCampaignRecord(pool, agentUsername);
    return NextResponse.json({ ok: true, assignment });
  } catch (err) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/agent/campaigns/next" });
