/**
 * WS6 — Predictive pacing controller, abandon-rate compliance & blending
 * (flag-gated, inert by default).
 *
 * Enabled only when OUTBOUND_PREDICTIVE_PACING=true. Mounted inside the WS3
 * singleton coordinator leader loop (same leadership as the WS5 Power pacer),
 * so exactly one node paces predictive campaigns at any time.
 *
 * Differences vs Power (WS5-T3):
 *   - Power dials a FIXED ratio per free agent.
 *   - Predictive dials an ADAPTIVE ratio derived from live campaign stats:
 *       rawRatio   = 1 / answerRate          (more dials when fewer answer)
 *       effective  = min(rawRatio × baseRatio, maxRatio) × complianceDamping
 *     where complianceDamping shrinks the ratio multiplicatively as the
 *     trailing abandon rate approaches/exceeds the configured target
 *     (classic abandon-rate compliance loop, default target 3%).
 *   - Cold start: until minSampleSize attempts have completed in the trailing
 *     window the controller behaves like Power (ratio = baseRatio), so a new
 *     campaign cannot overdial before statistics exist.
 *   - Blending: free agents are reduced by an inbound reserve before the
 *     budget is computed — queued inbound interactions on the campaign's
 *     target queue claim agents first, plus an optional fixed percentage
 *     reserve (blending_config.inboundReservePercent).
 *
 * Everything else (claim → originate with AMD, human connect via
 * reserveAgent + bridge, overshoot abandon) reuses the WS5 primitives in
 * pacing-power.js / execution.js. No inbound routing code is touched.
 */

import { runnerLogger, outboundErrorPayload } from "./logging.mjs";
import {
  computePowerDialBudget,
  listFreeAgentsForQueue,
  reconnectOrAbandonPendingHumans,
} from "./pacing-power.js";

const TICK_INTERVAL_MS = 1_000;
const DEFAULT_BASE_RATIO = 1;
const DEFAULT_MAX_RATIO = 3;
const DEFAULT_ABANDON_TARGET = 0.03; // 3% — common regulatory ceiling
const DEFAULT_MIN_ANSWER_RATE = 0.1; // floor so 1/answerRate stays bounded
const DEFAULT_MIN_SAMPLE_SIZE = 20;
const DEFAULT_STATS_WINDOW_MINUTES = 30;
const MIN_COMPLIANCE_DAMPING = 0.25; // never throttle below 25% of computed ratio

const runtime = (globalThis.__outboundPredictivePacing ||= {
  started: false,
  stopRequested: false,
  loopPromise: null,
});

export function isPredictivePacingEnabled() {
  return (
    String(process.env.OUTBOUND_PREDICTIVE_PACING || "false").toLowerCase() === "true"
  );
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function predictivePacingConfig(campaign = {}) {
  const pacing = parseJson(campaign.pacing_config, {});
  const blending = parseJson(campaign.metadata, {})?.blending_config || pacing.blending || {};
  return {
    baseRatio: numberOr(pacing.ratio, DEFAULT_BASE_RATIO),
    maxRatio: numberOr(pacing.maxRatio ?? pacing.max_ratio, DEFAULT_MAX_RATIO),
    abandonTarget: clamp01(
      numberOr(pacing.abandonTarget ?? pacing.abandon_target, DEFAULT_ABANDON_TARGET),
    ),
    minSampleSize: Math.max(
      1,
      Math.floor(numberOr(pacing.minSampleSize ?? pacing.min_sample_size, DEFAULT_MIN_SAMPLE_SIZE)),
    ),
    statsWindowMinutes: numberOr(
      pacing.statsWindowMinutes ?? pacing.stats_window_minutes,
      DEFAULT_STATS_WINDOW_MINUTES,
    ),
    abandonTimeoutSecs: numberOr(
      pacing.abandonTimeoutSecs ?? pacing.abandon_timeout_secs,
      10,
    ),
    inboundReservePercent: clamp01(
      Number(blending.inboundReservePercent ?? blending.inbound_reserve_percent ?? 0) / 100 >
        0
        ? Number(blending.inboundReservePercent ?? blending.inbound_reserve_percent) / 100
        : 0,
    ),
  };
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Pure controller (unit-tested): derive the effective predictive ratio from
 * trailing stats.
 *
 *   sample too small        → baseRatio (Power-like cold start)
 *   rawRatio                = baseRatio / max(answerRate, minAnswerRate)
 *   capped                  = min(rawRatio, maxRatio)
 *   complianceDamping       = 1                       when abandonRate ≤ target
 *                             max(MIN, target/abandon) when above target
 *   effective               = max(1 × damping, capped × damping)
 *
 * The result is always ≥ MIN_COMPLIANCE_DAMPING and ≤ maxRatio.
 */
export function computePredictiveRatio({
  answerRate,
  abandonRate,
  sampleSize,
  baseRatio = DEFAULT_BASE_RATIO,
  maxRatio = DEFAULT_MAX_RATIO,
  abandonTarget = DEFAULT_ABANDON_TARGET,
  minSampleSize = DEFAULT_MIN_SAMPLE_SIZE,
  minAnswerRate = DEFAULT_MIN_ANSWER_RATE,
} = {}) {
  const base = numberOr(baseRatio, DEFAULT_BASE_RATIO);
  const cap = Math.max(1, numberOr(maxRatio, DEFAULT_MAX_RATIO));
  const samples = Math.max(0, Math.floor(Number(sampleSize) || 0));

  // Cold start: no reliable stats yet — behave like Power.
  if (samples < Math.max(1, Math.floor(Number(minSampleSize) || DEFAULT_MIN_SAMPLE_SIZE))) {
    return Math.min(base, cap);
  }

  const answer = Math.max(clamp01(answerRate), clamp01(minAnswerRate) || DEFAULT_MIN_ANSWER_RATE);
  const rawRatio = base / answer;
  const capped = Math.min(rawRatio, cap);

  const abandon = clamp01(abandonRate);
  const target = clamp01(abandonTarget) || DEFAULT_ABANDON_TARGET;
  const damping =
    abandon <= target ? 1 : Math.max(MIN_COMPLIANCE_DAMPING, target / abandon);

  return Math.max(MIN_COMPLIANCE_DAMPING, capped * damping);
}

/**
 * Pure blending math (unit-tested): how many free agents remain for outbound
 * after reserving capacity for inbound traffic.
 *
 *   reserve = queuedInbound + ceil(reservePercent × freeAgents), capped at freeAgents
 */
export function computeBlendedFreeAgents({
  freeAgents,
  queuedInbound = 0,
  inboundReservePercent = 0,
} = {}) {
  const agents = Math.max(0, Math.floor(Number(freeAgents) || 0));
  const queued = Math.max(0, Math.floor(Number(queuedInbound) || 0));
  const percent = clamp01(inboundReservePercent);
  const reserve = Math.min(agents, queued + Math.ceil(percent * agents));
  return Math.max(0, agents - reserve);
}

/**
 * Trailing-window campaign stats from the attempt ledger (DB-authoritative):
 *   - dials:      attempts that reached a terminal/answered outcome
 *   - humans:     attempts whose AMD/dial-state classified a live human
 *   - abandoned:  humans dropped because no agent connected in time
 */
export async function loadPredictiveStats(pool, campaignId, windowMinutes) {
  const minutes = Math.max(1, Math.floor(numberOr(windowMinutes, DEFAULT_STATS_WINDOW_MINUTES)));
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE status IN ('answered','completed','failed','cancelled')
       )::int AS dials,
       COUNT(*) FILTER (
         WHERE dial_state IN ('human','connecting','connected','wrapup','disposed','abandoned')
            OR metadata->>'amd_result' IN ('human','human_residence','human_business')
       )::int AS humans,
       COUNT(*) FILTER (
         WHERE dial_state = 'abandoned'
            OR metadata->>'power_connect_state' = 'abandoned'
       )::int AS abandoned
     FROM outbound_attempt_ledger
     WHERE campaign_id = $1
       AND updated_at > NOW() - ($2::text || ' minutes')::interval`,
    [campaignId, String(minutes)],
  );
  const stats = rows?.[0] || {};
  const dials = Math.max(0, Number(stats.dials || 0));
  const humans = Math.max(0, Number(stats.humans || 0));
  const abandoned = Math.max(0, Number(stats.abandoned || 0));
  return {
    dials,
    humans,
    abandoned,
    answerRate: dials > 0 ? humans / dials : 0,
    abandonRate: humans > 0 ? abandoned / humans : 0,
  };
}

/** Queued inbound interactions currently waiting on a queue (blending input). */
export async function countQueuedInbound(pool, queueId) {
  if (!pool || !queueId) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS queued
       FROM cc_interactions
      WHERE queue_id = $1
        AND state = 'queued'
        AND completed_at IS NULL
        AND abandoned_at IS NULL`,
    [queueId],
  );
  return Number(rows?.[0]?.queued || 0);
}

async function countInFlight(pool, campaignId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS in_flight
       FROM outbound_attempt_ledger
      WHERE campaign_id = $1
        AND (
          status IN ('dialing', 'answered')
          OR (
            status = 'claimed'
            AND COALESCE(lease_expires_at, NOW() + INTERVAL '1 second') > NOW() - INTERVAL '5 seconds'
          )
        )`,
    [campaignId],
  );
  return Number(result.rows?.[0]?.in_flight || 0);
}

async function resolveMaxLines(pool, campaign) {
  const concurrency = parseJson(campaign?.concurrency_config, {});
  const campaignLimit = numberOr(concurrency.maxLines ?? concurrency.maxConcurrent, null);
  let globalLimit = 10;
  try {
    const settingsResult = await pool.query(
      `SELECT settings FROM outbound_settings WHERE id='default' LIMIT 1`,
    );
    const settings = parseJson(settingsResult.rows?.[0]?.settings, {});
    globalLimit = numberOr(settings.max_lines ?? settings.maxLines, 10);
  } catch {
    globalLimit = 10;
  }
  if (campaignLimit && globalLimit) return Math.max(1, Math.min(campaignLimit, globalLimit));
  return Math.max(1, campaignLimit || globalLimit || 10);
}

async function ensureRunningRun(pool, campaignId) {
  const { rows } = await pool.query(
    `SELECT * FROM outbound_campaign_runs
      WHERE campaign_id = $1 AND status = 'running'
      ORDER BY started_at DESC
      LIMIT 1`,
    [campaignId],
  );
  if (rows[0]) return rows[0];
  const { startCampaignRun } = await import("./execution.js");
  return startCampaignRun(pool, campaignId, "predictive-pacer");
}

async function loadRunningPredictiveCampaigns(pool) {
  const { rows } = await pool.query(
    `SELECT * FROM outbound_campaigns
      WHERE status = 'running' AND mode = 'predictive'
      ORDER BY created_at ASC`,
  );
  return rows || [];
}

/**
 * Dial new lines for one predictive campaign according to the adaptive
 * budget. Mirrors paceCampaignOnce (WS5) but with controller-derived ratio
 * and blending-adjusted free agents.
 */
export async function pacePredictiveCampaignOnce(pool, campaign) {
  if (!pool || !campaign?.id) return { dialed: 0, budget: 0 };
  const queueId = campaign.handler_type === "queue" ? campaign.handler_ref : null;
  if (!queueId) return { dialed: 0, budget: 0, reason: "missing_queue_target" };

  const config = predictivePacingConfig(campaign);
  const freeAgents = await listFreeAgentsForQueue(pool, queueId);
  const queuedInbound = await countQueuedInbound(pool, queueId);
  const blendedFreeAgents = computeBlendedFreeAgents({
    freeAgents: freeAgents.length,
    queuedInbound,
    inboundReservePercent: config.inboundReservePercent,
  });

  const stats = await loadPredictiveStats(pool, campaign.id, config.statsWindowMinutes);
  const effectiveRatio = computePredictiveRatio({
    answerRate: stats.answerRate,
    abandonRate: stats.abandonRate,
    sampleSize: stats.dials,
    baseRatio: config.baseRatio,
    maxRatio: config.maxRatio,
    abandonTarget: config.abandonTarget,
    minSampleSize: config.minSampleSize,
  });

  const inFlight = await countInFlight(pool, campaign.id);
  const maxLines = await resolveMaxLines(pool, campaign);
  const budget = computePowerDialBudget({
    freeAgents: blendedFreeAgents,
    ratio: effectiveRatio,
    inFlight,
    maxLines,
  });

  const telemetry = {
    campaignId: campaign.id,
    freeAgents: freeAgents.length,
    blendedFreeAgents,
    queuedInbound,
    answerRate: Number(stats.answerRate.toFixed(3)),
    abandonRate: Number(stats.abandonRate.toFixed(3)),
    sampleSize: stats.dials,
    effectiveRatio: Number(effectiveRatio.toFixed(3)),
    inFlight,
    budget,
  };

  if (budget <= 0) return { dialed: 0, ...telemetry };

  const run = await ensureRunningRun(pool, campaign.id);
  const { claimOneAgentlessRecord, executeAgentlessAttempt } = await import("./execution.js");

  let dialed = 0;
  for (let i = 0; i < budget; i += 1) {
    const claim = await claimOneAgentlessRecord(pool, campaign, run?.id || null, {
      attemptReason: "predictive_pacing_claim",
    });
    if (!claim) {
      if (inFlight === 0 && dialed === 0) {
        try {
          const { completeCampaignIfExhausted } = await import("./completion.js");
          await completeCampaignIfExhausted(pool, campaign, "predictive-pacer");
        } catch {
          /* completion is best-effort; next tick retries */
        }
      }
      break;
    }
    const execution = await executeAgentlessAttempt(pool, campaign, claim);
    if (execution?.ok) dialed += 1;
  }

  if (dialed > 0) {
    runnerLogger.info("predictive_pacing_dialed", { ...telemetry, dialed });
  }
  return { dialed, ...telemetry };
}

/** One full predictive tick across all running predictive campaigns. */
export async function runPredictivePacingTick(pool) {
  if (!isPredictivePacingEnabled() || !pool) return { campaigns: 0 };
  const campaigns = await loadRunningPredictiveCampaigns(pool);
  for (const campaign of campaigns) {
    try {
      // Human connect retry/abandon reuses the WS5 primitive (same dial-state
      // machine, same reservation/bridge path).
      await reconnectOrAbandonPendingHumans(pool, campaign);
      await pacePredictiveCampaignOnce(pool, campaign);
    } catch (err) {
      runnerLogger.error("predictive_pacing_tick_failed", {
        campaignId: campaign.id,
        ...outboundErrorPayload(err),
      });
    }
  }
  return { campaigns: campaigns.length };
}

/**
 * Leader-only loop. Started from the WS3 coordinator leader loop next to the
 * Power pacer. No-op unless OUTBOUND_PREDICTIVE_PACING=true.
 */
export async function startPredictivePacingLoop({ signal } = {}) {
  if (!isPredictivePacingEnabled()) return false;
  if (runtime.started) return true;
  runtime.started = true;
  runtime.stopRequested = false;

  const { getPostgresPool } = await import("../postgres.mjs");

  runtime.loopPromise = (async () => {
    while (!runtime.stopRequested && !(signal && signal.aborted)) {
      try {
        const pool = getPostgresPool();
        if (pool) await runPredictivePacingTick(pool);
      } catch (err) {
        runnerLogger.error("predictive_pacing_loop_error", outboundErrorPayload(err));
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, TICK_INTERVAL_MS);
        if (typeof timer.unref === "function") timer.unref();
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }
      });
    }
    runtime.started = false;
  })();

  runnerLogger.info("predictive_pacing_started", {});
  return true;
}

export async function stopPredictivePacingLoop() {
  runtime.stopRequested = true;
  if (runtime.loopPromise) {
    await runtime.loopPromise.catch(() => {});
    runtime.loopPromise = null;
  }
  runtime.started = false;
}

export function isPredictivePacingStarted() {
  return runtime.started;
}
