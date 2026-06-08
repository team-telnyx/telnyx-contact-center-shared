import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const monitorPage = readFileSync("app/(portal)/supervisor/monitor/page.jsx", "utf8");
const menuConfig = readFileSync("config/menu.jsx", "utf8");
const historyRoute = readFileSync("app/api/contact-center/interactions/history/route.js", "utf8");

test("supervisor monitor rail exposes call history alongside dashboard, agents, queues, and statistics", () => {
  const expectedLabels = ["Dashboard", "Agents", "Queues", "Statistics", "Call History"];
  for (const label of expectedLabels) {
    assert.match(monitorPage, new RegExp(`label: [\\"']${label}[\\"']`));
  }
  assert.match(monitorPage, /id: ["']call-history["']/);
  assert.match(monitorPage, /<SupervisorCallHistoryView\s+embedded/);
});

test("sidebar keeps the main Supervisor group and uses one Reporting entry", () => {
  assert.match(menuConfig, /label: ["']SUPERVISOR["']/);
  assert.match(menuConfig, /title: ["']Reporting["']/);
  assert.doesNotMatch(menuConfig, /label: ["']REPORTING["']/);
  assert.doesNotMatch(menuConfig, /title: ["']Call History["']/);
});

test("dashboard uses standard cards and today-only realtime aggregate tiles", () => {
  assert.match(monitorPage, /Today realtime command center/);
  assert.match(monitorPage, /Realtime signal/);
  assert.match(monitorPage, /Today SLA/);
  assert.match(monitorPage, /Live queue pressure/);
  assert.match(monitorPage, /Today answer rate/);
  assert.doesNotMatch(monitorPage, /bg-gradient-to-br from-slate-950 to-zinc-900 text-white/);
});

test("statistics charts use real aggregate snapshots with dark tooltip content", () => {
  assert.match(monitorPage, /function ChartTooltip/);
  assert.doesNotMatch(monitorPage, /<Tooltip\s*\/>/);
  assert.doesNotMatch(monitorPage, /Trend visualization scaffold/);
  assert.match(monitorPage, /Queue depth/);
  assert.match(monitorPage, /availableAgents/);
  assert.match(monitorPage, /busyAgents/);
});

test("statistics view supports predefined and custom date ranges like Call History", () => {
  for (const label of ["1 day", "7 days", "30 days", "Custom range"]) {
    assert.match(monitorPage, new RegExp(`>${label}<`));
  }
  assert.match(monitorPage, /setQuickStatisticsRange\(1\)/);
  assert.match(monitorPage, /setQuickStatisticsRange\(7\)/);
  assert.match(monitorPage, /setQuickStatisticsRange\(30\)/);
  assert.match(monitorPage, /type="datetime-local"/);
  assert.match(monitorPage, /summary=true/);
  assert.match(historyRoute, /summary=true/);
});

test("agents and queues views use dark-theme card dashboards with top metric tiles", () => {
  for (const label of [
    "Agent operations",
    "Roster coverage",
    "Available now",
    "Live conversations",
    "Queue activations",
    "Queue command center",
    "Queues monitored",
    "Waiting callers",
    "Active calls",
    "Service level",
  ]) {
    assert.match(monitorPage, new RegExp(label));
  }
  assert.match(monitorPage, /dark:bg-zinc-950\/70/);
  assert.match(monitorPage, /filteredAgentMetrics/);
  assert.match(monitorPage, /queueViewMetrics/);
  assert.match(monitorPage, /queue-pressure-card/);
});

test("queues view expands one queue row and embeds a scroll-limited calls list", () => {
  assert.match(monitorPage, /expandedQueueId/);
  assert.match(monitorPage, /setExpandedQueueId\(queueId\)/);
  assert.match(monitorPage, /queueCallsMap/);
  assert.match(monitorPage, /slice\(0, 10\)/);
  assert.match(monitorPage, /max-h-\[360px\] overflow-y-auto/);
  assert.match(monitorPage, /Recent calls in this queue/);
  assert.doesNotMatch(monitorPage, /Back<\/Button>/);
  assert.doesNotMatch(monitorPage, / - Calls/);
});
