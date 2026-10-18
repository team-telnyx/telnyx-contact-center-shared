import { sourceText } from "../i18n/source-text.mjs";
import { getWhatsAppTemplateVariableFields } from "../whatsapp-templates.js";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateWhatsAppTemplateVariableCounts(
  configuredTemplates,
  approvedTemplates, tUi = sourceText
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
      return tUi("Template {value0}: variables must be an array of names.", {value0: index + 1});
    }
    if (variables.length !== expectedCount) {
      return tUi("Template {value0}: required number of variable names for the selected template: {value1}.", {value0: index + 1, value1: expectedCount});
    }
    if (variables.some((name) => !String(name || "").trim())) {
      return tUi("Template {value0}: variable names cannot be empty.", {value0: index + 1});
    }
  }

  return "";
}

function validToolName(value) {
  return /^[A-Za-z0-9_-]+$/.test(String(value || ""));
}

export function validateAssistantToolConfiguration(tool, tUi = sourceText) {
  if (!tool || typeof tool !== "object") return tUi("Tool configuration is missing.");

  if (tool.type === "vision" && tool.vision?.max_frame_age_secs !== undefined && (!Number.isFinite(tool.vision.max_frame_age_secs) || tool.vision.max_frame_age_secs < 1)) return tUi("Maximum frame age must be at least 1 second.");
  const timeout = Number(tool.timeout_ms);
  if (
    ["client_side_tool", "whatsapp_template"].includes(tool.type) &&
    tool.timeout_ms !== undefined &&
    tool.timeout_ms !== null &&
    (!Number.isFinite(timeout) || timeout <= 0)
  ) {
    return tUi("Timeout must be greater than 0.");
  }

  if (["function", "update_dynamic_variables", "webhook"].includes(tool.type)) {
    const config = tool[tool.type] || {};
    if (!validToolName(config.name)) return tUi("Enter a name using letters, numbers, underscores or hyphens.");
    if (tool.type === "webhook" && !/^https?:\/\//.test(config.url || "")) return tUi("Enter a valid HTTP or HTTPS webhook address.");
  }
  if (tool.type === "pay") {
    if (!tool.pay?.connector_name?.trim()) return tUi("Enter the name of your Telnyx payment connector.");
    if (!tool.pay?.description?.trim()) return tUi("Describe when the assistant should collect a payment.");
  }
  if (tool.type === "update_dynamic_variables") {
    const config = tool.update_dynamic_variables || {};
    if (!config.description?.trim()) return tUi("Describe when the assistant should update these variables.");
    if (!config.updatable_variables?.length) return tUi("Add at least one variable to update.");
    const names = new Set();
    for (const variable of config.updatable_variables) {
      if (!/^(?!telnyx_)[a-zA-Z0-9._-]+$/.test(variable.name || "")) return tUi("Variable names may contain letters, numbers, dots, underscores and hyphens. Names starting with telnyx_ are reserved.");
      if (names.has(variable.name)) return tUi("Each variable needs a different name.");
      names.add(variable.name);
    }
  }
  if (tool.type === "retrieval") {
    if (!tool.retrieval?.bucket_ids?.length) return tUi("Choose at least one knowledge source.");
    if (!Number.isInteger(tool.retrieval.max_num_results ?? 3) || (tool.retrieval.max_num_results ?? 3) < 1) return tUi("Maximum results must be a whole number greater than zero.");
  }

  if (tool.type === "client_side_tool") {
    const config = tool.client_side_tool;
    if (!isObject(config)) return tUi("Client-side tool configuration is missing.");
    if (!String(config.name || "").trim()) return tUi("Name is required.");
    if (!validToolName(config.name)) {
      return tUi("Name may only contain letters, numbers, underscores, and hyphens.");
    }
    if (!String(config.description || "").trim()) {
      return tUi("Description is required.");
    }

    const parameters = config.parameters;
    if (!isObject(parameters)) {
      return tUi("Parameters must be a JSON object.");
    }
    if (parameters.type !== "object") {
      return tUi("Parameters must include \"type\": \"object\".");
    }
    if (!isObject(parameters.properties)) {
      return tUi("Parameters must include a \"properties\" object.");
    }
    if (!Array.isArray(parameters.required)) {
      return tUi("Parameters must include a \"required\" array.");
    }
  }

  if (tool.type === "whatsapp_template") {
    const templates = tool.whatsapp_template?.templates;
    if (!Array.isArray(templates) || templates.length === 0) {
      return tUi("Add at least one WhatsApp template.");
    }

    for (let index = 0; index < templates.length; index += 1) {
      const template = templates[index] || {};
      const prefix = tUi("Template {value0}", {value0: index + 1});
      if (!String(template.template_id || "").trim()) {
        return tUi("{value0}: select an approved WhatsApp template.", {value0: prefix});
      }
      if (!String(template.name || "").trim()) {
        return tUi("{value0}: name is required.", {value0: prefix});
      }
      if (!validToolName(template.name)) {
        return tUi("{value0}: name may only contain letters, numbers, underscores, and hyphens.", {value0: prefix});
      }
      if (!String(template.description || "").trim()) {
        return tUi("{value0}: description is required.", {value0: prefix});
      }
      if (!Array.isArray(template.variables)) {
        return tUi("{value0}: variables must be an array of names.", {value0: prefix});
      }
    }
  }

  return "";
}
