import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const streamRoutePath = new URL("../app/api/admin/logging/stream/route.js", import.meta.url);
const pagePath = new URL("../app/(portal)/admin/logging/page.jsx", import.meta.url);

test("Admin logging exposes an SSE stream for newest live log file", async () => {
  await access(streamRoutePath);
  const source = await readFile(streamRoutePath, "utf8");

  assert.match(source, /export const dynamic = "force-dynamic"/);
  assert.match(source, /text\/event-stream/);
  assert.match(source, /Cache-Control": "no-cache, no-transform"/);
  assert.match(source, /request\.signal\.addEventListener\("abort"/);
  assert.match(source, /listLogFiles\(\{ logDir, limit: 1 \}\)/);
  assert.match(source, /queryLogEntries\(\{[\s\S]*file: latestFile\.name/);
  assert.match(source, /send\("ready", \{ ok: true, file: latestFile\.name, entries: initial\.entries \}\)/);
  assert.match(source, /setInterval\(/);
  assert.match(source, /clearInterval\(pollTimer\)/);
  assert.match(source, /event: log/);
  assert.match(source, /\$\{JSON\.stringify\(entry\)\}/);
  assert.doesNotMatch(source, /queryParam\(request, "logDir"\)|searchParams\.get\("logDir"\)/);
});

test("Admin Logging Live uses EventSource subscription and closes it when leaving the view", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /const \[liveConnected, setLiveConnected\] = React\.useState\(false\)/);
  assert.match(source, /new EventSource\(`\/api\/admin\/logging\/stream\?\$\{params\.toString\(\)\}`\)/);
  assert.match(source, /source\.addEventListener\("log"/);
  assert.match(source, /if \(Array\.isArray\(data\.entries\)\) setLogEntries\(data\.entries\)/);
  assert.match(source, /setLogEntries\(\(prev\) => \[/);
  assert.match(source, /return \(\) => \{[\s\S]*source\.close\(\)[\s\S]*\}/);
  assert.match(source, /if \(active !== "live"\) return undefined/);
  assert.match(source, /latest: "1"/);
});

test("Admin Logging Files renders selected file events with the same log entry view without SSE", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /function FileLogView\(/);
  assert.match(source, /<FileLogView entries=\{logEntries\}/);
  assert.match(source, /sourceLabel=\{logFilters\.file \|\| currentFile\?\.name \|\| "No file selected"\}/);
  assert.match(source, /loadLogs\(\{ file: logFilters\.file \|\| currentFile\?\.name \|\| "" \}\)/);
  assert.doesNotMatch(source, /active === "files" \? \(\s*<FilesView/);
  assert.doesNotMatch(source, /setActive\("live"\); loadLogs\(\{ file \}\)/);
});
