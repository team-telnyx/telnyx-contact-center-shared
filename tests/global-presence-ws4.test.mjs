import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("WS4-T3 global presence is flag-gated and backed by an expiring DB table", async () => {
  const presenceSource = await source("lib/contact-center/session-presence.js");
  const schemaSource = await source("lib/postgres-schema.mjs");

  assert.match(
    presenceSource,
    /process\.env\.GLOBAL_PRESENCE\s*\|\|\s*["']false["']/,
    "GLOBAL_PRESENCE must default off so single-node behavior is unchanged",
  );
  assert.match(
    presenceSource,
    /cc_session_presence/,
    "global presence must use a DB-backed presence table, not only process memory",
  );
  assert.match(
    presenceSource,
    /expires_at\s*>\s*NOW\(\)/,
    "presence liveness must be TTL based so crashed nodes expire automatically",
  );
  assert.match(
    presenceSource,
    /fallbackKey/,
    "global presence must fall back to local hasActiveClients when disabled or DB unavailable",
  );
  assert.match(
    schemaSource,
    /CREATE TABLE IF NOT EXISTS cc_session_presence/,
    "schema must create the additive presence table",
  );
  assert.match(
    schemaSource,
    /idx_cc_session_presence_user_expires/,
    "schema must index active presence lookup by user and expiry",
  );
});

test("WS4-T3 status-stream records, heartbeats, removes, and globally checks session presence", async () => {
  const statusStreamSource = await source("app/api/user/status-stream/route.js");

  assert.match(statusStreamSource, /registerSessionPresence/, "status-stream must register a DB presence row on connect");
  assert.match(statusStreamSource, /touchSessionPresence/, "status-stream ping must extend the DB presence TTL");
  assert.match(statusStreamSource, /removeSessionPresence/, "status-stream disconnect must remove only its own DB presence row");
  assert.match(
    statusStreamSource,
    /hasActiveSessionPresence\(\{\s*userId,\s*fallbackKey:\s*statusKey\s*\}\)/s,
    "offline grace timer must check global active presence before setting Offline",
  );
  assert.doesNotMatch(
    statusStreamSource,
    /if \(hasActiveClients\(statusKey\)\) return;/,
    "offline decision must not rely only on local process memory in HA mode",
  );
});

test("WS4-T3 session presence module exports the small route-facing API", async () => {
  const mod = await import("../lib/contact-center/session-presence.js");
  assert.equal(typeof mod.registerSessionPresence, "function");
  assert.equal(typeof mod.touchSessionPresence, "function");
  assert.equal(typeof mod.removeSessionPresence, "function");
  assert.equal(typeof mod.hasActiveSessionPresence, "function");
  assert.equal(typeof mod.isGlobalPresenceEnabled, "function");
});
