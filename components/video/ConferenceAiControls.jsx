"use client";
import { useRef, useState } from "react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { useTrackElement } from "@/hooks/use-video-room";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { VideoToolbarButton as ToolbarButton, videoToolbarClass, videoToolbarButtonClass as iconButtonClass, videoToolbarPalette } from "./VideoToolbar";
import { IconAlertTriangle, IconDeviceDesktop, IconEye, IconFocus2, IconPhotoUp, IconRobot, IconUserPlus, IconVideo, IconVolume, IconVolumeOff, IconX } from "@tabler/icons-react";

function SourcePreview({ track }) {
  const preview = useRef(null);
  useTrackElement(preview, track, { muted: true });
  return track ? <video ref={preview} autoPlay playsInline muted className="aspect-video w-full rounded-md bg-black object-contain" /> : null;
}

export default function ConferenceAiControls({ ai, config, role, agentConnected, room, onAction, allowInvite = false, translate, assistants = [], palette }) {
  const appText = useUiText(), tUi = translate || appText, [busy, setBusy] = useState(false), [error, setError] = useState("");
  const consent = ai?.ownConsent || {};
  const [assistantId, setAssistantId] = useState(config?.assistantId || "");
  const [statusOpen, setStatusOpen] = useState(false);
  const imageInput = useRef(null);
  const effective = ai?.sources?.find(s => s.key === ai.vision?.effectiveSourceKey);
  const own = effective?.role === role;
  const track = effective ? own ? effective.streamKey === "screen" ? room.localScreen : room.local.video
    : room.remote.find(s => s.participantId === effective.participantId && s.key === effective.streamKey)?.videoTrack : null;
  const controls = role === "agent" || !agentConnected;
  const vision = ai?.visionConfig || config?.vision;
  const live = ai && !["stopped", "failed"].includes(ai.state);
  const sourceLabel = type => ({ "customer-camera": tUi("Customer camera"), "agent-camera": tUi("Agent camera"), "customer-screen": tUi("Customer shared screen"), "agent-screen": tUi("Agent shared screen") })[type] || type;
  const visionControls = controls && (role !== "agent" || vision?.agentControls);
  const status = tUi(ai?.desiredState === "muted" ? "Visible, muted" : ai?.state === "connected" ? "Active" : ai?.state === "audio_only" ? "Audio only" : ai?.state === "failed" ? "Unavailable" : ai?.state === "stopped" ? "Stopped" : "Connecting…");
  const paletteStyle = videoToolbarPalette(palette);
  const sourceStatus = tUi(ai?.vision?.uploadStage ? "Analyzing uploaded image…" : ai?.vision?.transitioning ? "Changing Vision source…" : effective ? "Vision source" : "Vision paused");
  const separator = <span aria-hidden="true" className="my-1 w-px self-stretch bg-border" />;
  const imageDisabled = busy || ai?.desiredState !== "active" || ai?.vision?.transitioning || Boolean(ai?.vision?.uploadStage);
  async function action(body) {
    setBusy(true); setError("");
    try { await onAction(body); return true; } catch (e) { setError(e.message); setStatusOpen(true); return false; } finally { setBusy(false); }
  }
  async function upload(file) {
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error(tUi("Choose a JPEG, PNG or WebP image up to 10 MiB"));
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas"); const scale = Math.min(1, 1600 / bitmap.width, 1200 / bitmap.height);
      canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
      let imageUrl;
      for (const quality of [0.8, 0.6, 0.4]) { imageUrl = canvas.toDataURL("image/jpeg", quality); if (imageUrl.length < 1000000) break; }
      if (imageUrl.length >= 1000000) throw new Error(tUi("Image is too large for Vision"));
      await action({ action: "image", imageUrl, prompt: "Analyze the uploaded image and explain what you see." });
    } catch (e) { setError(e.message); setStatusOpen(true); }
  }
  if (!ai && !allowInvite) return null;
  return <div className={videoToolbarClass} role="group" aria-label={`${tUi("AI assistant")} · ${tUi("Vision")}`} data-conference-ai-controls style={paletteStyle}>
    <Popover open={statusOpen} onOpenChange={setStatusOpen}>
      <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" className={`${iconButtonClass} rounded-s-lg`} aria-label={`${tUi("AI assistant")}: ${status}`} title={`${tUi("AI assistant")}: ${status}`}>
        {error || ai?.error ? <IconAlertTriangle className="text-amber-500" /> : <IconRobot />}
        {ai && <span aria-hidden="true" className={`absolute end-1 top-1 size-1.5 rounded-full ${ai.desiredState === "active" && ["connected", "audio_only"].includes(ai.state) ? "bg-emerald-500" : "bg-amber-500"}`} />}
      </Button></PopoverTrigger>
      <PopoverContent onEscapeKeyDown={event => event.stopPropagation()} align="end" className="z-[2147483646] max-w-[calc(100vw-24px)] space-y-3 p-3 text-xs" style={paletteStyle}>
        <div className="flex items-center justify-between gap-3"><strong>{tUi("AI assistant")}</strong>{ai && <span role="status">{status}</span>}</div>
        {allowInvite && !live && <>
          {config?.allowedAssistantIds?.length > 0 && <label className="grid gap-1">{tUi("Assistant to invite")}<select value={assistantId} onChange={e => setAssistantId(e.target.value)} className="h-8 w-full rounded border bg-background px-2">{[...new Set([config.assistantId, ...config.allowedAssistantIds])].filter(Boolean).map(id => <option key={id} value={id}>{assistants.find(a => a.id === id)?.name || id}</option>)}</select></label>}
          <Button type="button" size="sm" disabled={busy} onClick={async () => { if (await action({ action: "invite", assistantId })) setStatusOpen(false); }}>{tUi("Join assistant")}</Button>
        </>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {ai?.error && <p role="status">{tUi("The assistant is unavailable. The human video conference can continue.")}</p>}
      </PopoverContent>
    </Popover>
    {live && controls && <ToolbarButton palette={palette} label={tUi(ai.desiredState === "muted" ? "Activate assistant" : "Mute assistant")} pressed={ai.desiredState === "active"} disabled={busy} onClick={() => action({ action: ai.desiredState === "active" ? "muted" : "active" })}>{ai.desiredState === "active" ? <IconVolume /> : <IconVolumeOff />}</ToolbarButton>}
    {live && vision && vision.mode !== "disabled" && <>
      {separator}
      {vision.mode === "live" && <>
        {["camera", "screen"].filter(kind => vision.allowedSources.includes(`${role}-${kind}`)).map(kind => <ToolbarButton key={kind} palette={palette} label={tUi(kind === "camera" ? "Allow AI to see my camera" : "Allow AI to see my shared screen")} pressed={consent[kind] === true} disabled={busy} onClick={() => action({ action: "consent", source: kind, enabled: consent[kind] !== true })}>
          {kind === "camera" ? <IconVideo /> : <IconDeviceDesktop />}
        </ToolbarButton>)}
        <Popover>
          <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" className={iconButtonClass} aria-label={tUi("Vision source")} title={`${sourceStatus}${effective ? `: ${sourceLabel(effective.type)}` : ""}`}><IconEye />{effective && <span aria-hidden="true" className="absolute end-1 top-1 size-1.5 rounded-full bg-emerald-500" />}</Button></PopoverTrigger>
          <PopoverContent onEscapeKeyDown={event => event.stopPropagation()} align="end" className="z-[2147483646] max-w-[calc(100vw-24px)] space-y-2 p-3 text-xs" style={paletteStyle}>
            <strong>{tUi("Vision source")}</strong>
            <p aria-live="polite">{sourceStatus}{effective ? `: ${sourceLabel(effective.type)}` : ""}</p>
            <SourcePreview track={track} />
            {visionControls && <select className="h-8 w-full rounded-md border bg-background px-2" aria-label={tUi("Vision source")} disabled={busy}
              value={ai.vision?.selection === "automatic" || !ai.vision?.selection && vision.selection === "automatic" ? "automatic" : ai.vision?.requestedSourceKey || "paused"}
              onChange={e => action({ action: "vision-source", sourceKey: ["automatic", "paused"].includes(e.target.value) ? null : e.target.value, automatic: e.target.value === "automatic" })}>
              {ai.vision?.selection === "manual" && ai.vision.requestedSourceKey && !ai.sources?.some(s => s.key === ai.vision.requestedSourceKey) && <option value={ai.vision.requestedSourceKey} disabled>{tUi("Selected source unavailable")}</option>}
              <option value="paused">{tUi("Vision paused")}</option><option value="automatic">{tUi("Automatic source selection")}</option>
              {(ai.sources || []).filter(s => vision.allowedSources.includes(s.type) && (role === "agent" || s.role === "customer")).map(s => <option key={s.key} value={s.key} disabled={!s.available || !s.consented}>{sourceLabel(s.type)}{s.name ? ` · ${s.name}` : ""}{!s.available || !s.consented ? ` · ${tUi("Unavailable")}` : ""}</option>)}
            </select>}
          </PopoverContent>
        </Popover>
      </>}
      {visionControls && <>
        {vision.mode === "live" && <ToolbarButton label={tUi("Analyze current frame")} disabled={!effective || imageDisabled} onClick={() => action({ action: "analyze" })}><IconFocus2 /></ToolbarButton>}
        <ToolbarButton label={tUi("Send image to Vision")} disabled={imageDisabled} onClick={() => imageInput.current?.click()}><IconPhotoUp /></ToolbarButton>
        <input ref={imageInput} className="hidden" type="file" accept="image/jpeg,image/png,image/webp" disabled={imageDisabled} onChange={e => { upload(e.target.files?.[0]); e.target.value = ""; }} />
      </>}
    </>}
    {live && controls && <>
      {separator}
      {role === "customer" && <ToolbarButton label={tUi("Talk to an agent")} disabled={busy} onClick={() => action({ action: "handoff" })}><IconUserPlus /></ToolbarButton>}
      <ToolbarButton label={tUi("Remove assistant")} disabled={busy} onClick={() => action({ action: "stopped" })}><IconX /></ToolbarButton>
    </>}
    <span role="status" className="sr-only">{status} · {sourceStatus}</span>
  </div>;
}
