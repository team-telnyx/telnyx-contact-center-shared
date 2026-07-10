import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  uploadArtifactToGcs, waitForIapSshReady, runIapSshDeployCommand, deploySingleNodeGcp,
} from '../lib/gcp-deploy.mjs';

describe('gcp-deploy.mjs — uploadArtifactToGcs', () => {
  it('uploads archive/checksum/manifest to the deploy-artifacts/<shortId>/ prefix', async () => {
    const calls = [];
    const execImpl = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: '' };
    };
    const result = await uploadArtifactToGcs({
      bucket: 'cc-main-abcd', shortId: 'abc123',
      archivePath: '/tmp/image.tar.zst', archiveName: 'image.tar.zst',
      checksumPath: '/tmp/image.tar.zst.sha256', manifestPath: '/tmp/manifest.json',
      execImpl,
    });
    assert.strictEqual(result.gcsPrefix, 'gs://cc-main-abcd/deploy-artifacts/abc123');
    assert.strictEqual(calls.length, 3);
    assert.ok(calls.every((c) => c[0] === 'gcloud' && c[1] === 'storage' && c[2] === 'cp'));
    assert.ok(calls[0].includes('gs://cc-main-abcd/deploy-artifacts/abc123/image.tar.zst'));
    assert.ok(calls[1].includes('gs://cc-main-abcd/deploy-artifacts/abc123/image.tar.zst.sha256'));
    assert.ok(calls[2].includes('gs://cc-main-abcd/deploy-artifacts/abc123/manifest.json'));
  });

  it('throws when bucket or shortId is missing', async () => {
    await assert.rejects(() => uploadArtifactToGcs({ shortId: 'x' }), /requires \{ bucket \}/);
    await assert.rejects(() => uploadArtifactToGcs({ bucket: 'b' }), /requires \{ shortId \}/);
  });
});

describe('gcp-deploy.mjs — waitForIapSshReady', () => {
  it('returns ready=true immediately when the first SSH probe succeeds', async () => {
    let calls = 0;
    let capturedArgs = null;
    const execImpl = async (cmd, args) => { calls += 1; capturedArgs = args; return { stdout: '' }; };
    const result = await waitForIapSshReady({
      instanceName: 'cc-main-app', zone: 'us-central1-a', project: 'my-project', execImpl,
    });
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(calls, 1);
    // --quiet suppresses gcloud's interactive SSH-keygen prompt on a
    // workstation that's never run `gcloud compute ssh` before — without
    // it, a first-time GCP deploy can hang/fail waiting on a prompt
    // execFile can never answer (regression: Codex review on PR #1188).
    assert.ok(capturedArgs.includes('--quiet'));
  });

  it('retries until the SSH probe succeeds, sleeping between attempts', async () => {
    let calls = 0;
    const execImpl = async () => {
      calls += 1;
      if (calls < 3) throw new Error('connection refused');
      return { stdout: '' };
    };
    const sleeps = [];
    const result = await waitForIapSshReady({
      instanceName: 'cc-main-app', zone: 'us-central1-a', project: 'my-project', execImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.attempts, 3);
    assert.strictEqual(sleeps.length, 2);
  });

  it('gives up and returns ready=false after the timeout elapses', async () => {
    const execImpl = async () => { throw new Error('connection refused'); };
    let now = 0;
    const result = await waitForIapSshReady({
      instanceName: 'cc-main-app', zone: 'us-central1-a', project: 'my-project', execImpl,
      timeoutMs: 20_000, intervalMs: 5000,
      now: () => now,
      sleep: async () => { now += 5000; },
    });
    assert.strictEqual(result.ready, false);
  });
});

describe('gcp-deploy.mjs — runIapSshDeployCommand', () => {
  it('runs the script via gcloud compute ssh --tunnel-through-iap with env vars exported and forwarded through sudo', async () => {
    let capturedCommand = null;
    let capturedArgs = null;
    const execImpl = async (cmd, args) => {
      assert.strictEqual(cmd, 'gcloud');
      assert.deepStrictEqual(args.slice(0, 2), ['compute', 'ssh']);
      assert.ok(args.includes('--tunnel-through-iap'));
      assert.ok(args.includes('--quiet'));
      capturedArgs = args;
      const idx = args.indexOf('--command');
      capturedCommand = args[idx + 1];
      return { stdout: 'DEPLOY_OK image=x' };
    };
    const result = await runIapSshDeployCommand({
      instanceName: 'cc-main-app', zone: 'us-central1-a', project: 'my-project',
      script: '#!/bin/bash\necho hi\n', gcsPrefix: 'gs://bucket/deploy-artifacts/abc',
      env: { GCP_PROJECT: 'my-project', APP_PORT: 3000 },
      execImpl,
    });
    assert.strictEqual(result.success, true);
    assert.match(capturedCommand, /export GCP_PROJECT='my-project'/);
    assert.match(capturedCommand, /export APP_PORT='3000'/);
    assert.match(capturedCommand, /gs:\/\/bucket\/deploy-artifacts\/abc/);
    // Regression (Codex review on PR #1188, P1): `sudo` resets the
    // environment by default, so the shell-level `export FOO=bar` above
    // never reaches the root process the deploy script runs as. The
    // exported vars must ALSO be forwarded explicitly via `sudo env
    // VAR=val ...` so the deploy script (which runs with `set -u`) doesn't
    // abort on its first env-var reference.
    assert.match(capturedCommand, /sudo env .*GCP_PROJECT='my-project'.*\/tmp\/cc-deploy\.sh/);
    assert.match(capturedCommand, /sudo env .*APP_PORT='3000'.*\/tmp\/cc-deploy\.sh/);
    assert.ok(capturedArgs.includes('--quiet'));
  });

  it('returns success=false with stderr captured when the ssh command fails', async () => {
    const execImpl = async () => {
      const err = new Error('ssh failed');
      err.stderr = 'DEPLOY_OK never printed — health check failed';
      throw err;
    };
    const result = await runIapSshDeployCommand({
      instanceName: 'cc-main-app', zone: 'us-central1-a', project: 'my-project',
      script: 'echo hi', gcsPrefix: 'gs://bucket/x', execImpl,
    });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /health check failed/);
  });
});

describe('gcp-deploy.mjs — deploySingleNodeGcp', () => {
  it('uploads to GCS, waits for IAP SSH, then runs the deploy command', async () => {
    const calls = [];
    const result = await deploySingleNodeGcp({
      instanceName: 'cc-main-app', zone: 'us-central1-a', project: 'my-project', bucket: 'cc-main-abcd',
      artifact: { archivePath: '/tmp/image.tar.zst', archiveName: 'image.tar.zst', checksumPath: '/tmp/x.sha256', manifestPath: '/tmp/manifest.json' },
      appEnvSecretName: 'projects/1/secrets/cc-main-app-env', appPort: 3000, streamingWsPort: 3001,
      uploadArtifactToGcsImpl: async (opts) => { calls.push('upload'); return { gcsPrefix: `gs://${opts.bucket}/deploy-artifacts/${opts.shortId}` }; },
      waitForIapSshReadyImpl: async () => { calls.push('wait'); return { ready: true, attempts: 1 }; },
      runIapSshDeployCommandImpl: async () => { calls.push('deploy'); return { success: true, output: 'DEPLOY_OK' }; },
    });
    assert.deepStrictEqual(calls, ['upload', 'wait', 'deploy']);
    assert.ok(result.gcsPrefix.startsWith('gs://cc-main-abcd/deploy-artifacts/'));
  });

  it('throws when the instance never becomes reachable over IAP SSH', async () => {
    await assert.rejects(
      () => deploySingleNodeGcp({
        instanceName: 'cc-main-app', zone: 'us-central1-a', project: 'my-project', bucket: 'cc-main-abcd',
        artifact: { archivePath: '/tmp/image.tar.zst', archiveName: 'image.tar.zst', checksumPath: '/tmp/x.sha256', manifestPath: '/tmp/manifest.json' },
        appEnvSecretName: 'projects/1/secrets/cc-main-app-env', appPort: 3000, streamingWsPort: 3001,
        uploadArtifactToGcsImpl: async () => ({ gcsPrefix: 'gs://cc-main-abcd/deploy-artifacts/x' }),
        waitForIapSshReadyImpl: async () => ({ ready: false, attempts: 40 }),
        runIapSshDeployCommandImpl: async () => { throw new Error('should not be called'); },
      }),
      /never became reachable/,
    );
  });

  it('throws when the deploy command itself fails', async () => {
    await assert.rejects(
      () => deploySingleNodeGcp({
        instanceName: 'cc-main-app', zone: 'us-central1-a', project: 'my-project', bucket: 'cc-main-abcd',
        artifact: { archivePath: '/tmp/image.tar.zst', archiveName: 'image.tar.zst', checksumPath: '/tmp/x.sha256', manifestPath: '/tmp/manifest.json' },
        appEnvSecretName: 'projects/1/secrets/cc-main-app-env', appPort: 3000, streamingWsPort: 3001,
        uploadArtifactToGcsImpl: async () => ({ gcsPrefix: 'gs://cc-main-abcd/deploy-artifacts/x' }),
        waitForIapSshReadyImpl: async () => ({ ready: true, attempts: 1 }),
        runIapSshDeployCommandImpl: async () => ({ success: false, error: 'health check failed' }),
      }),
      /Single-node GCP deploy failed/,
    );
  });
});
