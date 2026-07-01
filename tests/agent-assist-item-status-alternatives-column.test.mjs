import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("schema adds an idempotent ALTER TABLE for aa_workflow_item_status.alternatives JSONB column", async () => {
  const schema = await read("../lib/postgres-schema.mjs");

  // Idempotent ADD COLUMN using IF NOT EXISTS (matches the simpler idempotent
  // pattern used elsewhere in the schema, e.g. for hp_phones columns).
  assert.match(
    schema,
    /ALTER TABLE aa_workflow_item_status ADD COLUMN IF NOT EXISTS alternatives JSONB/
  );

  // The new column must be JSONB (not text/varchar/etc.) — alternatives are
  // arrays of {value, confidence} objects.
  assert.match(schema, /alternatives JSONB/);

  // Ensure we did NOT accidentally drop or rename the column elsewhere.
  assert.doesNotMatch(schema, /DROP COLUMN alternatives/i);
});
