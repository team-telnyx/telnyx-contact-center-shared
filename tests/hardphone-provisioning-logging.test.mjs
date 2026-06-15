import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import {
  recordProvisioningEvent,
  phoneProvisioningLogger,
} from "../lib/hardphones/logging.mjs";

async function src(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function fakePool() {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
}

describe("hardphone provisioning logging module", () => {
  it("exposes a diagnostic logger on the platform.phone-provisioning topic", async () => {
    assert.ok(phoneProvisioningLogger, "phoneProvisioningLogger should be exported");
    for (const level of ["debug", "info", "warn", "error"]) {
      assert.strictEqual(typeof phoneProvisioningLogger[level], "function", `logger.${level} should exist`);
    }
    const moduleSource = await src("lib/hardphones/logging.mjs");
    assert.match(
      moduleSource,
      /createDiagnosticLogger\(["']platform\.phone-provisioning["']\)/,
      "must keep the platform.phone-provisioning topic",
    );
  });

  it("writes one hp_provisioning_events row with the expected shape", async () => {
    const pool = fakePool();
    const ok = await recordProvisioningEvent(pool, {
      phoneId: "p-1",
      mac: "0004f2abcdef",
      eventType: "config_served",
      detail: { filename: "0004f2abcdef.cfg", kind: "master" },
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(pool.calls.length, 1);
    const { text, params } = pool.calls[0];
    assert.match(text, /INSERT INTO hp_provisioning_events/);
    assert.deepStrictEqual(params.slice(0, 3), ["p-1", "0004f2abcdef", "config_served"]);
    assert.deepStrictEqual(JSON.parse(params[3]), { filename: "0004f2abcdef.cfg", kind: "master" });
  });

  it("does not throw and returns false when there is no pool", async () => {
    const ok = await recordProvisioningEvent(null, { eventType: "common_config_fetch" });
    assert.strictEqual(ok, false);
  });

  it("swallows DB errors (provisioning must never 500 on an audit insert) and returns false", async () => {
    const pool = {
      async query() {
        throw new Error("db down");
      },
    };
    const ok = await recordProvisioningEvent(pool, { eventType: "config_served", mac: "aa" });
    assert.strictEqual(ok, false);
  });

  it("defaults phoneId/mac/detail so partial events still record", async () => {
    const pool = fakePool();
    await recordProvisioningEvent(pool, { eventType: "unknown_phone_request" });
    const { params } = pool.calls[0];
    assert.strictEqual(params[0], null);
    assert.strictEqual(params[1], null);
    assert.strictEqual(params[2], "unknown_phone_request");
    assert.deepStrictEqual(JSON.parse(params[3]), {});
  });
});

describe("hardphone provisioning call sites use the central recorder", () => {
  const routes = [
    "app/api/provisioning/[filename]/route.js",
    "app/api/provisioning/events/[vendor]/route.js",
  ];

  for (const route of routes) {
    it(`${route} imports recordProvisioningEvent from the central module`, async () => {
      const source = await src(route);
      assert.match(
        source,
        /from\s+["']@\/lib\/hardphones\/logging\.mjs["']/,
        `${route} should import the central logging module`,
      );
      assert.match(source, /recordProvisioningEvent/, `${route} should call recordProvisioningEvent`);
    });

    it(`${route} no longer inlines raw INSERT INTO hp_provisioning_events`, async () => {
      const source = await src(route);
      assert.doesNotMatch(
        source,
        /INSERT INTO hp_provisioning_events/,
        `${route} should delegate the INSERT to the central recorder`,
      );
    });
  }

  it("provisioning serve route does not borrow the unrelated voice.flow logger", async () => {
    const source = await src("app/api/provisioning/[filename]/route.js");
    assert.doesNotMatch(
      source,
      /voiceRuntimeLogger/,
      "serve route should log on the phone-provisioning topic, not voice.flow",
    );
  });
});
