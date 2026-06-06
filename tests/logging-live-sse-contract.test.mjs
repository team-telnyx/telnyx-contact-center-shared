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
  assert.match(source, /fileSize=\{currentFile\?\.size\}/);
  assert.match(source, /loadLogs\(\{ file: logFilters\.file \|\| currentFile\?\.name \|\| "" \}\)/);
  assert.doesNotMatch(source, /active === "files" \? \(\s*<FilesView/);
  assert.doesNotMatch(source, /setActive\("live"\); loadLogs\(\{ file \}\)/);
});

test("Admin logging log metrics stay static while only the log list scrolls", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /<div className="flex-1 min-h-0 overflow-hidden p-5">/);
  assert.match(source, /function LogEntriesView\(\{ entries, loading, meta, fileSize/);
  assert.match(source, /<div className="flex h-full min-h-0 flex-col gap-4">/);
  assert.match(source, /<div className="grid shrink-0 gap-3 md:grid-cols-4">/);
  assert.match(source, /<div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">/);
  assert.match(source, /MiniStat label="File Size" value=\{formatBytes\(fileSize\)\}/);
  assert.doesNotMatch(source, /MiniStat label="Source"/);
});

test("Admin logging Files view has no top log files card and Live filters show only filters", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.doesNotMatch(source, /<h3 className="text-sm font-semibold">Log files<\/h3>/);
  assert.doesNotMatch(source, /Select a JSONL file to render its events below/);
  assert.doesNotMatch(source, /MiniStat label="Known files"/);
  assert.doesNotMatch(source, /MiniStat label="Current size"/);
  assert.match(source, /function LogFiltersPanel\([\s\S]*<SettingCard icon=\{IconFilter\} title="Filters"/);
});
