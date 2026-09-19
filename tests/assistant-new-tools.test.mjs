import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ASSISTANT_TOOL_TYPES } from "../config/assistant-tools.js";
import {
  validateAssistantToolConfiguration,
  validateWhatsAppTemplateVariableCounts,
} from "../lib/ai/assistant-tool-validation.js";
import {
  assistantToolToLibraryPayload,
  libraryToolToAssistantTool,
} from "../lib/ai/tool-library.js";
import {
  clientSideParametersSupportVisualMode,
  clientSideParametersToRows,
  clientSideRowsToParameters,
  validateClientSideParameterRows,
} from "../lib/ai/client-side-tool-parameters.js";

test("assistant integrations list WhatsApp Template and Client-Side Tool", () => {
  const whatsapp = ASSISTANT_TOOL_TYPES.find(
    (tool) => tool.type === "whatsapp_template"
  );
  const clientSide = ASSISTANT_TOOL_TYPES.find(
    (tool) => tool.type === "client_side_tool"
  );

  assert.deepEqual(whatsapp, {
    type: "whatsapp_template",
    label: "WhatsApp Template",
    singleton: true,
  });
  assert.deepEqual(clientSide, {
    type: "client_side_tool",
    label: "Client-Side Tool",
    singleton: false,
  });
});

test("client-side tool validation follows the Telnyx schema", () => {
  const tool = {
    type: "client_side_tool",
    display_name: "show_order",
    client_side_tool: {
      name: "show_order",
      description: "Show an order in the connected browser.",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "Order identifier" },
        },
        required: ["order_id"],
      },
    },
    timeout_ms: 5000,
  };

  assert.equal(validateAssistantToolConfiguration(tool), "");
  assert.match(
    validateAssistantToolConfiguration({
      ...tool,
      client_side_tool: {
        ...tool.client_side_tool,
        parameters: { type: "object", properties: {} },
      },
    }),
    /required/
  );
});

test("client-side visual parameters round-trip through Telnyx JSON Schema", () => {
  const rows = [
    {
      name: "order_id",
      type: "string",
      required: true,
      description: "Order identifier",
      enumValues: "",
    },
    {
      name: "status",
      type: "enum",
      required: false,
      description: "",
      enumValues: "pending, shipped",
    },
    {
      name: "scores",
      type: "array-number",
      required: false,
      description: "Order scores",
      enumValues: "",
    },
  ];

  const schema = clientSideRowsToParameters(rows);

  assert.deepEqual(schema, {
    type: "object",
    properties: {
      order_id: { type: "string", description: "Order identifier" },
      status: { type: "string", enum: ["pending", "shipped"] },
      scores: {
        type: "array",
        items: { type: "number" },
        description: "Order scores",
      },
    },
    required: ["order_id"],
    additionalProperties: false,
  });
  assert.equal(clientSideParametersSupportVisualMode(schema), true);
  assert.deepEqual(
    clientSideParametersToRows(schema).map(({ id, ...row }) => row),
    rows
  );
});

test("client-side visual mode rejects incomplete rows and preserves advanced schemas", () => {
  assert.match(
    validateClientSideParameterRows([
      {
        name: "",
        type: "string",
        required: true,
        description: "",
        enumValues: "",
      },
    ]),
    /name is required/
  );
  assert.equal(
    clientSideParametersSupportVisualMode({
      type: "object",
      properties: {
        customer: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
      required: [],
    }),
    false
  );
  assert.match(
    validateClientSideParameterRows([
      {
        name: "status",
        type: "enum",
        required: false,
        description: "",
        enumValues: "",
      },
    ]),
    /at least one enum value/
  );
});

test("client-side generic arrays round-trip without narrowing their item schema", () => {
  const schema = {
    type: "object",
    properties: {
      values: { type: "array", description: "Values of any supported shape" },
    },
    required: [],
  };

  const rows = clientSideParametersToRows(schema);
  assert.equal(rows[0].type, "array");
  assert.deepEqual(clientSideRowsToParameters(rows), {
    ...schema,
    additionalProperties: false,
  });
});

test("WhatsApp Template validation requires approved template metadata", () => {
  const tool = {
    type: "whatsapp_template",
    display_name: "WhatsApp Templates",
    whatsapp_template: {
      templates: [
        {
          template_id: "template-123",
          template_name: "login_code",
          language: "en_US",
          name: "auth_code",
          description: "Send a login verification code.",
          variables: ["code"],
        },
      ],
    },
    timeout_ms: 5000,
  };

  assert.equal(validateAssistantToolConfiguration(tool), "");
  assert.match(
    validateAssistantToolConfiguration({
      ...tool,
      whatsapp_template: {
        templates: [{ ...tool.whatsapp_template.templates[0], template_id: "" }],
      },
    }),
    /select an approved WhatsApp template/
  );
  assert.equal(
    validateWhatsAppTemplateVariableCounts(
      tool.whatsapp_template.templates,
      [
        {
          id: "template-123",
          components: [
            { type: "BODY", text: "Code {{1}}, expires {{2}}" },
          ],
        },
      ]
    ),
    "Template 1: enter exactly 2 variable names for the selected template."
  );
});

test("new assistant tool definitions round-trip through Tools Library mapping", () => {
  const clientSide = {
    type: "client_side_tool",
    display_name: "Show order",
    client_side_tool: {
      name: "show_order",
      description: "Show an order.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    timeout_ms: 5000,
  };
  const payload = assistantToolToLibraryPayload(clientSide);

  assert.deepEqual(payload, clientSide);
  assert.deepEqual(
    libraryToolToAssistantTool({
      id: "tool-client",
      ...payload,
      tool_definition: payload.client_side_tool,
    }),
    {
      type: "client_side_tool",
      tool_id: "tool-client",
      display_name: "Show order",
      x_demo_portal_tool_source: "tools_library",
      client_side_tool: payload.client_side_tool,
      timeout_ms: 5000,
    }
  );
});

test("new tool sheets expose the Telnyx fields and approved-template picker", () => {
  const assistantSheet = readFileSync(
    new URL(
      "../components/assistants/AssistantToolEditSheet.jsx",
      import.meta.url
    ),
    "utf8"
  );
  const clientSideEditor = readFileSync(
    new URL(
      "../components/assistants/tools/ClientSideToolEditor.jsx",
      import.meta.url
    ),
    "utf8"
  );
  const whatsappEditor = readFileSync(
    new URL(
      "../components/assistants/tools/WhatsAppTemplateToolEditor.jsx",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(assistantSheet, /case "client_side_tool"/);
  assert.match(assistantSheet, /case "whatsapp_template"/);
  assert.match(clientSideEditor, /client_side_tool/);
  assert.match(clientSideEditor, /Parameters \(JSON Schema\)/);
  assert.match(clientSideEditor, /Advanced mode/);
  assert.match(clientSideEditor, /Add parameter/);
  assert.match(clientSideEditor, /CLIENT_SIDE_PARAMETER_TYPES/);
  assert.match(clientSideEditor, /timeout_ms/);
  assert.match(whatsappEditor, /whatsapp_template/);
  assert.match(whatsappEditor, /template_id/);
  assert.match(whatsappEditor, /template_name/);
  assert.match(whatsappEditor, /language/);
  assert.match(whatsappEditor, /variables/);
  assert.match(whatsappEditor, /validateWhatsAppTemplateVariableCounts/);
  assert.match(
    whatsappEditor,
    /filter\[status\][\s\S]*APPROVED|APPROVED[\s\S]*filter\[status\]/
  );
  assert.match(
    whatsappEditor,
    /\/api\/messaging\/whatsapp\/templates/
  );
});

test("assistant tool sheet scrolls growing configuration cards inside the viewport", () => {
  const assistantSheet = readFileSync(
    new URL(
      "../components/assistants/AssistantToolEditSheet.jsx",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(
    assistantSheet,
    /className="flex-1 min-h-0 overflow-y-auto">\s*<Card className="p-6 mx-4">/
  );
  assert.doesNotMatch(
    assistantSheet,
    /<Card className="[^"]*flex-1 min-h-0 overflow-visible/
  );
});

test("Contact Center proxies approved WhatsApp templates for assistant tools", () => {
  const route = readFileSync(
    new URL(
      "../app/api/messaging/whatsapp/templates/route.js",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(route, /withPermission\("messaging_admin:read", GET_handler, \{ route:/);
  assert.match(route, /\/whatsapp\/message_templates/);
  assert.match(route, /new URL\(request\.url\)\.searchParams\.toString\(\)/);
  assert.match(route, /TELNYX_API_KEY/);
});
