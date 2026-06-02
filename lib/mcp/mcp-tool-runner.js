import { buildTelnyxV2Url } from "@/lib/telnyx.js";
import { getSecretByName } from "@/lib/secrets.js";
import {
  buildMcpToolArguments,
  normalizeMcpToolResponse,
  resolveMcpTemplateValue,
} from "@/lib/mcp/mcp-argument-builder.js";

export { buildMcpToolArguments, normalizeMcpToolResponse, resolveMcpTemplateValue };

async function loadMcpServer(serverId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error("TELNYX_API_KEY not configured");
  const response = await fetch(buildTelnyxV2Url(`/ai/mcp_servers/${encodeURIComponent(serverId)}`), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.errors?.[0]?.detail || data?.error || "Failed to load MCP server");
  }
  return data.data || data;
}

function isTelnyxMcpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "api.telnyx.com" && ["/mcp/sse", "/v2/mcp"].includes(parsed.pathname);
  } catch {
    return false;
  }
}

async function resolveMcpAuthHeaders(server) {
  const headers = {};
  const apiKeyRef = String(server.api_key_ref || "").trim();
  const telnyxApiKey = isTelnyxMcpUrl(server.url) ? process.env.TELNYX_API_KEY : null;

  if (telnyxApiKey) {
    headers.Authorization = `Bearer ${telnyxApiKey}`;
    return headers;
  }

  if (!apiKeyRef) return headers;

  const localSecret = await getSecretByName(apiKeyRef);
  const apiKey = localSecret?.value || process.env[apiKeyRef];
  if (!apiKey) {
    throw new Error(
      `MCP server '${server.name || server.id || "unknown"}' requires API key ref '${apiKeyRef}', but no matching runtime secret was found. ` +
        "Configure a Contact Center secret or environment variable with the same name so call-flow MCP execution can authenticate.",
    );
  }

  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
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

export async function callMcpTool({ serverId, toolName, input, variables = {} }) {
  if (!serverId) throw new Error("MCP server is required");
  if (!toolName) throw new Error("MCP tool is required");

  const server = await loadMcpServer(serverId);
  const allowedTools = Array.isArray(server.allowed_tools) ? server.allowed_tools : [];
  if (allowedTools.length > 0 && !allowedTools.includes(toolName)) {
    throw new Error(`MCP tool '${toolName}' is not allowed for this server`);
  }

  const resolvedInput = resolveMcpTemplateValue(input || {}, variables);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({ name: "telnyx-contact-center", version: "0.1.0" });
  const transport = await createTransport(server);

  try {
    await client.connect(transport);
    const response = await client.callTool({ name: toolName, arguments: resolvedInput });
    return normalizeMcpToolResponse(response);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function executeMcpToolNode(node, variables = {}, callControlId, executionState = {}) {
  const config = node.data?.config || {};
  const responseVariable = config.responseVariable || "mcp_response";
  const errorVariable = config.errorVariable || "mcp_error";
  try {
    const input = buildMcpToolArguments({
      input: config.input,
      instruction: config.instruction,
      variables,
      toolName: config.toolName,
      toolInputSchema: config.toolInputSchema,
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
          serverId: config.serverId,
          toolName: config.toolName,
        },
      },
    };
  }
}
