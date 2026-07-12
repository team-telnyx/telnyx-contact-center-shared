"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { VariableInput } from "@/components/voice-flow/VariableInput";
import { VariableTextarea } from "@/components/voice-flow/VariableTextarea";
import { Switch } from "@/components/ui/switch";
import AIModels from "@/components/assistants/AIModels";
import TagsSection from "@/components/assistants/TagsSection";
import { Combobox } from "@/components/ui/combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const MODEL_GENERATED_GREETING_VALUE = "<assistant-speaks-first-with-model-generated-message>";

function deriveGreetingMode(greeting, explicitMode) {
  if (explicitMode) return explicitMode;
  if (greeting === MODEL_GENERATED_GREETING_VALUE) return "model_generated";
  if (greeting === "") return "wait_for_user";
  return "custom";
}

export default function AgentSettingsPanel({ assistantId, values, setValues, models }) {
  const recommendedModels = useMemo(
    () => (Array.isArray(models) ? models : []).filter((model) => model.recommended_for_assistants),
    [models]
  );
  const selectedModel = useMemo(
    () => (models || []).find((model) => String(model.id) === String(values.model)) || null,
    [models, values.model]
  );
  const assistantVariableNames = useMemo(() => {
    const systemVariables = [
      "telnyx_current_time",
      "telnyx_conversation_channel",
      "telnyx_agent_target",
      "telnyx_end_user_target",
      "telnyx_shaken_stir_attestation",
      "call_control_id",
    ];
    return [...new Set([...systemVariables, ...Object.keys(values.dynamic_variables || {}).filter(Boolean)])];
  }, [values.dynamic_variables]);
  const ownedBy = selectedModel?.raw?.owned_by;
  const requiresSecret = ownedBy ? String(ownedBy).toLowerCase() !== "telnyx" : false;
  const greetingMode = deriveGreetingMode(values.greeting, values.greeting_mode);

  function handleGreetingModeChange(mode) {
    setValues((current) => {
      const currentGreeting = current.greeting || "";
      const customDraft = currentGreeting && currentGreeting !== MODEL_GENERATED_GREETING_VALUE
        ? currentGreeting
        : current.greeting_custom_draft || "";
      if (mode === "model_generated") return { ...current, greeting_mode: mode, greeting_custom_draft: customDraft, greeting: MODEL_GENERATED_GREETING_VALUE };
      if (mode === "wait_for_user") return { ...current, greeting_mode: mode, greeting_custom_draft: customDraft, greeting: "" };
      return { ...current, greeting_mode: "custom", greeting: customDraft };
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden rounded-xl border bg-card p-5 shadow-sm">
      <div className="shrink-0">
        <label className="text-xs">Name <span className="text-red-500">*</span></label>
        <Input value={values.name || ""} onChange={(event) => setValues((current) => ({ ...current, name: event.target.value }))} required />
      </div>

      <div className="grid shrink-0 grid-cols-1 items-end gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div>
          <label className="text-xs">Model <span className="text-red-500">*</span></label>
          <AIModels
            value={values.model || ""}
            onValueChange={(value) => setValues((current) => ({ ...current, model: value }))}
            models={recommendedModels}
            triggerClassName="mt-1 border bg-background"
          />
        </div>
        <div className="flex h-10 items-center gap-2 whitespace-nowrap">
          <Switch
            checked={values.fallback_enabled || false}
            onCheckedChange={(checked) => setValues((current) => ({
              ...current,
              fallback_enabled: checked,
              fallback_model: checked ? current.fallback_model : "",
              fallback_llm_api_key_ref: checked ? current.fallback_llm_api_key_ref : "",
            }))}
          />
          <label className="text-xs font-medium">Enable fallback model</label>
        </div>
        <div className={values.fallback_enabled ? "" : "pointer-events-none opacity-50"}>
          <label className="text-xs">Fallback Model</label>
          <AIModels
            value={values.fallback_model || ""}
            onValueChange={(value) => setValues((current) => ({ ...current, fallback_model: value }))}
            models={recommendedModels}
            placeholder="Select a fallback model"
            triggerClassName="mt-1 border bg-background"
          />
        </div>
      </div>

      {requiresSecret || values.fallback_enabled ? (
        <div className="grid shrink-0 grid-cols-1 gap-4 md:grid-cols-2">
          {requiresSecret ? (
            <div>
              <label className="text-xs">LLM API Key Reference</label>
              <SecretsCombobox value={values.llm_api_key_ref || ""} onChange={(value) => setValues((current) => ({ ...current, llm_api_key_ref: value }))} />
            </div>
          ) : <div />}
          {values.fallback_enabled ? <FallbackSecretField values={values} models={models} setValues={setValues} /> : null}
        </div>
      ) : null}

      <div className="shrink-0 space-y-2">
        <div>
          <label className="text-xs">Greeting mode</label>
          <Select value={greetingMode} onValueChange={handleGreetingModeChange}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Select how the assistant starts" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="custom">Assistant speaks first with custom greeting</SelectItem>
              <SelectItem value="wait_for_user">Assistant waits for the user to speak first</SelectItem>
              <SelectItem value="model_generated">Assistant speaks first with model-generated message</SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-1 text-[11px] text-muted-foreground">Telnyx maps these to greeting text, an empty greeting, or the special model-generated greeting value.</p>
        </div>
        {greetingMode === "custom" ? (
          <div>
            <label className="text-xs">Greeting <span className="text-red-500">*</span></label>
            <VariableInput
              value={values.greeting || ""}
              onChange={(next) => setValues((current) => ({ ...current, greeting: next, greeting_custom_draft: next }))}
              availableVariables={assistantVariableNames}
              required
            />
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <label className="text-xs">Instructions <span className="text-red-500">*</span></label>
        <VariableTextarea
          rows={8}
          wrapperClassName="min-h-0 flex-1"
          className="h-full min-h-0 resize-none"
          value={values.instructions || ""}
          onChange={(next) => setValues((current) => ({ ...current, instructions: next }))}
          availableVariables={assistantVariableNames}
          required
        />
      </div>
      <TagsSection assistantId={assistantId} initialTags={values.tags || []} />
    </div>
  );
}

function FallbackSecretField({ values, models, setValues }) {
  const model = (models || []).find((item) => String(item.id) === String(values.fallback_model));
  const requiresSecret = model?.raw?.owned_by
    ? String(model.raw.owned_by).toLowerCase() !== "telnyx"
    : false;
  if (!requiresSecret) return null;
  return <div><label className="text-xs">Fallback LLM API Key Reference</label><SecretsCombobox value={values.fallback_llm_api_key_ref || ""} onChange={(value) => setValues((current) => ({ ...current, fallback_llm_api_key_ref: value }))} /></div>;
}

function SecretsCombobox({ value, onChange }) {
  const [options, setOptions] = useState([]);
  useEffect(() => {
    let mounted = true;
    fetch("/api/integration-secrets", { cache: "no-store" })
      .then((response) => response.json().then((data) => ({ response, data })))
      .then(({ response, data }) => {
        if (mounted && response.ok && data?.ok) setOptions((data.secrets || []).map((secret) => ({ value: secret.identifier, label: secret.identifier })));
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);
  return <Combobox value={value} onChange={onChange} options={options} placeholder="Select integration secret…" emptyLabel="No secrets found" triggerClassName="mt-1 w-full" searchable />;
}
