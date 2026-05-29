import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function tableBlock(source, tableName) {
  const start = source.indexOf(`CREATE TABLE IF NOT EXISTS ${tableName}`);
  assert.notEqual(start, -1, `missing ${tableName} CREATE TABLE`);
  const end = source.indexOf("CREATE INDEX", start);
  assert.notEqual(end, -1, `missing ${tableName} index section after CREATE TABLE`);
  return source.slice(start, end);
}

test("data source tables define and migrate custom_data JSONB", async () => {
  const schema = await read("../lib/postgres-schema.mjs");

  for (const table of ["contacts", "kb_articles", "tasks"]) {
    assert.match(
      tableBlock(schema, table),
      /custom_data\s+JSONB\s+DEFAULT '\{\}'::jsonb/,
      `${table} must define custom_data as JSONB object storage`,
    );
    assert.match(
      schema,
      new RegExp(`ALTER TABLE ${table} ADD COLUMN custom_data JSONB DEFAULT '\\\{\\\}'::jsonb`),
      `${table} must migrate custom_data for existing databases`,
    );
    assert.match(
      schema,
      new RegExp(`CREATE INDEX IF NOT EXISTS idx_${table}_custom_data ON ${table} USING GIN \\(custom_data\\)`),
      `${table} must index custom_data for JSONB lookup`,
    );
  }
});

test("data source schema exposes custom_data object field", async () => {
  const source = await read("../lib/data-sources-schema.js");

  for (const entity of ["contacts", "kb_articles", "tasks"]) {
    const entityStart = source.indexOf(`case "${entity}":`);
    assert.notEqual(entityStart, -1, `missing ${entity} schema`);
    const nextCase = source.indexOf("case ", entityStart + 1);
    const block = source.slice(entityStart, nextCase === -1 ? undefined : nextCase);
    assert.match(block, /custom_data:\s*{[\s\S]*?type:\s*"object"/, `${entity} custom_data must be an object field`);
    assert.match(block, /description:\s*"Custom JSON object/, `${entity} custom_data description should be user-facing`);
  }
});

test("API routes persist custom_data in create and update paths", async () => {
  const routes = [
    "../app/api/contacts/route.js",
    "../app/api/contacts/[id]/route.js",
    "../app/api/admin/kb-articles/route.js",
    "../app/api/admin/kb-articles/[id]/route.js",
    "../app/api/tasks/route.js",
    "../app/api/tasks/[id]/route.js",
  ];

  for (const route of routes) {
    const source = await read(route);
    assert.match(source, /custom_data/, `${route} must reference custom_data`);
    assert.match(source, /normalizeCustomDataValue/, `${route} must validate custom_data as an object`);
  }
});

test("add/edit sheets render Custom Data JSON textarea and validate object JSON", async () => {
  const sheets = [
    "../components/contacts/EditSheet.jsx",
    "../components/kb-articles/EditSheet.jsx",
    "../components/tasks/EditSheet.jsx",
  ];

  for (const sheet of sheets) {
    const source = await read(sheet);
    assert.match(source, /Custom Data/, `${sheet} must render Custom Data section`);
    assert.match(source, /parseCustomDataText/, `${sheet} must parse and validate custom data text`);
    assert.match(source, /custom_data/, `${sheet} must submit custom_data payload`);
    assert.match(source, /JSON object/, `${sheet} must tell users the field expects a JSON object`);
  }
});
