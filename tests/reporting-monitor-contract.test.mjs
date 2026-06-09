import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const monitorPage = readFileSync("app/(portal)/supervisor/monitor/page.jsx", "utf8");
const menuConfig = readFileSync("config/menu.jsx", "utf8");
const historyRoute = readFileSync("app/api/contact-center/interactions/history/route.js", "utf8");
const callHistoryView = readFileSync("components/contact-center/SupervisorCallHistoryView.jsx", "utf8");
const monitorSectionNav = readFileSync("components/contact-center/MonitorSectionNav.jsx", "utf8");
const callHistoryDetailPage = readFileSync("app/(portal)/supervisor/call-history/[id]/page.jsx", "utf8");

test("supervisor monitor rail exposes call history alongside dashboard, agents, queues, and statistics", () => {
  const expectedLabels = ["Dashboard", "Agents", "Queues", "Statistics", "Call History"];
  for (const label of expectedLabels) {
    assert.match(monitorSectionNav, new RegExp(`label: [\\"']${label}[\\"']`));
  }
  assert.match(monitorSectionNav, /id: ["']call-history["']/);
  assert.match(monitorPage, /MONITOR_RAIL_ITEMS/);
  assert.match(monitorPage, /from ["']@\/components\/contact-center\/MonitorSectionNav["']/);
  assert.match(monitorPage, /<SupervisorCallHistoryView\s+embedded/);
});

test("call history sub-pages keep the monitor section rail visible", () => {
  // Standalone call history list keeps the left rail
  assert.match(callHistoryView, /<MonitorSectionRailNav activeId=["']call-history["']/);
  // Interaction detail page keeps the left rail
  assert.match(callHistoryDetailPage, /<MonitorSectionRailNav activeId=["']call-history["']/);
  // Rail navigation persists the chosen section and routes back to the monitor
  assert.match(monitorSectionNav, /persistMonitorSection\(sectionId\)/);
  assert.match(monitorSectionNav, /router\.push\(`\/supervisor\/monitor\?section=\$\{encodeURIComponent\(sectionId\)\}`\)/);
  // Both consumers share one storage key so monitor restores the chosen section
  assert.match(monitorSectionNav, /MONITOR_ACTIVE_SECTION_STORAGE_KEY\s*=\s*["']supervisor\.monitor\.activeSection["']/);
  assert.match(monitorPage, /activeSection: MONITOR_ACTIVE_SECTION_STORAGE_KEY/);
});

test("sidebar keeps the main Supervisor group and uses one Monitoring entry", () => {
  assert.match(menuConfig, /label: ["']SUPERVISOR["']/);
  assert.match(menuConfig, /title: ["']Monitoring["']/);
  assert.doesNotMatch(menuConfig, /title: ["']Reporting["']/);
  assert.doesNotMatch(menuConfig, /label: ["']REPORTING["']/);
  assert.doesNotMatch(menuConfig, /title: ["']Call History["']/);
});

test("dashboard uses standard cards and today-only realtime aggregate tiles", () => {
  assert.match(monitorPage, /Today realtime command center/);
  assert.match(monitorPage, /<div className="rounded-2xl border border-border\/70 bg-card p-4 shadow-sm dark:bg-zinc-950\/70">[\s\S]*Today realtime command center/);
  assert.doesNotMatch(monitorPage, /<div className="rounded-3xl border bg-background\/85 p-5 shadow-sm">[\s\S]*Today realtime command center/);
  assert.match(monitorPage, /Realtime signal/);
  assert.match(monitorPage, /Today SLA/);
  assert.match(monitorPage, /Live queue pressure/);
  assert.match(monitorPage, /Today answer rate/);
  assert.match(monitorPage, /function MonitorDashboardView\(\{ overall, agents, queues, timestamp \}\)/);
  assert.match(monitorPage, /<MonitorDashboardView overall=\{overall\} agents=\{allAgents\} queues=\{queues\} timestamp=\{data\?\.timestamp\} \/>/);
  assert.match(monitorPage, /function MiniSignalTile\(\{ label, value, detail \}\)[\s\S]*rounded-2xl border bg-card\/70 p-4/);
  assert.doesNotMatch(monitorPage, /function MiniSignalTile[\s\S]*const tones = \{/);
  assert.doesNotMatch(monitorPage, /<MiniSignalTile[^\n]+tone=/);
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

test("statistics view keeps date controls inside the first command card before metric tiles", () => {
  for (const label of ["1 day", "7 days", "30 days", "Custom range"]) {
    assert.match(monitorPage, new RegExp(`>${label}<`));
  }
  assert.match(monitorPage, /setQuickStatisticsRange\(1\)/);
  assert.match(monitorPage, /setQuickStatisticsRange\(7\)/);
  assert.match(monitorPage, /setQuickStatisticsRange\(30\)/);
  assert.match(monitorPage, /type="datetime-local"/);
  assert.match(monitorPage, /statistics-command-card-controls/);
  assert.match(monitorPage, /statistics-command-card-controls[\s\S]*<OverviewMetricCard icon=\{IconPhoneIncoming\} label="Total calls"/);
  assert.doesNotMatch(monitorPage, /statistics-header-controls/);
  assert.doesNotMatch(monitorPage, /range\.toUpperCase\(\)/);
  assert.doesNotMatch(monitorPage, /Reporting statistics/);
  assert.match(monitorPage, /<OverviewMetricCard icon=\{IconPhoneIncoming\} label="Total calls"/);
  assert.match(monitorPage, /<OverviewMetricCard icon=\{IconCheck\} label="Answered"/);
  assert.doesNotMatch(monitorPage, /<MiniSignalTile label="Total calls"/);
  assert.match(monitorPage, /summary=true/);
  assert.match(historyRoute, /summary=true/);
});

test("call history keeps date controls inside the first command card before metric tiles", () => {
  assert.match(callHistoryView, /call-history-command-card-controls/);
  assert.match(callHistoryView, /call-history-command-card-controls[\s\S]*<HistoryMetricCard icon=\{IconPhoneIncoming\} label="Interactions"/);
  assert.doesNotMatch(callHistoryView, /call-history-header-controls/);
  assert.match(callHistoryView, />Custom range</);
  assert.match(callHistoryView, /historyRange === "custom"/);
  assert.match(callHistoryView, /Call history command center/);
  assert.match(callHistoryView, /dark:bg-zinc-950\/70/);
  assert.match(callHistoryView, /HistoryMetricCard/);
  assert.match(callHistoryView, /function HistoryMetricCard[\s\S]*<Card className="overflow-hidden border bg-background\/85 shadow-sm transition hover:-translate-y-0\.5 hover:border-foreground\/20 hover:shadow-md">/);
  assert.doesNotMatch(callHistoryView, /bg-background\/80 p-4 shadow-sm dark:bg-zinc-900\/70/);
  assert.match(callHistoryView, /label="Interactions"/);
  assert.match(callHistoryView, /label="Completed"/);
  assert.match(callHistoryView, /label="Missed"/);
  assert.match(callHistoryView, /label="Recordings"/);
  assert.doesNotMatch(callHistoryView, /10 visible rows/);
  assert.doesNotMatch(callHistoryView, /<CardContent className="flex-1 min-h-0 space-y-6 overflow-y-auto py-6">/);
});

test("reporting tabs do not render duplicate top title headers above first cards", () => {
  assert.doesNotMatch(monitorPage, /<CardTitle className="flex items-center gap-2">\s*<IconActivity className="size-5" \/>\s*\{activeSection\.label\}/);
  assert.doesNotMatch(monitorPage, /<CardTitle className="flex items-center gap-2">[\s\S]*?Agents[\s\S]*?<\/CardTitle>/);
  assert.doesNotMatch(monitorPage, /<CardTitle className="flex items-center gap-2">[\s\S]*?Queues[\s\S]*?<\/CardTitle>/);
  assert.doesNotMatch(monitorPage, /<CardTitle className="flex items-center gap-2">[\s\S]*?Statistics[\s\S]*?<\/CardTitle>/);
  assert.doesNotMatch(callHistoryView, /<CardTitle className="flex items-center gap-2">[\s\S]*?Call History[\s\S]*?<\/CardTitle>/);
  assert.doesNotMatch(monitorPage, /visible of \{allAgents\.length\} agents/);
  assert.doesNotMatch(monitorPage, /queue pressure<\/Badge>/);
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
