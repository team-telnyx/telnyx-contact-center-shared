import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import {
  broadcastCampaignActivationChanged,
  listAgentCampaigns,
  setAgentCampaignActivation,
} from "@/lib/outbound-dialer/agent-campaigns";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

function usernameFor(user) {
  return user?.username || user?.email || null;
}

async function resolveTargetAgent(pool, requester, requestedUserId) {
  if (!requestedUserId || String(requestedUserId) === String(requester.id)) {
    return { userId: requester.id, username: usernameFor(requester) };
  }
  if (!isSupervisorOrAdmin(requester)) {
    throw Object.assign(new Error("Only supervisors and admins can manage other users' campaigns"), { status: 403 });
  }
  const { rows } = await pool.query(
    `SELECT id, username, email FROM users WHERE id = $1 LIMIT 1`,
    [requestedUserId],
  );
  const target = rows[0];
  if (!target) throw Object.assign(new Error("Target user not found"), { status: 404 });
  return { userId: target.id, username: target.username || target.email };
}

export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    const { searchParams } = new URL(request.url);
    const target = await resolveTargetAgent(pool, user, searchParams.get("userId"));
    if (!target.username) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const campaigns = await listAgentCampaigns(pool, target.username);
    return NextResponse.json({ ok: true, campaigns });
  } catch (err) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: err.status || 500 });
  }
}

export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    const body = await request.json().catch(() => ({}));
    const target = await resolveTargetAgent(pool, user, body?.userId ? String(body.userId) : null);
    if (!target.username) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    const campaignIds = Array.isArray(body?.campaignIds)
      ? body.campaignIds.filter(Boolean).map(String)
      : body?.campaignId && body.campaignId !== "none"
        ? [String(body.campaignId)]
        : [];

    await setAgentCampaignActivation(pool, target.username, campaignIds);
    const campaigns = await listAgentCampaigns(pool, target.username);
    await broadcastCampaignActivationChanged(pool, { id: "agent-campaign-assignments", name: "Agent campaign assignments", status: "updated", mode: "preview", userId: target.userId, campaignIds }, "campaign_activation_changed");
    return NextResponse.json({ ok: true, campaigns, activeCampaignIds: campaignIds });
  } catch (err) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: err.status || 400 });
  }
}
