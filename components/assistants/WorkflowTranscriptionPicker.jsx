"use client";

import { useEffect, useMemo, useState } from "react";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { VariableTextarea } from "@/components/voice-flow/VariableTextarea";
import { TRANSCRIPTION_PROVIDERS } from "@/config/voice";
import {
  ASSISTANT_TRANSCRIPTION_MODELS,
  AZURE_TRANSCRIPTION_REGIONS,
  createTranscriptionOverride,
  validateTranscriptionOverride,
} from "@/lib/ai/assistant-transcription.mjs";

function cleanObject(value) {
  if (!value || typeof value !== "object") return undefined;
  const next = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== "")
  );
  return Object.keys(next).length ? next : undefined;
}

function languageLabel(code) {
  if (code === "auto") return "Auto (automatic detection)";
  if (code === "multi") return "Multi (no language hint)";
  if (code === "codeswitch") return "Arabic / English code-switching";

  try {
    const normalized = String(code || "").replace(/_/g, "-");
    const baseLanguage = normalized.split("-")[0];
    const languageName = new Intl.DisplayNames(undefined, { type: "language" }).of(baseLanguage);
    return languageName ? `${languageName} (${code})` : code;
  } catch (_) {
    return code;
  }
}

function NumberSetting({
  id,
  label,
  value,
  defaultValue,
  min,
  max,
  step = 1,
  description,
  onChange,
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value ?? defaultValue}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

function BooleanSetting({ id, label, checked, description, onCheckedChange }) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
      </div>
      {description && <p className="mt-2 text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

function SecretsCombobox({ value, onChange }) {
  const [options, setOptions] = useState([]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const response = await fetch("/api/integration-secrets", { cache: "no-store" });
        const data = await response.json();
        if (mounted && response.ok && data?.ok) {
          setOptions(
            (data.secrets || []).map((secret) => ({
              value: secret.identifier,
              label: secret.identifier,
            }))
          );
        }
      } catch (_) {
        if (mounted) setOptions([]);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <Combobox
      value={value || ""}
      onChange={onChange}
      options={options}
      placeholder="Select Azure API key reference…"
      emptyLabel="No integration secrets found"
      triggerClassName="w-full"
      searchable
    />
  );
}

export default function WorkflowTranscriptionPicker({
  nodeId,
  value,
  availableVariables = [],
  onChange,
}) {
  const model = String(value?.model || "");
  const settings = value?.settings || {};
  const issues = validateTranscriptionOverride(value);

  const languages = useMemo(() => {
    const provider = TRANSCRIPTION_PROVIDERS.find((entry) => entry.model_name === model);
    const values = Array.isArray(provider?.languages) ? provider.languages : [];
    const current = value?.language;
    const unique = Array.from(new Set([...(current ? [current] : []), ...values]));
    return unique.map((code) => ({ value: code, label: languageLabel(code) }));
  }, [model, value?.language]);

  function updateTranscription(patch) {
    onChange?.(cleanObject({ ...(value || {}), ...patch }));
  }

  function updateSettings(patch) {
    updateTranscription({
      settings: cleanObject({ ...settings, ...patch }),
    });
  }

  const idPrefix = `workflow-transcription-${nodeId}`;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs font-medium text-muted-foreground">Transcription Model</Label>
        <Select
          value={model}
          onValueChange={(nextModel) => onChange?.(createTranscriptionOverride(nextModel))}
        >
          <SelectTrigger className="w-full text-sm">
            <SelectValue placeholder="Select transcription model" />
          </SelectTrigger>
          <SelectContent>
            {ASSISTANT_TRANSCRIPTION_MODELS.map((modelName) => (
              <SelectItem key={modelName} value={modelName}>
                {modelName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {languages.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            Transcription Language
          </Label>
          <Combobox
            value={value?.language || ""}
            onChange={(language) => updateTranscription({ language: language || undefined })}
            options={languages}
            placeholder="Use provider default"
            emptyLabel="No matching language"
            triggerClassName="w-full"
            searchable
          />
        </div>
      )}

      {(model === "deepgram/nova-2" || model === "deepgram/nova-3") && (
        <div className="space-y-3">
          <BooleanSetting
            id={`${idPrefix}-smart-format`}
            label="Smart Format"
            checked={settings.smart_format ?? true}
            description="Adds punctuation, casing, and readable transcript formatting."
            onCheckedChange={(checked) => updateSettings({ smart_format: checked })}
          />
          <BooleanSetting
            id={`${idPrefix}-numerals`}
            label="Numerals"
            checked={settings.numerals ?? true}
            description="Converts spoken numbers to numerical digits."
            onCheckedChange={(checked) => updateSettings({ numerals: checked })}
          />
        </div>
      )}

      {model === "deepgram/flux" && (
        <div className="space-y-3">
          <NumberSetting
            id={`${idPrefix}-eot-threshold`}
            label="End-of-turn Threshold"
            value={settings.eot_threshold}
            defaultValue={0.8}
            min={0.5}
            max={0.9}
            step={0.05}
            description="Confidence required to trigger a final end of turn (0.5–0.9)."
            onChange={(next) => updateSettings({ eot_threshold: next })}
          />
          <NumberSetting
            id={`${idPrefix}-eot-timeout`}
            label="End-of-turn Timeout (ms)"
            value={settings.eot_timeout_ms}
            defaultValue={5000}
            min={500}
            max={10000}
            step={100}
            description="Maximum silence before forcing an end of turn (500–10000 ms)."
            onChange={(next) => updateSettings({ eot_timeout_ms: next })}
          />
          <NumberSetting
            id={`${idPrefix}-eager-eot-threshold`}
            label="Eager End-of-turn Threshold"
            value={settings.eager_eot_threshold}
            defaultValue={0.4}
            min={0.3}
            max={0.9}
            step={0.05}
            description="Starts speculative LLM processing early. Must be no higher than the final threshold."
            onChange={(next) => updateSettings({ eager_eot_threshold: next })}
          />
        </div>
      )}

      {(model === "deepgram/nova-3" || model === "deepgram/flux") && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Keyterm Boost</Label>
          <VariableTextarea
            value={settings.keyterm || ""}
            onChange={(keyterm) => updateSettings({ keyterm: keyterm || undefined })}
            availableVariables={availableVariables}
            includeSecrets={false}
            highlightVariables
            rows={3}
            placeholder="Telnyx,VoIP,{{customer_name}}"
          />
          <p className="text-xs text-muted-foreground">
            Comma-separated terms to boost. Dynamic variables are resolved at call time.
          </p>
        </div>
      )}

      {model === "assemblyai/universal-streaming" && (
        <div className="space-y-3">
          <NumberSetting
            id={`${idPrefix}-assembly-confidence`}
            label="End-of-turn Confidence Threshold"
            value={settings.end_of_turn_confidence_threshold}
            defaultValue={0.4}
            min={0}
            max={1}
            step={0.05}
            description="Confidence required to trigger an end of turn (0–1)."
            onChange={(next) =>
              updateSettings({ end_of_turn_confidence_threshold: next })
            }
          />
          <NumberSetting
            id={`${idPrefix}-assembly-min-silence`}
            label="Minimum Turn Silence (ms)"
            value={settings.min_turn_silence}
            defaultValue={400}
            min={100}
            max={5000}
            step={100}
            description="Must be no higher than maximum turn silence."
            onChange={(next) => updateSettings({ min_turn_silence: next })}
          />
          <NumberSetting
            id={`${idPrefix}-assembly-max-silence`}
            label="Maximum Turn Silence (ms)"
            value={settings.max_turn_silence}
            defaultValue={1280}
            min={100}
            max={5000}
            step={100}
            description="Maximum silence before forcing an end of turn."
            onChange={(next) => updateSettings({ max_turn_silence: next })}
          />
        </div>
      )}

      {model === "azure/fast" && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Azure Region</Label>
            <Select
              value={value?.region || "latency"}
              onValueChange={(region) => updateTranscription({ region })}
            >
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AZURE_TRANSCRIPTION_REGIONS.map((region) => (
                  <SelectItem key={region} value={region}>
                    {region === "latency" ? "Latency (auto-select closest region)" : region}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">
              Azure API Key Reference
            </Label>
            <SecretsCombobox
              value={value?.api_key_ref || ""}
              onChange={(apiKeyRef) =>
                updateTranscription({ api_key_ref: apiKeyRef || undefined })
              }
            />
            <p className="text-xs text-muted-foreground">
              Optional integration secret for Azure regions that require a customer key.
            </p>
          </div>
        </div>
      )}

      {model === "soniox/stt-rt-v4" && (
        <div className="space-y-3">
          <BooleanSetting
            id={`${idPrefix}-soniox-interim`}
            label="Interim Results"
            checked={settings.interim_results ?? false}
            description="Streams non-final results in addition to finalized transcripts."
            onCheckedChange={(checked) => updateSettings({ interim_results: checked })}
          />
          <BooleanSetting
            id={`${idPrefix}-soniox-endpoint`}
            label="Endpoint Detection"
            checked={settings.enable_endpoint_detection ?? false}
            description="Emits end-of-utterance events using the maximum endpoint delay."
            onCheckedChange={(checked) =>
              updateSettings({
                enable_endpoint_detection: checked,
                max_endpoint_delay_ms: checked
                  ? settings.max_endpoint_delay_ms ?? 1750
                  : undefined,
              })
            }
          />
          {(settings.enable_endpoint_detection ?? false) && (
            <NumberSetting
              id={`${idPrefix}-soniox-endpoint-delay`}
              label="Maximum Endpoint Delay (ms)"
              value={settings.max_endpoint_delay_ms}
              defaultValue={1750}
              min={500}
              max={3000}
              step={50}
              description="Maximum silence before Soniox emits an end-of-utterance event."
              onChange={(next) => updateSettings({ max_endpoint_delay_ms: next })}
            />
          )}
        </div>
      )}

      {model === "nvidia/parakeet-v3" && (
        <p className="rounded-md border p-3 text-xs text-muted-foreground">
          Parakeet V3 uses automatic multilingual detection and has no provider-specific
          settings.
        </p>
      )}

      {model === "speechmatics/standard" && (
        <p className="rounded-md border p-3 text-xs text-muted-foreground">
          Speechmatics Standard uses the selected language hint and has no additional
          provider-specific settings.
        </p>
      )}

      {model === "humain/realtime" && (
        <p className="rounded-md border p-3 text-xs text-muted-foreground">
          Humain Realtime supports Arabic, English, and Arabic/English code-switching.
        </p>
      )}

      {issues.length > 0 && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">
          <div className="mb-1 font-medium">Fix transcription settings before saving</div>
          <ul className="list-disc space-y-1 pl-4">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
