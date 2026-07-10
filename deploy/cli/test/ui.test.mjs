import assert from 'node:assert';
import { describe, it } from 'node:test';
import { longStep, step, persistGeneratedSecrets } from '../lib/ui.mjs';

describe('ui.mjs — longStep (TTY path)', () => {
  it('renders an initial spinner frame with elapsed time on construction', () => {
    const writes = [];
    const s = longStep('Building containers', {
      isTTY: true,
      write: (str) => writes.push(str),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
      now: () => 1000,
    });
    s.stop();
    // 2 writes expected: initial spinner frame + the clearLine from stop().
    assert.strictEqual(writes.length, 2);
    // First write is the spinner frame with label + (0s) timestamp.
    assert.match(writes[0], /⠋/);
    assert.match(writes[0], /Building containers/);
    assert.match(writes[0], /\(0s\)/);
    assert.ok(writes[0].startsWith('\r\x1b[K'));
    // Second write is the clear-line escape from stop() (so the next console.log
    // starts on a fresh line).
    assert.strictEqual(writes[1], '\r\x1b[K');
  });

  it('rotates through spinner frames on each tick', () => {
    const writes = [];
    const fakeNow = { v: 1000 };
    const tickHolder = {};
    const s = longStep('Build', {
      isTTY: true,
      write: (str) => writes.push(str),
      setIntervalFn: (fn) => { tickHolder.tick = fn; return 1; },
      clearIntervalFn: () => {},
      now: () => fakeNow.v,
    });
    // First write happens in the constructor.
    assert.strictEqual(writes.length, 1);
    tickHolder.tick();
    tickHolder.tick();
    assert.strictEqual(writes.length, 3);
    // Each frame starts with \r\x1b[K (overwrite-in-place).
    assert.ok(writes[1].startsWith('\r\x1b[K'));
    assert.ok(writes[2].startsWith('\r\x1b[K'));
    // Frame counter advances — first three glyphs are ⠋ ⠙ ⠹.
    assert.match(writes[0], /⠋/);
    assert.match(writes[1], /⠙/);
    assert.match(writes[2], /⠹/);
    s.stop();
  });

  it('updates elapsed seconds on each render', () => {
    const writes = [];
    const fakeNow = { v: 1000 };
    const tickHolder = {};
    const s = longStep('Build', {
      isTTY: true,
      write: (str) => writes.push(str),
      setIntervalFn: (fn) => { tickHolder.tick = fn; return 1; },
      clearIntervalFn: () => {},
      now: () => fakeNow.v,
    });
    // Advance virtual time to 5 seconds elapsed (startedAt = 1000, now = 6000).
    fakeNow.v = 6000;
    tickHolder.tick();
    assert.match(writes[writes.length - 1], /\(5s\)/);
    s.stop();
  });

  it('emits a "still running" hint when crossing the 30s threshold', () => {
    const writes = [];
    const fakeNow = { v: 1000 };
    const tickHolder = {};
    const s = longStep('Build', {
      isTTY: true,
      write: (str) => writes.push(str),
      setIntervalFn: (fn) => { tickHolder.tick = fn; return 1; },
      clearIntervalFn: () => {},
      now: () => fakeNow.v,
    });
    // Cross 30s — the render at exactly 30s should include both the spinner frame
    // (with (30s) elapsed) and the still-running hint. The implementation writes
    // them in two separate stdout.write() calls so we look across all writes.
    fakeNow.v = 31000;
    tickHolder.tick();
    const all = writes.join('');
    assert.match(all, /\(30s\)/);
    assert.match(all, /still running/i);
    s.stop();
  });

  it('does NOT re-emit the hint on subsequent ticks within the same threshold window', () => {
    const writes = [];
    const fakeNow = { v: 1000 };
    const tickHolder = {};
    const s = longStep('Build', {
      isTTY: true,
      write: (str) => writes.push(str),
      setIntervalFn: (fn) => { tickHolder.tick = fn; return 1; },
      clearIntervalFn: () => {},
      now: () => fakeNow.v,
    });
    fakeNow.v = 31000;
    tickHolder.tick();
    fakeNow.v = 32000;
    tickHolder.tick();
    // Exactly one hint line emitted (from the 30s tick).
    const hintLines = writes.filter((w) => /still running/i.test(w));
    assert.strictEqual(hintLines.length, 1, `expected 1 hint, got ${hintLines.length}`);
    s.stop();
  });

  it('succeed() stops the spinner, clears the line, and prints ✔ with elapsed time', () => {
    const writes = [];
    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => logLines.push(args.join(' '));
    try {
      const fakeNow = { v: 1000 };
      const s = longStep('Build', {
        isTTY: true,
        write: (str) => writes.push(str),
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
        now: () => fakeNow.v,
      });
      // Advance 4 seconds (fakeNow 1000 -> 5000 → elapsed = 4000ms = 4s).
      fakeNow.v = 5000;
      s.succeed('Containers started');
      // The trailing write must be the clear-line escape.
      assert.strictEqual(writes[writes.length - 1], '\r\x1b[K');
      // And console.log printed the success line with ✔ + elapsed.
      assert.strictEqual(logLines.length, 1);
      assert.match(logLines[0], /✔/);
      assert.match(logLines[0], /Containers started/);
      assert.match(logLines[0], /\(4s\)/);
    } finally {
      console.log = origLog;
    }
  });

  it('fail() prints ✖ with elapsed time', () => {
    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => logLines.push(args.join(' '));
    try {
      const fakeNow = { v: 1000 };
      const s = longStep('Build', {
        isTTY: true,
        write: () => {},
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
        now: () => fakeNow.v,
      });
      // 12000 - 1000 = 11000ms = 11s.
      fakeNow.v = 12000;
      s.fail('docker compose failed');
      assert.strictEqual(logLines.length, 1);
      assert.match(logLines[0], /✖/);
      assert.match(logLines[0], /\(11s\)/);
    } finally {
      console.log = origLog;
    }
  });

  it('stop() is idempotent — calling succeed() then stop() does not double-clear', () => {
    const writes = [];
    const fakeNow = { v: 1000 };
    const s = longStep('Build', {
      isTTY: true,
      write: (str) => writes.push(str),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      now: () => fakeNow.v,
    });
    const before = writes.length;
    s.succeed('Done');
    s.stop();
    // Only one trailing clear-line from the implicit stop in succeed().
    const trailing = writes.slice(before).filter((w) => w === '\r\x1b[K').length;
    assert.strictEqual(trailing, 1);
  });

  it('info() pauses the spinner, prints the message, and resumes', () => {
    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => logLines.push(args.join(' '));
    try {
      const writes = [];
      const tickHolder = {};
      const s = longStep('Build', {
        isTTY: true,
        write: (str) => writes.push(str),
        setIntervalFn: (fn) => { tickHolder.tick = fn; return 1; },
        clearIntervalFn: () => {},
        now: () => 1000,
      });
      const writesBefore = writes.length;
      s.info('first build can take a while');
      // Should have a clear-line then an info line via console.log.
      assert.ok(writes.includes('\r\x1b[K'));
      assert.strictEqual(logLines.length, 1);
      assert.match(logLines[0], /first build can take a while/);
      // And it should have re-armed the spinner: writes count grew.
      assert.ok(writes.length > writesBefore);
      s.stop();
    } finally {
      console.log = origLog;
    }
  });
});

describe('ui.mjs — longStep (non-TTY path)', () => {
  it('falls back to a one-line log without writing \r', () => {
    const writes = [];
    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => logLines.push(args.join(' '));
    try {
      const s = longStep('Build', {
        isTTY: false,
        write: (str) => writes.push(str),
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
        now: () => 1000,
      });
      // No writes to stdout in non-TTY mode — output goes via console.log only.
      assert.strictEqual(writes.length, 0);
      assert.strictEqual(logLines.length, 1);
      assert.match(logLines[0], /⠸/);
      assert.match(logLines[0], /Build/);

      s.succeed('done');
      assert.match(logLines[1], /✔/);
      assert.match(logLines[1], /done/);
    } finally {
      console.log = origLog;
    }
  });

  it('stop() is a no-op in non-TTY mode', () => {
    const s = longStep('Build', { isTTY: false });
    // Should not throw.
    s.stop();
    s.stop();
  });
});

describe('ui.mjs — step() (unchanged baseline)', () => {
  it('step() still produces a single log line — backward compat', () => {
    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => logLines.push(args.join(' '));
    try {
      const s = step('Plain step');
      assert.strictEqual(logLines.length, 1);
      assert.match(logLines[0], /⠸/);
      s.succeed('OK');
      assert.match(logLines[1], /✔/);
    } finally {
      console.log = origLog;
    }
  });
});

describe('ui.mjs — longStep with timeoutMs', () => {
  // When the parent knows an upper bound (health probe has a 120s budget, etc.),
  // the spinner should show `(38s/120s)` instead of just `(38s)` so the user
  // can tell at a glance how much time is left before the wizard gives up.
  it('renders elapsed/total when timeoutMs is supplied', () => {
    const writes = [];
    const fakeNow = { v: 1000 };
    const tickHolder = {};
    const s = longStep('Waiting', {
      isTTY: true,
      write: (str) => writes.push(str),
      setIntervalFn: (fn) => { tickHolder.tick = fn; return 1; },
      clearIntervalFn: () => {},
      now: () => fakeNow.v,
      timeoutMs: 120_000,
    });
    assert.match(writes[0], /\(0s\/120s\)/);

    fakeNow.v = 38_000; // 37s elapsed
    tickHolder.tick();
    // The render at this tick emits the spinner frame first, then a
    // "(still running)" hint because 37s crosses the 30s threshold. Look across
    // all writes for the spinner frame containing `(37s/120s)` — the hint
    // appears in a separate write.
    assert.ok(
      writes.some((w) => /\(37s\/120s\)/.test(w)),
      `expected (37s/120s) in one of: ${JSON.stringify(writes)}`,
    );
    s.stop();
  });

  it('shows plain elapsed time when timeoutMs is null (backward compat)', () => {
    const writes = [];
    const s = longStep('Build', {
      isTTY: true,
      write: (str) => writes.push(str),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      now: () => 1000,
      timeoutMs: null,
    });
    assert.match(writes[0], /\(0s\)/);
    assert.doesNotMatch(writes[0], /\//);
    s.stop();
  });

  it('rounds timeoutMs up to seconds (ceiling division)', () => {
    // 119_500ms → 120s. We use ceil so a 119.5s timeout reads as 120s
    // (rounding down would read as 119s and could mislead).
    const writes = [];
    const s = longStep('Wait', {
      isTTY: true,
      write: (str) => writes.push(str),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      now: () => 1000,
      timeoutMs: 119_500,
    });
    assert.match(writes[0], /\(0s\/120s\)/);
    s.stop();
  });

  it('falls back to plain elapsed when timeoutMs is not a positive number', () => {
    // 0 / NaN / negative values must NOT crash — fall back to plain elapsed
    // because the parent's "upper bound" is effectively unknown.
    const writes = [];
    const s = longStep('Wait', {
      isTTY: true,
      write: (str) => writes.push(str),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      now: () => 1000,
      timeoutMs: 0,
    });
    assert.match(writes[0], /\(0s\)/);
    assert.doesNotMatch(writes[0], /\//);
    s.stop();
  });

  it('succeed() includes elapsed/total when timeoutMs is set', () => {
    const logLines = [];
    const origLog = console.log;
    console.log = (...args) => logLines.push(args.join(' '));
    try {
      const fakeNow = { v: 1000 };
      const s = longStep('Wait', {
        isTTY: true,
        write: () => {},
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
        now: () => fakeNow.v,
        timeoutMs: 60_000,
      });
      fakeNow.v = 7000; // 6s elapsed
      s.succeed('Healthy');
      assert.match(logLines[0], /\(6s\/60s\)/);
    } finally {
      console.log = origLog;
    }
  });
});

describe('ui.mjs — persistGeneratedSecrets', () => {
  it('writes secrets to deploy/.cc-credentials.txt with chmod 600', async () => {
    let written = null;
    let chmoded = null;
    const writes = [];
    await persistGeneratedSecrets({
      deployDir: '/tmp/deploy-test-1',
      generatedSecrets: { ownerPassword: 'auto-pwd-12345' },
      writeFileImpl: async (path, body, opts) => {
        written = { path, body, opts };
      },
      chmodImpl: async (path, mode) => {
        chmoded = { path, mode };
      },
      log: (...args) => writes.push(args.join(' ')),
    });
    assert.strictEqual(written.path, '/tmp/deploy-test-1/.cc-credentials.txt');
    assert.match(written.body, /ownerPassword=auto-pwd-12345/);
    assert.match(written.body, /Generated by cc up/);
    assert.match(written.body, /DO NOT COMMIT/);
    // Mode 600 on writeFileImpl is the POSIX chmod-equivalent; explicit chmod
    // is also attempted for hosts where the file mode is ignored (some FUSE
    // mounts, NTFS on Linux, etc.).
    assert.strictEqual(written.opts.mode, 0o600);
    assert.deepStrictEqual(chmoded, { path: '/tmp/deploy-test-1/.cc-credentials.txt', mode: 0o600 });
  });

  it('is a no-op when generatedSecrets is empty', async () => {
    let written = null;
    await persistGeneratedSecrets({
      deployDir: '/tmp/deploy-test-2',
      generatedSecrets: {},
      writeFileImpl: async (path, body) => { written = { path, body }; },
    });
    assert.strictEqual(written, null);
  });

  it('does not throw when writeFileImpl rejects — surfaces warning in log instead', async () => {
    const writes = [];
    await persistGeneratedSecrets({
      deployDir: '/tmp/deploy-readonly',
      generatedSecrets: { ownerPassword: 'auto-pwd-abc' },
      writeFileImpl: async () => { throw new Error('EROFS'); },
      chmodImpl: async () => {},
      log: (...args) => writes.push(args.join(' ')),
    });
    // The function swallows the error so the wizard doesn't crash mid-flow;
    // the user still got the on-screen secret from runLocalProvisionStep.
    assert.strictEqual(writes.length, 2);
    assert.match(writes[0], /EROFS/);
    assert.match(writes[1], /copy them now or lose them/);
  });

  it('writes multiple secrets in KEY=value order', async () => {
    let written = null;
    await persistGeneratedSecrets({
      deployDir: '/tmp/deploy-test-3',
      generatedSecrets: {
        ownerPassword: 'pwd-aaaa',
        // Future-proofing: envgen may start generating more secrets in
        // the future (e.g. a NEXTAUTH-like reset token). The file format
        // already supports N of them.
        apiToken: 'tok-bbbb',
      },
      writeFileImpl: async (path, body) => { written = { path, body }; },
    });
    assert.match(written.body, /ownerPassword=pwd-aaaa/);
    assert.match(written.body, /apiToken=tok-bbbb/);
    // Order is whatever Object.entries returns — the spec says "do not commit",
    // not "this exact format", so we don't pin order, just that both are present.
  });
});
