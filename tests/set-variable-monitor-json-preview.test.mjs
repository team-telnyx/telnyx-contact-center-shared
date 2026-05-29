import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Set Variable monitor formats JSON object results with CodeBlock preview", async () => {
  const source = await readFile(
    new URL("../app/(portal)/admin/call-flows/[id]/page.jsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /function getJsonObjectPreview\(value\)/,
    "Call flow monitor should detect JSON object previewable values",
  );
  assert.match(
    source,
    /JSON\.parse\(trimmed\)/,
    "String values that contain JSON should be parsed before rendering",
  );
  assert.match(
    source,
    /!Array\.isArray\(parsed\)/,
    "Only JSON objects, not arrays, should switch to object preview mode",
  );

  const setVariableStart = source.indexOf('if (nodeType === "set_variable")');
  const httpRequestStart = source.indexOf('if (nodeType === "http_request_action")', setVariableStart);
  assert.ok(setVariableStart > -1 && httpRequestStart > setVariableStart, "Set Variable monitor branch should exist");

  const setVariableSource = source.slice(setVariableStart, httpRequestStart);
  assert.match(setVariableSource, /resultJsonPreview/, "Set Variable result should use JSON preview detection");
  assert.match(setVariableSource, /<CodeBlock[\s\S]*code=\{resultJsonPreview\}[\s\S]*language="json"/, "JSON object results should render in the shared JSON CodeBlock");
  assert.match(setVariableSource, /<CodeBlockCopyButton \/>/, "JSON object previews should keep the copy button");
  assert.match(setVariableSource, /formatInlineValue\(details\.result\)/, "Non-JSON-object results should remain inline scalar text");
});
