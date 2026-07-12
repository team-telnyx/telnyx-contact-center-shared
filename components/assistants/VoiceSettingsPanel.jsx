"use client";

import { useEffect, useMemo, useState } from "react";
import { IconPlayerPlay, IconVolume } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

const TRANSCRIPTION_PROVIDERS = [
  { id: "deepgram", label: "Deepgram", models: ["flux", "nova-3", "nova-2", "enhanced", "base"] },
  { id: "google", label: "Google", models: ["latest_long", "latest_short", "telephony"] },
  { id: "azure", label: "Azure", models: ["default"] },
  { id: "telnyx", label: "Telnyx", models: ["nova-3"] },
];

const LANGUAGES = ["auto", "en", "en-US", "en-GB", "es", "fr", "de", "it", "pt", "pl", "nl", "sv", "ja", "ko", "zh"];

function selectedVoiceParts(value) {
  const parts = String(value || "").split(".");
  return { provider: parts[0] || "", model: parts.length > 2 ? parts.slice(1, -1).join(".") : "default" };
}

export default function VoiceSettingsPanel({ values, setValues }) {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const initial = selectedVoiceParts(values.voice);
  const [providerId, setProviderId] = useState(initial.provider);
  const [modelId, setModelId] = useState(initial.model);
  const [language, setLanguage] = useState("any");
  const [gender, setGender] = useState("any");
  const transcriptionModel = String(values.transcription?.model || "deepgram/flux");
  const [transcriptionProvider, transcriptionModelId = ""] = transcriptionModel.split("/");

  useEffect(() => {
    fetch("/api/tts/voices", { cache: "no-store" }).then((response) => response.json()).then((data) => setProviders(Array.isArray(data.providers) ? data.providers : [])).catch(() => setProviders([])).finally(() => setLoading(false));
  }, []);

  const provider = providers.find((item) => item.id === providerId) || providers[0];
  const model = provider?.models?.find((item) => item.id === modelId) || provider?.models?.[0];
  const voices = useMemo(() => (model?.voices || []).filter((voice) => (language === "any" || voice.language === language) && (gender === "any" || voice.gender === gender)), [gender, language, model]);
  const languageOptions = useMemo(() => [...new Set((model?.voices || []).map((voice) => voice.language).filter(Boolean))], [model]);
  const genderOptions = useMemo(() => [...new Set((model?.voices || []).map((voice) => voice.gender).filter(Boolean))], [model]);

  function setField(key, value) { setValues((current) => ({ ...current, [key]: value })); }
  function setNested(group, key, value) { setValues((current) => ({ ...current, [group]: { ...(current[group] || {}), [key]: value } })); }
  function chooseProvider(next) { setProviderId(next); const nextProvider = providers.find((item) => item.id === next); const nextModel = nextProvider?.models?.[0]; setModelId(nextModel?.id || "default"); setField("voice", nextModel?.voices?.[0]?.id || ""); }
  function chooseModel(next) { setModelId(next); const nextModel = provider?.models?.find((item) => item.id === next); setField("voice", nextModel?.voices?.[0]?.id || ""); }

  async function preview() {
    if (!values.voice) return;
    setPreviewing(true);
    try {
      const response = await fetch("/api/tts/speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice: values.voice, voice_speed: values.voice_speed || 1, voice_api_key_ref: values.voice_api_key_ref || "", text: "Hello! This is a preview of your Telnyx AI assistant voice." }) });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "Preview failed"); }
      const url = URL.createObjectURL(await response.blob()); const audio = new Audio(url); audio.onended = () => URL.revokeObjectURL(url); await audio.play();
    } catch (error) { notify({ title: "Voice preview failed", description: error.message, variant: "error" }); }
    finally { setPreviewing(false); }
  }

  const interruptions = values.interruption_settings || {};
  const telephony = values.telephony || {};
  const noise = telephony.noise_suppression_config || {};

  return <div className="h-full space-y-4 overflow-y-auto pr-1">
    <Card><CardHeader><CardTitle>Text-to-speech voice</CardTitle><CardDescription>Select a Telnyx voice and tune its delivery.</CardDescription></CardHeader><CardContent className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"><div className="space-y-2"><Label>Provider</Label><Select disabled={loading} value={provider?.id || ""} onValueChange={chooseProvider}><SelectTrigger><SelectValue placeholder="Provider" /></SelectTrigger><SelectContent>{providers.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label>Model</Label><Select value={model?.id || ""} onValueChange={chooseModel}><SelectTrigger><SelectValue placeholder="Model" /></SelectTrigger><SelectContent>{(provider?.models || []).map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label>Language</Label><Select value={language} onValueChange={setLanguage}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="any">Any</SelectItem>{languageOptions.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label>Gender</Label><Select value={gender} onValueChange={setGender}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="any">Any</SelectItem>{genderOptions.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></div></div>
      <div className="grid gap-4 lg:grid-cols-[1fr_auto]"><div className="space-y-2"><Label>Voice *</Label><Select value={values.voice || ""} onValueChange={(value) => setField("voice", value)}><SelectTrigger><SelectValue placeholder="Select voice" /></SelectTrigger><SelectContent>{voices.map((voice) => <SelectItem key={voice.id} value={voice.id}>{voice.label || voice.name || voice.id}</SelectItem>)}</SelectContent></Select></div><div className="flex items-end"><Button variant="outline" onClick={preview} disabled={!values.voice || previewing}><IconPlayerPlay className="size-4" />{previewing ? "Generating…" : "Preview"}</Button></div></div>
      <div className="space-y-3"><div className="flex justify-between"><Label>Voice speed</Label><span className="text-sm tabular-nums">{Number(values.voice_speed || 1).toFixed(2)}×</span></div><Slider min={0.5} max={2} step={0.05} value={[Number(values.voice_speed || 1)]} onValueChange={([value]) => setField("voice_speed", value)} /></div>
      {String(values.voice || "").startsWith("ElevenLabs.") ? <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-2 xl:grid-cols-4"><div className="space-y-2"><Label>Temperature</Label><Input type="number" min="0" max="1" step="0.05" value={values.elevenlabs_settings?.temperature ?? 0.5} onChange={(event) => setNested("elevenlabs_settings", "temperature", Number(event.target.value))} /></div><div className="space-y-2"><Label>Similarity boost</Label><Input type="number" min="0" max="1" step="0.05" value={values.elevenlabs_settings?.similarity_boost ?? 0.75} onChange={(event) => setNested("elevenlabs_settings", "similarity_boost", Number(event.target.value))} /></div><div className="space-y-2"><Label>Style</Label><Input type="number" min="0" max="1" step="0.05" value={values.elevenlabs_settings?.style ?? 0} onChange={(event) => setNested("elevenlabs_settings", "style", Number(event.target.value))} /></div><div className="flex items-center gap-3 pt-6"><Switch checked={Boolean(values.elevenlabs_settings?.use_speaker_boost)} onCheckedChange={(checked) => setNested("elevenlabs_settings", "use_speaker_boost", checked)} /><Label>Speaker boost</Label></div></div> : null}
    </CardContent></Card>

    <Card><CardHeader><CardTitle>Transcription</CardTitle><CardDescription>Choose the speech-to-text provider, model, language, and endpointing behavior.</CardDescription></CardHeader><CardContent className="space-y-5">
      <div className="grid gap-4 md:grid-cols-3"><div className="space-y-2"><Label>Provider</Label><Select value={transcriptionProvider || "deepgram"} onValueChange={(next) => { const config = TRANSCRIPTION_PROVIDERS.find((item) => item.id === next); setNested("transcription", "model", `${next}/${config?.models?.[0] || "default"}`); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TRANSCRIPTION_PROVIDERS.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label>Model</Label><Select value={transcriptionModelId || "default"} onValueChange={(next) => setNested("transcription", "model", `${transcriptionProvider}/${next}`)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(TRANSCRIPTION_PROVIDERS.find((item) => item.id === transcriptionProvider)?.models || [transcriptionModelId]).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label>Language</Label><Select value={values.transcription?.language || "auto"} onValueChange={(next) => setNested("transcription", "language", next)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{LANGUAGES.map((item) => <SelectItem key={item} value={item}>{item === "auto" ? "Automatic" : item}</SelectItem>)}</SelectContent></Select></div></div>
      <div className="grid gap-3 md:grid-cols-2"><div className="flex items-center justify-between rounded-lg border p-4"><div><div className="text-sm font-medium">Eager end-of-turn detection</div><div className="text-xs text-muted-foreground">Respond sooner when the user stops speaking.</div></div><Switch checked={Boolean(values.transcription?.settings?.eager_eot_threshold)} onCheckedChange={(checked) => setValues((current) => ({ ...current, transcription: { ...(current.transcription || {}), settings: { ...(current.transcription?.settings || {}), eager_eot_threshold: checked ? 0.4 : undefined } } }))} /></div><div className="flex items-center justify-between rounded-lg border p-4"><div><div className="text-sm font-medium">Profanity filter</div><div className="text-xs text-muted-foreground">Mask profanity in transcriptions.</div></div><Switch checked={Boolean(values.transcription?.settings?.profanity_filter)} onCheckedChange={(checked) => setValues((current) => ({ ...current, transcription: { ...(current.transcription || {}), settings: { ...(current.transcription?.settings || {}), profanity_filter: checked } } }))} /></div></div>
    </CardContent></Card>

    <Card><CardHeader><CardTitle>Noise and background audio</CardTitle><CardDescription>Enhance inbound speech and select ambient audio for calls.</CardDescription></CardHeader><CardContent className="space-y-5">
      <div className="flex items-center justify-between rounded-lg border p-4"><div><div className="text-sm font-medium">Noise suppression</div><div className="text-xs text-muted-foreground">Reduce background noise before transcription.</div></div><Switch checked={Boolean(noise.engine)} onCheckedChange={(checked) => setValues((current) => ({ ...current, telephony: { ...(current.telephony || {}), noise_suppression_config: checked ? { ...(current.telephony?.noise_suppression_config || {}), engine: current.telephony?.noise_suppression_config?.engine || "aicoustics" } : {} } }))} /></div>
      {noise.engine ? <div className="grid gap-4 md:grid-cols-2"><div className="space-y-2"><Label>Suppression engine</Label><Select value={noise.engine} onValueChange={(value) => setValues((current) => ({ ...current, telephony: { ...(current.telephony || {}), noise_suppression_config: { ...(current.telephony?.noise_suppression_config || {}), engine: value } } }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="aicoustics">AiCoustics</SelectItem><SelectItem value="krisp">Krisp</SelectItem><SelectItem value="deepfilternet">DeepFilterNet</SelectItem></SelectContent></Select></div><div className="space-y-2"><Label>Mode</Label><Select value={noise.mode || "advanced"} onValueChange={(value) => setValues((current) => ({ ...current, telephony: { ...(current.telephony || {}), noise_suppression_config: { ...(current.telephony?.noise_suppression_config || {}), mode: value } } }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="advanced">Advanced</SelectItem><SelectItem value="basic">Basic</SelectItem></SelectContent></Select></div></div> : null}
      <div className="grid gap-4 md:grid-cols-3"><div className="space-y-2"><Label>Background audio type</Label><Select value={values.background_audio?.type || "predefined_media"} onValueChange={(value) => setField("background_audio", { ...(values.background_audio || {}), type: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="predefined_media">Predefined media</SelectItem><SelectItem value="media_url">Custom media URL</SelectItem></SelectContent></Select></div><div className="space-y-2"><Label>{values.background_audio?.type === "media_url" ? "Media URL" : "Preset"}</Label>{values.background_audio?.type === "media_url" ? <Input value={values.background_audio?.value || ""} onChange={(event) => setField("background_audio", { ...(values.background_audio || {}), value: event.target.value })} /> : <Select value={values.background_audio?.value || "silence"} onValueChange={(value) => setField("background_audio", { ...(values.background_audio || {}), value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="silence">Silence</SelectItem><SelectItem value="office">Office</SelectItem></SelectContent></Select>}</div><div className="space-y-3"><div className="flex justify-between"><Label>Volume</Label><span className="text-sm">{Math.round(Number(values.background_audio?.volume ?? 0.5) * 100)}%</span></div><Slider min={0} max={1} step={0.05} value={[Number(values.background_audio?.volume ?? 0.5)]} onValueChange={([volume]) => setField("background_audio", { ...(values.background_audio || {}), volume })} /></div></div>
    </CardContent></Card>

    <Card><CardHeader><CardTitle>Interruptions</CardTitle><CardDescription>Control when user speech interrupts the assistant.</CardDescription></CardHeader><CardContent className="space-y-5"><div className="flex items-center justify-between rounded-lg border p-4"><div><div className="text-sm font-medium">Enable interruptions</div><div className="text-xs text-muted-foreground">Allow callers to speak over assistant audio.</div></div><Switch checked={interruptions.enabled !== false} onCheckedChange={(enabled) => setField("interruption_settings", { ...interruptions, enabled })} /></div>{interruptions.enabled !== false ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"><div className="space-y-2"><Label>Wait seconds</Label><Input type="number" min="0" step="0.1" value={interruptions.wait_seconds ?? 0.5} onChange={(event) => setField("interruption_settings", { ...interruptions, wait_seconds: Number(event.target.value) })} /></div><div className="space-y-2"><Label>Words required</Label><Input type="number" min="1" value={interruptions.words_required ?? 1} onChange={(event) => setField("interruption_settings", { ...interruptions, words_required: Number(event.target.value) })} /></div><div className="space-y-2"><Label>Duration threshold</Label><Input type="number" min="0" step="0.1" value={interruptions.duration_threshold ?? 0.1} onChange={(event) => setField("interruption_settings", { ...interruptions, duration_threshold: Number(event.target.value) })} /></div><div className="space-y-2"><Label>On-number seconds</Label><Input type="number" min="0" step="0.1" value={interruptions.on_number_seconds ?? 0.5} onChange={(event) => setField("interruption_settings", { ...interruptions, on_number_seconds: Number(event.target.value) })} /></div></div> : null}</CardContent></Card>
  </div>;
}
