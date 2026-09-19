import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ESLint } from 'eslint';
const read=path=>readFileSync(path,'utf8');
const page=read('app/(portal)/supervisor/analytics/page.jsx'),route=read('app/api/contact-center/analytics/route.js'),rail=read('components/contact-center/AnalyticsSectionNav.jsx');
const reporting=read('lib/acd/interaction-reporting.mjs'),workforce=read('lib/acd/workforce-reports.mjs'),channels=read('lib/acd/interaction-analytics.mjs'),transfers=read('lib/acd/transfer-hold-report.mjs');
test('Analytics sidebar item declares the supervisor.analytics screen',()=>assert.match(read('config/menu.jsx'),/title:\s*"Analytics",[\s\S]*?screen:\s*"supervisor\.analytics"/));
test('analytics rail preserves section IDs while naming the universal archive',()=>{
  for(const id of ['queue-performance','agent-performance','abandonment','agent-adherence','transfers-holds','wrapup-codes','ai-handoffs','outbound-campaigns','skills-gap','call-history'])assert.ok(rail.includes(`id: "${id}"`));
  assert.match(rail,/Interactions History/);assert.match(rail,/Unserved & Abandonment/);
  assert.doesNotMatch(rail,/Call Journeys|label: "Call History"/);
});
test('analytics shares filters and opens specialized report content',()=>{
  assert.match(page,/<SupervisorCallHistoryView embedded/);assert.match(page,/<MultichannelDashboard/);
  assert.match(page,/persistAnalyticsSection\(activeReport\)/);assert.match(page,/\.includes\(activeReport\)/);
  const dashboard=read('components/contact-center/MultichannelDashboard.jsx');
  const details=read('components/contact-center/SupervisorReportContent.jsx');
  assert.match(dashboard, /<SupervisorReportContent report=/);
  for (const heading of ['Arrival heatmap','Agent scorecard','Recovery list','Disposition trend']) assert.ok(details.includes(heading));
});
test('the canonical report uses Core participants and recorded SLA policy evidence',()=>{
  assert.match(reporting,/FROM acd_work_items/);assert.match(reporting,/acd_segments/);assert.match(reporting,/acd_sla_status/);
  assert.doesNotMatch(reporting,/wait.*<=\s*20|agent_username\s*=/);
  assert.match(reporting,/COUNT\(DISTINCT w.id\)/);assert.match(reporting,/slaSummary/);
});
test('all outcomes and chart series follow channel registry and timezone',()=>{
  assert.match(reporting,/RELEASED_CHANNELS/);assert.match(reporting,/state='failed'/);
  assert.match(reporting,/terminal_at AT TIME ZONE/);assert.match(reporting,/terminal_at>=\$1 AND w.terminal_at<\$2/);
});
test('analytics authorization and date validation are centralized',()=>{
  assert.match(route,/withPermission\("reports:read", GET_handler, \{ route:/);
  assert.match(route,/Unknown report/);
  const scope=read('lib/acd/reporting-scope.mjs');assert.match(scope,/366 \* 86400000/);assert.match(scope,/Invalid timezone/);assert.match(scope,/parseChannel/);
  assert.doesNotMatch(reporting,/\$\{queueName\}|\$\{from\}|\$\{to\}/);
});
test('workforce intervals include the ongoing Core state and apply stable personal scope',()=>{
  assert.match(workforce,/cc_agent_status_intervals/);assert.match(workforce,/acd_agent_state/);assert.match(workforce,/effectiveAgentStatusSql/);
  assert.match(workforce,/u.id=\$3/);assert.match(workforce,/activity_type IN \('login', 'logout'\)/);
});
test('outbound remains explicitly voice scoped while handoffs include native chat',()=>{
  assert.match(route,/Outbound campaign analytics apply to Voice/);
  for(const table of ['outbound_campaigns','outbound_campaign_runs','outbound_attempt_ledger'])assert.ok(workforce.includes(table));
  assert.match(channels,/aa_ai_handoff_events/);assert.match(channels,/cc_widget_handoffs/);assert.match(channels,/COUNT\(DISTINCT work_item_id\)/);
});
test('skills supply respects active membership and channel policy',()=>{
  for(const field of ['cc_queue_user_assignments','activated_at','cc_queue_channels','cc_agent_channel_policies','cc_agent_queue_channels','required_skills','qualified_agents'])assert.ok(channels.includes(field));
});
test('transfers use every participant and hold rates use the voice population',()=>{
  assert.match(transfers,/acd_segments/);assert.match(transfers,/hold_started/);assert.match(transfers,/voice_total/);
  assert.match(transfers,/channel !== "voice" \? null/);
});
test('remaining operational reports preserve their charts and explicit applicability',()=>{
  for(const label of ['Status time mix','Recent status transitions','Longest holds','Handoffs per day','Attempt funnel','Best calling hours','Skill supply','Demand vs supply'])assert.ok(page.includes(label),label);
  assert.match(page,/reportError/);assert.match(page,/applicability/);assert.match(page,/AnalyticsReportFilters/);
});

test('analytics render paths do not reference undefined variables or components', async () => {
  const eslint = new ESLint({ overrideConfig: { rules: { 'no-undef': 'error' } } });
  const results = await eslint.lintFiles([
    'app/(portal)/supervisor/analytics/page.jsx',
    'components/contact-center/AnalyticsReportFilters.jsx',
    'components/contact-center/MultichannelDashboard.jsx',
    'components/contact-center/SupervisorReportContent.jsx',
    'components/contact-center/SupervisorCallHistoryView.jsx',
  ]);
  const errors = results.flatMap(result => result.messages
    .filter(message => message.fatal || ['no-undef', 'react/jsx-no-undef'].includes(message.ruleId))
    .map(message => `${result.filePath}:${message.line} ${message.message}`));
  assert.deepEqual(errors, []);
});
