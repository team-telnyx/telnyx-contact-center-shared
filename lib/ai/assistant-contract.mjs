import Ajv from "ajv";
import { validateConversationFlow } from "./assistant-conversation-workflow.mjs";
import { modelConfigurationErrors } from "./assistant-draft.mjs";
import { validateAdditionalTranscription } from "./assistant-transcription-ui.mjs";
import sourceContract from "./assistant-contract.json" with { type: "json" };
const contract = structuredClone(sourceContract);
export const assistantSchemas = contract.components.schemas;
// Documented Vision extension (2026-10-18); retain the pinned source contract.
assistantSchemas.VisionTool = {type:"object",required:["type"],properties:{type:{type:"string",enum:["vision"]},vision:{type:"object",properties:{max_frame_age_secs:{type:"number",minimum:1,default:10}},additionalProperties:false}}};
assistantSchemas.AssistantTools.items.oneOf.push({$ref:"#/components/schemas/VisionTool"});
// Live API requires this field although it is absent from the published
// 2026-10-14 request schema. Keep the immutable source contract unchanged.
const editorExtensions = {
  PayToolParams: {
    properties: {
      ...assistantSchemas.PayToolParams.properties,
      description: {
        type: "string",
        minLength: 1,
        description:
          "Describe when the assistant should collect a payment. Required by the live API.",
      },
    },
    required: [...assistantSchemas.PayToolParams.required, "description"],
  },
};
export function resolveAssistantSchema(schema) {
  if (schema?.$ref)
    return {
      ...assistantSchemas[schema.$ref.split("/").at(-1)],
      ...editorExtensions[schema.$ref.split("/").at(-1)],
      ...Object.fromEntries(
        Object.entries(schema).filter(([k]) => k !== "$ref"),
      ),
    };
  if (schema?.allOf)
    return schema.allOf.reduce(
      (acc, s) => {
        const next = resolveAssistantSchema(s);
        return {
          ...acc,
          ...next,
          properties: { ...acc.properties, ...next.properties },
          required: [
            ...new Set([...(acc.required || []), ...(next.required || [])]),
          ],
        };
      },
      { ...schema, allOf: undefined },
    );
  return schema || {};
}
const ajv = new Ajv({
  allErrors: true,
  // Decimal steps such as 0.7 / 0.1 are not exact in binary floating point.
  multipleOfPrecision: 8,
  unknownFormats: "ignore",
  schemaId: "auto",
  logger: false,
});
const validations = new Map();
export function validateAssistantField(name, value) {
  if (value === undefined) return [];
  // Canonical null expresses removal; the server applies verified wire encodings.
  if (
    value === null &&
    [
      "external_llm",
      "fallback_config",
      "avatar_settings",
      "conversation_flow",
    ].includes(name)
  )
    return [];
  let validate = validations.get(name);
  if (!validate) {
    const schema = resolveAssistantSchema(
      assistantSchemas.UpdateAssistantRequestWithPromotion,
    ).properties?.[name];
    if (!schema) return [`Unknown assistant field: ${name}`];
    validate = ajv.compile({ ...schema, components: contract.components });
    validations.set(name, validate);
  }
  return validate(value)
    ? []
    : (validate.errors || []).map(
        (e) =>
          `${name}${e.dataPath || ""}: ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ""}`,
      );
}
export function validateAssistantChanges(payload) {
  return Object.entries(payload).flatMap(([name, value]) =>
    validateAssistantField(name, value),
  );
}
/**
 * One branch per type of a multi-type schema, each carrying the parent's keywords. The parent's
 * default stays only on the branch it belongs to: a null default copied onto the string or array
 * branch would make that branch start as null and the form snap back to the null variant.
 */
export function schemaTypeBranches(schema) {
  const { default: fallback, ...rest } = schema;
  return schema.type.map((type) => {
    const keeps = fallback !== undefined && (type === "null" ? fallback === null : fallback !== null);
    return { ...rest, type, ...(keeps ? { default: fallback } : {}) };
  });
}
export function initialSchemaValue(raw) {
  const s = resolveAssistantSchema(raw);
  if (s.default !== undefined) return structuredClone(s.default);
  if (s.const !== undefined) return s.const;
  if (s.enum) return s.enum[0];
  if (s.type === "null") return null;
  if (s.anyOf || s.oneOf)
    return initialSchemaValue(
      (s.anyOf || s.oneOf).find((v) => v.type !== "null"),
    );
  if (s.type === "object" || s.properties)
    return Object.fromEntries(
      (s.required || []).map((k) => [k, initialSchemaValue(s.properties[k])]),
    );
  if (s.type === "array") return [];
  if (s.type === "boolean") return false;
  if (["integer", "number"].includes(s.type)) return s.minimum ?? 0;
  return "";
}

export function validateAssistantValue(schema, value, name = "value") {
  if (value === undefined) return [];
  const key = JSON.stringify(schema);
  let validate = validations.get(key);
  if (!validate) {
    validate = ajv.compile({ ...schema, components: contract.components });
    validations.set(key, validate);
  }
  return validate(value)
    ? []
    : (validate.errors || []).map(
        (e) => `${name}${e.dataPath || ""}: ${e.message}`,
      );
}

// Validate edited fields against the pinned request schema. Unchanged null values
// returned by Telnyx are omitted from validation (the read and write schemas differ).
export function validateAssistantDraftChanges(payload, original = {}) {
  const errors = [];
  if (payload.transcription) errors.push(...validateAdditionalTranscription({...original.transcription,...payload.transcription}));
  if (payload.conversation_flow) errors.push(...validateConversationFlow(payload.conversation_flow, {allowInheritedInstructions: true}));
  for (const [name, value] of Object.entries(payload)) {
    if (["promote_to_main", "version_name"].includes(name)) continue;
    if (
      value === null &&
      [
        "external_llm",
        "fallback_config",
        "avatar_settings",
        "conversation_flow",
      ].includes(name)
    )
      continue;
    const schema = assistantSchemas.UpdateAssistantRequest.properties[name];
    if (!schema) {
      errors.push(`Unknown assistant field: ${name}`);
      continue;
    }
    errors.push(
      ...validateAssistantValue(
        schema,
        assistantValidationValue(value, original[name], schema),
        name,
      ),
    );
  }
  if (payload.tags?.some((tag) => tag.length > 20))
    errors.push("tags: each tag must be at most 20 characters.");
  if (
    payload.transcription?.fallback_models?.length &&
    payload.transcription?.challenger
  )
    errors.push(
      "transcription: fallback models and challenger cannot be combined.",
    );
  const merged = { ...original, ...payload };
  if ("external_llm" in payload || "model" in payload || "llm_api_key_ref" in payload)
    errors.push(...modelConfigurationErrors(merged));
  for (const key of ["fallback_config", "delegation_settings"])
    if (payload[key]) errors.push(...modelConfigurationErrors(payload[key], key));
  for (const node of payload.conversation_flow?.nodes || [])
    errors.push(...modelConfigurationErrors(node, `conversation_flow.${node.id}`));
  if (
    ("delegation_settings" in payload || "websocket_settings" in payload) &&
    merged.delegation_settings?.enabled === true &&
    merged.delegation_settings?.mode === "client" &&
    (merged.websocket_settings?.enabled !== true ||
      !/^wss?:\/\//.test(merged.websocket_settings?.url || ""))
  )
    errors.push(
      "delegation_settings: client delegation requires an enabled WebSocket connection.",
    );
  const tools = [
    ...(merged.tools || []),
    ...(merged.conversation_flow?.nodes || []).flatMap(
      (node) => node.tools || [],
    ),
  ];
  if (
    (payload.tools ||
      payload.conversation_flow ||
      payload.telephony_settings) &&
    tools.some((tool) => tool.type === "pay") &&
    merged.telephony_settings?.disable_dtmf !== true
  )
    errors.push(
      "telephony_settings.disable_dtmf: enable before configuring a Pay tool.",
    );
  if (
    payload.delegation_settings?.enabled === true &&
    (payload.delegation_settings.mode || "telnyx") === "telnyx" &&
    !payload.delegation_settings.model &&
    !payload.delegation_settings.external_llm?.model
  )
    errors.push("delegation_settings: select a backend model.");
  if (
    payload.websocket_settings?.enabled === true &&
    !/^wss?:\/\//.test(payload.websocket_settings.url || "")
  )
    errors.push("websocket_settings.url: enter a WebSocket endpoint.");
  for (const tool of payload.tools || []) {
    if (tool.type === "pay" && !tool.pay?.description?.trim())
      errors.push(
        "tools.pay.description: a payment tool description is required by the live API.",
      );
    if (
      tool.transfer?.warm_transfer_acceptance?.enabled &&
      !tool.transfer.warm_transfer_instructions &&
      !(
        Array.isArray(tool.transfer.targets) &&
        tool.transfer.targets.every((target) => target.message)
      )
    )
      errors.push(
        "tools.transfer: warm acceptance requires transfer instructions or a message on every target.",
      );
  }
  return errors;
}

export function assistantValidationValue(current, previous, raw) {
  const schema = resolveAssistantSchema(raw);
  if (Array.isArray(current))
    return current.map((value, index) =>
      assistantValidationValue(value, previous?.[index], schema.items || {}),
    );
  if (current && typeof current === "object")
    return Object.fromEntries(
      Object.entries(current)
        .filter(
          ([key, value]) =>
            !(
              value === null &&
              (previous?.[key] === null ||
                (key === "external_llm" && schema.properties?.[key])) &&
              !schema.required?.includes(key)
            ),
        )
        .map(([key, value]) => [
          key,
          assistantValidationValue(
            value,
            previous?.[key],
            schema.properties?.[key] || {},
          ),
        ]),
    );
  return current;
}
