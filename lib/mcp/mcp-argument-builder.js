// Pure, client-safe MCP argument builder. Keep schema-driven mapping here so
// Request Preview and runtime calls cannot drift.

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

function getMcpToolSchemaProperties(toolInputSchema) {
  if (!toolInputSchema || typeof toolInputSchema !== "object" || Array.isArray(toolInputSchema)) {
    return {};
  }
  return toolInputSchema.properties && typeof toolInputSchema.properties === "object"
    ? toolInputSchema.properties
    : {};
}

function getObjectSchemaProperties(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  if (schema.properties && typeof schema.properties === "object") return schema.properties;
  return {};
}

function isObjectSchema(schema) {
  const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];
  return types.includes("object") || Boolean(schema?.properties);
}

function isStringSchema(schema) {
  return schema?.type === "string" || (Array.isArray(schema?.type) && schema.type.includes("string"));
}

function isNumberSchema(schema) {
  const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];
  return types.includes("number") || types.includes("integer");
}

function normalizeSchemaText(...parts) {
  return parts.filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9_+\s-]/g, " ");
}

function getInstructionFacts(instruction) {
  const rawText = String(instruction || "");
  const text = rawText.toLowerCase();
  const countryIsoByKeyword = [
    [/\b(polish|poland|polska|polski|pl)\b/, "PL"],
    [/\b(german|germany|deutschland|de)\b/, "DE"],
    [/\b(united states|usa|us)\b/, "US"],
    [/\b(united kingdom|great britain|british|uk|gb)\b/, "GB"],
    [/\b(canadian|canada|ca)\b/, "CA"],
    [/\b(french|france|fr)\b/, "FR"],
    [/\b(spanish|spain|es)\b/, "ES"],
    [/\b(italian|italy|it)\b/, "IT"],
  ];
  const phoneNumbers = Array.from(rawText.matchAll(/\+\d[\d\s().-]{6,}\d/g))
    .map((match) => match[0].replace(/[\s().-]/g, ""));
  const quotedStrings = Array.from(rawText.matchAll(/["“”'‘’]([^"“”'‘’]{1,1000})["“”'‘’]/g)).map((match) => match[1].trim());
  const textMatch = rawText.match(/(?:with\s+)?(?:text|message|body|content)\s*(?:=|:|as|to)?\s*["“”'‘’]([^"“”'‘’]+)["“”'‘’]/i)
    || rawText.match(/(?:with\s+)?(?:text|message|body|content)\s*(?:=|:|as|to)?\s+(.+?)(?:\s+from\b|\s+to\b|$)/i);
  const fromMatch = rawText.match(/\bfrom\s+(?:Telnyx\s+)?(?:alphasender\s+ID\s+|sender\s+ID\s+|number\s+)?(.+?)(?:\s+with\b|\s+to\b|\s+and\b|$)/i);
  const prefixMatch = rawText.match(/(?:prefix|starts?\s+with|begin(?:s|ning)?\s+with)\s*(\+?\d{3,15})/i);
  const pageSizeMatch = text.match(/(?:page\s*size|limit|show(?:\s+only)?)\s*(\d{1,3})/);

  return {
    rawText,
    text,
    phoneNumbers,
    quotedStrings,
    messageText: (textMatch?.[1] || quotedStrings[0] || "").trim(),
    fromText: (fromMatch?.[1] || "").trim().replace(/[.,;:]$/, ""),
    prefix: prefixMatch?.[1],
    pageSize: pageSizeMatch ? Math.max(1, Math.min(250, Number(pageSizeMatch[1]))) : undefined,
    countryIso: countryIsoByKeyword.find(([pattern]) => pattern.test(text))?.[1]
      || (/\b(polish|poland|polska|polski|pl)\b/.test(text) ? "PL" : undefined),
    status: /\b(active|available)\b/.test(text) ? "active" : undefined,
  };
}

function inferSchemaValue(fieldName, schema, facts) {
  const fieldText = normalizeSchemaText(fieldName, schema?.title, schema?.description);

  if (isStringSchema(schema)) {
    if (/\binstruction\b|natural_language|prompt/.test(fieldText)) return facts.rawText;
    if (/country.*iso|iso.*country|alpha2|country_code/.test(fieldText) && facts.countryIso) return facts.countryIso;
    if (/status|state/.test(fieldText) && facts.status) return facts.status;
    if (/prefix|filter_phone_number|phone_number_filter|starts/.test(fieldText) && facts.prefix) return facts.prefix;
    if (/(^|[_\s-])(to|recipient|destination|customer|phone_number|phone)([_\s-]|$)/.test(fieldText) && facts.phoneNumbers[0]) return facts.phoneNumbers[0];
    if (/(^|[_\s-])(from|sender|source|caller|alpha|alphanumeric)([_\s-]|$)/.test(fieldText) && facts.fromText) return facts.fromText;
    if (/(^|[_\s-])(text|message|body|content|template)([_\s-]|$)/.test(fieldText) && facts.messageText) return facts.messageText;
  }

  if (isNumberSchema(schema) && /page_size|limit|per_page|max/.test(fieldText) && facts.pageSize !== undefined) {
    return facts.pageSize;
  }

  return undefined;
}

function stripUnknownSchemaFields(value, schema) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isObjectSchema(schema)) return value;
  const properties = getObjectSchemaProperties(schema);
  if (Object.keys(properties).length === 0) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => Object.prototype.hasOwnProperty.call(properties, key))
      .map(([key, entryValue]) => [key, stripUnknownSchemaFields(entryValue, properties[key])]),
  );
}

function buildSchemaObjectFromInstruction(schema, facts) {
  const properties = getObjectSchemaProperties(schema);
  const result = {};

  Object.entries(properties).forEach(([fieldName, fieldSchema]) => {
    if (isObjectSchema(fieldSchema)) {
      const nested = buildSchemaObjectFromInstruction(fieldSchema, facts);
      if (Object.keys(nested).length > 0) result[fieldName] = nested;
      return;
    }

    const inferredValue = inferSchemaValue(fieldName, fieldSchema, facts);
    if (inferredValue !== undefined && inferredValue !== "") result[fieldName] = inferredValue;
  });

  if (Object.keys(result).length === 0) {
    const requiredStringFields = Array.isArray(schema?.required)
      ? schema.required.filter((fieldName) => isStringSchema(properties[fieldName]))
      : [];
    if (requiredStringFields.length === 1) return { [requiredStringFields[0]]: facts.rawText };

    const stringFields = Object.entries(properties)
      .filter(([, fieldSchema]) => isStringSchema(fieldSchema))
      .map(([fieldName]) => fieldName);
    if (stringFields.length === 1) return { [stringFields[0]]: facts.rawText };
  }

  return result;
}

function buildInstructionArguments({ resolvedInstruction, toolName, toolInputSchema }) {
  const facts = getInstructionFacts(resolvedInstruction);
  const properties = getMcpToolSchemaProperties(toolInputSchema);
  const requestProperty = properties.request;

  if (isStringSchema(requestProperty)) {
    return { request: resolvedInstruction };
  }

  if (requestProperty && isObjectSchema(requestProperty)) {
    return { request: buildSchemaObjectFromInstruction(requestProperty, facts) };
  }

  if (Object.keys(properties).length > 0) {
    return buildSchemaObjectFromInstruction(toolInputSchema, facts);
  }

  if (toolName === "list_phone_numbers") {
    return {
      request: Object.fromEntries(
        Object.entries({
          filter_country_iso_alpha2: facts.countryIso,
          filter_status: facts.status,
          filter_phone_number: facts.prefix,
          page_size: facts.pageSize,
        }).filter(([, value]) => value !== undefined && value !== ""),
      ),
    };
  }

  return { request: { instruction: resolvedInstruction } };
}

export function buildMcpToolArguments({ input, instruction, variables = {}, toolName, toolInputSchema } = {}) {
  const advancedInput = parseMcpToolInputConfig(input, variables);
  const resolvedInstruction = resolveMcpTemplateValue(instruction || "", variables);
  const hasInstruction = typeof resolvedInstruction === "string" && resolvedInstruction.trim();

  const rootSchema = toolInputSchema && typeof toolInputSchema === "object" && !Array.isArray(toolInputSchema)
    ? toolInputSchema
    : null;

  if (!hasInstruction) {
    const resolvedAdvancedInput = resolveMcpTemplateValue(advancedInput || {}, variables);
    return rootSchema ? stripUnknownSchemaFields(resolvedAdvancedInput, rootSchema) : resolvedAdvancedInput;
  }

  const baseArguments = buildInstructionArguments({ resolvedInstruction, toolName, toolInputSchema });

  if (!advancedInput || typeof advancedInput !== "object" || Array.isArray(advancedInput)) {
    return rootSchema ? stripUnknownSchemaFields(baseArguments, rootSchema) : baseArguments;
  }

  let mergedArguments;
  if (advancedInput.request && typeof advancedInput.request === "object" && !Array.isArray(advancedInput.request) && baseArguments.request) {
    mergedArguments = {
      ...advancedInput,
      request: {
        ...baseArguments.request,
        ...resolveMcpTemplateValue(advancedInput.request, variables),
      },
    };
  } else {
    mergedArguments = {
      ...baseArguments,
      ...resolveMcpTemplateValue(advancedInput, variables),
    };
  }

  return rootSchema ? stripUnknownSchemaFields(mergedArguments, rootSchema) : mergedArguments;
}

