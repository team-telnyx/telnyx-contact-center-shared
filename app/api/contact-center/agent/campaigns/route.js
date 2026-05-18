import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { listAgentCampaigns, setAgentCampaignActivation } from "@/lib/outbound-dialer/agent-campaigns";

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
    const campaigns = await listAgentCampaigns(pool, agentUsername);
    return NextResponse.json({ ok: true, campaigns });
  } catch (err) {
    console.error("[Agent Campaigns] list failed:", err);
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
    const agentUsername = usernameFor(user);
    if (!agentUsername) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    const body = await request.json().catch(() => ({}));
    const campaignId = body?.campaignId && body.campaignId !== "none" ? String(body.campaignId) : null;
    await setAgentCampaignActivation(pool, agentUsername, campaignId);
    const campaigns = await listAgentCampaigns(pool, agentUsername);
    return NextResponse.json({ ok: true, campaigns, activeCampaignId: campaignId });
  } catch (err) {
    console.error("[Agent Campaigns] activation failed:", err);
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: 400 });
  }
}
