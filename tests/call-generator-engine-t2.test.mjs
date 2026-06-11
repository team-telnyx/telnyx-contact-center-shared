import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  buildGeneratorClientState,
  parseGeneratorClientState,
  resolveDialTarget,
  pstnWhitelistFromConfig,
  isPstnTargetAllowed,
  canTransition,
  isCallGeneratorEnabled,
} from "../lib/call-generator/engine.mjs";

describe("call generator engine (T2)", () => {
  let envBackup;
  beforeEach(() => { envBackup = process.env.CALL_GENERATOR; });
  afterEach(() => {
    if (envBackup === undefined) delete process.env.CALL_GENERATOR;
    else process.env.CALL_GENERATOR = envBackup;
  });

  it("is dormant by default (flag off)", () => {
    delete process.env.CALL_GENERATOR;
    assert.strictEqual(isCallGeneratorEnabled(), false);
  });

  it("activates only with CALL_GENERATOR=true", () => {
    process.env.CALL_GENERATOR = "true";
    assert.strictEqual(isCallGeneratorEnabled(), true);
    process.env.CALL_GENERATOR = "1";
    assert.strictEqual(isCallGeneratorEnabled(), false);
  });

  it("client_state round-trips with callGenerator marker", () => {
    const cs = buildGeneratorClientState({ runId: "run-1", ledgerId: "led-1" });
    const parsed = parseGeneratorClientState(cs);
    assert.deepStrictEqual(parsed, { callGenerator: true, runId: "run-1", ledgerId: "led-1" });
  });

  it("rejects non-generator client_state", () => {
    const foreign = Buffer.from(JSON.stringify({ outbound: true, campaignId: "c1" })).toString("base64");
    assert.strictEqual(parseGeneratorClientState(foreign), null);
    assert.strictEqual(parseGeneratorClientState("not-base64!"), null);
    assert.strictEqual(parseGeneratorClientState(""), null);
  });

  it("resolves call_flow target to SIP subdomain URI", () => {
    assert.strictEqual(
      resolveDialTarget({ target_type: "call_flow", target: "flow-abc" }),
      "sip:gen@flow-abc.sip.telnyx.com",
    );
  });

  it("resolves sip and pstn targets", () => {
    assert.strictEqual(resolveDialTarget({ target_type: "sip", target: "sip:x@y.com" }), "sip:x@y.com");
    assert.strictEqual(resolveDialTarget({ target_type: "sip", target: "x@y.com" }), "sip:x@y.com");
    assert.strictEqual(resolveDialTarget({ target_type: "pstn", target: "+48123456789" }), "+48123456789");
    assert.strictEqual(resolveDialTarget({ target_type: "unknown", target: "z" }), null);
    assert.strictEqual(resolveDialTarget({ target_type: "pstn", target: "" }), null);
  });

  it("pstn whitelist enforces digits match", () => {
    const wl = pstnWhitelistFromConfig({ pstnWhitelist: ["+48 123 456 789", "+12025550100"] });
    assert.strictEqual(isPstnTargetAllowed("+48123456789", wl), true);
    assert.strictEqual(isPstnTargetAllowed("+12025550100", wl), true);
    assert.strictEqual(isPstnTargetAllowed("+12025550199", wl), false);
    assert.strictEqual(isPstnTargetAllowed("", wl), false);
  });

  it("state machine allows only forward transitions", () => {
    assert.strictEqual(canTransition("pending", "dialing"), true);
    assert.strictEqual(canTransition("dialing", "ringing"), true);
    assert.strictEqual(canTransition("ringing", "answered"), true);
    assert.strictEqual(canTransition("answered", "talking"), true);
    assert.strictEqual(canTransition("talking", "completed"), true);
    assert.strictEqual(canTransition("dialing", "abandoned"), true);
    // backwards / invalid
    assert.strictEqual(canTransition("completed", "dialing"), false);
    assert.strictEqual(canTransition("answered", "ringing"), false);
    assert.strictEqual(canTransition("failed", "answered"), false);
    assert.strictEqual(canTransition("talking", "ringing"), false);
  });
});

describe("call generator webhook route (T2)", () => {
  it("webhook route exists with fail-open flag gating", async () => {
    const { readFile } = await import("node:fs/promises");
    const code = await readFile(new URL("../app/api/call-generator/webhook/route.js", import.meta.url), "utf8");
    assert.match(code, /isCallGeneratorEnabled/);
    assert.match(code, /handleGeneratorWebhookEvent/);
    assert.match(code, /ignored: true/);
  });

  it("run control route supports stop and panic", async () => {
    const { readFile } = await import("node:fs/promises");
    const code = await readFile(new URL("../app/api/admin/call-generator/runs/[id]/route.js", import.meta.url), "utf8");
    assert.match(code, /panicStop/);
    assert.match(code, /action === "stop"/);
    assert.match(code, /action === "panic"/);
    assert.match(code, /requireAdmin/);
  });
});
