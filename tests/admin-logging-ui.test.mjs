import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const PAGE = new URL("../app/(portal)/admin/logging/page.jsx", import.meta.url);

async function source() {
  return readFile(PAGE, "utf8");
}

test("Admin logging page follows SectionRail three-pane workspace layout", async () => {
  const page = await source();
  assert.match(page, /import \{ SectionRail, SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH \}/);
  assert.match(page, /\{ id: "live", label: "Live", icon: IconActivity/);
  assert.match(page, /\{ id: "files", label: "Files", icon: IconFileText/);
  assert.match(page, /\{ id: "settings", label: "Settings", icon: IconSettings/);
  assert.match(page, /<main className=\{SECTION_RAIL_PAGE_GRID_CLASS\}/);
  assert.match(page, /<SectionRail items=\{NAV_ITEMS\} activeId=\{active\}/);
  assert.match(page, /gridTemplateColumns: `\$\{SECTION_RAIL_WIDTH\} minmax\(0,1fr\) 380px`/);
  assert.match(page, /<aside className="min-h-0 overflow-hidden rounded-2xl border bg-card\/92/);
});

test("Admin logging Settings keeps the topic levels list independently scrollable", async () => {
  const page = await source();

  assert.match(page, /data-testid="logging-topic-levels-list"/);
  assert.match(page, /data-testid="logging-topic-levels-list"[\s\S]*max-h-\[min\(52vh,620px\)\][\s\S]*overflow-y-auto/);
});

test("Admin logging file selection renders selected file entries in Files view", async () => {
  const page = await source();
  assert.match(page, /function FileLogView\(/);
  assert.match(page, /fileSize=\{currentFile\?\.size\}/);
  assert.match(page, /loadLogs\(\{ file: logFilters\.file \|\| currentFile\?\.name \|\| "" \}\)/);
  assert.doesNotMatch(page, /Select a JSONL file to render its events below/);
  assert.doesNotMatch(page, /setActive\("live"\); loadLogs\(\{ file \}\)/);
});

test("Admin logging confirmations use the custom AlertDialog instead of browser confirms", async () => {
  const page = await source();
  assert.match(page, /from "@\/components\/ui\/alert-dialog"/);
  assert.match(page, /function LoggingConfirmationDialog\(/);
  assert.match(page, /<AlertDialog open=\{Boolean\(confirmation\)\}/);
  assert.match(page, /Apply troubleshooting preset\?/);
  assert.match(page, /Enable JSONL file logging\?/);
  assert.doesNotMatch(page, /window\.confirm|window\.alert|window\.prompt/);
});

test("Admin logging settings expose Friendly console directly under Pretty console", async () => {
  const page = await source();
  assert.match(page, /consoleFriendly: config\.consoleFriendly === true/);
  assert.match(page, /ToggleRow label="Pretty console"/);
  assert.match(page, /ToggleRow label="Friendly console"[\s\S]*config\.consoleFriendly === true[\s\S]*updateConfig\(\{ consoleFriendly: checked \}\)/);
  assert.ok(page.indexOf('ToggleRow label="Pretty console"') < page.indexOf('ToggleRow label="Friendly console"'));
});

test("Admin logging Live SSE closes EventSource on errors and when leaving Live", async () => {
  const page = await source();

  assert.match(page, /const source = new EventSource\(`\/api\/admin\/logging\/stream\?\$\{params\.toString\(\)\}`\);/);
  assert.match(page, /source\.onerror = \(\) => \{[\s\S]*setLiveConnected\(false\);[\s\S]*source\.close\(\);[\s\S]*\};/);
  assert.match(page, /return \(\) => \{[\s\S]*setLiveConnected\(false\);[\s\S]*source\.close\(\);[\s\S]*\};/);
});

test("Admin logging entries stay compact and expand anywhere into CodeBlock JSON", async () => {
  const page = await source();
  assert.match(page, /import \{ CodeBlock, CodeBlockCopyButton \} from "@\/components\/ai-elements\/code-block"/);
  assert.match(page, /const \[expanded, setExpanded\] = React\.useState\(false\)/);
  assert.match(page, /role="button"/);
  assert.match(page, /onClick=\{\(\) => setExpanded\(\(open\) => !open\)\}/);
  assert.match(page, /onKeyDown=\{\(event\) => \{/);
  assert.match(page, /isInteractiveTarget\(event\.target\)/);
  assert.match(page, /aria-expanded=\{expanded\}/);
  assert.match(page, /line-clamp-1/);
  assert.match(page, /const message = entry\.message \|\| entry\.msg \|\| entry\.event \|\| "Log entry";/);
  assert.match(page, /maxCompactMetaItems/);
  assert.match(page, /compactMeta/);
  assert.match(page, /Full JSON entry/);
  assert.match(page, /<CodeBlock code=\{safeJsonStringify\(entry\)\} language="json" maxHeight=\{420\}>/);
  assert.match(page, /<CodeBlockCopyButton type="button"/);
  assert.doesNotMatch(page, /<details|<summary|<pre/);
});
