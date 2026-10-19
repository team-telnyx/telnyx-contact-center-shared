"use client";
import { useUiText } from "@/components/i18n/use-ui-text";

import { DeviceHandoff } from "./DeviceHandoff";
import { readVideoResponse } from "@/lib/video/client-response.mjs";
import { voiceFetch, subscribeVoiceEndpoints } from "@/lib/telephony/endpoint-client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRightLeft, Bot, Loader2, Mic, MicOff, MonitorUp, MonitorX, PhoneOff, Video, VideoOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ToastNotify";
import { useVideoRoom } from "@/hooks/use-video-room";
import { VideoLayoutSwitch, VideoStage } from "@/components/video/VideoStage";
import { ChatAvatar } from "./ChatMessageBubble";
import ConferenceAiControls from "@/components/video/ConferenceAiControls";
import MessagingTransferModal from "./MessagingTransferModal";

const TOKEN_REFRESH_MS = 10 * 60 * 1000;
const LAYOUT_LABELS = { layoutRemote: "Customer only", layoutSplit: "Side by side", layoutPip: "Picture in picture", layoutSpotlight: "Spotlight", layout: "Layout" };

// Agent side of a web video call. The card in the interactions list owns
// accept/decline; once the assignment is active this view joins the Telnyx
// room, renders the 1:1 stage and offers end/transfer.
export default function VideoInteractionDetail({ interaction, onChanged, headerTarget }) {
  const tUi = useUiText();
  const [acceptingMove,setAcceptingMove]=useState(false);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const moveAttempt = useRef(null);
  useEffect(() => () => { moveAttempt.current?.abort(); }, [interaction.id]);
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
      const response = await voiceFetch(endpoint, { cache: "no-store", signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to load the video call");
      if (!controller.signal.aborted) { setDetail(body); setSupervision(body.video?.supervision || null); }
    } catch (reason) { if (reason.name !== "AbortError") setError(reason.message); }
  }, [endpoint, setSupervision]);

  useEffect(() => {
    const unsubscribe = subscribeVoiceEndpoints(() => void refresh());
    const timer = setInterval(() => void refresh(), 2000);
    window.addEventListener("contact-center:acd-state", refresh);
    window.addEventListener("contact-center:chat-changed", refresh);
    return () => { unsubscribe(); clearInterval(timer); request.current?.abort(); window.removeEventListener("contact-center:acd-state", refresh); window.removeEventListener("contact-center:chat-changed", refresh); };
  }, [refresh]);

  const { updateToken, status: roomStatus } = room;
  // Join as soon as the assignment is active; leave when handling ends.
  const canControl = Boolean(detail && detail.deviceControl?.canControl !== false);
  const active = detail?.assignmentState === "active" && !wrapup && canControl;
  useEffect(() => {
    if (!active || joiningRef.current || room.status === "connected" || room.status === "joining") return;
    joiningRef.current = true;
    (async () => {
      try {
        const response = await voiceFetch(`${endpoint}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Video token unavailable");
        joinRef.current = body.join;
        await room.join({ ...body.join, onJoined: async participantId => {
          if (!body.join.member) return;
          const result = await voiceFetch(`${endpoint}/ai`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "bind", ...body.join.member, participantId }) });
          if (!result.ok) throw new Error("Unable to authorize conference participant");
        } });
      } catch (joinError) {
        setError(joinError.message);
        joiningRef.current = false;
      }
    })();
  }, [active, endpoint, room]);

  useEffect(() => {
    if (((!canControl && !acceptingMove) || wrapup || interaction.completed_at || interaction.abandoned_at || detail?.work?.terminal_at) && room.status !== "idle" && room.status !== "disconnected") void room.leave();
  }, [acceptingMove, canControl, detail?.work?.terminal_at, interaction.abandoned_at, interaction.completed_at, room, wrapup]);

  useEffect(() => {
    if (roomStatus !== "connected") return undefined;
    const timer = setInterval(async () => {
      const refreshToken = joinRef.current?.refreshToken;
      if (!refreshToken) return;
      try {
        const response = await voiceFetch(`${endpoint}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken }) });
        const body = await response.json();
        if (response.ok) { joinRef.current = { ...joinRef.current, ...body.join }; await updateToken(body.join.token); }
      } catch { /* next poll surfaces a dead session */ }
    }, TOKEN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [endpoint, roomStatus, updateToken]);

  async function joinMovedVideo(join, id) {
    moveAttempt.current?.abort();
    const attempt = new AbortController();
    moveAttempt.current = attempt;
    setAcceptingMove(true); joiningRef.current = true;
    const movePath = `/api/contact-center/interactions/${interaction.id}/device-handoff`;
    try {
      joinRef.current = join;
      await room.prepare({camera: true});
      if (attempt.signal.aborted) return;
      let movedParticipantId;
      await room.join({...join, media: false, onJoined: async participantId => { movedParticipantId = participantId; }});
      while (!attempt.signal.aborted) {
        let result;
        try {
          const response = await voiceFetch(movePath, {method: 'POST', signal: attempt.signal,
            headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action: 'ready', id})});
          if (response.ok) result = await response.json();
          else {
            // A cancelled move also returns 409. Read its authoritative outcome
            // instead of retrying forever or abandoning an uncertain cutover.
            const state = await voiceFetch(movePath, {cache: 'no-store', signal: attempt.signal});
            if (state.ok) result = await state.json();
            else if ([401, 403, 404].includes(state.status)) result = {handoff: {state: 'failed'}};
          }
        } catch (reason) {
          if (attempt.signal.aborted) return;
          setError('Reconnecting to confirm the video move…');
        }
        if (result) {
          if (result.handoff?.id !== id || ['cancelled', 'failed'].includes(result.handoff?.state))
            throw new Error('The video move ended. Check the device handling the call.');
          if (result.handoff.completed) {
            if (attempt.signal.aborted) return;
            if (join.member) {
              const response = await voiceFetch(`${endpoint}/ai`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'bind',...join.member,participantId:movedParticipantId})});
              if (!response.ok) throw new Error('Unable to bind the video participant');
            }
            await refresh();
            await room.resumeAfterHandoff();
            setError('');
            return;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (reason) {
      await room.leave();
      if (!attempt.signal.aborted) setError(reason.message);
    } finally {
      if (moveAttempt.current === attempt) { setAcceptingMove(false); joiningRef.current = false; }
    }
  }

  async function endCall() {
    if (busy || !detail || !canControl) return;
    setBusy(true);
    try {
      const response = await voiceFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
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

  const customerName = detail?.customerName || interaction.from_name || tUi("Website visitor");
  const peer = room.peer;
  const labelFor = (tile) => tile.role === "customer" ? customerName : tile.role === "supervisor" ? (tile.name || "Supervisor") : (tile.name || "Participant");
  const tiles = room.tiles.map((tile) => tile.self
    ? { ...tile, label: tile.kind === "screen" ? tUi("Your screen") : tUi("You"), cameraOffLabel: tUi("Camera is off") }
    : { ...tile, poster: tile.role === "ai" ? detail?.ai?.avatar?.previewUrl : null, label: tile.kind === "screen" ? `${labelFor(tile)} · Screen` : labelFor(tile), cameraOffLabel: tile.role === "customer" ? "Customer camera is off" : "Camera is off" });
  if (detail?.ai?.avatar?.enabled && !["stopped", "failed"].includes(detail.ai.state) && !tiles.some(tile => tile.role === "ai")) tiles.push({id:"pending-ai",role:"ai",kind:"camera",label:detail.ai.avatar.name||tUi("AI assistant"),poster:detail.ai.avatar.previewUrl});
  const supervision = room.supervision;
  const stateLabel = offered ? "Offered" : wrapup ? "Wrap-up" : room.status === "connected" ? (peer ? "Connected" : "Waiting for the customer") : active ? "Joining…" : "Active";
  const recordingEnabled = Boolean(detail?.video?.recordingEnabled);
  const headerContent = (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2" data-testid="video-interaction-header">
      <div className="flex min-w-0 max-w-full items-center gap-2 overflow-x-auto p-0.5">
      {active && <ConferenceAiControls ai={detail.ai} config={detail.conferenceConfig?.ai} assistants={detail.conferenceAssistants} role="agent" agentConnected room={room} allowInvite={detail.conferenceConfig?.ai?.allowAgentInvite}
      onAction={async body => { const response = await voiceFetch(`${endpoint}/ai`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const result = await readVideoResponse(response); await refresh(); return result; }} />}
      <VideoLayoutSwitch toolbar layout={room.layout} onChange={(next) => room.setLayout(next)} labels={LAYOUT_LABELS} />
      </div>
      {supervision && <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-700 dark:text-amber-300" title={supervision.name || tUi("Supervisor")} data-testid="video-supervision-badge">{supervision.mode === "monitor" ? tUi("Supervisor listening") : supervision.mode === "whisper" ? tUi("Supervisor whispering") : tUi("Supervisor joined")}</span>}
      <div className="ms-auto flex min-w-0 items-center gap-2">
        <ChatAvatar name={customerName} className="size-8 shrink-0" />
        <div className="min-w-0 max-w-64">
          <h3 className="truncate text-xs font-semibold" title={customerName}>{customerName}</h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground"><span className="max-w-36 truncate" title={detail?.queueName || interaction.queue_name}>{detail?.queueName || interaction.queue_name || tUi("Video")}</span>{recordingEnabled && <><span>·</span><span>{tUi("Recording")}</span></>}{detail?.work?.attributes?.handoff && <><span>·</span><Bot className="size-3" /><span>{tUi("AI handoff")}</span></>}</p>
        </div>
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-rose-500/20 bg-rose-500/5 px-2 py-1 text-[10px] font-medium text-rose-700 dark:text-rose-300"><span className={`size-1.5 rounded-full ${offered ? "animate-pulse bg-amber-500" : wrapup ? "bg-amber-500" : "bg-rose-500"}`} />{tUi(stateLabel)}</span>
      </div>
    </div>
  );
  return (
    <div className="@container flex min-h-0 flex-1 flex-col" data-help-id="agent.video" data-testid="video-interaction-detail">
      {headerTarget && createPortal(headerContent, headerTarget)}
      {detail?.assignmentState==='active'&&!wrapup&&<DeviceHandoff interactionId={interaction.id} onJoinVideo={joinMovedVideo}/>}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden bg-muted/20 p-3">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-background shadow-sm" aria-label={tUi("Video call")}>
          {!headerTarget && <header className="shrink-0 border-b bg-rose-500/[0.04] px-3 py-2">{headerContent}</header>}
          {(error || room.error) && <p role="alert" className="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">{error || room.error}</p>}
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
            {!detail ? <Skeleton className="h-full min-h-[320px] w-full rounded-xl" /> : offered ? (
              <div className="grid flex-1 place-items-center rounded-xl border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">{tUi("Accept this video call from the interactions list to join the customer.")}</div>
            ) : wrapup ? (
              <div className="grid flex-1 place-items-center rounded-xl border bg-amber-500/5 p-6 text-center"><div><p className="text-sm font-semibold">{tUi("Video call ended · Wrap-up in progress")}</p><p className="mt-1 text-xs text-muted-foreground">{tUi("Complete the Wrapup Codes sheet to release this slot.")}</p></div></div>
            ) : (
              <>
      <VideoStage scene={room.layout} tiles={tiles} viewerRole="agent" orientation="row" fill
                hiddenLabel={(hidden) => `+${hidden.length} more`}
                audioTracks={room.audioTracks} radius={12} className="min-h-[320px]" />
              {detail.aiTranscript?.length > 0 && <details className="rounded border p-2 text-xs"><summary>{tUi("Assistant transcript")}</summary><div className="mt-2 max-h-40 space-y-2 overflow-y-auto">{detail.aiTranscript.map(item => <p key={item.id}><strong>{tUi(item.payload.role === "assistant" ? "AI assistant" : "Participant")}: </strong>{item.payload.text}</p>)}</div></details>}
              </>
            )}
            {detail?.assignmentState === "active" && !wrapup && (
              <div>
              <fieldset disabled={!canControl} className="flex flex-wrap items-center justify-center gap-2">
                <Button type="button" variant={room.micOn ? "outline" : "secondary"} size="icon" className="size-11 rounded-full" aria-label={room.micOn ? tUi("Mute microphone") : tUi("Unmute microphone")} onClick={() => room.toggleMic()}>{room.micOn ? <Mic className="size-5" /> : <MicOff className="size-5" />}</Button>
                <Button type="button" variant="destructive" className="h-11 rounded-full px-5" disabled={busy} onClick={() => void endCall()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <PhoneOff className="size-4" />}{tUi("End video call")}</Button>
                <Button type="button" variant={room.cameraOn ? "outline" : "secondary"} size="icon" className="size-11 rounded-full" aria-label={room.cameraOn ? tUi("Turn camera off") : tUi("Turn camera on")} onClick={() => void room.toggleCamera()}>{room.cameraOn ? <Video className="size-5" /> : <VideoOff className="size-5" />}</Button>
                <Button type="button" variant={room.screenSharing ? "secondary" : "outline"} size="icon" className="size-11 rounded-full" aria-label={room.screenSharing ? tUi("Stop sharing your screen") : tUi("Share your screen")} title={room.screenSharing ? tUi("Stop sharing your screen") : tUi("Share your screen")} onClick={() => void room.toggleScreenShare()}>{room.screenSharing ? <MonitorX className="size-5" /> : <MonitorUp className="size-5" />}</Button>
                <Button type="button" variant="outline" className="h-11 rounded-full px-4" disabled={busy} onClick={() => setTransferOpen(true)}><ArrowRightLeft className="size-4" />{tUi("Transfer")}</Button>
              </fieldset>
              </div>
            )}
          </div>
        </section>
      </div>
      {transferOpen && canControl && <MessagingTransferModal interaction={interaction} onClose={() => setTransferOpen(false)} onTransferred={() => { void room.leave(); window.dispatchEvent(new CustomEvent("contact-center:chat-changed")); onChanged?.(); }} />}
    </div>
  );
}
