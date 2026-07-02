import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("WS4-T2 SSE fan-out stays flag-gated and uses the existing event bus topic contract", async () => {
  const sse = await source("lib/sse.js");

  assert.match(
    sse,
    /process\.env\.SSE_FANOUT\s*\|\|\s*["']false["']/,
    "SSE fan-out must default off so single-node/prod behavior stays unchanged",
  );
  assert.match(
    sse,
    /TOPICS\.SSE_PREFIX/,
    "SSE fan-out must use the central event bus SSE prefix constant",
  );
  assert.match(
    sse,
    /subscribe\(\s*`\$\{TOPICS\.SSE_PREFIX\}\*`/,
    "SSE fan-out subscribers must listen to sse:* for all local client keys",
  );
  assert.match(
    sse,
    /publish\(\s*`\$\{TOPICS\.SSE_PREFIX\}\$\{key\}`/,
    "broadcastToKey must publish cross-node events to sse:<key> when SSE_FANOUT=true",
  );
  const publishBlock = sse.slice(sse.indexOf("function publishSseFanout"), sse.indexOf("export async function broadcastToKey"));
  assert.doesNotMatch(
    publishBlock,
    /await\s+ensureSseFanoutSubscriber\(\)/,
    "publishing cross-node events must not be blocked by local subscriber startup",
  );
  assert.match(
    sse,
    /origin\s*===\s*SSE_INSTANCE_ID/,
    "a node must ignore its own bus echo to avoid duplicate local SSE messages",
  );
  assert.match(
    sse,
    /broadcastLocalToKey/,
    "bus-delivered SSE events must write only to local clients, not re-publish recursively",
  );
});

test("WS4-T2 SSE fan-out does not alter the public SSE API used by callers", async () => {
  const sse = await import("../lib/sse.js");
  assert.equal(typeof sse.addSseClient, "function");
  assert.equal(typeof sse.removeSseClient, "function");
  assert.equal(typeof sse.hasActiveClients, "function");
  assert.equal(typeof sse.broadcastToKey, "function");
  assert.equal(typeof sse.broadcastToAllAgents, "function");
});
