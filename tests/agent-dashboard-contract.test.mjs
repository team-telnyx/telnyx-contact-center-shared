import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const read=path=>readFileSync(path,'utf8');
const dashboard=read('components/contact-center/MultichannelDashboard.jsx');
const route=read('app/api/dashboard/stats/route.js');
test('both personal dashboard entry points use the shared channel reporting view',()=>{
  assert.match(read('components/contact-center/AgentDashboard.jsx'),/MultichannelDashboard personal/);
  assert.match(dashboard,/My performance/);assert.match(dashboard,/AnalyticsReportFilters/);
  assert.doesNotMatch(dashboard,/Calls handled|vs yesterday|label="Occupancy"/);
});
test('personal metrics distinguish customer response, agent response and global capacity',()=>{
  for(const text of ['Customer first response','My first response','Handling elapsed','My workforce time'])assert.ok(dashboard.includes(text),text);
  assert.match(dashboard,/Capacity remains global/);
  assert.match(dashboard,/onOpenInteraction/);
  assert.match(dashboard,/InteractionRecordPreview/);
});
test('dashboard refresh cancels obsolete requests and retains scope in the URL',()=>{
  for(const value of ['1d','7d','30d'])assert.ok(read('components/contact-center/AnalyticsReportFilters.jsx').includes(`["${value}",`));
  assert.match(dashboard,/AbortController/);assert.match(dashboard,/controller.signal.aborted/);
  assert.match(dashboard,/history.replaceState/);assert.match(dashboard,/visibilityState/);
  assert.match(dashboard,/Skeleton/);assert.match(dashboard,/Showing the last successful snapshot/);
});
test('personal endpoint forces stable authenticated agent scope for metrics and evidence',()=>{
  assert.match(route,/scope.agentId\s*=\s*String\(user.id\)/);
  assert.match(route,/readInteractionReport\(db,\s*scope\)/);
  assert.match(route,/readLiveWorkload\(db,\s*scope.agentId\)/);
  assert.match(route,/agentAdherenceReport\(db,\s*scope\)/);
  assert.match(route,/REPEATABLE READ READ ONLY/);
  assert.doesNotMatch(route,/agent_username\s*=|agentId\s*=\s*.*params.get/);
});
