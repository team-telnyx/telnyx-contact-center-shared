import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool, seedQueue } from './helpers/acd-test-db.mjs';
import {
  readQueueAudioContext, startQueueAudio, clearAllSessions,
  markQueuePositionStarted, resumeQueueMedia, getActiveSession,
} from '../lib/contact-center/queue-audio-service.js';

const pool = await prepareAcdTestPool('acd_core_test_queue_position');
const skip = pool ? false : 'PostgreSQL unavailable';
test.after(async () => { clearAllSessions(); await pool?.end(); });

async function fixture() {
  const queueId = `position-${randomUUID()}`, callId = `v3:${randomUUID()}`;
  await seedQueue(pool, queueId, []);
  await pool.query("UPDATE cc_queues SET queue_audio_media_name='queue-music' WHERE id=$1", [queueId]);
  const emailId = randomUUID(), voiceId = randomUUID();
  await pool.query(`INSERT INTO acd_work_items(id,channel,direction,state,queue_id,enqueued_at)
    VALUES ($1,'email','inbound','queued',$3,now()-interval '2 minutes'),
           ($2,'voice','inbound','queued',$3,now()-interval '1 minute')`, [emailId, voiceId, queueId]);
  await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,state)
    VALUES($1,$2,'customer',$3,'answered')`, [randomUUID(), voiceId, callId]);
  return { queueId, callId, emailId, voiceId };
}

async function waitUntil(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw Error('Timed out waiting for queue announcement');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('queue position excludes handled mail and tracks all remaining waiting channels', { skip }, async () => {
  const { callId, emailId, voiceId, queueId } = await fixture();
  assert.equal((await readQueueAudioContext(pool, callId)).position, 2);
  for (const state of ['offered', 'active', 'completed']) {
    await pool.query('UPDATE acd_work_items SET state=$2 WHERE id=$1', [emailId, state]);
    assert.equal((await readQueueAudioContext(pool, callId)).position, 1, state);
  }
  const chatId = randomUUID();
  await pool.query(`INSERT INTO acd_work_items(id,channel,direction,state,queue_id,enqueued_at)
    VALUES ($1,'chat','inbound','queued',$2,now()-interval '3 minutes'),
           ($3,'voice','inbound','queued','another-queue',now()-interval '4 minutes'),
           ($4,'email','inbound','queued',$2,now())`, [chatId, queueId, randomUUID(), randomUUID()]);
  assert.equal((await readQueueAudioContext(pool, callId)).position, 2);
  await pool.query("UPDATE acd_work_items SET state='abandoned' WHERE id=$1", [chatId]);
  assert.equal((await readQueueAudioContext(pool, callId)).position, 1);
  await pool.query("UPDATE acd_work_items SET state='active' WHERE id=$1", [voiceId]);
  assert.equal((await readQueueAudioContext(pool, callId)).allowed, false);
  await pool.query("UPDATE acd_legs SET state='ended',ended_at=now() WHERE work_item_id=$1", [voiceId]);
  assert.equal((await readQueueAudioContext(pool, callId)).known, false);
});

test('recurring voice announcement changes from second to first after an email is accepted', { skip }, async t => {
  const { queueId, callId, emailId, voiceId } = await fixture();
  const previousKey = process.env.TELNYX_API_KEY;
  process.env.TELNYX_API_KEY = 'test-key';
  const speaks = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/actions/speak')) speaks.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const loadContext = id => readQueueAudioContext(pool, id);
  try {
    await startQueueAudio(callId, queueId, {
      queue_audio_media_name: 'queue-music', queue_audio_enable_position: true,
      queue_audio_tts_voice: 'AWS.Polly.Joanna', queue_audio_position_interval_secs: 0.03,
    }, 99, { loadContext });
    assert.equal(speaks[0].payload, 'your current position in a queue is 2');
    await markQueuePositionStarted(callId, speaks[0].client_state);
    await pool.query("UPDATE acd_work_items SET state='active' WHERE id=$1", [emailId]);
    await resumeQueueMedia(callId, speaks[0].client_state, { loadContext });
    await waitUntil(() => speaks.length >= 2);
    assert.equal(speaks[1].payload, 'your current position in a queue is 1');
    assert.equal(getActiveSession(callId).currentPosition, 1);
    await markQueuePositionStarted(callId, speaks[1].client_state);
    await pool.query("UPDATE acd_work_items SET state='active' WHERE id=$1", [voiceId]);
    await resumeQueueMedia(callId, speaks[1].client_state, { loadContext });
    await waitUntil(() => !getActiveSession(callId));
    assert.equal(speaks.length, 2, 'no queue announcement after the caller is connected');
  } finally {
    clearAllSessions();
    if (previousKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = previousKey;
  }
});
