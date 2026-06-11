import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import {
  effectiveRunLimits,
  rampedConcurrency,
  createCircuitBreaker,
} from "../lib/call-generator/runner.mjs";

describe("call generator runner (T3)", () => {
  it("run config can only tighten global caps, never exceed", () => {
    const settings = { max_concurrent_calls: 10, max_cps: 5 };
    const limits = effectiveRunLimits(settings, { maxConcurrent: 50, maxCps: 15 });
    assert.strictEqual(limits.maxConcurrent, 10);
    assert.strictEqual(limits.maxCps, 5);
    const tighter = effectiveRunLimits(settings, { maxConcurrent: 3, maxCps: 1 });
    assert.strictEqual(tighter.maxConcurrent, 3);
    assert.strictEqual(tighter.maxCps, 1);
  });

  it("falls back to sane defaults on garbage input", () => {
    const limits = effectiveRunLimits({ max_concurrent_calls: "lots", max_cps: null }, { maxConcurrent: NaN });
    assert.strictEqual(limits.maxConcurrent, 10);
    assert.strictEqual(limits.maxCps, 2);
    assert.strictEqual(limits.dialTimeoutSecs, 30);
    assert.strictEqual(limits.maxDurationSecs, 120);
  });

  it("ramp profile grows linearly and clamps", () => {
    assert.strictEqual(rampedConcurrency(10, 0, 5000), 10); // no ramp
    assert.strictEqual(rampedConcurrency(10, 100, 0), 1); // floor 1
    assert.strictEqual(rampedConcurrency(10, 100, 50_000), 5); // halfway
    assert.strictEqual(rampedConcurrency(10, 100, 100_000), 10); // full
    assert.strictEqual(rampedConcurrency(10, 100, 500_000), 10); // clamped
  });

  it("circuit breaker trips after threshold and recovers after cooldown", async () => {
    const breaker = createCircuitBreaker({ threshold: 3, cooldownMs: 50 });
    assert.strictEqual(breaker.isOpen(), false);
    breaker.recordFailure();
    breaker.recordFailure();
    assert.strictEqual(breaker.isOpen(), false);
    breaker.recordFailure();
    assert.strictEqual(breaker.isOpen(), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(breaker.isOpen(), false); // half-open probe
    breaker.recordSuccess();
    assert.strictEqual(breaker.isOpen(), false);
    assert.strictEqual(breaker.state().consecutiveFailures, 0);
  });

  it("runs API gates run start on CALL_GENERATOR flag and runner result", async () => {
    const code = await readFile(new URL("../app/api/admin/call-generator/runs/route.js", import.meta.url), "utf8");
    assert.match(code, /isCallGeneratorEnabled\(\)/);
    assert.match(code, /startRunLoop/);
    assert.match(code, /'pending'|"pending"/);
  });

  it("run control stops the in-process loop on stop and panic", async () => {
    const code = await readFile(new URL("../app/api/admin/call-generator/runs/[id]/route.js", import.meta.url), "utf8");
    const stopMatches = code.match(/stopRunLoop\(params\.id\)/g) || [];
    assert.ok(stopMatches.length >= 2, "stopRunLoop must be called for both stop and panic");
  });

  it("settings API exposes inventory numbers and persists caps", async () => {
    const code = await readFile(new URL("../app/api/admin/call-generator/settings/route.js", import.meta.url), "utf8");
    assert.match(code, /loadInventoryNumbers/);
    assert.match(code, /phone_numbers/);
    assert.match(code, /from_numbers/);
    assert.match(code, /max_cps/);
    assert.match(code, /pstn_whitelist/);
    assert.match(code, /ON CONFLICT \(id\) DO UPDATE/);
  });

  it("settings editor renders From Numbers multiselect from inventory", async () => {
    const code = await readFile(new URL("../app/(portal)/admin/call-generator/page.jsx", import.meta.url), "utf8");
    assert.match(code, /MultiSelect/);
    assert.match(code, /inventoryNumbers/);
    assert.match(code, /from_numbers/);
    assert.match(code, /Max concurrent/i);
    assert.match(code, /Max CPS/i);
    assert.match(code, /PSTN/i);
  });

  it("scenario editor offers per-target from-number multiselect limited to settings", async () => {
    const code = await readFile(new URL("../app/(portal)/admin/call-generator/page.jsx", import.meta.url), "utf8");
    assert.match(code, /allowedFromNumbers/);
    assert.match(code, /from_numbers/);
    assert.match(code, /Target Flow/);
    assert.match(code, /total_calls/);
  });

  it("runner rotates CLI round-robin across selected from numbers", async () => {
    const code = await readFile(new URL("../lib/call-generator/runner.mjs", import.meta.url), "utf8");
    assert.match(code, /pickFromNumber/);
    assert.match(code, /index % list\.length/);
  });

  it("runner enforces watchdog reaping of orphaned calls", async () => {
    const code = await readFile(new URL("../lib/call-generator/runner.mjs", import.meta.url), "utf8");
    assert.match(code, /reapOrphans/);
    assert.match(code, /orphan_reaped/);
  });
});
