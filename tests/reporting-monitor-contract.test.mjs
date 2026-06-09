import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const monitorPage = readFileSync("app/(portal)/supervisor/monitor/page.jsx", "utf8");
const menuConfig = readFileSync("config/menu.jsx", "utf8");
const historyRoute = readFileSync("app/api/contact-center/interactions/history/route.js", "utf8");
const callHistoryView = readFileSync("components/contact-center/SupervisorCallHistoryView.jsx", "utf8");
const monitorSectionNav = readFileSync("components/contact-center/MonitorSectionNav.jsx", "utf8");
const analyticsSectionNav = readFileSync("components/contact-center/AnalyticsSectionNav.jsx", "utf8");
const callHistoryDetailPage = readFileSync("app/(portal)/supervisor/call-history/[id]/page.jsx", "utf8");

test("supervisor monitor rail exposes dashboard, agents, and queues only", () => {
  const expectedLabels = ["Dashboard", "Agents", "Queues"];
  for (const label of expectedLabels) {
    assert.match(monitorSectionNav, new RegExp(`label: [\\"']${label}[\\"']`));
  }
  // Statistics was consolidated into the dashboard; Call History moved to Analytics.
  assert.doesNotMatch(monitorSectionNav, /label: ["']Statistics["']/);
  assert.doesNotMatch(monitorSectionNav, /label: ["']Call History["']/);
  assert.doesNotMatch(monitorSectionNav, /id: ["']graphs["']/);
  assert.doesNotMatch(monitorSectionNav, /id: ["']call-history["']/);
  assert.match(monitorPage, /MONITOR_RAIL_ITEMS/);
  assert.match(monitorPage, /from ["']@\/components\/contact-center\/MonitorSectionNav["']/);
  assert.doesNotMatch(monitorPage, /SupervisorCallHistoryView/);
  assert.doesNotMatch(monitorPage, /MonitorGraphsView/);
});

test("call history sub-pages keep the analytics section rail visible", () => {
  // Standalone call history list keeps the left rail
  assert.match(callHistoryView, /<AnalyticsSectionRailNav activeId=["']call-history["']/);
  // Interaction detail page keeps the left rail
  assert.match(callHistoryDetailPage, /<AnalyticsSectionRailNav activeId=["']call-history["']/);
  // Rail navigation persists the chosen section and routes back to analytics
  assert.match(analyticsSectionNav, /persistAnalyticsSection\(sectionId\)/);
  assert.match(analyticsSectionNav, /router\.push\(`\/supervisor\/analytics\?section=\$\{encodeURIComponent\(sectionId\)\}`\)/);
  // Both consumers share one storage key so analytics restores the chosen section
  assert.match(analyticsSectionNav, /ANALYTICS_ACTIVE_SECTION_STORAGE_KEY\s*=\s*["']supervisor\.analytics\.activeSection["']/);
});

test("sidebar keeps the main Supervisor group and uses one Monitoring entry", () => {
  assert.match(menuConfig, /label: ["']SUPERVISOR["']/);
  assert.match(menuConfig, /title: ["']Monitoring["']/);
  assert.doesNotMatch(menuConfig, /title: ["']Reporting["']/);
  assert.doesNotMatch(menuConfig, /label: ["']REPORTING["']/);
  assert.doesNotMatch(menuConfig, /title: ["']Call History["']/);
  // Statistics lives inside the dashboard now — no standalone menu entry.
  assert.doesNotMatch(menuConfig, /title: ["']Statistics["']/);
});

test("scheduled events moved from SUPERVISOR to ADMIN group", () => {
  const supervisorGroup = menuConfig.slice(
    menuConfig.indexOf('label: "SUPERVISOR"'),
    menuConfig.indexOf('label: "ADMIN"'),
  );
  const adminGroup = menuConfig.slice(menuConfig.indexOf('label: "ADMIN"'));
  assert.doesNotMatch(supervisorGroup, /Scheduled Events/);
  assert.match(adminGroup, /title: ["']Scheduled Events["'],[\s\S]*?url: ["']\/supervisor\/scheduled-events["'],[\s\S]*?role_access: \["admin", "owner"\]/);
});

test("dashboard consolidates today statistics tiles and live signals", () => {
  assert.match(monitorPage, /Today realtime command center/);
  assert.match(monitorPage, /Contact center today at a glance/);
  // Consolidated Statistics tiles
  assert.match(monitorPage, /<OverviewMetricCard icon=\{IconPhoneIncoming\} label="Total calls"/);
  assert.match(monitorPage, /<OverviewMetricCard icon=\{IconCheck\} label="Answered"/);
  assert.match(monitorPage, /<OverviewMetricCard icon=\{IconAlertCircle\} label="Abandoned"/);
  assert.match(monitorPage, /<OverviewMetricCard icon=\{IconClock\} label="Avg wait"/);
  // Live signal tiles
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

test("dashboard renders today widgets: hourly chart, top performers, wrap-up codes, queues", () => {
  // Today data is fetched from the analytics dashboard-today report
  assert.match(monitorPage, /report["'],?\s*["']dashboard-today["']|dashboard-today/);
  assert.match(monitorPage, /Today call volume by hour/);
  assert.match(monitorPage, /Top performers today/);
  assert.match(monitorPage, /top-performer-row/);
  assert.match(monitorPage, /Top wrap-up codes today/);
  assert.match(monitorPage, /top-wrapup-row/);
  assert.match(monitorPage, /Queues today/);
  // Charts keep the dark tooltip content
  assert.match(monitorPage, /function ChartTooltip/);
  assert.doesNotMatch(monitorPage, /<Tooltip\s*\/>/);
});

test("statistics tab was removed from the monitor", () => {
  assert.doesNotMatch(monitorPage, /Statistics command center/);
  assert.doesNotMatch(monitorPage, /setQuickStatisticsRange/);
  assert.doesNotMatch(monitorPage, /statistics-command-card-controls/);
  assert.doesNotMatch(monitorPage, /activeTab === ["']graphs["']/);
  assert.doesNotMatch(monitorPage, /activeTab === ["']call-history["']/);
  // The history summary endpoint contract remains in place for analytics consumers.
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
