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

export function parseMcpToolInputConfig(input, variables = {}) {
  if (typeof input !== "string") return input || {};

  const trimmed = input.trim();
  if (!trimmed) return {};

  const exactTemplateMatch = trimmed.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (exactTemplateMatch) {
    return resolveMcpTemplateValue(trimmed, variables);
  }

  return JSON.parse(input);
}

function inferPhoneNumberRequestFromInstruction(instruction) {
  const text = String(instruction || "").toLowerCase();
  const request = {};

  if (/\b(polish|poland|polska|polski|pl)\b/.test(text)) {
    request.filter_country_iso_alpha2 = "PL";
  }
  if (/\b(active|available)\b/.test(text)) {
    request.filter_status = "active";
  }
  const pageSizeMatch = text.match(/(?:page\s*size|limit|show(?:\s+only)?)\s*(\d{1,3})/);
  if (pageSizeMatch) {
    request.page_size = Math.max(1, Math.min(250, Number(pageSizeMatch[1])));
  }

  return request;
}

function getMcpToolSchemaProperties(toolInputSchema) {
  if (!toolInputSchema || typeof toolInputSchema !== "object" || Array.isArray(toolInputSchema)) {
    return {};
  }
  return toolInputSchema.properties && typeof toolInputSchema.properties === "object"
    ? toolInputSchema.properties
    : {};
}

function isStringSchema(schema) {
  return schema?.type === "string" || (Array.isArray(schema?.type) && schema.type.includes("string"));
}

function buildInstructionArguments({ resolvedInstruction, toolName, toolInputSchema }) {
  const properties = getMcpToolSchemaProperties(toolInputSchema);
  const requestProperty = properties.request;
  const instructionRequest = toolName === "list_phone_numbers"
    ? inferPhoneNumberRequestFromInstruction(resolvedInstruction)
    : {};

  if (requestProperty && typeof requestProperty === "object" && !Array.isArray(requestProperty)) {
    return {
      request: {
        instruction: resolvedInstruction,
        ...instructionRequest,
      },
    };
  }

  if (isStringSchema(properties.instruction)) {
    return { instruction: resolvedInstruction };
  }

  const requiredStringFields = Array.isArray(toolInputSchema?.required)
    ? toolInputSchema.required.filter((field) => isStringSchema(properties[field]))
    : [];
  if (requiredStringFields.length === 1) {
    return { [requiredStringFields[0]]: resolvedInstruction };
  }

  const stringFields = Object.entries(properties)
    .filter(([, schema]) => isStringSchema(schema))
    .map(([field]) => field);
  if (stringFields.length === 1) {
    return { [stringFields[0]]: resolvedInstruction };
  }

  return {
    request: {
      instruction: resolvedInstruction,
      ...instructionRequest,
    },
  };
}

export function buildMcpToolArguments({ input, instruction, variables = {}, toolName, toolInputSchema } = {}) {
  const advancedInput = parseMcpToolInputConfig(input, variables);
  const resolvedInstruction = resolveMcpTemplateValue(instruction || "", variables);
  const hasInstruction = typeof resolvedInstruction === "string" && resolvedInstruction.trim();

  if (!hasInstruction) {
    return resolveMcpTemplateValue(advancedInput || {}, variables);
  }

  const baseArguments = buildInstructionArguments({ resolvedInstruction, toolName, toolInputSchema });

  if (!advancedInput || typeof advancedInput !== "object" || Array.isArray(advancedInput)) {
    return baseArguments;
  }

  if (advancedInput.request && typeof advancedInput.request === "object" && !Array.isArray(advancedInput.request) && baseArguments.request) {
    return {
      ...advancedInput,
      request: {
        ...baseArguments.request,
        ...resolveMcpTemplateValue(advancedInput.request, variables),
      },
    };
  }

  return {
    ...baseArguments,
    ...resolveMcpTemplateValue(advancedInput, variables),
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
