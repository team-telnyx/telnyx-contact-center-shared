"use client";
import { useId, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import {
  assistantTabListClass,
  assistantTabTriggerClass,
} from "./AssistantSectionTabs";
import {
  IconMicrophone,
  IconShieldCheck,
  IconSparkles,
  IconPlus,
  IconTrash,
  IconArrowUp,
  IconArrowDown,
  IconLock,
  IconInfoCircle,
  IconX,
  IconChevronDown,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Combobox } from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { VariableInput } from "@/components/voice-flow/VariableInput";
import { IntegrationSecretField } from "./AssistantModelConfiguration";
import { useUiText } from "@/components/i18n/use-ui-text";
import { assistantSchemas } from "@/lib/ai/assistant-contract.mjs";
import {
  AZURE_TRANSCRIPTION_REGIONS,
  createTranscriptionOverride,
  validateTranscriptionOverride,
} from "@/lib/ai/assistant-transcription.mjs";
import {
  TRANSCRIPTION_MODELS,
  transcriptionSettingNames,
  transcriptionLanguages,
  inheritedTranscriptionSettings,
  additionalTranscriptionModels,
  updateTranscriptionFallbacks,
  updateTranscriptionBooster,
  transcriptionRuleAvailable,
  validateAdditionalTranscription,
} from "@/lib/ai/assistant-transcription-ui.mjs";

const settingLabels = {
  smart_format: "Smart Format",
  numerals: "Numerals",
  eot_threshold: "End-of-turn Threshold",
  eot_timeout_ms: "End-of-turn Timeout (ms)",
  eager_eot_threshold: "Eager End-of-turn Threshold",
  keyterm: "Keyterm Boost",
  end_of_turn_confidence_threshold: "End-of-turn Confidence Threshold",
  min_turn_silence: "Minimum Turn Silence (ms)",
  max_turn_silence: "Maximum Turn Silence (ms)",
  interim_results: "Interim Results",
  enable_endpoint_detection: "Endpoint Detection",
  max_endpoint_delay_ms: "Maximum Endpoint Delay (ms)",
  context: "Vocabulary hints",
  language_hints: "Language hints",
};
function FieldLabel({ children, htmlFor, hint }) {
  const tUi = useUiText();
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {children}
      </label>
      {hint ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={tUi("More information")}
                className="text-muted-foreground hover:text-foreground"
              >
                <IconInfoCircle className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm text-xs leading-relaxed">
              {hint}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </div>
  );
}
function languageLabel(code, locale) {
  try {
    return new Intl.DisplayNames(locale, { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}
function LanguagePicker({ id, model, value, inherited, onChange }) {
  const tUi = useUiText();
  const codes = transcriptionLanguages(model);
  const [custom, setCustom] = useState(false);
  const labels = {
    auto: tUi("Auto (automatic detection)"),
    multi: tUi("Multi (no language hint)"),
    codeswitch: tUi("Arabic / English code-switching"),
  };
  const options = [
    ...(inherited
      ? [{ value: "__inherit__", label: tUi("Same as primary language") }]
      : []),
    ...[...new Set([...(value ? [value] : []), ...codes])].map((code) => ({
      value: code,
      label: labels[code] || languageLabel(code, tUi.locale),
    })),
    ...(codes.length === 1 && codes[0] === "auto"
      ? [{ value: "__custom__", label: tUi("Specify a language code") }]
      : []),
  ];
  return (
    <div className="space-y-2">
      <Combobox
        id={id}
        value={
          custom ? "__custom__" : value || (inherited ? "__inherit__" : "auto")
        }
        onChange={(next) => {
          setCustom(next === "__custom__");
          if (next !== "__custom__")
            onChange(next === "__inherit__" ? null : next);
        }}
        options={options}
        triggerClassName="w-full h-10 bg-background"
        contentClassName="w-[var(--radix-dropdown-menu-trigger-width)]"
        placeholder={tUi("Select language")}
        emptyLabel={tUi("No matching language")}
      />
      {custom ? (
        <Input
          aria-label={tUi("Language code")}
          value={value || ""}
          placeholder="en-US"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </div>
  );
}
function ProviderSettings({
  model,
  value = {},
  defaults = {},
  onChange,
  availableVariables,
  id,
}) {
  const tUi = useUiText();
  const names = transcriptionSettingNames(model);
  const [languageToAdd, setLanguageToAdd] = useState("");
  function update(name, next) {
    onChange({ ...value, [name]: next });
  }
  return (
    <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
      {names.map((name) => {
        const schema =
          assistantSchemas.TranscriptionSettingsConfig.properties[name];
        const fieldId = `${id}-${name}`;
        const current = value?.[name] ?? defaults[name] ?? schema.default;
        if (
          name === "max_endpoint_delay_ms" &&
          !(
            value?.enable_endpoint_detection ??
            defaults.enable_endpoint_detection
          )
        )
          return null;
        if (name === "language_hints")
          return (
            <div key={name} className="md:col-span-2">
              <FieldLabel
                htmlFor={fieldId}
                hint={tUi(
                  "Optional languages to prioritize when recognizing speech.",
                )}
              >
                {tUi(settingLabels[name])}
              </FieldLabel>
              <div className="flex flex-wrap gap-2 mb-2">
                {(value?.language_hints || []).map((code) => (
                  <span
                    key={code}
                    className="inline-flex items-center gap-2 rounded-md border bg-background px-2.5 py-1 text-xs"
                  >
                    {languageLabel(code, tUi.locale)}
                    <button
                      type="button"
                      aria-label={`${tUi("Remove")} ${languageLabel(code, tUi.locale)}`}
                      onClick={() =>
                        update(
                          name,
                          value.language_hints.filter((v) => v !== code),
                        )
                      }
                    >
                      <IconX className="size-3.5" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <LanguagePicker
                    id={fieldId}
                    model={model}
                    value={languageToAdd}
                    onChange={setLanguageToAdd}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    !languageToAdd ||
                    ["auto", "multi"].includes(languageToAdd) ||
                    value?.language_hints?.includes(languageToAdd)
                  }
                  onClick={() => {
                    update(name, [
                      ...(value?.language_hints || []),
                      languageToAdd,
                    ]);
                    setLanguageToAdd("");
                  }}
                >
                  <IconPlus className="size-4" />
                  {tUi("Add language")}
                </Button>
              </div>
            </div>
          );
        if (schema.type === "boolean")
          return (
            <div
              key={name}
              className="flex items-center justify-between gap-4 rounded-lg border bg-background px-4 py-3"
            >
              <label htmlFor={fieldId} className="text-sm font-medium">
                {tUi(settingLabels[name])}
              </label>
              <Switch
                id={fieldId}
                checked={Boolean(current)}
                onCheckedChange={(next) => update(name, next)}
              />
            </div>
          );
        return (
          <div
            key={name}
            className={schema.type === "string" ? "md:col-span-2" : ""}
          >
            <FieldLabel htmlFor={fieldId} hint={schema.description}>
              {tUi(settingLabels[name])}
            </FieldLabel>
            {schema.type === "string" ? (
              <VariableInput
                id={fieldId}
                value={current || ""}
                onChange={(next) => update(name, next || undefined)}
                availableVariables={availableVariables}
                secrets={[]}
                placeholder={tUi("e.g., Telnyx,VoIP,SIP")}
              />
            ) : (
              <Input
                id={fieldId}
                className="h-10 bg-background"
                type="number"
                min={schema.minimum}
                max={schema.maximum}
                step={schema.type === "integer" ? 1 : 0.05}
                value={current ?? ""}
                onChange={(event) =>
                  update(
                    name,
                    event.target.value === ""
                      ? undefined
                      : Number(event.target.value),
                  )
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
export function TranscriptionModelFields({
  entry,
  onChange,
  primary,
  models,
  id,
  availableVariables,
  isPrimary = false,
  expanded = false,
}) {
  const tUi = useUiText();
  const [settingsOpen, setSettingsOpen] = useState(expanded);
  const model = entry.model || "";
  const custom = isPrimary || entry.settings != null;
  const defaults = isPrimary
    ? createTranscriptionOverride(model).settings || {}
    : inheritedTranscriptionSettings(primary, model);
  const options = [
    ...new Set([
      ...(model && !models.includes(model) ? [model] : []),
      ...models,
    ]),
  ];
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <FieldLabel htmlFor={`${id}-model`}>{tUi("Model")}</FieldLabel>
          <Select
            value={model}
            onValueChange={(next) => {
              if (isPrimary)
                onChange({
                  ...entry,
                  ...createTranscriptionOverride(next),
                  settings: createTranscriptionOverride(next).settings || {},
                  region: next === "azure/fast" ? "latency" : undefined,
                  api_key_ref:
                    next === "azure/fast" ? entry.api_key_ref : undefined,
                });
              else
                onChange({
                  ...entry,
                  model: next,
                  settings: null,
                  language: null,
                });
            }}
          >
            <SelectTrigger
              id={`${id}-model`}
              className="h-10 w-full bg-background"
            >
              <SelectValue placeholder={tUi("Select transcription model")} />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                  {option.startsWith("deepgram/") ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {tUi("Self-hosted by Telnyx")}
                    </span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <FieldLabel htmlFor={`${id}-language`}>{tUi("Language")}</FieldLabel>
          <LanguagePicker
            id={`${id}-language`}
            model={model}
            value={entry.language}
            inherited={!isPrimary}
            onChange={(language) => onChange({ ...entry, language })}
          />
        </div>
      </div>
      {isPrimary && model === "azure/fast" ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <FieldLabel htmlFor={`${id}-region`}>
              {tUi("Azure Region")}
            </FieldLabel>
            <Select
              value={entry.region || "latency"}
              onValueChange={(region) => onChange({ ...entry, region })}
            >
              <SelectTrigger id={`${id}-region`} className="w-full h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AZURE_TRANSCRIPTION_REGIONS.map((region) => (
                  <SelectItem key={region} value={region}>
                    {region === "latency"
                      ? tUi("Latency (auto-select closest region)")
                      : region}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <IntegrationSecretField
            label="Azure API Key Reference"
            value={entry.api_key_ref}
            onChange={(api_key_ref) => onChange({ ...entry, api_key_ref })}
          />
        </div>
      ) : null}
      {transcriptionSettingNames(model).length ? (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="-ml-2 gap-2 text-muted-foreground"
              onClick={() => setSettingsOpen(!settingsOpen)}
              aria-expanded={settingsOpen}
            >
              <IconChevronDown
                className={`size-4 transition-transform ${settingsOpen ? "rotate-180" : ""}`}
              />
              {isPrimary
                ? tUi("Model settings")
                : custom
                  ? tUi("Settings: Custom")
                  : tUi("Settings: Inherited")}
            </Button>
            {!isPrimary ? (
              <label
                className="flex items-center gap-2 text-xs"
                htmlFor={`${id}-custom`}
              >
                <span>{tUi("Customize settings")}</span>
                <Switch
                  id={`${id}-custom`}
                  checked={custom}
                  onCheckedChange={(enabled) => {
                    onChange({ ...entry, settings: enabled ? defaults : null });
                    setSettingsOpen(enabled);
                  }}
                />
              </label>
            ) : null}
          </div>
          {settingsOpen ? (
            <div className="mt-3 rounded-lg border bg-muted/20 p-4">
              {custom ? (
                <ProviderSettings
                  id={id}
                  model={model}
                  value={entry.settings || {}}
                  defaults={defaults}
                  onChange={(settings) => onChange({ ...entry, settings })}
                  availableVariables={availableVariables}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {tUi(
                    "Uses the primary model’s settings where supported, then provider defaults.",
                  )}
                </p>
              )}
              {!isPrimary && custom ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => onChange({ ...entry, settings: null })}
                >
                  {tUi("Use primary settings")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
const ruleOptions = [
  {
    value: "best_turn",
    label: "Best transcript each turn",
    description:
      "Both models transcribe every turn. The assistant uses the more complete, confident transcript.",
  },
  {
    value: "best_engine",
    label: "Best model for the call",
    description:
      "Compare the first turns, then continue with the stronger model. Available for streaming models.",
  },
  {
    value: "merge_words",
    label: "Merge Arabic and English",
    description:
      "Combine words within each utterance. Requires Telnyx Basira and Cohere with an Arabic language.",
  },
];
export default function AssistantTranscriptionSettings({
  value = {},
  savedValue,
  onChange,
  availableVariables = [],
  compact = false,
}) {
  const tUi = useUiText();
  const id = useId();
  const [emptyMode, setEmptyMode] = useState("fallback");
  const [undo, setUndo] = useState(null);
  const [dragIndex, setDragIndex] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const fallbacks = value.fallback_models || [];
  const mode = value.challenger
    ? "booster"
    : fallbacks.length
      ? "fallback"
      : emptyMode;
  const entries =
    mode === "fallback"
      ? fallbacks
      : value.challenger
        ? [value.challenger]
        : [];
  const activeIndex = Math.min(selectedIndex, Math.max(0, entries.length - 1));
  const selected = entries[activeIndex];
  const errors = [
    ...validateTranscriptionOverride(value),
    ...validateAdditionalTranscription(value),
  ];
  const available = additionalTranscriptionModels(value, mode, entries);
  function changeMode(next) {
    if (next === mode) return;
    setUndo(
      entries.length
        ? {
            fallback_models: value.fallback_models,
            challenger: value.challenger,
            mode,
            savedValue,
            selectedIndex: activeIndex,
          }
        : null,
    );
    setEmptyMode(next);
    setSelectedIndex(0);
    onChange({ ...value, fallback_models: null, challenger: null });
  }
  function updateEntries(next) {
    setEmptyMode(mode);
    onChange(
      mode === "fallback"
        ? updateTranscriptionFallbacks(value, next)
        : updateTranscriptionBooster(value, next[0]),
    );
  }
  function move(from, to) {
    if (to < 0 || to >= entries.length || from === to) return;
    const next = [...entries];
    next.splice(to, 0, next.splice(from, 1)[0]);
    setSelectedIndex(
      activeIndex === from
        ? to
        : from < activeIndex && to >= activeIndex
          ? activeIndex - 1
          : from > activeIndex && to <= activeIndex
            ? activeIndex + 1
            : activeIndex,
    );
    updateEntries(next);
  }
  function remove(index) {
    setSelectedIndex(
      index < activeIndex
        ? activeIndex - 1
        : Math.min(activeIndex, Math.max(0, entries.length - 2)),
    );
    updateEntries(entries.filter((_, i) => i !== index));
  }
  return (
    <div
      className="w-full space-y-5 pb-4"
      data-transcription-panel
    >
      <section
        className="overflow-hidden rounded-xl border bg-card shadow-sm"
        data-setting-path="transcription"
      >
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <IconMicrophone className="size-5 text-telnyx-green" />
          <div>
            <h2 className="font-semibold">{tUi("Primary transcription")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {tUi("Choose how your assistant listens and recognizes speech.")}
            </p>
          </div>
        </div>
        <div className="p-5">
          <TranscriptionModelFields
            id={`${id}-primary`}
            entry={value}
            onChange={onChange}
            primary={value}
            models={TRANSCRIPTION_MODELS.filter(
              (model) => model !== "assemblyai/universal-streaming",
            )}
            availableVariables={availableVariables}
            isPrimary
          />
        </div>
      </section>
      <Tabs.Root
        value={mode}
        onValueChange={changeMode}
        className="space-y-4"
        data-setting-path="transcription.fallback_models"
      >
        <Tabs.List
          className={assistantTabListClass}
          aria-label={tUi("Additional transcription mode")}
        >
          {[
            { id: "fallback", label: "Fallback" },
            { id: "booster", label: "Language Booster" },
          ].map((item) => (
            <Tabs.Trigger
              key={item.id}
              value={item.id}
              data-transcription-mode={item.id}
              className={assistantTabTriggerClass}
            >
              {tUi(item.label)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content
          value={mode}
          className="space-y-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {undo && undo.savedValue === savedValue ? (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
            >
              <span>
                {tUi(
                  "Changing mode removes the previous additional models when you save.",
                )}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  onChange({
                    ...value,
                    fallback_models: undo.fallback_models,
                    challenger: undo.challenger,
                  });
                  setEmptyMode(undo.mode);
                  setSelectedIndex(undo.selectedIndex);
                  setUndo(null);
                }}
              >
                {tUi("Undo")}
              </Button>
            </div>
          ) : null}
          <div
            className={`grid items-start gap-5 ${compact ? "" : "lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.6fr)]"}`}
          >
            <section
              className="min-w-0 rounded-xl border bg-card p-5 shadow-sm"
              aria-label={tUi("Additional transcription models")}
            >
              <div className="mb-2 flex items-center gap-2">
                {mode === "fallback" ? (
                  <IconShieldCheck className="size-5 text-telnyx-green" />
                ) : (
                  <IconSparkles className="size-5 text-telnyx-green" />
                )}
                <h2 className="font-semibold">{tUi("Additional models")}</h2>
              </div>
              <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
                {mode === "fallback"
                  ? tUi(
                      "If transcription fails, the next model in this order takes over — even during a call.",
                    )
                  : tUi(
                      "A second model listens alongside the primary model. Choose how the assistant selects the transcript.",
                    )}
              </p>
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                <IconLock className="mt-0.5 size-4 shrink-0" />
                <div>
                  {tUi("Primary model")}
                  <span className="mt-1 block break-words font-medium text-foreground">
                    {value.model || tUi("Select transcription model")}
                  </span>
                </div>
              </div>
              <div
                className="space-y-2"
                role="group"
                aria-label={tUi("Model order")}
              >
                {entries.map((entry, index) => (
                  <div
                    key={`${mode}-${index}`}
                    data-transcription-entry={index}
                    className={`rounded-lg border ${activeIndex === index ? "border-telnyx-green/60 bg-telnyx-green/5" : "bg-background/40"}`}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (dragIndex !== null) move(dragIndex, index);
                      setDragIndex(null);
                    }}
                  >
                    <button
                      type="button"
                      aria-pressed={activeIndex === index}
                      aria-controls={`${id}-detail`}
                      onClick={() => setSelectedIndex(index)}
                      className="w-full rounded-t-lg px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="mb-1 block text-xs font-medium text-emerald-700 dark:text-telnyx-green">
                        {mode === "fallback"
                          ? tUi("Fallback {value0}", { value0: index + 1 })
                          : tUi("Language Booster")}
                      </span>
                      <span className="block break-words text-sm font-medium">
                        {entry.model}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {entry.language
                          ? languageLabel(entry.language, tUi.locale)
                          : tUi("Same as primary language")}{" "}
                        ·{" "}
                        {entry.settings == null
                          ? tUi("Inherited settings")
                          : tUi("Custom settings")}
                      </span>
                    </button>
                    <div className="flex items-center gap-1 border-t px-2 py-1.5">
                      {mode === "fallback" ? (
                        <>
                          <span
                            draggable
                            onDragStart={() => setDragIndex(index)}
                            onDragEnd={() => setDragIndex(null)}
                            className="mr-auto cursor-grab px-2 text-muted-foreground"
                            aria-hidden
                          >
                            ⠿
                          </span>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-8"
                            disabled={index === 0}
                            aria-label={tUi("Move up")}
                            onClick={() => move(index, index - 1)}
                          >
                            <IconArrowUp className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-8"
                            disabled={index === entries.length - 1}
                            aria-label={tUi("Move down")}
                            onClick={() => move(index, index + 1)}
                          >
                            <IconArrowDown className="size-4" />
                          </Button>
                        </>
                      ) : (
                        <span className="mr-auto" />
                      )}
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        aria-label={tUi("Remove model")}
                        onClick={() => remove(index)}
                      >
                        <IconTrash className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {!entries.length ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  {mode === "fallback"
                    ? tUi("No fallback models added")
                    : tUi("No language booster added")}
                </p>
              ) : null}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-add-transcription-model
                  disabled={
                    !available.length ||
                    entries.length >= (mode === "fallback" ? 3 : 1)
                  }
                  onClick={() => {
                    const model =
                      available.find((model) => model !== value.model) ||
                      available[0];
                    setSelectedIndex(entries.length);
                    updateEntries([
                      ...entries,
                      {
                        model,
                        language: null,
                        settings: null,
                        ...(mode === "booster" ? { rule: "best_turn" } : {}),
                      },
                    ]);
                  }}
                >
                  <IconPlus className="size-4" />
                  {mode === "fallback"
                    ? tUi("Add fallback model")
                    : tUi("Add language booster")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {mode === "fallback"
                    ? tUi("{value0} of 3 fallback models", {
                        value0: entries.length,
                      })
                    : tUi("One booster at a time")}
                </span>
              </div>
            </section>
            <section
              id={`${id}-detail`}
              className="min-w-0 rounded-xl border bg-card p-5 shadow-sm"
              aria-label={tUi("Selected model settings")}
            >
              {selected ? (
                <>
                  <div className="mb-5 border-b pb-4">
                    <h2 className="font-semibold">
                      {mode === "fallback"
                        ? tUi("Fallback {value0}", { value0: activeIndex + 1 })
                        : tUi("Language Booster")}
                    </h2>
                    <p className="mt-1 break-words text-sm text-muted-foreground">
                      {selected.model}
                    </p>
                  </div>
                  <TranscriptionModelFields
                    key={`${mode}-${activeIndex}-${selected.model}`}
                    expanded
                    id={`${id}-${mode}-${activeIndex}`}
                    entry={selected}
                    primary={value}
                    models={additionalTranscriptionModels(
                      value,
                      mode,
                      entries,
                      activeIndex,
                    )}
                    availableVariables={availableVariables}
                    onChange={(next) =>
                      updateEntries(
                        entries.map((item, i) =>
                          i === activeIndex ? next : item,
                        ),
                      )
                    }
                  />
                  {mode === "booster" ? (
                    <div
                      className="mt-5 border-t pt-5"
                      data-setting-path="transcription.challenger"
                    >
                      <FieldLabel htmlFor={`${id}-rule`}>
                        {tUi("How to choose the transcript")}
                      </FieldLabel>
                      <Select
                        value={selected.rule || "best_turn"}
                        onValueChange={(rule) =>
                          updateEntries([{ ...selected, rule }])
                        }
                      >
                        <SelectTrigger
                          id={`${id}-rule`}
                          className="h-10 w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ruleOptions.map((rule) => (
                            <SelectItem
                              key={rule.value}
                              value={rule.value}
                              disabled={
                                !transcriptionRuleAvailable(
                                  rule.value,
                                  value,
                                  selected,
                                )
                              }
                            >
                              {tUi(rule.label)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                        {tUi(
                          ruleOptions.find(
                            (rule) =>
                              rule.value === (selected.rule || "best_turn"),
                          )?.description,
                        )}
                      </p>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center">
                  <IconMicrophone className="size-6 text-muted-foreground" />
                  <h2 className="font-medium">{tUi("Model settings")}</h2>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {available.length
                      ? tUi(
                          "Add a model to configure its language and recognition settings.",
                        )
                      : tUi(
                          "Choose a compatible primary model to use this mode.",
                        )}
                  </p>
                </div>
              )}
            </section>
          </div>
        </Tabs.Content>
      </Tabs.Root>
      {errors.length ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          <p className="font-medium">{tUi("Review transcription settings")}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {[...new Set(errors)].map((error) => (
              <li key={error}>{tUi(error)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
