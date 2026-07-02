import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Call Flow Start AI Assistant node loads AI assistants from the shared API", async () => {
  const source = await readFile(new URL("../app/(portal)/admin/call-flows/[id]/page.jsx", import.meta.url), "utf8");

  assert.match(source, /const \[aiAssistants, setAiAssistants\] = useState\(\[\]\)/, "Call flow editor should keep AI assistants in state");
  assert.match(source, /fetch\("\/api\/ai\/assistants\?pageSize=1000"/, "Call flow editor should load assistants from the same API used elsewhere");
  assert.match(source, /setAiAssistants\(.*normalizeAiAssistants/, "Call flow editor should normalize assistant API shapes before rendering");
  assert.doesNotMatch(source, /AI assistants not available in contact center - leave empty/, "Call flow editor should not intentionally leave AI assistants empty");

  const editorStart = source.indexOf('paramDef.type ===\n                                    "ai_assistant_select"');
  const editorEnd = source.indexOf(') : paramDef.type === "select"', editorStart);
  assert.ok(editorStart > -1 && editorEnd > editorStart, "AI assistant selector branch should exist");
  const editorSource = source.slice(editorStart, editorEnd);
  assert.match(editorSource, /aiAssistants[\s\S]*\.map\(\(assistant\) =>/, "AI assistant selector should render loaded assistants");
  assert.match(editorSource, /No AI assistants available/, "AI assistant selector should keep a clear empty state");
});
