import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("analyze route persists slots_filled as an atomic jsonb MERGE of a delta, never a full overwrite", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");

  // A per-request delta object accumulates only the slots this request changed.
  assert.match(route, /const slotsDelta = \{\};/);
  assert.match(route, /slotsDelta\[item\.slot_name\] = accumulated;/);
  assert.match(route, /slotsDelta\[item\.slot_name\] = slotsFilled\[item\.slot_name\];/);

  // The write jsonb-merges the delta into the current row value and gates on the
  // delta (not the full snapshot). The old full-overwrite must be gone.
  assert.match(
    route,
    /SET slots_filled = COALESCE\(slots_filled, '\{\}'::jsonb\) \|\| \$1::jsonb/
  );
  assert.match(route, /if \(Object\.keys\(slotsDelta\)\.length > 0\)/);
  assert.match(route, /RETURNING slots_filled/);
  assert.doesNotMatch(route, /SET slots_filled = \$1, updated_at = NOW\(\)/);
  assert.doesNotMatch(route, /\[JSON\.stringify\(slotsFilled\), workflowSession\.id\]/);
});

test("workflow store merges slotsFilled from analyze responses instead of replacing", async () => {
  const store = await read("../lib/stores/workflow-store.js");
  assert.match(
    store,
    /slotsFilled: \{ \.\.\.state\.slotsFilled, \.\.\.data\.slotsFilled \}/
  );
  assert.doesNotMatch(store, /set\(\{ slotsFilled: data\.slotsFilled \}/);
});
