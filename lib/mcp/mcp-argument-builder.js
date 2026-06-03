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

function hasStructuredMcpPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).length > 0;
}

export function parseMcpJsonTextPayload(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!/^[\[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function getMcpResponseVariablePayload(response) {
  if (!response || typeof response !== "object") return response;
  if (Object.prototype.hasOwnProperty.call(response, "body")) return response.body;
  if (hasStructuredMcpPayload(response.structuredContent)) return response.structuredContent;

  const content = Array.isArray(response.content) ? response.content : [];
  const textPayload = response.text || content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  if (textPayload) return parseMcpJsonTextPayload(textPayload);

  if (hasStructuredMcpPayload(response.raw?.structuredContent)) return response.raw.structuredContent;
  if (hasStructuredMcpPayload(response.raw?.structured_content)) return response.raw.structured_content;
  if (hasStructuredMcpPayload(response.raw?.data)) return response.raw.data;
  return response;
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

function inferMcpArgTypeFromDescription(name, description) {
  const text = `${name || ""} ${description || ""}`.toLowerCase();
  if (/\bboolean\b|\bbool\b/.test(text)) return "boolean";
  if (/\blist\b|\barray\b|\burls\b|\bids\b/.test(text)) return "array";
  if (/\binteger\b|\bint\b/.test(text)) return "integer";
  if (/\bnumber\b|\bfloat\b|\bdouble\b/.test(text)) return /phone\s+number|number\(s\)|receiving address|sending address/.test(text) ? "string" : "number";
  return "string";
}

function buildMcpArgSchemaFromDescription(arg = {}) {
  const schema = { type: arg.type || "string" };
  if (schema.type === "array") schema.items = { type: "string" };
  if (arg.description) schema.description = arg.description;
  return schema;
}

function stripMcpRequiredPrefix(description = "") {
  return String(description)
    .replace(/^\s*Required\.\s*/i, "")
    .replace(/^\s*Optional(?:\s+boolean)?\.?:?\s*/i, "")
    .replace(/^\s*Optional\s+/i, "")
    .trim();
}

export function parseMcpDescriptionArgs(description) {
  if (!description) return [];
  const lines = String(description).replace(/\r\n/g, "\n").split("\n");
  const args = [];
  let inArgs = false;

  for (const line of lines) {
    if (/^\s*Args\s*:?\s*$/i.test(line)) {
      inArgs = true;
      continue;
    }
    if (!inArgs) continue;
    if (/^\s*(Returns|Raises|Note|Notes|Examples?)\s*:?/i.test(line)) break;
    if (!line.trim()) continue;

    const match = line.match(/^\s*(?:[-*•–—]\s*)?([A-Za-z_][\w.-]{0,80})\s*:\s*(.+?)\s*$/);
    if (!match) continue;

    const [, name, rawDescription] = match;
    const required = /^\s*Required\b/i.test(rawDescription);
    const cleanedDescription = stripMcpRequiredPrefix(rawDescription);
    args.push({
      name,
      required,
      type: inferMcpArgTypeFromDescription(name, rawDescription),
      description: cleanedDescription,
    });
  }

  return args;
}

function hasObjectProperties(schema) {
  return Boolean(schema?.properties && typeof schema.properties === "object" && Object.keys(schema.properties).length > 0);
}

export function enrichMcpInputSchemaWithDescription(schema, description) {
  const args = parseMcpDescriptionArgs(description);
  if (!args.length || !schema || typeof schema !== "object" || Array.isArray(schema)) return schema;

  const next = structuredClone(schema);
  const properties = getMcpSchemaProperties(next);
  const requestSchema = properties.request;
  const targetSchema = requestSchema && (requestSchema.type === "object" || requestSchema.properties || requestSchema.title === "Request")
    ? requestSchema
    : next;

  if (targetSchema !== next && hasObjectProperties(targetSchema)) return next;
  if (targetSchema === next && hasObjectProperties(next)) return next;

  targetSchema.type = "object";
  targetSchema.properties = Object.fromEntries(
    args.map((arg) => [arg.name, buildMcpArgSchemaFromDescription(arg)]),
  );
  const requiredArgs = args.filter((arg) => arg.required);
  const required = requiredArgs.map((arg) => arg.name);
  if (required.length) {
    targetSchema.required = Array.from(new Set([...(Array.isArray(targetSchema.required) ? targetSchema.required : []), ...required]));
  }

  return next;
}

export function buildEmptyMcpArgsFromSchema(schema) {
  const properties = getMcpSchemaProperties(schema);
  const requiredNames = Array.isArray(schema?.required) ? schema.required : [];
  return Object.fromEntries(
    Object.entries(properties).filter(([key]) => requiredNames.includes(key)).map(([key, propertySchema]) => {
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
