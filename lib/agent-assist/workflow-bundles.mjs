const ASSISTANT_SETTING_KEYS = [
  "ai_assistant_id",
  "aiAssistantId",
  "llm_model",
  "llmModel",
  "llm_confidence_threshold",
  "llmConfidenceThreshold",
  "insight_group_id",
  "insightGroupId",
  "insight_slots_id",
  "insightSlotsId",
  "insight_summary_id",
  "insightSummaryId",
  "insight_sentiment_id",
  "insightSentimentId",
];

const WORKFLOW_BUNDLE_TYPE = "telnyx-contact-center-agent-assist-workflow";
const WORKFLOW_BUNDLE_VERSION = "1.0";
const MAX_STAGES = 100;
const MAX_ITEMS_PER_STAGE = 500;
const COMPLETION_TRIGGERS = new Set(["agent", "customer", "either"]);
const ITEM_TYPES = new Set(["action", "question", "topic", "slot"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nullIfEmpty(value) {
  if (value === undefined || value === null) return null;
  const stringValue = String(value).trim();
  return stringValue ? stringValue : null;
}

function sanitizeItem(item = {}, index = 0) {
  const completionTrigger = COMPLETION_TRIGGERS.has(item.completion_trigger)
    ? item.completion_trigger
    : (item.type === "slot" ? "customer" : "agent");

  return {
    type: item.type || "action",
    label: item.label || "Untitled item",
    description: item.description || null,
    prompt_hint: item.prompt_hint || null,
    hints: asArray(item.hints),
    order_index: Number.isInteger(item.order_index) ? item.order_index : index,
    is_required: item.is_required ?? true,
    slot_name: nullIfEmpty(item.slot_name),
    slot_type: nullIfEmpty(item.slot_type),
    slot_options: item.slot_options ?? null,
    slot_validation: nullIfEmpty(item.slot_validation),
    completion_trigger: completionTrigger,
  };
}

function sanitizeStage(stage = {}, index = 0) {
  return {
    name: stage.name || "Untitled stage",
    description: stage.description || null,
    order_index: Number.isInteger(stage.order_index) ? stage.order_index : index,
    is_required: stage.is_required ?? true,
    items: asArray(stage.items).map((item, itemIndex) => sanitizeItem(item, itemIndex)),
  };
}

function containsAssistantSettings(input = {}) {
  return ASSISTANT_SETTING_KEYS.some((key) => Object.prototype.hasOwnProperty.call(input, key));
}

export function buildWorkflowExportBundle(workflow = {}, options = {}) {
  return {
    version: WORKFLOW_BUNDLE_VERSION,
    type: WORKFLOW_BUNDLE_TYPE,
    name: workflow.name || "Agent Assist workflow",
    description: workflow.description || "",
    category: workflow.category || null,
    is_active: Boolean(workflow.is_active ?? true),
    stages: asArray(workflow.stages).map((stage, index) => sanitizeStage(stage, index)),
    exported_at: options.exportedAt || new Date().toISOString(),
  };
}

export function normalizeImportedWorkflowBundle(input = {}) {
  if (!input || typeof input !== "object") throw new Error("Invalid workflow format: expected JSON object");
  if (input.version !== WORKFLOW_BUNDLE_VERSION) throw new Error(`Invalid workflow format: unsupported version ${input.version || "missing"}`);
  if (input.type && input.type !== WORKFLOW_BUNDLE_TYPE) throw new Error("Invalid workflow format: unsupported workflow bundle type");
  if (containsAssistantSettings(input)) {
    throw new Error("Invalid workflow import: assistant settings are not portable and must not be included");
  }
  if (!input.name || !String(input.name).trim()) throw new Error("Invalid workflow format: missing name");
  if (!Array.isArray(input.stages)) throw new Error("Invalid workflow format: stages must be an array");
  if (input.stages.length > MAX_STAGES) throw new Error(`Invalid workflow format: stages cannot exceed ${MAX_STAGES}`);

  const stages = input.stages.map((stage, stageIndex) => {
    if (!stage || typeof stage !== "object") throw new Error("Invalid workflow format: each stage must be an object");
    if (containsAssistantSettings(stage)) throw new Error("Invalid workflow import: assistant settings are not portable and must not be included");
    if (stage.items !== undefined && !Array.isArray(stage.items)) throw new Error("Invalid workflow format: stage items must be an array");
    if (asArray(stage.items).length > MAX_ITEMS_PER_STAGE) throw new Error(`Invalid workflow format: stage items cannot exceed ${MAX_ITEMS_PER_STAGE}`);
    for (const item of asArray(stage.items)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid workflow format: each item must be an object");
      if (containsAssistantSettings(item)) throw new Error("Invalid workflow import: assistant settings are not portable and must not be included");
      if (item.type !== undefined && !ITEM_TYPES.has(item.type)) {
        throw new Error("Invalid workflow format: item type must be one of action, question, topic, slot");
      }
      if (item.completion_trigger !== undefined && !COMPLETION_TRIGGERS.has(item.completion_trigger)) {
        throw new Error("Invalid workflow format: completion_trigger must be one of agent, customer, either");
      }
    }
    return sanitizeStage(stage, stageIndex);
  });

  return {
    name: String(input.name).trim(),
    description: input.description || "",
    category: input.category || null,
    // Imported workflows start inactive so admins can inspect them before using them live.
    is_active: false,
    stages,
    metadata: {
      imported_from_bundle: true,
      original_exported_at: input.exported_at || null,
    },
  };
}

export function workflowExportFilename(name = "") {
  const safeName = String(name || "")
    .replace(/[^a-z0-9]/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  return `${safeName || "agent_assist"}_workflow.json`;
}
