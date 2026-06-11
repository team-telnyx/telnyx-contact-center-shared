import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import {
  normalizeAssertions,
  summarizeCorrelation,
  evaluateAssertions,
} from "../lib/call-generator/correlation.mjs";

const row = (overrides = {}) => ({
  ledger_id: "l1",
  call_session_id: "cs1",
  generator_status: "completed",
  started_at: "2026-06-11T10:00:00Z",
  answered_at: "2026-06-11T10:00:05Z",
  ended_at: "2026-06-11T10:01:00Z",
  duration_ms: 55000,
  interaction_id: "i1",
  queue_name: "support",
  interaction_state: "completed",
  wait_time_seconds: 4,
  ...overrides,
});

describe("call generator correlation (T5)", () => {
  it("normalizes valid assertions and drops garbage", () => {
    const normalized = normalizeAssertions([
      { type: "routed_to_queue", queue: "support" },
      { type: "answer_within_secs", seconds: 20 },
      { type: "max_abandon_rate", percent: 5 },
      { type: "min_answer_rate", percent: 80 },
      { type: "routed_to_queue", queue: "" },
      { type: "answer_within_secs", seconds: -1 },
      { type: "max_abandon_rate", percent: 200 },
      { type: "unknown_assert" },
      null,
    ]);
    assert.strictEqual(normalized.length, 4);
    assert.deepStrictEqual(normalized.map((a) => a.type), [
      "routed_to_queue",
      "answer_within_secs",
      "max_abandon_rate",
      "min_answer_rate",
    ]);
  });

  it("summarizes correlation rows with queue distribution and avg wait", () => {
    const rows = [
      row(),
      row({ ledger_id: "l2", queue_name: "support", wait_time_seconds: 6 }),
      row({ ledger_id: "l3", generator_status: "abandoned", answered_at: null, interaction_id: null, queue_name: null, wait_time_seconds: null }),
      row({ ledger_id: "l4", generator_status: "failed", answered_at: null, interaction_id: null, queue_name: null, wait_time_seconds: null }),
    ];
    const summary = summarizeCorrelation(rows);
    assert.strictEqual(summary.total, 4);
    assert.strictEqual(summary.correlated, 2);
    assert.strictEqual(summary.answered, 2);
    assert.strictEqual(summary.abandoned, 1);
    assert.strictEqual(summary.failed, 1);
    assert.deepStrictEqual(summary.queues, { support: 2 });
    assert.strictEqual(summary.avgWaitSecs, 5);
  });

  it("routed_to_queue passes only when all correlated calls hit the queue", () => {
    const pass = evaluateAssertions([row(), row({ ledger_id: "l2" })], [{ type: "routed_to_queue", queue: "support" }]);
    assert.strictEqual(pass.assertions[0].passed, true);
    const fail = evaluateAssertions(
      [row(), row({ ledger_id: "l2", queue_name: "sales" })],
      [{ type: "routed_to_queue", queue: "support" }],
    );
    assert.strictEqual(fail.assertions[0].passed, false);
    assert.strictEqual(fail.passed, false);
  });

  it("answer_within_secs honours latency threshold", () => {
    const fast = evaluateAssertions([row()], [{ type: "answer_within_secs", seconds: 10 }]);
    assert.strictEqual(fast.assertions[0].passed, true);
    const slow = evaluateAssertions(
      [row({ answered_at: "2026-06-11T10:00:45Z" })],
      [{ type: "answer_within_secs", seconds: 10 }],
    );
    assert.strictEqual(slow.assertions[0].passed, false);
  });

  it("abandon and answer rate assertions evaluate percentages", () => {
    const rows = [row(), row({ ledger_id: "l2" }), row({ ledger_id: "l3", generator_status: "abandoned", answered_at: null })];
    const result = evaluateAssertions(rows, [
      { type: "max_abandon_rate", percent: 50 },
      { type: "min_answer_rate", percent: 50 },
    ]);
    assert.strictEqual(result.assertions[0].passed, true); // 33.3% <= 50%
    assert.strictEqual(result.assertions[1].passed, true); // 66.7% >= 50%
    assert.strictEqual(result.passed, true);

    const strict = evaluateAssertions(rows, [{ type: "max_abandon_rate", percent: 10 }]);
    assert.strictEqual(strict.assertions[0].passed, false);
  });

  it("no assertions yields passed=null (informational report)", () => {
    const result = evaluateAssertions([row()], []);
    assert.strictEqual(result.passed, null);
    assert.deepStrictEqual(result.assertions, []);
  });

  it("report API route builds and persists the report", async () => {
    const code = await readFile(new URL("../app/api/admin/call-generator/runs/[id]/report/route.js", import.meta.url), "utf8");
    assert.match(code, /buildRunReport/);
    assert.match(code, /requireAdmin/);
  });

  it("correlation module persists report on cg_runs.stats and joins cc_interactions", async () => {
    const code = await readFile(new URL("../lib/call-generator/correlation.mjs", import.meta.url), "utf8");
    assert.match(code, /LEFT JOIN cc_interactions i ON i\.call_session_id = l\.call_session_id/);
    assert.match(code, /jsonb_build_object\('report'/);
  });

  it("dashboard exposes Report button and renders assertions panel", async () => {
    const code = await readFile(new URL("../components/contact-center/CallGeneratorDashboardView.jsx", import.meta.url), "utf8");
    assert.match(code, /loadReport\(run\.id\)/);
    assert.match(code, /Run report/);
    assert.match(code, /PASSED/);
    assert.match(code, /No assertions/);
  });

  it("scenario editor captures assertion fields into config.assertions", async () => {
    const code = await readFile(new URL("../components/contact-center/CallGeneratorScenariosView.jsx", import.meta.url), "utf8");
    assert.match(code, /assertionsFromDraft/);
    assert.match(code, /routed_to_queue/);
    assert.match(code, /answer_within_secs/);
    assert.match(code, /max_abandon_rate/);
    assert.match(code, /min_answer_rate/);
  });
});
