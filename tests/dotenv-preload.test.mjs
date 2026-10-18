import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('cutover bootstrap keeps dotenv/config, selected env file and clean JSON output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dotenv-preload-'));
  try {
    const envFile = path.join(dir, 'selected.env');
    fs.writeFileSync(envFile, 'CC_DOTENV_TEST_MARKER=selected-file\nLOG_LEVEL=silent\nLOG_DB_LEVEL=silent\n');
    const env = { ...process.env, DOTENV_CONFIG_PATH: envFile, DOTENV_CONFIG_QUIET: 'false', DOTENV_QUIET: 'false' };
    delete env.DOTENV_PATH;
    delete env.CC_DOTENV_TEST_MARKER;
    const entry = new URL('../scripts/acd-core-cutover-reset.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(entry)}); console.log(JSON.stringify({marker:process.env.CC_DOTENV_TEST_MARKER}));`],
    { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { marker: 'selected-file' });
    assert(!result.stderr.includes('injected env'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
