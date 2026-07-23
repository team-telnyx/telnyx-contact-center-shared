import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deployScript = path.join(repoRoot, 'docker', 'deploy.sh');

describe('docker/deploy.sh Telnyx Credential Connection commands', () => {
  it('passes bash syntax validation', () => {
    const result = spawnSync('bash', ['-n', deployScript], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
  });

  it('documents audit, repair, connection override, and explicit confirmation', () => {
    const result = spawnSync('bash', [deployScript, '--help'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /--audit-telnyx-credentials/);
    assert.match(result.stdout, /--repair-telnyx-credentials/);
    assert.match(result.stdout, /--connection-id <id>/);
    assert.match(result.stdout, /--env-file <path>/);
    assert.match(result.stdout, /--yes/);
    assert.match(result.stdout, /exits with status 2/);
  });

  it('rejects unsafe or ambiguous flag combinations before loading .env', () => {
    const both = spawnSync(
      'bash',
      [deployScript, 'production', '--audit-telnyx-credentials', '--repair-telnyx-credentials'],
      { encoding: 'utf8' },
    );
    assert.strictEqual(both.status, 1);
    assert.match(both.stdout, /only one/);

    const unscopedYes = spawnSync('bash', [deployScript, 'production', '--yes'], {
      encoding: 'utf8',
    });
    assert.strictEqual(unscopedYes.status, 1);
    assert.match(unscopedYes.stdout, /require a Telnyx audit\/repair action/);

    const unscopedEnv = spawnSync(
      'bash',
      [deployScript, 'production', '--env-file', '/tmp/app.env'],
      { encoding: 'utf8' },
    );
    assert.strictEqual(unscopedEnv.status, 1);
    assert.match(unscopedEnv.stdout, /require a Telnyx audit\/repair action/);
  });

  it('loads comments and literal secret characters without xargs quote parsing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-deploy-env-'));
    const envFile = path.join(dir, 'app.env');
    try {
      writeFileSync(
        envFile,
        [
          "# application's URL and host's port are valid comments",
          'TELNYX_API_KEY="key-with-\'apostrophe-$dollar-#hash"',
          '# Intentionally omit TELNYX_SIP_CONNECTION_ID so execution stops before network access.',
          '',
        ].join('\n'),
      );
      const result = spawnSync(
        'bash',
        [deployScript, 'production', '--audit-telnyx-credentials', '--env-file', envFile],
        { encoding: 'utf8' },
      );
      assert.strictEqual(result.status, 1);
      assert.doesNotMatch(result.stderr, /xargs|unterminated quote/i);
      assert.match(result.stderr, /TELNYX_SIP_CONNECTION_ID is missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
