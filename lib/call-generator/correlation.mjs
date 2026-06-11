// Call Generator — routing correlation & assertions (T5)
//
// Correlates generated calls (cg_call_ledger) with contact-center
// interactions (cc_interactions) via call_session_id, evaluates per-run
// assertions and produces a pass/fail report stored on cg_runs.stats.report.
//
// Supported assertions (per scenario config.assertions):
//   { type: "routed_to_queue", queue: "support" }       — every correlated call hit the queue
//   { type: "answer_within_secs", seconds: 20 }          — answered calls connected fast enough
//   { type: "max_abandon_rate", percent: 5 }             — abandoned share stays under threshold
//   { type: "min_answer_rate", percent: 80 }             — answered share stays above threshold

export function normalizeAssertions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((entry) => {
      const type = String(entry?.type || "").toLowerCase();
      if (type === "routed_to_queue") {
        const queue = String(entry.queue || "").trim();
        return queue ? { type, queue } : null;
      }
      if (type === "answer_within_secs") {
        const seconds = Number(entry.seconds);
        return Number.isFinite(seconds) && seconds > 0 ? { type, seconds: Math.min(600, seconds) } : null;
      }
      if (type === "max_abandon_rate" || type === "min_answer_rate") {
        const percent = Number(entry.percent);
        return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? { type, percent } : null;
      }
      return null;
    })
    .filter(Boolean);
}

// Correlate ledger rows with cc_interactions on call_session_id.
export async function correlateRunCalls(pool, runId) {
  const { rows } = await pool.query(
    `SELECT l.id AS ledger_id, l.call_session_id, l.status AS generator_status,
            l.started_at, l.answered_at, l.ended_at, l.duration_ms,
            i.id AS interaction_id, i.queue_name, i.queue_id, i.agent_username,
            i.state AS interaction_state, i.direction,
            i.enqueued_at, i.assigned_at, i.answered_at AS interaction_answered_at,
            i.completed_at, i.abandoned_at, i.wait_time_seconds, i.talk_time_seconds
     FROM cg_call_ledger l
     LEFT JOIN cc_interactions i ON i.call_session_id = l.call_session_id AND l.call_session_id IS NOT NULL
     WHERE l.run_id = $1
     ORDER BY l.created_at`,
    [runId],
  );
  return rows;
}

export function summarizeCorrelation(rows) {
  const total = rows.length;
  const correlated = rows.filter((r) => r.interaction_id).length;
  const answered = rows.filter((r) => ["answered", "talking", "completed"].includes(r.generator_status) && r.answered_at).length;
  const abandoned = rows.filter((r) => r.generator_status === "abandoned" || r.interaction_state === "abandoned").length;
  const failed = rows.filter((r) => r.generator_status === "failed").length;
  const queues = {};
  for (const row of rows) {
    if (row.queue_name) queues[row.queue_name] = (queues[row.queue_name] || 0) + 1;
  }
  const waitTimes = rows
    .map((r) => (r.wait_time_seconds === null || r.wait_time_seconds === undefined ? NaN : Number(r.wait_time_seconds)))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const avgWaitSecs = waitTimes.length ? Math.round((waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length) * 10) / 10 : null;
  return { total, correlated, answered, abandoned, failed, queues, avgWaitSecs };
}

function answerDelaySecs(row) {
  // Generator-side answer latency: started_at -> answered_at.
  if (!row.started_at || !row.answered_at) return null;
  const delta = (new Date(row.answered_at).getTime() - new Date(row.started_at).getTime()) / 1000;
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

export function evaluateAssertions(rows, assertions) {
  const summary = summarizeCorrelation(rows);
  const results = [];

  for (const assertion of normalizeAssertions(assertions)) {
    if (assertion.type === "routed_to_queue") {
      const correlated = rows.filter((r) => r.interaction_id);
      const matching = correlated.filter((r) => String(r.queue_name || "") === assertion.queue);
      const passed = correlated.length > 0 && matching.length === correlated.length;
      results.push({
        ...assertion,
        passed,
        detail: correlated.length
          ? `${matching.length}/${correlated.length} correlated calls reached queue "${assertion.queue}"`
          : "no correlated interactions found",
      });
      continue;
    }
    if (assertion.type === "answer_within_secs") {
      const delays = rows.map(answerDelaySecs).filter((d) => d !== null);
      const slow = delays.filter((d) => d > assertion.seconds);
      const passed = delays.length > 0 && slow.length === 0;
      results.push({
        ...assertion,
        passed,
        detail: delays.length
          ? `${delays.length - slow.length}/${delays.length} answered within ${assertion.seconds}s (max ${Math.max(...delays).toFixed(1)}s)`
          : "no answered calls to evaluate",
      });
      continue;
    }
    if (assertion.type === "max_abandon_rate") {
      const rate = summary.total ? (summary.abandoned / summary.total) * 100 : 0;
      const passed = rate <= assertion.percent;
      results.push({ ...assertion, passed, detail: `abandon rate ${rate.toFixed(1)}% (limit ${assertion.percent}%)` });
      continue;
    }
    if (assertion.type === "min_answer_rate") {
      const rate = summary.total ? (summary.answered / summary.total) * 100 : 0;
      const passed = rate >= assertion.percent;
      results.push({ ...assertion, passed, detail: `answer rate ${rate.toFixed(1)}% (required ${assertion.percent}%)` });
    }
  }

  return {
    summary,
    assertions: results,
    passed: results.length > 0 ? results.every((r) => r.passed) : null,
  };
}

// Build the full report and persist it on cg_runs.stats.report.
export async function buildRunReport(pool, runId) {
  const { rows: runRows } = await pool.query(
    `SELECT r.*, s.name AS scenario_name, s.config AS scenario_config
     FROM cg_runs r JOIN cg_scenarios s ON s.id = r.scenario_id WHERE r.id = $1`,
    [runId],
  );
  if (!runRows.length) return null;
  const run = runRows[0];
  const rows = await correlateRunCalls(pool, runId);
  const report = evaluateAssertions(rows, run.scenario_config?.assertions);
  const payload = {
    generated_at: new Date().toISOString(),
    scenario_name: run.scenario_name,
    run_status: run.status,
    ...report,
  };
  await pool.query(
    `UPDATE cg_runs SET stats = COALESCE(stats, '{}'::jsonb) || jsonb_build_object('report', $2::jsonb) WHERE id = $1`,
    [runId, JSON.stringify(payload)],
  );
  return { report: payload, calls: rows };
}
