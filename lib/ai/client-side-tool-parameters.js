export const DEFAULT_CLIENT_SIDE_PARAMETERS = {
  type: "object",
  properties: {},
  required: [],
};

export const CLIENT_SIDE_PARAMETER_TYPES = [
  { value: "string", label: "string" },
  { value: "enum", label: "enum" },
  { value: "number", label: "number" },
  { value: "integer", label: "integer" },
  { value: "boolean", label: "boolean" },
  { value: "array", label: "array" },
  { value: "array-string", label: "array (string)" },
  { value: "array-number", label: "array (number)" },
  { value: "array-boolean", label: "array (boolean)" },
];

const VISUAL_TYPES = new Set(
  CLIENT_SIDE_PARAMETER_TYPES.map((option) => option.value)
);
const VISUAL_PROPERTY_KEYS = new Set([
  "type",
  "description",
  "enum",
  "items",
]);
const VISUAL_ARRAY_ITEM_TYPES = new Set(["string", "number", "boolean"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function visualTypeForProperty(definition) {
  if (!isObject(definition)) return null;
  if (
    Object.keys(definition).some((key) => !VISUAL_PROPERTY_KEYS.has(key))
  ) {
    return null;
  }
  if (
    definition.description !== undefined &&
    typeof definition.description !== "string"
  ) {
    return null;
  }

  if (
    definition.type === "string" &&
    Array.isArray(definition.enum) &&
    definition.enum.every((value) => typeof value === "string")
  ) {
    return "enum";
  }

  if (
    ["string", "number", "integer", "boolean"].includes(definition.type) &&
    definition.enum === undefined &&
    definition.items === undefined
  ) {
    return definition.type;
  }

  if (definition.type !== "array" || definition.enum !== undefined) {
    return null;
  }

  if (definition.items === undefined) return "array";
  if (
    !isObject(definition.items) ||
    Object.keys(definition.items).some((key) => key !== "type") ||
    !VISUAL_ARRAY_ITEM_TYPES.has(definition.items.type)
  ) {
    return null;
  }

  return `array-${definition.items.type}`;
}

export function clientSideParametersSupportVisualMode(parameters) {
  if (
    !isObject(parameters) ||
    parameters.type !== "object" ||
    !isObject(parameters.properties) ||
    !Array.isArray(parameters.required) ||
    (parameters.additionalProperties !== undefined &&
      parameters.additionalProperties !== false)
  ) {
    return false;
  }

  return (
    parameters.required.every((name) =>
      Object.prototype.hasOwnProperty.call(parameters.properties, name)
    ) &&
    Object.values(parameters.properties).every(
      (definition) => visualTypeForProperty(definition) !== null
    )
  );
}

export function clientSideParametersToRows(parameters) {
  const schema = isObject(parameters)
    ? parameters
    : DEFAULT_CLIENT_SIDE_PARAMETERS;
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : []
  );

  return Object.entries(properties).reduce((rows, [name, definition]) => {
    const type = visualTypeForProperty(definition);
    if (!type) return rows;

    rows.push({
      name,
      type,
      required: required.has(name),
      description: String(definition.description || ""),
      enumValues:
        type === "enum" && Array.isArray(definition.enum)
          ? definition.enum.join(", ")
          : "",
    });
    return rows;
  }, []);
}

export function validateClientSideParameterRows(rows) {
  const seenNames = new Set();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    const name = String(row.name || "");
    const prefix = `Parameter ${index + 1}`;

    if (!name.trim()) return `${prefix}: name is required.`;
    if (name !== name.trim()) {
      return `${prefix}: name cannot start or end with whitespace.`;
    }
    if (seenNames.has(name)) return `${prefix}: name must be unique.`;
    if (!VISUAL_TYPES.has(row.type)) {
      return `${prefix}: select a supported type.`;
    }
    if (
      row.type === "enum" &&
      !String(row.enumValues || "")
        .split(",")
        .some((value) => value.trim())
    ) {
      return `${prefix}: add at least one enum value.`;
    }
    seenNames.add(name);
  }

  return "";
}

export function clientSideRowsToParameters(
  rows,
  baseParameters = DEFAULT_CLIENT_SIDE_PARAMETERS
) {
  const validationError = validateClientSideParameterRows(rows);
  if (validationError) throw new Error(validationError);

  const properties = {};
  const required = [];

  rows.forEach((row) => {
    let definition;

    if (row.type === "enum") {
      const enumValues = String(row.enumValues || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      definition = {
        type: "string",
        ...(enumValues.length > 0 ? { enum: enumValues } : {}),
      };
    } else if (row.type === "array") {
      definition = { type: "array" };
    } else if (row.type.startsWith("array-")) {
      definition = {
        type: "array",
        items: { type: row.type.slice("array-".length) },
      };
    } else {
      definition = { type: row.type };
    }

    if (String(row.description || "").trim()) {
      definition.description = String(row.description).trim();
    }

    properties[row.name] = definition;
    if (row.required) required.push(row.name);
  });

  const rootMetadata = isObject(baseParameters) ? { ...baseParameters } : {};
  delete rootMetadata.type;
  delete rootMetadata.properties;
  delete rootMetadata.required;
  delete rootMetadata.additionalProperties;

  return {
    ...rootMetadata,
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
