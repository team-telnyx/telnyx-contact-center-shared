"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TRANSCRIPTION_PROVIDERS } from "@/config/voice";
import {
  IconVolume,
  IconWaveSine,
  IconCheck,
  IconSelector,
  IconWorld,
  IconInfoCircle,
  IconMicrophone,
} from "@tabler/icons-react";
import { Play, Pause } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import MicOverlay from "@/components/ai-elements/mic-overlay";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Combobox } from "@/components/ui/combobox";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { notify } from "@/components/ToastNotify";

function parseVoiceString(value, availableProviders = []) {
  const safe = String(value || "").trim();
  const parts = safe.split(".");
  const provider = parts[0] || "";
  if (!safe || !provider) return { provider, model: "", voiceName: safe };

  // Match against the catalog because model ids may themselves contain dots
  // (for example Minimax `speech-2.8-turbo`). Splitting on the first dot would
  // turn that model into `speech-2` and make both selects lose their labels.
  const providerKey = provider.toLowerCase();
  const selectedProvider = availableProviders.find((candidate) =>
    [candidate?.id, candidate?.provider, candidate?.name]
      .filter(Boolean)
      .some((candidateName) => String(candidateName).toLowerCase() === providerKey)
  );
  const catalogProvider = selectedProvider?.id || selectedProvider?.provider || provider;
  const catalogVoice = (selectedProvider?.models || [])
    .flatMap((entry) => entry?.voices || [])
    .find((entry) => String(entry?.id || "").toLowerCase() === safe.toLowerCase())?.id || safe;
  const remainder = parts.slice(1).join(".");
  const matchedModel = (selectedProvider?.models || [])
    .map((entry) => entry?.id || entry?.name || "")
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find((modelId) => remainder === modelId || remainder.startsWith(`${modelId}.`));
  if (matchedModel) return { provider: catalogProvider, model: matchedModel, voiceName: catalogVoice };

  // Providers such as xAI use Provider.VoiceId, while the normalized catalog
  // exposes their model bucket as `default`.
  const defaultModel = (selectedProvider?.models || []).find(
    (entry) => (entry?.id || entry?.name || "").toLowerCase() === "default"
  );
  if (parts.length === 2 && defaultModel) {
    return { provider: catalogProvider, model: defaultModel.id || defaultModel.name, voiceName: catalogVoice };
  }

  // Format nuances:
  // - 3+ segments: Provider.Model.VoiceId (e.g., ElevenLabs.eleven_flash_v2.XXXX)
  // - 2 segments:  Provider.VoiceId (e.g., Azure.en-US-AvaMultilingualNeural)
  // - 1 segment:   Provider only
  if (parts.length >= 3) {
    return {
      provider: catalogProvider,
      model: parts.slice(1, -1).join("."),
      voiceName: catalogVoice, // use full upstream id
    };
  }
  if (parts.length === 2) {
    return {
      provider: catalogProvider,
      model: "",
      voiceName: catalogVoice, // use full upstream id
    };
  }
  return { provider: catalogProvider, model: "", voiceName: catalogVoice };
}

function buildVoiceString(provider, model, voiceName) {
  if (!provider && !model && !voiceName) return "";
  // If there is no model, emit Provider.VoiceId (Azure/AWS often have only VoiceId)
  const segs = model
    ? [provider, model, voiceName].filter(Boolean)
    : [provider, voiceName].filter(Boolean);
  return segs.join(".");
}

// SecretsCombobox component for API Key selection
function SecretsCombobox({ value, onChange }) {
  const [options, setOptions] = useState([]);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/integration-secrets", {
          cache: "no-store",
        });
        const data = await res.json();
        if (mounted && res.ok && data?.ok) {
          const opts = (data.secrets || []).map((s) => ({
            value: s.identifier,
            label: s.identifier,
          }));
          setOptions(opts);
        }
      } catch (_) {}
    })();
    return () => {
      mounted = false;
    };
  }, []);
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Select API key reference…"
      emptyLabel="No API keys found"
      triggerClassName="w-full"
      searchable
    />
  );
}

const MINIMAX_LANGUAGE_BOOST_OPTIONS = [
  "auto", "Afrikaans", "Arabic", "Bengali", "Bulgarian", "Catalan",
  "Chinese", "Chinese,Yue", "Croatian", "Czech", "Danish", "Dutch",
  "English", "Filipino", "Finnish", "French", "Georgian", "German",
  "Greek", "Gujarati", "Hebrew", "Hindi", "Hungarian", "Indonesian",
  "Italian", "Japanese", "Kannada", "Korean", "Malay", "Malayalam",
  "Marathi", "Māori", "Norwegian", "Nynorsk", "Persian", "Polish",
  "Portuguese", "Punjabi", "Romanian", "Russian", "Slovak", "Slovenian",
  "Spanish", "Swedish", "Tagalog", "Tamil", "Telugu", "Thai", "Turkish",
  "Ukrainian", "Vietnamese",
].map((language) => ({
  value: language,
  label: language === "auto" ? "Auto (automatic detection)" : language,
}));

const XAI_LANGUAGE_OPTIONS = [
  ["auto", "Auto (automatic detection)"],
  ["en", "English"],
  ["ar-EG", "Arabic (Egypt)"],
  ["ar-SA", "Arabic (Saudi Arabia)"],
  ["ar-AE", "Arabic (United Arab Emirates)"],
  ["bn", "Bengali"],
  ["zh", "Chinese (Simplified)"],
  ["fr", "French"],
  ["de", "German"],
  ["hi", "Hindi"],
  ["id", "Indonesian"],
  ["it", "Italian"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["pt-PT", "Portuguese (Portugal)"],
  ["ru", "Russian"],
  ["es-MX", "Spanish (Mexico)"],
  ["es-ES", "Spanish (Spain)"],
  ["tr", "Turkish"],
  ["vi", "Vietnamese"],
].map(([value, label]) => ({ value, label }));

/**
 * Pronunciation Dictionary dropdown — fetches list from API and lets user pick one
 */
function PronunciationDictSelect({ value, onChange }) {
  const [dicts, setDicts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/ai/pronunciation-dictionaries?page_size=100")
      .then((r) => r.json())
      .then((d) => setDicts(d?.data || []))
      .catch(() => setDicts([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Select
      value={value || "__none__"}
      onValueChange={(val) => onChange(val === "__none__" ? "" : val)}
    >
      <SelectTrigger className="w-full">
        {loading ? (
          <span className="text-muted-foreground text-sm">Loading…</span>
        ) : (
          <SelectValue placeholder="No dictionary selected" />
        )}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">No dictionary selected</SelectItem>
        {dicts.map((d) => (
          <SelectItem key={d.id} value={d.id}>
            {d.name}
            {d.items?.length !== undefined && (
              <span className="ml-2 text-xs text-muted-foreground">({d.items.length} items)</span>
            )}
          </SelectItem>
        ))}
        {!loading && dicts.length === 0 && (
          <div className="px-2 py-3 text-xs text-muted-foreground text-center">
            No dictionaries yet.{" "}
            <Link href="/admin/ai-assistants/pronunciation-dictionaries" className="underline">Create one</Link>.
          </div>
        )}
      </SelectContent>
    </Select>
  );
}

export default function TtsVoicePicker({ value, onChange }) {
  const voice = value?.voice || "";
  const voice_speed = value?.voice_speed ?? 1;
  const voice_api_key_ref = value?.voice_api_key_ref || "";
  const elevenlabs_settings = value?.elevenlabs_settings || {};
  const language_boost = value?.language_boost || "";
  const voice_language = value?.voice_language || "";
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [voiceName, setVoiceName] = useState("");
  const [sampleText, setSampleText] = useState(
    "Hello! This is a sample message to check my voice quality."
  );
  const [genderFilter, setGenderFilter] = useState("");
  const [languageFilter, setLanguageFilter] = useState("");
  const [languageSearch, setLanguageSearch] = useState("");
  const [languagePopoverOpen, setLanguagePopoverOpen] = useState(false);
  const [
    transcriptionLanguagePopoverOpen,
    setTranscriptionLanguagePopoverOpen,
  ] = useState(false);
  const [transcriptionLanguageSearch, setTranscriptionLanguageSearch] =
    useState("");
  const [loading, setLoading] = useState(false);
  const [translating, setTranslating] = useState(false);
  // ElevenLabs API key ref state
  const [voiceApiKeyRef, setVoiceApiKeyRef] = useState(voice_api_key_ref);
  // Microphone overlay is provided inline via <MicOverlay/>
  const audioRef = useRef(null);
  const syncingRef = useRef(false);

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

  const {
    provider: pInit,
    model: mInit,
    voiceName: vInit,
  } = useMemo(() => parseVoiceString(voice, providers), [voice, providers]);

  useEffect(() => {
    // Sync internal state from controlled prop (voice)
    syncingRef.current = true;
    setProvider((prev) => (prev !== pInit ? pInit : prev));
    setModel((prev) => (prev !== mInit ? mInit : prev));
    setVoiceName((prev) => (prev !== vInit ? vInit : prev));
  }, [pInit, mInit, vInit]);

  useEffect(() => {
    // Clear syncing flag once internal state matches prop-derived values
    if (
      syncingRef.current &&
      provider === pInit &&
      model === mInit &&
      voiceName === vInit
    ) {
      syncingRef.current = false;
    }
  }, [provider, model, voiceName, pInit, mInit, vInit]);

  useEffect(() => {
    async function loadVoices() {
      try {
        const res = await fetch("/api/tts/voices", { cache: "no-store" });
        const data = await res.json();
        if (res.ok && data?.ok) setProviders(data.providers || []);
      } catch (_) {}
    }
    loadVoices();
  }, []);

  // Sync voiceApiKeyRef from props
  useEffect(() => {
    setVoiceApiKeyRef(voice_api_key_ref);
  }, [voice_api_key_ref]);

  const filteredProviders = useMemo(() => {
    if (!languageFilter && !genderFilter) return providers;
    const out = [];
    for (const p of providers) {
      const filteredModels = [];
      for (const m of p.models || []) {
        const vs = (m.voices || []).filter((v) => {
          const langOk = languageFilter
            ? normalizeLocaleCode(v?.language) === languageFilter
            : true;
          const genderOk = genderFilter
            ? String(v?.gender || "").toLowerCase() ===
              String(genderFilter || "").toLowerCase()
            : true;
          return langOk && genderOk;
        });
        if (vs.length) filteredModels.push({ ...m, voices: vs });
      }
      if (filteredModels.length) out.push({ ...p, models: filteredModels });
    }
    return out;
  }, [providers, languageFilter, genderFilter]);

  useEffect(() => {
    // Auto-align provider with language filter if current provider has no coverage
    if (!languageFilter) return;
    const exists = filteredProviders.some((p) => p.id === provider);
    if (!exists) {
      setProvider(filteredProviders[0]?.id || "");
      setModel("");
      setVoiceName("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [languageFilter, filteredProviders]);

  useEffect(() => {
    // Auto-translate sample text when language changes
    if (languageFilter && sampleText.trim()) {
      translateSampleText(languageFilter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [languageFilter]);

  const models = useMemo(() => {
    const p = filteredProviders.find((x) => x.id === provider);
    return p ? p.models : [];
  }, [filteredProviders, provider]);

  const allVoices = useMemo(() => {
    const out = [];
    for (const p of providers) {
      for (const m of p.models || []) {
        for (const v of m.voices || []) out.push(v);
      }
    }
    return out;
  }, [providers]);

  const languageOptions = useMemo(() => {
    const base = genderFilter
      ? allVoices.filter(
          (v) =>
            String(v?.gender || "").toLowerCase() ===
            String(genderFilter || "").toLowerCase()
        )
      : allVoices;
    const map = new Map(); // key: normalized code -> { value, label, flag }
    let langNames = null;
    let regionNames = null;
    try {
      langNames = new Intl.DisplayNames(undefined, { type: "language" });
      regionNames = new Intl.DisplayNames(undefined, { type: "region" });
    } catch (_) {}
    for (const v of base) {
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
  }, [allVoices, genderFilter]);

  const filteredLanguageOptions = useMemo(() => {
    if (!languageSearch.trim()) return languageOptions;
    const search = languageSearch.toLowerCase();
    return languageOptions.filter(
      (option) =>
        option.label.toLowerCase().includes(search) ||
        option.value.toLowerCase().includes(search)
    );
  }, [languageOptions, languageSearch]);

  const genderOptions = useMemo(() => {
    const base = languageFilter
      ? allVoices.filter(
          (v) => normalizeLocaleCode(v?.language) === languageFilter
        )
      : allVoices;
    const map = new Map(); // key: lowercase, value: display label
    for (const v of base) {
      const raw = String(v?.gender || "").trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (!map.has(key)) {
        const label = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
        map.set(key, label);
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label }));
  }, [allVoices, languageFilter]);

  const voices = useMemo(() => {
    const m = models.find((x) => x.id === model);
    let list = m ? m.voices : [];
    if (genderFilter)
      list = list.filter(
        (v) =>
          String(v.gender || "").toLowerCase() === genderFilter.toLowerCase()
      );
    if (languageFilter)
      list = list.filter(
        (v) => normalizeLocaleCode(v?.language) === languageFilter
      );
    // Deduplicate by voice id to avoid duplicate keys and values
    const seen = new Set();
    const unique = [];
    for (const v of list) {
      const id = String(v?.id || "");
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(v);
    }
    return unique;
  }, [models, model, genderFilter, languageFilter]);

  function emitChange(next) {
    if (next !== voice) {
      const normalizedProvider = provider.toLowerCase();
      onChange?.({
        voice: next,
        voice_speed,
        voice_api_key_ref: voiceApiKeyRef,
        elevenlabs_settings:
          Object.keys(elevenlabs_settings).length > 0 ? elevenlabs_settings : undefined,
        language_boost: normalizedProvider.includes("minimax")
          ? language_boost || "auto"
          : language_boost || undefined,
        voice_language: normalizedProvider === "xai"
          ? voice_language || "auto"
          : voice_language || undefined,
      });
    }
  }

  function handleApiKeyRefChange(newApiKeyRef) {
    setVoiceApiKeyRef(newApiKeyRef);
    onChange?.({
      voice,
      voice_speed,
      voice_api_key_ref: newApiKeyRef,
      elevenlabs_settings:
        Object.keys(elevenlabs_settings).length > 0 ? elevenlabs_settings : undefined,
      language_boost: language_boost || undefined,
    });
  }

  function handleElevenLabsSettingChange(key, val) {
    const next = { ...elevenlabs_settings, [key]: val };
    onChange?.({
      voice,
      voice_speed: key === "speed" ? Number(val) : voice_speed,
      voice_api_key_ref: voiceApiKeyRef,
      elevenlabs_settings: next,
      language_boost: language_boost || undefined,
    });
  }

  function handleLanguageBoostChange(val) {
    onChange?.({
      voice,
      voice_speed,
      voice_api_key_ref: voiceApiKeyRef,
      elevenlabs_settings:
        Object.keys(elevenlabs_settings).length > 0 ? elevenlabs_settings : undefined,
      language_boost: val,
    });
  }

  function handleVoiceLanguageChange(val) {
    onChange?.({
      voice,
      voice_speed,
      voice_api_key_ref: voiceApiKeyRef,
      voice_language: val,
    });
  }

  useEffect(() => {
    // Only emit when a specific voice id is selected
    if (syncingRef.current) return;
    if (!voiceName) return;
    const next = voiceName; // voiceName holds the upstream voice id
    if (next !== voice) emitChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceName]);

  function setSpeed(next) {
    const current = voice_speed;
    if (Number(next) === Number(current)) return;
    onChange?.({
      voice,
      voice_speed: next,
      voice_api_key_ref: voiceApiKeyRef,
    });
  }

  async function translateSampleText(targetLanguage) {
    if (!sampleText.trim() || !targetLanguage || targetLanguage === "auto")
      return;

    try {
      setTranslating(true);
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          text: sampleText,
          targetLanguage,
          sourceLanguage: "auto",
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.translatedText) {
          setSampleText(data.translatedText);
        }
      } else {
        notify({ title: "Translation failed", variant: "error" });
      }
    } catch (error) {
      console.error("Translation failed:", error);
      notify({ title: "Translation failed", variant: "error" });
    } finally {
      setTranslating(false);
    }
  }

  async function playSample() {
    try {
      // Prefer upstream voice id if available; fallback to derived string
      let voiceId = "";
      try {
        const currentModel = models.find((x) => x.id === model);
        const candidate = (currentModel?.voices || []).find((v) => {
          const name = String(v?.name || "");
          const id = String(v?.id || "");
          return (
            (voiceName && name.toLowerCase() === voiceName.toLowerCase()) ||
            (voiceName && id.toLowerCase() === voiceName.toLowerCase())
          );
        });
        voiceId = String(candidate?.id || "");
      } catch (_) {}
      const vs =
        voice ||
        voiceId ||
        voiceName ||
        buildVoiceString(provider, model, voiceName);
      if (!vs) return;
      setLoading(true);
      const res = await fetch("/api/tts/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
        cache: "no-store",
        body: JSON.stringify({
          voice: vs,
          text: sampleText || "Hello!",
          voice_api_key_ref: voiceApiKeyRef,
            voice_speed: voice_speed,
            voice_language: provider.toLowerCase() === "xai"
              ? voice_language || "auto"
              : undefined,
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
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
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.src = url;
        await audioRef.current.play();
      }
    } catch (err) {
      console.error("Failed to play sample:", err);
      notify({ title: err?.message || "Failed to generate speech", variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  // MicOverlay will call onAppend with pre-formatted deltas; simply append.

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section className="overflow-hidden rounded-xl border bg-card shadow-sm xl:col-span-2">
        <div className="flex items-start gap-3 border-b bg-muted/30 px-4 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-orange-500/10">
            <IconVolume className="size-5 text-orange-500" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Text-to-Speech (TTS)</h3>
            <p className="text-xs text-muted-foreground">Choose the assistant voice, delivery style, and pronunciation.</p>
          </div>
        </div>
        <div className="space-y-4 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="col-span-full text-xs font-medium text-muted-foreground">Catalog filters</div>
        <div>
          <label className="text-xs">Language</label>
          <Popover
            open={languagePopoverOpen}
            onOpenChange={setLanguagePopoverOpen}
          >
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                className="w-full h-10 justify-between text-sm font-normal"
              >
                {languageFilter ? (
                  <span className="flex items-center gap-2">
                    <span>
                      {
                        languageOptions.find(
                          (opt) => opt.value === languageFilter
                        )?.flag
                      }
                    </span>
                    <span>
                      {languageOptions.find(
                        (opt) => opt.value === languageFilter
                      )?.label || languageFilter}
                    </span>
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <IconWorld className="size-4" />
                    <span>Any</span>
                  </span>
                )}
                <IconSelector className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[320px] p-0">
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
                    onSelect={() => {
                      setLanguageFilter("");
                      setLanguagePopoverOpen(false);
                    }}
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
                      onSelect={() => {
                        setLanguageFilter(opt.value);
                        setLanguagePopoverOpen(false);
                      }}
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
        </div>
        <div>
          <label className="text-xs">Gender</label>
          <Select
            value={genderFilter === "" ? "__any__" : genderFilter}
            onValueChange={(val) =>
              setGenderFilter(val === "__any__" ? "" : val)
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">Any</SelectItem>
              {genderOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Provider, Model, Voice, API Key, and Voice Speed in one row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="text-xs">Provider</label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              {filteredProviders
                .filter((p) => p?.id)
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        {/* Show API Key Ref selector when ElevenLabs is selected */}
        {provider.toLowerCase() === "elevenlabs" && (
          <div>
            <label className="text-xs">
              ElevenLabs API Key Reference{" "}
              <span className="text-red-500">*</span>
            </label>
            <SecretsCombobox
              value={voiceApiKeyRef}
              onChange={handleApiKeyRefChange}
            />
          </div>
        )}

        <div>
          <label className="text-xs">Model</label>
          <Select
            value={model === "" ? "__default__" : model}
            onValueChange={(val) => setModel(val === "__default__" ? "" : val)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent>
              {models.some((m) => !m?.id) && (
                <SelectItem value="__default__">Default</SelectItem>
              )}
              {models
                .filter((m) => m?.id)
                .map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name || m.id}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-xs">
            Voice <span className="text-red-500">*</span>
          </label>
          <Select value={voiceName} onValueChange={setVoiceName}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select voice" />
            </SelectTrigger>
            <SelectContent>
              {voices
                .map((v) => {
                  const name = String(v?.name || "");
                  const id = String(v?.id || "");
                  if (!id) return null;
                  return (
                    <SelectItem key={id} value={id}>
                      {name || id}
                    </SelectItem>
                  );
                })
                .filter(Boolean)}
            </SelectContent>
          </Select>
        </div>

        {provider.toLowerCase().includes("minimax") && (
          <div>
            <label className="text-xs">Language Boost</label>
            <Select
              value={language_boost || "auto"}
              onValueChange={handleLanguageBoostChange}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select language boost" />
              </SelectTrigger>
              <SelectContent>
                {MINIMAX_LANGUAGE_BOOST_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {provider.toLowerCase() === "xai" && (
          <div>
            <label className="text-xs">Language</label>
            <Select
              value={voice_language || "auto"}
              onValueChange={handleVoiceLanguageChange}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select language" />
              </SelectTrigger>
              <SelectContent>
                {XAI_LANGUAGE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Voice Speed - show for Telnyx Natural, NaturalHD and Ultra models */}
        {provider.toLowerCase() === "telnyx" &&
          (model.toLowerCase() === "natural" ||
            model.toLowerCase() === "naturalhd" ||
            model.toLowerCase() === "ultra") && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs">Voice Speed</label>
                <Badge variant="secondary" className="text-xs">
                  {voice_speed.toFixed(2)}x
                </Badge>
              </div>
              <div className="relative pt-6">
                <Slider
                  min={0.25}
                  max={2}
                  step={0.05}
                  value={[voice_speed]}
                  onValueChange={(vals) => setSpeed(Number(vals[0].toFixed(2)))}
                />
                <div className="flex justify-between text-xs text-gray-500 mt-2">
                  <span>0.25</span>
                  <span>2.0</span>
                </div>
              </div>
            </div>
          )}
      </div>

      {/* Expressive Mode - only for Telnyx Ultra */}
      {provider.toLowerCase() === "telnyx" &&
        model.toLowerCase() === "ultra" && (
          <div className="flex items-center gap-3 mt-2">
            <Switch
              id="expressive-mode"
              checked={value?.expressive_mode ?? false}
              onCheckedChange={(checked) =>
                onChange?.({
                  voice,
                  voice_speed,
                  voice_api_key_ref: voiceApiKeyRef,
                  transcription: value?.transcription,
                  language_boost: value?.language_boost,
                  expressive_mode: checked,
                  pronunciation_dict_id: value?.pronunciation_dict_id,
                })
              }
            />
            <div className="flex items-center gap-1.5">
              <label htmlFor="expressive-mode" className="text-sm font-medium cursor-pointer">Expressive Mode</label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    Enables emotionally expressive speech using SSML emotion tags.<br />
                    The assistant uses tones like excited, content, or calm to add nuance.<br />
                    Only supported for Telnyx Ultra voices.
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}

      {/* ElevenLabs Advanced Settings */}
      {provider.toLowerCase() === "elevenlabs" && (
        <div className="border rounded-md p-4 space-y-4 bg-muted/20">
          <div className="text-sm font-medium">ElevenLabs Advanced Settings</div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs">Temperature</label>
              <Badge variant="secondary" className="text-xs">
                {(elevenlabs_settings?.temperature ?? 0.5).toFixed(2)}
              </Badge>
            </div>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={[elevenlabs_settings?.temperature ?? 0.5]}
              onValueChange={([val]) =>
                handleElevenLabsSettingChange("temperature", Number(val.toFixed(2)))
              }
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0</span>
              <span>1</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Controls voice stability vs expressiveness.
            </p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs">Similarity Boost</label>
              <Badge variant="secondary" className="text-xs">
                {(elevenlabs_settings?.similarity_boost ?? 0.75).toFixed(2)}
              </Badge>
            </div>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={[elevenlabs_settings?.similarity_boost ?? 0.75]}
              onValueChange={([val]) =>
                handleElevenLabsSettingChange("similarity_boost", Number(val.toFixed(2)))
              }
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0</span>
              <span>1</span>
            </div>
            <p className="text-xs text-muted-foreground">
              How closely the AI voice matches the target voice.
            </p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs">Speed</label>
              <Badge variant="secondary" className="text-xs">
                {(elevenlabs_settings?.speed ?? voice_speed ?? 1.0).toFixed(2)}x
              </Badge>
            </div>
            <Slider
              min={0.7}
              max={1.3}
              step={0.05}
              value={[elevenlabs_settings?.speed ?? voice_speed ?? 1.0]}
              onValueChange={([val]) =>
                handleElevenLabsSettingChange("speed", Number(val.toFixed(2)))
              }
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0.7</span>
              <span>1.3</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Speech velocity (separate from Voice Speed).
            </p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs">Style</label>
              <Badge variant="secondary" className="text-xs">
                {(elevenlabs_settings?.style ?? 0.0).toFixed(2)}
              </Badge>
            </div>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={[elevenlabs_settings?.style ?? 0.0]}
              onValueChange={([val]) =>
                handleElevenLabsSettingChange("style", Number(val.toFixed(2)))
              }
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0</span>
              <span>1</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Controls style exaggeration. Higher values are more expressive.
            </p>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div>
              <label className="text-xs font-medium">Speaker Boost</label>
              <p className="text-xs text-muted-foreground">
                Increases similarity to the original speaker voice.
              </p>
            </div>
            <Switch
              checked={elevenlabs_settings?.use_speaker_boost ?? true}
              onCheckedChange={(checked) =>
                handleElevenLabsSettingChange("use_speaker_boost", checked)
              }
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <label className="text-xs">
            Sample text
            {translating && (
              <span className="ml-2 text-xs text-blue-500">Translating...</span>
            )}
          </label>
          <MicOverlay
            onAppend={(delta) =>
              setSampleText((prev) =>
                prev ? `${prev}${delta}` : String(delta)
              )
            }
            onSet={(val) => setSampleText(val)}
          >
            <Input
              value={sampleText}
              onChange={(e) => setSampleText(e.target.value)}
              placeholder="Type text to preview"
              disabled={translating}
            />
          </MicOverlay>
        </div>
        <div className="flex gap-2 items-center">
          <Button
            type="button"
            onClick={playSample}
            disabled={
              loading ||
              !voiceName ||
              (provider === "ElevenLabs" && !voiceApiKeyRef)
            }
          >
            {loading ? "Generating…" : "Play Sample"}
          </Button>
          <audio ref={audioRef} controls className="hidden" />
        </div>
      </div>

      {/* Pronunciation Dictionary */}
      <div className="space-y-1.5 rounded-lg border bg-muted/15 p-3">
        <div className="flex items-center gap-1.5">
          <label className="text-xs font-medium">Pronunciation Dictionary</label>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconInfoCircle className="size-3.5 text-gray-400 cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p>Control how your assistant pronounces specific words.<br />Create and manage dictionaries in Pronunciation Dictionaries.</p>
            </TooltipContent>
          </Tooltip>
        </div>
        <PronunciationDictSelect
          value={value?.pronunciation_dict_id || ""}
          onChange={(dictId) =>
            onChange?.({
              voice,
              voice_speed,
              voice_api_key_ref: voiceApiKeyRef,
              transcription: value?.transcription,
              language_boost: value?.language_boost,
              expressive_mode: value?.expressive_mode,
              pronunciation_dict_id: dictId || undefined,
            })
          }
        />
        <p className="text-xs text-muted-foreground">
          Control how your assistant pronounces specific words.{" "}
          <Link href="/admin/ai-assistants/pronunciation-dictionaries" className="underline text-primary">
            Create and manage dictionaries
          </Link>
          .
        </p>
      </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border bg-card shadow-sm xl:col-span-2">
        <div className="flex items-start gap-3 border-b bg-muted/30 px-4 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10">
            <IconWaveSine className="size-5 text-sky-500" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Speech-to-Text (STT)</h3>
            <p className="text-xs text-muted-foreground">Configure transcription, language detection, and endpointing.</p>
          </div>
        </div>
        <div className="space-y-4 p-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
        <div className="w-full">
          <label className="text-xs">
            Transcription provider <span className="text-red-500">*</span>
          </label>
          <Select
            value={String(value?.transcription?.model || "")}
            onValueChange={(val) => {
              const isDeepgram =
                val === "deepgram/nova-2" || val === "deepgram/nova-3";
              const isDeepgramFlux = val === "deepgram/flux";
              const newTranscription = {
                ...(value?.transcription || {}),
                model: val,
              };
              // Initialize settings with defaults for Deepgram models
              if (isDeepgram && !value?.transcription?.settings) {
                newTranscription.settings = {
                  smart_format: true,
                  numerals: true,
                };
              }
              // Initialize settings with defaults for Deepgram Flux
              if (isDeepgramFlux && !value?.transcription?.settings) {
                newTranscription.settings = {
                  smart_format: true,
                  numerals: true,
                  eot_threshold: 0.8,
                  eot_timeout_ms: 5000,
                  eager_eot_threshold: 0.3,
                };
              }
              onChange?.({
                voice,
                voice_speed,
                voice_api_key_ref: voiceApiKeyRef,
                transcription: newTranscription,
              });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select transcription" />
            </SelectTrigger>
            <SelectContent>
              {TRANSCRIPTION_PROVIDERS.map((p) => (
                <SelectItem key={p.model_name} value={p.model_name}>
                  {p.model_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-full">
          {(() => {
            const selected = TRANSCRIPTION_PROVIDERS.find(
              (p) => p.model_name === value?.transcription?.model
            );
            const langs = Array.isArray(selected?.languages)
              ? selected.languages
              : [];
            if (langs.length === 0) return null;
            const hasAuto = Array.isArray(langs)
              ? langs.some((l) => String(l).toLowerCase() === "auto")
              : false;
            const selectedLangValue = String(
              value?.transcription?.language || (hasAuto ? "" : "__any__")
            );

            // Build display like voice providers (flag + language names)
            const items = [];
            const seen = new Set();
            try {
              const languageNames = new Intl.DisplayNames(undefined, {
                type: "language",
              });
              const regionNames = new Intl.DisplayNames(undefined, {
                type: "region",
              });
              const scriptNames = new Intl.DisplayNames(undefined, {
                type: "script",
              });

              const regionAlias = { 419: "MX" }; // Latin America → use MX flag
              const regionToFlag = (region) => {
                let r = String(region || "").toUpperCase();
                if (/^\d{3}$/.test(r)) r = regionAlias[r] || "";
                if (!/^[A-Z]{2}$/.test(r)) return "🌐";
                const cps = [...r].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
                return String.fromCodePoint(...cps);
              };

              const defaultRegionForLanguage = (lang) => {
                const m = {
                  // Core Western languages
                  en: "US",
                  es: "ES",
                  fr: "FR",
                  de: "DE",
                  it: "IT",
                  pt: "PT",
                  nl: "NL",
                  sv: "SE",
                  da: "DK",
                  fi: "FI",
                  no: "NO",
                  et: "EE",
                  pl: "PL",
                  ro: "RO",
                  cs: "CZ",
                  sk: "SK",
                  sl: "SI",
                  hu: "HU",
                  lt: "LT",
                  lv: "LV",
                  is: "IS",
                  ga: "IE",
                  gd: "GB",
                  oc: "FR",
                  br: "FR",
                  gl: "ES",
                  fy: "NL",
                  fo: "FO",
                  // Balkans & Eastern Europe
                  bs: "BA",
                  sq: "AL",
                  hr: "HR",
                  sr: "RS",
                  bg: "BG",
                  mk: "MK",
                  be: "BY",
                  ba: "RU",
                  ru: "RU",
                  uk: "UA",
                  // Caucasus & Central Asia
                  ka: "GE",
                  az: "AZ",
                  kk: "KZ",
                  ky: "KG",
                  tg: "TJ",
                  uz: "UZ",
                  tt: "RU",
                  tk: "TM",
                  // Middle East & North Africa / South Asia
                  ar: "SA",
                  he: "IL",
                  fa: "IR",
                  ur: "PK",
                  ps: "AF",
                  tr: "TR",
                  hi: "IN",
                  bn: "BD",
                  pa: "IN",
                  ta: "IN",
                  te: "IN",
                  gu: "IN",
                  kn: "IN",
                  ml: "IN",
                  mr: "IN",
                  or: "IN",
                  as: "IN",
                  sa: "IN",
                  // East & Southeast Asia
                  zh: "CN",
                  yue: "HK",
                  ja: "JP",
                  ko: "KR",
                  id: "ID",
                  jv: "ID",
                  su: "ID",
                  th: "TH",
                  vi: "VN",
                  km: "KH",
                  lo: "LA",
                  my: "MM",
                  mn: "MN",
                  // Africa
                  sw: "KE",
                  ha: "NG",
                  yo: "NG",
                  xh: "ZA",
                  zu: "ZA",
                  so: "SO",
                  mg: "MG",
                  // Americas & Islands
                  ht: "HT",
                  mi: "NZ",
                  // Miscellaneous
                  am: "ET",
                  hy: "AM",
                  eu: "ES",
                  ca: "ES",
                  ku: "IQ",
                  la: "VA",
                  lb: "LU",
                  mt: "MT",
                  ms: "MY",
                  ne: "NP",
                  nn: "NO",
                  oc: "FR",
                  cy: "GB",
                  sn: "ZW",
                  sd: "PK",
                  si: "LK",
                  st: "LS",
                  tk: "TM",
                  ug: "CN",
                  yi: "IL",
                  kk: "KZ",
                  tw: "GH",
                  mk: "MK",
                };
                return m[lang] || null;
              };

              const prettyCase = (s) =>
                String(s || "")
                  .slice(0, 1)
                  .toUpperCase() +
                String(s || "")
                  .slice(1)
                  .toLowerCase();

              for (const raw0 of langs) {
                const raw = String(raw0 || "").trim();
                if (!raw) continue;

                // Special handling for auto and multi modes
                if (/^auto$/i.test(raw)) {
                  if (!seen.has("auto")) {
                    items.push({
                      value: "auto",
                      label: "Auto (experimental)",
                      flag: "🌐",
                    });
                    seen.add("auto");
                  }
                  continue;
                }

                if (/^multi$/i.test(raw)) {
                  if (!seen.has("multi")) {
                    items.push({
                      value: "multi",
                      label: "Multilingual (No audio hint)",
                      flag: "🌐",
                    });
                    seen.add("multi");
                  }
                  continue;
                }

                // Normalize IETF tag separators
                const tag = raw.replace(/_/g, "-");
                const parts = tag.split("-");
                const language = String(parts[0] || "").toLowerCase();
                let script = null;
                let region = null;
                for (let i = 1; i < parts.length; i++) {
                  const sub = parts[i];
                  if (/^[A-Za-z]{4}$/.test(sub)) {
                    script = prettyCase(sub);
                  } else if (/^[A-Za-z]{2}$/.test(sub)) {
                    region = sub.toUpperCase();
                  } else if (/^\d{3}$/.test(sub)) {
                    // Region like 419 (Latin America). Map to a representative country for flag.
                    region = { 419: "MX" }[sub] || null;
                  }
                }

                // Label for base language
                let langLabel =
                  language === "yue"
                    ? "Cantonese"
                    : languageNames?.of(language) || language.toUpperCase();

                // Optional script label
                let scriptLabel = script
                  ? scriptNames?.of(script) || script
                  : null;

                // Default region for script-only Chinese variants
                if (!region && language === "zh" && script) {
                  if (script.toLowerCase() === "hans") region = "CN";
                  if (script.toLowerCase() === "hant") region = "TW";
                }

                // If region exists, append pretty region name
                let fullLabel = langLabel;
                if (scriptLabel && region) {
                  fullLabel = `${langLabel} (${scriptLabel}, ${
                    regionNames?.of(region) || region
                  })`;
                } else if (scriptLabel) {
                  fullLabel = `${langLabel} (${scriptLabel})`;
                } else if (region) {
                  fullLabel = `${langLabel} (${
                    regionNames?.of(region) || region
                  })`;
                }

                // Determine flag
                let flag = "";
                if (region) flag = regionToFlag(region);
                else {
                  const def = defaultRegionForLanguage(language);
                  flag = def ? regionToFlag(def) : "🌐";
                }

                const key = tag.toLowerCase();
                if (!seen.has(key)) {
                  items.push({
                    value: raw,
                    label: fullLabel,
                    flag,
                  });
                  seen.add(key);
                }
              }
            } catch (_) {}

            return (
              <>
                <label className="text-xs">Language</label>
                <Popover
                  open={transcriptionLanguagePopoverOpen}
                  onOpenChange={setTranscriptionLanguagePopoverOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      className="w-full h-10 justify-between text-sm font-normal"
                    >
                      {(() => {
                        const selectedItem = items.find(
                          (item) => item.value === selectedLangValue
                        );

                        if (selectedItem) {
                          return (
                            <span className="flex items-center gap-2">
                              <span>{selectedItem.flag}</span>
                              <span>{selectedItem.label}</span>
                            </span>
                          );
                        }

                        return hasAuto ? (
                          <span className="flex items-center gap-2">
                            <IconWorld className="size-4" />
                            <span>Auto</span>
                          </span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <IconWorld className="size-4" />
                            <span>Any</span>
                          </span>
                        );
                      })()}
                      <IconSelector className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[400px] p-0">
                    <Command shouldFilter={false}>
                      <CommandInput
                        placeholder="Search languages..."
                        value={transcriptionLanguageSearch}
                        onValueChange={setTranscriptionLanguageSearch}
                        className="h-9"
                      />
                      <CommandEmpty>
                        {transcriptionLanguageSearch.trim()
                          ? "No language found."
                          : "Type to search languages..."}
                      </CommandEmpty>
                      <CommandGroup className="max-h-[300px] overflow-auto">
                        {(() => {
                          // Filter items based on search
                          const filteredItems =
                            transcriptionLanguageSearch.trim()
                              ? items.filter(
                                  (item) =>
                                    item.label
                                      .toLowerCase()
                                      .includes(
                                        transcriptionLanguageSearch.toLowerCase()
                                      ) ||
                                    item.value
                                      .toLowerCase()
                                      .includes(
                                        transcriptionLanguageSearch.toLowerCase()
                                      )
                                )
                              : items;

                          return (
                            <>
                              {!hasAuto && (
                                <CommandItem
                                  value="__any__"
                                  onSelect={() => {
                                    onChange?.({
                                      voice,
                                      voice_speed,
                                      voice_api_key_ref: voiceApiKeyRef,
                                      transcription: {
                                        ...(value?.transcription || {}),
                                        language: "",
                                      },
                                    });
                                    setTranscriptionLanguagePopoverOpen(false);
                                  }}
                                >
                                  <IconCheck
                                    className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${
                                      selectedLangValue === "__any__" ||
                                      !selectedLangValue
                                        ? "opacity-100"
                                        : "opacity-0"
                                    }`}
                                  />
                                  <IconWorld className="size-4 mr-2" />
                                  <span>Any</span>
                                </CommandItem>
                              )}
                              {filteredItems.map((opt) => (
                                <CommandItem
                                  key={opt.value}
                                  value={`${opt.label}-${opt.value}`}
                                  onSelect={() => {
                                    onChange?.({
                                      voice,
                                      voice_speed,
                                      voice_api_key_ref: voiceApiKeyRef,
                                      transcription: {
                                        ...(value?.transcription || {}),
                                        language: opt.value,
                                      },
                                    });
                                    setTranscriptionLanguagePopoverOpen(false);
                                  }}
                                >
                                  <IconCheck
                                    className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${
                                      selectedLangValue === opt.value
                                        ? "opacity-100"
                                        : "opacity-0"
                                    }`}
                                  />
                                  <span className="mr-2">{opt.flag}</span>
                                  <span>{opt.label}</span>
                                </CommandItem>
                              ))}
                            </>
                          );
                        })()}
                      </CommandGroup>
                    </Command>
                  </PopoverContent>
                </Popover>
              </>
            );
          })()}
        </div>
      </div>

      {/* Deepgram-specific switches in second row */}
      {(value?.transcription?.model === "deepgram/nova-2" ||
        value?.transcription?.model === "deepgram/nova-3" ||
        value?.transcription?.model === "deepgram/flux") && (
        <div className="flex gap-6 items-center mt-3">
          <div className="flex items-center gap-2">
            <Switch
              id="smart_format"
              checked={value?.transcription?.settings?.smart_format ?? true}
              onCheckedChange={(checked) =>
                onChange?.({
                  voice,
                  voice_speed,
                  voice_api_key_ref: voiceApiKeyRef,
                  transcription: {
                    ...(value?.transcription || {}),
                    settings: {
                      ...(value?.transcription?.settings || {}),
                      smart_format: checked,
                    },
                  },
                })
              }
            />
            <label
              htmlFor="smart_format"
              className="text-sm font-medium leading-none cursor-pointer"
            >
              Smart Format
            </label>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  Automatically formats transcripts for improved readability.
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="numerals"
              checked={value?.transcription?.settings?.numerals ?? true}
              onCheckedChange={(checked) =>
                onChange?.({
                  voice,
                  voice_speed,
                  voice_api_key_ref: voiceApiKeyRef,
                  transcription: {
                    ...(value?.transcription || {}),
                    settings: {
                      ...(value?.transcription?.settings || {}),
                      numerals: checked,
                    },
                  },
                })
              }
            />
            <label
              htmlFor="numerals"
              className="text-sm font-medium leading-none cursor-pointer"
            >
              Numerals
            </label>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>Converts numbers from written form to numerical digits.</p>
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Deepgram Flux specific fields */}
          {value?.transcription?.model === "deepgram/flux" && (
            <>
              <div className="flex items-center gap-2">
                <label
                  htmlFor="eot_threshold"
                  className="text-sm font-medium leading-none"
                >
                  End-Of-Turn Threshold
                </label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      Confidence required to trigger an end of turn. Higher
                      values = more reliable turn detection but slightly
                      increased latency.
                    </p>
                  </TooltipContent>
                </Tooltip>
                <Input
                  id="eot_threshold"
                  type="number"
                  min={0.5}
                  max={0.9}
                  step={0.05}
                  value={value?.transcription?.settings?.eot_threshold ?? 0.8}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (val >= 0.5 && val <= 0.9) {
                      onChange?.({
                        voice,
                        voice_speed,
                        voice_api_key_ref: voiceApiKeyRef,
                        transcription: {
                          ...(value?.transcription || {}),
                          settings: {
                            ...(value?.transcription?.settings || {}),
                            eot_threshold: val,
                          },
                        },
                      });
                    }
                  }}
                  className="w-24"
                />
              </div>
              <div className="flex items-center gap-2">
                <label
                  htmlFor="eot_timeout_ms"
                  className="text-sm font-medium leading-none"
                >
                  End-Of-Turn Timeout (ms)
                </label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      Maximum milliseconds of silence before forcing an end of
                      turn, regardless of confidence.
                    </p>
                  </TooltipContent>
                </Tooltip>
                <Input
                  id="eot_timeout_ms"
                  type="number"
                  min={500}
                  max={10000}
                  step={100}
                  value={value?.transcription?.settings?.eot_timeout_ms ?? 5000}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    if (val >= 500 && val <= 10000) {
                      onChange?.({
                        voice,
                        voice_speed,
                        voice_api_key_ref: voiceApiKeyRef,
                        transcription: {
                          ...(value?.transcription || {}),
                          settings: {
                            ...(value?.transcription?.settings || {}),
                            eot_timeout_ms: val,
                          },
                        },
                      });
                    }
                  }}
                  className="w-24"
                />
              </div>
              <div className="flex items-center gap-2">
                <label
                  htmlFor="eager_eot_threshold"
                  className="text-sm font-medium leading-none"
                >
                  Eager EOT Threshold
                </label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      Confidence threshold for eager end-of-turn detection. Must be ≤ EOT Threshold. Setting equal to EOT Threshold disables eager detection. Range: 0.3–0.9.
                    </p>
                  </TooltipContent>
                </Tooltip>
                <Input
                  id="eager_eot_threshold"
                  type="number"
                  min={0.3}
                  max={0.9}
                  step={0.05}
                  value={value?.transcription?.settings?.eager_eot_threshold ?? 0.3}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (val >= 0.3 && val <= 0.9) {
                      onChange?.({
                        voice,
                        voice_speed,
                        voice_api_key_ref: voiceApiKeyRef,
                        transcription: {
                          ...(value?.transcription || {}),
                          settings: {
                            ...(value?.transcription?.settings || {}),
                            eager_eot_threshold: val,
                          },
                        },
                      });
                    }
                  }}
                  className="w-24"
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* Keyterm boost for nova-3 and flux */}
      {(value?.transcription?.model === "deepgram/nova-3" ||
        value?.transcription?.model === "deepgram/flux") && (
        <div className="mt-3">
          <label className="text-xs flex items-center gap-1">
            Keyterm Boost
            <Tooltip>
              <TooltipTrigger asChild>
                <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>Comma-separated terms to boost recognition accuracy for domain-specific vocabulary, proper nouns, or uncommon words. Example: Telnyx,VoIP,SIP</p>
              </TooltipContent>
            </Tooltip>
          </label>
          <Input
            className="mt-1 w-full"
            placeholder="e.g., Telnyx,VoIP,SIP"
            value={value?.transcription?.settings?.keyterm || ""}
            onChange={(e) =>
              onChange?.({
                voice,
                voice_speed,
                voice_api_key_ref: voiceApiKeyRef,
                transcription: {
                  ...(value?.transcription || {}),
                  settings: {
                    ...(value?.transcription?.settings || {}),
                    keyterm: e.target.value,
                  },
                },
              })
            }
          />
        </div>
      )}

      {/* AssemblyAI Universal Streaming specific settings */}
      {value?.transcription?.model === "assemblyai/universal-streaming" && (
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="text-xs flex items-center gap-1">
              End-of-Turn Confidence Threshold
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>Confidence threshold to detect end of turn. Higher = more reliable detection. Range: 0.1–0.9, default: 0.4</p>
                </TooltipContent>
              </Tooltip>
            </label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              className="mt-1 w-full"
              value={value?.transcription?.settings?.end_of_turn_confidence_threshold ?? 0.4}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (val >= 0 && val <= 1) {
                  onChange?.({
                    voice,
                    voice_speed,
                    voice_api_key_ref: voiceApiKeyRef,
                    transcription: {
                      ...(value?.transcription || {}),
                      settings: {
                        ...(value?.transcription?.settings || {}),
                        end_of_turn_confidence_threshold: val,
                      },
                    },
                  });
                }
              }}
            />
          </div>
          <div>
            <label className="text-xs flex items-center gap-1">
              Min Turn Silence (ms)
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>Minimum silence duration (ms) required to consider a turn ended.</p>
                </TooltipContent>
              </Tooltip>
            </label>
            <Input
              type="number"
              min={100}
              max={5000}
              step={100}
              className="mt-1 w-full"
              value={value?.transcription?.settings?.min_turn_silence ?? 500}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (val >= 100 && val <= 5000) {
                  onChange?.({
                    voice,
                    voice_speed,
                    voice_api_key_ref: voiceApiKeyRef,
                    transcription: {
                      ...(value?.transcription || {}),
                      settings: {
                        ...(value?.transcription?.settings || {}),
                        min_turn_silence: val,
                      },
                    },
                  });
                }
              }}
            />
          </div>
          <div>
            <label className="text-xs flex items-center gap-1">
              Max Turn Silence (ms)
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>Maximum silence duration (ms) before forcing end of turn detection.</p>
                </TooltipContent>
              </Tooltip>
            </label>
            <Input
              type="number"
              min={500}
              max={10000}
              step={100}
              className="mt-1 w-full"
              value={value?.transcription?.settings?.max_turn_silence ?? 2000}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (val >= 500 && val <= 10000) {
                  onChange?.({
                    voice,
                    voice_speed,
                    voice_api_key_ref: voiceApiKeyRef,
                    transcription: {
                      ...(value?.transcription || {}),
                      settings: {
                        ...(value?.transcription?.settings || {}),
                        max_turn_silence: val,
                      },
                    },
                  });
                }
              }}
            />
          </div>
        </div>
      )}

      {/* Azure STT region + API key */}
      {value?.transcription?.model?.startsWith("azure/") && (
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs">Azure Region <span className="text-red-500">*</span></label>
            <Select
              value={value?.transcription?.region || "__latency__"}
              onValueChange={(val) =>
                onChange?.({
                  voice,
                  voice_speed,
                  voice_api_key_ref: voiceApiKeyRef,
                  transcription: {
                    ...(value?.transcription || {}),
                    region: val === "__latency__" ? undefined : val,
                  },
                })
              }
            >
              <SelectTrigger className="w-full mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__latency__">Latency (Auto-select closest region)</SelectItem>
                <SelectItem value="australiaeast">Australia East</SelectItem>
                <SelectItem value="centralindia">Central India</SelectItem>
                <SelectItem value="eastus">East US</SelectItem>
                <SelectItem value="northcentralus">North Central US</SelectItem>
                <SelectItem value="westeurope">West Europe</SelectItem>
                <SelectItem value="westus2">West US 2</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Choose the region closest to your users.
            </p>
          </div>
          <div>
            <label className="text-xs">Azure API Key <span className="text-muted-foreground">(optional)</span></label>
            <div className="mt-1">
              <SecretsCombobox
                value={value?.transcription?.api_key_ref || ""}
                onChange={(ref) =>
                  onChange?.({
                    voice,
                    voice_speed,
                    voice_api_key_ref: voiceApiKeyRef,
                    transcription: {
                      ...(value?.transcription || {}),
                      api_key_ref: ref || undefined,
                    },
                  })
                }
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Optional — defaults available for some regions.
            </p>
          </div>
        </div>
      )}

        </div>
      </section>

      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="flex items-start gap-3 border-b bg-muted/30 px-4 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
            <IconVolume className="size-5 text-blue-500" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Call audio</h3>
            <p className="text-xs text-muted-foreground">Clean incoming audio and add an optional ambient track.</p>
          </div>
        </div>
        <div className="space-y-5 p-4">
      {/* Noise Suppression */}
      <div className="space-y-2 rounded-lg border bg-muted/15 p-3">
        <div className="flex items-center gap-2">
          <Switch
            id="noise-suppression-toggle"
            checked={!!value?.telephony?.noise_suppression && value?.telephony?.noise_suppression !== "disabled"}
            onCheckedChange={(checked) =>
              onChange?.({
                voice,
                voice_speed,
                voice_api_key_ref: voiceApiKeyRef,
                telephony: {
                  ...(value?.telephony || {}),
                  noise_suppression: checked ? "aicoustics" : null,
                },
              })
            }
          />
          <label htmlFor="noise-suppression-toggle" className="text-sm font-medium leading-none cursor-pointer">
            Noise Suppression
          </label>
        </div>

        {!!value?.telephony?.noise_suppression && value?.telephony?.noise_suppression !== "disabled" && (
          <>
            <Separator className="my-2" />
            <div className="flex items-center gap-3 flex-wrap">
              {/* Provider selector */}
              <Select
                value={value?.telephony?.noise_suppression || "krisp"}
                onValueChange={(val) =>
                  onChange?.({
                    voice,
                    voice_speed,
                    voice_api_key_ref: voiceApiKeyRef,
                    telephony: {
                      ...(value?.telephony || {}),
                      noise_suppression: val,
                      noise_suppression_config: val === "deepfilternet"
                        ? (value?.telephony?.noise_suppression_config || { attenuation_limit: 100, mode: "advanced" })
                        : val === "aicoustics"
                        ? (value?.telephony?.noise_suppression_config || { model: "voice_focus_2.0", enhancement_level: 0.8 })
                        : undefined,
                    },
                  })
                }
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="krisp">Krisp</SelectItem>
                  <SelectItem value="deepfilternet">Deepfilternet</SelectItem>
                  <SelectItem value="aicoustics">AiCoustics (recommended)</SelectItem>
                </SelectContent>
              </Select>

              {/* Deepfilternet-specific settings */}
              {value?.telephony?.noise_suppression === "deepfilternet" && (
                <>
                  <div className="flex items-center gap-2 shrink-0">
                    <label className="text-xs text-muted-foreground whitespace-nowrap">
                      Advanced
                    </label>
                    <Switch
                      checked={
                        value?.telephony?.noise_suppression_config?.mode ===
                        "advanced"
                      }
                      onCheckedChange={(checked) =>
                        onChange?.({
                          voice,
                          voice_speed,
                          voice_api_key_ref: voiceApiKeyRef,
                          telephony: {
                            ...(value?.telephony || {}),
                            noise_suppression_config: {
                              ...(value?.telephony?.noise_suppression_config || {}),
                              mode: checked ? "advanced" : undefined,
                            },
                          },
                        })
                      }
                    />
                  </div>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <label className="text-xs text-muted-foreground whitespace-nowrap">Attenuation</label>
                    <Slider
                      min={0}
                      max={100}
                      step={1}
                      value={[value?.telephony?.noise_suppression_config?.attenuation_limit ?? 100]}
                      onValueChange={([val]) =>
                        onChange?.({
                          voice,
                          voice_speed,
                          voice_api_key_ref: voiceApiKeyRef,
                          telephony: {
                            ...(value?.telephony || {}),
                            noise_suppression_config: {
                              ...(value?.telephony?.noise_suppression_config || {}),
                              attenuation_limit: val,
                            },
                          },
                        })
                      }
                      className="flex-1 min-w-0"
                    />
                    <span className="text-xs text-muted-foreground w-8 shrink-0">
                      {value?.telephony?.noise_suppression_config?.attenuation_limit ?? 100}%
                    </span>
                  </div>
                </>
              )}

              {/* AiCoustics-specific settings */}
              {value?.telephony?.noise_suppression === "aicoustics" && (
                <>
                  <div className="flex items-center gap-2 shrink-0">
                    <label className="text-xs text-muted-foreground whitespace-nowrap">Model</label>
                    <Select
                      value={value?.telephony?.noise_suppression_config?.model || "voice_focus_2.0"}
                      onValueChange={(val) =>
                        onChange?.({
                          voice,
                          voice_speed,
                          voice_api_key_ref: voiceApiKeyRef,
                          telephony: {
                            ...(value?.telephony || {}),
                            noise_suppression_config: {
                              ...(value?.telephony?.noise_suppression_config || {}),
                              model: val,
                            },
                          },
                        })
                      }
                    >
                      <SelectTrigger className="w-40 h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="voice_focus_2.0">Voice Focus 2.0</SelectItem>
                        <SelectItem value="voice_focus_1.0">Voice Focus 1.0</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <label className="text-xs text-muted-foreground whitespace-nowrap">Enhancement Level</label>
                    <Slider
                      min={0}
                      max={1}
                      step={0.1}
                      value={[value?.telephony?.noise_suppression_config?.enhancement_level ?? 0.8]}
                      onValueChange={([val]) =>
                        onChange?.({
                          voice,
                          voice_speed,
                          voice_api_key_ref: voiceApiKeyRef,
                          telephony: {
                            ...(value?.telephony || {}),
                            noise_suppression_config: {
                              ...(value?.telephony?.noise_suppression_config || {}),
                              enhancement_level: val,
                            },
                          },
                        })
                      }
                      className="flex-1 min-w-0"
                    />
                    <span className="text-xs text-muted-foreground w-8 shrink-0">
                      {value?.telephony?.noise_suppression_config?.enhancement_level ?? 0.8}
                    </span>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm font-semibold">
        <span>Background audio</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="text-xs">Background Audio Type</label>
          <Select
            value={value?.background_audio?.type || ""}
            onValueChange={(val) => {
              const currentValue =
                val === "predefined_media"
                  ? value?.background_audio?.value || "silence"
                  : val === "media_url"
                  ? value?.background_audio?.value || ""
                  : undefined;
              onChange?.({
                voice,
                voice_speed,
                voice_api_key_ref: voiceApiKeyRef,
                background_audio: {
                  type: val,
                  value: currentValue,
                  // Preserve volume only for predefined_media when not silence
                  ...(val === "predefined_media" &&
                  currentValue !== "silence" &&
                  currentValue
                    ? {
                        volume: value?.background_audio?.volume ?? 0.5,
                      }
                    : {}),
                },
              });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select background audio type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="predefined_media">Predefined Media</SelectItem>
              <SelectItem value="media_url">Custom Media URL</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {value?.background_audio?.type === "predefined_media" && (
          <div>
            <label className="text-xs">Predefined Media</label>
            <Select
              value={value?.background_audio?.value || "silence"}
              onValueChange={(val) =>
                onChange?.({
                  voice,
                  voice_speed,
                  voice_api_key_ref: voiceApiKeyRef,
                  background_audio: {
                    type: "predefined_media",
                    value: val,
                    // Preserve volume when changing media type, default to 0.5 if not set
                    volume:
                      val !== "silence"
                        ? value?.background_audio?.volume ?? 0.5
                        : undefined,
                  },
                })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select predefined media" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="silence">Silence</SelectItem>
                <SelectItem value="office">Office</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {value?.background_audio?.type === "media_url" && (
          <div>
            <label className="text-xs">Local Media Files</label>
            <CustomMediaUrlSelector
              value={value?.background_audio?.value || ""}
              onChange={(url) =>
                onChange?.({
                  voice,
                  voice_speed,
                  voice_api_key_ref: voiceApiKeyRef,
                  background_audio: {
                    type: "media_url",
                    value: url,
                  },
                })
              }
            />
          </div>
        )}
        {/* Volume Control - only show for predefined_media when not silence */}
        {value?.background_audio?.type === "predefined_media" &&
          value?.background_audio?.value !== "silence" &&
          value?.background_audio?.value && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs">Volume</label>
                <Badge variant="secondary" className="text-xs">
                  {(value?.background_audio?.volume ?? 0.5).toFixed(1)}
                </Badge>
              </div>
              <div className="relative pt-6">
                <Slider
                  min={0.1}
                  max={1}
                  step={0.1}
                  value={[value?.background_audio?.volume ?? 0.5]}
                  onValueChange={(vals) =>
                    onChange?.({
                      voice,
                      voice_speed,
                      voice_api_key_ref: voiceApiKeyRef,
                      background_audio: {
                        ...(value?.background_audio || {}),
                        type: "predefined_media",
                        value: value?.background_audio?.value,
                        volume: Number(vals[0].toFixed(1)),
                      },
                    })
                  }
                />
                <div className="flex justify-between text-xs text-gray-500 mt-2">
                  <span>0.1</span>
                  <span>1.0</span>
                </div>
              </div>
            </div>
          )}
      </div>

      {/* Audio Preview Button - positioned below Background Audio Type */}
      {value?.background_audio?.type === "media_url" && (
        <div className="mt-3">
          <AudioPreviewButton
            audioUrl={value?.background_audio?.value}
            audioType="media_url"
          />
        </div>
      )}

        </div>
      </section>

      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="flex items-start gap-3 border-b bg-muted/30 px-4 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
            <IconMicrophone className="size-5 text-emerald-500" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Speaking plan</h3>
            <p className="text-xs text-muted-foreground">Tune interruptions and response timing for natural turn-taking.</p>
          </div>
        </div>
        <div className="p-4">

      {/* Enable Interruptions Toggle */}
      <div className="flex items-center gap-2 rounded-lg border bg-muted/15 p-3">
        <Switch
          id="enable_interruptions"
          checked={value?.interruption_settings?.enable ?? false}
          onCheckedChange={(checked) => {
            const newInterruptionSettings = {
              ...(value?.interruption_settings || {}),
              enable: checked,
            };

            // Set default values when enabling
            if (checked && !value?.interruption_settings?.start_speaking_plan) {
              newInterruptionSettings.start_speaking_plan = {
                wait_seconds: 0.2,
                transcription_endpointing_plan: {
                  on_punctuation_seconds: 0.2,
                  on_no_punctuation_seconds: 0.2,
                  on_number_seconds: 0.2,
                },
                custom_endpointing_rules: null,
              };
            }

            onChange?.({
              voice,
              voice_speed,
              voice_api_key_ref: voiceApiKeyRef,
              interruption_settings: newInterruptionSettings,
            });
          }}
        />
        <label
          htmlFor="enable_interruptions"
          className="text-sm font-medium leading-none cursor-pointer"
        >
          Enable Interruptions
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
          </TooltipTrigger>
          <TooltipContent>
            <p>Allow users to interrupt the assistant while it&apos;s speaking.</p>
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        {/* Wait Seconds */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Wait Seconds</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>Minimum seconds assistant waits before speaking.</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="relative pt-6">
            {(() => {
              const currentValue =
                value?.interruption_settings?.start_speaking_plan
                  ?.wait_seconds ?? 0.6;
              const percentage = (currentValue / 3) * 100;
              return (
                <>
                  <Badge
                    variant="secondary"
                    className="absolute -top-1 transition-all duration-150"
                    style={{ left: `calc(${percentage}% - 12px)` }}
                  >
                    {currentValue.toFixed(1)}
                  </Badge>
                  <Slider
                    min={0}
                    max={3}
                    step={0.1}
                    value={[currentValue]}
                    onValueChange={(vals) =>
                      onChange?.({
                        voice,
                        voice_speed,
                        voice_api_key_ref: voiceApiKeyRef,
                        interruption_settings: {
                          ...(value?.interruption_settings || {}),
                          start_speaking_plan: {
                            ...(value?.interruption_settings
                              ?.start_speaking_plan || {}),
                            wait_seconds: Number(vals[0].toFixed(1)),
                          },
                        },
                      })
                    }
                  />
                </>
              );
            })()}
            <div className="flex justify-between text-xs text-gray-500 mt-2">
              <span>0</span>
              <span>3</span>
            </div>
          </div>
        </div>

        {/* On Punctuation Seconds */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">
              On Punctuation Seconds
            </label>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  Minimum seconds assistant waits after transcription ending
                  with punctuation.
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="relative pt-6">
            {(() => {
              const currentValue =
                value?.interruption_settings?.start_speaking_plan
                  ?.transcription_endpointing_plan?.on_punctuation_seconds ??
                0.7;
              const percentage = (currentValue / 3) * 100;
              return (
                <>
                  <Badge
                    variant="secondary"
                    className="absolute -top-1 transition-all duration-150"
                    style={{ left: `calc(${percentage}% - 12px)` }}
                  >
                    {currentValue.toFixed(1)}
                  </Badge>
                  <Slider
                    min={0}
                    max={3}
                    step={0.1}
                    value={[currentValue]}
                    onValueChange={(vals) =>
                      onChange?.({
                        voice,
                        voice_speed,
                        voice_api_key_ref: voiceApiKeyRef,
                        interruption_settings: {
                          ...(value?.interruption_settings || {}),
                          start_speaking_plan: {
                            ...(value?.interruption_settings
                              ?.start_speaking_plan || {}),
                            transcription_endpointing_plan: {
                              ...(value?.interruption_settings
                                ?.start_speaking_plan
                                ?.transcription_endpointing_plan || {}),
                              on_punctuation_seconds: Number(
                                vals[0].toFixed(1)
                              ),
                            },
                          },
                        },
                      })
                    }
                  />
                </>
              );
            })()}
            <div className="flex justify-between text-xs text-gray-500 mt-2">
              <span>0</span>
              <span>3</span>
            </div>
          </div>
        </div>

        {/* On No Punctuation Seconds */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">
              On No Punctuation Seconds
            </label>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  Minimum seconds assistant waits after transcription ending
                  without punctuation.
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="relative pt-6">
            {(() => {
              const currentValue =
                value?.interruption_settings?.start_speaking_plan
                  ?.transcription_endpointing_plan?.on_no_punctuation_seconds ??
                0.8;
              const percentage = (currentValue / 3) * 100;
              return (
                <>
                  <Badge
                    variant="secondary"
                    className="absolute -top-1 transition-all duration-150"
                    style={{ left: `calc(${percentage}% - 12px)` }}
                  >
                    {currentValue.toFixed(1)}
                  </Badge>
                  <Slider
                    min={0}
                    max={3}
                    step={0.1}
                    value={[currentValue]}
                    onValueChange={(vals) =>
                      onChange?.({
                        voice,
                        voice_speed,
                        voice_api_key_ref: voiceApiKeyRef,
                        interruption_settings: {
                          ...(value?.interruption_settings || {}),
                          start_speaking_plan: {
                            ...(value?.interruption_settings
                              ?.start_speaking_plan || {}),
                            transcription_endpointing_plan: {
                              ...(value?.interruption_settings
                                ?.start_speaking_plan
                                ?.transcription_endpointing_plan || {}),
                              on_no_punctuation_seconds: Number(
                                vals[0].toFixed(1)
                              ),
                            },
                          },
                        },
                      })
                    }
                  />
                </>
              );
            })()}
            <div className="flex justify-between text-xs text-gray-500 mt-2">
              <span>0</span>
              <span>3</span>
            </div>
          </div>
        </div>

        {/* On Number Seconds */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">On Number Seconds</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconInfoCircle className="size-4 text-gray-400 cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  Minimum seconds assistant waits after transcription ending
                  with a number.
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="relative pt-6">
            {(() => {
              const currentValue =
                value?.interruption_settings?.start_speaking_plan
                  ?.transcription_endpointing_plan?.on_number_seconds ?? 0.9;
              const percentage = (currentValue / 3) * 100;
              return (
                <>
                  <Badge
                    variant="secondary"
                    className="absolute -top-1 transition-all duration-150"
                    style={{ left: `calc(${percentage}% - 12px)` }}
                  >
                    {currentValue.toFixed(1)}
                  </Badge>
                  <Slider
                    min={0}
                    max={3}
                    step={0.1}
                    value={[currentValue]}
                    onValueChange={(vals) =>
                      onChange?.({
                        voice,
                        voice_speed,
                        voice_api_key_ref: voiceApiKeyRef,
                        interruption_settings: {
                          ...(value?.interruption_settings || {}),
                          start_speaking_plan: {
                            ...(value?.interruption_settings
                              ?.start_speaking_plan || {}),
                            transcription_endpointing_plan: {
                              ...(value?.interruption_settings
                                ?.start_speaking_plan
                                ?.transcription_endpointing_plan || {}),
                              on_number_seconds: Number(vals[0].toFixed(1)),
                            },
                          },
                        },
                      })
                    }
                  />
                </>
              );
            })()}
            <div className="flex justify-between text-xs text-gray-500 mt-2">
              <span>0</span>
              <span>3</span>
            </div>
          </div>
        </div>
      </div>
        </div>
      </section>
    </div>
  );
}

function CustomMediaUrlSelector({ value, onChange }) {
  const [audioFiles, setAudioFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [customUrl, setCustomUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);

  useEffect(() => {
    async function loadAudioFiles() {
      try {
        setLoading(true);
        const response = await fetch("/api/media/audio");
        if (response.ok) {
          const data = await response.json();
          setAudioFiles(data.files || []);
        }
      } catch (error) {
        console.error("Error loading audio files:", error);
      } finally {
        setLoading(false);
      }
    }
    loadAudioFiles();
  }, []);

  // Check if the current value is from our media library
  const isFromMediaLibrary = audioFiles.some((file) => file.url === value);

  // If not from media library, show as custom URL
  useEffect(() => {
    if (!isFromMediaLibrary && value) {
      setCustomUrl(value);
      setSelectedFile(null);
    } else if (isFromMediaLibrary) {
      const file = audioFiles.find((file) => file.url === value);
      setSelectedFile(file);
      setCustomUrl(value); // Show the full URL in the input field
    }
  }, [value, isFromMediaLibrary, audioFiles]);

  const handleFileSelect = (fileUrl) => {
    const file = audioFiles.find((f) => f.url === fileUrl);
    setSelectedFile(file);
    setCustomUrl(fileUrl); // Show the selected file URL in the input field
    onChange(fileUrl);
  };

  const handleCustomUrlChange = (url) => {
    setCustomUrl(url);
    setSelectedFile(null);
    onChange(url);
  };

  return (
    <div className="space-y-2">
      <Select
        value={isFromMediaLibrary ? value : ""}
        onValueChange={handleFileSelect}
      >
        <SelectTrigger className="w-full">
          <SelectValue
            placeholder={
              loading ? "Loading audio files..." : "Select from media library"
            }
          />
        </SelectTrigger>
        <SelectContent>
          {audioFiles.map((file) => (
            <SelectItem key={file.url} value={file.url}>
              {file.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="text-xs text-gray-500 mb-1">
        Selected URL (used in AI assistant settings):
      </div>
      <Input
        value={customUrl}
        onChange={(e) => handleCustomUrlChange(e.target.value)}
        placeholder="https://example.com/audio.mp3"
        className="font-mono text-sm"
      />
    </div>
  );
}

function AudioPreviewButton({ audioUrl, audioType, onFileChange }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const waveformRef = useRef(null);
  const wavesurferRef = useRef(null);

  // Initialize WaveSurfer
  useEffect(() => {
    if (!audioUrl || !waveformRef.current) return;

    // Small delay to ensure DOM is ready
    const timer = setTimeout(() => {
      // Create WaveSurfer instance
      const wavesurfer = WaveSurfer.create({
        container: waveformRef.current,
        waveColor: "#6b7280",
        progressColor: "#374151",
        cursorColor: "#111827",
        barWidth: 2,
        barRadius: 3,
        responsive: true,
        height: 60,
        normalize: true,
        backend: "WebAudio",
        mediaControls: false,
      });

      wavesurferRef.current = wavesurfer;

      // Event listeners
      wavesurfer.on("ready", () => {
        setDuration(wavesurfer.getDuration());
      });

      wavesurfer.on("play", () => {
        setIsPlaying(true);
      });

      wavesurfer.on("pause", () => {
        setIsPlaying(false);
      });

      wavesurfer.on("finish", () => {
        setIsPlaying(false);
      });

      wavesurfer.on("timeupdate", (currentTime) => {
        setCurrentTime(currentTime);
      });

      wavesurfer.on("error", (e) => {
        console.error("WaveSurfer error:", e);
        setError("Error loading audio: " + (e.message || "Unknown error"));
        setIsPlaying(false);
      });

      // Load audio
      wavesurfer.load(audioUrl);
    }, 100);

    return () => {
      clearTimeout(timer);
      if (wavesurferRef.current) {
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
      }
    };
  }, [audioUrl]);

  // Cleanup when component unmounts
  useEffect(() => {
    return () => {
      if (wavesurferRef.current) {
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
      }
    };
  }, []);

  const togglePlayPause = () => {
    if (wavesurferRef.current) {
      wavesurferRef.current.playPause();
    }
  };

  const formatTime = (time) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const isValidUrl =
    audioUrl && audioUrl.trim() !== "" && audioUrl.startsWith("http");

  return (
    <div className="space-y-3">
      {/* Play/Pause Button */}
      <div className="flex items-center gap-2">
        <Button
          onClick={togglePlayPause}
          disabled={!isValidUrl}
          size="sm"
          className="flex items-center gap-2"
        >
          {isPlaying ? (
            <Pause className="w-4 h-4" />
          ) : (
            <Play className="w-4 h-4" />
          )}
          {isPlaying ? "Pause" : "Play"}
        </Button>

        {error && <span className="text-xs text-red-600">{error}</span>}

        {!isValidUrl && (
          <span className="text-xs text-gray-500">
            Select a media file or enter a valid URL
          </span>
        )}
      </div>

      {/* WaveSurfer Waveform */}
      {isValidUrl && (
        <div className="w-full">
          <div
            ref={waveformRef}
            className="w-full rounded-lg border border-gray-300"
            style={{ borderWidth: "1px" }}
          />

          {/* Time Display */}
          <div className="flex justify-between text-sm text-gray-500 mt-2">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
