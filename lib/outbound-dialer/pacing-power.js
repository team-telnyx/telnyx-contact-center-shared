/**
 * WS5-T3 — Power mode pacing engine (flag-gated, inert by default).
 *
 * Enabled only when OUTBOUND_POWER_PACING=true. Mounted inside the WS3
 * singleton coordinator leader loop (lib/contact-center/coordinator.js), so
 * exactly one node in the cluster paces power campaigns at any time.
 *
 * Tick (~1s) per running power campaign:
 *   1. freeAgents  = DB-authoritative count of routable agents for the
 *                    campaign's target queue (Available + routable + below
 *                    max_concurrent_calls counting active reservations)
 *   2. linesToDial = max(0, ceil(ratio × freeAgents) − inFlight), capped by
 *                    campaign/global max lines
 *   3. claim eligible contacts (shared WS5-T1 claim primitive, all
 *      suppression/DNC/time-set/attempt-limit checks reused) and originate
 *      with AMD (WS5-T2 execution primitive)
 *   4. connect pending human answers to agents:
 *      reserveAgent(channel='outbound') → transfer to agent WebRTC leg;
 *      overshoot beyond abandonTimeoutSecs → dial_state=abandoned + hangup
 *
 * Safety: this module NEVER touches inbound routing or agentless campaigns.
 * Every entry point no-ops unless the flag is on AND the campaign mode is
 * 'power'. All writes go through existing primitives (attempt ledger CAS
 * dial-state transitions, reservation manager, webhook idempotency).
 */

import { buildTelnyxV2Url } from "../telnyx.js";
import { runnerLogger, outboundErrorPayload } from "./logging.mjs";
import { transitionDialState, DIAL_STATES } from "./dial-state.js";

const TICK_INTERVAL_MS = 1_000;
const DEFAULT_PACING_RATIO = 1;
const DEFAULT_ABANDON_TIMEOUT_SECS = 10;
const DEFAULT_CONNECT_LEASE_MS = 60_000;
const MAX_DIALS_PER_TICK = 10;

const runtime = (globalThis.__outboundPowerPacing ||= {
  started: false,
  stopRequested: false,
  loopPromise: null,
});

export function isPowerPacingEnabled() {
  return String(process.env.OUTBOUND_POWER_PACING || "false").toLowerCase() === "true";
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

/**
 * Pure pacing math (unit-tested):
 * linesToDial = max(0, ceil(ratio × freeAgents) − inFlight),
 * additionally capped so inFlight + linesToDial ≤ maxLines.
 */
export function computePowerDialBudget({ freeAgents, ratio, inFlight, maxLines }) {
  const agents = Math.max(0, Math.floor(Number(freeAgents) || 0));
  const pacingRatio = numberOr(ratio, DEFAULT_PACING_RATIO);
  const dialing = Math.max(0, Math.floor(Number(inFlight) || 0));
  const cap = numberOr(maxLines, Infinity);

  const target = Math.ceil(pacingRatio * agents);
  const budget = Math.max(0, target - dialing);
  const capRemaining = Math.max(0, (Number.isFinite(cap) ? cap : Infinity) - dialing);
  return Math.min(budget, capRemaining, MAX_DIALS_PER_TICK);
}

export function powerPacingConfig(campaign = {}) {
  const pacing = parseJson(campaign.pacing_config, {});
  return {
    ratio: numberOr(pacing.ratio, DEFAULT_PACING_RATIO),
    abandonTimeoutSecs: numberOr(
      pacing.abandonTimeoutSecs ?? pacing.abandon_timeout_secs,
      DEFAULT_ABANDON_TIMEOUT_SECS,
    ),
  };
}

/**
 * DB-authoritative free agents for a queue: Available + routable + active
 * queue assignment + below max_concurrent_calls (counting unexpired
 * reservations). Sorted longest-available-first (LAA, same as inbound FIFO).
 */
export async function listFreeAgentsForQueue(pool, queueId) {
  if (!pool || !queueId) return [];
  const { rows } = await pool.query(
    `SELECT u.id, u.username, ast.available_since
       FROM users u
       INNER JOIN cc_queue_user_assignments qa
               ON qa.user_id = u.id
              AND qa.queue_id = $1
              AND qa.enabled = true
              AND qa.activated_at IS NOT NULL
              AND qa.deactivated_at IS NULL
       INNER JOIN cc_agent_state ast ON ast.user_id = u.id
      WHERE ast.agent_status = 'Available'
        AND COALESCE(ast.is_available_for_routing, true) = true
        AND COALESCE(u.available_for_routing, true) = true
        AND (
          SELECT COUNT(*)
            FROM cc_agent_reservations r
           WHERE r.agent_id = u.id
             AND r.state IN ('reserved', 'ringing', 'active')
             AND (
               r.state = 'active'
               OR (r.state IN ('reserved', 'ringing') AND r.lease_expires_at > now())
             )
        ) < COALESCE(u.max_concurrent_calls, 1)
      ORDER BY ast.available_since ASC NULLS LAST, u.id ASC`,
    [queueId],
  );
  return rows || [];
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
  return startCampaignRun(pool, campaignId, "power-pacer");
}

async function loadRunningPowerCampaigns(pool) {
  const { rows } = await pool.query(
    `SELECT * FROM outbound_campaigns
      WHERE status = 'running' AND mode = 'power'
      ORDER BY created_at ASC`,
  );
  return rows || [];
}

/**
 * Dial new lines for one power campaign according to the pacing budget.
 */
export async function paceCampaignOnce(pool, campaign) {
  if (!pool || !campaign?.id) return { dialed: 0, budget: 0, freeAgents: 0 };
  const queueId = campaign.handler_type === "queue" ? campaign.handler_ref : null;
  if (!queueId) return { dialed: 0, budget: 0, freeAgents: 0, reason: "missing_queue_target" };

  const freeAgents = await listFreeAgentsForQueue(pool, queueId);
  const inFlight = await countInFlight(pool, campaign.id);
  const maxLines = await resolveMaxLines(pool, campaign);
  const { ratio } = powerPacingConfig(campaign);

  const budget = computePowerDialBudget({
    freeAgents: freeAgents.length,
    ratio,
    inFlight,
    maxLines,
  });
  if (budget <= 0) return { dialed: 0, budget, freeAgents: freeAgents.length, inFlight };

  const run = await ensureRunningRun(pool, campaign.id);
  const { claimOneAgentlessRecord, executeAgentlessAttempt } = await import("./execution.js");

  let dialed = 0;
  for (let i = 0; i < budget; i += 1) {
    const claim = await claimOneAgentlessRecord(pool, campaign, run?.id || null, {
      attemptReason: "power_pacing_claim",
    });
    if (!claim) {
      if (inFlight === 0 && dialed === 0) {
        try {
          const { completeCampaignIfExhausted } = await import("./completion.js");
          await completeCampaignIfExhausted(pool, campaign, "power-pacer");
        } catch {
          /* completion is best-effort; next tick retries */
        }
      }
      break;
    }
    const execution = await executeAgentlessAttempt(pool, campaign, claim);
    if (execution?.ok) dialed += 1;
  }
  return { dialed, budget, freeAgents: freeAgents.length, inFlight };
}

/**
 * WS5-T3 human connect path. Called from the AMD webhook handler when a
 * power campaign call is answered by a human, and re-driven by the pacer
 * tick for pending attempts (overshoot retry → abandon on timeout).
 *
 * Returns null when this attempt is not a power/predictive-campaign human
 * connect (agentless campaigns keep their existing behaviour).
 */
export async function handleHumanAnswerForPowerCampaign(pool, ledger, callControlId) {
  const mode = String(ledger?.mode || "");
  if (mode === "power" && !isPowerPacingEnabled()) return null;
  if (mode === "predictive") {
    // WS6: predictive campaigns share this connect path, gated by their flag.
    const { isPredictivePacingEnabled } = await import("./pacing-predictive.js");
    if (!isPredictivePacingEnabled()) return null;
  }
  if (mode !== "power" && mode !== "predictive") return null;
  if (!pool || !ledger?.id || !callControlId) return null;
  const queueId = ledger.handler_type === "queue" ? ledger.handler_ref : null;
  if (!queueId) return null;

  // Mark the attempt as awaiting an agent (idempotent metadata flag).
  await pool.query(
    `UPDATE outbound_attempt_ledger
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
            updated_at = NOW()
      WHERE id = $2
        AND COALESCE(metadata->>'power_connect_state', 'pending') = 'pending'`,
    [
      JSON.stringify({
        power_connect_state: "pending",
        human_detected_at: new Date().toISOString(),
      }),
      ledger.id,
    ],
  );

  return tryConnectHumanToAgent(pool, {
    ledgerId: ledger.id,
    campaignId: ledger.campaign_id,
    queueId,
    callControlId,
    callSessionId: ledger.call_session_id || null,
    toNumber: parseJson(ledger.metadata, {})?.to_number || null,
  });
}

async function tryConnectHumanToAgent(pool, ctx) {
  const { ledgerId, campaignId, queueId, callControlId, callSessionId, toNumber } = ctx;

  const freeAgents = await listFreeAgentsForQueue(pool, queueId);
  const agent = freeAgents[0] || null;
  if (!agent) {
    return { connected: false, reason: "no_available_agents" };
  }

  const { reserveAgent, promoteReservation, releaseReservation } = await import(
    "../contact-center/reservation-manager.js"
  );
  const reservationId = await reserveAgent(agent.id, {
    pool,
    channel: "outbound",
    attemptId: ledgerId,
    campaignId,
    queueId,
    leaseMs: DEFAULT_CONNECT_LEASE_MS,
  });
  if (!reservationId) {
    return { connected: false, reason: "agent_reservation_failed" };
  }

  // human → connecting (CAS; replay-safe)
  const transition = await transitionDialState(pool, ledgerId, DIAL_STATES.CONNECTING, {
    event: "power_connect",
    reason: `agent:${agent.username}`,
  });
  if (!transition.applied) {
    await releaseReservation(reservationId, { pool });
    return { connected: false, reason: "stale_dial_state" };
  }

  try {
    const { bridgeCallToAgent } = await import("../contact-center/webrtc-bridge.js");
    const bridge = await bridgeCallToAgent(
      callSessionId,
      callControlId,
      agent.username,
      toNumber || undefined,
      null,
    );
    await promoteReservation(reservationId, "ringing", { pool });
    await pool.query(
      `UPDATE outbound_attempt_ledger
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
              updated_at = NOW()
        WHERE id = $2`,
      [
        JSON.stringify({
          power_connect_state: "connecting",
          power_agent_username: agent.username,
          power_reservation_id: reservationId,
          agent_call_control_id: bridge?.agentCallControlId || null,
          power_connected_at: new Date().toISOString(),
        }),
        ledgerId,
      ],
    );
    runnerLogger.info("power_connect_bridged", {
      ledgerId,
      campaignId,
      queueId,
      agentUsername: agent.username,
      reservationId,
    });
    return { connected: true, agentUsername: agent.username, reservationId };
  } catch (err) {
    await releaseReservation(reservationId, { pool });
    // connecting → failed would end the attempt; the human is still on the
    // line, so fall back to human and let the next tick retry/abandon.
    await pool.query(
      `UPDATE outbound_attempt_ledger
          SET dial_state = 'human',
              metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
              updated_at = NOW()
        WHERE id = $2
          AND dial_state = 'connecting'`,
      [
        JSON.stringify({ power_connect_state: "pending", power_last_bridge_error: err?.message || String(err) }),
        ledgerId,
      ],
    );
    runnerLogger.warn("power_connect_bridge_failed", {
      ledgerId,
      campaignId,
      agentUsername: agent.username,
      ...outboundErrorPayload(err),
    });
    return { connected: false, reason: "bridge_failed" };
  }
}

/**
 * Pacer-side retry/abandon for pending human answers.
 * Overshoot: human waiting longer than abandonTimeoutSecs → abandoned.
 */
export async function reconnectOrAbandonPendingHumans(pool, campaign) {
  const queueId = campaign.handler_type === "queue" ? campaign.handler_ref : null;
  if (!queueId) return { reconnected: 0, abandoned: 0 };
  const { abandonTimeoutSecs } = powerPacingConfig(campaign);

  const { rows } = await pool.query(
    `SELECT id, campaign_id, call_control_id, call_session_id, metadata
       FROM outbound_attempt_ledger
      WHERE campaign_id = $1
        AND dial_state = 'human'
        AND status IN ('dialing', 'answered')
        AND metadata->>'power_connect_state' = 'pending'
      ORDER BY updated_at ASC
      LIMIT 10`,
    [campaign.id],
  );

  let reconnected = 0;
  let abandoned = 0;
  for (const attempt of rows || []) {
    const metadata = parseJson(attempt.metadata, {});
    const humanAt = Date.parse(metadata.human_detected_at || "") || Date.now();
    const waitedSecs = (Date.now() - humanAt) / 1000;

    if (waitedSecs > abandonTimeoutSecs) {
      await abandonHumanAttempt(pool, attempt);
      abandoned += 1;
      continue;
    }

    const result = await tryConnectHumanToAgent(pool, {
      ledgerId: attempt.id,
      campaignId: attempt.campaign_id,
      queueId,
      callControlId: attempt.call_control_id || metadata.call_control_id,
      callSessionId: attempt.call_session_id || metadata.call_session_id || null,
      toNumber: metadata.to_number || null,
    });
    if (result?.connected) reconnected += 1;
  }
  return { reconnected, abandoned };
}

async function abandonHumanAttempt(pool, attempt) {
  const callControlId = attempt.call_control_id || parseJson(attempt.metadata, {})?.call_control_id;
  const transition = await transitionDialState(pool, attempt.id, DIAL_STATES.ABANDONED, {
    event: "power_abandon",
    reason: "no_agent_within_threshold",
  });
  if (!transition.applied) return;

  const apiKey = process.env.TELNYX_API_KEY;
  if (apiKey && callControlId) {
    try {
      await fetch(buildTelnyxV2Url(`/calls/${encodeURIComponent(callControlId)}/actions/hangup`), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
    } catch {
      /* hangup webhook still finalizes the attempt */
    }
  }

  const { completeAttemptClaim } = await import("./execution.js");
  await completeAttemptClaim(pool, attempt.id, "completed", {
    reason_code: "abandoned",
    abandoned: true,
    power_connect_state: "abandoned",
    abandoned_at: new Date().toISOString(),
  });
  runnerLogger.warn("power_attempt_abandoned", {
    ledgerId: attempt.id,
    campaignId: attempt.campaign_id,
  });
}

/** One full pacer tick across all running power campaigns. */
export async function runPowerPacingTick(pool) {
  if (!isPowerPacingEnabled() || !pool) return { campaigns: 0 };
  const campaigns = await loadRunningPowerCampaigns(pool);
  for (const campaign of campaigns) {
    try {
      await reconnectOrAbandonPendingHumans(pool, campaign);
      await paceCampaignOnce(pool, campaign);
    } catch (err) {
      runnerLogger.error("power_pacing_tick_failed", {
        campaignId: campaign.id,
        ...outboundErrorPayload(err),
      });
    }
  }
  return { campaigns: campaigns.length };
}

/**
 * Leader-only loop. Started from the WS3 coordinator leader loop; the
 * coordinator's advisory-lock leadership guarantees a single pacer
 * cluster-wide. No-op unless OUTBOUND_POWER_PACING=true.
 */
export async function startPowerPacingLoop({ signal } = {}) {
  if (!isPowerPacingEnabled()) return false;
  if (runtime.started) return true;
  runtime.started = true;
  runtime.stopRequested = false;

  const { getPostgresPool } = await import("../postgres.mjs");

  runtime.loopPromise = (async () => {
    while (!runtime.stopRequested && !(signal && signal.aborted)) {
      try {
        const pool = getPostgresPool();
        if (pool) await runPowerPacingTick(pool);
      } catch (err) {
        runnerLogger.error("power_pacing_loop_error", outboundErrorPayload(err));
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

  runnerLogger.info("power_pacing_started", {});
  return true;
}

export async function stopPowerPacingLoop() {
  runtime.stopRequested = true;
  if (runtime.loopPromise) {
    await runtime.loopPromise.catch(() => {});
    runtime.loopPromise = null;
  }
  runtime.started = false;
}

export function isPowerPacingStarted() {
  return runtime.started;
}
