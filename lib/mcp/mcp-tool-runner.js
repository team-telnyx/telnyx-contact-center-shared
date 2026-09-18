import { getSecretByName } from "@/lib/secrets.js";
import { getValidTelnyxMcpOAuthAccessToken, tokenSecretName } from "@/lib/mcp/mcp-oauth.js";
import {
  buildClientCredentialsTokenRequest,
  parseOAuthClientCredentials,
  resolveClientCredentialsConfig,
} from "@/lib/mcp/mcp-oauth-client-credentials.js";
import {
  buildMcpToolArguments,
  getMcpResponseVariablePayload,
  normalizeMcpToolResponse,
  resolveMcpTemplateValue,
} from "@/lib/mcp/mcp-argument-builder.js";
import { assertValidMcpToolArguments } from "@/lib/mcp/mcp-schema-validator.js";
import { getMcpServer, getMcpServerTool, normalizeMcpTools } from "@/lib/mcp/mcp-server-registry.js";
import { addNodeExecutionEvent } from "@/lib/call-monitor-store.js";
import { unwrapMcpResultEnvelope } from "@/lib/agent-assist/slot-mcp-runner.mjs";

export { buildMcpToolArguments, normalizeMcpToolResponse, resolveMcpTemplateValue };
export { validateMcpToolArguments, assertValidMcpToolArguments } from "@/lib/mcp/mcp-schema-validator.js";

const oauthTokenCache = new Map();

function normalizeHeaderName(name) {
  const value = String(name || "").trim();
  return value || null;
}

// HTTP header names are case-insensitive, but a plain object is not: a custom
// header named "authorization" would survive alongside a generated
// "Authorization", and fetch joins same-name headers into a single invalid
// value ("static-value, Bearer <token>"), breaking auth. Always set through
// this so a generated header replaces any case variant of itself.
function setHeader(headers, name, value) {
  const target = String(name || "").toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === target) delete headers[existing];
  }
  headers[name] = value;
}

// Header values may reference an encrypted local secret as {{secret:NAME}}
// rather than embedding the credential in the plaintext mcp_servers.headers
// column (which is also returned to the browser by the admin GET route).
const SECRET_HEADER_PATTERN = /^\{\{\s*secret:([^}]+?)\s*\}\}$/;

export function parseSecretHeaderReference(value) {
  const match = SECRET_HEADER_PATTERN.exec(String(value ?? "").trim());
  return match ? match[1].trim() : null;
}

async function resolveConfiguredHeaders(server) {
  const configured = server.headers && typeof server.headers === "object" ? server.headers : {};
  const resolved = {};
  for (const [name, rawValue] of Object.entries(configured)) {
    const secretRef = parseSecretHeaderReference(rawValue);
    if (!secretRef) {
      resolved[name] = rawValue;
      continue;
    }
    const localSecret = await getSecretByName(secretRef);
    const secretValue = localSecret?.value || process.env[secretRef];
    if (!secretValue) {
      throw new Error(
        `MCP server '${server.name || server.id || "unknown"}' header '${name}' references local Contact Center secret '${secretRef}', but no matching runtime secret was found.`,
      );
    }
    resolved[name] = secretValue;
  }
  return resolved;
}

export function isTelnyxMcpUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.protocol === "https:" && parsed.hostname === "api.telnyx.com" && pathname === "/v2/mcp";
  } catch {
    return false;
  }
}

async function fetchOAuthClientCredentialsToken(config) {
  const { endpoint, headers, body } = buildClientCredentialsTokenRequest(config);
  const cacheKey = JSON.stringify([
    endpoint,
    config.clientId,
    config.scope || "",
    config.resource || "",
    config.audience || "",
  ]);
  const cached = oauthTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body,
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) {
    throw new Error(
      data?.error_description || data?.error || `Failed to obtain MCP OAuth access token from ${endpoint}`,
    );
  }

  const expiresIn = Number(data.expires_in || 3600);
  oauthTokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000,
  });
  return data.access_token;
}

async function resolveSecretValue(secretName, server) {
  const localSecret = await getSecretByName(secretName);
  const secretValue = localSecret?.value || process.env[secretName];
  if (!secretValue) {
    throw new Error(
      `MCP server '${server.name || server.id || "unknown"}' requires local Contact Center secret '${secretName}', but no matching runtime secret was found.`,
    );
  }
  return secretValue;
}

async function hasTelnyxMcpOAuthSession(server) {
  if (!isTelnyxMcpUrl(server.url) || !server.id) return false;
  const oauthSecret = await getSecretByName(tokenSecretName(server.id));
  return Boolean(oauthSecret?.value);
}

async function resolveMcpAuthHeaders(server) {
  const headers = await resolveConfiguredHeaders(server);
  const authType = String(server.auth_type || "none").trim();
  const secretName = String(server.auth_secret_name || server.api_key_ref || "").trim();

  if (isTelnyxMcpUrl(server.url) && server.id && authType !== "oauth_client_credentials") {
    const oauthSecretName = tokenSecretName(server.id);
    if (await hasTelnyxMcpOAuthSession(server)) {
      const accessToken = await getValidTelnyxMcpOAuthAccessToken(oauthSecretName);
      setHeader(headers, "Authorization", `Bearer ${accessToken}`);
      return headers;
    }
  }

  if (authType === "none") return headers;
  if (!secretName) {
    throw new Error(`MCP server '${server.name || server.id || "unknown"}' requires an auth secret name`);
  }

  const secretValue = await resolveSecretValue(secretName, server);

  if (authType === "oauth_authorization_code") {
    const accessToken = await getValidTelnyxMcpOAuthAccessToken(secretName);
    setHeader(headers, "Authorization", `Bearer ${accessToken}`);
    return headers;
  }

  if (authType === "oauth_client_credentials") {
    const credentials = parseOAuthClientCredentials(secretValue);
    if (!credentials) {
      throw new Error(
        `MCP server '${server.name || server.id || "unknown"}' uses OAuth Client Credentials, but secret '${secretName}' is not a JSON {client_id, client_secret} value or client_id:client_secret pair.`,
      );
    }
    const resolved = resolveClientCredentialsConfig({
      credentials,
      authScheme: server.auth_scheme,
      isTelnyxMcpResource: isTelnyxMcpUrl(server.url),
    });
    const accessToken = await fetchOAuthClientCredentialsToken({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      ...resolved,
    });
    setHeader(headers, "Authorization", `Bearer ${accessToken}`);
    return headers;
  }

  if (authType === "bearer") {
    setHeader(headers, "Authorization", `Bearer ${secretValue}`);
    return headers;
  }

  if (authType === "api_key") {
    setHeader(headers, normalizeHeaderName(server.auth_header_name) || "x-api-key", secretValue);
    return headers;
  }

  if (authType === "custom_header") {
    const headerName = normalizeHeaderName(server.auth_header_name);
    if (!headerName) throw new Error("Custom header authentication requires a header name");
    const scheme = String(server.auth_scheme || "").trim();
    setHeader(headers, headerName, scheme ? `${scheme} ${secretValue}` : secretValue);
    return headers;
  }

  throw new Error(`Unsupported MCP auth type '${authType}'`);
}

async function createTransport(server) {
  const headers = await resolveMcpAuthHeaders(server);

  if (server.type === "http") {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
  }

  const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
  return new SSEClientTransport(new URL(server.url), { requestInit: { headers } });
}

async function withMcpClient(server, callback) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({ name: "telnyx-contact-center", version: "0.1.0" });
  const transport = await createTransport(server);
  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function markMcpDispatchError(error, state) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  try {
    normalized.mcpDispatchState = state;
    normalized.remoteOutcomeUncertain = state === "uncertain";
    return normalized;
  } catch {
    const wrapped = new Error(normalized.message, { cause: normalized });
    wrapped.mcpDispatchState = state;
    wrapped.remoteOutcomeUncertain = state === "uncertain";
    if (normalized.validationErrors) wrapped.validationErrors = normalized.validationErrors;
    return wrapped;
  }
}

export async function discoverMcpToolsForServer(server) {
  if (!server?.url) throw new Error("MCP server URL is required");
  return withMcpClient(server, async (client) => {
    const response = await client.listTools();
    return normalizeMcpTools(response);
  });
}

export async function callMcpTool({ serverId, toolName, input, args, variables = {} }) {
  try {
    if (!serverId) throw new Error("MCP server is required");
    if (!toolName) throw new Error("MCP tool is required");

    const server = await getMcpServer(serverId);
    if (!server || server.enabled === false) throw new Error("MCP server not found or disabled");
    if (
      isTelnyxMcpUrl(server.url) &&
      String(server.auth_type || "none") === "bearer" &&
      !(await hasTelnyxMcpOAuthSession(server))
    ) {
      throw new Error(
        "Telnyx MCP HTTP tools/call requires an OAuth bearer token for resource https://api.telnyx.com/v2/mcp. " +
          "A Telnyx API key in Bearer auth can list tools but fails tool execution with 'Authentication required for MCP method'. " +
          "Configure this MCP server with OAuth Client Credentials instead.",
      );
    }
    const allowedTools = Array.isArray(server.allowed_tools) ? server.allowed_tools : [];
    if (allowedTools.length > 0 && !allowedTools.includes(toolName)) {
      throw new Error(`MCP tool '${toolName}' is not allowed for this server`);
    }

    const tool = await getMcpServerTool(serverId, toolName);
    if (!tool) throw new Error(`MCP tool '${toolName}' is not discovered for this server`);

    const resolvedInput = buildMcpToolArguments({ input, args, variables });
    assertValidMcpToolArguments(resolvedInput, tool.input_schema);

    return await withMcpClient(server, async (client) => {
      try {
        const response = await client.callTool({ name: toolName, arguments: resolvedInput });
        return normalizeMcpToolResponse(response);
      } catch (error) {
        // Once client.callTool has been entered, a thrown transport/protocol
        // error may mean the remote tool performed its side effect before the
        // response was lost. Mark that outcome explicitly so callers can avoid
        // blindly retrying once-per-session operations.
        throw markMcpDispatchError(error, "uncertain");
      }
    });
  } catch (error) {
    // Errors raised before client.callTool (missing/disabled server, undiscovered
    // tool, invalid arguments, auth setup, transport construction or connect)
    // cannot have executed the target tool. Preserve an explicit uncertain
    // marker from the callback; otherwise classify the failure as preflight so
    // a corrected configuration can retry safely.
    if (error?.mcpDispatchState === "uncertain") throw error;
    throw markMcpDispatchError(error, "preflight");
  }
}

export async function executeMcpToolNode(node, variables = {}, callControlId, executionState = {}) {
  const config = node.data?.config || {};
  const responseVariable = config.responseVariable || "mcp_response";
  const errorVariable = config.errorVariable || "mcp_error";
  try {
    const input = buildMcpToolArguments({
      input: config.args ?? config.input,
      variables,
    });
    const result = await callMcpTool({
      serverId: config.serverId,
      toolName: config.toolName,
      input,
      variables,
      callControlId,
      flowId: executionState.flowId,
      nodeId: node.id,
    });

    if (result.isError) {
      addNodeExecutionEvent(
        callControlId,
        "mcp_tool",
        node.id,
        node.data?.label || "MCP Tool",
        {
          server_id: config.serverId,
          tool_name: config.toolName,
          request: input,
          response: result,
        },
        false,
        1,
        executionState?.flowId || null,
      );
      return { success: true, output: 1, variables: { [errorVariable]: result } };
    }

    // the reference workflow wraps every tool result as {result, error} regardless of transport
    // (JSON-RPC content[].text or the plain REST alternative) and reports
    // failures INSIDE that envelope rather than as an MCP-protocol error, so
    // a 200/non-isError response can still be a failed call. getMcpResponse-
    // VariablePayload only strips the MCP protocol layer (content[].text /
    // structuredContent) — it has no notion of the reference integration's own envelope, so without
    // this unwrap, mcp_response.<field> from a the reference workflow tool is always one level
    // too shallow (the real fields sit under mcp_response.result.<field>).
    // The slot-mcp binding pipeline already applies this same unwrap via
    // unwrapToolPayload (slot-mcp-execute.js) — this brings the call-flow MCP
    // Tool node in line with it so `mcp_response.<field>` behaves the same
    // way in both places.
    const rawResponsePayload = getMcpResponseVariablePayload(result);
    const { payload: responsePayload, error: envelopeError } = unwrapMcpResultEnvelope(rawResponsePayload);

    if (envelopeError) {
      addNodeExecutionEvent(
        callControlId,
        "mcp_tool",
        node.id,
        node.data?.label || "MCP Tool",
        {
          server_id: config.serverId,
          tool_name: config.toolName,
          request: input,
          response: result,
          response_payload: rawResponsePayload,
          envelope_error: envelopeError,
        },
        false,
        1,
        executionState?.flowId || null,
      );
      return {
        success: true,
        output: 1,
        variables: { [errorVariable]: { message: envelopeError, response: rawResponsePayload } },
      };
    }

    addNodeExecutionEvent(
      callControlId,
      "mcp_tool",
      node.id,
      node.data?.label || "MCP Tool",
      {
        server_id: config.serverId,
        tool_name: config.toolName,
        response_variable: responseVariable,
        request: input,
        response: result,
        response_payload: responsePayload,
      },
      true,
      0,
      executionState?.flowId || null,
    );

    return {
      success: true,
      output: 0,
      variables: {
        [responseVariable]: responsePayload,
        [`${responseVariable}_text`]: typeof responsePayload === "string" ? responsePayload : result.text || "",
        [`${responseVariable}_structured`]: responsePayload && typeof responsePayload === "object" ? responsePayload : result.structuredContent || {},
      },
    };
  } catch (error) {
    addNodeExecutionEvent(
      callControlId,
      "mcp_tool",
      node.id,
      node.data?.label || "MCP Tool",
      {
        server_id: config.serverId,
        tool_name: config.toolName,
        error: error?.message || String(error),
        validationErrors: error?.validationErrors || undefined,
      },
      false,
      1,
      executionState?.flowId || null,
    );
    return {
      success: true,
      output: 1,
      variables: {
        [errorVariable]: {
          message: error?.message || String(error),
          validationErrors: error?.validationErrors || undefined,
        },
      },
    };
  }
}
