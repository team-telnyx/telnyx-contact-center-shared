import { claimAutonomousOutbound } from "@/lib/acd/outbound-runtime.mjs";
import { NextResponse } from "next/server";
import {
  getOutboundPool,
  jsonError,
  mapCampaign, usernameFor } from "@/lib/outbound-dialer/api";
import {
  closeCampaignRun,
  recycleCampaignRecords,
  updateCampaignExecutionControl,
} from "@/lib/outbound-dialer/execution";
import { completeCampaignIfExhausted } from "@/lib/outbound-dialer/completion";
import { broadcastCampaignActivationChanged } from "@/lib/outbound-dialer/agent-campaigns";
import { startAgentlessRunner, stopAgentlessRunner, getRunnerState } from "@/lib/outbound-dialer/runner";
import { executionLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { isOutboundMessagingChannel } from "@/lib/outbound-dialer/schema";
import { assertMessagingCampaignStartable } from "@/lib/outbound-dialer/messaging/api.mjs";
import { loadOutboundSettingsRow, patchMessagingRuntime, runMessagingCampaignTick } from "@/lib/outbound-dialer/messaging/execution.mjs";
import { messagingProvider } from "@/lib/outbound-dialer/messaging/provider.mjs";
import { withPermission } from "@/lib/authz/guard";
import { campaignInScope, resolveScope } from "@/lib/authz/scope.mjs";

function isAgentlessMode(mode) {
  return mode === "agentless_ai" || mode === "agentless_flow";
}

async function POST_handler(request, context, authz) {
  const user = authz.user;

  const { campaignId } = await context.params;
  if (!campaignInScope(authz.scope, campaignId)) return jsonError("Campaign not found", 404);
  const pool = getOutboundPool();
  if (!pool) return jsonError("Server not ready", 500);

  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "").trim().toLowerCase();
    if (!["start", "pause", "resume", "stop", "tick", "recycle"].includes(action)) {
      return jsonError("Unsupported action", 400);
    }

    const actionPermission = ["pause", "resume"].includes(action) ? "campaigns:pause" : "campaigns:execute";
    if (!authz.can(actionPermission) || !campaignInScope(await resolveScope(pool, user, authz.access, actionPermission), campaignId)) return jsonError("Forbidden", 403);
    const { rows } = await pool.query(
      `SELECT * FROM outbound_campaigns WHERE id = $1 AND status <> 'archived' LIMIT 1`,
      [campaignId],
    );
    const campaign = rows[0];
    if (!campaign) return jsonError("Campaign not found", 404);
    const messaging = isOutboundMessagingChannel(campaign.channel);
    if (['start','resume','tick'].includes(action) && campaign.channel !== 'voice' && !messaging) return jsonError('Only voice and messaging campaign execution is enabled at this stage',400);

    const username = usernameFor(user);

    if (messaging && action === "tick") {
      if (campaign.status !== "running") return jsonError("Campaign must be running before tick execution", 409);
      const summary = await runMessagingCampaignTick(pool, messagingProvider(), campaign, { node: `web:${username}` });
      return NextResponse.json({ ok: true, action, summary, runner: getRunnerState(campaignId) });
    }
    if (messaging && ["start", "resume"].includes(action)) {
      try { await assertMessagingCampaignStartable(pool, campaign, await loadOutboundSettingsRow(pool)); }
      catch (error) { return jsonError(error.message || "Campaign is not ready to start", error.status || 400); }
      // A manual start clears throttling, batch pacing and auto-pause markers.
      await patchMessagingRuntime(pool, campaignId, { throttle_until: null, next_batch_at: null, auto_paused_reason: null, auto_paused_detail: null, auto_paused_at: null, started_by: username, started_at: new Date().toISOString() });
    }

    if (["start", "resume", "pause", "stop", "recycle"].includes(action)) {
      if (action === "recycle") {
        if (isAgentlessMode(campaign.mode)) {
          stopAgentlessRunner(campaignId);
        }
        await closeCampaignRun(pool, campaignId, "stopped", username, "recycle", { action: "recycle" });
        const { updatedCampaign, recycledAttempts } = await recycleCampaignRecords(pool, campaignId, username);
        await broadcastCampaignActivationChanged(pool, updatedCampaign || campaign, "campaign_status_changed");
        return NextResponse.json({
          ok: true,
          action,
          campaign: mapCampaign(updatedCampaign || campaign),
          recycled_attempts: recycledAttempts,
          runner: getRunnerState(campaignId),
        });
      }

      const updated = await updateCampaignExecutionControl(
        pool,
        campaignId,
        action,
        username,
      );

      let run = null;
      if ((action === "start" || action === "resume") && (isAgentlessMode(updated?.mode) || isOutboundMessagingChannel(updated?.channel))) {
        const runResult = await pool.query(
          `SELECT * FROM outbound_campaign_runs
           WHERE campaign_id = $1 AND status = 'running'
           ORDER BY started_at DESC
           LIMIT 1`,
          [campaignId],
        );
        run = runResult.rows[0] || null; // durable worker creates the run under the campaign lock
        startAgentlessRunner({ pool, campaignId, username });
      }

      if ((action === "pause" || action === "stop") && isAgentlessMode(updated?.mode)) {
        stopAgentlessRunner(campaignId);
      }

      if (action === "pause") {
        await closeCampaignRun(pool, campaignId, "paused", username, "manual_pause", { action: "pause" });
      }
      if (action === "stop") {
        await closeCampaignRun(pool, campaignId, "stopped", username, "manual_stop", { action: "stop" });
      }

      await broadcastCampaignActivationChanged(pool, updated, "campaign_status_changed");

      return NextResponse.json({
        ok: true,
        action,
        campaign: mapCampaign(updated),
        run,
        runner: getRunnerState(campaignId),
      });
    }

    if (!isAgentlessMode(campaign.mode)) {
      return jsonError("Tick currently supported only for agentless campaign modes", 400);
    }
    if (campaign.status !== "running") {
      return jsonError("Campaign must be running before tick execution", 409);
    }

    const runResult = await pool.query(
      `SELECT * FROM outbound_campaign_runs
       WHERE campaign_id = $1 AND status = 'running'
       ORDER BY started_at DESC
       LIMIT 1`,
      [campaignId],
    );
    const run = runResult.rows[0] || null;

    const claim = await claimAutonomousOutbound(pool, campaignId);
    if (!claim) {
      const completion = await completeCampaignIfExhausted(pool, campaign, username);
      if (completion.completed && isAgentlessMode(campaign.mode)) {
        stopAgentlessRunner(campaignId);
      }
      return NextResponse.json({
        ok: true,
        action,
        run,
        claim: null,
        completion,
        campaign: completion.campaign ? mapCampaign(completion.campaign) : undefined,
        message: completion.completed ? "Campaign completed: no claimable records remain" : "No claimable records",
      });
    }

    const execution = { ok: true, durable: true, saga_id: claim.sagaId };

    return NextResponse.json({
      ok: execution?.ok === true,
      action,
      run,
      claim: execution?.ledger || null,
      execution,
    });
  } catch (err) {
    executionLogger.error("execution_action_failed", { campaignId, ...outboundErrorPayload(err) });
    return jsonError(err.message || "Execution action failed", 400);
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission(["campaigns:execute", "campaigns:pause"], POST_handler, { route: "/api/contact-center/outbound-dialer/campaigns/[campaignId]/execution" });
