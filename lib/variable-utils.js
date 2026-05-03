/**
 * Variable Utility Functions
 * Helpers for variable naming, validation, and reference extraction
 */

export const DEFAULT_FORM_SUBMIT_PAYLOAD_VARIABLE = "form_payload";


/**
 * Generate a unique variable name by auto-incrementing if there's a conflict
 * @param {string} baseName - The base variable name
 * @param {Array<string>} existingNames - Array of existing variable names
 * @returns {string} Unique variable name
 */
export function generateUniqueVariableName(baseName, existingNames = []) {
  if (!existingNames.includes(baseName)) {
    return baseName;
  }

  let counter = 1;
  let uniqueName = `${baseName}_${counter}`;

  while (existingNames.includes(uniqueName)) {
    counter++;
    uniqueName = `${baseName}_${counter}`;
  }

  return uniqueName;
}

/**
 * Validate variable name (must be valid JavaScript identifier)
 * @param {string} name - Variable name to validate
 * @returns {Object} { valid: boolean, error: string }
 */
export function validateVariableName(name) {
  if (!name) {
    return { valid: false, error: "Variable name is required" };
  }

  if (typeof name !== "string") {
    return { valid: false, error: "Variable name must be a string" };
  }

  // Check if it starts with letter or underscore
  if (!/^[a-zA-Z_]/.test(name)) {
    return {
      valid: false,
      error: "Variable name must start with a letter or underscore",
    };
  }

  // Check if it contains only alphanumeric and underscore
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return {
      valid: false,
      error: "Variable name can only contain letters, numbers, and underscores",
    };
  }

  // Check for reserved JavaScript keywords
  const reservedWords = [
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "export",
    "extends",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "let",
    "new",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
  ];

  if (reservedWords.includes(name.toLowerCase())) {
    return {
      valid: false,
      error: `'${name}' is a reserved keyword and cannot be used as a variable name`,
    };
  }

  return { valid: true };
}

/**
 * Extract all variable references from a text string
 * @param {string} text - Text containing {{variable}} references
 * @returns {Array<string>} Array of variable names (without braces)
 */
export function extractVariableReferences(text) {
  if (!text || typeof text !== "string") {
    return [];
  }

  const regex = /\{\{([^}]+)\}\}/g;
  const matches = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    matches.push(match[1].trim());
  }

  return matches;
}

/**
 * Validate that all variable references exist in available variables
 * @param {string} text - Text containing {{variable}} references
 * @param {Array<string>} availableVars - Array of available variable names
 * @returns {Object} { valid: boolean, errors: Array<string> }
 */
export function validateVariableReferences(text, availableVars = []) {
  const references = extractVariableReferences(text);
  const errors = [];

  references.forEach((ref) => {
    // Extract the root variable name (before any dots)
    let rootVar = ref.split(".")[0];

    // Strip array index notation if present (e.g., "varName[0]" -> "varName")
    const arrayIndexMatch = rootVar.match(/^([^[]+)\[/);
    if (arrayIndexMatch) {
      rootVar = arrayIndexMatch[1];
    }

    // Check if it's a special prefix
    if (
      rootVar === "global" ||
      rootVar === "payload" ||
      rootVar === "response"
    ) {
      return; // These are valid prefixes
    }

    // Check if the variable exists
    if (!availableVars.includes(rootVar)) {
      errors.push(`Variable '${rootVar}' is not defined`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Suggest a variable name from a source path
 * Converts "payload.call_control_id" → "call_control_id"
 * @param {string} sourcePath - The source path (e.g., "payload.call_control_id")
 * @returns {string} Suggested variable name
 */
export function suggestVariableName(sourcePath) {
  if (!sourcePath) {
    return "";
  }

  // Split by dots and take the last part
  const parts = sourcePath.split(".");
  const lastPart = parts[parts.length - 1];

  // Convert to snake_case if it's camelCase
  const snakeCase = lastPart.replace(/([A-Z])/g, "_$1").toLowerCase();

  // Remove any non-alphanumeric characters except underscore
  const cleaned = snakeCase.replace(/[^a-z0-9_]/g, "_");

  // Remove leading/trailing underscores
  const trimmed = cleaned.replace(/^_+|_+$/g, "");

  // If empty after cleaning, use a default
  return trimmed || "variable";
}

/**
 * Get the value from an object using dot notation path
 * @param {Object} obj - The object to extract from
 * @param {string} path - Dot notation path (e.g., "payload.call_control_id")
 * @returns {*} The value at the path, or undefined if not found
 */
export function getValueByPath(obj, path) {
  if (!obj || !path) {
    return undefined;
  }

  const parts = path.split(".");
  let current = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current !== "object") {
      return undefined;
    }

    current = current[part];
  }

  return current;
}

/**
 * Set a value in an object using dot notation path
 * @param {Object} obj - The object to modify
 * @param {string} path - Dot notation path
 * @param {*} value - The value to set
 * @returns {Object} The modified object
 */
export function setValueByPath(obj, path, value) {
  if (!obj || !path) {
    return obj;
  }

  const parts = path.split(".");
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];

    if (!(part in current) || typeof current[part] !== "object") {
      current[part] = {};
    }

    current = current[part];
  }

  current[parts[parts.length - 1]] = value;
  return obj;
}

/**
 * Get all variable names from nodes, edges, and global variables
 * @param {Object} flow - The flow definition
 * @returns {Array<string>} Array of all variable names
 */
export function getAllVariableNames(flow) {
  const names = [];

  // Get global variable names
  if (flow.globalVariables) {
    names.push(...Object.keys(flow.globalVariables));
  }

  // Get edge variable mapping names
  if (flow.edges) {
    flow.edges.forEach((edge) => {
      if (edge.data?.variableMappings) {
        edge.data.variableMappings.forEach((mapping) => {
          if (mapping.variableName) {
            names.push(mapping.variableName);
          }
        });
      }
    });
  }

  // Get variable names from Set Variable nodes
  if (flow.nodes) {
    flow.nodes.forEach((node) => {
      const nodeType = node.data?.nodeType;

      // Set Variable nodes define variables directly
      if (nodeType === "set_variable") {
        const variableName = node.data?.config?.variableName;
        if (variableName && variableName.trim()) {
          names.push(variableName.trim());
        }
      }

      // HTTP Request nodes also create response variables
      if (nodeType === "http_request_action") {
        const responseVariable = node.data?.config?.responseVariable;
        if (responseVariable && responseVariable.trim()) {
          names.push(responseVariable.trim());
        }
      }

      // Form Submit initiators create a full submitted form payload variable
      if (nodeType === "form_submit") {
        const payloadVariable =
          node.data?.config?.payloadVariable ||
          node.data?.config?.payloadVariableName ||
          DEFAULT_FORM_SUBMIT_PAYLOAD_VARIABLE;
        if (payloadVariable && payloadVariable.trim()) {
          names.push(payloadVariable.trim());
        }
      }

      // Data Action nodes also create response variables
      if (nodeType === "data_action") {
        const responseVariable = node.data?.config?.responseVariable;
        if (responseVariable && responseVariable.trim()) {
          names.push(responseVariable.trim());
        }
      }
    });
  }

  return names;
}

/**
 * Check if a variable name is a duplicate across the flow
 * @param {string} variableName - The variable name to check
 * @param {Object} flow - The flow definition { nodes, edges, globalVariables }
 * @param {Object} exclude - Optional exclusion criteria { type, id, edgeId, oldName }
 * @returns {Object} { isDuplicate: boolean, source: string, message: string }
 */
export function checkDuplicateVariableName(variableName, flow, exclude = {}) {
  if (!variableName || !variableName.trim()) {
    return { isDuplicate: false, source: null, message: null };
  }

  const trimmedName = variableName.trim();

  // Check global variables
  if (flow.globalVariables && flow.globalVariables[trimmedName]) {
    // Exclude if we're editing this specific global variable
    if (exclude.type === "global" && exclude.oldName === trimmedName) {
      return { isDuplicate: false, source: null, message: null };
    }
    return {
      isDuplicate: true,
      source: "global",
      message: "A global variable with this name already exists",
    };
  }

  // Check edge variable mappings
  if (flow.edges) {
    for (const edge of flow.edges) {
      if (edge.data?.variableMappings) {
        for (const mapping of edge.data.variableMappings) {
          if (mapping.variableName === trimmedName) {
            // Exclude if we're editing this specific edge mapping
            if (exclude.type === "edge" && exclude.edgeId === edge.id) {
              continue;
            }
            return {
              isDuplicate: true,
              source: "edge",
              message: "A variable with this name is defined on another edge",
            };
          }
        }
      }
    }
  }

  // Check Set Variable nodes
  if (flow.nodes) {
    for (const node of flow.nodes) {
      const nodeType = node.data?.nodeType;

      if (nodeType === "set_variable") {
        const nodeVarName = node.data?.config?.variableName;
        if (nodeVarName && nodeVarName.trim() === trimmedName) {
          // Exclude if we're editing this specific node
          if (exclude.type === "set_variable" && exclude.id === node.id) {
            continue;
          }
          return {
            isDuplicate: true,
            source: "set_variable",
            message: `A Set Variable node "${
              node.data?.label || node.id
            }" already defines this variable`,
          };
        }
      }

      if (nodeType === "http_request_action") {
        const responseVar = node.data?.config?.responseVariable;
        if (responseVar && responseVar.trim() === trimmedName) {
          // Exclude if we're editing this specific node
          if (exclude.type === "http_request" && exclude.id === node.id) {
            continue;
          }
          return {
            isDuplicate: true,
            source: "http_request",
            message: `An HTTP Request node "${
              node.data?.label || node.id
            }" already uses this response variable name`,
          };
        }
      }

      if (nodeType === "form_submit") {
        const payloadVar =
          node.data?.config?.payloadVariable ||
          node.data?.config?.payloadVariableName ||
          DEFAULT_FORM_SUBMIT_PAYLOAD_VARIABLE;
        if (payloadVar && payloadVar.trim() === trimmedName) {
          // Exclude if we're editing this specific node
          if (exclude.type === "form_submit" && exclude.id === node.id) {
            continue;
          }
          return {
            isDuplicate: true,
            source: "form_submit",
            message: `A Form Submit node "${
              node.data?.label || node.id
            }" already uses this payload variable name`,
          };
        }
      }

      if (nodeType === "data_action") {
        const responseVar = node.data?.config?.responseVariable;
        if (responseVar && responseVar.trim() === trimmedName) {
          // Exclude if we're editing this specific node
          if (exclude.type === "data_action" && exclude.id === node.id) {
            continue;
          }
          return {
            isDuplicate: true,
            source: "data_action",
            message: `A Data Action node "${
              node.data?.label || node.id
            }" already uses this response variable name`,
          };
        }
      }
    }
  }

  return { isDuplicate: false, source: null, message: null };
}
