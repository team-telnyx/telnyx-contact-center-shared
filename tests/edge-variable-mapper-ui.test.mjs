import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const repoRoot = new URL("../", import.meta.url);

async function read(path) {
  return readFile(new URL(path, repoRoot), "utf8");
}

test("Configure Edge Variables sheet matches standard edit sheet shell", async () => {
  const source = await read("components/voice-flow/EdgeVariableMapper.jsx");

  assert.match(source, /<Sheet open=\{open\} onOpenChange=\{handleOpenChange\}>/);
  assert.match(source, /<SheetContent[\s\S]*side="right"[\s\S]*className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"/);
  assert.match(source, /<SheetHeader className="px-6 py-4 border-b"/);
  assert.match(source, /<SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2"/);
  assert.match(source, /Card className="mx-5 my-4"/);
  assert.match(source, /<SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2"/);
  assert.doesNotMatch(source, /fixed inset-y-0 right-0/);
  assert.doesNotMatch(source, /bg-background border-l shadow-2xl/);
});

test("HTTP Request action edge mapper can read persisted test response payloads", async () => {
  const source = await read("components/voice-flow/EdgeVariableMapper.jsx");

  assert.match(source, /sourceNode\?\.data\?\.config\?\.testResponse/);
  assert.match(source, /extractPathsFromObject\(testResponse\.body, responseVariable\)/);
  assert.match(source, /sourceLabel: "HTTP Response Structure"/);
  assert.doesNotMatch(source, /Please run a test request[\s\S]*without checking persisted testResponse/);
});

test("Expected payload structure supports checkbox multi-select and batch Add Mapping", async () => {
  const source = await read("components/voice-flow/EdgeVariableMapper.jsx");

  assert.match(source, /selectedSourcePaths/);
  assert.match(source, /Checkbox[\s\S]*checked=\{isAlreadyMapped \|\| selectedSourcePaths\.has\(field\.path\)\}/);
  assert.match(source, /addSelectedMappings/);
  assert.match(source, /Add \{selectedSourcePaths\.size \|\| ""\} Mapping/);
  assert.doesNotMatch(source, /<Select[\s\S]*updateMapping\(index, "sourcePath"/);
});

test("Mapping picker only adds selected keys and disables already mapped keys", async () => {
  const source = await read("components/voice-flow/EdgeVariableMapper.jsx");

  assert.doesNotMatch(source, /Auto-suggest Variable Mappings/);
  assert.doesNotMatch(source, /autoSuggestMappings/);
  assert.match(source, /mappedSourcePaths/);
  assert.match(source, /checked=\{isAlreadyMapped \|\| selectedSourcePaths\.has\(field\.path\)\}/);
  assert.match(source, /disabled=\{isAlreadyMapped\}/);
  assert.match(source, /aria-disabled=\{isAlreadyMapped\}/);
});

test("Mapping list uses telnyx-green source badges without duplicate source path controls", async () => {
  const source = await read("components/voice-flow/EdgeVariableMapper.jsx");

  assert.match(source, /getSourcePathBadgeClass/);
  assert.match(source, /text-telnyx-green border-telnyx-green\/40 bg-telnyx-green\/10/);
  assert.match(source, /<Badge[\s\S]*\{mapping\.sourcePath \|\| "No source selected"\}[\s\S]*<\/Badge>/);
  assert.doesNotMatch(source, /Mapping \{index \+ 1\}/);
  assert.doesNotMatch(source, /<Label className="text-xs">Source Path<\/Label>/);
  assert.doesNotMatch(source, /Source path is locked after adding\. Select a different payload field above to add another mapping\./);
  assert.match(source, /updateMapping\(index, "variableName", e\.target\.value\)/);
  assert.match(source, /updateMapping\(index, "description", e\.target\.value\)/);
});

test("JSON payload view uses the standard CodeBlock viewer and shows mapped key badges", async () => {
  const source = await read("components/voice-flow/EdgeVariableMapper.jsx");

  assert.match(source, /CodeBlock,/);
  assert.match(source, /CodeBlockCopyButton/);
  assert.match(source, /renderJsonPayloadView/);
  assert.match(source, /Mapped in this edge/);
  assert.doesNotMatch(source, /JSON object view with selectable keys/);
});

test("Data Action edge mapping exposes response payload structures from data-source schemas", async () => {
  const source = await read("components/voice-flow/EdgeVariableMapper.jsx");

  assert.match(source, /isDataActionNode/);
  assert.match(source, /getDataActionResponseSchemaPaths/);
  assert.match(source, /getEntitySchema\(dataSource\)/);
  assert.match(source, /data_response\.rows\.0/);
  assert.doesNotMatch(source, /path: `\$\{responseVariable\}\.rows\[\]`/);
  assert.match(source, /Data Action Response Structure/);
});
