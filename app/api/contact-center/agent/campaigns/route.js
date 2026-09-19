import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  broadcastCampaignActivationChanged,
  listAgentCampaigns,
  setAgentCampaignActivation,
} from "@/lib/outbound-dialer/agent-campaigns";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { agentInScope, campaignInScope } from "@/lib/authz/scope.mjs";

function usernameFor(user) {
  return user?.username || user?.email || null;
}

async function resolveTargetAgent(pool, requester, requestedUserId) {
  if (!requestedUserId || String(requestedUserId) === String(requester.id)) {
    return { userId: requester.id, username: usernameFor(requester) };
  }
  const { rows } = await pool.query(
    `SELECT id, username, email FROM users WHERE id = $1 LIMIT 1`,
    [requestedUserId],
  );
  const target = rows[0];
  if (!target) throw Object.assign(new Error("Target user not found"), { status: 404 });
  return { userId: target.id, username: target.username || target.email };
}

async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    const { searchParams } = new URL(request.url);
    const target = await resolveTargetAgent(pool, user, searchParams.get("userId"));
    if (!agentInScope(authz.scope, target.userId)) return NextResponse.json({ ok: false, error: "Target user not found" }, { status: 404 });
    if (!target.username) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const campaigns = await listAgentCampaigns(pool, target.username);
    return NextResponse.json({ ok: true, campaigns });
  } catch (err) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: err.status || 500 });
  }
}

async function POST_handler(request, _context, authz) {
  try {
    const user = authz.user;
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    const body = await request.json().catch(() => ({}));
    const target = await resolveTargetAgent(pool, user, body?.userId ? String(body.userId) : null);
    if (!agentInScope(authz.scope, target.userId)) return NextResponse.json({ ok: false, error: "Target user not found" }, { status: 404 });
    if (!target.username) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    const campaignIds = Array.isArray(body?.campaignIds)
      ? body.campaignIds.filter(Boolean).map(String)
      : body?.campaignId && body.campaignId !== "none"
        ? [String(body.campaignId)]
        : [];

    const outsideScope = campaignIds.filter((campaignId) => !campaignInScope(authz.scope, campaignId));
    if (outsideScope.length) return NextResponse.json({ ok: false, error: "Campaign outside your data scope", campaignIds: outsideScope }, { status: 403 });

    await setAgentCampaignActivation(pool, target.username, campaignIds);
    const campaigns = await listAgentCampaigns(pool, target.username);
    await broadcastCampaignActivationChanged(pool, { id: "agent-campaign-assignments", name: "Agent campaign assignments", status: "updated", mode: "preview", userId: target.userId, campaignIds }, "campaign_activation_changed");
    return NextResponse.json({ ok: true, campaigns, activeCampaignIds: campaignIds });
  } catch (err) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: err.status || 400 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agents:campaigns.assign", GET_handler, { route: "/api/contact-center/agent/campaigns" });
export const POST = withPermission("agents:campaigns.assign", POST_handler, { route: "/api/contact-center/agent/campaigns" });
