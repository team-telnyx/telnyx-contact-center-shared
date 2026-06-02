// Pure, client-safe MCP argument utilities. Keep Request Preview and runtime calls aligned.

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
  if (input == null || input === "") return {};
  if (typeof input !== "string") return input || {};

  const trimmed = input.trim();
  if (!trimmed) return {};

  const exactTemplateMatch = trimmed.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (exactTemplateMatch) {
    return resolveMcpTemplateValue(trimmed, variables);
  }

  return JSON.parse(input);
}

export function getMcpToolInputSchema(tool) {
  return tool?.input_schema || tool?.inputSchema || tool?.parameters || null;
}

export function getMcpSchemaProperties(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  if (schema.properties && typeof schema.properties === "object") return schema.properties;
  return {};
}

export function buildEmptyMcpArgsFromSchema(schema) {
  const properties = getMcpSchemaProperties(schema);
  return Object.fromEntries(
    Object.entries(properties).map(([key, propertySchema]) => {
      const type = Array.isArray(propertySchema?.type) ? propertySchema.type[0] : propertySchema?.type;
      if (type === "object" || propertySchema?.properties) return [key, buildEmptyMcpArgsFromSchema(propertySchema)];
      if (type === "array") return [key, []];
      if (type === "boolean") return [key, false];
      return [key, ""];
    }),
  );
}

export function buildMcpToolArguments({ input, args, variables = {} } = {}) {
  const explicitArgs = args !== undefined ? args : input;
  const parsedArgs = parseMcpToolInputConfig(explicitArgs, variables);
  if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
    throw new Error("MCP tool arguments must be a JSON object matching the selected tool input schema");
  }
  return resolveMcpTemplateValue(parsedArgs, variables);
}
