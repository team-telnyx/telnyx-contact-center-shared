"use client";
import { useUiText } from "@/components/i18n/use-ui-text";

import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import AssistantConfigurationCard from "./AssistantConfigurationCard";
import { VariableTextarea } from "@/components/voice-flow/VariableTextarea";
import { Switch } from "@/components/ui/switch";
import TagsSection from "./TagsSection";
import AssistantModelConfiguration from "./AssistantModelConfiguration";
import AssistantSectionTabs from "./AssistantSectionTabs";
import AssistantDelegationSettings from "./AssistantDelegationSettings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MODEL_GENERATED_GREETING_VALUE =
  "<assistant-speaks-first-with-model-generated-message>";

function deriveGreetingMode(greeting, explicitMode) {
  if (explicitMode) return explicitMode;
  if (greeting === MODEL_GENERATED_GREETING_VALUE) return "model_generated";
  if (greeting === "") return "wait_for_user";
  return "custom";
}

export default function AgentSettingsPanel({
  values,
  setValues,
  localTab,
  onLocalTabChange,
}) {
  const tUi = useUiText();
  const assistantVariableNames = useMemo(() => {
    const systemVariables = [
      "telnyx_current_time",
      "telnyx_conversation_channel",
      "telnyx_agent_target",
      "telnyx_end_user_target",
      "telnyx_shaken_stir_attestation",
      "call_control_id",
    ];
    return [
      ...new Set([
        ...systemVariables,
        ...Object.keys(values.dynamic_variables || {}).filter(Boolean),
      ]),
    ];
  }, [values.dynamic_variables]);
  const greetingMode = deriveGreetingMode(
    values.greeting,
    values.greeting_mode,
  );

  function handleGreetingModeChange(mode) {
    setValues((current) => {
      const currentGreeting = current.greeting || "";
      const customDraft =
        currentGreeting && currentGreeting !== MODEL_GENERATED_GREETING_VALUE
          ? currentGreeting
          : current.greeting_custom_draft || "";
      if (mode === "model_generated")
        return {
          ...current,
          greeting_mode: mode,
          greeting_custom_draft: customDraft,
          greeting: MODEL_GENERATED_GREETING_VALUE,
        };
      if (mode === "wait_for_user")
        return {
          ...current,
          greeting_mode: mode,
          greeting_custom_draft: customDraft,
          greeting: "",
        };
      return { ...current, greeting_mode: "custom", greeting: customDraft };
    });
  }

  const tab = localTab || "identity";
  function changeModel(next) {
    setValues((current) => ({ ...current, ...next }));
  }
  function modelUi(key, next) {
    setValues((current) => ({
      ...current,
      _modelUi: { ...current._modelUi, [key]: next },
    }));
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card p-5 shadow-sm">
      <div className="min-h-0 flex-1">
      <AssistantSectionTabs
        value={tab}
        onValueChange={onLocalTabChange}
        label="Agent settings"
        tabs={[
          { id: "identity", label: "Identity & instructions" },
          { id: "model", label: "Model & fallback" },
          { id: "greeting", label: "Greeting & behavior" },
        ]}
      >
        {(active) =>
          active === "identity" ? (
            <div className="flex h-full min-h-56 flex-col gap-5">
              <div className="grid shrink-0 gap-4 md:grid-cols-2">
              <div className="space-y-2" data-setting-path="name">
                <label htmlFor="assistant-name" className="text-sm font-medium">
                  {tUi("Name")}
                </label>
                <Input
                  id="assistant-name"
                  value={values.name || ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, name: e.target.value }))
                  }
                  required
                />
              </div>
              <div className="space-y-2" data-setting-path="description">
                <label
                  htmlFor="assistant-description"
                  className="text-sm font-medium"
                >
                  {tUi("Description")}
                </label>
                <Input
                  id="assistant-description"
                  value={values.description || ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, description: e.target.value }))
                  }
                />
              </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2" data-setting-path="instructions">
                <label htmlFor="assistant-instructions" className="shrink-0 text-sm font-medium">
                  {tUi("Instructions")}
                </label>
                <VariableTextarea
                  id="assistant-instructions"
                  rows={14}
                  wrapperClassName="min-h-0 flex-1"
                  className="h-full min-h-0 resize-none leading-relaxed"
                  pickerClassName="bottom-2 mt-0 max-h-full"
                  value={values.instructions || ""}
                  onChange={(next) =>
                    setValues((v) => ({ ...v, instructions: next }))
                  }
                  availableVariables={assistantVariableNames}
                />
              </div>
            </div>
          ) : active === "model" ? (
            <div className="grid w-full grid-cols-1 items-start gap-5 lg:grid-cols-2">
              <div className="rounded-xl border bg-card p-4" data-setting-path="model">
              <AssistantModelConfiguration
                value={values}
                onChange={changeModel}
                ui={values._modelUi?.primary}
                onUiChange={(next) => modelUi("primary", next)}
              />
              </div>
              <div className="space-y-5 rounded-xl border bg-card p-4" data-setting-path="fallback_config">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <label
                    htmlFor="assistant-fallback"
                    className="text-sm font-medium"
                  >
                    {tUi("Fallback model")}
                  </label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tUi(
                      "Used if the primary provider fails. This is separate from routing inside FastRouter.",
                    )}
                  </p>
                </div>
                <Switch
                  id="assistant-fallback"
                  checked={Boolean(
                    values.fallback_config?.model ||
                    values.fallback_config?.external_llm ||
                    values._fallbackEnabled,
                  )}
                  onCheckedChange={(enabled) =>
                    setValues((v) => ({
                      ...v,
                      _fallbackEnabled: enabled,
                      _fallbackDraft: enabled
                        ? v._fallbackDraft
                        : v.fallback_config,
                      fallback_config: enabled
                        ? v._fallbackDraft || { model: "" }
                        : null,
                    }))
                  }
                />
              </div>
              {values.fallback_config?.model ||
              values.fallback_config?.external_llm ||
              values._fallbackEnabled ? (
                <AssistantModelConfiguration
                  label="Fallback model"
                  hideLegend
                  settingPath="fallback_config"
                  value={values.fallback_config || {}}
                  onChange={(next) =>
                    setValues((v) => ({ ...v, fallback_config: next }))
                  }
                  ui={values._modelUi?.fallback}
                  onUiChange={(next) => modelUi("fallback", next)}
                />
              ) : null}
              </div>
            </div>
          ) : (
            <div className="grid w-full items-start gap-5 lg:grid-cols-2">
              <AssistantConfigurationCard title="Opening greeting" description="Choose how the assistant starts the conversation.">
              <div className="space-y-2" data-setting-path="greeting">
                <label className="text-sm font-medium">
                  {tUi("Greeting mode")}
                </label>
                <Select
                  value={greetingMode}
                  onValueChange={handleGreetingModeChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="custom">
                      {tUi("Assistant speaks first with custom greeting")}
                    </SelectItem>
                    <SelectItem value="wait_for_user">
                      {tUi("Assistant waits for the user to speak first")}
                    </SelectItem>
                    <SelectItem value="model_generated">
                      {tUi(
                        "Assistant speaks first with model-generated message",
                      )}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {greetingMode === "custom" ? (
                <VariableTextarea
                  rows={6}
                  value={values.greeting || ""}
                  onChange={(next) =>
                    setValues((v) => ({
                      ...v,
                      greeting: next,
                      greeting_custom_draft: next,
                    }))
                  }
                  availableVariables={assistantVariableNames}
                />
              ) : null}
              </AssistantConfigurationCard>
              <div data-setting-path="delegation_settings">
                <AssistantDelegationSettings
                  values={values}
                  setValues={setValues}
                />
              </div>
            </div>
          )
        }
      </AssistantSectionTabs>
      </div>
      {tab === "identity" ? (
        <div className="shrink-0 pt-5" data-setting-path="tags">
          <TagsSection value={values.tags || []} onChange={tags => setValues(v => ({...v,tags}))}/>
        </div>
      ) : null}
    </div>
  );
}
