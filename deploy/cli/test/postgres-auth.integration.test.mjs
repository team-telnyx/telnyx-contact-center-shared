import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { it } from 'node:test';

const execFileAsync = promisify(execFile);

async function waitForPostgres(containerName) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await execFileAsync('docker', [
        'exec', containerName,
        'pg_isready', '-h', '127.0.0.1', '-U', 'cc_test', '-d', 'cc_test',
      ]);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error('PostgreSQL did not become ready');
}

it('fresh bundled PostgreSQL uses SCRAM and rejects an invalid TCP password', async (t) => {
  try {
    await execFileAsync('docker', ['info']);
  } catch {
    return t.skip('Docker daemon is not available');
  }

  const containerName = `cc-postgres-auth-test-${process.pid}-${Date.now()}`;
  const password = 'cc-test-password-with-32-characters';

  try {
    await execFileAsync('docker', [
      'run', '-d', '--name', containerName,
      '-e', 'POSTGRES_DB=cc_test',
      '-e', 'POSTGRES_USER=cc_test',
      '-e', `POSTGRES_PASSWORD=${password}`,
      '-e', 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
      '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
      'postgres:17-alpine',
    ]);

    await waitForPostgres(containerName);

    const correct = await execFileAsync('docker', [
      'exec', '-e', `PGPASSWORD=${password}`, containerName,
      'psql', '-h', '127.0.0.1', '-U', 'cc_test', '-d', 'cc_test', '-Atc', 'SELECT 1',
    ]);
    assert.strictEqual(correct.stdout.trim(), '1');

    await assert.rejects(
      execFileAsync('docker', [
        'exec', '-e', 'PGPASSWORD=__cc_invalid_password__', containerName,
        'psql', '-h', '127.0.0.1', '-U', 'cc_test', '-d', 'cc_test', '-Atc', 'SELECT 1',
      ]),
      (error) => /password authentication failed/i.test(`${error.stderr || ''}${error.message || ''}`),
    );

    const hba = await execFileAsync('docker', [
      'exec', '-e', `PGPASSWORD=${password}`, containerName,
      'psql', '-h', '127.0.0.1', '-U', 'cc_test', '-d', 'cc_test', '-Atc',
      "SELECT string_agg(type || ':' || auth_method, ',') FROM pg_hba_file_rules WHERE type LIKE 'host%';",
    ]);
    assert.match(hba.stdout, /scram-sha-256/);
    assert.doesNotMatch(hba.stdout, /trust/);

    const verifier = await execFileAsync('docker', [
      'exec', '-e', `PGPASSWORD=${password}`, containerName,
      'psql', '-h', '127.0.0.1', '-U', 'cc_test', '-d', 'cc_test', '-Atc',
      "SELECT rolpassword FROM pg_authid WHERE rolname = 'cc_test';",
    ]);
    assert.match(verifier.stdout, /^SCRAM-SHA-256\$/);
  } finally {
    // `postgres:17-alpine` declares a data volume; `-v` removes the anonymous
    // test volume together with the one-off container.
    await execFileAsync('docker', ['rm', '-f', '-v', containerName]).catch(() => {});
  }
});
