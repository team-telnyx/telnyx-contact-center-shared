import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

// Codex review findings on PR #1350: custom headers must not store credentials
// in the plaintext mcp_servers.headers column, and must not collide with the
// generated authentication header.

test("custom header credentials are stored as secret references, never as plaintext", async () => {
  const runner = await read("lib/mcp/mcp-tool-runner.js");
  const sheet = await read("components/admin/MCPServerEditorSheet.jsx");

  assert.match(runner, /SECRET_HEADER_PATTERN/, "runtime should recognize secret-reference header values");
  assert.match(runner, /async function resolveConfiguredHeaders/, "configured headers should be resolved before use");
  assert.match(
    runner,
    /resolveConfiguredHeaders[\s\S]*getSecretByName\(secretRef\)/,
    "a referenced header secret should be read from the encrypted local secret store at request time",
  );
  assert.match(
    runner,
    /header '\$\{name\}' references local Contact Center secret/,
    "a missing header secret should fail loudly instead of sending an empty credential",
  );
  assert.doesNotMatch(
    runner,
    /const headers = \{ \.\.\.\(server\.headers/,
    "raw configured headers must not be passed through unresolved",
  );

  assert.match(sheet, /SecretRefCombobox\s*\n?\s*value=\{row\.value\}/, "header rows should offer the local secret picker");
  assert.match(sheet, /\{\{secret:\$\{value\}\}\}/, "secret-backed header rows should persist a reference, not the value");
});

test("generated auth headers win over custom rows regardless of casing", async () => {
  const runner = await read("lib/mcp/mcp-tool-runner.js");
  const sheet = await read("components/admin/MCPServerEditorSheet.jsx");

  assert.match(runner, /function setHeader\(headers, name, value\)/, "there should be one case-insensitive header setter");
  assert.match(
    runner,
    /existing\.toLowerCase\(\) === target\) delete headers\[existing\]/,
    "setting a header must remove any differently-cased duplicate",
  );
  assert.doesNotMatch(
    runner,
    /headers\.Authorization = /,
    "Authorization must be set through setHeader so a custom 'authorization' row cannot survive alongside it",
  );

  assert.match(sheet, /RESERVED_HEADER_NAMES/, "the editor should know which headers are generated");
  assert.match(sheet, /Reserved header/, "the editor should warn when a custom row collides with generated auth");
});

test("secret header references round-trip through the editor helpers", async () => {
  const source = await read("components/admin/MCPServerEditorSheet.jsx");
  const start = source.indexOf("const SECRET_HEADER_PATTERN");
  const end = source.indexOf("// Authentication headers are generated");
  assert.ok(start > -1 && end > start, "header helpers should be co-located and exportable for test");

  const helpers = source.slice(start, end);
  const helpers_mod = await import(`data:text/javascript,${encodeURIComponent(`${helpers}
export { headersObjectToRows, headerRowsToObject };`)}`);

  const rows = helpers_mod.headersObjectToRows({
    "Ocp-Apim-Subscription-Key": "{{secret:intake-apim-key}}",
    "X-Tenant": "acme",
  });
  assert.deepEqual(rows, [
    { name: "Ocp-Apim-Subscription-Key", value: "intake-apim-key", fromSecret: true },
    { name: "X-Tenant", value: "acme", fromSecret: false },
  ]);

  assert.deepEqual(helpers_mod.headerRowsToObject(rows), {
    "Ocp-Apim-Subscription-Key": "{{secret:intake-apim-key}}",
    "X-Tenant": "acme",
  });

  assert.deepEqual(
    helpers_mod.headerRowsToObject([{ name: "X-Empty-Secret", value: "  ", fromSecret: true }]),
    {},
    "a secret-backed row with no secret selected must not persist an empty reference",
  );
});
