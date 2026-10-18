export function newWorkflowExpression(type = "comparison") {
  if (type === "variable") return { type, name: "" };
  if (type === "string_literal") return { type, value: "" };
  if (type === "number_literal") return { type, value: 0 };
  if (type === "bool_literal") return { type, value: true };
  if (type === "bool_op")
    return {
      type,
      op: "and",
      operands: [newWorkflowExpression(), newWorkflowExpression()],
    };
  if (type === "arithmetic")
    return {
      type,
      op: "+",
      left: newWorkflowExpression("variable"),
      right: newWorkflowExpression("number_literal"),
    };
  return {
    type: "comparison",
    op: "==",
    left: newWorkflowExpression("variable"),
    right: newWorkflowExpression("string_literal"),
  };
}

export function changeWorkflowBooleanOperator(expression, op) {
  const operands = expression.operands || [];
  return {
    ...expression,
    op,
    operands:
      op === "not"
        ? operands.slice(0, 1)
        : operands.length >= 2
          ? operands
          : [...operands, newWorkflowExpression()],
  };
}

export function workflowExpressionIssues(expression) {
  if (!expression || typeof expression !== "object") return ["Complete the condition."];
  if (expression.type === "variable") return String(expression.name || "").trim() ? [] : ["A variable is required."];
  if (expression.type === "number_literal") return Number.isFinite(expression.value) ? [] : ["Enter a valid number."];
  if (expression.type === "string_literal") return typeof expression.value === "string" ? [] : ["Enter a text value."];
  if (expression.type === "bool_literal") return typeof expression.value === "boolean" ? [] : ["Choose yes or no."];
  if (["comparison", "arithmetic"].includes(expression.type)) {
    const operators = expression.type === "comparison" ? ["==", "!=", "<", "<=", ">", ">=", "contains", "not_contains"] : ["+", "-", "*", "/", "%"];
    return [...(operators.includes(expression.op) ? [] : ["Choose a valid operator."]), ...workflowExpressionIssues(expression.left), ...workflowExpressionIssues(expression.right)];
  }
  if (expression.type === "bool_op") {
    const operands = Array.isArray(expression.operands) ? expression.operands : [];
    const validCount = expression.op === "not" ? operands.length === 1 : ["and", "or"].includes(expression.op) && operands.length >= 2;
    return [...(validCount ? [] : ["Complete the condition group."]), ...operands.flatMap(workflowExpressionIssues)];
  }
  return ["Choose a supported condition."];
}
