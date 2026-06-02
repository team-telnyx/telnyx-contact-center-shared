import { buildTelnyxV2Url } from "@/lib/telnyx.js";
import { getSecretByName } from "@/lib/secrets.js";

function getValueByPathLocal(scope, path) {
  if (!path) return undefined;
  return String(path)
    .split(".")
    .reduce((value, key) => (value == null ? undefined : value[key]), scope);
}

export function resolveMcpTemplateValue(value, variables = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveMcpTemplateValue(item, variables));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        resolveMcpTemplateValue(entryValue, variables),
      ]),
    );
  }
  if (typeof value !== "string") return value;

  const exactMatch = value.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
  if (exactMatch) {
    const resolved = getValueByPathLocal(variables, exactMatch[1].trim());
    return resolved === undefined ? value : resolved;
  }

  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, path) => {
    const resolved = getValueByPathLocal(variables, String(path).trim());
    if (resolved === undefined || resolved === null) return "";
    if (typeof resolved === "object") return JSON.stringify(resolved);
    return String(resolved);
  });
}

export function normalizeMcpToolResponse(response) {
  const raw = response || {};
  const content = Array.isArray(raw.content) ? raw.content : [];
  const text = content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  return {
    raw,
    content,
    text: raw.text || text,
    structuredContent: raw.structuredContent || raw.structured_content || raw.data || {},
    isError: Boolean(raw.isError || raw.is_error || raw.error),
  };
}

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

async function createTransport(server) {
  const headers = {};
  if (server.api_key_ref) {
    const secret = await getSecretByName(server.api_key_ref);
    if (secret?.value) headers.Authorization = `Bearer ${secret.value}`;
  }

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
    const input = typeof config.input === "string" ? JSON.parse(config.input || "{}") : config.input || {};
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
