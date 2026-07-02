"use client";

import { useMemo } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { languages as baseLanguageOptions } from "@/lib/languages";
import { VariableInput } from "./VariableInput";

const PREDEFINED_PARAMETERS = [
  {
    value: "caller_language",
    label: "Caller language",
    description: "Used by Agent Assist online translation as the caller's spoken language.",
  },
];

const LANGUAGE_OVERRIDES = [
  { code: "en-US", name: "English (United States)", flag: "🇺🇸" },
  { code: "en-GB", name: "English (United Kingdom)", flag: "🇬🇧" },
  { code: "pl-PL", name: "Polish (Poland)", flag: "🇵🇱" },
];

const LANGUAGE_OPTIONS = [
  ...LANGUAGE_OVERRIDES,
  ...baseLanguageOptions.filter(
    (language) =>
      !["auto", "multi"].includes(language.code) &&
      !LANGUAGE_OVERRIDES.some((override) => override.code === language.code),
  ),
];

function buildPreviewPatch(config) {
  const mode = config.update_mode || "predefined";
  if (mode === "predefined") {
    const key = config.predefined_key || "caller_language";
    const value = config.value_source === "variable"
      ? config.variable_value || "{{customer_language}}"
      : config.caller_language || "en-US";
    return { [key]: value };
  }
  if (mode === "custom") {
    const key = config.custom_key || "custom_key";
    let value = config.custom_value || "";
    if (config.custom_value_type === "number") value = Number(value || 0);
    if (config.custom_value_type === "boolean") value = value === true || value === "true";
    if (config.custom_value_type === "json") {
      try {
        value = JSON.parse(value || "null");
      } catch {
        value = "Invalid JSON";
      }
    }
    return { [key]: value };
  }
  try {
    return JSON.parse(config.raw_json || "{}");
  } catch {
    return { error: "Invalid JSON" };
  }
}

function encodePreview(value) {
  try {
    return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
  } catch {
    return "";
  }
}

export default function ClientStateUpdateNodeEditor({ config = {}, onChange, availableVariables = [] }) {
  const update = (key, value) => onChange({ ...config, [key]: value });
  const mode = config.update_mode || "predefined";
  const valueSource = config.value_source || "static";
  const previewPatch = useMemo(() => buildPreviewPatch(config), [config]);
  const base64Preview = useMemo(() => encodePreview(previewPatch), [previewPatch]);

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <Label>Update mode</Label>
        <Select value={mode} onValueChange={(value) => update("update_mode", value)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="predefined">Predefined parameter</SelectItem>
            <SelectItem value="custom">Custom parameter</SelectItem>
            <SelectItem value="raw_json">Raw JSON</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {mode === "predefined" && (
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label>Parameter</Label>
            <Select
              value={config.predefined_key || "caller_language"}
              onValueChange={(value) => update("predefined_key", value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PREDEFINED_PARAMETERS.map((parameter) => (
                  <SelectItem key={parameter.value} value={parameter.value}>
                    {parameter.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {PREDEFINED_PARAMETERS.find((item) => item.value === (config.predefined_key || "caller_language"))?.description}
            </p>
          </div>

          <div className="grid gap-2">
            <Label>Value source</Label>
            <Select value={valueSource} onValueChange={(value) => update("value_source", value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="static">Static language</SelectItem>
                <SelectItem value="variable">Variable / expression</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {valueSource === "variable" ? (
            <div className="grid gap-2">
              <Label>Variable value</Label>
              <VariableInput
                value={config.variable_value || ""}
                onChange={(value) => update("variable_value", value)}
                availableVariables={availableVariables}
                placeholder="{{customer_language}}"
              />
              {availableVariables.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Available examples: {availableVariables.slice(0, 6).join(", ")}
                </p>
              )}
            </div>
          ) : (
            <div className="grid gap-2">
              <Label>Caller language</Label>
              <Select
                value={config.caller_language || "en-US"}
                onValueChange={(value) => update("caller_language", value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map((language) => (
                    <SelectItem key={language.code} value={language.code}>
                      {language.flag} {language.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      {mode === "custom" && (
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label>Custom parameter</Label>
            <Input
              value={config.custom_key || ""}
              onChange={(event) => update("custom_key", event.target.value)}
              placeholder="customer_tier"
            />
          </div>
          <div className="grid gap-2">
            <Label>Value type</Label>
            <Select
              value={config.custom_value_type || "text"}
              onValueChange={(value) => update("custom_value_type", value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="number">Number</SelectItem>
                <SelectItem value="boolean">Boolean</SelectItem>
                <SelectItem value="json">JSON value</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Value</Label>
            <Input
              value={config.custom_value || ""}
              onChange={(event) => update("custom_value", event.target.value)}
              placeholder="gold or {{customer_tier}}"
            />
          </div>
        </div>
      )}

      {mode === "raw_json" && (
        <div className="grid gap-2">
          <Label>Raw JSON</Label>
          <Textarea
            value={config.raw_json || "{}"}
            onChange={(event) => update("raw_json", event.target.value)}
            rows={6}
            className="font-mono text-xs"
            placeholder={'{"caller_language":"{{customer_language}}"}'}
          />
          <p className="text-xs text-muted-foreground">
            This object is merged into the current client_state. Existing keys are preserved unless this JSON sets the same key.
          </p>
        </div>
      )}

      <div className="space-y-2 rounded-lg border p-3">
        <Label>Will merge into client_state</Label>
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs">
          {JSON.stringify(previewPatch, null, 2)}
        </pre>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Base64 preview</summary>
          <pre className="mt-2 overflow-auto rounded bg-muted p-2 font-mono text-[11px] text-foreground">
            {base64Preview}
          </pre>
        </details>
      </div>
    </div>
  );
}
