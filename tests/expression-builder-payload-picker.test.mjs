import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Set Variable Expression Builder receives call-flow payload options", async () => {
  const source = await read("components/voice-flow/SetVariableNodeEditor.jsx");

  assert.match(
    source,
    /buildExpressionTestPayloadOptions/,
    "Set Variable editor should build payload options from the call flow",
  );
  assert.match(
    source,
    /buildExpressionTestPayloadOptions\(\{ nodes, edges \}\)/,
    "payload options should be derived from the same nodes and edges shown in the editor",
  );
  assert.match(
    source,
    /testPayloadOptions=\{testPayloadOptions\}/,
    "Expression Builder modal should receive the computed payload options",
  );
});

test("Expression Builder renders a saved-payload dropdown that loads JSON into Test Data", async () => {
  const source = await read("components/voice-flow/ExpressionBuilderModal.jsx");

  assert.match(source, /SelectTrigger/, "modal should use the project select component");
  assert.match(
    source,
    /Choose a saved webhook\/request\/response payload from this call flow/,
    "dropdown helper copy should explain saved flow payloads",
  );
  assert.match(
    source,
    /JSON\.stringify\(option\.payload, null, 2\)/,
    "selecting a payload should populate the Test Data JSON editor",
  );
  assert.match(
    source,
    /Manual JSON \/ custom test data/,
    "manual editing should remain available",
  );
  assert.match(
    source,
    /hasPreviewableTestData \? \([\s\S]*<CodeBlock[\s\S]*code=\{testData\}[\s\S]*language="json"[\s\S]*Edit JSON/,
    "selected JSON payloads should render as a real CodeBlock preview with an explicit edit affordance",
  );
  assert.match(
    source,
    /aria-label="Test Data JSON code editor"[\s\S]*bg-black[\s\S]*font-mono/,
    "manual editing should remain available as a dark code-styled JSON editor",
  );
  assert.match(
    source,
    /Right Column - Expression Editor & Testing[\s\S]*overflow-y-auto[\s\S]*Test Expression[\s\S]*border rounded-md p-4 bg-muted\/30 flex flex-col[\s\S]*Result:/,
    "the right side should scroll and the test panel should size to content so large Test Data previews do not hide the Result section",
  );
});

test("payload option helper exposes HTTP, Data Action, MCP Tool, HTTP initiator, and webhook payload shapes", async () => {
  const source = await read("lib/voice-flow-expression-test-payloads.js");

  assert.match(
    source,
    /group:\s*"HTTP Request responses"[\s\S]*\[responseVariable\]: responsePayload/,
    "HTTP Request test responses should be wrapped under their response variable",
  );
  assert.match(
    source,
    /group:\s*"Data Action responses"[\s\S]*buildDataActionExample/,
    "Data Action payload options should fall back to generated schema examples",
  );
  assert.match(
    source,
    /nodeType === "mcp_tool"[\s\S]*group:\s*"MCP Tool responses"[\s\S]*\[responseVariable\]: getMcpResponseVariablePayload\(testResponse\)[\s\S]*\`\$\{responseVariable\}_text\`[\s\S]*\`\$\{responseVariable\}_structured\`/,
    "MCP Tool test responses should include the runtime response variable and helper variables",
  );
  assert.match(
    source,
    /group:\s*"HTTP Request payloads"[\s\S]*\[payloadVariable\]: parsed[\s\S]*\[rootPath\]: parsed/,
    "HTTP Request initiator edge samples should expose both the configured alias and payload/query root",
  );
  assert.match(
    source,
    /nodeType === "incoming_call"[\s\S]*DEFAULT_INCOMING_CALL_PAYLOAD_VARIABLE[\s\S]*variables\[payloadVariable\] = payload/,
    "incoming-call webhook examples should include the configured call payload alias",
  );
  assert.match(
    source,
    /getNodeWebhookEvents\(node, edges\)/,
    "webhook payload choices should be derived from call-flow nodes and outgoing edges",
  );
});

test("available variable helper exposes MCP Tool response variables", async () => {
  const source = await read("lib/variable-utils.js");

  assert.match(
    source,
    /nodeType === "mcp_tool"[\s\S]*responseVariable \|\| "mcp_response"[\s\S]*names\.push\(responseVariable\.trim\(\)\)/,
    "Expression Builder variable chips should include MCP Tool response variables, defaulting to mcp_response",
  );
});
