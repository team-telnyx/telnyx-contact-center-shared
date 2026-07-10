import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("workflow schema/API persist multiple data action buttons with one-click settings", async () => {
  const schema = await readFile(new URL("lib/postgres-schema.mjs", root), "utf8");
  const route = await readFile(new URL("app/api/admin/workflows/[id]/route.js", root), "utf8");

  assert.match(schema, /data_action_buttons JSONB DEFAULT '\[\]'::jsonb/);
  assert.match(schema, /data_action_statuses JSONB DEFAULT '\{\}'::jsonb/);
  assert.match(route, /data_action_buttons/);
  assert.match(route, /normalizeWorkflowDataActionButtons/);
});

test("workflow session API returns configured Data Action buttons to Agent Desktop", async () => {
  const route = await readFile(new URL("app/api/agent-assist/workflow/session/route.js", root), "utf8");

  assert.match(route, /w\.data_action_buttons/);
  assert.match(route, /JOIN aa_workflows w ON s\.workflow_id = w\.id/);
});

test("workflow start API returns configured Data Action buttons on first render", async () => {
  const route = await readFile(new URL("app/api/agent-assist/workflow/start/route.js", root), "utf8");

  assert.match(route, /w\.data_action_buttons/);
  assert.match(route, /JOIN aa_workflows w ON s\.workflow_id = w\.id/);
});

test("workflow editor exposes Data Action Buttons configuration and loads Form Submit flows", async () => {
  const page = await readFile(new URL("app/(portal)/admin/workflows/[id]/page.jsx", root), "utf8");

  assert.match(page, /Data Action Buttons/);
  assert.match(page, /workflowForm\.data_action_buttons/);
  assert.match(page, /one_click/);
  assert.match(page, /\/api\/voice\/flows/);
  assert.match(page, /form_submit/);
});

test("workflow editor uses a right-side Sheet for Edit Workflow like Create AI Agent", async () => {
  const page = await readFile(new URL("app/(portal)/admin/workflows/[id]/page.jsx", root), "utf8");

  assert.match(page, /from "@\/components\/ui\/sheet"/);
  assert.match(page, /<Sheet open=\{editingWorkflow\} onOpenChange=\{setEditingWorkflow\}>/);
  assert.match(page, /<SheetContent\s+side="right"\s+className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"/);
  assert.match(page, /<SheetHeader className="px-6 py-4 border-b">/);
  assert.match(page, /<SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">/);
  assert.doesNotMatch(page, /<Dialog open=\{editingWorkflow\} onOpenChange=\{setEditingWorkflow\}>/);
});

test("agent desktop shows workflow Data Actions as a dropdown in the Interaction Details header", async () => {
  const workflowComponent = await readFile(new URL("components/contact-center/AgentAssistWorkflow.jsx", root), "utf8");
  const desktopComponent = await readFile(new URL("components/contact-center/AgentDesktop.jsx", root), "utf8");

  assert.match(desktopComponent, /id="interaction-detail-header-actions"/);
  assert.match(workflowComponent, /createPortal/);
  assert.match(workflowComponent, /document\.getElementById\("interaction-detail-header-actions"\)/);
  assert.match(workflowComponent, /DropdownMenu/);
  assert.match(workflowComponent, /DropdownMenuTrigger/);
  assert.match(workflowComponent, /DropdownMenuContent/);
  assert.match(workflowComponent, /Data Actions/);
  assert.match(workflowComponent, /WorkflowDataActionsDropdown/);
  assert.match(workflowComponent, /<WorkflowDataActionsDropdown[\s\S]*buttons=\{workflowDataActionButtons\}/);
  assert.doesNotMatch(workflowComponent, /<WorkflowDataActionButtons/);
  assert.doesNotMatch(workflowComponent, /WorkflowStagesCard[\s\S]*dataActionButtons=\{workflowDataActionButtons\}/);
});

test("workflow data action payload is compact and includes all workflow slots by slot name", async () => {
  const route = await readFile(new URL("app/api/agent-assist/workflow/data-action/route.js", root), "utf8");

  assert.match(route, /loadWorkflowSlotValues/);
  assert.match(route, /slot_name/);
  assert.match(route, /SELECT[\s\S]*wi\.slot_name[\s\S]*aa_workflow_items/);
  assert.match(route, /call_control_id/);
  assert.match(route, /call_session_id/);
  assert.match(route, /from_number/);
  assert.match(route, /to_number/);
  assert.doesNotMatch(route, /context:\s*interaction\s*\|\|\s*\{\}/);
});

test("workflow data action route reuses Form Submit data-action execution semantics", async () => {
  const route = await readFile(new URL("app/api/agent-assist/workflow/data-action/route.js", root), "utf8");
  const helper = await readFile(new URL("lib/forms/form-data-actions.js", root), "utf8");

  assert.match(route, /executeFormDataAction/);
  assert.match(route, /workflow_data_action/);
  assert.match(route, /button/);
  assert.match(helper, /formSubmitStatus/);
  assert.match(helper, /FORM_DATA_ACTION_NODE_TYPES/);
});
