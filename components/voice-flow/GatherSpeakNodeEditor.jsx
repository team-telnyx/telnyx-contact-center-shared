"use client";

import { useState, useEffect, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";
import {
  IconPlayerPlay,
  IconPlayerStop,
  IconCheck,
  IconWorld,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { VariableTextarea } from "./VariableTextarea";

function parseVoiceString(value, availableProviders = []) {
  const safe = String(value || "").trim();
  const parts = safe.split(".");
  const provider = parts[0] || "";
  if (!safe || !provider) return { provider, model: "", voiceName: safe };

  const selectedProvider = availableProviders.find(
    (candidate) =>
      candidate?.id === provider ||
      candidate?.provider === provider ||
      candidate?.name === provider
  );
  const remainder = parts.slice(1).join(".");
  const modelIds = (selectedProvider?.models || [])
    .map((modelEntry) =>
      typeof modelEntry === "object" ? modelEntry.id || modelEntry.name : modelEntry
    )
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const matchedModel = modelIds.find(
    (modelId) => remainder === modelId || remainder.startsWith(`${modelId}.`)
  );

  if (matchedModel) {
    return { provider, model: matchedModel, voiceName: safe };
  }
  if (parts.length >= 3) {
    return { provider, model: parts[1] || "", voiceName: safe };
  }
  if (parts.length === 2) {
    return { provider, model: "", voiceName: safe };
  }
  return { provider, model: "", voiceName: safe };
}

function buildVoiceString(provider, model, voiceName) {
  // Match AI Assistant pattern: return the full voice ID as-is
  // Voice IDs are already in format: Provider.Model.VoiceId or Provider.VoiceId
  return voiceName || "";
}

function normalizeLocaleCode(code) {
  try {
    const s = String(code || "").replace(/_/g, "-");
    const m = s.match(/^([a-zA-Z]{2,3})-([a-zA-Z]{2}|\d{3})$/);
    if (!m) return null;
    const lang = m[1].toLowerCase();
    const region = m[2].toUpperCase();
    return `${lang}-${region}`;
  } catch (_) {
    return null;
  }
}

function regionToFlag(region) {
  try {
    const r = String(region || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(r)) return "";
    const codePoints = [...r].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
    return String.fromCodePoint(...codePoints);
  } catch (_) {
    return "";
  }
}

export default function GatherSpeakNodeEditor({
  config = {},
  onChange,
  availableVariables = [],
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [audio, setAudio] = useState(null);
  const [providers, setProviders] = useState([]);
  const [secrets, setSecrets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [languageFilter, setLanguageFilter] = useState("");
  const [languageSearch, setLanguageSearch] = useState("");
  const [languagePopoverOpen, setLanguagePopoverOpen] = useState(false);

  const {
    provider: pInit,
    model: mInit,
    voiceName: vInit,
  } = useMemo(
    () => parseVoiceString(config.voice || "AWS.Polly.Joanna", providers),
    [config.voice, providers]
  );

  const [provider, setProvider] = useState(pInit);
  const [model, setModel] = useState(mInit);
  const [voiceName, setVoiceName] = useState(vInit);

  // Load voices from API
  useEffect(() => {
    async function loadVoices() {
      try {
        setLoading(true);
        console.log("Loading TTS voices...");
        const res = await fetch("/api/tts/voices", { cache: "no-store" });
        const data = await res.json();
        console.log("TTS voices response:", { ok: res.ok, data });

        if (res.ok && data?.ok) {
          setProviders(data.providers || []);
          console.log("Loaded providers:", data.providers?.length || 0);
        } else {
          console.error("Failed to load voices:", data.error);
        }
      } catch (err) {
        console.error("Error loading voices:", err);
      } finally {
        setLoading(false);
      }
    }
    loadVoices();
  }, []);

  // Load secrets for ElevenLabs
  useEffect(() => {
    if (provider === "ElevenLabs") {
      async function loadSecrets() {
        try {
          const res = await fetch("/api/integration-secrets", {
            cache: "no-store",
          });
          const data = await res.json();
          if (res.ok && data?.ok) {
            // Secrets are in data.secrets array with { identifier, ... } structure
            const secretsList = (data.secrets || []).map((s) => ({
              id: s.identifier,
              name: s.identifier,
            }));
            setSecrets(secretsList);
          }
        } catch (err) {
          console.error("Failed to load secrets:", err);
        }
      }
      loadSecrets();
    } else {
      setSecrets([]);
    }
  }, [provider]);

  // Update internal state when config changes (only when loading a saved voice)
  useEffect(() => {
    // Only sync if we have a valid voice from config
    // Don't sync if config.voice is empty (which happens when changing provider/model)
    if (config.voice && config.voice.trim()) {
      setProvider(pInit);
      setModel(mInit);
      setVoiceName(vInit);
    }
  }, [config.voice, pInit, mInit, vInit]);

  // Debug: Log when config changes
  useEffect(() => {
    console.log("[GatherSpeakNodeEditor] Config updated:", {
      voice: config.voice,
      voice_api_key_ref: config.voice_api_key_ref,
      payloadLength: config.payload?.length || 0,
    });
  }, [config.voice, config.voice_api_key_ref, config.payload]);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === provider || p.provider === provider),
    [providers, provider]
  );

  const models = useMemo(() => {
    if (!selectedProvider?.models) return [];
    // Filter out models without IDs to match AI Assistant pattern
    return selectedProvider.models
      .map((m) => {
        if (typeof m === "string") return { id: m, name: m };
        return { id: m.id || m.name, name: m.name || m.id };
      })
      .filter((m) => m.id); // Only include models with valid IDs
  }, [selectedProvider]);

  // Get all voices for the selected provider/model (before language filtering)
  const allVoicesForProvider = useMemo(() => {
    if (!selectedProvider?.models) return [];

    // If no model selected, get all voices from all models
    if (!model || model === "__default__") {
      const allVoices = [];
      for (const m of selectedProvider.models) {
        const modelVoices = typeof m === "object" && m.voices ? m.voices : [];
        allVoices.push(...modelVoices);
      }
      return allVoices.filter((v) => v?.id);
    }

    // Find specific model and return its voices
    const modelObj = selectedProvider.models.find(
      (m) => (typeof m === "object" ? m.id || m.name : m) === model
    );

    if (modelObj && typeof modelObj === "object" && modelObj.voices) {
      return modelObj.voices.filter((v) => v?.id);
    }

    return [];
  }, [selectedProvider, model]);

  // Extract available languages from voices
  const languageOptions = useMemo(() => {
    const map = new Map(); // key: normalized code -> { value, label, flag }
    let langNames = null;
    let regionNames = null;
    try {
      langNames = new Intl.DisplayNames(undefined, { type: "language" });
      regionNames = new Intl.DisplayNames(undefined, { type: "region" });
    } catch (_) {}

    for (const v of allVoicesForProvider) {
      const norm = normalizeLocaleCode(v?.language);
      if (!norm || map.has(norm)) continue;
      const [lang, region] = norm.split("-");
      let label = norm.toUpperCase();
      try {
        const ln = langNames?.of(lang) || lang.toUpperCase();
        const rn = regionNames?.of(region) || region.toUpperCase();
        label = `${ln} (${rn})`;
      } catch (_) {}
      const flag = regionToFlag(region);
      map.set(norm, { value: norm, label, flag });
    }
    return Array.from(map.values()).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
  }, [allVoicesForProvider]);

  const filteredLanguageOptions = useMemo(() => {
    if (!languageSearch.trim()) return languageOptions;
    const search = languageSearch.toLowerCase();
    return languageOptions.filter(
      (option) =>
        option.label.toLowerCase().includes(search) ||
        option.value.toLowerCase().includes(search)
    );
  }, [languageOptions, languageSearch]);

  // Filter voices by language
  const voices = useMemo(() => {
    let filtered = allVoicesForProvider;

    // Filter by language if a language is selected
    if (languageFilter) {
      filtered = filtered.filter(
        (v) => normalizeLocaleCode(v?.language) === languageFilter
      );
    }

    return filtered;
  }, [allVoicesForProvider, languageFilter]);

  const handleProviderChange = (newProvider) => {
    setProvider(newProvider);
    setModel("");
    setVoiceName("");
    setLanguageFilter(""); // Reset language filter
    // Don't emit voice change until a voice is actually selected
    // Just clear the current voice and preserve other config
    onChange?.({
      ...config,
      voice: "", // Clear voice when provider changes
      voice_api_key_ref:
        newProvider === "ElevenLabs" ? config.voice_api_key_ref || "" : "",
    });
  };

  const handleModelChange = (newModel) => {
    const actualModel = newModel === "__default__" ? "" : newModel;
    setModel(actualModel);
    setVoiceName("");
    setLanguageFilter(""); // Reset language filter when model changes
    // Don't emit voice change until a voice is actually selected
    // Preserve voice_api_key_ref
    onChange?.({
      ...config,
      voice: "", // Clear voice when model changes
    });
  };

  const handleLanguageChange = (selectedValue) => {
    if (selectedValue === "__any__") {
      setLanguageFilter("");
    } else {
      setLanguageFilter(selectedValue);
    }
    setVoiceName(""); // Clear voice when language filter changes
    onChange?.({
      ...config,
      voice: "", // Clear voice when language filter changes
    });
    setLanguagePopoverOpen(false);
  };

  const handleVoiceChange = (newVoiceName) => {
    setVoiceName(newVoiceName);
    // Voice IDs are already in full format (e.g., "ElevenLabs.eleven_flash_v2.Rachel")
    // Always preserve voice_api_key_ref
    onChange?.({
      ...config,
      voice: newVoiceName,
    });
  };

  const handleTest = async () => {
    if (isPlaying && audio) {
      audio.pause();
      audio.currentTime = 0;
      setIsPlaying(false);
      setAudio(null);
      return;
    }

    const text = config.payload || "";
    const voice = config.voice || "AWS.Polly.Joanna";
    const voiceApiKeyRef = config.voice_api_key_ref || "";

    console.log("[GatherSpeakNodeEditor] Testing voice with:", {
      voice,
      voice_api_key_ref: voiceApiKeyRef,
      textLength: text.length,
    });

    if (!text.trim()) {
      notify({
        title: "Error",
        description: "Please enter text to speak",
        variant: "error",
      });
      return;
    }

    try {
      setIsPlaying(true);

      // Use existing /api/tts/speech endpoint (same as AI Assistant)
      const response = await fetch("/api/tts/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
        cache: "no-store",
        body: JSON.stringify({
          text,
          voice,
          voice_api_key_ref: voiceApiKeyRef,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        // Extract Telnyx error format: {"errors":[{"title":"...","detail":"..."}]}
        let errorMessage = "Failed to generate speech";
        if (errorData?.error) {
          errorMessage = errorData.error;
        } else if (
          errorData?.errors &&
          Array.isArray(errorData.errors) &&
          errorData.errors.length > 0
        ) {
          const firstError = errorData.errors[0];
          errorMessage = firstError.detail || firstError.title || errorMessage;
        }
        throw new Error(errorMessage);
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audioElement = new Audio(audioUrl);

      audioElement.onended = () => {
        setIsPlaying(false);
        setAudio(null);
        URL.revokeObjectURL(audioUrl);
      };

      audioElement.onerror = () => {
        setIsPlaying(false);
        setAudio(null);
        URL.revokeObjectURL(audioUrl);
        notify({
          title: "Error",
          description: "Error playing audio",
          variant: "error",
        });
      };

      setAudio(audioElement);
      await audioElement.play();
    } catch (error) {
      console.error("Error testing voice:", error);
      notify({
        title: "Error",
        description: error.message || "Failed to generate speech",
        variant: "error",
      });
      setIsPlaying(false);
      setAudio(null);
    }
  };

  // Get selected language display info
  const selectedLanguageInfo = useMemo(() => {
    if (!languageFilter) return null;
    return languageOptions.find((opt) => opt.value === languageFilter);
  }, [languageFilter, languageOptions]);

  return (
    <div className="space-y-4">
      {/* Text to Speak */}
      <div>
        <Label htmlFor="payload">
          Text to Speak <span className="text-red-500">*</span>
        </Label>
        <VariableTextarea
          id="payload"
          value={config.payload || ""}
          onChange={(value) => onChange?.({ ...config, payload: value })}
          availableVariables={availableVariables}
          placeholder="Press 1 for sales, 2 for support"
          rows={4}
          maxLength={3000}
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          The text or SSML to be converted into speech (supports variable
          substitution, 3,000 character limit)
        </p>
      </div>

      {/* Provider */}
      <div>
        <Label>
          Provider <span className="text-red-500">*</span>
        </Label>
        <Select
          value={provider}
          onValueChange={handleProviderChange}
          disabled={loading}
        >
          <SelectTrigger className="w-full mt-1">
            <SelectValue
              placeholder={loading ? "Loading providers..." : "Select provider"}
            />
          </SelectTrigger>
          <SelectContent>
            {providers.length === 0 && !loading ? (
              <div className="p-2 text-sm text-muted-foreground">
                No providers available
              </div>
            ) : (
              providers
                .map((p) => {
                  const providerKey = p?.id || p?.provider || p?.name || "";
                  const providerLabel = p?.name || p?.provider || p?.id || "";
                  // Only render if we have a valid non-empty key
                  if (!providerKey || providerKey.trim() === "") {
                    return null;
                  }
                  return (
                    <SelectItem key={providerKey} value={providerKey}>
                      {providerLabel}
                    </SelectItem>
                  );
                })
                .filter(Boolean)
            )}
          </SelectContent>
        </Select>
      </div>

      {/* Model (if provider has models) */}
      {models.length > 0 && (
        <div>
          <Label>Model</Label>
          <Select
            value={model === "" ? "__default__" : model}
            onValueChange={handleModelChange}
            disabled={loading}
          >
            <SelectTrigger className="w-full mt-1">
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent>
              {/* Show "Default" option if some models have no ID */}
              {selectedProvider?.models?.some((m) => !m?.id && !m) && (
                <SelectItem value="__default__">Default</SelectItem>
              )}
              {models
                .map((m) => {
                  // Ensure m.id is valid and non-empty
                  if (!m?.id || m.id.trim() === "") {
                    return null;
                  }
                  return (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name || m.id}
                    </SelectItem>
                  );
                })
                .filter(Boolean)}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Language Filter (only show if languages are available) */}
      {(languageOptions.length > 0 || languageFilter) && (
        <div>
          <Label>Language Filter</Label>
          <Popover
            open={languagePopoverOpen}
            onOpenChange={setLanguagePopoverOpen}
          >
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                className="w-full mt-1 justify-between"
                disabled={loading}
              >
                <div className="flex items-center gap-2">
                  {selectedLanguageInfo ? (
                    <>
                      <span>{selectedLanguageInfo.flag}</span>
                      <span>{selectedLanguageInfo.label}</span>
                    </>
                  ) : (
                    <>
                      <IconWorld className="h-4 w-4" />
                      <span>All languages</span>
                    </>
                  )}
                </div>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[300px] p-0" align="start">
              <Command>
                <CommandInput
                  placeholder="Search languages..."
                  value={languageSearch}
                  onValueChange={setLanguageSearch}
                  className="h-9"
                />
                <CommandEmpty>No language found.</CommandEmpty>
                <CommandGroup className="max-h-[300px] overflow-auto">
                  <CommandItem
                    value="__any__"
                    onSelect={() => handleLanguageChange("__any__")}
                  >
                    <IconCheck
                      className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${
                        !languageFilter ? "opacity-100" : "opacity-0"
                      }`}
                    />
                    <IconWorld className="size-4 mr-2" />
                    <span>Any</span>
                  </CommandItem>
                  {filteredLanguageOptions.map((opt) => (
                    <CommandItem
                      key={opt.value}
                      value={`${opt.label}-${opt.value}`}
                      onSelect={() => handleLanguageChange(opt.value)}
                    >
                      <IconCheck
                        className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${
                          languageFilter === opt.value
                            ? "opacity-100"
                            : "opacity-0"
                        }`}
                      />
                      <span className="mr-2">{opt.flag}</span>
                      <span>{opt.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </Command>
            </PopoverContent>
          </Popover>
          <p className="text-xs text-muted-foreground mt-1">
            Filter voices by language ({languageOptions.length} language
            {languageOptions.length !== 1 ? "s" : ""} available)
          </p>
        </div>
      )}

      {/* Voice */}
      <div>
        <Label>
          Voice <span className="text-red-500">*</span>
        </Label>
        <Combobox
          value={voiceName}
          onChange={handleVoiceChange}
          options={voices
            .filter((v) => v?.id) // Filter out invalid voices
            .reduce((acc, v) => {
              // Only add if this voice ID doesn't already exist
              if (!acc.find((item) => item.value === v.id)) {
                // Include language in label if available
                const label = v.name || v.id;
                const languageLabel = v?.language
                  ? `${label} (${v.language})`
                  : label;
                acc.push({
                  value: v.id,
                  label: languageLabel,
                });
              }
              return acc;
            }, [])}
          placeholder="Select voice"
          searchPlaceholder="Search voices..."
          emptyText={
            languageFilter
              ? `No voices found for ${
                  selectedLanguageInfo?.label || languageFilter
                }`
              : "No voices found"
          }
          triggerClassName="w-full mt-1"
          disabled={loading}
        />
        {languageFilter && (
          <p className="text-xs text-muted-foreground mt-1">
            Showing {voices.length} voice{voices.length !== 1 ? "s" : ""} for{" "}
            {selectedLanguageInfo?.label || languageFilter}
          </p>
        )}
      </div>

      {/* Voice API Key (ElevenLabs only) */}
      {provider === "ElevenLabs" && (
        <div>
          <Label>
            ElevenLabs API Key <span className="text-red-500">*</span>
          </Label>
          <Select
            value={config.voice_api_key_ref || "__none__"}
            onValueChange={(value) => {
              const newKeyRef = value === "__none__" ? "" : value;
              console.log("[GatherSpeakNodeEditor] API key changed:", {
                from: config.voice_api_key_ref,
                to: newKeyRef,
              });
              onChange?.({
                ...config,
                voice_api_key_ref: newKeyRef,
              });
            }}
          >
            <SelectTrigger className="w-full mt-1">
              <SelectValue placeholder="Select API key" />
            </SelectTrigger>
            <SelectContent>
              {secrets.length === 0 ? (
                <div className="p-2 text-sm text-muted-foreground">
                  No ElevenLabs API keys found. Add one in Integration Secrets.
                </div>
              ) : (
                <>
                  <SelectItem value="__none__">Select an API key</SelectItem>
                  {secrets
                    .map((s) => {
                      // Ensure s.id is valid and non-empty
                      if (!s?.id || s.id.trim() === "") {
                        return null;
                      }
                      return (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name || s.id}
                        </SelectItem>
                      );
                    })
                    .filter(Boolean)}
                </>
              )}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            Select an ElevenLabs API key from your integration secrets
          </p>
        </div>
      )}

      {/* Test Button */}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={
            !config.payload?.trim() ||
            !config.voice ||
            !voiceName ||
            (provider === "ElevenLabs" && !config.voice_api_key_ref) ||
            loading
          }
          className="w-full"
        >
          {isPlaying ? (
            <>
              <IconPlayerStop className="w-4 h-4 mr-2" />
              Stop Test
            </>
          ) : (
            <>
              <IconPlayerPlay className="w-4 h-4 mr-2" />
              Test Voice
            </>
          )}
        </Button>
      </div>

      {/* Gather Configuration */}
      <div className="border-t pt-4">
        <h4 className="text-sm font-semibold mb-3">DTMF Collection Settings</h4>

        <div className="space-y-3">
          {/* Valid Digits */}
          <div>
            <Label htmlFor="valid_digits">Valid Digits</Label>
            <Input
              id="valid_digits"
              type="text"
              value={config.valid_digits ?? "0123456789#*"}
              onChange={(e) =>
                onChange?.({ ...config, valid_digits: e.target.value })
              }
              placeholder="0123456789#*"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              A list of all digits accepted as valid
            </p>
          </div>

          {/* Minimum Digits */}
          <div>
            <Label htmlFor="minimum_digits">Minimum Digits</Label>
            <Input
              id="minimum_digits"
              type="number"
              min={1}
              value={config.minimum_digits ?? 1}
              onChange={(e) =>
                onChange?.({
                  ...config,
                  minimum_digits: parseInt(e.target.value) || 1,
                })
              }
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The minimum number of digits to fetch
            </p>
          </div>

          {/* Maximum Digits */}
          <div>
            <Label htmlFor="maximum_digits">Maximum Digits</Label>
            <Input
              id="maximum_digits"
              type="number"
              max={128}
              value={config.maximum_digits ?? 128}
              onChange={(e) =>
                onChange?.({
                  ...config,
                  maximum_digits: parseInt(e.target.value) || 128,
                })
              }
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The maximum number of digits to fetch (max: 128)
            </p>
          </div>

          {/* Terminating Digit */}
          <div>
            <Label htmlFor="terminating_digit">Terminating Digit</Label>
            <Input
              id="terminating_digit"
              type="text"
              maxLength={1}
              value={config.terminating_digit ?? "#"}
              onChange={(e) =>
                onChange?.({ ...config, terminating_digit: e.target.value })
              }
              placeholder="#"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Digit used to terminate input
            </p>
          </div>

          {/* Timeout */}
          <div>
            <Label htmlFor="timeout_millis">Timeout (ms)</Label>
            <Input
              id="timeout_millis"
              type="number"
              value={config.timeout_millis ?? 60000}
              onChange={(e) =>
                onChange?.({
                  ...config,
                  timeout_millis: parseInt(e.target.value) || 60000,
                })
              }
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Milliseconds to wait for DTMF response after speech ends
            </p>
          </div>

          {/* Inter-digit Timeout */}
          <div>
            <Label htmlFor="inter_digit_timeout_millis">
              Inter-digit Timeout (ms)
            </Label>
            <Input
              id="inter_digit_timeout_millis"
              type="number"
              value={config.inter_digit_timeout_millis ?? 5000}
              onChange={(e) =>
                onChange?.({
                  ...config,
                  inter_digit_timeout_millis: parseInt(e.target.value) || 5000,
                })
              }
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The number of milliseconds to wait for input between digits
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
