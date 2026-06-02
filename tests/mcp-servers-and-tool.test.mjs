import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Admin menu exposes MCP Servers for admin users", async () => {
  const menu = await read("config/menu.jsx");

  assert.match(menu, /IconTools/, "menu should import the tools icon");
  assert.match(menu, /title:\s*"MCP Servers"/, "admin navigation should include MCP Servers");
  assert.match(menu, /url:\s*"\/admin\/mcp-servers"/, "MCP Servers should link to the admin page");
  assert.match(menu, /role_access:\s*\["admin",\s*"owner"\]/, "MCP Servers should be admin/owner scoped");
});

test("Admin MCP Server routes proxy Telnyx MCP APIs without local DB schema changes", async () => {
  const listRoute = await read("app/api/admin/mcp-servers/route.js");
  const detailRoute = await read("app/api/admin/mcp-servers/[id]/route.js");
  const toolsRoute = await read("app/api/admin/mcp-servers/[id]/tools/route.js");

  for (const source of [listRoute, detailRoute, toolsRoute]) {
    assert.match(source, /requireAdmin/, "MCP admin API should enforce admin access");
    assert.match(source, /TELNYX_API_KEY/, "MCP admin API should use the server-side Telnyx key");
    assert.doesNotMatch(source, /CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE/i, "MCP admin proxy must not mutate DB schema");
  }

  assert.match(listRoute, /buildTelnyxV2Url\("\/ai\/mcp_servers"\)/, "list/create route should proxy /ai/mcp_servers");
  assert.match(detailRoute, /\/ai\/mcp_servers\/\$\{encodeURIComponent\(id\)\}/, "detail route should proxy server id paths");
  assert.match(toolsRoute, /buildTelnyxV2Url\("\/ai\/mcp_servers\/list_tools"\)/, "tools route should use Telnyx list_tools endpoint");
  assert.match(toolsRoute, /normalizeTools/, "tools route should normalize OpenAI/function and raw MCP tool shapes");
  assert.match(listRoute, /allowed_tools/, "create/update payloads should preserve allowed_tools allowlist");
  assert.match(detailRoute, /api_key_ref/, "create/update payloads should preserve API key references");
});

test("Call Flow exposes MCP Tool node with editor, success/error outputs, and runtime execution", async () => {
  const nodes = await read("config/voice-flow-nodes.js");
  const flowPage = await read("app/(portal)/admin/call-flows/[id]/page.jsx");
  const engine = await read("lib/voice-flow-engine.js");
  const runner = await read("lib/mcp/mcp-tool-runner.js");

  assert.match(nodes, /mcp_tool:\s*{/, "voice-flow config should define mcp_tool");
  assert.match(nodes, /label:\s*"MCP Tool"/, "node label should be MCP Tool");
  assert.match(nodes, /outputLabels:\s*\["Success",\s*"Error"\]/, "MCP Tool should have success/error outputs");
  assert.match(nodes, /customEditor:\s*"McpToolNodeEditor"/, "MCP Tool should use the custom editor");
  assert.match(nodes, /serverId:[\s\S]*toolName:[\s\S]*input:[\s\S]*responseVariable:[\s\S]*errorVariable:/, "MCP Tool config should include server/tool/input/response/error fields");

  assert.match(flowPage, /import McpToolNodeEditor/, "Call Flow editor page should import the MCP Tool editor");
  assert.match(flowPage, /selectedNodeDef\.customEditor ===\s*\n\s*"McpToolNodeEditor"/, "Call Flow editor page should render the MCP Tool editor");

  assert.match(engine, /executeMcpToolNode/, "runtime engine should import MCP Tool execution");
  assert.match(engine, /nodeType === "mcp_tool"/, "runtime engine should dispatch mcp_tool nodes");

  assert.match(runner, /SSEClientTransport/, "runtime should support SSE MCP transport");
  assert.match(runner, /StreamableHTTPClientTransport/, "runtime should support streamable HTTP MCP transport");
  assert.match(runner, /allowed_tools/, "runtime should enforce server allowed_tools allowlist");
  assert.match(runner, /resolveMcpTemplateValue/, "runtime should interpolate {{variable}} inputs");
  assert.match(runner, /output:\s*0/, "runtime should route success through output 0");
  assert.match(runner, /output:\s*1/, "runtime should route MCP errors through output 1");
});

test("MCP Tool editor discovers configured servers and allowed tools", async () => {
  const editor = await read("components/voice-flow/McpToolNodeEditor.jsx");
  const adminPage = await read("app/(portal)/admin/mcp-servers/page.jsx");
  const sheet = await read("components/admin/MCPServerEditorSheet.jsx");

  assert.match(editor, /fetch\("\/api\/admin\/mcp-servers\?page=1&pageSize=100"/, "editor should load configured MCP servers");
  assert.match(editor, /\/api\/admin\/mcp-servers\/\$\{encodeURIComponent\(server\.id\)\}\/tools/, "editor should discover tools via admin tools proxy");
  assert.match(editor, /allowed\.length > 0[\s\S]*allowed\.includes\(tool\.name\)/, "editor should filter discovered tools by allowlist");
  assert.match(editor, /VariableTextarea/, "editor should expose variable-aware JSON input");

  assert.match(adminPage, /MCPServerEditorSheet/, "admin page should use the MCP server sheet");
  assert.match(sheet, /Select All \(\{availableTools\.length\} tools\)/, "sheet should support bulk allowlist selection");
  assert.match(sheet, /api_key_ref/, "sheet should save API key reference names rather than secret values");
  assert.doesNotMatch(sheet, /secret\.value/, "sheet must not expose decrypted secret values client-side");
});
