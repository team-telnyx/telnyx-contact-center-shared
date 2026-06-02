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
  assert.match(schema, /oauth_client_credentials/, "MCP registry should persist OAuth client credentials auth type");
  assert.match(schema, /oauth_authorization_code/, "MCP registry should persist interactive OAuth auth type");
  assert.match(registry, /listMcpServers/, "registry helper should list local MCP servers");
  assert.match(registry, /upsertMcpServerTools/, "registry helper should upsert discovered tool schemas");
  assert.match(toolsRoute, /discoverMcpToolsForServer/, "tools route should discover schemas directly from MCP server");
  assert.match(toolsRoute, /upsertMcpServerTools/, "tools route should cache discovered tool schemas locally");
});

test("MCP runtime resolves local Contact Center secrets and validates calls against persisted input schemas", async () => {
  const runner = await read("lib/mcp/mcp-tool-runner.js");
  const secrets = await read("lib/secrets.js");
  const validator = await read("lib/mcp/mcp-schema-validator.js");
  const oauth = await read("lib/mcp/mcp-oauth.js");
  const beginRoute = await read("app/api/admin/mcp-servers/[id]/oauth/begin/route.js");
  const callbackRoute = await read("app/api/admin/mcp-servers/oauth/callback/route.js");

  assert.match(runner, /SSEClientTransport/, "runtime should support SSE MCP transport");
  assert.match(runner, /StreamableHTTPClientTransport/, "runtime should support streamable HTTP MCP transport");
  assert.match(runner, /getMcpServer\(/, "runtime should load servers from local registry");
  assert.match(runner, /getMcpServerTool\(/, "runtime should load selected tool schema from local registry");
  assert.match(runner, /allowed_tools/, "runtime should enforce server allowed_tools allowlist");
  assert.match(runner, /getSecretByName/, "runtime should resolve local Contact Center secrets");
  assert.doesNotMatch(runner, /process\.env\.TELNYX_API_KEY|\/ai\/mcp_servers/, "runtime must not use Telnyx MCP registry or environment API key auth");
  assert.match(runner, /oauth_client_credentials/, "runtime should support OAuth client credentials for protected MCP resources");
  assert.match(runner, /oauth_authorization_code/, "runtime should support interactive OAuth Authorization Code sessions");
  assert.match(oauth, /getValidTelnyxMcpOAuthAccessToken/, "runtime should load and refresh Telnyx MCP OAuth tokens");
  assert.match(oauth, /upsertSecretByName/, "OAuth callback should upsert token secrets by unique name");
  assert.doesNotMatch(oauth, /createSecret/, "OAuth callback must not create duplicate token secrets on reconnect");
  assert.match(secrets, /ON CONFLICT \(name\) DO UPDATE/, "secrets should support atomic upsert by unique name");
  assert.match(secrets, /deleted_at = NULL/, "secret upsert should revive soft-deleted secrets with the same unique name");
  assert.match(runner, /Telnyx Portal OAuth can only be used with the Telnyx MCP URL/, "runtime should not send Telnyx Portal OAuth tokens to arbitrary MCP URLs");
  assert.match(runner, /https:\/\/api\.telnyx\.com\/v2\/mcp/, "runtime should recognize Telnyx MCP as an OAuth protected resource");
  assert.match(runner, /A Telnyx API key in Bearer auth can list tools but fails tool execution/, "runtime should explain Telnyx MCP API-key auth failures");
  assert.match(runner, /assertValidMcpToolArguments/, "runtime should validate args against schema before MCP call");
  assert.match(validator, /removeAdditional:\s*false/, "validator must respect additionalProperties instead of stripping unknown fields");
  assert.match(runner, /output:\s*0/, "runtime should route success through output 0");
  assert.match(runner, /output:\s*1/, "runtime should route MCP errors through output 1");
  assert.match(oauth, /browserSafeBaseUrl/, "OAuth should normalize server bind addresses before browser redirects");
  assert.match(oauth, /baseUrl\.hostname === "0\.0\.0\.0"/, "OAuth should detect 0.0.0.0 origins");
  assert.match(oauth, /baseUrl\.hostname = "localhost"/, "OAuth should redirect browsers to localhost instead of 0.0.0.0");
  assert.match(oauth, /code_challenge_method", "S256"/, "Telnyx Portal OAuth should use PKCE S256");
  assert.match(oauth, /https:\/\/api\.telnyx\.com\/v2\/oauth\/authorize/, "OAuth should use Telnyx authorization endpoint");
  assert.match(oauth, /https:\/\/api\.telnyx\.com\/v2\/oauth\/register/, "OAuth should support dynamic client registration");
  assert.match(oauth, /refresh_token/, "OAuth sessions should refresh tokens");
  assert.match(beginRoute, /NextResponse\.redirect\(authorizationUrl\)/, "begin route should redirect admins to Telnyx Portal");
  assert.match(callbackRoute, /finishTelnyxMcpOAuth/, "callback route should exchange the authorization code");
  assert.match(callbackRoute, /browserSafeBaseUrl\(request\)/, "callback route should avoid redirecting browsers to 0.0.0.0");
});

test("MCP Server admin page uses local Contact Center secrets and persists discovered schemas", async () => {
  const adminPage = await read("app/(portal)/admin/mcp-servers/page.jsx");
  const sheet = await read("components/admin/MCPServerEditorSheet.jsx");

  assert.match(adminPage, /MCPServerEditorSheet/, "admin page should use the MCP server sheet");
  assert.match(sheet, /Select All \(\{availableTools\.length\} tools\)/, "sheet should support bulk allowlist selection");
  assert.match(sheet, /auth_secret_name/, "sheet should save local auth secret names");
  assert.match(sheet, /oauth_client_credentials/, "sheet should allow OAuth client credentials for protected MCP resources");
  assert.match(sheet, /OAuth Resource URL/, "sheet should expose the resource URL required by non-Telnyx OAuth client credentials servers");
  assert.match(sheet, /oauth_authorization_code/, "sheet should allow Claude-style Telnyx Portal OAuth");
  assert.match(sheet, /Connect Telnyx Portal/, "sheet should expose a Telnyx Portal connect button");
  assert.match(sheet, /Authorization Code \+ PKCE/, "sheet should describe the interactive OAuth flow");
  assert.match(sheet, /client_id.*client_secret/s, "sheet should explain OAuth credential secret format");
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
  assert.match(sheet, /Response Text[\s\S]*CodeBlock code=\{testResult\.text\}[\s\S]*maxHeight=\{320\}[\s\S]*className="max-h-80 overflow-auto"/, "response text should render in the same scrollable code preview pattern as schema previews");
  assert.doesNotMatch(sheet, /Response Text[\s\S]*whitespace-pre-wrap/, "response text should not render as an unbounded plain text block");
  assert.match(sheet, /onTestSuccess/);

  assert.match(route, /callMcpTool/);
  assert.match(route, /buildMcpToolArguments/);
  assert.match(route, /request\.headers\.get\("cookie"\)/);
  assert.match(route, /request\.headers\.get\("authorization"\)/);
  assert.match(route, /NextResponse\.json/);
});

test("MCP description Args enrich sparse request schemas for form-based argument mapping", async () => {
  const {
    buildEmptyMcpArgsFromSchema,
    enrichMcpInputSchemaWithDescription,
    parseMcpDescriptionArgs,
  } = await loadMcpArgumentBuilderForUnitTests();

  const description = `Send a message.

    Args:
        from_: Required. Sending address (phone number, alphanumeric sender ID, or short code).
        to: Required. Receiving address(es).
        text: Required. Message text.
        messaging_profile_id: Optional. Messaging profile ID.
        subject: Optional. Message subject.
        media_urls: Optional. List of media URLs.
        webhook_url: Optional. Webhook URL.
        webhook_failover_url: Optional. Webhook failover URL.
        use_profile_webhooks: Optional boolean. Whether to use profile webhooks. Defaults to True.
        type: Optional. The protocol for sending the message, either "SMS" or "MMS".
        auto_detect: Optional boolean. Automatically detect if an SMS message is unusually long.

    Returns:
        Dict[str, Any]: Response data`;

  const schema = {
    type: "object",
    properties: {
      request: {
        title: "Request",
        type: "object",
      },
    },
    required: ["request"],
  };

  assert.deepEqual(parseMcpDescriptionArgs(description).slice(0, 3), [
    { name: "from_", required: true, type: "string", description: "Sending address (phone number, alphanumeric sender ID, or short code)." },
    { name: "to", required: true, type: "string", description: "Receiving address(es)." },
    { name: "text", required: true, type: "string", description: "Message text." },
  ]);

  const enriched = enrichMcpInputSchemaWithDescription(schema, description);
  assert.deepEqual(enriched.properties.request.required, ["from_", "to", "text"]);
  assert.equal(enriched.properties.request.properties.from_.description, "Sending address (phone number, alphanumeric sender ID, or short code).");
  assert.equal(enriched.properties.request.properties.messaging_profile_id, undefined);
  assert.equal(enriched.properties.request.properties.media_urls, undefined);
  assert.equal(enriched.properties.request.properties.use_profile_webhooks, undefined);

  assert.deepEqual(buildEmptyMcpArgsFromSchema(enriched), {
    request: {
      from_: "",
      to: "",
      text: "",
    },
  });
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
