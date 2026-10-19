import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { startVideoAiWorker } from "../lib/video/ai-worker.mjs";

const listen = server => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const close = server => new Promise(resolve => server.close(resolve));

test("failed Chromium startup releases the private control port for the next attempt", async () => {
  const probe = net.createServer(); await listen(probe); const port = probe.address().port; await close(probe);
  const previous = { path: process.env.VIDEO_AI_CHROMIUM_PATH, port: process.env.VIDEO_AI_CONTROL_PORT };
  process.env.VIDEO_AI_CONTROL_PORT = String(port); process.env.VIDEO_AI_CHROMIUM_PATH = "/nonexistent-cc-video-test-browser";
  try {
    await assert.rejects(startVideoAiWorker({ query: async () => ({ rows: [] }) }), /browser|executable|nonexistent/i);
    const retry = net.createServer();
    await new Promise((resolve, reject) => { retry.once("error", reject); retry.listen(port, "127.0.0.1", resolve); });
    await close(retry);
  } finally {
    for (const [key, value] of [["VIDEO_AI_CHROMIUM_PATH", previous.path], ["VIDEO_AI_CONTROL_PORT", previous.port]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("shutdown waits for in-flight heartbeat then deletes it; browser failure is observed once", async () => {
  const browser = new EventEmitter();
  let releaseHeartbeat, heartbeatStarted;
  const started = new Promise(resolve => { heartbeatStarted = resolve; });
  const blocked = new Promise(resolve => { releaseHeartbeat = resolve; });
  const queries = [], failures = [];
  const pool = { query: async sql => {
    queries.push(sql);
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ ok: false }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO cc_video_ai_workers")) { heartbeatStarted(); await blocked; }
    return { rows: [], rowCount: 0 };
  } };
  pool.connect = async () => ({ query: pool.query, release() {} });
  const worker = await startVideoAiWorker(pool, { browser, onFailure: error => failures.push(error.message) });
  await started;
  browser.emit("disconnected"); browser.emit("disconnected");
  assert.equal(failures.length, 1);
  const stopping = worker.stop(); releaseHeartbeat(); await stopping;
  await worker.stop(); browser.emit("disconnected");
  assert.equal(failures.length, 1);
  assert.match(queries.at(-1), /DELETE FROM cc_video_ai_workers/);
});
