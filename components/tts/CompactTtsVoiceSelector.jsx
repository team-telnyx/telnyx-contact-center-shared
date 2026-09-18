"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { notify } from "@/components/ToastNotify";

function normalizeLanguage(value) {
  const match = String(value || "").replace(/_/g, "-").match(/^([a-zA-Z]{2,3})-([a-zA-Z]{2}|\d{3})$/);
  return match ? `${match[1].toLowerCase()}-${match[2].toUpperCase()}` : "";
}

export function CompactTtsVoiceSelector({
  value,
  language = "",
  previewText = "",
  voiceApiKeyRef = "",
  providerModelFullWidth = false,
  onChange = () => {},
}) {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef(null);
  const urlRef = useRef("");
  const current = String(value || "").trim();
  const providerId = current.split(".")[0] || "";
  const provider = providers.find((item) => item.id === providerId || item.name === providerId) || null;
  const models = (provider?.models || []).filter((item) => item && typeof item === "object");
  const model = models.find((item) => current.startsWith(`${provider?.id}.${item.id}.`)) || models[0] || null;
  const voices = Array.isArray(model?.voices) ? model.voices : [];

  const stopPreview = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = "";
    setPreviewing(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tts/voices", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : { providers: [] })
      .then((payload) => {
        if (!cancelled) setProviders(Array.isArray(payload?.providers) ? payload.providers : []);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => stopPreview, [stopPreview]);

  function chooseVoice(voice) {
    if (!voice?.id) return;
    onChange({
      voice: voice.id,
      language: normalizeLanguage(voice.language) || language,
    });
  }

  async function preview() {
    if (previewing) return stopPreview();
    if (!current || !String(previewText || "").trim()) return;
    try {
      setPreviewing(true);
      const response = await fetch("/api/tts/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          text: previewText,
          voice: current,
          voice_api_key_ref: voiceApiKeyRef || undefined,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.error || "Failed to generate speech");
      }
      urlRef.current = URL.createObjectURL(await response.blob());
      const audio = new Audio(urlRef.current);
      audioRef.current = audio;
      audio.onended = stopPreview;
      audio.onerror = stopPreview;
      await audio.play();
    } catch (error) {
      stopPreview();
      notify({ title: "Preview failed", description: error.message, variant: "error" });
    }
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Select
          value={provider?.id || ""}
          onValueChange={(id) => chooseVoice(providers.find((item) => item.id === id)?.models?.[0]?.voices?.[0])}
          disabled={loading}
        >
          <SelectTrigger className={providerModelFullWidth ? "w-full" : undefined}><SelectValue placeholder={loading ? "Loading providers…" : "Provider"} /></SelectTrigger>
          <SelectContent>{providers.map((item) => <SelectItem key={item.id} value={item.id}>{item.name || item.id}</SelectItem>)}</SelectContent>
        </Select>
        <Select
          value={model?.id || ""}
          onValueChange={(id) => chooseVoice(models.find((item) => item.id === id)?.voices?.[0])}
          disabled={!provider}
        >
          <SelectTrigger className={providerModelFullWidth ? "w-full" : undefined}><SelectValue placeholder="Model" /></SelectTrigger>
          <SelectContent>{models.map((item) => <SelectItem key={item.id} value={item.id}>{item.name || item.id}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="flex gap-2">
        <Select
          value={current}
          onValueChange={(id) => chooseVoice(voices.find((item) => item.id === id) || { id })}
          disabled={!model}
        >
          <SelectTrigger className="min-w-0 flex-1"><SelectValue placeholder="Voice" /></SelectTrigger>
          <SelectContent>
            {voices.map((voice) => <SelectItem key={voice.id} value={voice.id}>{voice.language ? `${voice.name || voice.id} (${voice.language})` : voice.name || voice.id}</SelectItem>)}
            {!loading && !voices.some((voice) => voice.id === current) && current ? <SelectItem value={current}>{current}</SelectItem> : null}
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="icon" onClick={preview} disabled={!current || !String(previewText || "").trim()}>
          {previewing ? <IconPlayerStop className="size-4" /> : <IconPlayerPlay className="size-4" />}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{language ? `Language: ${language}` : "Select provider, model and voice."}</p>
    </div>
  );
}
