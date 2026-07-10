import assert from 'node:assert';
import { describe, it } from 'node:test';
import { waitForHealthy } from '../lib/health.mjs';

function fakeClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
}

describe('health.mjs waitForHealthy', () => {
  it('resolves immediately when the endpoint is healthy on the first attempt', async () => {
    const clock = fakeClock();
    const fetchImpl = async () => ({ ok: true, json: async () => ({ status: 'healthy', database: 'connected' }) });
    const result = await waitForHealthy({ url: 'http://x/api/health', fetchImpl, now: clock.now, sleep: clock.sleep });
    assert.strictEqual(result.healthy, true);
    assert.strictEqual(result.attempts, 1);
  });

  it('retries until healthy, using the interval between attempts', async () => {
    const clock = fakeClock();
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      if (call < 3) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ status: 'healthy' }) };
    };
    const attempts = [];
    const result = await waitForHealthy({
      url: 'http://x/api/health',
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 2000,
      onAttempt: (a) => attempts.push(a),
    });
    assert.strictEqual(result.healthy, true);
    assert.strictEqual(result.attempts, 3);
    assert.strictEqual(attempts.length, 3);
  });

  it('treats HTTP ok with no recognizable status field as healthy (tolerant of non-JSON/legacy bodies)', async () => {
    const clock = fakeClock();
    const fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('not json'); } });
    const result = await waitForHealthy({ url: 'http://x/api/health', fetchImpl, now: clock.now, sleep: clock.sleep });
    assert.strictEqual(result.healthy, true);
  });

  it('does not treat status:"unhealthy" as healthy even when HTTP is ok', async () => {
    const clock = fakeClock();
    const fetchImpl = async () => ({ ok: true, json: async () => ({ status: 'degraded', database: 'disconnected' }) });
    const result = await waitForHealthy({
      url: 'http://x/api/health', fetchImpl, now: clock.now, sleep: clock.sleep,
      timeoutMs: 5000, intervalMs: 2000,
    });
    assert.strictEqual(result.healthy, false);
  });

  it('times out and returns healthy:false with the last error when the endpoint never comes up', async () => {
    const clock = fakeClock();
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const result = await waitForHealthy({
      url: 'http://x/api/health', fetchImpl, now: clock.now, sleep: clock.sleep,
      timeoutMs: 6000, intervalMs: 2000,
    });
    assert.strictEqual(result.healthy, false);
    assert.ok(result.error);
    assert.match(result.error.message, /ECONNREFUSED/);
  });

  it('throws synchronously if called without a url', async () => {
    await assert.rejects(() => waitForHealthy({}), /requires a url/);
  });
});
