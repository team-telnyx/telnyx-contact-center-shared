import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const moduleUrl = new URL("../lib/logger/log-reader.mjs", import.meta.url).href;

async function freshModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

async function makeLogDir() {
  return mkdtemp(path.join(os.tmpdir(), "cc-log-reader-"));
}

test("listLogFiles returns newest JSONL files only and ignores unsafe names", async () => {
  const { listLogFiles } = await freshModule();
  const dir = await makeLogDir();
  await writeFile(path.join(dir, "app-2026-06-05.jsonl"), "");
  await writeFile(path.join(dir, "app-2026-06-06.jsonl"), "");
  await writeFile(path.join(dir, "notes.txt"), "secret");
  await writeFile(path.join(dir, "../outside.jsonl"), "outside");

  const files = await listLogFiles({ logDir: dir, limit: 10 });
  assert.deepEqual(files.map((f) => f.name), ["app-2026-06-06.jsonl", "app-2026-06-05.jsonl"]);
  assert.equal(files[0].path, undefined);
  assert.equal(files[0].size >= 0, true);
});

test("queryLogEntries filters JSONL logs by time, level, topic, runId, and search", async () => {
  const { queryLogEntries } = await freshModule();
  const dir = await makeLogDir();
  await writeFile(path.join(dir, "app-2026-06-06.jsonl"), [
    JSON.stringify({ time: "2026-06-06T10:00:00.000Z", level: "info", topic: "app", runId: "run-a", msg: "boot ok" }),
    JSON.stringify({ time: "2026-06-06T10:01:00.000Z", level: "debug", topic: "telnyx.stt", runId: "run-a", msg: "partial transcript" }),
    "not-json",
    JSON.stringify({ time: "2026-06-06T10:02:00.000Z", level: "error", topic: "telnyx.stt", runId: "run-b", msg: "provider failed", callControlId: "call-123" }),
  ].join("\n"));

  const result = await queryLogEntries({
    logDir: dir,
    level: "error",
    topic: "telnyx.stt",
    runId: "run-b",
    search: "provider",
    from: "2026-06-06T10:01:30.000Z",
    to: "2026-06-06T10:03:00.000Z",
    limit: 20,
  });

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].msg, "provider failed");
  assert.equal(result.entries[0].callControlId, "call-123");
  assert.equal(result.skippedInvalid, 1);
  assert.equal(result.truncated, false);
});

test("queryLogEntries accepts multiple selected topics", async () => {
  const { queryLogEntries } = await freshModule();
  const dir = await makeLogDir();
  await writeFile(path.join(dir, "app-2026-06-09.jsonl"), [
    JSON.stringify({ time: "2026-06-09T10:00:00.000Z", level: "info", topic: "app", msg: "boot" }),
    JSON.stringify({ time: "2026-06-09T10:01:00.000Z", level: "info", topic: "routing", msg: "matched route" }),
    JSON.stringify({ time: "2026-06-09T10:02:00.000Z", level: "info", topic: "telnyx.stt", msg: "transcript" }),
    JSON.stringify({ time: "2026-06-09T10:03:00.000Z", level: "info", scope: "voice-webhook", msg: "webhook handled" }),
  ].join("\n"));

  const result = await queryLogEntries({
    logDir: dir,
    file: "app-2026-06-09.jsonl",
    topics: ["routing", "telnyx.stt", "voice-webhook"],
    limit: 20,
  });

  assert.deepEqual(result.entries.map((entry) => entry.msg), ["webhook handled", "transcript", "matched route"]);
});

test("queryLogEntries is newest-first, bounded, and never reads path traversal filenames", async () => {
  const { queryLogEntries } = await freshModule();
  const dir = await makeLogDir();
  await writeFile(path.join(dir, "app-2026-06-06.jsonl"), [
    JSON.stringify({ time: "2026-06-06T10:00:00.000Z", level: "info", topic: "app", msg: "older" }),
    JSON.stringify({ time: "2026-06-06T10:01:00.000Z", level: "info", topic: "app", msg: "newer" }),
  ].join("\n"));

  await assert.rejects(
    () => queryLogEntries({ logDir: dir, file: "../outside.jsonl" }),
    /Invalid log file/,
  );

  const result = await queryLogEntries({ logDir: dir, file: "app-2026-06-06.jsonl", limit: 1 });
  assert.deepEqual(result.entries.map((entry) => entry.msg), ["newer"]);
  assert.equal(result.truncated, true);
});

test("queryLogEntries rejects symlink escapes, invalid time filters, and redacts at read time", async () => {
  const { queryLogEntries, listLogFiles } = await freshModule();
  const dir = await makeLogDir();
  const outside = path.join(os.tmpdir(), `cc-outside-${Date.now()}.jsonl`);
  await writeFile(outside, JSON.stringify({ time: "2026-06-06T10:00:00.000Z", msg: "outside" }));
  await symlink(outside, path.join(dir, "app-link.jsonl"));

  const files = await listLogFiles({ logDir: dir, limit: 10 });
  assert.deepEqual(files.map((file) => file.name), []);
  await assert.rejects(
    () => queryLogEntries({ logDir: dir, file: "app-link.jsonl" }),
    /Invalid log file/,
  );

  await writeFile(path.join(dir, "app-2026-06-07.jsonl"), JSON.stringify({
    time: "2026-06-07T10:00:00.000Z",
    level: "info",
    topic: "app",
    authorization: `Bearer ${"sk_live_abcdef1234567890"}`,
  }));
  await assert.rejects(
    () => queryLogEntries({ logDir: dir, from: "not-a-date" }),
    /Invalid from timestamp/,
  );
  const result = await queryLogEntries({ logDir: dir, file: "app-2026-06-07.jsonl" });
  assert.equal(result.entries[0].authorization, "[redacted:string:31]");
});

test("queryLogEntries accepts epoch filters and keeps only a bounded newest window", async () => {
  const { queryLogEntries } = await freshModule();
  const dir = await makeLogDir();
  await writeFile(path.join(dir, "app-1970-01-01.jsonl"), [
    JSON.stringify({ time: "1970-01-01T00:00:00.000Z", level: "info", topic: "app", msg: "epoch" }),
    JSON.stringify({ time: "1970-01-01T00:00:01.000Z", level: "info", topic: "app", msg: "one" }),
    JSON.stringify({ time: "1970-01-01T00:00:02.000Z", level: "info", topic: "app", msg: "two" }),
  ].join("\n"));

  const result = await queryLogEntries({
    logDir: dir,
    file: "app-1970-01-01.jsonl",
    from: "1970-01-01T00:00:00.000Z",
    limit: 2,
  });
  assert.deepEqual(result.entries.map((entry) => entry.msg), ["two", "one"]);
  assert.equal(result.truncated, true);
});

test("queryLogEntries tails oversized files instead of rejecting the viewer request", async () => {
  const { queryLogEntries } = await freshModule();
  const dir = await makeLogDir();
  const largePadding = "x".repeat(10 * 1024 * 1024 + 1024);
  await writeFile(path.join(dir, "app-2026-06-08.jsonl"), [
    JSON.stringify({ time: "2026-06-08T10:00:00.000Z", level: "info", topic: "app", msg: largePadding }),
    JSON.stringify({ time: "2026-06-08T10:01:00.000Z", level: "info", topic: "app", msg: "latest" }),
  ].join("\n"));

  const result = await queryLogEntries({ logDir: dir, file: "app-2026-06-08.jsonl", limit: 10 });
  assert.deepEqual(result.entries.map((entry) => entry.msg), ["latest"]);
  assert.equal(result.truncated, true);
});

test("queryLogEntries signals truncation even when filters match only the oversized file tail", async () => {
  const { queryLogEntries } = await freshModule();
  const dir = await makeLogDir();
  const largePadding = "x".repeat(10 * 1024 * 1024 + 1024);
  await writeFile(path.join(dir, "app-2026-06-09.jsonl"), [
    JSON.stringify({ time: "2026-06-09T10:00:00.000Z", level: "info", topic: "app", msg: largePadding }),
    JSON.stringify({ time: "2026-06-09T10:01:00.000Z", level: "error", topic: "app", msg: "tail error" }),
  ].join("\n"));

  const result = await queryLogEntries({ logDir: dir, file: "app-2026-06-09.jsonl", level: "error", limit: 10 });
  assert.deepEqual(result.entries.map((entry) => entry.msg), ["tail error"]);
  assert.equal(result.truncated, true);
});
