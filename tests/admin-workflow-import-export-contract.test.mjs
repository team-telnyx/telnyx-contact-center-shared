import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflowsPage = readFileSync("app/(portal)/admin/workflows/page.jsx", "utf8");
const exportRoute = readFileSync("app/api/admin/workflows/[id]/export/route.js", "utf8");
const importRoute = readFileSync("app/api/admin/workflows/import/route.js", "utf8");

test("workflows page exposes import and export actions like call flows", () => {
  assert.match(workflowsPage, /IconUpload/);
  assert.match(workflowsPage, /IconDownload/);
  assert.match(workflowsPage, /handleImport/);
  assert.match(workflowsPage, /handleExport/);
  assert.match(workflowsPage, /\/api\/admin\/workflows\/import/);
  assert.match(workflowsPage, /\/api\/admin\/workflows\/\$\{[^}]+\}\/export/);
});

test("workflow export and import routes use portable bundle helpers", () => {
  assert.match(exportRoute, /buildWorkflowExportBundle/);
  assert.match(exportRoute, /workflowExportFilename/);
  assert.match(importRoute, /normalizeImportedWorkflowBundle/);
  assert.match(importRoute, /INSERT INTO aa_workflows/);
  assert.match(importRoute, /INSERT INTO aa_workflow_stages/);
  assert.match(importRoute, /INSERT INTO aa_workflow_items/);
});
