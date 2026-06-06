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

test("Admin logging topics use toggles and level tabs instead of JSON editors", async () => {
  const page = await source();
  assert.match(page, /function LevelTabs\(/);
  assert.match(page, /<Switch checked=\{enabled\}/);
  assert.match(page, /Topic levels[\s\S]*Use toggles and level tabs instead of JSON configuration/);
  assert.doesNotMatch(page, /topicLevelsText|topicEnabledText|parseJsonField|prettyJson/);
  assert.match(page, /\^\[a-z0-9\]\[a-z0-9\._:-\]\{0,79\}\$/i);
  assert.doesNotMatch(page, /<Textarea[\s\S]*(Topic levels|Topic enabled)/);
});

test("Admin logging file selection refreshes Live entries for the selected file", async () => {
  const page = await source();
  assert.match(page, /const loadLogs = React\.useCallback\(async \(filterOverrides = \{\}\) =>/);
  assert.match(page, /const effectiveFilters = \{ \.\.\.logFilters, \.\.\.filterOverrides \}/);
  assert.match(page, /onSelect=\{\(file\) => \{ updateLogFilter\("file", file\); setActive\("live"\); loadLogs\(\{ file \}\); \}\}/);
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
