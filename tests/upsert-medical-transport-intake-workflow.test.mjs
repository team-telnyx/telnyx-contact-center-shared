import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("upsert script aborts (does not delete stages) when an active in_progress session exists, unless --force/FORCE=true is passed", async () => {
  // Replacing stages cascades to items and item statuses in the schema —
  // proceeding past a running session's in_progress state would wipe its
  // checklist/status rows and can null out its current stage mid-call.
  // Previously this only logged a warning and continued unconditionally.
  const source = await read("../scripts/upsert-medical-transport-intake-workflow.mjs");

  assert.match(source, /force = process\.env\.FORCE === "true" \|\| process\.argv\.includes\("--force"\)/);
  assert.match(source, /if \(activeSessions\.length > 0 && !force\) \{\s*\n[\s\S]*?throw new Error\(/);
  assert.match(source, /if \(activeSessions\.length > 0 && force\) \{/);

  // The abort happens BEFORE the destructive DELETE, and while still inside
  // the try block so the earlier workflow name/description UPDATE also rolls
  // back (no partial changes committed).
  const throwIdx = source.indexOf('throw new Error(\n        `Refusing to replace');
  const deleteIdx = source.indexOf("DELETE FROM aa_workflow_stages");
  assert.ok(throwIdx > -1 && deleteIdx > -1 && throwIdx < deleteIdx);
  assert.match(source, /catch \(error\) \{\s*\n\s*await client\.query\("ROLLBACK"\);\s*\n\s*throw error;/);
});

test("re-running the upsert against an EXISTING workflow never touches llm_model / llm_confidence_threshold", async () => {
  // llm_model is a per-workflow, admin-UI-editable setting (the model
  // dropdown) — someone may deliberately run a different model on this
  // workflow than the seed file's default, e.g. to compare slot-filling and
  // suggested-response latency/quality across models. The seed file's
  // llm_model must only seed a BRAND NEW workflow row; re-running the
  // script against an existing workflow (e.g. after a stage/item content
  // change) must never silently revert that live choice.
  const source = await read("../scripts/upsert-medical-transport-intake-workflow.mjs");

  // The INSERT branch (brand-new workflow) still seeds llm_model initially.
  assert.match(
    source,
    /INSERT INTO aa_workflows \(id, name, description, category, is_active, llm_model, llm_confidence_threshold\)/
  );

  // The UPDATE branch (existing workflow) must not reference either column.
  const updateMatch = source.match(/`UPDATE aa_workflows SET[\s\S]*?WHERE id = \$1`/);
  assert.ok(updateMatch, "expected an UPDATE aa_workflows statement");
  assert.doesNotMatch(updateMatch[0], /llm_model/);
  assert.doesNotMatch(updateMatch[0], /llm_confidence_threshold/);
});

test("re-running the upsert narrowly migrates ONLY a known-legacy bare llm_model, never a different/deliberate value (Codex review)", async () => {
  // A workflow row created back when this seed's own default was still the
  // bare (invalid, provider-unprefixed) "gpt-4o-mini" — before it was
  // corrected to "openai/gpt-4o-mini" — would otherwise stay stuck passing
  // that invalid id to Telnyx forever, since the test above confirms the
  // update branch never re-applies llm_model. Fix must be narrowly scoped:
  // only auto-correct the exact known-bad legacy value, never anything else
  // (an admin's deliberate model-dropdown override must survive re-runs).
  const source = await read("../scripts/upsert-medical-transport-intake-workflow.mjs");

  assert.match(source, /const LEGACY_LLM_MODEL_MIGRATIONS = \{\s*\n\s*"gpt-4o-mini": "openai\/gpt-4o-mini",\s*\n\s*\};/);
  assert.match(source, /const migratedModel = LEGACY_LLM_MODEL_MIGRATIONS\[workflow\.llm_model\];/);
  assert.match(source, /if \(migratedModel\) \{/);
  // The initial SELECTs must fetch llm_model so the migration has something
  // to check against.
  assert.match(source, /SELECT id, name, llm_model FROM aa_workflows WHERE id = \$1/);
  assert.match(source, /SELECT id, name, llm_model FROM aa_workflows WHERE name = \$1/);
});
