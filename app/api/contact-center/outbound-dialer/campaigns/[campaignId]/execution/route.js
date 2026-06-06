export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  getOutboundPool,
  jsonError,
  mapCampaign,
  requireOutboundSupervisor,
  usernameFor,
} from "@/lib/outbound-dialer/api";
import {
  closeCampaignRun,
  claimOneAgentlessRecord,
  executeAgentlessAttempt,
  recycleCampaignRecords,
  startCampaignRun,
  updateCampaignExecutionControl,
} from "@/lib/outbound-dialer/execution";
import { completeCampaignIfExhausted } from "@/lib/outbound-dialer/completion";
import { broadcastCampaignActivationChanged } from "@/lib/outbound-dialer/agent-campaigns";
import { startAgentlessRunner, stopAgentlessRunner, getRunnerState } from "@/lib/outbound-dialer/runner";

function isAgentlessMode(mode) {
  return mode === "agentless_ai" || mode === "agentless_flow";
}

export async function POST(request, context) {
  const user = await requireOutboundSupervisor();
  if (!user) return jsonError("Forbidden", 403);

  const { campaignId } = await context.params;
  const pool = getOutboundPool();
  if (!pool) return jsonError("Server not ready", 500);

  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "").trim().toLowerCase();
    if (!["start", "pause", "resume", "stop", "tick", "recycle"].includes(action)) {
      return jsonError("Unsupported action", 400);
    }

    const { rows } = await pool.query(
      `SELECT * FROM outbound_campaigns WHERE id = $1 AND status <> 'archived' LIMIT 1`,
      [campaignId],
    );
    const campaign = rows[0];
    if (!campaign) return jsonError("Campaign not found", 404);

    const username = usernameFor(user);

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
      if ((action === "start" || action === "resume") && isAgentlessMode(updated?.mode)) {
        const runResult = await pool.query(
          `SELECT * FROM outbound_campaign_runs
           WHERE campaign_id = $1 AND status = 'running'
           ORDER BY started_at DESC
           LIMIT 1`,
          [campaignId],
        );
        run = runResult.rows[0] || (await startCampaignRun(pool, campaignId, username));
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
    const run = runResult.rows[0] || (await startCampaignRun(pool, campaignId, username));

    const claim = await claimOneAgentlessRecord(pool, campaign, run?.id || null);
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

    const execution = await executeAgentlessAttempt(pool, campaign, claim);

    return NextResponse.json({
      ok: execution?.ok === true,
      action,
      run,
      claim: execution?.ledger || null,
      execution,
    });
  } catch (err) {
    console.error("[Outbound Dialer] execution action error:", err);
    return jsonError(err.message || "Execution action failed", 400);
  }
}
