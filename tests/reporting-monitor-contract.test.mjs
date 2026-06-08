import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const monitorPage = readFileSync("app/(portal)/supervisor/monitor/page.jsx", "utf8");
const menuConfig = readFileSync("config/menu.jsx", "utf8");

test("reporting monitor rail exposes call history alongside dashboard, agents, queues, and statistics", () => {
  const expectedLabels = ["Dashboard", "Agents", "Queues", "Statistics", "Call History"];
  for (const label of expectedLabels) {
    assert.match(monitorPage, new RegExp(`label: [\"']${label}[\"']`));
  }
  assert.match(monitorPage, /id: ["']call-history["']/);
  assert.match(monitorPage, /<SupervisorCallHistoryView\s+embedded/);
});

test("sidebar has one Reporting entry instead of a separate Supervisor Call History item", () => {
  assert.match(menuConfig, /label: ["']REPORTING["']/);
  assert.match(menuConfig, /title: ["']Reporting["']/);
  assert.doesNotMatch(menuConfig, /title: ["']Call History["']/);
});

test("statistics charts use real aggregate snapshots with dark tooltip content", () => {
  assert.match(monitorPage, /function ChartTooltip/);
  assert.doesNotMatch(monitorPage, /<Tooltip\s*\/>/);
  assert.doesNotMatch(monitorPage, /Trend visualization scaffold/);
  assert.match(monitorPage, /Queue depth/);
  assert.match(monitorPage, /availableAgents/);
  assert.match(monitorPage, /busyAgents/);
});
