/**
 * Expression Engine
 * Safe expression evaluator for variables and functions
 */

import { getValueByPath } from "./variable-utils";

/**
 * Evaluate an expression with variables
 * @param {string} expression - The expression to evaluate
 * @param {Object} variables - Available variables
 * @returns {Object} { success: boolean, result: any, error: string }
 */
export function evaluateExpression(expression, variables = {}) {
  try {
    if (!expression) {
      return { success: false, error: "Expression is empty" };
    }

    // Replace {{variable}} syntax with actual values
    let processedExpr = expression;

    // Find all {{...}} patterns
    const varPattern = /\{\{([^}]+)\}\}/g;
    const matches = [...expression.matchAll(varPattern)];

    for (const match of matches) {
      const varPath = match[1].trim();

      // Check if this is a complex JavaScript expression (contains operators)
      if (
        varPath.includes("+") ||
        varPath.includes("-") ||
        varPath.includes("*") ||
        varPath.includes("/") ||
        varPath.includes("&&") ||
        varPath.includes("||")
      ) {
        // This is a JavaScript expression, evaluate it and return immediately
        const value = evaluateJavaScriptExpression(varPath, variables);
        return { success: true, result: value };
      } else {
        // Simple variable reference
        const value = resolveVariable(varPath, variables);
        let replacement;
        if (typeof value === "string") {
          replacement = JSON.stringify(value);
        } else if (value === undefined || value === null) {
          replacement = "null";
        } else if (typeof value === "object") {
          replacement = JSON.stringify(value);
        } else {
          replacement = String(value);
        }
        processedExpr = processedExpr.replace(match[0], replacement);
      }
    }

    // If the expression is just a variable reference, return it directly
    if (matches.length === 1 && matches[0][0] === expression) {
      const varPath = matches[0][1].trim();
      const value = resolveVariable(varPath, variables);
      return { success: true, result: value };
    }

    // Evaluate the processed expression
    const result = evaluateSafeExpression(processedExpr, variables);

    return { success: true, result };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Expression evaluation failed",
    };
  }
}

/**
 * Evaluate a JavaScript expression with variable substitution
 * @param {string} expression - JavaScript expression (e.g., "customer_data.data.rows[0].first_name + ' ' + customer_data.data.rows[0].last_name")
 * @param {Object} variables - Available variables
 * @returns {*} The evaluated result
 */
function evaluateJavaScriptExpression(expression, variables) {
  try {
    // Replace variable references in the expression with actual values
    let processedExpr = expression;

    // Find all variable references (identifiers that might be variables)
    // Match patterns like: customer_data.data.rows[0].first_name
    const varPattern =
      /[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\[\d+\])*/g;
    const matches = [...expression.matchAll(varPattern)];

    // Sort matches by length (longest first) to avoid partial replacements
    const sortedMatches = matches.sort((a, b) => b[0].length - a[0].length);

    for (const match of sortedMatches) {
      const varPath = match[0];
      const value = resolveVariable(varPath, variables);

      if (value !== undefined) {
        let replacement;
        if (typeof value === "string") {
          replacement = JSON.stringify(value);
        } else if (value === null) {
          replacement = "null";
        } else if (typeof value === "object") {
          replacement = JSON.stringify(value);
        } else {
          replacement = String(value);
        }

        // Replace all occurrences of this variable path
        // Use a simple string replace since we're processing longest paths first
        processedExpr = processedExpr.split(varPath).join(replacement);
      }
    }

    // Evaluate the processed expression
    const result = eval(processedExpr);
    return result;
  } catch (error) {
    console.error(
      `[evaluateJavaScriptExpression] Error evaluating expression: ${expression}`,
      error
    );
    return undefined;
  }
}

/**
 * Resolve a variable path to its value
 * Supports array indexing: payload.custom_headers[0] or payload.tags[1]
 * @param {string} varPath - Variable path (e.g., "global.name" or "payload.custom_headers[0]")
 * @param {Object} variables - Available variables
 * @returns {*} The resolved value
 */
function resolveVariable(varPath, variables) {
  // Handle array indexing in path: array[0] or array[0].property
  const arrayIndexPattern = /([^[]+)\[(\d+)\](.*)$/;
  const arrayMatch = varPath.match(arrayIndexPattern);

  if (arrayMatch) {
    const [, basePath, index, remainingPath] = arrayMatch;
    const baseValue = resolveVariable(basePath.trim(), variables);

    if (Array.isArray(baseValue)) {
      const element = baseValue[parseInt(index, 10)];

      // If there's a remaining path (e.g., [0].value), resolve it
      if (remainingPath && element) {
        const cleanPath = remainingPath.startsWith(".")
          ? remainingPath.substring(1)
          : remainingPath;
        return getValueByPath(element, cleanPath);
      }

      return element;
    }

    return undefined;
  }

  // Handle global prefix
  if (varPath.startsWith("global.")) {
    const path = varPath.substring(7); // Remove "global."
    return getValueByPath(variables.global || {}, path);
  }

  // Handle payload prefix
  if (varPath.startsWith("payload.")) {
    const path = varPath.substring(8); // Remove "payload."
    return getValueByPath(variables.payload || {}, path);
  }

  // Handle response prefix
  if (varPath.startsWith("response.")) {
    const path = varPath.substring(9); // Remove "response."
    return getValueByPath(variables.response || {}, path);
  }

  // Handle dot notation in variable name
  if (varPath.includes(".")) {
    return getValueByPath(variables, varPath);
  }

  // Direct variable access
  return variables[varPath];
}

/**
 * Safely evaluate an expression using a limited set of operations
 * @param {string} expr - Expression to evaluate
 * @param {Object} variables - Available variables
 * @returns {*} Result of evaluation
 */
function evaluateSafeExpression(expr, variables) {
  // Create a safe evaluation context with only allowed functions
  const context = {
    // String functions
    substring: (str, start, length) => {
      const s = String(str || "");
      return length === undefined
        ? s.substring(start)
        : s.substring(start, start + length);
    },
    toUpperCase: (str) => String(str || "").toUpperCase(),
    toLowerCase: (str) => String(str || "").toLowerCase(),
    trim: (str) => String(str || "").trim(),
    replace: (str, find, replace) => String(str || "").replace(find, replace),
    concat: (...args) => args.join(""),
    length: (str) => String(str || "").length,
    indexOf: (str, search) => String(str || "").indexOf(search),
    startsWith: (str, search) => String(str || "").startsWith(search),
    endsWith: (str, search) => String(str || "").endsWith(search),
    contains: (str, search) => String(str || "").includes(search),

    // Numeric functions
    round: (num) => Math.round(Number(num)),
    abs: (num) => Math.abs(Number(num)),
    min: (...args) => Math.min(...args.map(Number)),
    max: (...args) => Math.max(...args.map(Number)),
    floor: (num) => Math.floor(Number(num)),
    ceil: (num) => Math.ceil(Number(num)),

    // Date/Time functions
    now: () => new Date().toISOString(),
    formatDate: (date, format) => {
      // Simple date formatting (can be enhanced)
      const d = new Date(date);
      return d.toISOString();
    },
    addMinutes: (date, minutes) => {
      const d = new Date(date);
      d.setMinutes(d.getMinutes() + Number(minutes));
      return d.toISOString();
    },
    diffMinutes: (date1, date2) => {
      const d1 = new Date(date1);
      const d2 = new Date(date2);
      return Math.floor((d2 - d1) / 60000);
    },

    // Logic functions
    ifThen: (condition, trueValue, falseValue) =>
      condition ? trueValue : falseValue,
    isEmpty: (value) => !value || value === "",
    isNull: (value) => value === null || value === undefined,

    // Type conversion
    toString: (value) => String(value),
    toNumber: (value) => Number(value),
    toBoolean: (value) => Boolean(value),

    // Array functions
    arrayLength: (arr) => (Array.isArray(arr) ? arr.length : 0),
    first: (arr) => (Array.isArray(arr) && arr.length > 0 ? arr[0] : null),
    last: (arr) =>
      Array.isArray(arr) && arr.length > 0 ? arr[arr.length - 1] : null,
    at: (arr, index) => (Array.isArray(arr) ? arr[Number(index)] : null),
    find: (arr, key, value) => {
      if (!Array.isArray(arr)) return null;
      return (
        arr.find(
          (item) =>
            typeof item === "object" && item !== null && item[key] === value
        ) || null
      );
    },
    findValue: (arr, key, searchValue, returnKey) => {
      if (!Array.isArray(arr)) return null;
      const found = arr.find(
        (item) =>
          typeof item === "object" && item !== null && item[key] === searchValue
      );
      return found && returnKey ? found[returnKey] : found;
    },
    filter: (arr, key, value) => {
      if (!Array.isArray(arr)) return [];
      return arr.filter(
        (item) =>
          typeof item === "object" && item !== null && item[key] === value
      );
    },
    map: (arr, key) => {
      if (!Array.isArray(arr)) return [];
      return arr.map((item) =>
        typeof item === "object" && item !== null ? item[key] : item
      );
    },
    includes: (arr, value) => Array.isArray(arr) && arr.includes(value),
    some: (arr, key, value) => {
      if (!Array.isArray(arr)) return false;
      return arr.some(
        (item) =>
          typeof item === "object" && item !== null && item[key] === value
      );
    },
    every: (arr, key, value) => {
      if (!Array.isArray(arr)) return false;
      return arr.every(
        (item) =>
          typeof item === "object" && item !== null && item[key] === value
      );
    },
    join: (arr, separator = ",") => {
      if (!Array.isArray(arr)) return "";
      return arr.join(separator);
    },
    slice: (arr, start, end) => {
      if (!Array.isArray(arr)) return [];
      return end !== undefined ? arr.slice(start, end) : arr.slice(start);
    },
    reverse: (arr) => {
      if (!Array.isArray(arr)) return [];
      return [...arr].reverse();
    },
    sort: (arr) => {
      if (!Array.isArray(arr)) return [];
      return [...arr].sort();
    },
    unique: (arr) => {
      if (!Array.isArray(arr)) return [];
      return [...new Set(arr)];
    },

    // Math object for advanced operations
    Math: Math,
  };

  // Create a function that evaluates the expression in the safe context
  // Using Function constructor is safer than eval as we control the scope
  try {
    const func = new Function(
      ...Object.keys(context),
      `"use strict"; return (${expr});`
    );
    return func(...Object.values(context));
  } catch (error) {
    throw new Error(`Expression evaluation error: ${error.message}`);
  }
}

/**
 * Validate an expression for syntax errors
 * @param {string} expression - Expression to validate
 * @param {Array<string>} availableVariables - List of available variable names
 * @returns {Object} { valid: boolean, errors: Array<string> }
 */
export function validateExpression(expression, availableVariables = []) {
  const errors = [];

  if (!expression) {
    errors.push("Expression cannot be empty");
    return { valid: false, errors };
  }

  // Check for unmatched braces
  const openBraces = (expression.match(/\{\{/g) || []).length;
  const closeBraces = (expression.match(/\}\}/g) || []).length;

  if (openBraces !== closeBraces) {
    errors.push("Unmatched {{ }} braces in expression");
  }

  // Extract variable references
  const varPattern = /\{\{([^}]+)\}\}/g;
  const matches = [...expression.matchAll(varPattern)];

  for (const match of matches) {
    const varPath = match[1].trim();

    // Skip special prefixes
    if (
      varPath.startsWith("global.") ||
      varPath.startsWith("payload.") ||
      varPath.startsWith("response.")
    ) {
      continue;
    }

    // Extract root variable name (handle array indexing: varName[0] -> varName)
    let rootVar = varPath.split(".")[0];

    // Strip array index notation if present
    const arrayIndexMatch = rootVar.match(/^([^[]+)\[/);
    if (arrayIndexMatch) {
      rootVar = arrayIndexMatch[1];
    }

    // Check if variable exists
    if (!availableVariables.includes(rootVar)) {
      errors.push(`Variable '${rootVar}' is not defined`);
    }
  }

  // Try to parse basic syntax (without evaluating)
  try {
    // Replace variables with dummy values for syntax check
    let testExpr = expression;
    for (const match of matches) {
      testExpr = testExpr.replace(match[0], "1");
    }

    // Try to create a function (syntax check only)
    new Function(`"use strict"; return (${testExpr});`);
  } catch (error) {
    errors.push(`Syntax error: ${error.message}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Evaluate a condition expression (returns boolean)
 * @param {string} leftOperand - Left side of comparison
 * @param {string} operator - Comparison operator
 * @param {string} rightOperand - Right side of comparison
 * @param {string} dataType - Data type for comparison (string/number/boolean)
 * @param {Object} variables - Available variables
 * @returns {Object} { success: boolean, result: boolean, error: string }
 */
export function evaluateCondition(
  leftOperand,
  operator,
  rightOperand,
  dataType,
  variables = {}
) {
  try {
    // Resolve operands
    const left = resolveOperand(leftOperand, dataType, variables);
    const right = resolveOperand(rightOperand, dataType, variables);

    let result = false;

    switch (operator) {
      case "===":
        result = left === right;
        break;
      case "!==":
        result = left !== right;
        break;
      case ">":
        result = left > right;
        break;
      case "<":
        result = left < right;
        break;
      case ">=":
        result = left >= right;
        break;
      case "<=":
        result = left <= right;
        break;
      case "contains":
        result = String(left).includes(String(right));
        break;
      case "startsWith":
        result = String(left).startsWith(String(right));
        break;
      case "endsWith":
        result = String(left).endsWith(String(right));
        break;
      default:
        return { success: false, error: `Unknown operator: ${operator}` };
    }

    return { success: true, result };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Condition evaluation failed",
    };
  }
}

/**
 * Resolve an operand value with type conversion
 * @param {string} operand - Operand value or variable reference
 * @param {string} dataType - Expected data type
 * @param {Object} variables - Available variables
 * @returns {*} Resolved and converted value
 */
function resolveOperand(operand, dataType, variables) {
  let value = operand;

  // Check if it's a variable reference
  if (operand.startsWith("{{") && operand.endsWith("}}")) {
    const varPath = operand.slice(2, -2).trim();
    value = resolveVariable(varPath, variables);
  }

  // Convert to appropriate type
  switch (dataType) {
    case "number":
      return Number(value);
    case "boolean":
      if (typeof value === "string") {
        return value.toLowerCase() === "true";
      }
      return Boolean(value);
    case "string":
    default:
      return String(value);
  }
}

/**
 * Get all available expression functions grouped by category
 * Useful for UI autocomplete and documentation
 * @returns {Object} Functions grouped by category with examples
 */
export function getAvailableFunctions() {
  return {
    string: [
      {
        name: "substring",
        syntax: "substring(str, start, length?)",
        example: 'substring("hello", 0, 3)',
        result: '"hel"',
      },
      {
        name: "toUpperCase",
        syntax: "toUpperCase(str)",
        example: 'toUpperCase("hello")',
        result: '"HELLO"',
      },
      {
        name: "toLowerCase",
        syntax: "toLowerCase(str)",
        example: 'toLowerCase("HELLO")',
        result: '"hello"',
      },
      {
        name: "trim",
        syntax: "trim(str)",
        example: 'trim(" hello ")',
        result: '"hello"',
      },
      {
        name: "replace",
        syntax: "replace(str, find, replace)",
        example: 'replace("hello", "l", "L")',
        result: '"heLlo"',
      },
      {
        name: "concat",
        syntax: "concat(str1, str2, ...)",
        example: 'concat("Hello", " ", "World")',
        result: '"Hello World"',
      },
      {
        name: "length",
        syntax: "length(str)",
        example: 'length("hello")',
        result: "5",
      },
      {
        name: "indexOf",
        syntax: "indexOf(str, search)",
        example: 'indexOf("hello", "l")',
        result: "2",
      },
      {
        name: "startsWith",
        syntax: "startsWith(str, search)",
        example: 'startsWith("hello", "he")',
        result: "true",
      },
      {
        name: "endsWith",
        syntax: "endsWith(str, search)",
        example: 'endsWith("hello", "lo")',
        result: "true",
      },
      {
        name: "contains",
        syntax: "contains(str, search)",
        example: 'contains("hello", "ell")',
        result: "true",
      },
    ],
    numeric: [
      {
        name: "round",
        syntax: "round(num)",
        example: "round(3.7)",
        result: "4",
      },
      { name: "abs", syntax: "abs(num)", example: "abs(-5)", result: "5" },
      {
        name: "min",
        syntax: "min(num1, num2, ...)",
        example: "min(5, 3, 8)",
        result: "3",
      },
      {
        name: "max",
        syntax: "max(num1, num2, ...)",
        example: "max(5, 3, 8)",
        result: "8",
      },
      {
        name: "floor",
        syntax: "floor(num)",
        example: "floor(3.7)",
        result: "3",
      },
      { name: "ceil", syntax: "ceil(num)", example: "ceil(3.2)", result: "4" },
    ],
    array: [
      {
        name: "arrayLength",
        syntax: "arrayLength(arr)",
        example: "arrayLength({{payload.tags}})",
        result: "2",
        description: "Get the length of an array",
      },
      {
        name: "first",
        syntax: "first(arr)",
        example: "first({{payload.tags}})",
        result: '"tag-01"',
        description: "Get the first element",
      },
      {
        name: "last",
        syntax: "last(arr)",
        example: "last({{payload.tags}})",
        result: '"tag-02"',
        description: "Get the last element",
      },
      {
        name: "at",
        syntax: "at(arr, index)",
        example: "at({{payload.tags}}, 1)",
        result: '"tag-02"',
        description: "Get element at specific index",
      },
      {
        name: "find",
        syntax: "find(arr, key, value)",
        example: 'find({{payload.custom_headers}}, "name", "Diversion")',
        result: '{name: "Diversion", value: "..."}',
        description: "Find object in array by property value",
      },
      {
        name: "findValue",
        syntax: "findValue(arr, key, searchValue, returnKey)",
        example:
          'findValue({{payload.sip_headers}}, "name", "Diversion", "value")',
        result: '"<sip:111@192.168.1.1>"',
        description: "Find object and return specific property value",
      },
      {
        name: "filter",
        syntax: "filter(arr, key, value)",
        example: 'filter({{payload.custom_headers}}, "name", "head_1")',
        result: '[{name: "head_1", value: "val_1"}]',
        description: "Filter array by property value",
      },
      {
        name: "map",
        syntax: "map(arr, key)",
        example: 'map({{payload.custom_headers}}, "value")',
        result: '["val_1", "val_2"]',
        description: "Extract property from all objects in array",
      },
      {
        name: "includes",
        syntax: "includes(arr, value)",
        example: 'includes({{payload.tags}}, "tag-01")',
        result: "true",
        description: "Check if array contains a value",
      },
      {
        name: "some",
        syntax: "some(arr, key, value)",
        example: 'some({{payload.custom_headers}}, "name", "head_1")',
        result: "true",
        description: "Check if any element matches condition",
      },
      {
        name: "every",
        syntax: "every(arr, key, value)",
        example: 'every({{payload.custom_headers}}, "name", "head_1")',
        result: "false",
        description: "Check if all elements match condition",
      },
      {
        name: "join",
        syntax: "join(arr, separator?)",
        example: 'join({{payload.tags}}, ", ")',
        result: '"tag-01, tag-02"',
        description: "Join array elements into string",
      },
      {
        name: "slice",
        syntax: "slice(arr, start, end?)",
        example: "slice({{payload.tags}}, 0, 1)",
        result: '["tag-01"]',
        description: "Extract portion of array",
      },
      {
        name: "reverse",
        syntax: "reverse(arr)",
        example: "reverse({{payload.tags}})",
        result: '["tag-02", "tag-01"]',
        description: "Reverse array order",
      },
      {
        name: "sort",
        syntax: "sort(arr)",
        example: "sort({{payload.tags}})",
        result: '["tag-01", "tag-02"]',
        description: "Sort array elements",
      },
      {
        name: "unique",
        syntax: "unique(arr)",
        example: 'unique(["a", "b", "a"])',
        result: '["a", "b"]',
        description: "Remove duplicates from array",
      },
    ],
    arrayIndexing: [
      {
        name: "Array Index Access",
        syntax: "{{array[index]}}",
        example: "{{payload.tags[0]}}",
        result: '"tag-01"',
        description: "Access array element by index directly",
      },
      {
        name: "Array Index with Property",
        syntax: "{{array[index].property}}",
        example: "{{payload.custom_headers[0].value}}",
        result: '"val_1"',
        description: "Access property of array element",
      },
      {
        name: "Nested Array Access",
        syntax: "{{payload.array[0]}}",
        example: "{{payload.sip_headers[1].name}}",
        result: '"Diversion"',
        description: "Access nested array elements",
      },
    ],
    dateTime: [
      {
        name: "now",
        syntax: "now()",
        example: "now()",
        result: '"2025-01-13T..."',
      },
      {
        name: "formatDate",
        syntax: "formatDate(date, format)",
        example: "formatDate(now())",
        result: '"2025-01-13T..."',
      },
      {
        name: "addMinutes",
        syntax: "addMinutes(date, minutes)",
        example: "addMinutes(now(), 30)",
        result: '"..."',
      },
      {
        name: "diffMinutes",
        syntax: "diffMinutes(date1, date2)",
        example: "diffMinutes(now(), {{start_time}})",
        result: "45",
      },
    ],
    logic: [
      {
        name: "ifThen",
        syntax: "ifThen(condition, trueValue, falseValue)",
        example: 'ifThen({{count}} > 5, "high", "low")',
        result: '"high"',
      },
      {
        name: "isEmpty",
        syntax: "isEmpty(value)",
        example: 'isEmpty("")',
        result: "true",
      },
      {
        name: "isNull",
        syntax: "isNull(value)",
        example: "isNull(null)",
        result: "true",
      },
    ],
    conversion: [
      {
        name: "toString",
        syntax: "toString(value)",
        example: "toString(123)",
        result: '"123"',
      },
      {
        name: "toNumber",
        syntax: "toNumber(value)",
        example: 'toNumber("123")',
        result: "123",
      },
      {
        name: "toBoolean",
        syntax: "toBoolean(value)",
        example: 'toBoolean("true")',
        result: "true",
      },
    ],
  };
}
