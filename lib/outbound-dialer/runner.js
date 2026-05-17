import { claimOneAgentlessRecord, executeAgentlessAttempt, startCampaignRun } from "./execution";

const RUNNERS = globalThis.__outboundAgentlessRunners || new Map();
globalThis.__outboundAgentlessRunners = RUNNERS;

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isAgentlessMode(mode) {
  return mode === "agentless_ai" || mode === "agentless_flow";
}

async function loadCampaign(pool, campaignId) {
  const { rows } = await pool.query(
    `SELECT * FROM outbound_campaigns WHERE id = $1 LIMIT 1`,
    [campaignId],
  );
  return rows[0] || null;
}

async function resolveMaxLines(pool, campaign) {
  const concurrency = campaign?.concurrency_config && typeof campaign.concurrency_config === "object"
    ? campaign.concurrency_config
    : {};
  const campaignLimit = numberOr(concurrency.maxLines ?? concurrency.maxConcurrent, null);

  let globalLimit = 10;
  try {
    const settingsResult = await pool.query(`SELECT settings FROM outbound_settings WHERE id='default' LIMIT 1`);
    const settings = settingsResult.rows?.[0]?.settings && typeof settingsResult.rows[0].settings === "object"
      ? settingsResult.rows[0].settings
      : {};
    globalLimit = numberOr(settings.max_lines ?? settings.maxLines, 10);
  } catch {
    globalLimit = 10;
  }

  if (campaignLimit && globalLimit) return Math.max(1, Math.min(campaignLimit, globalLimit));
  return Math.max(1, campaignLimit || globalLimit || 10);
}

async function countInFlightCalls(pool, campaignId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS in_flight
     FROM outbound_attempt_ledger
     WHERE campaign_id = $1
       AND status IN ('claimed', 'dialing', 'answered')`,
    [campaignId],
  );
  return Number(result.rows?.[0]?.in_flight || 0);
}

function clearRunner(campaignId) {
  const existing = RUNNERS.get(campaignId);
  if (existing?.timer) clearTimeout(existing.timer);
  RUNNERS.delete(campaignId);
}

function schedule(campaignId, delayMs) {
  const state = RUNNERS.get(campaignId);
  if (!state || state.stopped) return;
  state.timer = setTimeout(() => tick(campaignId).catch(() => {}), Math.max(250, delayMs));
}

async function tick(campaignId) {
  const state = RUNNERS.get(campaignId);
  if (!state || state.stopped || state.running) return;
  state.running = true;
  try {
    const campaign = await loadCampaign(state.pool, campaignId);
    if (!campaign || campaign.status !== "running" || !isAgentlessMode(campaign.mode)) {
      clearRunner(campaignId);
      return;
    }

    const runResult = await state.pool.query(
      `SELECT * FROM outbound_campaign_runs
       WHERE campaign_id = $1 AND status = 'running'
       ORDER BY started_at DESC
       LIMIT 1`,
      [campaignId],
    );
    const run = runResult.rows[0] || (await startCampaignRun(state.pool, campaignId, state.username || "system"));

    const maxLines = await resolveMaxLines(state.pool, campaign);
    const inFlight = await countInFlightCalls(state.pool, campaignId);
    if (inFlight >= maxLines) {
      schedule(campaignId, 1200);
      return;
    }

    const claim = await claimOneAgentlessRecord(state.pool, campaign, run?.id || null);
    if (!claim) {
      schedule(campaignId, 5000);
      return;
    }

    await executeAgentlessAttempt(state.pool, campaign, claim);
    schedule(campaignId, 450);
  } catch (err) {
    console.error("[Outbound Dialer] runner tick error:", err);
    schedule(campaignId, 3000);
  } finally {
    const next = RUNNERS.get(campaignId);
    if (next) next.running = false;
  }
}

export function startAgentlessRunner({ pool, campaignId, username = "system" }) {
  if (!pool || !campaignId) return;
  const existing = RUNNERS.get(campaignId);
  if (existing) {
    existing.stopped = false;
    existing.username = username;
    if (!existing.running && !existing.timer) schedule(campaignId, 50);
    return;
  }

  RUNNERS.set(campaignId, {
    pool,
    campaignId,
    username,
    running: false,
    stopped: false,
    timer: null,
  });
  schedule(campaignId, 50);
}

export function stopAgentlessRunner(campaignId) {
  clearRunner(campaignId);
}

export function getRunnerState(campaignId) {
  const state = RUNNERS.get(campaignId);
  if (!state) return { running: false };
  return { running: !state.stopped, inFlight: state.running };
}
