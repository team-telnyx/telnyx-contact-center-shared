export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { claimNextAgentCampaignRecord } from "@/lib/outbound-dialer/agent-campaigns";

function usernameFor(user) {
  return user?.username || user?.email || null;
}

export async function GET() {
  try {
    const user = await getAuthenticatedUser();
    const agentUsername = usernameFor(user);
    if (!agentUsername) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    const assignment = await claimNextAgentCampaignRecord(pool, agentUsername);
    return NextResponse.json({ ok: true, assignment });
  } catch (err) {
    console.error("[Agent Campaigns] next record failed:", err);
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: 500 });
  }
}
