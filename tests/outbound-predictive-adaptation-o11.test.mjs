import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { claimAutonomousOutbound } from '../lib/acd/outbound-runtime.mjs';
import { computePredictiveRatio } from '../lib/acd/outbound-pacing.mjs';
import { heartbeatAgentSession } from '../lib/acd/sessions.mjs';
import { prepareAcdTestPool, seedAgent, seedQueue } from './helpers/acd-test-db.mjs';
import { ensureOutboundTestSchema } from './helpers/acd-outbound-db.mjs';

const pool = await prepareAcdTestPool('acd_core_test_predictive_o11');
after(() => pool.end());
await ensureOutboundTestSchema(pool);

process.env.TELNYX_CALL_CONTROL_ID = 'test-connection';
process.env.TELNYX_WEBHOOK_BASE_URL = 'https://example.invalid';

async function adaptationFixture({ answers, maxRatio, candidates, samples = 20, abandons = 0 }) {
  const agentId = randomUUID();
  const queueId = randomUUID();
  await seedAgent(pool, agentId);
  await seedQueue(pool, queueId, [agentId], { engineOwner: 'acd_core' });
  await heartbeatAgentSession(pool, { agentId, sessionId: randomUUID(), voiceReady: true });

  const contactListId = (await pool.query(
    `INSERT INTO outbound_contact_lists (name, status) VALUES ($1, 'validated') RETURNING id`,
    [`Predictive fixture ${answers}/${samples}/${abandons}`],
  )).rows[0].id;
  const campaign = (await pool.query(
    `INSERT INTO outbound_campaigns
      (name, status, mode, channel, handler_type, handler_ref, contact_list_id,
       pacing_config, concurrency_config, retry_policy, amd_config, metadata)
     VALUES ($1, 'running', 'predictive', 'voice', 'queue', $2, $3,
       $4::jsonb, $5::jsonb, '{"maxAttempts":1}', '{"enabled":false}', $6::jsonb)
     RETURNING *`,
    [
      `Predictive fixture ${answers}/${samples}/${abandons}`,
      queueId,
      contactListId,
      JSON.stringify({ ratio: 1, maxRatio, minSampleSize: 20, statsWindowMinutes: 30, abandonTarget: 0.03 }),
      JSON.stringify({ maxConcurrent: 10, perAgentLimit: 10 }),
      JSON.stringify({ from_numbers: ['+15550001111'], contact_list_numbers: ['phone_number'], live_voice_test: true }),
    ],
  )).rows[0];

  for (let index = 0; index < candidates; index += 1) {
    await pool.query(
      `INSERT INTO outbound_contact_records (contact_list_id, row_data, contact_methods, validation_status)
       VALUES ($1, $2::jsonb, $3::jsonb, 'valid')`,
      [contactListId, JSON.stringify({ phone_number: `+1555001${String(index).padStart(4, '0')}` }), JSON.stringify({ number: { 1: `+1555001${String(index).padStart(4, '0')}` } })],
    );
  }

  for (let index = 0; index < samples; index += 1) {
    const metadata = {
      o11_synthetic: true,
      fixture_role: 'predictive_history',
      ...(index < answers ? { human_answered_at: new Date().toISOString() } : {}),
      ...(index < abandons ? { abandoned_at: new Date().toISOString() } : {}),
    };
    await pool.query(
      `INSERT INTO outbound_attempt_ledger
        (campaign_id, status, channel, handler_type, handler_ref, attempt_reason, metadata, created_at, updated_at)
       VALUES ($1, 'completed', 'voice', 'queue', $2, 'o11_synthetic_history', $3::jsonb, now(), now())`,
      [campaign.id, queueId, JSON.stringify(metadata)],
    );
  }
  return campaign;
}

async function claimUntilBlocked(campaign, attempts) {
  const results = [];
  for (let index = 0; index < attempts; index += 1) {
    results.push(await claimAutonomousOutbound(pool, campaign.id));
  }
  return results;
}

async function isolateNextCase(campaignId) {
  await pool.query(
    `UPDATE acd_outbound_lines
        SET released_at = COALESCE(released_at, now()), release_reason = COALESCE(release_reason, 'O-11 fixture isolation')
      WHERE campaign_id = $1`,
    [campaignId],
  );
  await pool.query(`UPDATE outbound_campaigns SET status = 'stopped' WHERE id = $1`, [campaignId]);
}

test('O-11: 50 percent answer rate expands one-agent admission from one line to two', async () => {
  const campaign = await adaptationFixture({ answers: 10, maxRatio: 3, candidates: 3 });
  assert.equal(computePredictiveRatio({
    sampleSize: 20,
    answerRate: 0.5,
    abandonRate: 0,
    baseRatio: 1,
    maxRatio: 3,
    minSampleSize: 20,
    abandonTarget: 0.03,
  }), 2);

  const claims = await claimUntilBlocked(campaign, 3);
  assert.equal(claims.filter(Boolean).length, 2);
  assert.equal(claims[2], null);
  const lines = await pool.query(
    `SELECT attempt_id FROM acd_outbound_lines WHERE campaign_id = $1 AND released_at IS NULL`,
    [campaign.id],
  );
  assert.equal(lines.rowCount, 2);
  await isolateNextCase(campaign.id);
});

test('O-11: low answer rate reaches maxRatio but cannot admit a fourth line', async () => {
  const campaign = await adaptationFixture({ answers: 0, maxRatio: 3, candidates: 4 });
  assert.equal(computePredictiveRatio({
    sampleSize: 20,
    answerRate: 0,
    abandonRate: 0,
    baseRatio: 1,
    maxRatio: 3,
    minSampleSize: 20,
    abandonTarget: 0.03,
  }), 3);

  const claims = await claimUntilBlocked(campaign, 4);
  assert.equal(claims.filter(Boolean).length, 3);
  assert.equal(claims[3], null);
  const lines = await pool.query(
    `SELECT attempt_id FROM acd_outbound_lines WHERE campaign_id = $1 AND released_at IS NULL`,
    [campaign.id],
  );
  assert.equal(lines.rowCount, 3);
  await isolateNextCase(campaign.id);
});

test('O-12: abandonment above the target blocks admission and target equality restores it', async () => {
  const campaign = await adaptationFixture({ answers: 100, samples: 100, abandons: 4, maxRatio: 3, candidates: 1 });
  assert.equal(await claimAutonomousOutbound(pool, campaign.id), null, '4% abandonment must block a 3% campaign');
  assert.equal((await pool.query(
    `SELECT COUNT(*)::int AS n FROM acd_outbound_lines WHERE campaign_id=$1 AND released_at IS NULL`,
    [campaign.id],
  )).rows[0].n, 0);
  const blocked = (await pool.query('SELECT metadata FROM outbound_campaigns WHERE id=$1',[campaign.id])).rows[0].metadata.answered_without_agent_guard;
  assert.equal(blocked.blocked,true);
  assert.equal(Number(blocked.rate_percent),4);

  await pool.query(`UPDATE outbound_attempt_ledger SET metadata=metadata-'abandoned_at'
    WHERE id=(SELECT id FROM outbound_attempt_ledger WHERE campaign_id=$1 AND metadata ? 'abandoned_at' ORDER BY id LIMIT 1)`,[campaign.id]);
  const recovered = await claimAutonomousOutbound(pool, campaign.id);
  assert.ok(recovered, '3% abandonment must permit recovery because the configured comparison is strictly above target');
  const guard = (await pool.query('SELECT metadata FROM outbound_campaigns WHERE id=$1',[campaign.id])).rows[0].metadata.answered_without_agent_guard;
  assert.equal(guard.blocked,false);
  assert.equal(Number(guard.rate_percent),3);
  await isolateNextCase(campaign.id);
});

test('O-12: a new quality breach drains an existing line without cancelling it', async () => {
  const campaign = await adaptationFixture({ answers: 100, samples: 100, abandons: 3, maxRatio: 3, candidates: 2 });
  const existing = await claimAutonomousOutbound(pool, campaign.id);
  assert.ok(existing);
  const before = await pool.query(`SELECT attempt_id,released_at FROM acd_outbound_lines WHERE campaign_id=$1`,[campaign.id]);
  assert.equal(before.rowCount,1);
  assert.equal(before.rows[0].released_at,null);

  await pool.query(`UPDATE outbound_attempt_ledger SET metadata=metadata||jsonb_build_object('abandoned_at',now()::text)
    WHERE id=(SELECT id FROM outbound_attempt_ledger WHERE campaign_id=$1 AND metadata->>'fixture_role'='predictive_history'
      AND NOT (metadata ? 'abandoned_at') ORDER BY id LIMIT 1)`,[campaign.id]);
  assert.equal(await claimAutonomousOutbound(pool,campaign.id),null,'a fourth abandonment must block the second contact');
  const after = await pool.query(`SELECT attempt_id,released_at FROM acd_outbound_lines WHERE campaign_id=$1`,[campaign.id]);
  assert.equal(after.rowCount,1);
  assert.equal(after.rows[0].attempt_id,existing.attemptId);
  assert.equal(after.rows[0].released_at,null,'the already admitted call must keep its line while new admission is blocked');
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM outbound_attempt_ledger
    WHERE campaign_id=$1 AND attempt_reason='acd_predictive'`,[campaign.id])).rows[0].n,1);
  await isolateNextCase(campaign.id);
});
