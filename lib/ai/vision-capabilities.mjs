// Image input is a capability of the entire provider configuration, including fallback.
export const RECOMMENDED_VISION_MODEL = "moonshotai/Kimi-K2.6";
export function modelVisionCapability(config, models = [], { buffered = false } = {}) {
  const model = config?.model || "";
  const result = (status, reason) => ({ status, model, reason, recommended: model === RECOMMENDED_VISION_MODEL });
  if (buffered && /^openai\/gpt-live/.test(model)) return result("unsupported", "GPT-Live does not support buffered Vision.");
  if (config?.external_llm) return result("unknown", "Image input through this external endpoint has not been verified.");
  const entry = models.find(item => item.id === model);
  const supported = entry?.is_vision_supported ?? entry?.raw?.is_vision_supported;
  if (model === "moonshotai/Kimi-K2.5") return result("unavailable", "Kimi-K2.5 image requests failed live validation. Use Kimi-K2.6.");
  if (supported !== true) return result(supported === false ? "unsupported" : "unknown", supported === false ? "This model does not support images through Telnyx." : "Image support could not be verified for this model.");
  if ((entry.recommended_for_assistants ?? entry.raw?.recommended_for_assistants) !== true) return result("unknown", "This image model is not recommended for AI Assistants by Telnyx.");
  return result("supported", model === RECOMMENDED_VISION_MODEL ? "Vision supported · Kimi-K2.6 recommended" : "Vision supported");
}
export function assistantVisionCapability(assistant, models, options) {
  const primary = modelVisionCapability(assistant, models, options);
  if (primary.status !== "supported") return primary;
  if (assistant?.fallback_config?.model || assistant?.fallback_config?.external_llm) {
    const fallback = modelVisionCapability(assistant.fallback_config, models, options);
    if (fallback.status !== "supported") return { ...fallback, reason: `Fallback: ${fallback.reason}` };
  }
  for (const node of assistant?.conversation_flow?.nodes || []) {
    if (node.type && node.type !== "prompt") continue;
    // Any LLM identity override replaces the entire bundle. Do not inherit
    // the assistant's supported model when a node supplies only credentials.
    if (!node.model && !node.external_llm && !node.llm_api_key_ref) continue;
    const capability = modelVisionCapability(node, models, options);
    if (capability.status !== "supported") {
      return { ...capability, reason: `Workflow node ${node.name || node.id}: ${capability.reason}` };
    }
  }
  // A transition replaces the active assistant, whose model may change
  // independently. Until the entire target graph is verified, fail closed
  // instead of claiming image support based only on the source assistant.
  if (assistant?.conversation_flow?.edges?.some(edge => edge.target?.type === "assistant" && edge.target.assistant_id !== assistant.id)) {
    return { ...primary, status: "unknown", reason: "Vision across workflow assistant transitions has not been verified. Use a single assistant for image input." };
  }
  return primary;
}
export function assertVisionCapability(assistant, models, options) {
  const capability = assistantVisionCapability(assistant, models, options);
  if (capability.status !== "supported") throw Object.assign(new Error(`${capability.reason} Recommended model: ${RECOMMENDED_VISION_MODEL}.`), { status: 400, ambiguous: false });
  return capability;
}
