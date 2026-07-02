import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dashboard = readFileSync("components/contact-center/AgentDashboard.jsx", "utf8");
const statsRoute = readFileSync("app/api/dashboard/stats/route.js", "utf8");

test("agent dashboard uses the analytics workspace design language", () => {
  assert.match(dashboard, /OverviewMetricCard/);
  assert.match(dashboard, /MiniSignalTile/);
  assert.match(dashboard, /GraphCard/);
  assert.match(dashboard, /function ChartTooltip/);
  assert.match(dashboard, /dark:bg-zinc-950\/70/);
  assert.match(dashboard, /My performance/);
  assert.match(dashboard, /agent-dashboard-controls/);
  // Old design artifacts must be gone
  assert.doesNotMatch(dashboard, /MutationObserver/);
  assert.doesNotMatch(dashboard, /vs yesterday/);
  assert.doesNotMatch(dashboard, /text-3xl font-bold tracking-tight">Dashboard/);
});

test("agent dashboard shows personal work summary tiles", () => {
  assert.match(dashboard, /Calls handled/);
  assert.match(dashboard, /Completion rate/);
  assert.match(dashboard, /Avg handle time/);
  assert.match(dashboard, /Talk time/);
  assert.match(dashboard, /label="Occupancy"/);
  assert.match(dashboard, /label="Holds"/);
  assert.match(dashboard, /label="Transfers"/);
  assert.match(dashboard, /label="Break time"/);
  assert.match(dashboard, /My wrap-up codes/);
  assert.match(dashboard, /statusBadgeClass\(metrics\.status\)/);
});

test("agent dashboard keeps period switching and refresh", () => {
  for (const id of ["today", "7days", "30days"]) {
    assert.match(dashboard, new RegExp(`id: ["']${id}["']`));
  }
  assert.match(dashboard, /\/api\/dashboard\/stats\?period=/);
  assert.match(dashboard, /IconRefresh/);
});

test("dashboard stats API returns extended personal metrics", () => {
  assert.match(statsRoute, /hold_count/);
  assert.match(statsRoute, /hold_duration_seconds/);
  assert.match(statsRoute, /transfer_count/);
  assert.match(statsRoute, /longest_handle_seconds/);
  assert.match(statsRoute, /cc_user_time_tracking/);
  assert.match(statsRoute, /occupancyPct/);
  assert.match(statsRoute, /wrapupDistribution/);
  assert.match(statsRoute, /jsonb_array_elements_text\(COALESCE\(i\.wrapup_codes/);
  // Personal endpoint stays scoped to the authenticated agent
  assert.match(statsRoute, /agent_username = \$1/);
  assert.match(statsRoute, /getServerSession/);
});
