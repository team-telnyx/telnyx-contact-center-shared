import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildWorkflowPrefillFromClientState,
} from "../lib/agent-assist/workflow-prefill.js";

test("buildWorkflowPrefillFromClientState only keeps values matching workflow slot names", () => {
  const workflow = {
    stages: [
      {
        items: [
          { type: "slot", slot_name: "customer_name", id: "slot-customer" },
          { type: "slot", slot_name: "customer_dob", id: "slot-dob" },
          { type: "action", slot_name: "ignored_action", id: "action-1" },
        ],
      },
    ],
  };

  const result = buildWorkflowPrefillFromClientState(
    {
      workflow_data: {
        customer_name: "John Wick",
        customer_dob: "1988-09-23",
        ignored_action: "nope",
        unknown_key: "drop me",
        empty_value: "",
      },
    },
    workflow,
  );

  assert.deepEqual(result.slotsFilled, {
    customer_name: "John Wick",
    customer_dob: "1988-09-23",
  });
  assert.deepEqual(result.itemCompletions, [
    { itemId: "slot-customer", slotName: "customer_name", value: "John Wick" },
    { itemId: "slot-dob", slotName: "customer_dob", value: "1988-09-23" },
  ]);
});

test("Agent Assist node stores workflow_data and resolves workflow variable/static mappings", async () => {
  const engineSource = await readFile(new URL("../lib/voice-flow-engine.js", import.meta.url), "utf8");
  assert.match(engineSource, /workflow_data/);
  assert.match(engineSource, /resolveWorkflowDataPrefill/);
  assert.match(engineSource, /agentAssistConfig\.workflow_data/);
  assert.match(engineSource, /newClientState\.workflow_data/);
});

test("Agent Assist editor renders workflow slot data prefill mappings", async () => {
  const editorSource = await readFile(new URL("../components/voice-flow/AgentAssistNodeEditor.jsx", import.meta.url), "utf8");
  assert.match(editorSource, /Workflow data prefill/);
  assert.match(editorSource, /selectedWorkflowSlots/);
  assert.match(editorSource, /updateWorkflowDataField/);
  assert.match(editorSource, /\/api\/admin\/workflows\/\$\{encodeURIComponent\(config\.workflow_id\)\}/);
});

test("Workflow start applies call-flow workflow_data to matching slots", async () => {
  const startRouteSource = await readFile(new URL("../app/api/agent-assist/workflow/start/route.js", import.meta.url), "utf8");
  assert.match(startRouteSource, /buildWorkflowPrefillFromClientState/);
  assert.match(startRouteSource, /metadata\?\.workflow_data/);
  assert.match(startRouteSource, /completed_by, source_transcript/);
  assert.match(startRouteSource, /'call_flow'/);
});

test("contact-center enqueue preserves workflow_data from client_state in interaction metadata", async () => {
  const handlerSource = await readFile(new URL("../lib/contact-center/webhook-handler.js", import.meta.url), "utf8");
  assert.match(handlerSource, /workflow_data/);
  assert.match(handlerSource, /routingMetadata\.workflow_data/);
});
