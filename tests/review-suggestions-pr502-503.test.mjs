import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("HTTP Request initiator auth requires a token during flow validation", async () => {
  const source = await read("../lib/voice-flow-validator.js");

  assert.match(source, /nodeType === "http_request"/, "validator must handle HTTP Request initiators explicitly");
  assert.match(source, /auth_required === true \|\| config\.auth_required === "true"/, "validator must detect enabled auth");
  assert.match(source, /requires an Authentication Token when authentication is enabled/, "validator must reject auth without a token");
});

test("data action failures do not fall back to success edges without a matching error edge", async () => {
  const source = await read("../lib/voice-flow-engine.js");

  assert.match(source, /const hasExplicitOutput = Number\.isInteger\(executionState\.lastOutput\)/, "engine must distinguish explicit output routing from default routing");
  assert.match(source, /if \(hasExplicitOutput && matchingEdges\.length === 0\) \{\s*return \[\];\s*\}/, "engine must stop when explicit output has no matching edge");
});

test("data action field variables preserve direct object and array values", async () => {
  const source = await read("../lib/voice-flow-engine.js");

  assert.match(source, /function replaceDataActionFieldValue\(value, variables\)/, "engine must have a data-action field resolver");
  assert.match(source, /resolveVariablePath\(variables, singleVariableMatch\[1\]\)/, "direct variable field values must use raw resolved values");
  assert.match(source, /const processedValue = replaceDataActionFieldValue\(value, variables\);\s*createBody\[key\] = processedValue;/, "create bodies must preserve direct object variables");
  assert.match(source, /const processedValue = replaceDataActionFieldValue\(value, variables\);\s*updateBody\[key\] = processedValue;/, "update bodies must preserve direct object variables");
});
