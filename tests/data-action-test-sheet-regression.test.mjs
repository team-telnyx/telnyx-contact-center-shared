import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, repoRoot), "utf8");

test("Data Action editor exposes Test Data Action sheet and persists live response", async () => {
  const editorSource = await read("components/voice-flow/DataActionsNodeEditor.jsx");
  const sheetSource = await read("components/voice-flow/DataActionTestSheet.jsx");

  assert.match(editorSource, /import \{ useState, useMemo, useRef \} from "react"/);
  assert.match(editorSource, /import DataActionTestSheet from "\.\/DataActionTestSheet"/);
  assert.match(editorSource, /IconFlask/);
  assert.match(editorSource, /Test Data Action/);
  assert.match(editorSource, /testResponse/);
  assert.match(editorSource, /testedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(editorSource, /<DataActionTestSheet/);

  assert.match(sheetSource, /<Sheet open=\{open\} onOpenChange=\{onOpenChange\}>/);
  assert.match(sheetSource, /Test your Data Action configuration with variable substitution/);
  assert.match(sheetSource, /Variable Values/);
  assert.match(sheetSource, /Request Preview/);
  assert.match(sheetSource, /Response Body/);
  assert.match(sheetSource, /\/api\/voice\/flows\/test-data-action/);
  assert.match(sheetSource, /CodeBlockCopyButton/);
});

test("Data Action test route supports CRUD and list actions with variable substitution", async () => {
  const routeSource = await read("app/api/voice/flows/test-data-action/route.js");
  const schemaSource = await read("lib/data-sources-schema.js");

  assert.match(schemaSource, /export function getEntitySearchPath/);
  assert.match(routeSource, /getEntityBasePath/);
  assert.match(routeSource, /getEntitySearchPath/);
  assert.match(routeSource, /function substituteVariables/);
  assert.match(routeSource, /case "create"/);
  assert.match(routeSource, /case "read"/);
  assert.match(routeSource, /case "update"/);
  assert.match(routeSource, /case "delete"/);
  assert.match(routeSource, /case "list"/);
  assert.match(routeSource, /TELNYX_AI_API_KEY/);
  assert.match(routeSource, /request\.headers\.get\("cookie"\)/);
  assert.match(routeSource, /request\.headers\.get\("authorization"\)/);
  assert.match(routeSource, /NextResponse\.json/);
});
