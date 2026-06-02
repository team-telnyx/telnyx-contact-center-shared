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
  const integrationSecretsRoute = await read("app/api/integration-secrets/route.js");

  for (const source of [listRoute, detailRoute, toolsRoute, integrationSecretsRoute]) {
    assert.match(source, /requireAdmin/, "MCP admin API should enforce admin access");
    assert.match(source, /TELNYX_API_KEY/, "MCP admin API should use the server-side Telnyx key");
    assert.doesNotMatch(source, /CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE/i, "MCP admin proxy must not mutate DB schema");
  }

  assert.match(listRoute, /buildTelnyxV2Url\("\/ai\/mcp_servers"\)/, "list/create route should proxy /ai/mcp_servers");
  assert.match(detailRoute, /\/ai\/mcp_servers\/\$\{encodeURIComponent\(id\)\}/, "detail route should proxy server id paths");
  assert.match(toolsRoute, /buildTelnyxV2Url\("\/ai\/mcp_servers\/list_tools"\)/, "tools route should use Telnyx list_tools endpoint");
  assert.match(toolsRoute, /normalizeTools/, "tools route should normalize OpenAI/function and raw MCP tool shapes");
  assert.match(integrationSecretsRoute, /\/integration_secrets\?page\[number\]=/, "API key refs should be loaded from Telnyx integration secrets");
  assert.match(integrationSecretsRoute, /identifier/, "integration secrets route should expose secret identifiers, not local secret names");
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
  assert.match(nodes, /serverId:[\s\S]*toolName:[\s\S]*instruction:[\s\S]*input:[\s\S]*responseVariable:[\s\S]*errorVariable:/, "MCP Tool config should include server/tool/instruction/advanced-input/response/error fields");

  assert.match(flowPage, /import McpToolNodeEditor/, "Call Flow editor page should import the MCP Tool editor");
  assert.match(flowPage, /selectedNodeDef\.customEditor ===\s*\n\s*"McpToolNodeEditor"/, "Call Flow editor page should render the MCP Tool editor");

  assert.match(engine, /executeMcpToolNode/, "runtime engine should import MCP Tool execution");
  assert.match(engine, /nodeType === "mcp_tool"/, "runtime engine should dispatch mcp_tool nodes");

  assert.match(runner, /SSEClientTransport/, "runtime should support SSE MCP transport");
  assert.match(runner, /StreamableHTTPClientTransport/, "runtime should support streamable HTTP MCP transport");
  assert.match(runner, /allowed_tools/, "runtime should enforce server allowed_tools allowlist");
  assert.match(runner, /resolveMcpTemplateValue/, "runtime should interpolate {{variable}} inputs");
  assert.match(runner, /buildMcpToolArguments\(\{[\s\S]*instruction: config\.instruction/, "runtime should build tool arguments from instruction plus advanced JSON");
  assert.match(runner, /isTelnyxMcpUrl/, "runtime should detect official Telnyx MCP endpoints");
  assert.match(runner, /process\.env\.TELNYX_API_KEY/, "official Telnyx MCP runtime should use the app Telnyx API key for outbound auth");
  assert.match(runner, /process\.env\[apiKeyRef\]/, "runtime should resolve selected API key refs from environment variables as well as local secrets");
  assert.match(runner, /no matching runtime secret was found/, "runtime should fail fast instead of calling authenticated MCP servers without auth");
  assert.doesNotMatch(runner, /if \(secret\?\.value\) headers\.Authorization[\s\S]*new URL\(server\.url\)/, "runtime must not silently omit auth when an API key ref cannot be resolved");
  assert.doesNotMatch(runner, /JSON\.parse\(config\.input/, "runtime should not parse pure template input before resolving it");
  assert.match(runner, /output:\s*0/, "runtime should route success through output 0");
  assert.match(runner, /output:\s*1/, "runtime should route MCP errors through output 1");
});

test("MCP Server admin page uses Telnyx integration secret identifiers for API refs", async () => {
  const adminPage = await read("app/(portal)/admin/mcp-servers/page.jsx");
  const sheet = await read("components/admin/MCPServerEditorSheet.jsx");

  assert.match(adminPage, /MCPServerEditorSheet/, "admin page should use the MCP server sheet");
  assert.match(sheet, /Select All \(\{availableTools\.length\} tools\)/, "sheet should support bulk allowlist selection");
  assert.match(sheet, /api_key_ref/, "sheet should save API key reference names rather than secret values");
  assert.match(sheet, /\/api\/integration-secrets/, "sheet should list Telnyx integration secret identifiers for api_key_ref");
  assert.match(sheet, /secret\.identifier/, "sheet should use Telnyx secret identifiers, not local secret names");
  assert.doesNotMatch(sheet, /\/api\/admin\/secrets/, "MCP api_key_ref picker must not use local app secrets");
  assert.doesNotMatch(sheet, /secret\.value/, "sheet must not expose decrypted secret values client-side");
});

async function loadMcpRunnerForUnitTests() {
  const source = await read("lib/mcp/mcp-tool-runner.js");
  const stripped = source.replace(/^import .*$/gm, "");
  return import(`data:text/javascript,${encodeURIComponent(stripped)}`);
}

test("MCP Tool editor uses natural-language instruction input and supports test response preview", async () => {
  const editor = await read("components/voice-flow/McpToolNodeEditor.jsx");
  const sheet = await read("components/voice-flow/McpToolTestSheet.jsx");
  const route = await read("app/api/voice/flows/test-mcp-tool/route.js");
  const runner = await read("lib/mcp/mcp-tool-runner.js");

  assert.match(editor, /import McpToolTestSheet from "\.\/McpToolTestSheet"/, "editor should use a dedicated MCP test sheet");
  assert.match(editor, /IconFlask/, "editor should expose a test action");
  assert.match(editor, /Test Tool/, "editor should label the action as Test Tool");
  assert.match(editor, /Instruction/, "editor should expose a natural-language instruction field");
  assert.match(editor, /list all Polish numbers/i, "instruction placeholder should guide non-technical users");
  assert.doesNotMatch(editor, /Tool Input JSON[\s\S]*<VariableTextarea/, "plain JSON should not be the primary MCP input UX");
  assert.match(editor, /testResponse/, "editor should persist test response shape on the node config");

  assert.match(sheet, /Test MCP Tool/);
  assert.match(sheet, /Variable Values/);
  assert.match(sheet, /Request Preview/);
  assert.match(sheet, /Response Structure/);
  assert.match(sheet, /Response Text/);
  assert.match(sheet, /\/api\/voice\/flows\/test-mcp-tool/);
  assert.match(sheet, /CodeBlockCopyButton/);
  assert.match(sheet, /onTestSuccess/);

  assert.match(route, /callMcpTool/);
  assert.match(route, /buildMcpToolArguments/);
  assert.match(route, /request\.headers\.get\("cookie"\)/);
  assert.match(route, /request\.headers\.get\("authorization"\)/);
  assert.match(route, /NextResponse\.json/);

  assert.match(runner, /export function buildMcpToolArguments/);
  assert.match(runner, /instruction/);
  assert.match(runner, /request:/, "instruction mode should map user text into a request argument by default");
  assert.match(runner, /filter_country_iso_alpha2 = "PL"/, "Polish number instructions should infer PL country filter for list_phone_numbers");
});

test("MCP list_phone_numbers instruction maps to supported Telnyx MCP arguments", async () => {
  const { buildMcpToolArguments } = await loadMcpRunnerForUnitTests();

  const args = buildMcpToolArguments({
    toolName: "list_phone_numbers",
    instruction: "List Polish phone numbers with prefix +4833440",
  });

  assert.deepEqual(args, {
    request: {
      filter_country_iso_alpha2: "PL",
      filter_phone_number: "+4833440",
    },
  });
  assert.equal(args.request.instruction, undefined, "list_phone_numbers must not receive unsupported instruction kwarg");
});
