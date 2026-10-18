import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool } from './helpers/acd-test-db.mjs';
import { ensureAcdSchema } from '../lib/acd/schema.mjs';
import { readVoiceEndpoints } from '../lib/acd/voice-endpoints.mjs';

const pool = await prepareAcdTestPool('acd_core_test_schema_upgrade');
after(() => pool?.end());
test('startup upgrades a database containing historical handoff legs and remains repeatable', { skip: !pool }, async () => {
  const workId = randomUUID();
  await pool.query("INSERT INTO acd_work_items(id,channel,direction,state) VALUES($1,'voice','inbound','completed')", [workId]);
  const roles = ['handoff_source', 'handoff_target', 'handoff_transport', 'consult_transport', 'transfer_transport'];
  for (const role of roles) {
    await pool.query("INSERT INTO acd_legs(id,work_item_id,role,state,ended_at) VALUES($1,$2,$3,'ended',now())", [randomUUID(), workId, role]);
  }
  // A pre-push-standby database already has real call history but not these columns.
  await pool.query('ALTER TABLE cc_voice_endpoints DROP COLUMN socket_ready_until, DROP COLUMN push_token_hash');
  for (let run = 0; run < 2; run++) {
    await ensureAcdSchema(pool);
    const history = await pool.query('SELECT role FROM acd_legs WHERE work_item_id=$1 ORDER BY role', [workId]);
    assert.deepEqual(history.rows.map(row => row.role), [...roles].sort());
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='cc_voice_endpoints' AND column_name IN ('socket_ready_until','push_token_hash')");
    assert.equal(columns.rowCount, 2);
    const devices = await readVoiceEndpoints(pool, 'schema-upgrade-test');
    assert.deepEqual(devices.endpoints, []);
  }
  await assert.rejects(pool.query("INSERT INTO acd_legs(id,work_item_id,role,state) VALUES($1,$2,'invalid_role','ended')", [randomUUID(), workId]), { code: '23514' });
});
