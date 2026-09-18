// Call Generator — run executor (T3)
//
// Gated by the admin Settings master switch (cg_settings.enabled), same as
// the engine. The runner
// drives queued cg_runs: claims pending ledger rows, paces originates with
// max-concurrency and CPS caps, applies a simple ramp-up profile, reaps
// orphaned calls (watchdog) and trips a circuit breaker on Telnyx 4xx/429.
//
// Preparation is transactional. runtime.mjs executes persisted runs under a
// shared PostgreSQL lock, in the app or in the standalone generator worker.
import {
  isCallGeneratorEnabled,
  requestGeneratorStop,
  resolveDialTarget,
  isPstnTargetAllowed,
} from "./engine.mjs";
import { WORKFLOW_TESTING_ACTION_ID, workflowTestingVoiceFromAction, normalizePersona, normalizeMaxSlotsPerTurn } from "./workflow-testing.mjs";


const activeRunners = new Map(); // Compatibility only; execution is persisted in cg_runs.

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

export function effectiveRunLimits(settings = {}, runConfig = {}, scenarioConfig = {}) {
  const clamp = (value, min, max, fallback) => {
    if (value === null || value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };
  // Run config may only tighten the global caps, never exceed them.
  const globalConcurrent = clamp(settings.max_concurrent_calls, 1, 100, 10);
  const globalCps = clamp(settings.max_cps, 1, 20, 2);
  // Max call duration precedence: explicit run config → per-scenario override
  // (scenarioConfig.maxCallDurationSecs) → global Settings value
  // (cg_settings.max_call_duration_secs) → 120s default. The scenario value can
  // exceed the global default — it is an intentional per-scenario override, not
  // a cap that may only be tightened (Telnyx enforces the real hangup via the
  // Dial time_limit_secs derived from this value).
  const globalMaxDuration = clamp(settings.max_call_duration_secs, 10, 3600, 120);
  const scenarioMaxDuration = clamp(scenarioConfig.maxCallDurationSecs, 10, 3600, globalMaxDuration);
  return {
    maxConcurrent: Math.min(globalConcurrent, clamp(runConfig.maxConcurrent, 1, 100, globalConcurrent)),
    maxCps: Math.min(globalCps, clamp(runConfig.maxCps, 1, 20, globalCps)),
    rampUpSecs: clamp(runConfig.rampUpSecs, 0, 600, 0),
    dialTimeoutSecs: clamp(runConfig.dialTimeoutSecs ?? settings.dial_timeout_secs, 10, 120, 30),
    maxDurationSecs: clamp(runConfig.maxDurationSecs ?? runConfig.postAnswer?.maxDurationSecs, 10, 3600, scenarioMaxDuration),
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

// Normalize the scenario's target list. New model: config.targets[] with
// { flow_id, total_calls, from_numbers[], action_id }. Legacy single-target
// configs (target_type/target/total_calls/from_numbers) are converted to a
// one-element list so older scenarios still run.
export function normalizeTargets(config = {}, fallbackFromNumbers = []) {
  const fallbackNumbers = Array.isArray(fallbackFromNumbers)
    ? fallbackFromNumbers.map((n) => String(n || "").trim()).filter(Boolean)
    : [];
  const rawTargets = Array.isArray(config.targets) ? config.targets : [];
  const targets = rawTargets
    .map((t) => {
      const targetType = String(t?.target_type || "").trim().toLowerCase();
      const rawTarget = String(t?.target || "").trim();
      const target = targetType === "sip" && rawTarget && !rawTarget.toLowerCase().startsWith("sip:")
        ? `sip:${rawTarget}`
        : rawTarget;
      return ({
      flow_id: String(t?.flow_id || "").trim(),
      ...(["pstn", "sip"].includes(targetType) ? { target_type: targetType, target } : {}),
      total_calls: Math.max(1, Math.min(1000, Math.floor(Number(t?.total_calls)) || 1)),
      from_numbers: Array.isArray(t?.from_numbers) ? t.from_numbers.map((n) => String(n || "").trim()).filter(Boolean) : [],
      action_id: t?.workflow_testing === true ? WORKFLOW_TESTING_ACTION_ID : (String(t?.action_id || "").trim() || null),
      action_trigger: String(t?.action_trigger || "call_answer") === "agent_bridge" ? "agent_bridge" : "call_answer",
      workflow_testing: t?.workflow_testing === true,
      workflow_id: String(t?.workflow_id || "").trim() || null,
      workflow_name: String(t?.workflow_name || "").trim() || null,
      transcription_active: t?.transcription_active === true,
      direct_agent_id: String(t?.direct_agent_id || "").trim() || null,
    });})
    .filter((t) => (t.flow_id
      || (t.target_type === "pstn" && /^\+[1-9]\d{6,14}$/.test(t.target))
      || (t.target_type === "sip" && /^sip:[A-Za-z0-9._~+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/i.test(t.target)))
      && t.from_numbers.length > 0);
  if (targets.length) return targets;
  // Legacy fallback
  if (config.target_type === "call_flow" && config.target) {
    const legacyFromNumbers = Array.isArray(config.from_numbers)
      ? config.from_numbers.map((n) => String(n || "").trim()).filter(Boolean)
      : fallbackNumbers;
    return [{
      flow_id: String(config.target).trim(),
      total_calls: Math.max(1, Math.min(1000, Math.floor(Number(config.total_calls)) || 1)),
      from_numbers: legacyFromNumbers,
      action_id: null,
      action_trigger: "call_answer",
    }].filter((t) => (t.flow_id || (t.target_type === "pstn" && /^\+[1-9]\d{6,14}$/.test(t.target))) && t.from_numbers.length > 0);
  }
  return [];
}

// Seed one ledger row per call across all targets. Each row carries its
// target context in result: flow_id, assigned from_number (round-robin
// within the target's number list) and resolved action steps.
export async function seedLedger(pool, run, scenario, fallbackFromNumbers = []) {
  const targets = normalizeTargets(scenario?.config || {}, fallbackFromNumbers);
  if (!targets.length) return 0;

  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM cg_call_ledger WHERE run_id = $1`, [run.id]);
  if ((rows[0]?.count || 0) > 0) {
    const { rows: totalRows } = await pool.query(`SELECT COUNT(*)::int AS count FROM cg_call_ledger WHERE run_id = $1`, [run.id]);
    return totalRows[0]?.count || 0;
  }

  // Resolve action steps once per distinct action_id
  const actionIds = [...new Set(targets.map((t) => t.action_id).filter(Boolean))];
  const stepsByAction = {};
  if (actionIds.length) {
    const { rows: actionRows } = await pool.query(`SELECT id, steps FROM cg_actions WHERE id = ANY($1)`, [actionIds]);
    for (const row of actionRows) stepsByAction[row.id] = Array.isArray(row.steps) ? row.steps : [];
  }

  let seeded = 0;
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
    const steps = target.action_id ? stepsByAction[target.action_id] || [] : [];
    const workflowTestingStep = target.workflow_testing ? steps.find((step) => step?.type === "workflow_testing") : null;
    const workflowTesting = target.workflow_testing ? {
      enabled: true,
      workflow_id: target.workflow_id,
      workflow_name: target.workflow_name,
      voice: workflowTestingStep?.voice || workflowTestingVoiceFromAction({ steps }),
      persona: normalizePersona(workflowTestingStep?.persona),
      max_slots_per_turn: normalizeMaxSlotsPerTurn(workflowTestingStep?.max_slots_per_turn),
      randomize_slots: workflowTestingStep?.randomize_slots === true,
      reply_delay_ms: Math.min(10000, Math.max(0, Math.round(Number(workflowTestingStep?.reply_delay_ms)) || 0)),
      expressive: workflowTestingStep?.expressive === true,
      history: [],
    } : null;
    for (let i = 0; i < target.total_calls; i += 1) {
      const fromNumber = pickFromNumber(target.from_numbers, i); // per-target CLI rotation
      await pool.query(
        `INSERT INTO cg_call_ledger (run_id, status, from_number, result, to_number) VALUES ($1, 'pending', $2, $3, $4)`,
        [run.id, fromNumber, JSON.stringify({ target_index: targetIndex, flow_id: target.flow_id, target_type: target.target_type || "call_flow", target: target.target || target.flow_id, direct_agent_id: target.direct_agent_id, action_steps: target.workflow_testing ? [] : steps, action_trigger: target.action_trigger, ...(workflowTesting ? { workflow_testing: workflowTesting } : {}) }), resolveDialTarget({ target_type: target.target_type || "call_flow", target: target.target || target.flow_id })],
      );
      seeded += 1;
    }
  }
  return seeded;
}

function pickFromNumber(fromNumbers, index) {
  const list = Array.isArray(fromNumbers) ? fromNumbers.filter(Boolean) : [];
  if (!list.length) return null;
  return list[index % list.length]; // round-robin CLI rotation
}

// Request cleanup without turning a missing hangup into a terminal ledger row.
export async function reapOrphans(pool, runId, maxAgeMs = 10 * 60 * 1000) {
  const rows = (await pool.query(`SELECT id FROM cg_call_ledger WHERE run_id=$1
    AND dial_requested_at IS NOT NULL AND media_ended_at IS NULL
    AND COALESCE(started_at,created_at) < now() - make_interval(secs => $2)`, [runId, Math.floor(maxAgeMs/1000)])).rows;
  for (const row of rows) await requestGeneratorStop(pool, row.id, "orphan_deadline");
  return rows.length;
}

export async function startRunLoop(pool, runId) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cg-prepare-${runId}`]);
    const result = await prepareRun(tx, runId);
    await tx.query("COMMIT");
    return result;
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}
async function prepareRun(pool, runId) {
  if (!(await isCallGeneratorEnabled(pool))) return { ok: false, reason: "call_generator_disabled" };
  if (activeRunners.has(String(runId))) return { ok: false, reason: "already_running" };

  const { rows: runRows } = await pool.query(
    `SELECT r.*, s.config AS scenario_config, s.name AS scenario_name
     FROM cg_runs r JOIN cg_scenarios s ON s.id = r.scenario_id WHERE r.id = $1`,
    [runId],
  );
  if (!runRows.length) return { ok: false, reason: "run_not_found" };
  const run = runRows[0];
  if (run.status !== "pending") return { ok: true, runId, existing: true };
  const scenario = { config: run.scenario_config || {}, name: run.scenario_name };
  const settings = await loadGeneratorSettings(pool);
  if (settings.enabled !== true) return { ok: false, reason: "generator_disabled_in_settings" };

  const settingsFromNumbers = Array.isArray(settings.from_numbers) ? settings.from_numbers : [];
  const targets = normalizeTargets(scenario.config || {}, settingsFromNumbers);
  if (!targets.length) {
    await pool.query(`UPDATE cg_runs SET status = 'failed', stopped_at = NOW(), stats = COALESCE(stats, '{}'::jsonb) || '{"error":"no_valid_targets"}' WHERE id = $1`, [runId]);
    return { ok: false, reason: "no_valid_targets" };
  }
  const workflowTestingWithoutTranscription = targets.find((t) => t.workflow_testing && t.transcription_active !== true);
  if (workflowTestingWithoutTranscription) {
    await pool.query(`UPDATE cg_runs SET status = 'failed', stopped_at = NOW(), stats = COALESCE(stats, '{}'::jsonb) || '{"error":"workflow_testing_transcription_required"}' WHERE id = $1`, [runId]);
    return { ok: false, reason: "workflow_testing_transcription_required" };
  }
  const missingWorkflowTarget = targets.find((t) => t.workflow_testing && !t.workflow_id);
  if (missingWorkflowTarget) {
    await pool.query(`UPDATE cg_runs SET status = 'failed', stopped_at = NOW(), stats = COALESCE(stats, '{}'::jsonb) || '{"error":"workflow_testing_workflow_required"}' WHERE id = $1`, [runId]);
    return { ok: false, reason: "workflow_testing_workflow_required" };
  }
  const missingActionTarget = targets.find((t) => !t.action_id);
  if (missingActionTarget) {
    await pool.query(`UPDATE cg_runs SET status = 'failed', stopped_at = NOW(), stats = COALESCE(stats, '{}'::jsonb) || '{"error":"missing_action_sequence"}' WHERE id = $1`, [runId]);
    return { ok: false, reason: "missing_action_sequence" };
  }
  const actionIds = [...new Set(targets.map((t) => t.action_id).filter(Boolean))];
  const { rows: actionRows } = await pool.query(`SELECT id, steps FROM cg_actions WHERE id = ANY($1)`, [actionIds]);
  const validActionIds = new Set(actionRows.filter((row) => Array.isArray(row.steps) && row.steps.length > 0).map((row) => row.id));
  const unresolvedActionTarget = targets.find((t) => !validActionIds.has(t.action_id));
  if (unresolvedActionTarget) {
    await pool.query(`UPDATE cg_runs SET status = 'failed', stopped_at = NOW(), stats = COALESCE(stats, '{}'::jsonb) || '{"error":"invalid_action_sequence"}' WHERE id = $1`, [runId]);
    return { ok: false, reason: "invalid_action_sequence" };
  }
  const invalidNumbers = targets.flatMap((t) => t.from_numbers).filter((n) => !settingsFromNumbers.includes(n));
  if (invalidNumbers.length) {
    await pool.query(`UPDATE cg_runs SET status = 'failed', stopped_at = NOW(), stats = COALESCE(stats, '{}'::jsonb) || '{"error":"from_numbers_not_enabled"}' WHERE id = $1`, [runId]);
    return { ok: false, reason: "from_numbers_not_enabled" };
  }

  const allowedPstn = (settings.pstn_whitelist || []).map(n => String(n).replace(/\D/g, ''));
  if (targets.some(t => t.target_type === 'pstn' && !isPstnTargetAllowed(t.target, allowedPstn))) return { ok: false, reason: 'pstn_not_whitelisted' };
  const limits = effectiveRunLimits(settings, run.config || {}, scenario.config || {});
  if (targets.reduce((sum,t) => sum+t.total_calls,0) > 1000) return { ok: false, reason: 'too_many_calls' };
  await seedLedger(pool, run, scenario, settingsFromNumbers);
  await pool.query(`UPDATE cg_runs SET status='running',started_at=COALESCE(started_at,now()),
    config = config || $2::jsonb WHERE id=$1`, [runId, JSON.stringify({ runtime: limits, scenario_snapshot: scenario.config })]);
  return { ok: true, runId, limits };
}
