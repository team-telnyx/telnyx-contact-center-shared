import { agentBridgeEvidence, loadVoiceBridgeTopology } from '../acd/voice-bridge-evidence.mjs';

export function normalizeAssertions(raw) {
  return (Array.isArray(raw) ? raw : []).flatMap((entry) => {
    const type = String(entry?.type || '').toLowerCase();
    if (type === 'routed_to_queue' && String(entry.queue || '').trim()) return [{ type, queue: String(entry.queue).trim() }];
    if (type === 'answer_within_secs' && Number.isFinite(Number(entry.seconds)) && Number(entry.seconds) > 0) return [{ type, seconds: Math.min(600, Number(entry.seconds)) }];
    if (['max_abandon_rate', 'min_answer_rate'].includes(type) && Number.isFinite(Number(entry.percent)) && Number(entry.percent) >= 0 && Number(entry.percent) <= 100) return [{ type, percent: Number(entry.percent) }];
    return [];
  });
}

// Keep one result per attempted call. A missing or ambiguous match never
// disappears from the denominator. From alone is deliberately not a join key.
export async function correlateRunCalls(db, runId) {
  const ledger = (await db.query('SELECT * FROM cg_call_ledger WHERE run_id = $1 ORDER BY created_at, id', [runId])).rows;
  const output = [];
  for (const l of ledger) {
    const candidates = (await db.query(`SELECT DISTINCT
        w.id AS work_item_id, w.state AS work_item_state,
        w.terminal_at, w.terminal_reason, w.enqueued_at AS core_enqueued_at,
        h.id AS interaction_id, h.queue_name, h.queue_id, h.agent_username,
        h.state AS interaction_state, h.direction, h.enqueued_at, h.assigned_at,
        h.answered_at AS interaction_answered_at, h.completed_at, h.abandoned_at,
        h.wait_time_seconds, h.talk_time_seconds
      FROM acd_work_items w
      JOIN acd_history_interactions h ON h.id = w.id
      WHERE (w.attributes->>'call_generator_ledger_id' = $1
        OR ($2::text IS NOT NULL AND EXISTS (
          SELECT 1 FROM acd_legs leg
           WHERE leg.work_item_id = w.id AND leg.provider_session_id = $2
        ))
        OR ($4::text IS NOT NULL AND EXISTS (
          SELECT 1 FROM acd_legs leg
           WHERE leg.work_item_id = w.id AND leg.provider_call_id = $4
        ))
        OR ($5::uuid IS NOT NULL AND w.id = $5::uuid))
        AND w.customer_address = $3`,
    [String(l.id), l.call_session_id, l.from_number, l.result?.inbound_call_control_id || null, l.work_item_id || null])).rows;
    const row = { ...l, ledger_id: l.id, generator_status: l.status, generator_result: l.result,
      correlation: candidates.length === 1 ? 'linked' : candidates.length ? 'ambiguous' : 'missing',
      correlation_count: candidates.length };
    if (candidates.length === 1) {
      Object.assign(row, candidates[0]);
      if (row.work_item_id) {
        const ids = [row.work_item_id];
        row.segments = (await db.query('SELECT * FROM acd_segments WHERE work_item_id = $1 ORDER BY seq', ids)).rows;
        const topology = await loadVoiceBridgeTopology(db, row.work_item_id);
        row.legs = topology.legs;
        row.intents = topology.intents;
        row.reservations = (await db.query('SELECT id,agent_id,state,released_at FROM acd_reservations WHERE work_item_id = $1', ids)).rows;
        const answered = row.segments.find(s => s.kind === 'agent' && s.answered_at && agentBridgeEvidence(row.legs, row.intents, s.agent_id));
        row.agent_answered_at = answered?.answered_at || null;
        row.answered_agent_id = answered?.agent_id || null;
        if (!l.work_item_id) await db.query('UPDATE cg_call_ledger SET work_item_id = $2 WHERE id = $1 AND work_item_id IS NULL', [l.id, row.work_item_id]);
      }
    }
    output.push(row);
  }
  return output;
}

function correlated(row) {
  return !['missing','ambiguous'].includes(row.correlation) && Boolean(row.work_item_id);
}
function answerAt(row) {
  if (!correlated(row)) return null;
  return row.agent_answered_at;
}
export function summarizeCorrelation(rows) {
  const queues = {};
  for (const row of rows) if (correlated(row) && row.queue_name) queues[row.queue_name] = (queues[row.queue_name] || 0) + 1;
  const waits = rows.map(r => r.wait_time_seconds == null ? NaN : Number(r.wait_time_seconds)).filter(n => Number.isFinite(n) && n >= 0);
  return {
    total: rows.length, correlated: rows.filter(correlated).length,
    answered: rows.filter(r => answerAt(r) && Number.isFinite(Date.parse(answerAt(r)))).length,
    abandoned: rows.filter(r => r.generator_status === 'abandoned' || r.interaction_state === 'abandoned' || r.work_item_state === 'abandoned').length,
    failed: rows.filter(r => r.generator_status === 'failed').length, queues,
    avgWaitSecs: waits.length ? Math.round(waits.reduce((a,b) => a+b, 0) / waits.length * 10) / 10 : null,
  };
}
function answerDelaySecs(row) {
  const start = row.core_enqueued_at || row.enqueued_at || row.started_at;
  const end = answerAt(row);
  if (!start || !end) return null;
  const delay = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(delay) && delay >= 0 ? delay : null;
}
export function evaluateAssertions(rows, assertions) {
  const summary = summarizeCorrelation(rows);
  const results = normalizeAssertions(assertions).map(a => {
    let passed = false, detail;
    if (a.type === 'routed_to_queue') {
      const matching = rows.filter(r => correlated(r) && r.queue_name === a.queue).length;
      passed = rows.length > 0 && matching === rows.length;
      detail = `${matching}/${rows.length} attempted calls reached queue "${a.queue}"`;
    } else if (a.type === 'answer_within_secs') {
      const matching = rows.map(answerDelaySecs).filter(n => n !== null && n <= a.seconds).length;
      passed = rows.length > 0 && matching === rows.length;
      detail = `${matching}/${rows.length} calls answered by an agent within ${a.seconds}s`;
    } else {
      const answer = a.type === 'min_answer_rate';
      const rate = rows.length ? 100 * (answer ? summary.answered : summary.abandoned) / rows.length : 0;
      passed = rows.length > 0 && rows.every(correlated) && (answer ? rate >= a.percent : rate <= a.percent);
      detail = `${answer ? 'agent answer' : 'abandon'} rate ${rate.toFixed(1)}% (threshold ${a.percent}%)`;
    }
    return { ...a, passed, detail };
  });
  return { summary, assertions: results, passed: results.length ? results.every(r => r.passed) : null };
}
export async function buildRunReport(pool, runId) {
  const run = (await pool.query(`SELECT r.*, s.name AS scenario_name, s.config AS scenario_config
    FROM cg_runs r JOIN cg_scenarios s ON s.id = r.scenario_id WHERE r.id = $1`, [runId])).rows[0];
  if (!run) return null;
  const rows = await correlateRunCalls(pool, runId);
  const report = { generated_at: new Date().toISOString(), scenario_name: run.scenario_name,
    run_status: run.status, evidence_scope: 'routing_and_agent_answer',
    ...evaluateAssertions(rows, run.config?.scenario_snapshot?.assertions || run.scenario_config?.assertions) };
  await pool.query(`UPDATE cg_runs SET stats = COALESCE(stats, '{}'::jsonb) || jsonb_build_object('report',$2::jsonb) WHERE id = $1`, [runId, JSON.stringify(report)]);
  return { report, calls: rows };
}
