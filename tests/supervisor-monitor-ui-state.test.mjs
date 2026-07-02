import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("supervisor monitor restores and persists the last selected section", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/monitor/page.jsx", import.meta.url), "utf8");
  const navSource = await readFile(new URL("../components/contact-center/MonitorSectionNav.jsx", import.meta.url), "utf8");
  const pageStart = source.indexOf("export default function MonitorPage");
  const pageEnd = source.indexOf("const selectMonitorSection", pageStart);
  assert.ok(pageStart > -1 && pageEnd > pageStart, "MonitorPage should exist before selectMonitorSection");

  const pageSource = source.slice(pageStart, pageEnd);

  assert.match(navSource, /MONITOR_ACTIVE_SECTION_STORAGE_KEY\s*=\s*"supervisor\.monitor\.activeSection"/, "Shared nav should define the scoped storage key for the selected section");
  assert.match(source, /activeSection: MONITOR_ACTIVE_SECTION_STORAGE_KEY/, "Monitor should use the shared scoped storage key for the selected section");
  assert.match(pageSource, /localStorage\.getItem\(MONITOR_UI_STATE_STORAGE_KEYS\.activeSection\)/, "Monitor should restore the selected section from localStorage");
  assert.match(pageSource, /MONITOR_RAIL_ITEMS\.some\(\(item\) => item\.id === savedActiveTab\)/, "Restored monitor section should be validated against known rail items");
  assert.match(pageSource, /localStorage\.setItem\(MONITOR_UI_STATE_STORAGE_KEYS\.activeSection, activeTab\)/, "Monitor should save section changes to localStorage");
});
