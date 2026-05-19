import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");

test("outbound campaign uses Active toggle instead of Launch State select", () => {
  assert.match(source, /ToggleRow label="Active" checked=\{isActiveCampaignConfig\(draft\)\} onCheckedChange=\{\(checked\) => update\(activeToggleStatusPatch\(checked, "ready", "draft"\)\)\}/);
  assert.match(source, /Active campaigns are visible in Command Center and can be started\. Not active campaigns stay in Draft configuration\./);
  assert.doesNotMatch(source, /ConfigSelect label="Launch State"/);
});

test("campaign configuration only receives active reusable resources", () => {
  assert.match(source, /const activeDncLists = useMemo\(\(\) => dncLists\.filter\(isActiveConfigItem\), \[dncLists\]\);/);
  assert.match(source, /const activeFilters = useMemo\(\(\) => filters\.filter\(isActiveConfigItem\), \[filters\]\);/);
  assert.match(source, /const activeTimeSets = useMemo\(\(\) => timeSets\.filter\(isActiveConfigItem\), \[timeSets\]\);/);
  assert.match(source, /dncLists=\{active === "campaigns" \? activeDncLists : dncLists\} filters=\{active === "campaigns" \? activeFilters : filters\} timeSets=\{active === "campaigns" \? activeTimeSets : timeSets\}/);
});

test("contact list, DNC, filter, time set, and disposition forms use Active toggles", () => {
  assert.match(source, /ToggleRow label="Active" checked=\{draft\.status === "validated"\} disabled=\{!validationAllowed\} onCheckedChange=\{\(checked\) => update\(activeToggleStatusPatch\(checked && validationAllowed, "validated", "draft"\)\)\}/);
  assert.match(source, /ToggleRow label="Active" checked=\{draft\.status === "active"\} onCheckedChange=\{\(checked\) => update\(activeToggleStatusPatch\(checked\)\)\}/);
  assert.match(source, /Active DNC lists are visible on campaign configuration\./);
  assert.match(source, /Active filters are visible on campaign configuration\./);
  assert.match(source, /Active time sets are visible on campaign configuration\./);
  assert.match(source, /Active disposition mappings are available for campaign workflows\./);
  assert.doesNotMatch(source, /ToggleRow label="Validated"/);
});

test("inventory tables present Active instead of status labels for outbound reusable resources", () => {
  assert.match(source, /columns=\{\["Name", "Active", "List", "Mode", "Actions"\]\}/);
  assert.match(source, /columns=\{\["Name", "Active", "Records", "Valid phones", "Fields", "Actions"\]\}/);
  assert.match(source, /columns=\{\["Name", "Active", "Source", "Match", "Records", "Actions"\]\}/);
  assert.match(source, /columns=\{\["Name", "Active", "Contact list", "Rules", "Actions"\]\}/);
  assert.match(source, /columns=\{\["Name", "Active", "Time zone", "Windows", "Actions"\]\}/);
  assert.match(source, /columns=\{\["Wrap-up code", "Scope", "Classification", "Business Category", "Active", "Actions"\]\}/);
});
