"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { IconInfoCircle } from "@tabler/icons-react";

// Lightweight TTS voice picker for AI Assistant workflow nodes.
//
// Telnyx's node-level voice override exposes ONLY the basics: provider, model,
// voice, and (for the providers that support them) voice speed + expressive
// mode. The full assistant-editor VoicePicker (components/assistants/VoicePicker.jsx)
// adds many extras (language/gender filters, sample-text playback, custom
// dictionaries, ElevenLabs advanced settings, speech-to-text) — none of which
// belong on a workflow node. This component deliberately omits all of that but
// keeps the same Provider → Model → Voice cascade as the working Call Flows /
// assistant editor picker, because /api/tts/voices nests voices UNDER models
// ({ id, name, models: [{ id, name, voices: [...] }] }). Without the Model step
// the voice list is always empty for multi-model providers (e.g. Telnyx).
// Emits the same Provider.Model.VoiceId string format so the value stays
// wire-compatible with the assistant voice field.

function parseVoiceString(value) {
  const safe = String(value || "").trim();
  if (!safe) return { provider: "", model: "", voiceName: "" };
  const parts = safe.split(".");
  const provider = parts[0] || "";
  // 3+ segments: Provider.Model.VoiceId (model may contain dots, e.g.
  // Minimax.speech-2.6-turbo.VoiceName) ; 2 segments: Provider.VoiceId
  if (parts.length >= 3) {
    return { provider, model: parts.slice(1, -1).join("."), voiceName: safe };
  }
  if (parts.length === 2) return { provider, model: "", voiceName: safe };
  return { provider, model: "", voiceName: safe };
}

export default function WorkflowVoicePicker({ value, onChange }) {
  const voice = value?.voice || "";
  const voice_speed = value?.voice_speed ?? 1;
  const { provider: pInit, model: mInit, voiceName: vInit } = useMemo(
    () => parseVoiceString(voice),
    [voice]
  );

  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState(pInit);
  const [model, setModel] = useState(mInit);
  const [voiceName, setVoiceName] = useState(vInit);

  // Keep local selection in sync ONLY with meaningful upstream changes.
  //
  // While the user is mid-cascade (provider/model chosen, voice not yet) we emit
  // an empty `voice` upstream. If we naively re-synced local state from that
  // empty value we'd wipe the just-picked provider/model — which made the Model
  // dropdown vanish on every model change. So we resync from upstream only when
  // it carries a real voice string, or when it transitions to empty from the
  // OUTSIDE (e.g. switching to a different node whose voice is unset), detected
  // by comparing against what we last emitted.
  const lastEmittedRef = useRef(voice);
  useEffect(() => {
    if (vInit) {
      // Upstream has a concrete voice — authoritative, adopt it.
      setProvider(pInit);
      setModel(mInit);
      setVoiceName(vInit);
      lastEmittedRef.current = vInit;
      return;
    }
    // Upstream voice is empty. Ignore it if it's just the echo of our own
    // mid-cascade emit; otherwise (external reset) clear local state.
    if (lastEmittedRef.current !== "") {
      setProvider("");
      setModel("");
      setVoiceName("");
      lastEmittedRef.current = "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pInit, mInit, vInit]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/tts/voices", { cache: "no-store" });
        const data = await res.json();
        if (mounted && res.ok && data?.ok) setProviders(data.providers || []);
      } catch (_) {}
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const currentProvider = useMemo(
    () => providers.find((p) => p.id === provider) || null,
    [providers, provider]
  );
  const models = currentProvider?.models || [];

  const voices = useMemo(() => {
    const m = models.find((x) => x.id === model);
    const list = m ? m.voices || [] : [];
    // Deduplicate by id to avoid duplicate Select keys/values.
    const seen = new Set();
    const out = [];
    for (const v of list) {
      const id = String(v?.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(v);
    }
    return out;
  }, [models, model]);

  function emit(next) {
    onChange?.({
      voice: next.voice ?? voice,
      voice_speed: next.voice_speed ?? voice_speed,
      voice_api_key_ref: value?.voice_api_key_ref,
      elevenlabs_settings: value?.elevenlabs_settings,
      language_boost: value?.language_boost,
      expressive_mode: next.expressive_mode ?? value?.expressive_mode,
      pronunciation_dict_id: value?.pronunciation_dict_id,
    });
  }

  function handleProvider(nextProvider) {
    setProvider(nextProvider);
    setVoiceName("");
    // Auto-select the model when the provider exposes exactly one (including
    // the empty-id model used by Azure/AWS-style flat providers).
    const p = providers.find((x) => x.id === nextProvider) || null;
    const provModels = p?.models || [];
    const nextModel = provModels.length === 1 ? provModels[0].id : "";
    setModel(nextModel);
    // Mark the upcoming empty `voice` as our own so the resync effect doesn't
    // mistake the echo for an external reset and wipe the new provider/model.
    lastEmittedRef.current = "";
    emit({ voice: "" });
  }

  function handleModel(nextModel) {
    setModel(nextModel);
    setVoiceName("");
    lastEmittedRef.current = "";
    emit({ voice: "" });
  }

  function handleVoice(nextVoiceId) {
    // nextVoiceId is the full upstream id (already Provider.Model.VoiceId
    // or Provider.VoiceId), so emit it verbatim and re-derive the model.
    setVoiceName(nextVoiceId);
    const parsed = parseVoiceString(nextVoiceId);
    if (parsed.model) setModel(parsed.model);
    lastEmittedRef.current = nextVoiceId;
    emit({ voice: nextVoiceId });
  }

  function handleSpeed(next) {
    emit({ voice_speed: next });
  }

  const isTelnyx = provider.toLowerCase() === "telnyx";
  const modelLower = model.toLowerCase();
  const supportsSpeed =
    isTelnyx && (modelLower === "natural" || modelLower === "naturalhd" || modelLower === "ultra");
  const supportsExpressive = isTelnyx && modelLower === "ultra";

  // Hide the Model dropdown when the provider has no real models (single
  // empty-id group). Keeps flat providers (Azure/AWS) clean while still
  // sourcing voices from models[0].
  const hasRealModels = models.some((m) => String(m.id || "").length > 0);

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs">Provider</label>
        <Select value={provider || undefined} onValueChange={handleProvider}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name || p.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {hasRealModels && (
        <div>
          <label className="text-xs">Model</label>
          <Select value={model || undefined} onValueChange={handleModel} disabled={!provider}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={provider ? "Select model" : "Select a provider first"} />
            </SelectTrigger>
            <SelectContent>
              {models
                .filter((m) => String(m.id || "").length > 0)
                .map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name || m.id}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div>
        <label className="text-xs">Voice</label>
        <Select
          value={voiceName || undefined}
          onValueChange={handleVoice}
          disabled={!provider || (hasRealModels && !model)}
        >
          <SelectTrigger className="w-full">
            <SelectValue
              placeholder={
                !provider
                  ? "Select a provider first"
                  : hasRealModels && !model
                    ? "Select a model first"
                    : "Select voice"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {voices
              .map((v) => {
                const id = String(v?.id || "");
                if (!id) return null;
                const name = String(v?.name || "");
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

      {supportsSpeed && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs">Voice Speed</label>
            <Badge variant="secondary" className="text-xs">
              {voice_speed.toFixed(2)}x
            </Badge>
          </div>
          <div className="relative pt-2">
            <Slider
              min={0.25}
              max={2}
              step={0.05}
              value={[voice_speed]}
              onValueChange={(vals) => handleSpeed(Number(vals[0].toFixed(2)))}
            />
            <div className="mt-2 flex justify-between text-xs text-muted-foreground">
              <span>0.25</span>
              <span>2.0</span>
            </div>
          </div>
        </div>
      )}

      {supportsExpressive && (
        <div className="mt-2 flex items-center gap-3">
          <Switch
            id="workflow-expressive-mode"
            checked={value?.expressive_mode ?? false}
            onCheckedChange={(checked) => emit({ expressive_mode: checked })}
          />
          <div className="flex items-center gap-1.5">
            <label htmlFor="workflow-expressive-mode" className="cursor-pointer text-sm font-medium">
              Expressive Mode
            </label>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconInfoCircle className="size-4 cursor-help text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  Enables emotionally expressive speech using SSML emotion tags.
                  <br />
                  Only supported for Telnyx Ultra voices.
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
}
