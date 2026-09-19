import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dashboard=readFileSync("components/contact-center/MultichannelDashboard.jsx","utf8");
const monitorPage = readFileSync("app/(portal)/supervisor/monitor/page.jsx", "utf8");
const menuConfig = readFileSync("config/menu.jsx", "utf8");
const historyRoute = readFileSync("app/api/contact-center/interactions/history/route.js", "utf8");
const callHistoryView = readFileSync("components/contact-center/SupervisorCallHistoryView.jsx", "utf8");
const monitorSectionNav = readFileSync("components/contact-center/MonitorSectionNav.jsx", "utf8");
const operationsPanel = readFileSync("components/contact-center/AcdOperationsPanel.jsx", "utf8");
const analyticsSectionNav = readFileSync("components/contact-center/AnalyticsSectionNav.jsx", "utf8");
const callHistoryDetailPage = readFileSync("app/(portal)/supervisor/call-history/[id]/page.jsx", "utf8");

test("supervisor monitor rail exposes operational views including recovery", () => {
  const expectedLabels = ["Dashboard", "Agents", "Queues", "Interactions", "Operations"];
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
  assert.match(monitorPage, /activeTab === ["']operations["']/);
  assert.match(monitorPage, /<AcdOperationsPanel \/>/);
  assert.match(operationsPanel, /MonitoringFilters/);
  assert.match(operationsPanel, /action: ["']recover_voice_capacity["']/);
  assert.match(operationsPanel, /recover\(item\.reservation_id\)/);
  assert.match(operationsPanel, /Check & recover/);
  assert.match(operationsPanel, /Recovery audit note/);
  assert.doesNotMatch(operationsPanel, /Operator reason/);
  assert.doesNotMatch(operationsPanel, /Executions awaiting attention/);
  assert.doesNotMatch(operationsPanel, /Webhook events awaiting attention/);
  assert.doesNotMatch(operationsPanel, /Recent alarms/);
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
  assert.match(adminGroup, /activeUrls: \[[^\]]*["']\/supervisor\/scheduled-events["']/);
  // RBAC Phase 3: the AI Assistants entry is shown to roles granting the AI screens or Scheduled Events.
  assert.match(adminGroup, /screens: \["admin\.ai", "supervisor\.scheduled-events"\]/);
});

test("dashboard shares multichannel statistics and separates live capacity", () => {
  assert.match(monitorPage, /OverviewDashboardView/);
  for (const text of ["Received in range","Closed in range","Waiting now","Handling now","Service level","Workforce capacity"]) assert.ok(dashboard.includes(text));
  assert.doesNotMatch(monitorPage, /function MonitorDashboardView/);
});

test("dashboard renders channel series, queue participation and appropriate evidence", () => {
  assert.match(dashboard, /data.channels.map/);
  assert.match(dashboard, /Closed interactions by channel/);
  assert.match(dashboard, /Queue participation/);
  assert.match(dashboard, /ConversationPreview/);
  assert.match(dashboard, /InteractionRecordPreview/);
});

test("statistics tab was removed from the monitor", () => {
  assert.doesNotMatch(monitorPage, /Statistics command center/);
  assert.doesNotMatch(monitorPage, /setQuickStatisticsRange/);
  assert.doesNotMatch(monitorPage, /statistics-command-card-controls/);
  assert.doesNotMatch(monitorPage, /activeTab === ["']graphs["']/);
  assert.doesNotMatch(monitorPage, /activeTab === ["']call-history["']/);
  // The history summary endpoint contract remains in place for analytics consumers.
  assert.match(historyRoute, /searchParams\.get\("summary"\) === "true"/);
});

test("analytics and history place shared channel/date filters before metric tiles", () => {
  const analytics = readFileSync("app/(portal)/supervisor/analytics/page.jsx", "utf8");
  const toolbar = readFileSync("components/contact-center/AnalyticsReportFilters.jsx", "utf8");
  for (const view of [analytics, dashboard, callHistoryView]) assert.match(view, /<AnalyticsReportFilters/);
  assert.match(callHistoryView, /<AnalyticsReportFilters[\s\S]*<HistoryMetricCard/);
  assert.match(toolbar, /ChannelFilter/);
  assert.match(toolbar, /aria-label="Reporting period"/);
  assert.match(toolbar, /\["custom", "Custom"\]/);
  assert.match(toolbar, /aria-pressed=\{range === value\}/);
  assert.doesNotMatch(toolbar, /<select/);
  assert.doesNotMatch(analytics, /<SupervisorPageHeader|<CommandCard|REPORT_META/);
  assert.doesNotMatch(dashboard, /Interaction intelligence|One view of volume/);
  assert.doesNotMatch(callHistoryView, /Interactions history command center|Interaction archive for the selected range|<SupervisorPageHeader/);
  for (const label of ["Interactions", "Completed", "Unserved", "Evidence"]) assert.ok(callHistoryView.includes(`label="${label}"`));
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
    "Roster coverage",
    "Available now",
    "Assigned interactions",
    "Queue activations",
    "Queues monitored",
    "Waiting interactions",
    "Active interactions",
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
  assert.doesNotMatch(monitorPage, /slice\(0, 10\)/);
  assert.match(monitorPage, /InteractionChannel/);
  assert.match(monitorPage, /InteractionPreviewAction/);
  assert.match(monitorPage, /max-h-\[360px\] overflow-y-auto/);
  assert.match(monitorPage, /Live interactions in this queue/);
  assert.doesNotMatch(monitorPage, /Back<\/Button>/);
  assert.doesNotMatch(monitorPage, / - Calls/);
});
