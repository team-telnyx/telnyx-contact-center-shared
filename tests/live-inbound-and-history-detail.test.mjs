import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool, seedAgent, seedQueue } from './helpers/acd-test-db.mjs';
import { readLiveInteractions } from '../lib/acd/live-interactions.mjs';
import { createWorkItem, openSegment, closeOpenSegment } from '../lib/acd/lifecycle.mjs';
import { findInteractionViewByReference, loadAcdHistoryDto } from '../lib/acd/work-item-repository.mjs';
import { loadAcdTimelineProjection, loadAcdInteractionSegments } from '../lib/acd/history-projection.mjs';
import { loadRoute } from './helpers/route-harness.mjs';

const pool = await prepareAcdTestPool('acd_core_test_inbound_history_detail');
after(() => pool.end());
await pool.query(`DROP TABLE IF EXISTS voice_flow_executions;
  CREATE TABLE voice_flow_executions(id TEXT PRIMARY KEY,flow_id TEXT,call_control_id TEXT,variables JSONB,status TEXT,started_at TIMESTAMPTZ,completed_at TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS cc_wrapup_codes(id TEXT PRIMARY KEY,name TEXT,display_order INT);
  CREATE TABLE IF NOT EXISTS app_settings(id TEXT PRIMARY KEY,cc_settings JSONB);`);
const at = seconds => new Date(Date.now() - seconds * 1000).toISOString();
async function flow({ callId = randomUUID(), sessionId = randomUUID(), direction = 'incoming', status = 'active', event = 'call.initiated' } = {}) {
  const id = randomUUID(), startedAt = at(120);
  await pool.query('INSERT INTO voice_flow_executions(id,flow_id,call_control_id,variables,status,started_at) VALUES($1,$2,$3,$4,$5,$6)', [id, 'flow-test', callId, JSON.stringify({ direction, event_type: event, call_session_id: sessionId, from: '+15550100', to: '+15550200' }), status, startedAt]);
  return { id, callId, sessionId, startedAt };
}

test('call.initiated flow execution appears before a queue work item exists', async () => {
  const item = await flow();
  const rows = (await readLiveInteractions(pool)).interactions;
  const row = rows.find(row => row.id === `flow:${item.id}`);
  assert.ok(row); assert.equal(row.state, 'initiated'); assert.equal(row.queueId, null);
  assert.equal(row.fromNumber, '+15550100'); assert.equal(row.callControlId, item.callId);
  assert.equal(row.createdAt.toISOString(), item.startedAt);
  assert.equal(row.sla.state, 'excluded'); assert.equal(row.capabilities.supervision, false);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM acd_work_items')).rows[0].count, 0);
  assert.equal((await readLiveInteractions(pool, { channel: 'email' })).interactions.length, 0);
});

test('enqueue reuses one visible row and preserves initiation age without changing queue SLA', async () => {
  const observed = await flow(); await seedQueue(pool, 'inbound-queue', []);
  const work = await createWorkItem(pool, { channel: 'voice', direction: 'inbound', queueId: 'inbound-queue', providerSessionId: observed.sessionId });
  await pool.query("UPDATE acd_work_items SET state='queued',enqueued_at=now() WHERE id=$1", [work.id]);
  await pool.query("INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,provider_session_id,state) VALUES($1,$2,'customer',$3,$4,'answered')", [randomUUID(),work.id,observed.callId,observed.sessionId]);
  await openSegment(pool, { workItemId: work.id, queueId: 'inbound-queue', kind: 'queue_wait' });
  let rows = (await readLiveInteractions(pool)).interactions;
  assert.equal(rows.filter(row => row.callControlId === observed.callId).length, 1);
  const core = rows.find(row => row.id === work.id);
  assert.equal(core.createdAt.toISOString(), observed.startedAt); assert.equal(core.state, 'queued');
  assert.equal(core.sla.state, 'pending'); assert.ok(Date.parse(core.sla.deadline_at) > Date.now());
  await pool.query("UPDATE acd_work_items SET state='abandoned',terminal_at=now() WHERE id=$1", [work.id]);
  rows = (await readLiveInteractions(pool)).interactions;
  assert.ok(!rows.some(row => row.callControlId === observed.callId), 'Stale flow row cannot resurrect a terminal Core call');
});

test('flow hangup removes pre-queue calls and outbound flow traffic is not duplicated', async () => {
  const incoming = await flow({ event: 'call.answered' });
  const outgoing = await flow({ direction: 'outgoing' });
  let rows = (await readLiveInteractions(pool)).interactions;
  assert.equal(rows.find(row => row.id === `flow:${incoming.id}`).state, 'in_flow');
  assert.ok(!rows.some(row => row.id === `flow:${outgoing.id}`));
  await pool.query("UPDATE voice_flow_executions SET status='completed',completed_at=now() WHERE id=$1", [incoming.id]);
  rows = (await readLiveInteractions(pool)).interactions;
  assert.ok(!rows.some(row => row.id === `flow:${incoming.id}`));
});

await seedAgent(pool, 'history-agent'); await seedQueue(pool, 'history-queue', ['history-agent']);
const detailRoute = await loadRoute('app/api/contact-center/interactions/[id]/route.js', {
  '@/lib/auth-server': { getAuthenticatedUser: async () => ({ id: 'supervisor', roles: ['supervisor'] }) },
  '@/lib/postgres.mjs': { getPostgresPool: () => pool },
  '@/lib/role-utils': { isSupervisorOrAdmin: () => true },
  '@/lib/acd/history-projection.mjs': { loadAcdTimelineProjection, loadAcdInteractionSegments },
  '@/lib/acd/work-item-repository.mjs': { findInteractionViewByReference, loadAcdHistoryDto },
  '@/lib/runtime-logging.mjs': { contactCenterRuntimeLogger: { error(...args) { console.error(...args); } }, runtimePayload: value => value },
});
for (const channel of ['chat','email','voice']) test(`${channel} detail API returns a shared timeline, segment cards and applicable SLA context`, async () => {
  const conversation = channel === 'voice' ? null : randomUUID();
  if (conversation) await pool.query('INSERT INTO acd_conversations(id,channel,customer_name) VALUES($1,$2,$3)', [conversation,channel,'Casey Customer']);
  const work = await createWorkItem(pool, { channel, direction: 'inbound', queueId: 'history-queue', conversationId: conversation, customerAddress: 'casey@example.test', ccAddress: 'support@example.test' });
  await pool.query('UPDATE acd_work_items SET created_at=$2,enqueued_at=$3 WHERE id=$1', [work.id,at(180),at(160)]);
  await openSegment(pool, { workItemId: work.id, kind: 'queue_wait', queueId: 'history-queue', startedAt: at(160) });
  await closeOpenSegment(pool, work.id, { outcome: 'answered', answeredAt: at(150), endedAt: at(150) });
  await openSegment(pool, { workItemId: work.id, kind: 'agent', queueId: 'history-queue', agentId: 'history-agent', startedAt: at(150), answeredAt: at(150) });
  const handlingEndedAt = at(50), wrapupEndedAt = new Date(Date.parse(handlingEndedAt) + 20_000).toISOString();
  await closeOpenSegment(pool, work.id, { outcome: 'completed', endedAt: handlingEndedAt });
  await pool.query("UPDATE acd_segments SET wrapup_ended_at=$2 WHERE work_item_id=$1 AND kind='agent'", [work.id,wrapupEndedAt]);
  await pool.query("UPDATE acd_work_items SET state='completed',terminal_at=$2 WHERE id=$1", [work.id,channel==='voice'?handlingEndedAt:wrapupEndedAt]);
  const response = await detailRoute.GET(new Request('https://cc.example.test'), { params: Promise.resolve({id:work.id}) });
  assert.equal(response.status, 200);
  const record = response.body.interaction;
  assert.equal(record.acd_segments.length, 1); assert.equal(record.acd_segments[0].agent_id, 'history-agent');
  assert.ok(record.routing_metadata.timeline.some(event => event.type === 'enqueued'));
  assert.ok(record.routing_metadata.timeline.some(event => event.type === 'connected'));
  assert.equal(record.routing_metadata.timeline.find(event => event.type === 'disconnected').timestamp, handlingEndedAt);
  assert.equal(record.routing_metadata.timeline.find(event => event.type === 'wrapup_start').timestamp, handlingEndedAt);
  assert.equal(record.routing_metadata.timeline.find(event => event.type === 'wrapup_end').wrapupDurationSeconds, 20);
  assert.equal(record.history.metrics.wrapupSeconds, 20);
  assert.ok(record.sla);
  if (conversation) { assert.equal(record.from_name, 'Casey Customer'); assert.equal(record.conversation_id, conversation); assert.equal(record.routing_metadata.timeline[0].type, 'received'); }
});
