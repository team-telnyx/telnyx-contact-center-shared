// Quality uses the public Inference API, not the AI Assistant model router.
// Externally hosted assistant models require a separate customer-provided key.
// The evaluation model is the request's or the scorecard's model when one is
// chosen; otherwise the AI Copilot "Quality evaluation" card, then the
// platform default model (no model is defined in code).
export function resolveEvaluationModel(model, config = {}) {
  const selected = model || config?.model || null;
  if (selected === null) return null;
  if (typeof selected !== "string" || !selected.trim()) {
    const error = new Error("Choose a valid evaluation model.");
    error.status = 400;
    throw error;
  }
  return selected.trim();
}

export function isQualityInferenceModel(model) {
  const task = String(model?.task || "").toLowerCase().replaceAll(" ", "-");
  return model?.owned_by?.toLowerCase() === "telnyx"
    && ["text-generation", "text-to-text"].includes(task) && Boolean(model?.id);
}
