import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const repoRoot = new URL("../", import.meta.url);

async function read(path) {
  return readFile(new URL(path, repoRoot), "utf8");
}

test("Configure Edge Variables sheet matches standard edit sheet shell", async () => {
  const source = await read("components/voice-flow/EdgeVariableMapper.jsx");

  assert.match(source, /fixed inset-y-0 right-0 w-full sm:max-w-xl overflow-hidden flex flex-col p-0/);
  assert.match(source, /px-6 py-4 border-b/);
  assert.match(source, /text-xl font-bold text-telnyx-green flex items-center gap-2/);
  assert.match(source, /Card className="mx-5 my-4"/);
});

test("Expected payload structure supports checkbox multi-select and batch Add Mapping", async () => {
  const source = await read("components/voice-flow/EdgeVariableMapper.jsx");

  assert.match(source, /selectedSourcePaths/);
  assert.match(source, /Checkbox[\s\S]*checked=\{selectedSourcePaths\.has\(field\.path\)\}/);
  assert.match(source, /addSelectedMappings/);
  assert.match(source, /Add \{selectedSourcePaths\.size \|\| ""\} Mapping/);
  assert.doesNotMatch(source, /<Select[\s\S]*updateMapping\(index, "sourcePath"/);
});

test("Mapping list renders source paths as immutable colored badges and editable names/descriptions", async () => {
  const source = await read("components/voice-flow/EdgeVariableMapper.jsx");

  assert.match(source, /getSourcePathBadgeClass/);
  assert.match(source, /<Badge[\s\S]*\{mapping\.sourcePath \|\| "No source selected"\}[\s\S]*<\/Badge>/);
  assert.doesNotMatch(source, /Mapping \{index \+ 1\}/);
  assert.match(source, /Source path is locked after adding\. Select a different payload field above to add another mapping\./);
  assert.match(source, /updateMapping\(index, "variableName", e\.target\.value\)/);
  assert.match(source, /updateMapping\(index, "description", e\.target\.value\)/);
});

test("JSON payload view renders selectable key rows instead of read-only code only", async () => {
  const source = await read("components/voice-flow/EdgeVariableMapper.jsx");

  assert.match(source, /renderSelectableJsonView/);
  assert.match(source, /JSON object view with selectable keys/);
  assert.match(source, /selectedSourcePaths\.has\(field\.path\)/);
});

test("Data Action edge mapping exposes response payload structures from data-source schemas", async () => {
  const source = await read("components/voice-flow/EdgeVariableMapper.jsx");

  assert.match(source, /isDataActionNode/);
  assert.match(source, /getDataActionResponseSchemaPaths/);
  assert.match(source, /getEntitySchema\(dataSource\)/);
  assert.match(source, /data_response\.rows\[\]/);
  assert.match(source, /Data Action Response Structure/);
});
