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

async function loadMcpAuthDiscoveryForUnitTests() {
  return import(new URL("lib/mcp/mcp-auth-discovery.js", root));
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

test("MCP auth discovery detects OAuth protected remote servers generically", async () => {
  const {
    buildOAuthProtectedResourceMetadataCandidates,
    parseWwwAuthenticateResourceMetadata,
    summarizeOAuthDiscovery,
  } = await loadMcpAuthDiscoveryForUnitTests();

  assert.equal(
    parseWwwAuthenticateResourceMetadata('Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"'),
    "https://api.example.com/.well-known/oauth-protected-resource/mcp",
  );
  assert.deepEqual(
    buildOAuthProtectedResourceMetadataCandidates("https://api.telnyx.com/v2/mcp").slice(0, 2),
    [
      "https://api.telnyx.com/.well-known/oauth-protected-resource/v2/mcp",
      "https://api.telnyx.com/.well-known/oauth-protected-resource",
    ],
  );
  const summary = summarizeOAuthDiscovery({
    resourceMetadata: {
      resource: "https://api.example.com/mcp",
      resource_name: "Example MCP",
      authorization_servers: ["https://auth.example.com"],
    },
    authorizationServerMetadata: {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
      grant_types_supported: ["authorization_code", "refresh_token"],
      scopes_supported: ["admin"],
      code_challenge_methods_supported: ["S256"],
    },
  });
  assert.equal(summary.authType, "oauth_authorization_code");
  assert.equal(summary.resource, "https://api.example.com/mcp");
  assert.equal(summary.resourceName, "Example MCP");
  assert.equal(summary.authorizationServer, "https://auth.example.com");
  assert.equal(summary.authorizationEndpoint, "https://auth.example.com/authorize");
  assert.equal(summary.tokenEndpoint, "https://auth.example.com/token");
  assert.equal(summary.registrationEndpoint, "https://auth.example.com/register");
  assert.equal(summary.pkce, true);
  assert.equal(summary.scope, "admin");

  const clientCredentialsOnlySummary = summarizeOAuthDiscovery({
    resourceMetadata: {
      resource: "https://api.example.com/mcp",
      resource_name: "Example MCP",
      authorization_servers: ["https://auth.example.com"],
    },
    authorizationServerMetadata: {
      issuer: "https://auth.example.com",
      token_endpoint: "https://auth.example.com/token",
      grant_types_supported: ["client_credentials"],
    },
  });
  assert.equal(clientCredentialsOnlySummary.authType, "bearer", "non-Telnyx client_credentials discovery should not auto-select an unsupported runtime flow");
});

test("MCP runtime resolves local Contact Center secrets and validates calls against persisted input schemas", async () => {
  const runner = await read("lib/mcp/mcp-tool-runner.js");
  const secrets = await read("lib/secrets.js");
  const validator = await read("lib/mcp/mcp-schema-validator.js");
  const oauth = await read("lib/mcp/mcp-oauth.js");
  const beginRoute = await read("app/api/admin/mcp-servers/[id]/oauth/begin/route.js");
  const callbackRoute = await read("app/api/admin/mcp-servers/oauth/callback/route.js");
  const discovery = await read("lib/mcp/mcp-auth-discovery.js");
  const discoverRoute = await read("app/api/admin/mcp-servers/auth/discover/route.js");

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
  assert.match(runner, /tokenSecretName\(server\.id\)/, "Telnyx MCP runtime should prefer connected OAuth sessions by server id");
  assert.match(runner, /authType !== "oauth_client_credentials"/, "Telnyx MCP OAuth session fallback should not override explicit client credentials");
  assert.match(runner, /await hasTelnyxMcpOAuthSession\(server\)/, "Telnyx MCP bearer guard should allow connected OAuth sessions");
  assert.match(oauth, /serverUpdate\.rowCount < 1/, "OAuth callback should fail if the MCP server row was not updated");
  assert.match(oauth, /was not found while saving OAuth session/, "OAuth callback should expose DB/server mismatch instead of pretending success");
  assert.doesNotMatch(runner, /Telnyx Portal OAuth can only be used/, "interactive OAuth should not be hardcoded to Telnyx URLs");
  assert.match(runner, /https:\/\/api\.telnyx\.com\/v2\/mcp/, "runtime should still explain Telnyx MCP API-key pitfalls");
  assert.match(runner, /parsed\.protocol === "https:"/, "Telnyx URL guard should still require HTTPS for Telnyx-specific fallbacks");
  assert.match(runner, /A Telnyx API key in Bearer auth can list tools but fails tool execution/, "runtime should explain Telnyx MCP API-key auth failures");
  assert.match(runner, /assertValidMcpToolArguments/, "runtime should validate args against schema before MCP call");
  assert.match(runner, /addNodeExecutionEvent/, "runtime should add MCP Tool execution events to Call Monitor");
  assert.match(runner, /node\.data\?\.label \|\| "MCP Tool"/, "MCP Tool monitor events should use the node label");
  assert.match(validator, /removeAdditional:\s*false/, "validator must respect additionalProperties instead of stripping unknown fields");
  assert.match(runner, /output:\s*0/, "runtime should route success through output 0");
  assert.match(runner, /output:\s*1/, "runtime should route MCP errors through output 1");
  assert.match(oauth, /browserSafeBaseUrl/, "OAuth should normalize server bind addresses before browser redirects");
  assert.match(oauth, /hostname === "0\.0\.0\.0"/, "OAuth should detect 0.0.0.0 origins");
  assert.match(oauth, /baseUrl\.hostname\.replace/, "OAuth should normalize bracketed IPv6 bind origins");
  assert.match(oauth, /baseUrl\.hostname = "localhost"/, "OAuth should redirect browsers to localhost instead of 0.0.0.0");
  assert.match(oauth, /code_challenge_method", "S256"/, "OAuth should use PKCE S256");
  assert.match(oauth, /discoverMcpServerAuth/, "OAuth begin should use generic MCP auth discovery metadata");
  assert.match(oauth, /registrationEndpoint/, "OAuth should support dynamic client registration from provider metadata");
  assert.match(oauth, /refresh_token/, "OAuth sessions should refresh tokens");
  assert.match(oauth, /grantType === "refresh_token" && authMethod === "none"/, "public PKCE refresh must not send client authentication to Telnyx");
  assert.match(oauth, /Telnyx returns invalid_client/, "OAuth helper should document the Telnyx invalid_client refresh pitfall");
  assert.match(oauth, /tokenSession\.token_endpoint \|\|/, "OAuth refresh should tolerate older Telnyx sessions without a saved token endpoint");
  assert.match(oauth, /https:\/\/api\.telnyx\.com\/v2\/oauth\/token/, "OAuth refresh should fall back to the Telnyx token endpoint for legacy Telnyx MCP sessions");
  assert.match(discovery, /WWW-Authenticate/i, "auth discovery should inspect WWW-Authenticate bearer challenges");
  assert.match(discovery, /oauth-protected-resource/, "auth discovery should probe OAuth protected resource metadata");
  assert.match(discovery, /oauth-authorization-server/, "auth discovery should probe OAuth authorization server metadata");
  assert.match(discovery, /registration_endpoint/, "auth discovery should support dynamic client registration metadata");
  assert.match(discoverRoute, /discoverMcpServerAuth/, "admin route should expose generic MCP auth discovery");
  assert.match(beginRoute, /NextResponse\.redirect\(authorizationUrl\)/, "begin route should redirect admins to the discovered authorization server");
  assert.doesNotMatch(beginRoute, /isTelnyxMcpUrl|Telnyx Portal OAuth/, "OAuth begin route should not be hardcoded to Telnyx MCP URLs");
  assert.match(callbackRoute, /finishTelnyxMcpOAuth/, "callback route should exchange the authorization code");
  assert.match(callbackRoute, /getPendingTelnyxMcpOAuthServerId/, "callback route should preserve the initiating server id on OAuth errors");
  assert.match(callbackRoute, /server_id: serverId/, "callback redirect should include the initiating MCP server id");
  assert.match(callbackRoute, /browserSafeBaseUrl\(request\)/, "callback route should avoid redirecting browsers to 0.0.0.0");
});

test("MCP Server admin page uses local Contact Center secrets and persists discovered schemas", async () => {
  const adminPage = await read("app/(portal)/admin/mcp-servers/page.jsx");
  const sheet = await read("components/admin/MCPServerEditorSheet.jsx");
  const toolDetailsSheet = await read("components/admin/MCPToolDetailsSheet.jsx");
  const toolsRoute = await read("app/api/admin/mcp-servers/[id]/tools/route.js");

  assert.match(adminPage, /MCPServerEditorSheet/, "admin page should use the MCP server sheet");
  assert.match(adminPage, /mcp_oauth/, "admin page should read OAuth callback status from query params");
  assert.match(adminPage, /setSheetServerId\(serverId\)/, "admin page should reopen the initiating server sheet after OAuth callback");
  assert.match(adminPage, /oauthStatus=\{oauthStatus\}/, "admin page should pass OAuth status into the sheet");
  assert.match(sheet, /Select All \(\{availableTools\.length\} tools\)/, "sheet should support bulk allowlist selection");
  assert.match(sheet, /auth_secret_name/, "sheet should save local auth secret names");
  assert.match(sheet, /buildAuthPayload/, "sheet should build auth payloads through one helper for connect and save");
  assert.match(sheet, /auth_secret_name:\s*nextAuthType === "none" \? "" : nextAuthSecretName/s, "None auth should send an empty secret even when a stale secret remains in hidden UI state");
  assert.match(sheet, /await loadTools\(\{ authOverride: \{ auth_type: nextAuthType, auth_scheme: nextAuthScheme \} \}\)/, "Connect should refresh tools using detected auth values instead of stale React state");
  assert.match(toolsRoute, /sanitizeMcpServerAuthInput/, "tools discovery route should sanitize auth fields before merging with a saved server");
  assert.match(toolsRoute, /auth_type === "none"[\s\S]*auth_secret_name: null/, "tools discovery route should clear auth secrets for explicit None auth");
  assert.match(toolsRoute, /hasOwnProperty\.call\(body, "headers"\)/, "tools discovery route should preserve saved custom headers when refresh requests omit headers");
  assert.doesNotMatch(toolsRoute, /headers:\s*body\.headers \|\| \{\}/, "tools discovery route must not overwrite saved custom headers with an empty object when headers are omitted");
  assert.doesNotMatch(toolsRoute, /body\.auth_secret_name \|\| body\.api_key_ref \|\| server\.auth_secret_name/, "tools discovery route must not resurrect a stale saved secret when the request explicitly selects None auth");
  assert.match(sheet, /oauth_client_credentials/, "sheet should allow OAuth client credentials for protected MCP resources");
  assert.match(sheet, /OAuth Resource URL/, "sheet should expose the resource URL required by non-Telnyx OAuth client credentials servers");
  assert.match(sheet, /oauth_authorization_code/, "sheet should allow Claude-style OAuth Authorization Code");
  assert.doesNotMatch(sheet, /Detect Authentication/, "sheet should not require a separate auth detection step before Connect");
  assert.match(sheet, /connectServer/, "sheet should use Connect for auth discovery");
  assert.match(sheet, /function authenticateOAuth/, "OAuth redirect should be split into an explicit Authenticate action");
  assert.match(sheet, /onClick=\{authenticateOAuth\}/, "OAuth card should expose an Authenticate button");
  assert.match(sheet, /Authenticate/, "sheet should label the OAuth redirect action Authenticate");
  assert.match(sheet, /persistServer[\s\S]*oauth\/begin/, "Authenticate should auto-save the MCP server before OAuth redirect");
  assert.match(sheet, /detectedAuth/, "sheet should store detected MCP auth metadata");
  assert.match(sheet, /OAuth auto-detected/, "sheet should show an OAuth auto-detected badge");
  const connectServerBody = sheet.slice(sheet.indexOf("async function connectServer"), sheet.indexOf("async function authenticateOAuth"));
  assert.doesNotMatch(connectServerBody, /oauth\/begin|window\.location\.href/, "Connect must not automatically start the provider OAuth redirect");
  assert.match(sheet, /Authentication connected/, "sheet should show a clear colored connected OAuth badge");
  assert.match(sheet, /Authentication failed/, "sheet should show a clear colored failed OAuth badge");
  assert.match(sheet, /Reconnect required/, "sheet should stop presenting expired OAuth sessions as connected");
  assert.match(sheet, /oauthSessionIssue/, "sheet should derive OAuth health from tool-loading errors");
  assert.match(toolsRoute, /oauthReconnectRequired/, "tools route should flag invalid OAuth refresh sessions");
  assert.match(toolsRoute, /Reconnect OAuth/, "tools route should tell admins how to recover invalid OAuth sessions generically");
  assert.match(sheet, /bg-gradient-to-br/, "OAuth section should use a polished highlighted card design");
  assert.match(sheet, /Authorization Code \+ PKCE/, "sheet should describe the interactive OAuth flow");
  assert.doesNotMatch(sheet, /OAuth via Telnyx Portal/, "OAuth auth label should not be hardcoded to Telnyx Portal");
  assert.match(sheet, /client_id.*client_secret/s, "sheet should explain OAuth credential secret format");
  assert.match(sheet, /\/api\/admin\/secrets/, "sheet should list local Contact Center secrets for runtime auth");
  assert.doesNotMatch(sheet, /\/api\/integration-secrets|Telnyx integration secrets|APIKeyRefCombobox/, "MCP auth picker must not use Telnyx integration secrets");
  assert.doesNotMatch(sheet, /secret\.value/, "sheet must not expose decrypted secret values client-side");
  assert.match(adminPage, /MCPToolDetailsSheet/, "admin page should include the MCP tool details sheet");
  assert.match(adminPage, /setToolDetails/, "clicking an expanded tool badge should open tool details");
  assert.match(adminPage, /toolsByName\.get\(toolName\)/, "tool badges should pass discovered tool metadata, not only the tool name");
  assert.match(adminPage, /View \$\{toolName\} tool details/, "tool badges should advertise the details action");
  assert.match(toolDetailsSheet, /SheetContent side="right" className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0 bg-background"/, "tool details should use the standard right-side sheet shell");
  assert.match(toolDetailsSheet, /CodeBlock/, "tool details should render schemas in a code viewer");
  assert.match(toolDetailsSheet, /Input Schema/, "tool details should show the input schema");
  assert.match(toolDetailsSheet, /Output Schema/, "tool details should show the output schema");
  assert.match(toolDetailsSheet, /Raw Tool Metadata/, "tool details should expose all available tool metadata");
  assert.match(toolDetailsSheet, /Input Arguments/, "tool details should summarize schema properties");
  assert.doesNotMatch(toolDetailsSheet, /showLineNumbers/, "MCP tool details code viewers should not show line numbers");
});

test("MCP Tool editor, test sheet, and monitor expose normalized response payloads", async () => {
  const editor = await read("components/voice-flow/McpToolNodeEditor.jsx");
  const sheet = await read("components/voice-flow/McpToolTestSheet.jsx");
  const route = await read("app/api/voice/flows/test-mcp-tool/route.js");
  const nodes = await read("config/voice-flow-nodes.js");
  const callFlowPage = await read("app/(portal)/admin/call-flows/[id]/page.jsx");

  assert.match(nodes, /toolInputSchema/, "MCP node config should persist selected tool schema");
  assert.doesNotMatch(nodes, /Plain-language instruction|list all Polish numbers/, "MCP node config should no longer depend on NLP instruction mapping");

  assert.match(editor, /toolInputSchema/, "editor should persist selected tool input schema on the node config");
  assert.match(editor, /Schema-driven Tool Arguments/, "editor should render schema-driven argument controls");
  assert.match(editor, /ArgumentMappingField/, "editor should allow assigning variables/templates to schema arguments");
  assert.match(editor, /buildEmptyMcpArgsFromSchema/, "editor should initialize arguments from schema");
  assert.match(editor, /VariableInput/, "text argument fields should support {{variables}} in input controls");
  assert.match(editor, /Switch/, "boolean argument fields should render as toggles");
  assert.match(editor, /IconInfoCircle/, "argument labels should expose schema description info icons");
  assert.match(editor, /TooltipTrigger/, "argument info icons should use tooltip triggers so descriptions open on mouse hover");
  assert.match(editor, /TooltipContent/, "argument info icons should show schema descriptions in hover tooltips");
  assert.doesNotMatch(editor, /PopoverTrigger/, "argument info icons should not require click-only popovers");
  assert.match(editor, /filteredTools\[0\]/, "tool refresh should auto-select the first discovered allowed tool instead of leaving an empty select value");
  assert.doesNotMatch(editor, /<VariableTextarea/, "text argument fields should not render as textarea controls");
  assert.doesNotMatch(editor, /Instruction[\s\S]*list all Polish numbers/i, "instruction/NLP mapping should no longer be primary MCP UX");

  assert.match(sheet, /Test MCP Tool/);
  assert.match(sheet, /Variable Values/);
  assert.match(sheet, /Request Preview/);
  assert.match(sheet, /Input Schema/);
  assert.match(sheet, /validateMcpToolArguments/, "test sheet should validate request preview against selected schema");
  assert.match(sheet, /formatJsonLikeCode/, "test sheet should pretty-print JSON strings in Response Text");
  assert.match(sheet, /testSessionKey/, "test sheet should key transient result state to the selected server/tool/request");
  assert.match(sheet, /setTestResult\(null\)[\s\S]*setTestError\(null\)/, "test sheet should clear stale responses when reopened for a different MCP tool");
  assert.match(sheet, /testSessionKeyRef\.current !== sessionKeyAtTestStart/, "test sheet should ignore late responses from a previous server/tool selection");
  assert.doesNotMatch(sheet, /showLineNumbers/, "test sheet JSON/code previews should not show line numbers");
  assert.match(sheet, /\/api\/voice\/flows\/test-mcp-tool/);
  assert.match(sheet, /CodeBlockCopyButton/);
  assert.match(sheet, /Response Text[\s\S]*CodeBlock code=\{formatJsonLikeCode\(testResult\.text\)\}[\s\S]*maxHeight=\{320\}[\s\S]*className="max-h-80 overflow-auto"/, "response text should render pretty-printed JSON strings in the same scrollable code preview pattern as schema previews");
  assert.doesNotMatch(sheet, /Response Text[\s\S]*whitespace-pre-wrap/, "response text should not render as an unbounded plain text block");
  assert.match(callFlowPage, /if \(nodeType === "mcp_tool"\)/, "Call Monitor should have a dedicated MCP Tool renderer instead of falling back to raw JSON");
  assert.match(callFlowPage, /Request Payload[\s\S]*Response Payload/s, "MCP Tool monitor details should split request and response payload code views");
  assert.match(callFlowPage, /getMcpResponseVariablePayload/, "MCP Tool monitor should render the same response payload assigned to the response variable");
  assert.doesNotMatch(callFlowPage, /mcp_tool[\s\S]{0,1200}JSON\.stringify\(details, null, 2\)/, "MCP Tool monitor must not render request and response as one combined raw JSON object");
  assert.match(sheet, /onTestSuccess/);

  assert.match(route, /callMcpTool/);
  assert.match(route, /buildMcpToolArguments/);
  assert.match(route, /request\.headers\.get\("cookie"\)/);
  assert.match(route, /request\.headers\.get\("authorization"\)/);
  assert.match(route, /NextResponse\.json/);
});

test("MCP response variable value unwraps JSON payloads from MCP text content", async () => {
  const { getMcpResponseVariablePayload, normalizeMcpToolResponse } = await loadMcpArgumentBuilderForUnitTests();
  const projectPayload = {
    id: "d44f8fc6-2a7e-4bcd-84e5-27cc293557b5",
    name: "Burjeel Holdings",
    summary: "AI outbound calling for marketing lead-gen",
  };
  const normalized = normalizeMcpToolResponse({
    content: [{ type: "text", text: JSON.stringify(projectPayload) }],
  });

  assert.deepEqual(
    getMcpResponseVariablePayload(normalized),
    projectPayload,
    "response variable should receive the parsed JSON payload from content[].text, not the raw MCP envelope",
  );
  assert.deepEqual(
    getMcpResponseVariablePayload({ structuredContent: { rows: [{ id: 1 }] }, content: [] }),
    { rows: [{ id: 1 }] },
    "structuredContent should remain the response variable payload when MCP supplies structured output directly",
  );
  assert.equal(
    getMcpResponseVariablePayload({ text: "plain answer", content: [{ type: "text", text: "plain answer" }] }),
    "plain answer",
    "plain text MCP output should be assigned as plain text when it is not JSON",
  );
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
  assert.equal(enriched.properties.request.properties.messaging_profile_id.description, "Messaging profile ID.");
  assert.equal(enriched.properties.request.properties.media_urls.description, "List of media URLs.");
  assert.equal(enriched.properties.request.properties.use_profile_webhooks.type, "boolean");

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
