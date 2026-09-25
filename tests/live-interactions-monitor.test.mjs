import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool, seedAgent, seedQueue } from './helpers/acd-test-db.mjs';
import { createWorkItem, openSegment, closeOpenSegment } from '../lib/acd/lifecycle.mjs';
import { recordSlaService, saveSlaPolicies } from '../lib/acd/sla.mjs';
import { readMonitorStatistics } from '../lib/acd/monitor-statistics.mjs';
import { getAcdRealtimeQueueCalls, getAcdRealtimeAgentCalls } from '../lib/acd/realtime-queue-calls.mjs';
import { readLiveInteractions } from '../lib/acd/live-interactions.mjs';
import { realtimeDurations } from '../lib/acd/realtime-display.mjs';

const pool = await prepareAcdTestPool('acd_core_test_live_interactions_monitor');
after(() => pool.end());
await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;
  CREATE TABLE IF NOT EXISTS app_settings(id TEXT PRIMARY KEY,cc_settings JSONB,updated_by TEXT,updated_at TIMESTAMPTZ);
  DELETE FROM app_settings;`);
const policy = { enabled: true, thresholdSeconds: 60, targetPercentage: 90, warningPercentage: 80, clock: '24x7' };
await saveSlaPolicies(pool, { revision: 0, policies: { voice: policy, chat: policy, email: policy }, actor: 'test' });
const at = seconds => new Date(Date.now() - seconds * 1000).toISOString();
async function work(channel, queueId, age = 0) {
  const conversationId = channel !== 'voice' ? randomUUID() : null;
  if (conversationId) await pool.query('INSERT INTO acd_conversations(id,channel) VALUES($1,$2)', [conversationId, channel]);
  const row = await createWorkItem(pool, { channel, direction: 'inbound', queueId, conversationId, customerAddress: 'Customer', ccAddress: 'Support' });
  await pool.query("UPDATE acd_work_items SET state='queued',created_at=$2,enqueued_at=$2 WHERE id=$1", [row.id, at(age)]);
  return row;
}

test('queued voice has SLA without supervision and answer freezes the measurement in agent view', async () => {
  await seedAgent(pool, 'answer-agent'); await seedQueue(pool, 'sla-answer', ['answer-agent']);
  const row = await work('voice', 'sla-answer', 30);
  await openSegment(pool, { workItemId: row.id, kind: 'queue_wait', queueId: 'sla-answer', startedAt: at(30) });
  const queued = (await getAcdRealtimeQueueCalls(pool, 'sla-answer'))[0];
  assert.equal(queued.sla.state, 'pending'); assert.equal(queued.capabilities.supervision, false);
  await closeOpenSegment(pool, row.id, { outcome: 'answered', answeredAt: at(20), endedAt: at(20) });
  await openSegment(pool, { workItemId: row.id, kind: 'agent', agentId: 'answer-agent', queueId: 'sla-answer', startedAt: at(20), answeredAt: at(20) });
  await pool.query("UPDATE acd_work_items SET state='active' WHERE id=$1", [row.id]);
  const active = (await getAcdRealtimeAgentCalls(pool, 'answer-agent'))[0];
  assert.equal(active.sla.state, 'met'); assert.ok(active.waitSeconds >= 9 && active.waitSeconds <= 11);
  assert.ok(active.handlingSeconds >= 19);
  await saveSlaPolicies(pool, { queueId: 'sla-answer', revision: 0, policies: { voice: { mode: 'override', policy: { ...policy, thresholdSeconds: 1 } } }, actor: 'test' });
  assert.equal((await getAcdRealtimeQueueCalls(pool, 'sla-answer'))[0].sla.state, 'met');
});

test('a new queue visit never displays the previous visit SLA', async () => {
  await seedQueue(pool, 'sla-transfer', []);
  const row = await work('voice', 'sla-transfer', 50);
  await openSegment(pool, { workItemId: row.id, kind: 'queue_wait', queueId: 'sla-transfer', startedAt: at(50) });
  await closeOpenSegment(pool, row.id, { outcome: 'answered', answeredAt: at(40), endedAt: at(40) });
  // Simulate a visit written before SLA instrumentation. No historical rule may
  // be invented and the met result from the previous visit must not leak in.
  await pool.query("INSERT INTO acd_segments(id,work_item_id,seq,kind,queue_id,started_at) VALUES($1,$2,2,'queue_wait','sla-transfer',now())", [randomUUID(), row.id]);
  assert.equal((await getAcdRealtimeQueueCalls(pool, 'sla-transfer'))[0].sla, null);
});

test('mixed-channel service levels use evaluated measurements; pending and missing stay separate', async () => {
  // Keep relative two-minute fixtures inside today's cohort at every UTC hour.
  // Calendar/DST boundaries are covered separately; this test measures aggregation.
  const offset = new Date().getUTCHours() - 12;
  const timezone = `Etc/GMT${offset >= 0 ? '+' : ''}${offset}`;
  await seedQueue(pool, 'mixed-sla', []);
  const voice = await work('voice', 'mixed-sla', 120);
  await openSegment(pool, { workItemId: voice.id, kind: 'queue_wait', queueId: 'mixed-sla', startedAt: at(120) });
  await closeOpenSegment(pool, voice.id, { outcome: 'answered', answeredAt: at(90), endedAt: at(90) });
  await pool.query("UPDATE acd_work_items SET state='active' WHERE id=$1", [voice.id]);
  const email = await work('email', 'mixed-sla', 120);
  await pool.query("UPDATE acd_sla_measurements SET started_at=$2,deadline_at=$3 WHERE work_item_id=$1", [email.id, at(120), at(60)]);
  await recordSlaService(pool, { workItemId: email.id, serviceEvent: 'human_send_accepted', occurredAt: at(30), evidenceId: 'accepted' });
  await work('chat', 'mixed-sla', 30);
  const unknown = await work('voice', 'mixed-sla', 30);
  await pool.query("INSERT INTO acd_segments(id,work_item_id,seq,kind,queue_id,started_at) VALUES($1,$2,1,'queue_wait','mixed-sla',$3)", [randomUUID(), unknown.id, at(30)]);
  const result = await readMonitorStatistics(pool, { timezone });
  const queue = result.queues.find(row => row.queueId === 'mixed-sla');
  assert.equal(queue.sla.rate, 50); assert.equal(queue.sla.denominator, 2);
  assert.equal(queue.sla.pending, 1); assert.equal(queue.sla.unavailable, 1);
  assert.equal(queue.realtime.waitingCalls, 3); assert.equal(queue.realtime.activeCalls, 1);
  assert.ok(queue.realtime.avgWaitSeconds >= 59 && queue.realtime.avgWaitSeconds < 63);
  const filtered = await readMonitorStatistics(pool, { channel: 'chat', timezone });
  const chat = filtered.queues.find(row => row.queueId === 'mixed-sla');
  assert.equal(chat.sla.rate, null); assert.equal(chat.sla.denominator, 0); assert.equal(chat.realtime.waitingCalls, 1);
});

test('all-live view includes manual and open work, deduplicates consultation transport, removes ended legs and filters channels', async () => {
  await seedAgent(pool, 'consultant');
  await seedAgent(pool, 'manual-originator');
  const manual = await createWorkItem(pool, { channel: 'voice', direction: 'outbound', customerAddress: '+15550100', ccAddress: '+15550200', attributes: { voice_occupancy_kind: 'manual_outbound' } });
  await pool.query("UPDATE acd_work_items SET created_at=$2 WHERE id=$1", [manual.id, at(3600)]);
  await pool.query("INSERT INTO acd_reservations(id,agent_id,work_item_id,channel,weight,state,lease_expires_at) VALUES($1,'manual-originator',$2,'voice',1,'reserved',now()+interval '1 minute')", [randomUUID(), manual.id]);
  const saga = randomUUID(), target = randomUUID(), transport = randomUUID();
  await pool.query("INSERT INTO acd_sagas(id,type,work_item_id,conflict_key,step,deadline_at,data) VALUES($1,'consult_transfer',$2,'consult','dial_target',now(),$3)", [saga, manual.id, JSON.stringify({ target: '+15550300', targetAgentId: 'consultant' })]);
  await pool.query("INSERT INTO acd_legs(id,work_item_id,role,owner_saga_id,state,created_at) VALUES($1,$3,'consult_target',$4,'ringing',$5),($2,$3,'consult_transport',$4,'answered',$5)", [target, transport, manual.id, saga, at(25)]);
  const result = await readLiveInteractions(pool);
  assert.equal(result.interactions[0].id, manual.id);
  assert.equal(result.interactions[0].sla.state, 'excluded');
  assert.equal(result.interactions[0].agentUserId, 'manual-originator');
  assert.equal(result.interactions[0].state, 'open');
  const children = result.interactions.filter(row => row.parentInteractionId === manual.id);
  assert.equal(children.length, 1); assert.equal(children[0].legId, target);
  assert.equal(children[0].toNumber, '+15550300'); assert.equal(children[0].agentUserId, 'consultant');
  assert.equal(children[0].capabilities.supervision, false); assert.equal(children[0].sla.state, 'excluded');
  const chat = await readLiveInteractions(pool, { channel: 'chat' });
  assert.ok(chat.interactions.length > 0); assert.ok(chat.interactions.every(row => row.channel === 'chat'));
  await assert.rejects(readLiveInteractions(pool, { channel: 'invalid' }), /Invalid channel/);
  await pool.query("UPDATE acd_legs SET state='ended',ended_at=now() WHERE id=ANY($1::uuid[])", [[target, transport]]);
  assert.equal((await readLiveInteractions(pool)).interactions.filter(row => row.parentInteractionId === manual.id).length, 0);
  await pool.query("UPDATE acd_work_items SET state='completed',terminal_at=now() WHERE id=$1", [manual.id]);
  assert.ok(!(await readLiveInteractions(pool)).interactions.some(row => row.id === manual.id));
});

test('routing availability checks channel sessions and exclusive voice across a larger capacity budget', async () => {
  await seedAgent(pool, 'capacity-agent', { capacity: 2 });
  await seedQueue(pool, 'capacity-a', ['capacity-agent']); await seedQueue(pool, 'capacity-b', ['capacity-agent']);
  await pool.query("UPDATE acd_agent_sessions SET capabilities='{\"voice\":true,\"chat\":true}' WHERE agent_id='capacity-agent'");
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES('capacity-agent','chat',true,3,0.33),('capacity-agent','email',true,5,0.2)");
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES('capacity-a','chat',true,3,0.33),('capacity-a','email',true,5,0.2)");
  const before = await readMonitorStatistics(pool);
  assert.equal(before.agents.find(row => row.userId === 'capacity-agent').capacityByChannel.chat, true);
  assert.equal(before.agents.find(row => row.userId === 'capacity-agent').capacityByChannel.email, false);
  const item = await work('voice', null);
  await pool.query("INSERT INTO acd_reservations(id,agent_id,work_item_id,channel,weight,state,lease_expires_at) VALUES($1,'capacity-agent',$2,'voice',1,'active',now())", [randomUUID(), item.id]);
  const during = await readMonitorStatistics(pool);
  const agent = during.agents.find(row => row.userId === 'capacity-agent');
  assert.equal(agent.isAvailableForRouting, false); assert.deepEqual(agent.currentInteractionIds, [item.id]);
  assert.equal(during.overall.agents.busy - before.overall.agents.busy, 1);
});

test('live phases freeze at their actual boundaries while a closed interaction is in wrap-up', () => {
  const row = { createdAt: at(400), enqueuedAt: at(300), waitEndedAt: at(280), answeredAt: at(280), handlingEndedAt: at(100), completedAt: at(100) };
  const first = realtimeDurations(row), later = realtimeDurations(row, Date.now() + 60000);
  assert.deepEqual(first, later); assert.equal(first.wait, 20); assert.equal(first.handling, 180);
});

test('monitor readers execute in a read-only transaction without changing application state', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.ok((await readLiveInteractions(db)).interactions.length > 0);
    assert.ok((await readMonitorStatistics(db)).queues.length > 0);
  } finally { await db.query('ROLLBACK'); db.release(); }
});

test('global listing does not silently truncate at the queue accordion limit', async () => {
  const batch = await pool.query(`INSERT INTO acd_work_items(id,channel,direction,state,created_at)
    SELECT gen_random_uuid(),'voice','outbound','open',now() FROM generate_series(1,1005) RETURNING id`);
  try {
    const result = await readLiveInteractions(pool, { channel: 'voice' });
    const ids = new Set(result.interactions.map(row => row.id));
    assert.ok(batch.rows.every(row => ids.has(row.id)));
  } finally { await pool.query('DELETE FROM acd_work_items WHERE id=ANY($1::uuid[])', [batch.rows.map(row => row.id)]); }
});

test('live endpoint authorizes supervisors and admins, rejects other roles and invalid channels', async () => {
  const { loadRoute } = await import('./helpers/route-harness.mjs');
  let identity = null, connects = 0;
  const route = await loadRoute('app/api/contact-center/monitor/interactions/route.js', {
    '@/lib/auth-server': { getAuthenticatedUser: async () => identity },
    '@/lib/role-utils': { isSupervisorOrAdmin: user => user.roles?.some(role => ['supervisor', 'admin'].includes(role)) },
    '@/lib/postgres.mjs': { getPostgresPool: () => ({ connect: () => { connects++; return pool.connect(); } }) },
    '@/lib/acd/live-interactions.mjs': { readLiveInteractions },
    '@/lib/acd/mobile-monitor-pages.mjs': await import('../lib/acd/mobile-monitor-pages.mjs'),
    '@/lib/runtime-logging.mjs': { contactCenterRuntimeLogger: { error() {} } },
  });
  const request = channel => new Request(`https://cc.example.test/api/contact-center/monitor/interactions?channel=${channel}`);
  assert.equal((await route.GET(request('all'))).status, 401);
  identity = { id: 'agent', roles: ['agent'] };
  assert.equal((await route.GET(request('all'))).status, 403); assert.equal(connects, 0);
  identity = { id: 'supervisor', roles: ['supervisor'] };
  assert.equal((await route.GET(request('invalid'))).status, 400);
  assert.equal((await route.GET(request('chat'))).status, 200);
  identity.roles = ['admin']; assert.equal((await route.GET(request('voice'))).status, 200);
  const paged = await route.GET(new Request('https://cc.example.test/api/contact-center/monitor/interactions?channel=all&mobilePageSize=25'));
  assert.equal(paged.status, 200);
  const payload = paged.body;
  assert.equal(payload.pagination.pageSize, 25);
  assert.ok(payload.interactions.filter(row => !row.parentInteractionId).length <= 25);
  identity = null;
  assert.equal((await route.GET(new Request('https://cc.example.test/api/contact-center/monitor/interactions?mobilePageSize=25'))).status, 401);
});
