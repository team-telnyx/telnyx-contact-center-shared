import contract from "./assistant-contract.json" with { type: "json" };

function resolve(schema = {}) {
  return schema.$ref
    ? contract.components.schemas[schema.$ref.split("/").at(-1)] || {}
    : schema;
}

function acceptsNull(raw) {
  const schema = resolve(raw);
  return schema.type === "null" ||
    (Array.isArray(schema.type) && schema.type.includes("null")) ||
    (schema.anyOf || schema.oneOf || []).some(acceptsNull);
}

// GET includes null placeholders that are invalid in a newly created override.
// Omit only optional, documented, non-nullable fields. Preserve meaningful nulls
// (inheritance/clearing), unknown fields, and the original assistant settings.
export function cloneAssistantOverride(value, schemaName) {
  function copy(current, raw) {
    let schema = resolve(raw);
    const variants = schema.anyOf || schema.oneOf;
    if (variants && current && typeof current === "object") {
      schema = variants.map(resolve).find((variant) => {
        const discriminator = variant.properties?.type;
        return discriminator && (discriminator.const === current.type || discriminator.enum?.includes(current.type));
      }) || variants.map(resolve).find((variant) => variant.type === "object" || variant.properties) || schema;
    }
    if (Array.isArray(current)) return current.map((item) => copy(item, schema.items));
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(Object.entries(current)
      .filter(([key, item]) => !(item === null && schema.properties?.[key] && !schema.required?.includes(key) && !acceptsNull(schema.properties[key])))
      .map(([key, item]) => [key, copy(item, schema.properties?.[key])]));
  }
  return copy(value, contract.components.schemas[schemaName]);
}
