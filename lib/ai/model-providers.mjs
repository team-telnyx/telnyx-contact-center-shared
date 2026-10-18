export const FASTROUTER_BASE_URL = "https://api.fastrouter.ai/api/v1";
export const LLM_PROVIDERS = [
  { value: "telnyx", label: "Telnyx" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
  { value: "openai", label: "OpenAI" },
  { value: "fastrouter", label: "FastRouter" },
  { value: "custom", label: "Custom OpenAI-compatible endpoint" },
];
export const modelOwner = (model) =>
  String(model?.raw?.owned_by || model?.owned_by || "").toLowerCase();

export function integrationSecretOptions(secrets, type = "bearer") {
  return secrets
    .filter(secret => !type || secret.type === type)
    .map(secret => ({value: secret.identifier, label: `${secret.identifier} (${secret.type})`}));
}

export function switchExternalAuthentication(external, authentication_method) {
  return {
    ...external,
    authentication_method,
    ...(authentication_method === "certificate"
      ? {llm_api_key_ref: ""}
      : {certificate_ref: "", token_retrieval_url: ""}),
  };
}
export function modelProvider(config, models = []) {
  if (config?.external_llm)
    return String(config.external_llm.base_url).replace(/\/$/, "") ===
      FASTROUTER_BASE_URL
      ? "fastrouter"
      : "custom";
  return (
    modelOwner(models.find((m) => m.id === config?.model)) ||
    (config?.model ? "unlisted" : "telnyx")
  );
}
export function assistantCatalogModels(models) {
  return (Array.isArray(models) ? models : []).filter(model => model.recommended_for_assistants === true);
}
export function usesManualAssistantModelEntry(provider, mode, eligibleCount) {
  return provider === "custom" || (provider === "fastrouter" && (mode === "virtual" || eligibleCount === 0));
}

export function providerOptions(models) {
  const result = [...LLM_PROVIDERS];
  for (const m of models || []) {
    const owner = modelOwner(m);
    if (owner && !result.some((p) => p.value === owner))
      result.push({ value: owner, label: owner });
  }
  return result;
}
export function normalizeFastRouterCatalog(data) {
  return (Array.isArray(data?.data) ? data.data : [])
    .filter((m) => {
      if (!m?.id || m.is_active === false) return false;
      const input = m.architecture?.input_modalities,
        output = m.architecture?.output_modalities;
      if (Array.isArray(output) && !output.includes("text")) return false;
      if (Array.isArray(input) && !input.includes("text")) return false;
      const modality = String(m.architecture?.modality || "");
      if (modality && !modality.split("->").at(-1).includes("text"))
        return false;
      if (/embedding|rerank/i.test(String(m.task || m.type || "")))
        return false;
      return true;
    })
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      recommended_for_assistants: m.recommended_for_assistants === true,
      raw: { ...m, owned_by: "fastrouter" },
      capabilities: {
        tools:
          Array.isArray(m.supported_parameters) && m.supported_parameters.length
            ? m.supported_parameters.includes("tools")
            : null,
      },
    }));
}
