import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { resolveInteractionDurationSeconds } from "../lib/contact-center/interaction-duration.mjs";

test("Call History uses the full Core customer span across queue and agent transfers", () => {
  assert.equal(
    resolveInteractionDurationSeconds({
      customer_started_at: "2026-08-04T10:00:00.000Z",
      customer_ended_at: "2026-08-04T10:08:30.000Z",
      handle_time_seconds: 45,
      transfer_count: 3,
      answered_at: "2026-08-04T10:07:45.000Z",
    }),
    510,
  );
});

test("Call History uses the stable work-item start for transferred calls", () => {
  assert.equal(
    resolveInteractionDurationSeconds({
      created_at: "2026-08-04T10:00:00.000Z",
      enqueued_at: "2026-08-04T10:06:00.000Z",
      answered_at: "2026-08-04T10:07:00.000Z",
      completed_at: "2026-08-04T10:08:30.000Z",
      handle_time_seconds: 150,
      transfer_count: 2,
    }),
    510,
  );
});

test("Call History preserves handle time for a non-transferred interaction", () => {
  assert.equal(
    resolveInteractionDurationSeconds({
      created_at: "2026-08-04T10:00:00.000Z",
      completed_at: "2026-08-04T10:08:30.000Z",
      handle_time_seconds: 240,
      transfer_count: 0,
    }),
    240,
  );
});

test("history API and table expose the aggregated interaction duration", async () => {
  const [route, view] = await Promise.all([
    readFile(
      new URL(
        "../app/api/contact-center/interactions/history/route.js",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../components/contact-center/SupervisorCallHistoryView.jsx",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(route, /FROM acd_history_interactions i/);
  assert.match(route, /i\.created_at AS customer_started_at/);
  assert.match(route, /i\.terminal_at AS customer_ended_at/);
  assert.match(route, /interaction_duration_seconds: resolveInteractionDurationSeconds\(row\)/);
  assert.match(view, /item\.interaction_duration_seconds \?\?/);
  assert.match(view, /item\.customer_started_at \|\| \(Number\(item\.transfer_count \|\| 0\) > 0 \? item\.created_at : null\)/);
});
