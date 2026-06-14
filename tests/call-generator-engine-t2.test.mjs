import assert from "node:assert";
import { describe, it } from "node:test";
import {
  buildGeneratorClientState,
  parseGeneratorClientState,
  resolveDialTarget,
  pstnWhitelistFromConfig,
  isPstnTargetAllowed,
  canTransition,
  isCallGeneratorEnabled,
  handleGeneratorWebhookEvent,
} from "../lib/call-generator/engine.mjs";

function poolWithSettings(settings) {
  return { query: async () => ({ rows: settings === undefined ? [] : [{ settings }] }) };
}

describe("call generator engine (T2)", () => {
  it("is dormant by default (no settings row, no pool)", async () => {
    assert.strictEqual(await isCallGeneratorEnabled(null), false);
    assert.strictEqual(await isCallGeneratorEnabled(poolWithSettings(undefined)), false);
  });

  it("activates only when settings.enabled === true in the database", async () => {
    assert.strictEqual(await isCallGeneratorEnabled(poolWithSettings({ enabled: true })), true);
    assert.strictEqual(await isCallGeneratorEnabled(poolWithSettings({ enabled: false })), false);
    assert.strictEqual(await isCallGeneratorEnabled(poolWithSettings({ enabled: "true" })), false);
    assert.strictEqual(await isCallGeneratorEnabled({ query: async () => { throw new Error("db down"); } }), false);
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



  it("delays action sequence until agent bridge when configured", async () => {
    const originalApiKey = process.env.TELNYX_API_KEY;
    const originalFetch = global.fetch;
    process.env.TELNYX_API_KEY = "test-key";
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body || "{}") });
      return { ok: true, status: 200, json: async () => ({ data: {} }), text: async () => "" };
    };

    const ledger = {
      status: "ringing",
      result: {
        action_trigger: "agent_bridge",
        action_steps: [{ type: "speak", text: "hello agent", voice: "AWS.Polly.Joanna" }],
      },
    };
    const pool = {
      query: async (sql, params = []) => {
        if (/SELECT status, result FROM cg_call_ledger/.test(sql)) return { rows: [{ status: ledger.status, result: ledger.result }] };
        if (/SELECT status FROM cg_call_ledger/.test(sql)) return { rows: [{ status: ledger.status }] };
        if (/SELECT result FROM cg_call_ledger WHERE id/.test(sql)) return { rows: [{ result: ledger.result }] };
        if (/SELECT r.config, l.result/.test(sql)) return { rows: [{ result: ledger.result, config: { maxDurationSecs: 120 } }] };
        if (/SET status = \$1/.test(sql)) {
          const next = params[0];
          if (params[3] !== ledger.status) return { rowCount: 0 };
          ledger.status = next;
          ledger.result = { ...ledger.result, ...JSON.parse(params[1] || "{}") };
          return { rowCount: 1 };
        }
        if (/action_sequence_started_at/.test(sql)) {
          if (ledger.result.action_sequence_started_at) return { rowCount: 0 };
          ledger.result = { ...ledger.result, ...JSON.parse(params[0] || "{}") };
          return { rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const payload = {
      client_state: buildGeneratorClientState({ runId: "run-1", ledgerId: "ledger-1" }),
      call_control_id: "cc-1",
    };

    try {
      assert.strictEqual(await handleGeneratorWebhookEvent(pool, "call.answered", payload), "answered");
      assert.strictEqual(calls.some((call) => call.url.includes("/actions/speak")), false);
      assert.strictEqual(await handleGeneratorWebhookEvent(pool, "call.bridged", payload), "talking");
      assert.strictEqual(calls.some((call) => call.body.payload === "hello agent"), true);
    } finally {
      if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
      else process.env.TELNYX_API_KEY = originalApiKey;
      global.fetch = originalFetch;
    }
  });

  it("runs agent-bridge actions when bridged arrives before answered", async () => {
    const originalApiKey = process.env.TELNYX_API_KEY;
    const originalFetch = global.fetch;
    process.env.TELNYX_API_KEY = "test-key";
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body || "{}") });
      return { ok: true, status: 200, json: async () => ({ data: {} }), text: async () => "" };
    };

    const ledger = {
      status: "dialing",
      result: {
        action_trigger: "agent_bridge",
        action_steps: [{ type: "speak", text: "bridge first", voice: "AWS.Polly.Joanna" }],
      },
    };
    const pool = {
      query: async (sql, params = []) => {
        if (/SELECT status, result FROM cg_call_ledger/.test(sql)) return { rows: [{ status: ledger.status, result: ledger.result }] };
        if (/SELECT status FROM cg_call_ledger/.test(sql)) return { rows: [{ status: ledger.status }] };
        if (/SELECT result FROM cg_call_ledger WHERE id/.test(sql)) return { rows: [{ result: ledger.result }] };
        if (/SELECT r.config, l.result/.test(sql)) return { rows: [{ result: ledger.result, config: { maxDurationSecs: 120 } }] };
        if (/SET status = \$1/.test(sql)) {
          const next = params[0];
          if (params[3] !== ledger.status) return { rowCount: 0 };
          ledger.status = next;
          ledger.result = { ...ledger.result, ...JSON.parse(params[1] || "{}") };
          return { rowCount: 1 };
        }
        if (/action_sequence_started_at/.test(sql)) {
          if (ledger.result.action_sequence_started_at) return { rowCount: 0 };
          ledger.result = { ...ledger.result, ...JSON.parse(params[0] || "{}") };
          return { rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    try {
      const payload = {
        client_state: buildGeneratorClientState({ runId: "run-1", ledgerId: "ledger-1" }),
        call_control_id: "cc-1",
      };
      assert.strictEqual(await handleGeneratorWebhookEvent(pool, "call.bridged", payload), "talking");
      assert.strictEqual(ledger.status, "talking");
      assert.strictEqual(calls.some((call) => call.body.payload === "bridge first"), true);
    } finally {
      if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
      else process.env.TELNYX_API_KEY = originalApiKey;
      global.fetch = originalFetch;
    }
  });

  it("preserves call-answer actions when bridged arrives before answered", async () => {
    const originalApiKey = process.env.TELNYX_API_KEY;
    const originalFetch = global.fetch;
    process.env.TELNYX_API_KEY = "test-key";
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body || "{}") });
      return { ok: true, status: 200, json: async () => ({ data: {} }), text: async () => "" };
    };

    const ledger = {
      status: "dialing",
      result: {
        action_trigger: "call_answer",
        action_steps: [{ type: "speak", text: "answer first", voice: "AWS.Polly.Joanna" }],
      },
    };
    const pool = {
      query: async (sql, params = []) => {
        if (/SELECT status, result FROM cg_call_ledger/.test(sql)) return { rows: [{ status: ledger.status, result: ledger.result }] };
        if (/SELECT status FROM cg_call_ledger/.test(sql)) return { rows: [{ status: ledger.status }] };
        if (/SELECT result FROM cg_call_ledger WHERE id/.test(sql)) return { rows: [{ result: ledger.result }] };
        if (/SELECT r.config, l.result/.test(sql)) return { rows: [{ result: ledger.result, config: { maxDurationSecs: 120 } }] };
        if (/SET status = \$1/.test(sql)) {
          const next = params[0];
          if (params[3] !== ledger.status) return { rowCount: 0 };
          ledger.status = next;
          ledger.result = { ...ledger.result, ...JSON.parse(params[1] || "{}") };
          return { rowCount: 1 };
        }
        if (/action_sequence_started_at/.test(sql)) {
          if (ledger.result.action_sequence_started_at) return { rowCount: 0 };
          ledger.result = { ...ledger.result, ...JSON.parse(params[0] || "{}") };
          return { rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    try {
      const payload = {
        client_state: buildGeneratorClientState({ runId: "run-1", ledgerId: "ledger-1" }),
        call_control_id: "cc-1",
      };
      assert.strictEqual(await handleGeneratorWebhookEvent(pool, "call.bridged", payload), null);
      assert.strictEqual(ledger.status, "dialing");
      assert.strictEqual(calls.some((call) => call.body.payload === "answer first"), false);
      assert.strictEqual(await handleGeneratorWebhookEvent(pool, "call.answered", payload), "answered");
      assert.strictEqual(calls.some((call) => call.body.payload === "answer first"), true);
    } finally {
      if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
      else process.env.TELNYX_API_KEY = originalApiKey;
      global.fetch = originalFetch;
    }
  });

  it("ignores late bridged events after the ledger is already final", async () => {
    const originalApiKey = process.env.TELNYX_API_KEY;
    const originalFetch = global.fetch;
    process.env.TELNYX_API_KEY = "test-key";
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount += 1;
      return { ok: true, status: 200, json: async () => ({ data: {} }), text: async () => "" };
    };

    const ledger = {
      status: "completed",
      result: {
        action_trigger: "agent_bridge",
        action_steps: [{ type: "speak", text: "too late", voice: "AWS.Polly.Joanna" }],
      },
    };
    const pool = {
      query: async (sql, params = []) => {
        if (/SELECT status, result FROM cg_call_ledger/.test(sql)) return { rows: [{ status: ledger.status, result: ledger.result }] };
        if (/SELECT status FROM cg_call_ledger/.test(sql)) return { rows: [{ status: ledger.status }] };
        if (/SELECT result FROM cg_call_ledger WHERE id/.test(sql)) return { rows: [{ result: ledger.result }] };
        if (/SET status = \$1/.test(sql)) return { rowCount: 0 };
        if (/action_sequence_started_at/.test(sql)) {
          ledger.result = { ...ledger.result, ...JSON.parse(params[0] || "{}") };
          return { rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    try {
      const payload = {
        client_state: buildGeneratorClientState({ runId: "run-1", ledgerId: "ledger-1" }),
        call_control_id: "cc-1",
      };
      assert.strictEqual(await handleGeneratorWebhookEvent(pool, "call.bridged", payload), null);
      assert.strictEqual(ledger.result.action_sequence_started_at, undefined);
      assert.strictEqual(fetchCount, 0);
    } finally {
      if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
      else process.env.TELNYX_API_KEY = originalApiKey;
      global.fetch = originalFetch;
    }
  });

  it("does not fall back to legacy post-answer audio for empty action steps", async () => {
    const originalApiKey = process.env.TELNYX_API_KEY;
    const originalFetch = global.fetch;
    process.env.TELNYX_API_KEY = "test-key";
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body || "{}") });
      return { ok: true, status: 200, json: async () => ({ data: {} }), text: async () => "" };
    };

    const ledger = {
      status: "ringing",
      result: { action_trigger: "call_answer", action_steps: [] },
    };
    const pool = {
      query: async (sql, params = []) => {
        if (/SELECT status, result FROM cg_call_ledger/.test(sql)) return { rows: [{ status: ledger.status, result: ledger.result }] };
        if (/SELECT status FROM cg_call_ledger/.test(sql)) return { rows: [{ status: ledger.status }] };
        if (/SELECT result FROM cg_call_ledger WHERE id/.test(sql)) return { rows: [{ result: ledger.result }] };
        if (/SELECT r.config, l.result/.test(sql)) return { rows: [{ result: ledger.result, config: { postAnswer: { action: "tts_loop", ttsText: "legacy audio" }, maxDurationSecs: 120 } }] };
        if (/SET status = \$1/.test(sql)) {
          ledger.status = params[0];
          ledger.result = { ...ledger.result, ...JSON.parse(params[1] || "{}") };
          return { rowCount: 1 };
        }
        if (/action_sequence_started_at/.test(sql)) {
          ledger.result = { ...ledger.result, ...JSON.parse(params[0] || "{}") };
          return { rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    try {
      const payload = {
        client_state: buildGeneratorClientState({ runId: "run-1", ledgerId: "ledger-1" }),
        call_control_id: "cc-1",
      };
      assert.strictEqual(await handleGeneratorWebhookEvent(pool, "call.answered", payload), "answered");
      assert.strictEqual(calls.some((call) => call.url.includes("/actions/speak") || call.body.payload === "legacy audio"), false);
    } finally {
      if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
      else process.env.TELNYX_API_KEY = originalApiKey;
      global.fetch = originalFetch;
    }
  });

  it("state machine allows only forward transitions", () => {
    assert.strictEqual(canTransition("pending", "dialing"), true);
    assert.strictEqual(canTransition("dialing", "ringing"), true);
    assert.strictEqual(canTransition("ringing", "answered"), true);
    assert.strictEqual(canTransition("dialing", "talking"), true);
    assert.strictEqual(canTransition("ringing", "talking"), true);
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
  it("webhook route processes generator events via client_state correlation", async () => {
    const { readFile } = await import("node:fs/promises");
    const code = await readFile(new URL("../app/api/call-generator/webhook/route.js", import.meta.url), "utf8");
    assert.match(code, /handleGeneratorWebhookEvent/);
    assert.match(code, /findGeneratorStateByLedger/);
    assert.match(code, /call_control_id = \$1/);
    assert.match(code, /call_session_id = \$2/);
    assert.match(code, /buildGeneratorClientState\(\{ runId: generatorState\.runId, ledgerId: generatorState\.ledgerId \}\)/);
    assert.match(code, /ignored: true/);
    assert.doesNotMatch(code, /CALL_GENERATOR/);
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
