"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Ear, Loader2, MessageSquareText, Mic, MicOff, PhoneOff, Users, Video, VideoOff } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/components/auth-provider";
import { useVideoRoom } from "@/hooks/use-video-room";
import { VideoLayoutSwitch, VideoStage } from "@/components/video/VideoStage";
import { InteractionChannel } from "./InteractionChannel";

// Supervisor side of a web video call (the internal documentation §2).
// The supervisor joins the Telnyx room as a third participant without media;
// whisper and barge publish the microphone (and optionally the camera). The
// mode travels in the join context and, on change, in a room message; the
// server keeps it for clients that reconnect.
const MODES = [
  { id: "monitor", label: "Monitor", description: "Listen and watch; nobody hears or sees you.", permission: "calls:supervise.listen", Icon: Ear },
  { id: "whisper", label: "Whisper", description: "Only the agent hears you.", permission: "calls:supervise.whisper", Icon: MessageSquareText },
  { id: "barge", label: "Barge", description: "Both sides hear you; your camera may join the scene.", permission: "calls:supervise.barge", Icon: Users },
];
const LAYOUT_LABELS = { layoutRemote: "Customer only", layoutSplit: "Grid", layoutPip: "Picture in picture", layoutSpotlight: "Spotlight", layout: "Layout" };
const TOKEN_REFRESH_MS = 10 * 60 * 1000;

export default function VideoSupervisionModal({ open, onOpenChange, interaction }) {
  const { can } = useAuth();
  const workItemId = interaction.workItemId || interaction.id;
  const endpoint = `/api/contact-center/video/${workItemId}/supervise`;
  const allowed = MODES.filter((mode) => can(mode.permission));
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const joinRef = useRef(null);
  const room = useVideoRoom({ role: "supervisor", name: "Supervisor", initialCamera: false, initialLayout: "spotlight" });
  const { leave: leaveRoom } = room;

  const post = useCallback(async (body) => {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Video supervision failed");
    return payload;
  }, [endpoint]);

  const start = useCallback(async (nextMode) => {
    setBusy(true); setError("");
    let started = false;
    try {
      const { join } = await post({ action: "start", mode: nextMode });
      started = true;
      joinRef.current = join;
      await room.join({ roomId: join.roomId, token: join.token, context: join.context, media: false });
      setMode(nextMode);
      if (nextMode !== "monitor") await room.toggleMic();
    } catch (startError) {
      setError(startError.message);
      // The seat is claimed server-side; a participant who never joined sends no "left" webhook.
      if (started) await post({ action: "end", supervisionId: joinRef.current?.context?.supervisionId }).catch(() => undefined);
    } finally { setBusy(false); }
  }, [post, room]);

  const switchMode = useCallback(async (nextMode) => {
    if (busy || nextMode === mode) return;
    setBusy(true); setError("");
    try {
      await post({ action: "mode", mode: nextMode, supervisionId: joinRef.current?.context?.supervisionId });
      setMode(nextMode);
      room.announceSupervision(nextMode);
      // Monitor publishes nothing: mute when stepping back, unmute when stepping in.
      if (nextMode === "monitor" && room.micOn) await room.toggleMic();
      if (nextMode !== "monitor" && !room.micOn) await room.toggleMic();
      if (nextMode !== "barge" && room.cameraOn) await room.toggleCamera();
    } catch (switchError) { setError(switchError.message); }
    finally { setBusy(false); }
  }, [busy, mode, post, room]);

  const stop = useCallback(async () => {
    await leaveRoom().catch(() => undefined);
    if (mode) await post({ action: "end", supervisionId: joinRef.current?.context?.supervisionId }).catch(() => undefined);
    setMode(null);
  }, [leaveRoom, mode, post]);

  useEffect(() => {
    if (!open) return undefined;
    if (!mode && !busy && allowed.length && room.status === "idle") void start(allowed[0].id);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (room.status !== "connected") return undefined;
    const timer = setInterval(async () => {
      const refreshToken = joinRef.current?.refreshToken;
      if (!refreshToken) return;
      try { const { join } = await post({ action: "refresh", refreshToken }); joinRef.current = { ...joinRef.current, ...join }; await room.updateToken(join.token); } catch { /* next poll surfaces it */ }
    }, TOKEN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [post, room]);

  const close = async (next) => { if (!next) await stop(); onOpenChange(next); };
  const labelFor = (tile) => tile.role === "customer" ? (interaction.customerName || "Customer") : tile.role === "agent" ? (interaction.agentName || interaction.agentUsername || "Agent") : (tile.name || "Participant");
  const tiles = room.tiles.map((tile) => tile.self
    ? { ...tile, label: tile.kind === "screen" ? "Your screen" : "You", cameraOffLabel: mode === "barge" ? "Camera is off" : "Not visible to the call" }
    : { ...tile, label: tile.kind === "screen" ? `${labelFor(tile)} · Screen` : labelFor(tile), cameraOffLabel: "Camera is off" });
  // Own camera tile only when barging; otherwise the scene shows the call as it is.
  const visibleTiles = mode === "barge" ? tiles : tiles.filter((tile) => !tile.self);
  const connected = room.status === "connected";

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[90dvh] flex-col gap-3 sm:max-w-5xl" data-testid="video-supervision-dialog" data-mode={mode || ""}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3"><InteractionChannel channel="video" />Supervise video call</DialogTitle>
          <DialogDescription>{interaction.customerName || "Website visitor"} with {interaction.agentName || interaction.agentUsername || "the agent"}{interaction.queueName ? ` · ${interaction.queueName}` : ""}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-3">
          {MODES.map(({ id, label, description, Icon, permission }) => {
            const enabled = can(permission);
            return (
              <button key={id} type="button" disabled={!enabled || busy} onClick={() => void (connected ? switchMode(id) : start(id))} aria-pressed={mode === id} data-testid={`video-supervision-${id}`}
                className={`flex items-start gap-3 rounded-xl border p-3 text-left transition disabled:opacity-50 ${mode === id ? "border-amber-500 bg-amber-500/10" : "hover:bg-muted/50"}`}>
                <Icon className="mt-0.5 size-4 shrink-0" />
                <span><span className="block text-sm font-semibold">{label}</span><span className="block text-xs text-muted-foreground">{enabled ? description : "No permission"}</span></span>
              </button>
            );
          })}
        </div>
        {(error || room.error) && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error || room.error}</p>}
        <div className="flex min-h-[320px] flex-1 flex-col gap-2 overflow-hidden rounded-xl border bg-black/90 p-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-xs text-white/70">{!connected ? (busy ? "Joining the room…" : "Not connected") : mode === "monitor" ? "Listening silently" : mode === "whisper" ? "Only the agent hears you" : "Everyone hears you"}</span>
            <VideoLayoutSwitch layout={room.layout} onChange={(next) => room.setLayout(next, { broadcast: false })} labels={LAYOUT_LABELS} size={28} iconSize={14}
              buttonStyle={{ borderRadius: 6, borderColor: "rgba(255,255,255,0.25)", backgroundColor: "transparent", color: "#fff" }} activeStyle={{ backgroundColor: "rgba(245,158,11,0.35)" }} />
          </div>
          <VideoStage scene={room.layout} tiles={visibleTiles} viewerRole="supervisor" orientation="row" fill mixedAudioTrack={room.mixedAudioTrack} radius={10} hiddenLabel={(hidden) => `+${hidden.length} more`} className="min-h-[280px]" />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant={room.micOn ? "outline" : "secondary"} size="icon" className="size-11 rounded-full" disabled={!connected || mode === "monitor"} aria-label={room.micOn ? "Mute" : "Unmute"} onClick={() => room.toggleMic()}>{room.micOn ? <Mic className="size-5" /> : <MicOff className="size-5" />}</Button>
          <Button type="button" variant={room.cameraOn ? "outline" : "secondary"} size="icon" className="size-11 rounded-full" disabled={!connected || mode !== "barge"} aria-label={room.cameraOn ? "Turn camera off" : "Turn camera on"} onClick={() => void room.toggleCamera()}>{room.cameraOn ? <Video className="size-5" /> : <VideoOff className="size-5" />}</Button>
          <Button type="button" variant="destructive" className="h-11 rounded-full px-5" disabled={busy && !connected} onClick={() => void close(false)}>{busy && !connected ? <Loader2 className="size-4 animate-spin" /> : <PhoneOff className="size-4" />}Leave</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
