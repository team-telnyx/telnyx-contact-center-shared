// Required release check against an isolated local PostgreSQL database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { upgradeAiModelSettings, ensureWorkflowModelColumns } from '../../lib/ai-operations/upgrade-1-10.mjs';

const url = new URL(process.env.TEST_POSTGRES_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Upgrade fixtures require a local test database');
async function fixture(t) {
  const pool = new Pool({ connectionString: url.href, max: 1 });
  const schema = `upgrade_${randomUUID().replaceAll('-', '')}`;
  const client = await pool.connect();
  t.after(async () => { await client.query(`DROP SCHEMA "${schema}" CASCADE`); client.release(); await pool.end(); });
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(`CREATE TABLE app_settings (id TEXT PRIMARY KEY, cc_settings JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE aa_workflows (id TEXT PRIMARY KEY, llm_model VARCHAR(100) DEFAULT 'openai/gpt-4o',
      llm_fallback_model VARCHAR(100) NOT NULL DEFAULT 'openai/gpt-5.6-luna');`);
  return client;
}
async function upgrade(client, existingInstallation = true, env = {}) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(184920, 110)');
    await upgradeAiModelSettings(client, { existingInstallation, env });
    await ensureWorkflowModelColumns(client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
const settings = async (client) => (await client.query("SELECT cc_settings FROM app_settings WHERE id='default'")).rows[0]?.cc_settings;

test('real PostgreSQL upgrade preserves both old-default and custom workflow models', async (t) => {
  const client = await fixture(t);
  await client.query("INSERT INTO aa_workflows (id) VALUES ('old'); INSERT INTO aa_workflows VALUES ('explicit','openai/gpt-4o','openai/gpt-5.6-luna'),('custom','custom/primary','custom/fallback')");
  const before = (await client.query('SELECT * FROM aa_workflows ORDER BY id')).rows;
  await upgrade(client);
  assert.deepEqual((await client.query('SELECT * FROM aa_workflows ORDER BY id')).rows, before);
  const upgraded = await settings(client);
  assert.equal(upgraded.ai_default_model, 'openai/gpt-4o');
  assert.equal(Object.keys(upgraded.ai_operations).length, 15);
  await client.query("INSERT INTO aa_workflows (id) VALUES ('new')");
  assert.deepEqual((await client.query("SELECT llm_model,llm_fallback_model FROM aa_workflows WHERE id='new'")).rows[0], { llm_model: null, llm_fallback_model: null });
});

test('a restart never restores deliberately cleared models or repeats seeding', async (t) => {
  const client = await fixture(t);
  await upgrade(client);
  const changed = { ai_default_model: 'chosen/default', ai_operations: {}, keep: ['unrelated'] };
  await client.query("UPDATE app_settings SET cc_settings=$1 WHERE id='default'", [changed]);
  await client.query("INSERT INTO aa_workflows VALUES ('cleared',NULL,NULL)");
  await upgrade(client);
  assert.deepEqual(await settings(client), changed);
  assert.deepEqual((await client.query('SELECT llm_model,llm_fallback_model FROM aa_workflows')).rows[0], { llm_model: null, llm_fallback_model: null });
});

test('fresh installs are marked without inheriting historical defaults on a later startup', async (t) => {
  const client = await fixture(t);
  await upgrade(client, false);
  assert.equal(await settings(client), undefined);
  await upgrade(client, true);
  assert.equal(await settings(client), undefined);
});

test('rollback retries the upgrade and preserves current settings', async (t) => {
  const client = await fixture(t);
  await client.query('BEGIN');
  await upgradeAiModelSettings(client, { existingInstallation: true, env: {} });
  await client.query('ROLLBACK');
  const initial = { ai_operations: { 'form-builder': { model: 'saved/form', instructions: 'Keep.' } }, brand: 'Keep brand' };
  await client.query("INSERT INTO app_settings (id,cc_settings) VALUES ('default',$1)", [initial]);
  await upgrade(client, true, { TELNYX_TRANSLATION_MODEL: 'legacy/translation' });
  const result = await settings(client);
  assert.deepEqual(result.ai_operations['form-builder'], initial.ai_operations['form-builder']);
  assert.equal(result.ai_operations['preview-translation'].model, 'legacy/translation');
  assert.equal(result.brand, initial.brand);
});
