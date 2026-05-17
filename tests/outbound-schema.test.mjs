import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeContactFieldSchema, normalizeContactFieldType } from "../lib/outbound-dialer/schema.js";

test("contact field schema preserves imported column names and semantic identity field types", () => {
  const schema = normalizeContactFieldSchema([
    { name: "First Name", type: "first_name", required: true },
    { name: "Last Name", type: "last_name" },
    { name: "Company", type: "company" },
  ]);

  assert.deepEqual(schema, [
    { name: "First Name", type: "first_name", required: true, label: "First Name" },
    { name: "Last Name", type: "last_name", required: false, label: "Last Name" },
    { name: "Company", type: "company", required: false, label: "Company" },
  ]);
});

test("contact field type normalization accepts UI labels for semantic identity fields", () => {
  assert.equal(normalizeContactFieldType("First Name"), "first_name");
  assert.equal(normalizeContactFieldType("Last Name"), "last_name");
  assert.equal(normalizeContactFieldType("Display Name"), "display_name");
  assert.equal(normalizeContactFieldType("Company"), "company");
  assert.equal(normalizeContactFieldType("unknown"), "text");
});

test("outbound campaigns schema allows stopped status used by execution completion", async () => {
  const schema = await readFile(new URL("../lib/postgres-schema.mjs", import.meta.url), "utf8");
  assert.match(schema, /status IN \('draft', 'ready', 'paused', 'running', 'stopped', 'completed', 'archived'\)/);
});
