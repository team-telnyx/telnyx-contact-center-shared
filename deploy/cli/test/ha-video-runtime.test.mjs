import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HA_VIDEO_SETUP, HA_VIDEO_PREFLIGHT } from '../lib/ha-video-runtime.mjs';

test('HA shell preflight rejects missing, loopback and local-disk configuration; publishes private relay and shared mount', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-ha-video-'));
  const shared = join(dir, 'private-recordings');
  try {
    await mkdir(shared, { mode: 0o700 });
    await writeFile(join(dir, 'app.env'), '');
    await writeFile(join(dir, 'ip'), '#!/bin/sh\nprintf "2: eth0 inet 10.0.1.7/24 scope global eth0\\n"\n', { mode: 0o755 });
    await writeFile(join(dir, 'findmnt'), '#!/bin/sh\nprintf "%s\\n" "$CC_TEST_FS"\n', { mode: 0o755 });
    const run = async (settings, fs = 'nfs4') => {
      await writeFile(join(dir, 'node.env'), settings);
      return spawnSync('bash', ['-c', 'set -euo pipefail\nAPP_DIR="$1"\n' + HA_VIDEO_SETUP + '\nprintf "%s\\n" "${video_args[@]}"\n', 'ha-test', dir], {
        encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CC_TEST_FS: fs },
      });
    };
    const fresh = await run('');
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(fresh.stdout.trim(), '--env\nVIDEO_CONFERENCE_AI_ENABLED=false');
    const missing = await run('VIDEO_CONFERENCE_AI_ENABLED=true\n');
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /VIDEO_AI_PRIVATE_IP/);
    const loopback = await run(`VIDEO_CONFERENCE_AI_ENABLED=true\nVIDEO_AI_PRIVATE_IP=127.0.0.1\nCC_VIDEO_RECORDINGS_PATH=${shared}\n`);
    assert.notEqual(loopback.status, 0);
    const settings = `VIDEO_CONFERENCE_AI_ENABLED=true\nVIDEO_AI_PRIVATE_IP=10.0.1.7\nCC_VIDEO_RECORDINGS_PATH=${shared}\n`;
    const local = await run(settings, 'ext4');
    assert.notEqual(local.status, 0); assert.match(local.stderr, /mounted shared filesystem/);
    const foreign = await run(settings.replace('10.0.1.7', '10.0.2.9'));
    assert.notEqual(foreign.status, 0); assert.match(foreign.stderr, /not assigned/);
    const valid = await run(settings);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /VIDEO_AI_CONTROL_URL=http:\/\/10\.0\.1\.7:3092/);
    assert.match(valid.stdout, /--publish\n10\.0\.1\.7:3092:3092/);
    assert.ok(valid.stdout.includes(`type=bind,source=${shared},target=/app/.data/video-recordings`));
    assert.doesNotMatch(valid.stdout, /type=volume|127\.0\.0\.1/);
    const disabled = await run('VIDEO_CONFERENCE_AI_ENABLED=false\n', 'ext4');
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(disabled.stdout.trim(), '--env\nVIDEO_CONFERENCE_AI_ENABLED=false');
    const playback = await run(`VIDEO_CONFERENCE_AI_ENABLED=false\nCC_VIDEO_RECORDINGS_PATH=${shared}\n`);
    assert.equal(playback.status, 0, playback.stderr);
    assert.ok(playback.stdout.includes(`type=bind,source=${shared}`));
    assert.doesNotMatch(playback.stdout, /--publish/);
    assert.equal(spawnSync('bash', ['-n'], { input: HA_VIDEO_PREFLIGHT }).status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('HA infrastructure restricts relay ingress to app nodes and threads the same port into bootstrap', async () => {
  const read = path => readFile(new URL(`../../terraform/${path}`, import.meta.url), 'utf8');
  const network = await read('modules/cc-network/main.tf');
  const rule = network.match(/dynamic "ingress" \{\s*for_each = var\.topology == "ha"[\s\S]*?\n  \}/)?.[0];
  assert.ok(rule, 'relay rule must only exist for HA');
  assert.match(rule, /self\s*=\s*true/);
  assert.match(rule, /from_port\s*=\s*var.video_ai_control_port/);
  assert.match(rule, /to_port\s*=\s*var.video_ai_control_port/);
  assert.doesNotMatch(rule, /cidr_blocks|security_groups/);
  const root = await read('aws/multi-node/main.tf');
  for (const module of ['network', 'compute']) {
    assert.match(root.match(new RegExp(`module "${module}" \\{[\\s\\S]*?\\n\\}`))?.[0] || '', /video_ai_control_port\s*=\s*var.video_ai_control_port/);
  }
  assert.match(await read('modules/cc-compute-ha/main.tf'), /video_ai_control_port\s*=\s*var.video_ai_control_port/);
  const bootstrap = await read('modules/cc-compute-ha/templates/user_data.sh.tpl');
  assert.match(bootstrap, /VIDEO_AI_CONTROL_PORT=\$\{video_ai_control_port\}/);
  assert.match(bootstrap, /VIDEO_CONFERENCE_AI_ENABLED=false/);
});
