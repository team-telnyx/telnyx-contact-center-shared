import Ajv from "ajv";

const ajv = new Ajv({
  strict: false,
  allErrors: true,
  coerceTypes: true,
  useDefaults: false,
  removeAdditional: false,
});

export function formatMcpValidationErrors(errors = []) {
  return errors.map((error) => ({
    path: error.instancePath || error.schemaPath || "/",
    message: error.message || "Invalid value",
    keyword: error.keyword,
    params: error.params || {},
  }));
}

export function validateMcpToolArguments(args, inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return { valid: true, errors: [] };
  }
  const validate = ajv.compile(inputSchema);
  const valid = validate(args);
  const errors = valid ? [] : formatMcpValidationErrors(validate.errors || []);
  return { valid: Boolean(valid), errors };
}

export function assertValidMcpToolArguments(args, inputSchema) {
  const result = validateMcpToolArguments(args, inputSchema);
  if (result.valid) return args;
  const message = result.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
  const error = new Error(`MCP tool arguments do not match the selected tool schema: ${message}`);
  error.validationErrors = result.errors;
  throw error;
}
