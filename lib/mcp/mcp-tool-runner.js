import { getSecretByName } from "@/lib/secrets.js";
import {
  buildMcpToolArguments,
  normalizeMcpToolResponse,
  resolveMcpTemplateValue,
} from "@/lib/mcp/mcp-argument-builder.js";
import { assertValidMcpToolArguments } from "@/lib/mcp/mcp-schema-validator.js";
import { getMcpServer, getMcpServerTool, normalizeMcpTools } from "@/lib/mcp/mcp-server-registry.js";

export { buildMcpToolArguments, normalizeMcpToolResponse, resolveMcpTemplateValue };
export { validateMcpToolArguments, assertValidMcpToolArguments } from "@/lib/mcp/mcp-schema-validator.js";

const oauthTokenCache = new Map();

function normalizeHeaderName(name) {
  const value = String(name || "").trim();
  return value || null;
}

function isTelnyxMcpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "api.telnyx.com" && parsed.pathname === "/v2/mcp";
  } catch {
    return false;
  }
}

function parseOAuthClientCredentials(secretValue) {
  const raw = String(secretValue || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const clientId = String(parsed.client_id || parsed.clientId || "").trim();
    const clientSecret = String(parsed.client_secret || parsed.clientSecret || "").trim();
    if (clientId && clientSecret) return { clientId, clientSecret };
  } catch {
    // Fall through to delimiter formats.
  }

  const separator = raw.includes("\n") ? "\n" : raw.includes(":") ? ":" : null;
  if (!separator) return null;
  const [clientId, ...rest] = raw.split(separator);
  const clientSecret = rest.join(separator);
  if (!String(clientId || "").trim() || !String(clientSecret || "").trim()) return null;
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

async function fetchOAuthClientCredentialsToken({ clientId, clientSecret, resource }) {
  const cacheKey = `${clientId}:${resource}`;
  const cached = oauthTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "admin",
    resource,
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch("https://api.telnyx.com/v2/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) {
    throw new Error(data?.error_description || data?.error || "Failed to obtain MCP OAuth access token");
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

async function resolveMcpAuthHeaders(server) {
  const headers = { ...(server.headers && typeof server.headers === "object" ? server.headers : {}) };
  const authType = String(server.auth_type || "none").trim();
  const secretName = String(server.auth_secret_name || server.api_key_ref || "").trim();

  if (authType === "none") return headers;
  if (!secretName) {
    throw new Error(`MCP server '${server.name || server.id || "unknown"}' requires an auth secret name`);
  }

  const secretValue = await resolveSecretValue(secretName, server);

  if (authType === "oauth_client_credentials") {
    const credentials = parseOAuthClientCredentials(secretValue);
    if (!credentials) {
      throw new Error(
        `MCP server '${server.name || server.id || "unknown"}' uses OAuth Client Credentials, but secret '${secretName}' is not a JSON {client_id, client_secret} value or client_id:client_secret pair.`,
      );
    }
    const resource = isTelnyxMcpUrl(server.url) ? "https://api.telnyx.com/v2/mcp" : String(server.auth_scheme || "").trim();
    if (!resource) throw new Error("OAuth Client Credentials authentication requires auth_scheme to contain the OAuth resource URL");
    const accessToken = await fetchOAuthClientCredentialsToken({ ...credentials, resource });
    headers.Authorization = `Bearer ${accessToken}`;
    return headers;
  }

  if (authType === "bearer") {
    headers.Authorization = `Bearer ${secretValue}`;
    return headers;
  }

  if (authType === "api_key") {
    headers[normalizeHeaderName(server.auth_header_name) || "x-api-key"] = secretValue;
    return headers;
  }

  if (authType === "custom_header") {
    const headerName = normalizeHeaderName(server.auth_header_name);
    if (!headerName) throw new Error("Custom header authentication requires a header name");
    const scheme = String(server.auth_scheme || "").trim();
    headers[headerName] = scheme ? `${scheme} ${secretValue}` : secretValue;
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

export async function discoverMcpToolsForServer(server) {
  if (!server?.url) throw new Error("MCP server URL is required");
  return withMcpClient(server, async (client) => {
    const response = await client.listTools();
    return normalizeMcpTools(response);
  });
}

export async function callMcpTool({ serverId, toolName, input, args, variables = {} }) {
  if (!serverId) throw new Error("MCP server is required");
  if (!toolName) throw new Error("MCP tool is required");

  const server = await getMcpServer(serverId);
  if (!server || server.enabled === false) throw new Error("MCP server not found or disabled");
  if (isTelnyxMcpUrl(server.url) && String(server.auth_type || "none") === "bearer") {
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

  return withMcpClient(server, async (client) => {
    const response = await client.callTool({ name: toolName, arguments: resolvedInput });
    return normalizeMcpToolResponse(response);
  });
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
      return { success: true, output: 1, variables: { [errorVariable]: result } };
    }

    return {
      success: true,
      output: 0,
      variables: {
        [responseVariable]: result,
        [`${responseVariable}_text`]: result.text || "",
        [`${responseVariable}_structured`]: result.structuredContent || {},
      },
    };
  } catch (error) {
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
