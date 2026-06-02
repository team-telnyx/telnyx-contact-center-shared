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

function normalizeHeaderName(name) {
  const value = String(name || "").trim();
  return value || null;
}

async function resolveMcpAuthHeaders(server) {
  const headers = { ...(server.headers && typeof server.headers === "object" ? server.headers : {}) };
  const authType = String(server.auth_type || "none").trim();
  const secretName = String(server.auth_secret_name || server.api_key_ref || "").trim();

  if (authType === "none") return headers;
  if (!secretName) {
    throw new Error(`MCP server '${server.name || server.id || "unknown"}' requires an auth secret name`);
  }

  const localSecret = await getSecretByName(secretName);
  const secretValue = localSecret?.value || process.env[secretName];
  if (!secretValue) {
    throw new Error(
      `MCP server '${server.name || server.id || "unknown"}' requires local Contact Center secret '${secretName}', but no matching runtime secret was found.`,
    );
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
