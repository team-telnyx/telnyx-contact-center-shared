import { getWhatsAppTemplateVariableFields } from "../whatsapp-templates.js";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateWhatsAppTemplateVariableCounts(
  configuredTemplates,
  approvedTemplates
) {
  if (
    !Array.isArray(configuredTemplates) ||
    !Array.isArray(approvedTemplates) ||
    approvedTemplates.length === 0
  ) {
    return "";
  }

  const templatesById = new Map(
    approvedTemplates
      .filter((template) => template?.id)
      .map((template) => [String(template.id), template])
  );

  for (let index = 0; index < configuredTemplates.length; index += 1) {
    const configured = configuredTemplates[index] || {};
    const approved = templatesById.get(String(configured.template_id || ""));
    if (!approved) continue;

    const expectedCount = getWhatsAppTemplateVariableFields(approved).length;
    const variables = configured.variables;
    if (!Array.isArray(variables)) {
      return `Template ${index + 1}: variables must be an array of names.`;
    }
    if (variables.length !== expectedCount) {
      return `Template ${index + 1}: enter exactly ${expectedCount} variable name${
        expectedCount === 1 ? "" : "s"
      } for the selected template.`;
    }
    if (variables.some((name) => !String(name || "").trim())) {
      return `Template ${index + 1}: variable names cannot be empty.`;
    }
  }

  return "";
}

function validToolName(value) {
  return /^[A-Za-z0-9_-]+$/.test(String(value || ""));
}

export function validateAssistantToolConfiguration(tool) {
  if (!tool || typeof tool !== "object") return "Tool configuration is missing.";

  const timeout = Number(tool.timeout_ms);
  if (
    ["client_side_tool", "whatsapp_template"].includes(tool.type) &&
    tool.timeout_ms !== undefined &&
    tool.timeout_ms !== null &&
    (!Number.isFinite(timeout) || timeout <= 0)
  ) {
    return "Timeout must be greater than 0.";
  }

  if (tool.type === "client_side_tool") {
    const config = tool.client_side_tool;
    if (!isObject(config)) return "Client-side tool configuration is missing.";
    if (!String(config.name || "").trim()) return "Name is required.";
    if (!validToolName(config.name)) {
      return "Name may only contain letters, numbers, underscores, and hyphens.";
    }
    if (!String(config.description || "").trim()) {
      return "Description is required.";
    }

    const parameters = config.parameters;
    if (!isObject(parameters)) {
      return "Parameters must be a JSON object.";
    }
    if (parameters.type !== "object") {
      return 'Parameters must include "type": "object".';
    }
    if (!isObject(parameters.properties)) {
      return 'Parameters must include a "properties" object.';
    }
    if (!Array.isArray(parameters.required)) {
      return 'Parameters must include a "required" array.';
    }
  }

  if (tool.type === "whatsapp_template") {
    const templates = tool.whatsapp_template?.templates;
    if (!Array.isArray(templates) || templates.length === 0) {
      return "Add at least one WhatsApp template.";
    }

    for (let index = 0; index < templates.length; index += 1) {
      const template = templates[index] || {};
      const prefix = `Template ${index + 1}`;
      if (!String(template.template_id || "").trim()) {
        return `${prefix}: select an approved WhatsApp template.`;
      }
      if (!String(template.name || "").trim()) {
        return `${prefix}: name is required.`;
      }
      if (!validToolName(template.name)) {
        return `${prefix}: name may only contain letters, numbers, underscores, and hyphens.`;
      }
      if (!String(template.description || "").trim()) {
        return `${prefix}: description is required.`;
      }
      if (!Array.isArray(template.variables)) {
        return `${prefix}: variables must be an array of names.`;
      }
    }
  }

  return "";
}
