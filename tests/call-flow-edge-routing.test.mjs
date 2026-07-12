import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const editorSource = await readFile(
  new URL("../app/(portal)/admin/call-flows/[id]/page.jsx", import.meta.url),
  "utf8",
);

test("call flow edges use rounded routing with clearance around endpoint nodes", () => {
  assert.match(editorSource, /getSmoothStepPath/);
  assert.doesNotMatch(editorSource, /getBezierPath/);
  assert.match(
    editorSource,
    /getSmoothStepPath\(\{[\s\S]*?borderRadius: 28,[\s\S]*?offset: 36,[\s\S]*?\}\)/,
  );
});
