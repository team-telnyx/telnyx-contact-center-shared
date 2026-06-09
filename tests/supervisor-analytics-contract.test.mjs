import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const analyticsPage = readFileSync("app/(portal)/supervisor/analytics/page.jsx", "utf8");
const analyticsRoute = readFileSync("app/api/contact-center/analytics/route.js", "utf8");
const analyticsSectionNav = readFileSync("components/contact-center/AnalyticsSectionNav.jsx", "utf8");
const menuConfig = readFileSync("config/menu.jsx", "utf8");

test("sidebar exposes Analytics under SUPERVISOR for supervisor/admin/owner", () => {
  assert.match(
    menuConfig,
    /title:\s*"Analytics",[\s\S]*?url:\s*"\/supervisor\/analytics",[\s\S]*?role_access:\s*\["supervisor", "admin", "owner"\]/,
    "Analytics menu entry should exist with supervisor/admin/owner access",
  );
});

test("analytics rail exposes the launch reports plus call history", () => {
  const expectedLabels = [
    "Queue Performance",
    "Agent Scorecard",
    "Abandonment",
    "Adherence",
    "Transfers & Holds",
    "Wrap-up Codes",
    "AI Handoffs",
    "Outbound",
    "Skills Gap",
    "Call History",
  ];
  for (const label of expectedLabels) {
    assert.match(analyticsSectionNav, new RegExp(`label: ["']${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`));
  }
  for (const id of [
    "queue-performance",
    "agent-performance",
    "abandonment",
    "agent-adherence",
    "transfers-holds",
    "wrapup-codes",
    "ai-handoffs",
    "outbound-campaigns",
    "skills-gap",
    "call-history",
  ]) {
    assert.match(analyticsSectionNav, new RegExp(`id: ["']${id}["']`));
  }
  // Call Journeys duplicated Call History and was removed.
  assert.doesNotMatch(analyticsSectionNav, /Call Journeys/);
  assert.doesNotMatch(analyticsSectionNav, /cradle-to-grave/);
  assert.match(analyticsPage, /SectionRail items=\{ANALYTICS_RAIL_ITEMS\}/);
  assert.match(analyticsSectionNav, /ANALYTICS_ACTIVE_SECTION_STORAGE_KEY\s*=\s*["']supervisor\.analytics\.activeSection["']/, "Analytics should persist the selected report with a scoped storage key");
});

test("analytics embeds call history and honors the section query param", () => {
  assert.match(analyticsPage, /activeReport === ["']call-history["'] \? \(\s*<SupervisorCallHistoryView embedded \/>/);
  assert.match(analyticsPage, /new URLSearchParams\(window\.location\.search\)\.get\(["']section["']\)/);
  assert.match(analyticsPage, /persistAnalyticsSection\(activeReport\)/);
  // Call history loads its own data; the analytics fetch is skipped for it.
  assert.match(analyticsPage, /if \(activeReport === ["']call-history["']\) \{/);
});

test("final analytics reports query the right sources", () => {
  // Outbound campaigns
  assert.match(analyticsRoute, /outbound_campaigns/);
  assert.match(analyticsRoute, /outbound_campaign_runs/);
  assert.match(analyticsRoute, /outbound_attempt_ledger/);
  assert.match(analyticsRoute, /failure_reason/);
  // Skills gap
  assert.match(analyticsRoute, /FROM skills s/);
  assert.match(analyticsRoute, /jsonb_each_text\(COALESCE\(i\.required_skills/);
  assert.match(analyticsRoute, /skill_requirements/);
  assert.match(analyticsRoute, /qualified_agents/);
  // Cradle-to-grave report was removed together with the Call Journeys view.
  assert.doesNotMatch(analyticsRoute, /cradle-to-grave/);
  assert.doesNotMatch(analyticsRoute, /cradleToGraveReport/);
});

test("dashboard-today report aggregates the current day for the supervisor dashboard", () => {
  assert.match(analyticsRoute, /"dashboard-today"/);
  assert.match(analyticsRoute, /async function dashboardTodayReport/);
  assert.match(analyticsRoute, /dashboardTodayReport\(pool, \{ from, to, queueName \}\)/);
  // Headline volumes + hourly trend + top agents + top wrap-up codes + queues
  assert.match(analyticsRoute, /topAgents:/);
  assert.match(analyticsRoute, /topWrapupCodes:/);
  assert.match(analyticsRoute, /hourly:/);
  assert.match(analyticsRoute, /EXTRACT\(HOUR FROM COALESCE\(i\.completed_at, i\.abandoned_at, i\.created_at\)\)/);
});

test("final analytics views render their headline content", () => {
  // Outbound
  assert.match(analyticsPage, /Attempt funnel/);
  assert.match(analyticsPage, /Best calling hours/);
  assert.match(analyticsPage, /Campaign effectiveness/);
  assert.match(analyticsPage, /Failure reasons/);
  assert.match(analyticsPage, /Recent runs/);
  // Skills gap
  assert.match(analyticsPage, /Skill supply/);
  assert.match(analyticsPage, /Demand vs supply/);
  assert.match(analyticsPage, /Queue skill requirements/);
  assert.match(analyticsPage, /Uncovered/);
  // Call Journeys view was removed in favor of the embedded Call History.
  assert.doesNotMatch(analyticsPage, /CradleToGraveView/);
  assert.doesNotMatch(analyticsPage, /JOURNEY_EVENT_TONES/);
});

test("analytics page follows the Monitoring workspace design", () => {
  assert.match(analyticsPage, /SupervisorPageShell/);
  assert.match(analyticsPage, /SupervisorPageHeader/);
  assert.match(analyticsPage, /SECTION_RAIL_PAGE_GRID_CLASS/);
  assert.match(analyticsPage, /OverviewMetricCard/);
  assert.match(analyticsPage, /function ChartTooltip/);
  assert.doesNotMatch(analyticsPage, /<Tooltip\s*\/>/);
  assert.match(analyticsPage, /dark:bg-zinc-950\/70/);
  assert.match(analyticsPage, /analytics-command-card-controls/);
  for (const label of ["1 day", "7 days", "30 days", "Custom range"]) {
    assert.match(analyticsPage, new RegExp(`>${label}<`));
  }
  assert.match(analyticsPage, /type="datetime-local"/);
});

test("analytics reports render their headline content", () => {
  // Queue performance
  assert.match(analyticsPage, /Calls offered/);
  assert.match(analyticsPage, /Service level \(/);
  assert.match(analyticsPage, /Volume heatmap/);
  assert.match(analyticsPage, /VolumeHeatmap/);
  // Agent scorecard
  assert.match(analyticsPage, /Top agents by handled calls/);
  assert.match(analyticsPage, /Transfer rate/);
  assert.match(analyticsPage, /Occupancy/);
  // Abandonment
  assert.match(analyticsPage, /Wait time before abandoning/);
  assert.match(analyticsPage, /Callback list/);
  assert.match(analyticsPage, /supervisor\/call-history\/\$\{row\.id\}/);
});

test("analytics API guards access and bounds the query range", () => {
  assert.match(analyticsRoute, /getAuthenticatedUser/);
  assert.match(analyticsRoute, /isSupervisorOrAdmin/);
  assert.match(analyticsRoute, /status: 401/);
  assert.match(analyticsRoute, /status: 403/);
  assert.match(analyticsRoute, /MAX_RANGE_DAYS = 92/);
  assert.match(analyticsRoute, /clampDateRange/);
  for (const report of [
    "queue-performance",
    "agent-performance",
    "abandonment",
    "agent-adherence",
    "transfers-holds",
    "wrapup-codes",
    "ai-handoffs",
    "dashboard-today",
  ]) {
    assert.match(analyticsRoute, new RegExp(`"${report}"`));
  }
  assert.match(analyticsRoute, /Unknown report/);
});

test("new analytics reports query the right sources", () => {
  // Adherence
  assert.match(analyticsRoute, /cc_user_activity_log/);
  assert.match(analyticsRoute, /cc_agent_status_history/);
  assert.match(analyticsRoute, /activity_type = 'status_change'/);
  // Transfers & holds
  assert.match(analyticsRoute, /hold_duration_seconds/);
  assert.match(analyticsRoute, /transfer_count/);
  // Wrap-up codes
  assert.match(analyticsRoute, /jsonb_array_elements_text\(COALESCE\(i\.wrapup_codes/);
  assert.match(analyticsRoute, /cc_wrapup_codes/);
  // AI handoffs
  assert.match(analyticsRoute, /aa_ai_handoff_events/);
  assert.match(analyticsRoute, /ai_call_control_id/);
});

test("new analytics views render their headline content", () => {
  // Adherence
  assert.match(analyticsPage, /Status time mix/);
  assert.match(analyticsPage, /Recent status transitions/);
  assert.match(analyticsPage, /Agent adherence summary/);
  // Transfers & holds
  assert.match(analyticsPage, /Transfer and hold pressure by queue/);
  assert.match(analyticsPage, /Longest holds/);
  // Wrap-up codes
  assert.match(analyticsPage, /Disposition mix/);
  assert.match(analyticsPage, /Disposition trend/);
  assert.match(analyticsPage, /Dispositions by queue/);
  // AI handoffs
  assert.match(analyticsPage, /Handoffs per day/);
  assert.match(analyticsPage, /Handoff destinations/);
  assert.match(analyticsPage, /Recent handoff events/);
});

test("analytics API computes reports from cc_interactions with transfer-leg hygiene", () => {
  assert.match(analyticsRoute, /is_transfer_leg/);
  assert.match(analyticsRoute, /is_consult_call/);
  assert.match(analyticsRoute, /cc_user_time_tracking/);
  assert.match(analyticsRoute, /answered_within_sla/);
  assert.match(analyticsRoute, /EXTRACT\(ISODOW FROM/);
  assert.match(analyticsRoute, /state = 'abandoned'/);
  // Parameterized filters only — no string interpolation of user input values
  assert.doesNotMatch(analyticsRoute, /\$\{queueName\}/);
  assert.doesNotMatch(analyticsRoute, /\$\{from\}/);
  assert.doesNotMatch(analyticsRoute, /\$\{to\}/);
});
