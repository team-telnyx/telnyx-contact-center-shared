import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("analyze route clears a *_first_name slot that duplicates its *_last_name", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");

  // Detects the *_first_name / *_last_name pair by naming convention.
  assert.match(route, /if \(!key\.endsWith\("_first_name"\)\) continue;/);
  assert.match(route, /const lastKey = `\$\{key\.slice\(0, -"_first_name"\.length\)\}_last_name`;/);
  // Fires only when normalized first === last (the unambiguous duplicate case).
  assert.match(route, /norm\(slotsFilled\[key\]\) === norm\(slotsFilled\[lastKey\]\)/);
  // A shared no-info sentinel ("N/A"/"unknown") in both slots is NOT treated as a
  // duplicate surname — otherwise the first name would be cleared/re-asked forever.
  assert.match(route, /const NAME_DUP_SENTINELS = new Set\(\[/);
  assert.match(route, /if \(NAME_DUP_SENTINELS\.has\(norm\(slotsFilled\[key\]\)\)\) continue;/);
  // Race-safe: a SINGLE atomic UPDATE drops the key, guarded on the LIVE DB still
  // showing first === last, so a concurrent correction is never wiped.
  assert.match(route, /SET slots_filled = slots_filled - \$2/);
  assert.match(route, /lower\(btrim\(slots_filled->>\$2\)\) = lower\(btrim\(slots_filled->>\$3\)\)/);
  assert.match(route, /if \(clearedSession\.length === 0\) continue;/);
  // Resets the item status, including completed_by = NULL so AI/insights upserts
  // can repopulate the reopened slot.
  assert.match(route, /SET status = 'pending', extracted_value = NULL/);
  assert.match(route, /completed_by = NULL/);
  assert.match(route, /i\.slot_name = \$2/);
  // Emits a cleared update for the client.
  assert.match(route, /cleared_reason: "name_first_equals_last"/);
  // Response carries null so the client merge re-asks (delta-null approach dropped).
  assert.match(route, /slotsFilled\[key\] = null;/);
  assert.doesNotMatch(route, /slotsDelta\[key\] = null;/);
});

test("workflow store resets an item when the analyzer clears/un-collects it", async () => {
  const store = await read("../lib/stores/workflow-store.js");
  assert.match(store, /if \(update\.status === "pending" \|\| update\.cleared_reason\)/);
  assert.match(store, /status: "pending",\s*\n\s*extracted_value: null,/);
  // Also nulls completion metadata so applyAiHandoffData stops rejecting the slot.
  assert.match(store, /completed_by: null,\s*\n\s*completed_at: null,\s*\n\s*source_transcript: null,/);
});

test("name-split prompt forbids duplicating a surname into the first-name slot", async () => {
  const prompts = await read("../lib/agent-assist/workflow-prompts.js");
  assert.match(prompts, /NEVER put the SAME word in both the first-name and last-name slots/);
  assert.match(prompts, /do NOT fill the first-name slot with a surname/);
});
