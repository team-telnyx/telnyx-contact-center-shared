import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../lib/outbound-dialer/api.js", import.meta.url), "utf8");

test("DNC scaffold suppression persists and restores the prior validation status", () => {
  assert.match(source, /DNC_SCAFFOLD_PREVIOUS_STATUS_KEY = "__dnc_scaffold_previous_validation_status"/);
  assert.match(source, /jsonb_set\([\s\S]*to_jsonb\(COALESCE\(row_data->>\$3, validation_status\)::text\)[\s\S]*validation_status='suppressed'/);
  assert.match(source, /SET validation_status = CASE[\s\S]*WHEN row_data->>\$2 IN \('valid', 'needs_review'\) THEN row_data->>\$2[\s\S]*ELSE 'valid'[\s\S]*row_data = row_data - \$2/);
  assert.match(source, /OR COALESCE\(row_data \? \$2, false\) = false/);
  assert.doesNotMatch(source, /SET validation_status='valid', updated_at=NOW\(\) WHERE id=\$1 AND validation_status='suppressed'/);
});
