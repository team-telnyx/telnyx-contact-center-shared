import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routePath = new URL(
  "../app/api/voice/webhook/incoming/[flowId]/route.js",
  import.meta.url,
);
const enginePath = new URL("../lib/voice-flow-engine.js", import.meta.url);

async function read(url) {
  return readFile(url, "utf8");
}

function extractArrayAfter(source, marker) {
  const index = source.indexOf(marker);
  assert.notEqual(index, -1, `Missing marker ${marker}`);
  const start = source.indexOf("[", index);
  assert.notEqual(start, -1, `Missing array after ${marker}`);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "[") depth += 1;
    if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unterminated array after ${marker}`);
}

test("Data Action is treated as an immediate node in incoming webhook continuations", async () => {
  const source = await read(routePath);
  const arrays = [];
  let searchFrom = 0;
  while (true) {
    const markerIndex = source.indexOf("const logicalNodeTypes =", searchFrom);
    if (markerIndex === -1) break;
    arrays.push(extractArrayAfter(source.slice(markerIndex), "const logicalNodeTypes ="));
    searchFrom = markerIndex + 1;
  }

  assert.equal(arrays.length, 3, "expected all incoming webhook continuation contexts to be covered");
  arrays.forEach((arraySource, index) => {
    assert.match(arraySource, /"data_action"/, `logicalNodeTypes array ${index + 1} must include data_action`);
  });
});

test("MCP Tool is treated as an immediate node in incoming webhook continuations", async () => {
  const source = await read(routePath);
  const arrays = [];
  let searchFrom = 0;
  while (true) {
    const markerIndex = source.indexOf("const logicalNodeTypes =", searchFrom);
    if (markerIndex === -1) break;
    arrays.push(extractArrayAfter(source.slice(markerIndex), "const logicalNodeTypes ="));
    searchFrom = markerIndex + 1;
  }

  assert.equal(arrays.length, 3, "expected all incoming webhook continuation contexts to be covered");
  arrays.forEach((arraySource, index) => {
    assert.match(arraySource, /"mcp_tool"/, `logicalNodeTypes array ${index + 1} must include mcp_tool`);
  });
});

test("Data Action execution returns explicit output indexes for success and error routing", async () => {
  const source = await read(enginePath);
  const start = source.indexOf("async function executeDataActionNode(");
  assert.notEqual(start, -1, "missing executeDataActionNode");
  const dataActionSource = source.slice(start);

  assert.match(
    dataActionSource,
    /success:\s*response\.ok,[\s\S]*output,[\s\S]*\[responseVariable\]: responseData/,
    "HTTP 4xx/5xx Data Action responses must return success=false with output=1 so Error edge can be followed",
  );
  assert.match(
    dataActionSource,
    /Data action node missing data source[\s\S]*success:\s*false,[\s\S]*output:\s*1/,
    "configuration errors should explicitly route to Data Action Error output",
  );
});

test("edge mappings can resolve Data Action response variables", async () => {
  const source = await read(enginePath);

  assert.match(
    source,
    /extractVariablesFromWebhook\(\s*payload,\s*edge\.data\.variableMappings,\s*executionState\.variables \|\| \{},\s*\)/,
    "determineNextNodes must pass existing execution variables so Data Action response mappings can resolve",
  );
  assert.match(
    source,
    /const rootScope = \{[\s\S]*payload,[\s\S]*query: payload\?\.query \|\| \{},[\s\S]*\.\.\.\(variablesScope \|\| \{}\),[\s\S]*\}/,
    "edge mapping extraction should resolve source paths against execution variables as well as webhook payload roots",
  );
  assert.match(
    source,
    /sourcePath\.includes\("\[\]"\)[\s\S]*sourcePath\.replaceAll\("\[\]", "\.0"\)/,
    "legacy Data Action list mappings using rows[] should resolve to the first row instead of failing",
  );
});

test("edge mappings preserve nested array fallback markers before final list extraction", async () => {
  const source = await read(enginePath);

  assert.match(
    source,
    /sourcePath\.endsWith\("\[\]"\)\s*\?\s*sourcePath\.slice\(0, -2\)\.replaceAll\("\[\]", "\.0"\)/,
    "final [] mappings should strip only the final marker while earlier array markers fall back to the first parent item",
  );
  assert.doesNotMatch(
    source,
    /sourcePath\.replaceAll\("\[\]", ""\)/,
    "nested list mappings must not strip every array marker because paths like orders[].items[] would become orders.items",
  );
});
