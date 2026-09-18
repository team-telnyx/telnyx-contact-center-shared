import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function executeSource() {
  return readFile(new URL("lib/agent-assist/slot-mcp-execute.js", root), "utf8");
}

test("MCP result persistence is fenced by the post-claim slots version", async () => {
  const source = await executeSource();
  assert.match(source, /expectedSlotsVersion = null/);
  assert.match(source, /\$12::bigint IS NULL OR COALESCE\(slots_version, 0\) = \$12::bigint/);
  assert.match(source, /expectedSlotsVersion,/);
});

test("releasing failed claim metadata does not advance the slot snapshot version", async () => {
  const source = await executeSource();
  // Bounded by the function's own closing brace rather than by whatever happens
  // to follow it - the original pattern assumed a docblock came next and broke
  // the moment the neighbouring function moved.
  const releaseBody = source.match(/async function releaseInvocation[\s\S]*?\n\}\n/)?.[0] || "";
  assert.ok(releaseBody.length > 0);
  assert.doesNotMatch(releaseBody, /slots_version\s*=/);
});

test("ambiguous alternatives cannot demote a completed agent override", async () => {
  const source = await executeSource();
  assert.match(
    source,
    /AND \(status IS DISTINCT FROM 'completed' OR completed_by IS DISTINCT FROM 'agent'\)/,
  );
  assert.match(source, /if \(rowCount > 0\) \{\s*itemUpdates\.push\(\{/);
});

test("persistence SQL uses a fixed null-gated CAS parameter shape", async () => {
  const source = await executeSource();
  assert.match(source, /\$7::text IS NULL OR/);
  assert.match(source, /\$10::text IS NULL OR/);
  assert.match(source, /\$12::bigint IS NULL OR/);
});
