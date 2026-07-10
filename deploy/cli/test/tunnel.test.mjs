import assert from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { startQuickTunnel, isProcessAlive, stopTunnel, QUICK_TUNNEL_URL_REGEX } from '../lib/tunnel.mjs';

describe('tunnel.mjs — QUICK_TUNNEL_URL_REGEX', () => {
  it('matches a real cloudflared quick-tunnel URL embedded in log output', () => {
    const line = '2026-07-05T08:14:49Z INF |  https://university-involvement-palm-traffic.trycloudflare.com  |';
    const match = line.match(QUICK_TUNNEL_URL_REGEX);
    assert.ok(match);
    assert.strictEqual(match[0], 'https://university-involvement-palm-traffic.trycloudflare.com');
  });

  it('does not match a bare trycloudflare.com mention without a subdomain', () => {
    // Sanity check on the regex shape — not something cloudflared actually
    // emits, but guards against an overly loose pattern matching junk.
    const line = 'visit trycloudflare.com for more info';
    assert.strictEqual(line.match(QUICK_TUNNEL_URL_REGEX), null);
  });
});

describe('tunnel.mjs — startQuickTunnel', () => {
  let dir;

  it('resolves with the parsed URL once it appears in the log file (fake spawn + fake fs)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-tunnel-test-'));
    const logPath = join(dir, 'tunnel.log');

    // Fake child process: never actually spawns anything. exitCode stays
    // null (still running) throughout, matching a live cloudflared process.
    const fakeChild = new EventEmitter();
    fakeChild.pid = 4242;
    fakeChild.exitCode = null;
    fakeChild.unref = () => {};

    let callCount = 0;
    const fakeReadFile = async () => {
      callCount += 1;
      // First couple of polls: log file doesn't have the URL yet (simulates
      // cloudflared still requesting the tunnel from Cloudflare's edge).
      if (callCount < 3) return 'INF Requesting new quick Tunnel on trycloudflare.com...\n';
      return 'INF |  https://fake-quick-tunnel.trycloudflare.com  |\n';
    };

    const result = await startQuickTunnel({
      port: 3000,
      logPath,
      spawnImpl: () => fakeChild,
      readFileImpl: fakeReadFile,
      pollIntervalMs: 1, // no real waiting in the test
      timeoutMs: 5000,
    });

    assert.strictEqual(result.url, 'https://fake-quick-tunnel.trycloudflare.com');
    assert.strictEqual(result.pid, 4242);
    assert.strictEqual(result.logPath, logPath);
  });

  it('rejects if cloudflared exits before ever reporting a URL', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-tunnel-test-'));
    const logPath = join(dir, 'tunnel.log');
    const fakeChild = new EventEmitter();
    fakeChild.pid = 4243;
    fakeChild.exitCode = 1; // already exited by the time we start polling
    fakeChild.unref = () => {};

    await assert.rejects(
      () => startQuickTunnel({
        port: 3000,
        logPath,
        spawnImpl: () => fakeChild,
        readFileImpl: async () => '',
        pollIntervalMs: 1,
        timeoutMs: 200,
      }),
      /exited early/,
    );
  });

  it('rejects on timeout when no URL ever shows up', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-tunnel-test-'));
    const logPath = join(dir, 'tunnel.log');
    const fakeChild = new EventEmitter();
    fakeChild.pid = 4244;
    fakeChild.exitCode = null;
    fakeChild.unref = () => {};

    await assert.rejects(
      () => startQuickTunnel({
        port: 3000,
        logPath,
        spawnImpl: () => fakeChild,
        readFileImpl: async () => 'still starting up...\n',
        pollIntervalMs: 1,
        timeoutMs: 20,
      }),
      /Timed out/,
    );
  });

  it('rejects when port is missing', async () => {
    await assert.rejects(() => startQuickTunnel({ logPath: '/tmp/x.log' }), /requires \{ port \}/);
  });

  it('truncates a pre-existing log file instead of appending (regression: must not match a stale URL left over from a dead prior tunnel)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-tunnel-test-'));
    const logPath = join(dir, 'tunnel.log');
    // Simulate a leftover log from a previous (now-dead) quick tunnel run.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(logPath, 'INF |  https://stale-old-tunnel.trycloudflare.com  |\n', 'utf8');

    const fakeChild = new EventEmitter();
    fakeChild.pid = 4245;
    fakeChild.exitCode = null;
    fakeChild.unref = () => {};

    // Use the REAL readFile so this exercises the real open('w') truncation
    // performed by startQuickTunnel itself (not a mock). The fake spawn never
    // writes anything new to the fd, so if truncation happened the log stays
    // empty and we must time out WITHOUT ever matching the stale URL.
    await assert.rejects(
      () => startQuickTunnel({
        port: 3000,
        logPath,
        spawnImpl: () => fakeChild,
        pollIntervalMs: 5,
        timeoutMs: 50,
      }),
      /Timed out/,
    );
  });

  it('rejects when logPath is missing', async () => {
    await assert.rejects(() => startQuickTunnel({ port: 3000 }), /requires \{ logPath \}/);
  });
});

describe('tunnel.mjs — isProcessAlive / stopTunnel', () => {
  it('isProcessAlive returns true for the current process (always alive)', () => {
    assert.strictEqual(isProcessAlive(process.pid), true);
  });

  it('isProcessAlive returns false for a pid that does not exist', () => {
    // PID 2^31-1 is never a real process; kill(pid, 0) throws ESRCH.
    assert.strictEqual(isProcessAlive(2147483647), false);
  });

  it('isProcessAlive returns false for falsy pid', () => {
    assert.strictEqual(isProcessAlive(null), false);
    assert.strictEqual(isProcessAlive(undefined), false);
    assert.strictEqual(isProcessAlive(0), false);
  });

  it('stopTunnel returns false for a falsy pid without throwing', () => {
    assert.strictEqual(stopTunnel(null), false);
  });

  it('stopTunnel returns false (not throw) when the pid does not exist', () => {
    assert.strictEqual(stopTunnel(2147483647), false);
  });
});
