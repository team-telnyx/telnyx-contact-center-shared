"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRightLeft, Bot, Loader2, Mic, MicOff, MonitorUp, MonitorX, PhoneOff, Video, VideoOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ToastNotify";
import { useVideoRoom } from "@/hooks/use-video-room";
import { VideoLayoutSwitch, VideoStage } from "@/components/video/VideoStage";
import { ChatAvatar } from "./ChatMessageBubble";
import MessagingTransferModal from "./MessagingTransferModal";

const TOKEN_REFRESH_MS = 10 * 60 * 1000;
const LAYOUT_LABELS = { layoutRemote: "Customer only", layoutSplit: "Side by side", layoutPip: "Picture in picture", layoutSpotlight: "Spotlight", layout: "Layout" };

// Agent side of a web video call. The card in the interactions list owns
// accept/decline; once the assignment is active this view joins the Telnyx
// room, renders the 1:1 stage and offers end/transfer.
export default function VideoInteractionDetail({ interaction, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const request = useRef(null);
  const joinRef = useRef(null);
  const joiningRef = useRef(false);
  const endpoint = `/api/contact-center/video/${interaction.id}`;
  const offered = interaction.state === "ringing", wrapup = interaction.state === "wrapup";
  const room = useVideoRoom({ role: "agent", name: detail ? [detail.agent?.first_name, detail.agent?.last_name].filter(Boolean).join(" ") || "Agent" : "Agent", initialCamera: true, initialLayout: "pip",
    onRemoteLayout: (next) => room.setLayout(next, { broadcast: false }) });
  const { setSupervision } = room;

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to load the video call");
      if (!controller.signal.aborted) { setDetail(body); setSupervision(body.video?.supervision || null); }
    } catch (reason) { if (reason.name !== "AbortError") setError(reason.message); }
  }, [endpoint, setSupervision]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    window.addEventListener("contact-center:acd-state", refresh);
    window.addEventListener("contact-center:chat-changed", refresh);
    return () => { clearInterval(timer); request.current?.abort(); window.removeEventListener("contact-center:acd-state", refresh); window.removeEventListener("contact-center:chat-changed", refresh); };
  }, [refresh]);

  // Join as soon as the assignment is active; leave when handling ends.
  const active = detail?.assignmentState === "active" && !wrapup;
  useEffect(() => {
    if (!active || joiningRef.current || room.status === "connected" || room.status === "joining") return;
    joiningRef.current = true;
    (async () => {
      try {
        const response = await fetch(`${endpoint}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Video token unavailable");
        joinRef.current = body.join;
        await room.join({ roomId: body.join.roomId, token: body.join.token });
      } catch (joinError) {
        setError(joinError.message);
        joiningRef.current = false;
      }
    })();
  }, [active, endpoint, room]);

  useEffect(() => {
    if ((wrapup || interaction.completed_at || interaction.abandoned_at || detail?.work?.terminal_at) && room.status !== "idle" && room.status !== "disconnected") void room.leave();
  }, [detail?.work?.terminal_at, interaction.abandoned_at, interaction.completed_at, room, wrapup]);

  useEffect(() => {
    if (room.status !== "connected") return undefined;
    const timer = setInterval(async () => {
      const refreshToken = joinRef.current?.refreshToken;
      if (!refreshToken) return;
      try {
        const response = await fetch(`${endpoint}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken }) });
        const body = await response.json();
        if (response.ok) { joinRef.current = { ...joinRef.current, ...body.join }; await room.updateToken(body.join.token); }
      } catch { /* next poll surfaces a dead session */ }
    }, TOKEN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [endpoint, room]);

  async function endCall() {
    if (busy || !detail) return;
    setBusy(true);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect", commandId: crypto.randomUUID(), expectedVersion: detail.work.version }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to end the video call");
      await room.leave();
      window.dispatchEvent(new CustomEvent("contact-center:chat-changed"));
      onChanged?.();
      await refresh();
    } catch (reason) { notify({ title: "Video call", description: reason.message, variant: "error" }); }
    finally { setBusy(false); }
  }

  const customerName = detail?.customerName || interaction.from_name || "Website visitor";
  const peer = room.peer;
  const labelFor = (tile) => tile.role === "customer" ? customerName : tile.role === "supervisor" ? (tile.name || "Supervisor") : (tile.name || "Participant");
  const tiles = room.tiles.map((tile) => tile.self
    ? { ...tile, label: tile.kind === "screen" ? "Your screen" : "You", cameraOffLabel: "Camera is off" }
    : { ...tile, label: tile.kind === "screen" ? `${labelFor(tile)} · Screen` : labelFor(tile), cameraOffLabel: tile.role === "customer" ? "Customer camera is off" : "Camera is off" });
  const supervision = room.supervision;
  const stateLabel = offered ? "Offered" : wrapup ? "Wrap-up" : room.status === "connected" ? (peer ? "Connected" : "Waiting for the customer") : active ? "Joining…" : "Active";
  const recordingEnabled = Boolean(detail?.video?.recordingEnabled);
  return (
    <div className="@container flex min-h-0 flex-1 flex-col" data-testid="video-interaction-detail">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden bg-muted/20 p-3">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-background shadow-sm" aria-label="Video call">
          <header className="flex shrink-0 items-center gap-3 border-b bg-rose-500/[0.04] px-4 py-3">
            <ChatAvatar name={customerName} className="size-10" />
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-semibold">{customerName}</h3>
              <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground"><Video className="size-3" />{detail?.queueName || interaction.queue_name || "Video"}{recordingEnabled && <><span>·</span><span>Recording</span></>}{detail?.work?.attributes?.handoff && <><span>·</span><Bot className="size-3" /><span>AI handoff</span></>}</p>
            </div>
            <VideoLayoutSwitch layout={room.layout} onChange={(next) => room.setLayout(next)} labels={LAYOUT_LABELS} size={32} iconSize={15}
              buttonStyle={{ borderRadius: 8, borderColor: "var(--border)", backgroundColor: "transparent", color: "inherit" }}
              activeStyle={{ backgroundColor: "rgba(244,63,94,0.12)", color: "rgb(190,18,60)" }} />
            {supervision && <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-700 dark:text-amber-300" title={supervision.name || "Supervisor"} data-testid="video-supervision-badge">{supervision.mode === "monitor" ? "Supervisor listening" : supervision.mode === "whisper" ? "Supervisor whispering" : "Supervisor joined"}</span>}
            <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-rose-500/20 bg-rose-500/5 px-2 py-1 text-[10px] font-medium text-rose-700 dark:text-rose-300"><span className={`size-1.5 rounded-full ${offered ? "animate-pulse bg-amber-500" : wrapup ? "bg-amber-500" : "bg-rose-500"}`} />{stateLabel}</span>
          </header>
          {(error || room.error) && <p role="alert" className="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">{error || room.error}</p>}
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
            {!detail ? <Skeleton className="h-full min-h-[320px] w-full rounded-xl" /> : offered ? (
              <div className="grid flex-1 place-items-center rounded-xl border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">Accept this video call from the interactions list to join the customer.</div>
            ) : wrapup ? (
              <div className="grid flex-1 place-items-center rounded-xl border bg-amber-500/5 p-6 text-center"><div><p className="text-sm font-semibold">Video call ended · Wrap-up in progress</p><p className="mt-1 text-xs text-muted-foreground">Complete the Wrapup Codes sheet to release this slot.</p></div></div>
            ) : (
              <VideoStage scene={room.layout} tiles={tiles} viewerRole="agent" orientation="row" fill
                hiddenLabel={(hidden) => `+${hidden.length} more`}
                mixedAudioTrack={room.mixedAudioTrack} radius={12} className="min-h-[320px]" />
            )}
            {active && (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button type="button" variant={room.micOn ? "outline" : "secondary"} size="icon" className="size-11 rounded-full" aria-label={room.micOn ? "Mute microphone" : "Unmute microphone"} onClick={() => room.toggleMic()}>{room.micOn ? <Mic className="size-5" /> : <MicOff className="size-5" />}</Button>
                <Button type="button" variant="destructive" className="h-11 rounded-full px-5" disabled={busy} onClick={() => void endCall()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <PhoneOff className="size-4" />}End video call</Button>
                <Button type="button" variant={room.cameraOn ? "outline" : "secondary"} size="icon" className="size-11 rounded-full" aria-label={room.cameraOn ? "Turn camera off" : "Turn camera on"} onClick={() => void room.toggleCamera()}>{room.cameraOn ? <Video className="size-5" /> : <VideoOff className="size-5" />}</Button>
                <Button type="button" variant={room.screenSharing ? "secondary" : "outline"} size="icon" className="size-11 rounded-full" aria-label={room.screenSharing ? "Stop sharing your screen" : "Share your screen"} title={room.screenSharing ? "Stop sharing your screen" : "Share your screen"} onClick={() => void room.toggleScreenShare()}>{room.screenSharing ? <MonitorX className="size-5" /> : <MonitorUp className="size-5" />}</Button>
                <Button type="button" variant="outline" className="h-11 rounded-full px-4" disabled={busy} onClick={() => setTransferOpen(true)}><ArrowRightLeft className="size-4" />Transfer</Button>
              </div>
            )}
          </div>
        </section>
      </div>
      {transferOpen && <MessagingTransferModal interaction={interaction} onClose={() => setTransferOpen(false)} onTransferred={() => { void room.leave(); window.dispatchEvent(new CustomEvent("contact-center:chat-changed")); onChanged?.(); }} />}
    </div>
  );
}
