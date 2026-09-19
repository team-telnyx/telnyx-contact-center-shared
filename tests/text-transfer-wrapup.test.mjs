import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool, seedAgent, seedQueue, makeTxRunner } from './helpers/acd-test-db.mjs';
import { createWorkItem, applyTransition, openSegment } from '../lib/acd/lifecycle.mjs';
import { heartbeatAgentSession } from '../lib/acd/sessions.mjs';
import { routeOne } from '../lib/acd/router.mjs';
import { actOnTextWork, sweepTextWrapups, repairTransferredTextWrapups, endCustomerChat } from '../lib/acd/text-lifecycle.mjs';
import { setWorkflowState } from '../lib/acd/agent-state.mjs';
import { transferTextWork } from '../lib/acd/text-transfer.mjs';
import { completeAcdWrapup, saveAcdDisposition } from '../lib/acd/wrapup.mjs';
import { findPendingAcdWrapupForAgent, findPendingAcdWrapupSegment } from '../lib/acd/wrapup-context.mjs';
import { readAgentSnapshot } from '../lib/acd/stream.mjs';
import { readTextInteractions } from '../lib/acd/text-desktop.mjs';
import { readRealtimeInteractions } from '../lib/acd/realtime-queue-calls.mjs';
import { buildAcdTimeline, createAcdHistoryDto } from '../lib/acd/history-projection.mjs';
import { clearSagaDeadlineWakeups } from '../lib/acd/saga-engine.mjs';
import { requireChatCopilotAccess } from '../lib/contact-center/chat-copilot.js';

const pool = await prepareAcdTestPool('acd_core_test_text_transfer_wrapup');
const withTx = makeTxRunner(pool);
after(async () => { clearSagaDeadlineWakeups(); await pool.end(); });

async function fixture(channel) {
  const agentId = randomUUID(), queueId = randomUUID(), targetQueueId = randomUUID();
  await seedAgent(pool, agentId, { voiceReady: false });
  await pool.query(`INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight)
    VALUES($1,$2,true,5,0.2)`, [agentId, channel]);
  for (const id of [queueId, targetQueueId]) {
    await seedQueue(pool, id, [agentId]);
    await pool.query(`INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight)
      VALUES($1,$2,true,5,0.2)`, [id, channel]);
  }
  await heartbeatAgentSession(pool, { agentId, sessionId: randomUUID(), chatReady: channel === 'chat', emailReady: channel === 'email' });
  const work = await withTx(async db => {
    const conversationId = randomUUID();
    await db.query('INSERT INTO acd_conversations(id,channel) VALUES($1,$2)', [conversationId, channel]);
    const work = await createWorkItem(db, { channel, direction: 'inbound', queueId, conversationId, actor: 'test' });
    await applyTransition(db, { workItemId: work.id, to: 'queued', eventType: 'work_item_queued', actor: 'test' });
    await openSegment(db, { workItemId: work.id, kind: 'queue_wait', queueId });
    return work;
  });
  const act = async (action, extra = {}) => {
    const current = (await pool.query('SELECT version FROM acd_work_items WHERE id=$1', [work.id])).rows[0];
    return actOnTextWork(pool, { workItemId: work.id, agentId, channel, action, commandId: randomUUID(), expectedVersion: current.version, ...extra });
  };
  const accept = async () => {
    const offer = await routeOne(pool, work.id);
    assert.equal(offer.routed, true);
    await act('accept', { offerId: offer.offerId });
  };
  await accept();
  const originalSegment = (await pool.query('SELECT segment_id FROM acd_text_assignments WHERE work_item_id=$1', [work.id])).rows[0].segment_id;
  const transfer = async (extra = {}) => {
    const current = (await pool.query('SELECT version FROM acd_work_items WHERE id=$1', [work.id])).rows[0];
    await transferTextWork(pool, { workItemId: work.id, agentId, channel, queueId: targetQueueId, commandId: randomUUID(), expectedVersion: current.version, ...extra });
  };
  const finishTransfer = () => completeAcdWrapup(pool, { workItemId: work.id, expectedAgentId: agentId, segmentId: originalSegment, wrapupCodeId: 'general-inquiry' });
  return { work, agentId, queueId, targetQueueId, originalSegment, act, accept, transfer, finishTransfer };
}

for (const channel of ['email', 'chat']) {
  async function targetAgent(queueId) {
    const agentId = randomUUID();
    await seedAgent(pool, agentId, { voiceReady: false });
    await seedQueue(pool, queueId, [agentId]);
    await pool.query(`INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight)
      VALUES($1,$2,true,5,0.2)`, [agentId, channel]);
    await heartbeatAgentSession(pool, { agentId, sessionId: randomUUID(), chatReady: channel === 'chat', emailReady: channel === 'email' });
    return agentId;
  }

  test(`${channel}: source wrap-up opens immediately while destination handles the same conversation`, async () => {
    const f = await fixture(channel), target = await targetAgent(f.targetQueueId);
    await f.transfer({ targetAgentId: target });
    const pending = await findPendingAcdWrapupSegment(pool, { workItemId: f.work.id, agentId: f.agentId });
    assert.equal(pending.id, f.originalSegment);
    assert.equal(pending.queue_id, f.queueId);
    assert.equal(pending.outcome, 'transferred');
    assert(pending.wrapup_deadline_at > pending.ended_at);
    assert.equal((await readAgentSnapshot(pool, f.agentId)).pendingWrapup.segment_id, pending.id);
    assert.equal((await readTextInteractions(pool, f.agentId)).interactions.length, 0);
    assert.equal((await pool.query('SELECT state FROM acd_conversations WHERE id=$1', [f.work.conversation_id])).rows[0].state, 'open');
    assert.equal(await repairTransferredTextWrapups(pool, { workItemId: f.work.id }), 0);
    await assert.rejects(requireChatCopilotAccess(pool, { workItemId: f.work.id, agentId: f.agentId, channel }), { status: 403 });
    assert.equal((await requireChatCopilotAccess(pool, { workItemId: f.work.id, agentId: target, channel })).id, f.work.id);
    const offer = (await readTextInteractions(pool, target)).interactions[0];
    await f.act('accept', { agentId: target, offerId: offer.offer_id });
    assert.equal((await requireChatCopilotAccess(pool, { workItemId: f.work.id, agentId: target, channel })).id, f.work.id);
    const destinationBefore = await readAgentSnapshot(pool, target);
    const live = await readRealtimeInteractions(pool, { queueId: f.targetQueueId });
    assert.equal(live.length, 1);
    assert.equal(live[0].state, 'active');
    assert.equal(live[0].agentUserId, target);
    assert.equal((await readRealtimeInteractions(pool, { agentId: f.agentId })).length, 0);
    // Persist a known non-zero disposition interval without a wall-clock sleep.
    await pool.query("UPDATE acd_segments SET ended_at=now()-interval '20 seconds' WHERE id=$1", [pending.id]);
    await withTx(db => saveAcdDisposition(db, { segmentId: pending.id, agentId: f.agentId, codeId: 'general-inquiry', actor: 'test' }));
    await f.finishTransfer();
    await assert.rejects(requireChatCopilotAccess(pool, { workItemId: f.work.id, agentId: f.agentId, channel }), { status: 403 });
    assert.equal((await readAgentSnapshot(pool, f.agentId)).agent.status, 'Available');
    assert.deepEqual(await readAgentSnapshot(pool, target), destinationBefore);
    const work = (await pool.query('SELECT * FROM acd_work_items WHERE id=$1', [f.work.id])).rows[0];
    assert.equal(work.state, 'active');
    assert.equal(work.terminal_at, null);
    const segments = (await pool.query('SELECT * FROM acd_segments WHERE work_item_id=$1 ORDER BY seq', [f.work.id])).rows;
    const input = { workItem: work, segments };
    assert(createAcdHistoryDto(input).metrics.wrapupSeconds >= 20);
    assert(buildAcdTimeline(input).timeline.find(e => e.type === 'wrapup_end').wrapupDurationSeconds >= 20);
    await f.finishTransfer();
    assert.deepEqual(await readAgentSnapshot(pool, target), destinationBefore);
  });

  test(`${channel}: multiple agents' pending segments recover and time out independently`, async () => {
    const f = await fixture(channel), target = await targetAgent(f.targetQueueId);
    await f.transfer({ targetAgentId: target });
    await f.act('accept', { agentId: target, offerId: (await readTextInteractions(pool, target)).interactions[0].offer_id });
    await f.act('disconnect', { agentId: target });
    const targetPending = await findPendingAcdWrapupSegment(pool, { workItemId: f.work.id, agentId: target });
    await pool.query("UPDATE acd_agent_state SET workflow_state='idle' WHERE agent_id=ANY($1::text[])", [[f.agentId, target]]);
    await sweepTextWrapups(pool);
    assert.equal((await readAgentSnapshot(pool, f.agentId)).pendingWrapup.segment_id, f.originalSegment);
    assert.equal((await readAgentSnapshot(pool, target)).pendingWrapup.segment_id, targetPending.id);
    await pool.query("UPDATE acd_text_assignments SET wrapup_deadline_at=now()-interval '1 second' WHERE segment_id=$1", [f.originalSegment]);
    await sweepTextWrapups(pool);
    assert.equal((await readAgentSnapshot(pool, f.agentId)).pendingWrapup, null);
    assert.equal((await readAgentSnapshot(pool, target)).pendingWrapup.segment_id, targetPending.id);
    assert.equal((await pool.query('SELECT terminal_at FROM acd_work_items WHERE id=$1', [f.work.id])).rows[0].terminal_at, null);
    await completeAcdWrapup(pool, { workItemId: f.work.id, expectedAgentId: target, segmentId: targetPending.id });
    assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1', [f.work.id])).rows[0].state, 'completed');
    assert.equal((await pool.query('SELECT wrapup_code_id FROM acd_segments WHERE id=$1', [f.originalSegment])).rows[0].wrapup_code_id, 'auto_timeout');
  });

  test(`${channel}: destination can finish before source wrap-up without a second terminal transition`, async () => {
    const f = await fixture(channel), target = await targetAgent(f.targetQueueId);
    await f.transfer({ targetAgentId: target });
    await f.act('accept', { agentId: target, offerId: (await readTextInteractions(pool, target)).interactions[0].offer_id });
    await f.act('disconnect', { agentId: target });
    await completeAcdWrapup(pool, { workItemId: f.work.id, expectedAgentId: target });
    const before = (await pool.query('SELECT * FROM acd_work_items WHERE id=$1', [f.work.id])).rows[0];
    await f.finishTransfer();
    assert.deepEqual((await pool.query('SELECT * FROM acd_work_items WHERE id=$1', [f.work.id])).rows[0], before);
    assert.equal((await pool.query("SELECT 1 FROM acd_events WHERE work_item_id=$1 AND type='work_item_completed'", [f.work.id])).rowCount, 1);
    assert.equal((await readAgentSnapshot(pool, f.agentId)).agent.status, 'Available');
  });

  test(`${channel}: source disposition validates codes against the source queue`, async () => {
    const f = await fixture(channel);
    await pool.query(`CREATE TABLE IF NOT EXISTS cc_wrapup_codes(id text PRIMARY KEY,name text,is_active boolean);
      CREATE TABLE IF NOT EXISTS cc_queue_wrapup_codes(queue_id text,wrapup_code_id text)`);
    const sourceCode = randomUUID(), targetCode = randomUUID();
    await pool.query("INSERT INTO cc_wrapup_codes(id,name,is_active) VALUES($1,'Source',true),($2,'Destination',true)", [sourceCode, targetCode]);
    await pool.query('INSERT INTO cc_queue_wrapup_codes(queue_id,wrapup_code_id) VALUES($1,$2),($3,$4)', [f.queueId, sourceCode, f.targetQueueId, targetCode]);
    await f.transfer();
    await assert.rejects(f.act('wrapup', { codeId: targetCode }), e => e.status === 400);
    await f.act('wrapup', { codeId: sourceCode });
    assert.equal((await pool.query('SELECT wrapup_code_id FROM acd_segments WHERE id=$1', [f.originalSegment])).rows[0].wrapup_code_id, sourceCode);
    assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1', [f.work.id])).rows[0].state, 'queued');
  });

  if (channel === 'chat') for (const acceptDestination of [false, true]) {
    test(`chat: customer leaves after transfer ${acceptDestination ? 'during target handling' : 'while queued'} with source wrap-up pending`, async () => {
      const f = await fixture(channel), target = await targetAgent(f.targetQueueId);
      await f.transfer();
      if (acceptDestination) {
        const offer = await routeOne(pool, f.work.id);
        await f.act('accept', { agentId: target, offerId: offer.offerId });
      }
      await withTx(async db => {
        const work = (await db.query('SELECT * FROM acd_work_items WHERE id=$1 FOR UPDATE', [f.work.id])).rows[0];
        await endCustomerChat(db, work);
      });
      assert.equal((await pool.query('SELECT state FROM acd_conversations WHERE id=$1', [f.work.conversation_id])).rows[0].state, 'closed');
      assert.equal((await readAgentSnapshot(pool, f.agentId)).pendingWrapup.segment_id, f.originalSegment);
      if (acceptDestination) {
        const pending = (await readAgentSnapshot(pool, target)).pendingWrapup;
        assert(pending);
        assert.notEqual(pending.segment_id, f.originalSegment);
        await completeAcdWrapup(pool, { workItemId: f.work.id, expectedAgentId: target });
      }
      const before = (await pool.query('SELECT * FROM acd_work_items WHERE id=$1', [f.work.id])).rows[0];
      assert.equal(before.state, acceptDestination ? 'completed' : 'abandoned');
      await f.finishTransfer();
      assert.deepEqual((await pool.query('SELECT * FROM acd_work_items WHERE id=$1', [f.work.id])).rows[0], before);
    });
  }

  test(`${channel}: a late source disposition cannot overwrite terminal state or the same agent's new segment`, async () => {
    const f = await fixture(channel);
    await f.transfer();
    assert.equal((await routeOne(pool, f.work.id)).routed, false, 'source must finish disposition before accepting new work');
    await f.finishTransfer();
    await f.accept();
    await f.act('disconnect');
    const pending = await findPendingAcdWrapupSegment(pool, { workItemId: f.work.id, agentId: f.agentId });
    assert.notEqual(pending.id, f.originalSegment);
    const before = await readAgentSnapshot(pool, f.agentId);
    assert.equal((await f.finishTransfer()).alreadyCompleted, true);
    assert.deepEqual(await readAgentSnapshot(pool, f.agentId), before);
    assert.equal(await findPendingAcdWrapupSegment(pool, { workItemId: f.work.id, agentId: f.agentId, segmentId: f.originalSegment }), null);
    const foreign = await completeAcdWrapup(pool, { workItemId: f.work.id, expectedAgentId: randomUUID(), segmentId: pending.id });
    assert.equal(foreign.completed, false);
    await completeAcdWrapup(pool, { workItemId: f.work.id, expectedAgentId: f.agentId, segmentId: pending.id });
  });

  test(`${channel}: transfer back to the same agent dispositions the current segment and exits wrap-up once`, async () => {
    const f = await fixture(channel);
    await f.transfer();
    await f.finishTransfer();
    await f.accept();
    await f.act('disconnect');
    const pending = await findPendingAcdWrapupSegment(pool, { workItemId: f.work.id, agentId: f.agentId });
    assert.equal(pending.queue_id, f.targetQueueId, 'the sheet must use the current queue, not the historical transfer');
    assert.notEqual(pending.id, f.originalSegment);
    const snapshot = await readAgentSnapshot(pool, f.agentId);
    assert.equal(snapshot.pendingWrapup.segment_id, pending.id);
    assert.equal((await findPendingAcdWrapupForAgent(pool, { agentId: f.agentId })).id, pending.id);
    await withTx(db => saveAcdDisposition(db, { segmentId: pending.id, agentId: f.agentId, codeId: 'general-inquiry', actor: 'test' }));
    await completeAcdWrapup(pool, { workItemId: f.work.id, expectedAgentId: f.agentId });
    await completeAcdWrapup(pool, { workItemId: f.work.id, expectedAgentId: f.agentId });
    await sweepTextWrapups(pool);
    const after = await readAgentSnapshot(pool, f.agentId);
    assert.equal(after.agent.status, 'Available');
    assert.equal(after.agent.workflow_work_item_id, null);
    assert.equal(after.pendingWrapup, null);
    assert.equal(await findPendingAcdWrapupForAgent(pool, { agentId: f.agentId }), null);
    const segments = (await pool.query(`SELECT id,outcome,wrapup_ended_at,wrapup_code_id,wrapup_deadline_at,ended_at
      FROM acd_segments WHERE work_item_id=$1 AND kind='agent' ORDER BY seq`, [f.work.id])).rows;
    assert.equal(segments[0].outcome, 'transferred');
    assert(segments[0].wrapup_ended_at >= segments[0].ended_at);
    assert.equal(segments[0].wrapup_code_id, 'general-inquiry');
    assert(segments[0].wrapup_deadline_at);
    assert.equal(segments[1].wrapup_code_id, 'general-inquiry');
    assert(segments[1].wrapup_ended_at);
    assert.equal((await pool.query(`SELECT 1 FROM acd_reservations WHERE agent_id=$1 AND state<>'released'`, [f.agentId])).rowCount, 0);
  });

  test(`${channel}: historical transfers cannot acquire the current deadline or receive its disposition`, async () => {
    const f = await fixture(channel);
    await f.transfer();
    await f.finishTransfer();
    // Simulate a transfer written by the previous runtime.
    await pool.query('UPDATE acd_segments SET wrapup_ended_at=NULL,wrapup_deadline_at=NULL WHERE id=$1', [f.originalSegment]);
    await f.accept();
    await f.act('disconnect');
    assert.equal((await pool.query('SELECT wrapup_deadline_at FROM acd_segments WHERE id=$1', [f.originalSegment])).rows[0].wrapup_deadline_at, null);
    // Also tolerate an old runtime having already copied an expired deadline.
    await pool.query("UPDATE acd_segments SET wrapup_deadline_at=now()-interval '1 minute' WHERE id=$1", [f.originalSegment]);
    const pending = await findPendingAcdWrapupSegment(pool, { workItemId: f.work.id, agentId: f.agentId });
    const before = await readAgentSnapshot(pool, f.agentId);
    assert.notEqual(pending.id, f.originalSegment);
    assert.equal(before.pendingWrapup.segment_id, pending.id);
    assert.equal((await findPendingAcdWrapupForAgent(pool, { agentId: f.agentId, interactionId: f.work.id })).id, pending.id);
    await sweepTextWrapups(pool);
    const afterRepair = await readAgentSnapshot(pool, f.agentId);
    assert.equal(afterRepair.agent.status, 'Wrapup');
    assert.deepEqual(afterRepair.pendingWrapup.wrapup_deadline_at, before.pendingWrapup.wrapup_deadline_at);
    assert.equal(afterRepair.pendingWrapup.segment_id, pending.id);
    await withTx(db => saveAcdDisposition(db, { segmentId: pending.id, agentId: f.agentId, codeId: 'general-inquiry', actor: 'test' }));
    await completeAcdWrapup(pool, { workItemId: f.work.id, expectedAgentId: f.agentId, nextManualStatus: 'Break' });
    const done = await readAgentSnapshot(pool, f.agentId);
    assert.equal(done.agent.status, 'Break');
    assert.equal(done.agent.workflow_state, 'idle');
    assert.equal(done.pendingWrapup, null);
    assert.equal((await pool.query('SELECT wrapup_code_id FROM acd_segments WHERE id=$1', [pending.id])).rows[0].wrapup_code_id, 'general-inquiry');
  });

  test(`${channel}: repair closes a completed transfer without losing its saved code or reopening wrap-up`, async () => {
    const f = await fixture(channel);
    await f.transfer();
    await f.finishTransfer();
    await f.accept();
    await f.act('disconnect');
    await completeAcdWrapup(pool, { workItemId: f.work.id, expectedAgentId: f.agentId, wrapupCodeId: 'general-inquiry' });
    await pool.query(`UPDATE acd_segments SET wrapup_ended_at=NULL,wrapup_code_id='general-inquiry',
      wrapup_deadline_at=now()-interval '1 minute' WHERE id=$1`, [f.originalSegment]);
    await pool.query(`UPDATE acd_agent_state SET workflow_state='wrapup',workflow_work_item_id=$2,
      workflow_deadline_at=now()-interval '1 minute',routability='not_routable' WHERE agent_id=$1`, [f.agentId, f.work.id]);
    assert.equal(await repairTransferredTextWrapups(pool, { agentId: f.agentId, workItemId: f.work.id }), 1);
    const beforeRetry = await readAgentSnapshot(pool, f.agentId);
    assert.equal(beforeRetry.agent.status, 'Available');
    assert.equal(beforeRetry.agent.workflow_work_item_id, null);
    assert.equal(beforeRetry.pendingWrapup, null);
    assert.equal(await repairTransferredTextWrapups(pool, { agentId: f.agentId, workItemId: f.work.id }), 0);
    await sweepTextWrapups(pool);
    assert.deepEqual(await readAgentSnapshot(pool, f.agentId), beforeRetry);
    const old = (await pool.query('SELECT wrapup_code_id,ended_at,wrapup_ended_at,wrapup_deadline_at FROM acd_segments WHERE id=$1', [f.originalSegment])).rows[0];
    assert.equal(old.wrapup_code_id, 'general-inquiry');
    assert.deepEqual(old.wrapup_ended_at, old.ended_at);
    assert.equal(old.wrapup_deadline_at, null);
  });

  test(`${channel}: repair preserves newer voice handling and text timeout still releases capacity`, async () => {
    const f = await fixture(channel);
    await f.transfer();
    await f.finishTransfer();
    await pool.query('UPDATE acd_segments SET wrapup_ended_at=NULL,wrapup_deadline_at=NULL WHERE id=$1', [f.originalSegment]);
    const voice = await withTx(db => createWorkItem(db, { channel: 'voice', direction: 'inbound', actor: 'test' }));
    await setWorkflowState(pool, f.agentId, 'handling', { workItemId: voice.id, actor: 'test' });
    const before = (await readAgentSnapshot(pool, f.agentId)).agent;
    assert.equal(await repairTransferredTextWrapups(pool, { agentId: f.agentId }), 1);
    assert.deepEqual((await readAgentSnapshot(pool, f.agentId)).agent, before);
    await setWorkflowState(pool, f.agentId, 'idle', { actor: 'test' });
    await f.accept();
    await f.act('disconnect');
    await pool.query("UPDATE acd_text_assignments SET wrapup_deadline_at=now()-interval '1 second' WHERE work_item_id=$1 AND state='wrapup'", [f.work.id]);
    await sweepTextWrapups(pool);
    const snapshot = await readAgentSnapshot(pool, f.agentId);
    assert.equal(snapshot.agent.status, 'Available');
    assert.equal(snapshot.pendingWrapup, null);
    const segment = (await pool.query("SELECT wrapup_code_id,wrapup_ended_at FROM acd_segments WHERE work_item_id=$1 AND kind='agent' ORDER BY seq DESC LIMIT 1", [f.work.id])).rows[0];
    assert.equal(segment.wrapup_code_id, 'auto_timeout');
    assert(segment.wrapup_ended_at);
  });
}
