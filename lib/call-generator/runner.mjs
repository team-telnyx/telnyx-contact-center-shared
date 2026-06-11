// Call Generator — run executor (T3)
//
// Flag-gated by CALL_GENERATOR=true (same flag as the engine). The runner
// drives queued cg_runs: claims pending ledger rows, paces originates with
// max-concurrency and CPS caps, applies a simple ramp-up profile, reaps
// orphaned calls (watchdog) and trips a circuit breaker on Telnyx 4xx/429.
//
// Single-process by design: runs are started from an admin API call and the
// loop lives in the Node process that accepted the request. Cluster-wide
// singleton execution can later be delegated to the WS3 coordinator the same
// way the outbound pacers are mounted.
import {
  isCallGeneratorEnabled,
  originateGeneratedCall,
  hangupGeneratedCall,
  markLedgerStatus,
} from "./engine.mjs";
import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

const cgLogger = createDiagnosticLogger("contact-center.call-generator");

const activeRunners = new Map(); // runId -> { stop: () => void }

export function isRunActive(runId) {
  return activeRunners.has(String(runId));
}

export function stopRunLoop(runId) {
  const entry = activeRunners.get(String(runId));
  if (entry) entry.stop();
  return Boolean(entry);
}

export async function loadGeneratorSettings(pool) {
  try {
    const { rows } = await pool.query(`SELECT settings FROM cg_settings WHERE id = 'default' LIMIT 1`);
    return rows[0]?.settings && typeof rows[0].settings === "object" ? rows[0].settings : {};
  } catch {
    return {};
  }
}

export function effectiveRunLimits(settings = {}, runConfig = {}) {
  const clamp = (value, min, max, fallback) => {
    if (value === null || value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };
  // Run config may only tighten the global caps, never exceed them.
  const globalConcurrent = clamp(settings.max_concurrent_calls, 1, 100, 10);
  const globalCps = clamp(settings.max_cps, 1, 20, 2);
  return {
    maxConcurrent: Math.min(globalConcurrent, clamp(runConfig.maxConcurrent, 1, 100, globalConcurrent)),
    maxCps: Math.min(globalCps, clamp(runConfig.maxCps, 1, 20, globalCps)),
    rampUpSecs: clamp(runConfig.rampUpSecs, 0, 600, 0),
    dialTimeoutSecs: clamp(runConfig.dialTimeoutSecs ?? settings.dial_timeout_secs, 10, 120, 30),
    maxDurationSecs: clamp(runConfig.maxDurationSecs ?? settings.max_call_duration_secs, 10, 3600, 120),
  };
}

// Ramp profile: linear growth of allowed concurrency over rampUpSecs.
export function rampedConcurrency(maxConcurrent, rampUpSecs, elapsedMs) {
  if (!rampUpSecs || rampUpSecs <= 0) return maxConcurrent;
  const fraction = Math.min(1, Math.max(0, (elapsedMs / 1000) / rampUpSecs));
  return Math.max(1, Math.floor(maxConcurrent * fraction));
}

// Circuit breaker: trips after `threshold` consecutive Telnyx failures,
// holds for `cooldownMs`, then allows a probe.
export function createCircuitBreaker({ threshold = 5, cooldownMs = 30000 } = {}) {
  let consecutiveFailures = 0;
  let openedAt = null;
  return {
    recordSuccess() { consecutiveFailures = 0; openedAt = null; },
    recordFailure() {
      consecutiveFailures += 1;
      if (consecutiveFailures >= threshold && !openedAt) openedAt = Date.now();
    },
    isOpen() {
      if (!openedAt) return false;
      if (Date.now() - openedAt >= cooldownMs) {
        // half-open probe: allow one attempt
        openedAt = null;
        consecutiveFailures = Math.max(0, threshold - 1);
        return false;
      }
      return true;
    },
    state() { return { consecutiveFailures, open: Boolean(openedAt) }; },
  };
}

async function seedLedger(pool, run, scenario) {
  const total = Math.max(1, Math.min(1000, Number(scenario?.config?.total_calls) || 1));
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM cg_call_ledger WHERE run_id = $1`, [run.id]);
  const existing = rows[0]?.count || 0;
  for (let i = existing; i < total; i += 1) {
    await pool.query(
      `INSERT INTO cg_call_ledger (run_id, status) VALUES ($1, 'pending')`,
      [run.id],
    );
  }
  return total;
}

function pickFromNumber(fromNumbers, index) {
  const list = Array.isArray(fromNumbers) ? fromNumbers.filter(Boolean) : [];
  if (!list.length) return null;
  return list[index % list.length]; // round-robin CLI rotation
}

// Watchdog: any non-final ledger row not updated within maxAgeMs gets a
// best-effort hangup and is marked failed (orphan_reaped).
export async function reapOrphans(pool, runId, maxAgeMs = 10 * 60 * 1000) {
  const { rows } = await pool.query(
    `SELECT id, call_control_id FROM cg_call_ledger
     WHERE run_id = $1
       AND status IN ('dialing','ringing','answered','talking')
       AND COALESCE(started_at, created_at) < NOW() - make_interval(secs => $2)`,
    [runId, Math.floor(maxAgeMs / 1000)],
  );
  let reaped = 0;
  for (const row of rows) {
    if (row.call_control_id) await hangupGeneratedCall(row.call_control_id);
    const moved = await markLedgerStatus(pool, row.id, "failed", { reason: "orphan_reaped" });
    if (moved) reaped += 1;
  }
  return reaped;
}

export async function startRunLoop(pool, runId) {
  if (!isCallGeneratorEnabled()) return { ok: false, reason: "call_generator_disabled" };
  if (activeRunners.has(String(runId))) return { ok: false, reason: "already_running" };

  const { rows: runRows } = await pool.query(
    `SELECT r.*, s.config AS scenario_config, s.name AS scenario_name
     FROM cg_runs r JOIN cg_scenarios s ON s.id = r.scenario_id WHERE r.id = $1`,
    [runId],
  );
  if (!runRows.length) return { ok: false, reason: "run_not_found" };
  const run = runRows[0];
  const scenario = { config: run.scenario_config || {}, name: run.scenario_name };
  const settings = await loadGeneratorSettings(pool);
  if (settings.enabled !== true) return { ok: false, reason: "generator_disabled_in_settings" };

  const settingsFromNumbers = Array.isArray(settings.from_numbers) ? settings.from_numbers : [];
  const scenarioFromNumbers = Array.isArray(scenario.config.from_numbers) ? scenario.config.from_numbers : [];
  const fromNumbers = scenarioFromNumbers.length
    ? scenarioFromNumbers.filter((number) => settingsFromNumbers.includes(number))
    : settingsFromNumbers;
  if (!fromNumbers.length) {
    await pool.query(`UPDATE cg_runs SET status = 'failed', stopped_at = NOW(), stats = stats || '{"error":"no_from_numbers"}' WHERE id = $1`, [runId]);
    return { ok: false, reason: "no_from_numbers" };
  }

  const limits = effectiveRunLimits(settings, run.config || {});
  const breaker = createCircuitBreaker({});
  const startedAt = Date.now();
  let stopped = false;
  let dialedCount = 0;

  await seedLedger(pool, run, scenario);
  await pool.query(`UPDATE cg_runs SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = $1`, [runId]);

  const stop = () => { stopped = true; };
  activeRunners.set(String(runId), { stop });

  cgLogger.info("cg_run_loop_started", { runId, maxConcurrent: limits.maxConcurrent, maxCps: limits.maxCps });

  const tick = async () => {
    if (stopped) return finish("stopped");
    try {
      const { rows: statusRows } = await pool.query(`SELECT status FROM cg_runs WHERE id = $1`, [runId]);
      const runStatus = statusRows[0]?.status;
      if (runStatus !== "running") return finish(runStatus || "stopped");

      if (breaker.isOpen()) {
        cgLogger.warn("cg_circuit_open", { runId });
        return schedule();
      }

      const { rows: counts } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('dialing','ringing','answered','talking'))::int AS in_flight,
           COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
         FROM cg_call_ledger WHERE run_id = $1`,
        [runId],
      );
      const inFlight = counts[0]?.in_flight || 0;
      const pending = counts[0]?.pending || 0;

      if (pending === 0 && inFlight === 0) return finish("completed");

      const allowedConcurrent = rampedConcurrency(limits.maxConcurrent, limits.rampUpSecs, Date.now() - startedAt);
      const budget = Math.min(Math.max(0, allowedConcurrent - inFlight), limits.maxCps, pending);

      for (let i = 0; i < budget; i += 1) {
        if (stopped) break;
        const { rows: claimRows } = await pool.query(
          `UPDATE cg_call_ledger SET status = 'pending'
           WHERE id = (SELECT id FROM cg_call_ledger WHERE run_id = $1 AND status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING *`,
          [runId],
        );
        const ledgerRow = claimRows[0];
        if (!ledgerRow) break;
        const fromNumber = pickFromNumber(fromNumbers, dialedCount);
        dialedCount += 1;
        const result = await originateGeneratedCall(pool, {
          run: { ...run, config: { ...(run.config || {}), dialTimeoutSecs: limits.dialTimeoutSecs, postAnswer: { ...(run.config?.postAnswer || {}), maxDurationSecs: limits.maxDurationSecs }, pstnWhitelist: settings.pstn_whitelist || [] } },
          ledgerRow,
          task: { target_type: scenario.config.target_type, target: scenario.config.target },
          fromNumber,
        });
        if (result.ok) breaker.recordSuccess();
        else if (["telnyx_dial_failed", "telnyx_request_error"].includes(result.reason)) breaker.recordFailure();
      }

      await reapOrphans(pool, runId, (limits.maxDurationSecs + 300) * 1000);
      return schedule();
    } catch (err) {
      cgLogger.error("cg_run_loop_error", { runId, error: err?.message || String(err) });
      return schedule();
    }
  };

  const schedule = () => {
    if (stopped) return finish("stopped");
    setTimeout(tick, 1000);
  };

  const finish = async (finalStatus) => {
    activeRunners.delete(String(runId));
    try {
      const terminal = finalStatus === "completed" ? "completed" : "stopped";
      await pool.query(
        `UPDATE cg_runs SET status = CASE WHEN status = 'running' THEN $2 ELSE status END, stopped_at = COALESCE(stopped_at, NOW()) WHERE id = $1`,
        [runId, terminal],
      );
      const { rows: statRows } = await pool.query(
        `SELECT status, COUNT(*)::int AS count FROM cg_call_ledger WHERE run_id = $1 GROUP BY status`,
        [runId],
      );
      const stats = Object.fromEntries(statRows.map((r) => [r.status, r.count]));
      await pool.query(`UPDATE cg_runs SET stats = $2 WHERE id = $1`, [runId, JSON.stringify(stats)]);
      cgLogger.info("cg_run_loop_finished", { runId, finalStatus, stats });
    } catch (err) {
      cgLogger.error("cg_run_finish_error", { runId, error: err?.message || String(err) });
    }
  };

  schedule();
  return { ok: true, runId, limits };
}
