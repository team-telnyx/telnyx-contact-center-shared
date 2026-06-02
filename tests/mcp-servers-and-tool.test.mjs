import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

async function loadMcpArgumentBuilderForUnitTests() {
  const source = await read("lib/mcp/mcp-argument-builder.js");
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

async function loadMcpSchemaValidatorForUnitTests() {
  return import(new URL("lib/mcp/mcp-schema-validator.js", root));
}

test("Admin menu exposes MCP Servers for admin users", async () => {
  const menu = await read("config/menu.jsx");

  assert.match(menu, /IconTools/, "menu should import the tools icon");
  assert.match(menu, /title:\s*"MCP Servers"/, "admin navigation should include MCP Servers");
  assert.match(menu, /url:\s*"\/admin\/mcp-servers"/, "MCP Servers should link to the admin page");
  assert.match(menu, /role_access:\s*\["admin",\s*"owner"\]/, "MCP Servers should be admin/owner scoped");
});

test("Admin MCP Server routes use local Postgres registry and never proxy Telnyx MCP registry", async () => {
  const listRoute = await read("app/api/admin/mcp-servers/route.js");
  const detailRoute = await read("app/api/admin/mcp-servers/[id]/route.js");
  const toolsRoute = await read("app/api/admin/mcp-servers/[id]/tools/route.js");
  const registry = await read("lib/mcp/mcp-server-registry.js");
  const schema = await read("lib/postgres-schema.mjs");

  for (const source of [listRoute, detailRoute, toolsRoute]) {
    assert.match(source, /requireAdmin/, "MCP admin API should enforce admin access");
    assert.doesNotMatch(source, /buildTelnyxV2Url|\/ai\/mcp_servers|TELNYX_API_KEY/, "MCP admin API must not use Telnyx MCP registry");
  }

  assert.match(schema, /CREATE TABLE IF NOT EXISTS mcp_servers/, "local MCP servers table should exist");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mcp_server_tools/, "local MCP server tools table should cache schemas");
  assert.match(schema, /input_schema JSONB NOT NULL DEFAULT '\{\}'::jsonb/, "tool schemas should be persisted as JSONB");
  assert.match(registry, /listMcpServers/, "registry helper should list local MCP servers");
  assert.match(registry, /upsertMcpServerTools/, "registry helper should upsert discovered tool schemas");
  assert.match(toolsRoute, /discoverMcpToolsForServer/, "tools route should discover schemas directly from MCP server");
  assert.match(toolsRoute, /upsertMcpServerTools/, "tools route should cache discovered tool schemas locally");
});

test("MCP runtime resolves local Contact Center secrets and validates calls against persisted input schemas", async () => {
  const runner = await read("lib/mcp/mcp-tool-runner.js");
  const validator = await read("lib/mcp/mcp-schema-validator.js");

  assert.match(runner, /SSEClientTransport/, "runtime should support SSE MCP transport");
  assert.match(runner, /StreamableHTTPClientTransport/, "runtime should support streamable HTTP MCP transport");
  assert.match(runner, /getMcpServer\(/, "runtime should load servers from local registry");
  assert.match(runner, /getMcpServerTool\(/, "runtime should load selected tool schema from local registry");
  assert.match(runner, /allowed_tools/, "runtime should enforce server allowed_tools allowlist");
  assert.match(runner, /getSecretByName/, "runtime should resolve local Contact Center secrets");
  assert.doesNotMatch(runner, /isTelnyxMcpUrl|process\.env\.TELNYX_API_KEY|\/ai\/mcp_servers/, "runtime must not special-case official Telnyx MCP registry/auth");
  assert.match(runner, /assertValidMcpToolArguments/, "runtime should validate args against schema before MCP call");
  assert.match(validator, /removeAdditional:\s*false/, "validator must respect additionalProperties instead of stripping unknown fields");
  assert.match(runner, /output:\s*0/, "runtime should route success through output 0");
  assert.match(runner, /output:\s*1/, "runtime should route MCP errors through output 1");
});

test("MCP Server admin page uses local Contact Center secrets and persists discovered schemas", async () => {
  const adminPage = await read("app/(portal)/admin/mcp-servers/page.jsx");
  const sheet = await read("components/admin/MCPServerEditorSheet.jsx");

  assert.match(adminPage, /MCPServerEditorSheet/, "admin page should use the MCP server sheet");
  assert.match(sheet, /Select All \(\{availableTools\.length\} tools\)/, "sheet should support bulk allowlist selection");
  assert.match(sheet, /auth_secret_name/, "sheet should save local auth secret names");
  assert.match(sheet, /\/api\/admin\/secrets/, "sheet should list local Contact Center secrets for runtime auth");
  assert.doesNotMatch(sheet, /\/api\/integration-secrets|Telnyx integration secrets|APIKeyRefCombobox/, "MCP auth picker must not use Telnyx integration secrets");
  assert.doesNotMatch(sheet, /secret\.value/, "sheet must not expose decrypted secret values client-side");
});

test("MCP Tool editor and test sheet are schema-first and expose variable assignment to tool arguments", async () => {
  const editor = await read("components/voice-flow/McpToolNodeEditor.jsx");
  const sheet = await read("components/voice-flow/McpToolTestSheet.jsx");
  const route = await read("app/api/voice/flows/test-mcp-tool/route.js");
  const nodes = await read("config/voice-flow-nodes.js");

  assert.match(nodes, /toolInputSchema/, "MCP node config should persist selected tool schema");
  assert.doesNotMatch(nodes, /Plain-language instruction|list all Polish numbers/, "MCP node config should no longer depend on NLP instruction mapping");

  assert.match(editor, /toolInputSchema/, "editor should persist selected tool input schema on the node config");
  assert.match(editor, /Schema-driven Tool Arguments/, "editor should render schema-driven argument controls");
  assert.match(editor, /ArgumentMappingField/, "editor should allow assigning variables/templates to schema arguments");
  assert.match(editor, /buildEmptyMcpArgsFromSchema/, "editor should initialize arguments from schema");
  assert.match(editor, /VariableTextarea/, "argument fields should support {{variables}}");
  assert.doesNotMatch(editor, /Instruction[\s\S]*list all Polish numbers/i, "instruction/NLP mapping should no longer be primary MCP UX");

  assert.match(sheet, /Test MCP Tool/);
  assert.match(sheet, /Variable Values/);
  assert.match(sheet, /Request Preview/);
  assert.match(sheet, /Input Schema/);
  assert.match(sheet, /validateMcpToolArguments/, "test sheet should validate request preview against selected schema");
  assert.match(sheet, /\/api\/voice\/flows\/test-mcp-tool/);
  assert.match(sheet, /CodeBlockCopyButton/);
  assert.match(sheet, /onTestSuccess/);

  assert.match(route, /callMcpTool/);
  assert.match(route, /buildMcpToolArguments/);
  assert.match(route, /request\.headers\.get\("cookie"\)/);
  assert.match(route, /request\.headers\.get\("authorization"\)/);
  assert.match(route, /NextResponse\.json/);
});

test("MCP argument builder only resolves explicit schema-shaped args and preserves additional properties", async () => {
  const { buildMcpToolArguments, resolveMcpTemplateValue } = await loadMcpArgumentBuilderForUnitTests();

  const args = buildMcpToolArguments({
    input: JSON.stringify({
      request: {
        to: "{{customer.phone}}",
        text: "Hello {{customer.name}}",
        dynamic_extra: "keep me",
      },
    }),
    variables: { customer: { phone: "+48602410402", name: "Leszek" } },
  });

  assert.deepEqual(args, {
    request: {
      to: "+48602410402",
      text: "Hello Leszek",
      dynamic_extra: "keep me",
    },
  });

  assert.deepEqual(resolveMcpTemplateValue("{{customer}}", { customer: { id: 123 } }), { id: 123 });
  assert.throws(
    () => buildMcpToolArguments({ input: '"not-object"' }),
    /must be a JSON object/,
    "MCP tool arguments must remain object-shaped for JSON Schema validation",
  );
});

test("MCP schema validator rejects missing required fields without stripping allowed unknown fields", async () => {
  const { validateMcpToolArguments, assertValidMcpToolArguments } = await loadMcpSchemaValidatorForUnitTests();
  const schema = {
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: { to: { type: "string" } },
        required: ["to"],
        additionalProperties: true,
      },
    },
    required: ["request"],
  };

  const validArgs = { request: { to: "+48602410402", extra: "preserved" } };
  assert.equal(validateMcpToolArguments(validArgs, schema).valid, true);
  assert.deepEqual(assertValidMcpToolArguments(validArgs, schema), validArgs);

  const invalid = validateMcpToolArguments({ request: {} }, schema);
  assert.equal(invalid.valid, false);
  assert.match(JSON.stringify(invalid.errors), /required/);
});
