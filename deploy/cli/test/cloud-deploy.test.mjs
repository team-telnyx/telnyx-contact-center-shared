import assert from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAndPackageImage, uploadArtifact, waitForSsmOnline, runSsmDeployCommand,
  deregisterFromAlb, registerWithAlb, deploySingleNode, deployHaRolling, REMOTE_SCRIPTS,
} from '../lib/cloud-deploy.mjs';

const noopSleep = () => Promise.resolve();

describe('cloud-deploy.mjs — REMOTE_SCRIPTS single-node deploy mechanism', () => {
  it('writes the Secrets Manager payload to app.env and runs the container with `docker run --env-file` (no compose.yaml, no Caddy) — same mechanism as HA', () => {
    // Single-node was unified with HA's plain-`docker run` deploy mechanism
    // (see cc-compute-single's user_data.sh.tpl header comment) — Caddy/
    // compose.yaml were removed from the AWS path entirely (TLS is now
    // either an ALB+ACM in front, or the operator's own responsibility for
    // externally-hosted domains). Regression coverage: the remote script
    // must fetch the runtime secret into app.env and pass BOTH env files
    // (--env-file app.env --env-file node.env) to `docker run`, never
    // reference compose.yaml/Caddyfile, and never write to a bare `.env`.
    assert.match(REMOTE_SCRIPTS.single, /> "\$APP_DIR\/app\.env"/);
    assert.doesNotMatch(REMOTE_SCRIPTS.single, /> "\$APP_DIR\/\.env"/);
    assert.match(REMOTE_SCRIPTS.single, /--env-file "\$APP_DIR\/app\.env"/);
    assert.match(REMOTE_SCRIPTS.single, /--env-file "\$APP_DIR\/node\.env"/);
    assert.doesNotMatch(REMOTE_SCRIPTS.single, /docker compose/);
    assert.doesNotMatch(REMOTE_SCRIPTS.single, /caddy/i);
  });

  it('single-node and HA remote scripts use the identical deploy mechanism (unified single-vs-HA behavior)', () => {
    assert.strictEqual(REMOTE_SCRIPTS.single, REMOTE_SCRIPTS.ha);
  });
});

describe('cloud-deploy.mjs — buildAndPackageImage', () => {
  it('runs docker build then docker save|zstd, and returns checksum + manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-cloud-deploy-'));
    const calls = [];
    const execImpl = async (cmd, args, opts) => {
      calls.push({ cmd, args });
      if (cmd === 'bash') {
        // simulate `docker save ... | zstd -o <archivePath>` by writing a fake archive
        const archivePath = `${dir}/image.tar.zst`;
        // Must clear the new MIN_ARCHIVE_BYTES (1MB) floor buildAndPackageImage
        // now enforces (2026-07-09 fix: silent-empty-archive-on-docker-save-
        // failure regression) — a too-small fixture would trip that guard and
        // fail the test with the guard's own error instead of exercising the
        // success path this test is actually for.
        await writeFile(archivePath, Buffer.alloc(2 * 1024 * 1024, 'a'));
      }
      return { stdout: '', stderr: '' };
    };
    const result = await buildAndPackageImage({
      repoRoot: '/repo', imageTag: 'telnyx-contact-center:abc123', outDir: dir, execImpl,
    });
    assert.strictEqual(calls[0].cmd, 'docker');
    assert.strictEqual(calls[0].args[0], 'build');
    assert.ok(calls[0].args.includes('telnyx-contact-center:abc123'));
    assert.strictEqual(calls[1].cmd, 'bash');
    assert.match(calls[1].args[1], /docker save/);
    assert.match(calls[1].args[1], /zstd/);
    assert.match(calls[1].args[1], /set -o pipefail/);
    assert.strictEqual(result.archiveName, 'image.tar.zst');
    assert.match(result.checksumLine, /^[0-9a-f]{64}  image\.tar\.zst\n$/);
    assert.strictEqual(result.manifest.image, 'telnyx-contact-center:abc123');
    await rm(dir, { recursive: true, force: true });
  });

  it('falls back to gzip when useZstd is false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-cloud-deploy-'));
    const calls = [];
    const execImpl = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'bash') await writeFile(`${dir}/image.tar.gz`, Buffer.alloc(2 * 1024 * 1024, 'a'));
      return { stdout: '' };
    };
    const result = await buildAndPackageImage({
      repoRoot: '/repo', imageTag: 'x:y', outDir: dir, useZstd: false, execImpl,
    });
    assert.strictEqual(result.archiveName, 'image.tar.gz');
    assert.match(calls[1].args[1], /gzip/);
    assert.match(calls[1].args[1], /set -o pipefail/);
    await rm(dir, { recursive: true, force: true });
  });

  it('throws when required options are missing', async () => {
    await assert.rejects(() => buildAndPackageImage({ imageTag: 'x', outDir: '/tmp' }), /repoRoot/);
    await assert.rejects(() => buildAndPackageImage({ repoRoot: '/tmp', outDir: '/tmp' }), /imageTag/);
    await assert.rejects(() => buildAndPackageImage({ repoRoot: '/tmp', imageTag: 'x' }), /outDir/);
  });

  it('retries a transient docker build failure and succeeds on the second attempt (2026-07-06 regression: Docker Desktop buildx "permission denied" hiccup)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-cloud-deploy-'));
    let buildAttempts = 0;
    const sleeps = [];
    const execImpl = async (cmd, args) => {
      if (cmd === 'docker') {
        buildAttempts += 1;
        if (buildAttempts === 1) {
          throw new Error('ERROR: failed to build: stat /Users/leszek/.docker/buildx/refs/desktop-linux/desktop-linux: permission denied');
        }
        return { stdout: '' };
      }
      if (cmd === 'bash') await writeFile(`${dir}/image.tar.zst`, Buffer.alloc(2 * 1024 * 1024, 'a'));
      return { stdout: '' };
    };
    const result = await buildAndPackageImage({
      repoRoot: '/repo', imageTag: 'telnyx-contact-center:retry-test', outDir: dir, execImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.strictEqual(buildAttempts, 2);
    assert.deepStrictEqual(sleeps, [5000]);
    assert.strictEqual(result.archiveName, 'image.tar.zst');
    await rm(dir, { recursive: true, force: true });
  });

  it('gives up and throws the last error after exhausting all retries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-cloud-deploy-'));
    let buildAttempts = 0;
    const execImpl = async (cmd) => {
      if (cmd === 'docker') {
        buildAttempts += 1;
        throw new Error('permanent build failure: syntax error in Dockerfile');
      }
      return { stdout: '' };
    };
    await assert.rejects(
      () => buildAndPackageImage({
        repoRoot: '/repo', imageTag: 'x:y', outDir: dir, execImpl, buildRetries: 2, sleep: async () => {},
      }),
      /permanent build failure/,
    );
    assert.strictEqual(buildAttempts, 3); // initial attempt + 2 retries
    await rm(dir, { recursive: true, force: true });
  });

  it('does not retry (and does not sleep) when the build succeeds on the first try', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-cloud-deploy-'));
    let buildAttempts = 0;
    let sleepCalled = false;
    const execImpl = async (cmd) => {
      if (cmd === 'docker') { buildAttempts += 1; return { stdout: '' }; }
      if (cmd === 'bash') await writeFile(`${dir}/image.tar.zst`, Buffer.alloc(2 * 1024 * 1024, 'a'));
      return { stdout: '' };
    };
    await buildAndPackageImage({
      repoRoot: '/repo', imageTag: 'x:y', outDir: dir, execImpl, sleep: async () => { sleepCalled = true; },
    });
    assert.strictEqual(buildAttempts, 1);
    assert.strictEqual(sleepCalled, false);
    await rm(dir, { recursive: true, force: true });
  });

  it('throws a clear error instead of shipping a bogus archive when `docker save` fails silently inside the pipe (2026-07-09 regression: Azure/AWS/GCP deploy failing on the VM with no useful error, 5-10 minutes after the fact)', async () => {
    // Reproduces the real-world failure: `docker save <tag> | zstd -o <path>`
    // run without `set -o pipefail` lets a failed `docker save` (image not
    // found in the local store — confirmed in the wild right after a
    // `--platform linux/amd64` build) still exit 0 overall, because only
    // zstd's own exit code (compressing empty stdin, which "succeeds") is
    // checked. The fix adds `set -o pipefail` AND a minimum-archive-size
    // floor as defense in depth. This test simulates the fixture writing a
    // tiny (garbage) archive — as `docker save` piping nothing through zstd
    // really does — and asserts buildAndPackageImage refuses to treat that
    // as a successful build.
    const dir = await mkdtemp(join(tmpdir(), 'cc-cloud-deploy-'));
    const execImpl = async (cmd) => {
      if (cmd === 'docker') return { stdout: '' };
      // Simulate the exact real-world garbage: zstd's own empty-stdin output size.
      if (cmd === 'bash') await writeFile(`${dir}/image.tar.zst`, Buffer.alloc(13, 0));
      return { stdout: '' };
    };
    await assert.rejects(
      () => buildAndPackageImage({
        repoRoot: '/repo', imageTag: 'telnyx-contact-center:broken-save', outDir: dir, execImpl,
      }),
      /suspiciously small.*13 bytes.*docker save telnyx-contact-center:broken-save.*likely failed silently/s,
    );
    await rm(dir, { recursive: true, force: true });
  });
});

describe('cloud-deploy.mjs — uploadArtifact', () => {
  it('uploads archive, checksum, manifest, and any extra files to the deploy-artifacts prefix', async () => {
    const calls = [];
    const execImpl = async (cmd, args) => { calls.push(args); return { stdout: '' }; };
    const result = await uploadArtifact({
      bucket: 'cc-main-abcd1234',
      shortId: 'deadbeef1234',
      archivePath: '/tmp/image.tar.zst',
      archiveName: 'image.tar.zst',
      checksumPath: '/tmp/image.tar.zst.sha256',
      manifestPath: '/tmp/manifest.json',
      extraFiles: { 'compose.yaml': '/tmp/compose.yaml', Caddyfile: '/tmp/Caddyfile' },
      execImpl,
    });
    assert.strictEqual(result.s3Prefix, 's3://cc-main-abcd1234/deploy-artifacts/deadbeef1234');
    assert.strictEqual(calls.length, 5); // archive, checksum, manifest, compose.yaml, Caddyfile
    assert.ok(calls[0].includes('s3://cc-main-abcd1234/deploy-artifacts/deadbeef1234/image.tar.zst'));
    assert.ok(calls[3].includes('s3://cc-main-abcd1234/deploy-artifacts/deadbeef1234/compose.yaml'));
  });

  it('throws when bucket or shortId missing', async () => {
    await assert.rejects(() => uploadArtifact({ shortId: 'x' }), /bucket/);
    await assert.rejects(() => uploadArtifact({ bucket: 'x' }), /shortId/);
  });
});

describe('cloud-deploy.mjs — waitForSsmOnline', () => {
  it('resolves online:true as soon as PingStatus is Online', async () => {
    let call = 0;
    const execImpl = async () => {
      call += 1;
      const status = call < 3 ? 'ConnectionLost' : 'Online';
      return { stdout: JSON.stringify({ InstanceInformationList: [{ PingStatus: status }] }) };
    };
    const result = await waitForSsmOnline({ instanceId: 'i-123', execImpl, sleep: noopSleep, intervalMs: 0 });
    assert.strictEqual(result.online, true);
    assert.strictEqual(call, 3);
  });

  it('resolves online:false when the instance never registers (empty list) and times out', async () => {
    let now = 0;
    const execImpl = async () => ({ stdout: JSON.stringify({ InstanceInformationList: [] }) });
    const result = await waitForSsmOnline({
      instanceId: 'i-123', execImpl, sleep: noopSleep,
      now: () => { now += 50; return now; },
      timeoutMs: 120,
      intervalMs: 0,
    });
    assert.strictEqual(result.online, false);
  });

  it('treats a describe-instance-information error as "not yet online" rather than throwing', async () => {
    let call = 0;
    const execImpl = async () => {
      call += 1;
      if (call < 2) throw new Error('AccessDenied transient');
      return { stdout: JSON.stringify({ InstanceInformationList: [{ PingStatus: 'Online' }] }) };
    };
    const result = await waitForSsmOnline({ instanceId: 'i-123', execImpl, sleep: noopSleep });
    assert.strictEqual(result.online, true);
  });

  it('throws when instanceId is missing', async () => {
    await assert.rejects(() => waitForSsmOnline({}), /instanceId/);
  });
});

describe('cloud-deploy.mjs — runSsmDeployCommand', () => {
  it('passes --parameters as full JSON (not the commands=[...] shorthand, which mangles multi-line scripts)', async () => {
    let sendArgs;
    const execImpl = async (cmd, args) => {
      if (args[0] === 'ssm' && args[1] === 'send-command') {
        sendArgs = args;
        return { stdout: JSON.stringify({ Command: { CommandId: 'cmd-shape' } }) };
      }
      if (args[0] === 'ssm' && args[1] === 'get-command-invocation') {
        return { stdout: JSON.stringify({ Status: 'Success', StandardOutputContent: 'DEPLOY_OK image=x:y\n' }) };
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    await runSsmDeployCommand({
      instanceId: 'i-1', region: 'us-east-2', s3Prefix: 's3://bucket/deploy-artifacts/abc',
      script: REMOTE_SCRIPTS.single, execImpl, sleep: noopSleep,
    });
    const idx = sendArgs.indexOf('--parameters');
    assert.ok(idx !== -1, '--parameters flag must be present');
    const paramsValue = sendArgs[idx + 1];
    // Must NOT be the AWS CLI shorthand form (`commands=[...]`), which splits
    // on commas/brackets and corrupts a multi-line shell script embedded as
    // a single command string. Must be parseable as full JSON with a
    // `commands` array instead.
    assert.ok(!paramsValue.startsWith('commands='), '--parameters must not use the commands=[...] shorthand syntax');
    const parsed = JSON.parse(paramsValue);
    assert.ok(Array.isArray(parsed.commands), '--parameters JSON must have a commands array');
    assert.strictEqual(parsed.commands.length, 1);
    assert.match(parsed.commands[0], /cc-deploy\.sh/);
  });

  it('sends the command and polls get-command-invocation until Success', async () => {
    let pollCount = 0;
    const execImpl = async (cmd, args) => {
      if (args[0] === 'ssm' && args[1] === 'send-command') {
        return { stdout: JSON.stringify({ Command: { CommandId: 'cmd-1' } }) };
      }
      if (args[0] === 'ssm' && args[1] === 'get-command-invocation') {
        pollCount += 1;
        const status = pollCount < 2 ? 'InProgress' : 'Success';
        return { stdout: JSON.stringify({ Status: status, StandardOutputContent: 'DEPLOY_OK image=x:y\n' }) };
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    const result = await runSsmDeployCommand({
      instanceId: 'i-1', region: 'us-east-2', s3Prefix: 's3://bucket/deploy-artifacts/abc',
      script: REMOTE_SCRIPTS.single, execImpl, sleep: noopSleep,
    });
    assert.strictEqual(result.success, true);
    assert.match(result.output, /DEPLOY_OK/);
  });

  it('reports failure with stderr content when the remote script fails', async () => {
    const execImpl = async (cmd, args) => {
      if (args[0] === 'ssm' && args[1] === 'send-command') return { stdout: JSON.stringify({ Command: { CommandId: 'cmd-2' } }) };
      if (args[0] === 'ssm' && args[1] === 'get-command-invocation') {
        return { stdout: JSON.stringify({ Status: 'Failed', StandardErrorContent: 'health check failed\n' }) };
      }
      throw new Error('unexpected');
    };
    const result = await runSsmDeployCommand({
      instanceId: 'i-1', region: 'us-east-2', s3Prefix: 's3://bucket/x', script: REMOTE_SCRIPTS.ha, execImpl, sleep: noopSleep,
    });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /health check failed/);
  });

  it('throws when send-command does not return a CommandId', async () => {
    const execImpl = async () => ({ stdout: JSON.stringify({}) });
    await assert.rejects(
      () => runSsmDeployCommand({ instanceId: 'i-1', region: 'us-east-1', s3Prefix: 's3://b/x', script: 'x', execImpl, sleep: noopSleep }),
      /CommandId/,
    );
  });

  it('times out client-side if the invocation never reaches a terminal state', async () => {
    let now = 0;
    const execImpl = async (cmd, args) => {
      if (args[0] === 'ssm' && args[1] === 'send-command') return { stdout: JSON.stringify({ Command: { CommandId: 'cmd-3' } }) };
      return { stdout: JSON.stringify({ Status: 'InProgress' }) };
    };
    const result = await runSsmDeployCommand({
      instanceId: 'i-1', region: 'us-east-1', s3Prefix: 's3://b/x', script: 'x', execImpl,
      sleep: noopSleep, now: () => { now += 100; return now; }, timeoutMs: 250, pollIntervalMs: 0,
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'ClientTimeout');
  });
});

describe('cloud-deploy.mjs — ALB drain/register helpers', () => {
  it('deregisterFromAlb: deregisters both target groups and waits for unused', async () => {
    const calls = [];
    const execImpl = async (cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'elbv2' && args[1] === 'describe-target-health') {
        return { stdout: JSON.stringify({ TargetHealthDescriptions: [{ TargetHealth: { State: 'unused' } }] }) };
      }
      return { stdout: '' };
    };
    await deregisterFromAlb({
      appTargetGroupArn: 'arn:app', wsTargetGroupArn: 'arn:ws', instanceId: 'i-1',
      appPort: 3000, wsPort: 3001, region: 'us-east-2', execImpl, sleep: noopSleep,
    });
    assert.ok(calls.some((c) => c.includes('deregister-targets') && c.includes('arn:app')));
    assert.ok(calls.some((c) => c.includes('deregister-targets') && c.includes('arn:ws')));
  });

  it('registerWithAlb: throws if targets never become healthy within maxAttempts', async () => {
    const execImpl = async (cmd, args) => {
      if (args[0] === 'elbv2' && args[1] === 'describe-target-health') {
        return { stdout: JSON.stringify({ TargetHealthDescriptions: [{ TargetHealth: { State: 'unhealthy' } }] }) };
      }
      return { stdout: '' };
    };
    await assert.rejects(
      () => registerWithAlb({
        appTargetGroupArn: 'arn:app', wsTargetGroupArn: 'arn:ws', instanceId: 'i-1',
        appPort: 3000, wsPort: 3001, region: 'us-east-2', execImpl, sleep: noopSleep,
      }),
      /did not become healthy/,
    );
  });

  it('registerWithAlb: resolves once both target groups report healthy', async () => {
    const execImpl = async (cmd, args) => {
      if (args[0] === 'elbv2' && args[1] === 'describe-target-health') {
        return { stdout: JSON.stringify({ TargetHealthDescriptions: [{ TargetHealth: { State: 'healthy' } }] }) };
      }
      return { stdout: '' };
    };
    await registerWithAlb({
      appTargetGroupArn: 'arn:app', wsTargetGroupArn: 'arn:ws', instanceId: 'i-1',
      appPort: 3000, wsPort: 3001, region: 'us-east-2', execImpl, sleep: noopSleep,
    });
  });
});

describe('cloud-deploy.mjs — deploySingleNode', () => {
  it('waits for SSM online then runs the deploy command; throws if SSM never comes online', async () => {
    const waitForSsmOnlineImpl = async () => ({ online: false, attempts: 36 });
    await assert.rejects(
      () => deploySingleNode({
        instanceId: 'i-1', region: 'us-east-2', s3Prefix: 's3://b/x', appEnvSecretName: 'cc-main/app/env',
        appPort: 3000, streamingWsPort: 3001, waitForSsmOnlineImpl, sleep: noopSleep,
      }),
      /never registered with SSM/,
    );
  });

  it('propagates a clear error when the remote deploy script fails', async () => {
    const waitForSsmOnlineImpl = async () => ({ online: true, attempts: 1 });
    const runSsmDeployCommandImpl = async () => ({ success: false, status: 'Failed', error: 'boom' });
    await assert.rejects(
      () => deploySingleNode({
        instanceId: 'i-1', region: 'us-east-2', s3Prefix: 's3://b/x', appEnvSecretName: 'cc-main/app/env',
        appPort: 3000, streamingWsPort: 3001, waitForSsmOnlineImpl, runSsmDeployCommandImpl, sleep: noopSleep,
      }),
      /Single-node deploy failed.*boom/s,
    );
  });

  it('resolves with the deploy result on success', async () => {
    const waitForSsmOnlineImpl = async () => ({ online: true, attempts: 1 });
    const runSsmDeployCommandImpl = async () => ({ success: true, output: 'DEPLOY_OK image=x:y' });
    const result = await deploySingleNode({
      instanceId: 'i-1', region: 'us-east-2', s3Prefix: 's3://b/x', appEnvSecretName: 'cc-main/app/env',
      appPort: 3000, streamingWsPort: 3001, waitForSsmOnlineImpl, runSsmDeployCommandImpl, sleep: noopSleep,
    });
    assert.strictEqual(result.success, true);
  });
});

describe('cloud-deploy.mjs — deployHaRolling', () => {
  it('deploys nodes one at a time, deregister -> deploy -> register, in order', async () => {
    const order = [];
    const waitForSsmOnlineImpl = async ({ instanceId }) => { order.push(`ssm-wait:${instanceId}`); return { online: true }; };
    const deregisterFromAlbImpl = async ({ instanceId }) => { order.push(`deregister:${instanceId}`); };
    const runSsmDeployCommandImpl = async ({ instanceId }) => { order.push(`deploy:${instanceId}`); return { success: true, output: 'ok' }; };
    const registerWithAlbImpl = async ({ instanceId }) => { order.push(`register:${instanceId}`); };

    const results = await deployHaRolling({
      instanceIds: ['i-1', 'i-2'], region: 'us-east-2', s3Prefix: 's3://b/x',
      appEnvSecretName: 'cc-main/app/env', appPort: 3000, streamingWsPort: 3001,
      appTargetGroupArn: 'arn:app', wsTargetGroupArn: 'arn:ws',
      waitForSsmOnlineImpl, deregisterFromAlbImpl, runSsmDeployCommandImpl, registerWithAlbImpl, sleep: noopSleep,
    });

    assert.deepStrictEqual(order, [
      'ssm-wait:i-1', 'deregister:i-1', 'deploy:i-1', 'register:i-1',
      'ssm-wait:i-2', 'deregister:i-2', 'deploy:i-2', 'register:i-2',
    ]);
    assert.strictEqual(results.length, 2);
  });

  it('stops the rollout (does not proceed to next node) if a node fails deploy', async () => {
    const order = [];
    const waitForSsmOnlineImpl = async ({ instanceId }) => ({ online: true });
    const deregisterFromAlbImpl = async ({ instanceId }) => { order.push(`deregister:${instanceId}`); };
    const runSsmDeployCommandImpl = async ({ instanceId }) => {
      order.push(`deploy:${instanceId}`);
      if (instanceId === 'i-1') return { success: false, status: 'Failed', error: 'oom' };
      return { success: true };
    };
    const registerWithAlbImpl = async ({ instanceId }) => { order.push(`register:${instanceId}`); };

    await assert.rejects(
      () => deployHaRolling({
        instanceIds: ['i-1', 'i-2'], region: 'us-east-2', s3Prefix: 's3://b/x',
        appEnvSecretName: 'cc-main/app/env', appPort: 3000, streamingWsPort: 3001,
        appTargetGroupArn: 'arn:app', wsTargetGroupArn: 'arn:ws',
        waitForSsmOnlineImpl, deregisterFromAlbImpl, runSsmDeployCommandImpl, registerWithAlbImpl, sleep: noopSleep,
      }),
      /HA rolling deploy failed on i-1.*oom/s,
    );
    assert.ok(!order.includes('deploy:i-2'), 'must not attempt node 2 after node 1 fails');
  });

  it('throws if a node never registers with SSM, without attempting deploy on it', async () => {
    const order = [];
    const waitForSsmOnlineImpl = async ({ instanceId }) => ({ online: false, attempts: 36 });
    const runSsmDeployCommandImpl = async ({ instanceId }) => { order.push(instanceId); return { success: true }; };
    await assert.rejects(
      () => deployHaRolling({
        instanceIds: ['i-1'], region: 'us-east-2', s3Prefix: 's3://b/x',
        appEnvSecretName: 'cc-main/app/env', appPort: 3000, streamingWsPort: 3001,
        appTargetGroupArn: 'arn:app', wsTargetGroupArn: 'arn:ws',
        waitForSsmOnlineImpl, runSsmDeployCommandImpl, sleep: noopSleep,
      }),
      /never registered with SSM/,
    );
    assert.strictEqual(order.length, 0);
  });
});
