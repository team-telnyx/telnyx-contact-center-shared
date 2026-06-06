export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { loadAgentCampaignAttempt, markAgentCampaignAttemptDialing } from "@/lib/outbound-dialer/agent-campaigns";

function usernameFor(user) {
  return user?.username || user?.email || null;
}

export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
    const agentUsername = usernameFor(user);
    if (!agentUsername) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    const body = await request.json().catch(() => ({}));
    const attemptId = String(body?.attemptId || "").trim();
    if (!attemptId) return NextResponse.json({ ok: false, error: "Attempt ID is required" }, { status: 400 });
    const attempt = await loadAgentCampaignAttempt(pool, agentUsername, attemptId);
    if (!attempt) return NextResponse.json({ ok: false, error: "Assigned campaign record not found" }, { status: 404 });
    const execution = await markAgentCampaignAttemptDialing(pool, attempt, agentUsername);
    return NextResponse.json({ ok: execution?.ok === true, execution });
  } catch (err) {
    console.error("[Agent Campaigns] dial failed:", err);
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: 400 });
  }
}
