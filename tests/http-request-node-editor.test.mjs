import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const editorUrl = new URL(
  "../components/voice-flow/HttpRequestNodeEditor.jsx",
  import.meta.url,
);
const variableInputUrl = new URL(
  "../components/voice-flow/VariableInput.jsx",
  import.meta.url,
);
const variableTextareaUrl = new URL(
  "../components/voice-flow/VariableTextarea.jsx",
  import.meta.url,
);
const testModalUrl = new URL(
  "../components/voice-flow/HttpRequestTestModal.jsx",
  import.meta.url,
);
const testRouteUrl = new URL(
  "../app/api/voice/flows/test-http-request/route.js",
  import.meta.url,
);

test("HTTP request editor does not render a separate secret button for added headers", async () => {
  const source = await readFile(editorUrl, "utf8");

  assert.doesNotMatch(source, /insertSecretReference/);
  assert.doesNotMatch(source, /<IconKey[^>]*className="h-4 w-4 text-telnyx-green"/);
  assert.doesNotMatch(source, /\{\/\* Secrets Dropdown \*\/\}/);
});

test("HTTP request value inputs pass secrets into {{ autocomplete", async () => {
  const source = await readFile(editorUrl, "utf8");

  const variableInputUses = source.match(/<VariableInput[\s\S]*?availableSecrets=\{availableSecrets\}/g) || [];
  assert.ok(variableInputUses.length >= 5, "URL, header, path, query, and body params should pass availableSecrets");
});

test("variable autocomplete groups Secrets above Variables", async () => {
  const inputSource = await readFile(variableInputUrl, "utf8");
  const textareaSource = await readFile(variableTextareaUrl, "utf8");

  for (const source of [inputSource, textareaSource]) {
    assert.match(source, /availableSecrets = \[\]/);
    const secretsHeadingIndex = source.indexOf('CommandGroup heading="Secrets"');
    const variablesHeadingIndex = source.indexOf('CommandGroup heading="Variables"');
    assert.ok(secretsHeadingIndex > -1, "Secrets group must be rendered");
    assert.ok(variablesHeadingIndex > -1, "Variables group must be rendered");
    assert.ok(secretsHeadingIndex < variablesHeadingIndex, "Secrets group should appear before Variables");
    assert.match(source, /varName\.startsWith\("\{\{"\)/);
    assert.match(source, /insertedValue/);
    assert.match(source, /\{\{#integration_secret\}\}\$\{secret\.name\}\{\{\/integration_secret\}\}/);
  }
});

test("added HTTP request parameter names render as Telnyx green badges", async () => {
  const source = await readFile(editorUrl, "utf8");
  const modalSource = await readFile(testModalUrl, "utf8");

  assert.match(source, /className="[^"]*text-telnyx-green[^"]*border-telnyx-green/);
  assert.match(modalSource, /className="[^"]*text-telnyx-green[^"]*border-telnyx-green/);
});

test("test HTTP request route parses empty or non-JSON responses safely", async () => {
  const source = await readFile(testRouteUrl, "utf8");

  assert.match(source, /await response\.text\(\)/);
  assert.match(source, /responseText\.trim\(\)/);
  assert.match(source, /return null;/);
  assert.doesNotMatch(source, /await response\.json\(\)/);
});
