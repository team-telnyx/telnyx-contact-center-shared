import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const callFlowEditor = readFileSync(
  new URL("../app/(portal)/admin/call-flows/[id]/page.jsx", import.meta.url),
  "utf8"
);
const workflowEditor = readFileSync(
  new URL("../app/(portal)/admin/workflows/[id]/page.jsx", import.meta.url),
  "utf8"
);
const callFlowList = readFileSync(
  new URL("../app/(portal)/admin/call-flows/page.jsx", import.meta.url),
  "utf8"
);

test("automation editors keep the Automations rail visible", () => {
  assert.match(
    callFlowEditor,
    /<AutomationsSectionPage activeId="call-app-flows">/
  );
  assert.match(
    workflowEditor,
    /<AutomationsSectionPage activeId="workflows">/
  );
});

test("call flow editor relies on the rail instead of an Exit action", () => {
  assert.doesNotMatch(callFlowEditor, />\s*Exit\s*</);
  assert.doesNotMatch(callFlowEditor, /handleBackClick/);
});

test("workflow editor exposes actions in the main header without duplicate Back/name row", () => {
  assert.match(workflowEditor, /<AdminPageHeader[\s\S]*?actions=\{workflowActions\}/);
  assert.doesNotMatch(workflowEditor, />\s*Back\s*</);
  assert.doesNotMatch(workflowEditor, /text-lg font-semibold.*workflow\?\.name/);
});

test("automation editors guard rail and global link navigation with the custom unsaved dialog", () => {
  for (const editor of [callFlowEditor, workflowEditor]) {
    assert.match(editor, /onNavigate=\{requestNavigation\}/);
    assert.match(editor, /document\.addEventListener\("click", handleDocumentNavigation, true\)/);
    assert.match(editor, /<AlertDialogTitle>Unsaved Changes<\/AlertDialogTitle>/);
    assert.match(editor, /Leave without saving/);
    assert.match(editor, /addEventListener\("beforeunload"/);
  }
});

test("workflow item edits contribute to the page-level dirty state", () => {
  assert.match(workflowEditor, /onDirtyChange=\{setItemEditorDirty\}/);
  assert.match(workflowEditor, /workflowDetailsDirty \|\|[\s\S]*itemEditorDirty/);
});

test("Call & App Flows uses the same colored icon action pattern as Workflows", () => {
  assert.match(callFlowList, /IconEdit className="size-4"/);
  assert.match(callFlowList, /text-telnyx-green[\s\S]*title="Edit flow"/);
  assert.match(callFlowList, /text-blue-500[\s\S]*title="Duplicate flow"/);
  assert.match(callFlowList, /text-violet-500[\s\S]*title="Export flow"/);
  assert.match(callFlowList, /text-red-500[\s\S]*title="Delete flow"/);
  assert.doesNotMatch(callFlowList, /IconPencil/);
});

test("Call & App Flows uses the Workflows paging pattern", () => {
  assert.match(callFlowList, /const \[pageSize, setPageSize\] = useState\(10\)/);
  assert.match(callFlowList, /Rows per page/);
  for (const size of ["10", "25", "50", "100"]) {
    assert.match(callFlowList, new RegExp(`<SelectItem value="${size}">${size}<\\/SelectItem>`));
  }
  assert.match(callFlowList, /Page \{page\} of \{totalPages\}/);
  assert.match(callFlowList, /Total: \{total\}/);
  assert.match(callFlowList, /size="sm"[\s\S]*IconChevronsLeft/);
  assert.doesNotMatch(callFlowList, /size="icon"[\s\S]*IconChevronsLeft/);
});
