"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, Mic, MicOff, Phone, PhoneOff, RotateCcw, SendHorizontal, ShieldCheck, Volume2, VolumeX, X } from "lucide-react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AudioVisualizer } from "@/components/audio-visualizer";
import { AvatarBridgeProvider } from "@/components/avatar/avatar-bridge";
import { AvatarMediaPanel, latestTranscriptLine } from "@/components/avatar/avatar-media-panel";
import { TelnyxAvatarClient } from "@/lib/ai/telnyx-avatar-client.mjs";
import { mergeTranscript } from "@/lib/widgets/voice-transcript";
import AssistantCallTranscript from "./AssistantCallTranscript";
import { stripTtsExpressionTags } from "@/lib/ai/tts-expression-text.mjs";

const PAD = 12, WIDTH = 360, HEIGHT = 720;
const noop = () => {};
async function callRequest(assistantId, body, signal) {
  const response = await fetch(`/api/ai/assistants/${encodeURIComponent(assistantId)}/call-session`, {
    method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 401 ? "Your Contact Center session has ended. Sign in again." : response.status === 403 ? "You do not have permission to call assistants." : data.error || "Could not prepare the call. Try again.");
  return data;
}
function callError(error) {
  if (error?.name === "NotAllowedError") return "Allow microphone access in your browser, then try again.";
  if (error?.name === "NotFoundError") return "No microphone was found. Connect a microphone, then try again.";
  if (error?.message === "Avatar media connection failed") return "Could not connect the avatar video. Check your network and try again.";
  if (error?.message === "Avatar preparation timed out") return "The assistant took too long to connect. Try again.";
  if (error?.message === "Avatar service unavailable") return "The assistant disconnected. You can start a new call.";
  return error?.message || "Could not connect to the assistant. Try again.";
}

function FloatingPhone({ assistantId, assistantName, onClose }) {
  const tUi = useUiText();
  const [client] = useState(() => new TelnyxAvatarClient());
  const [configuration, setConfiguration] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [transcript, setTranscript] = useState([]);
  const [input, setInput] = useState("");
  const [position, setPosition] = useState(null);
  const [agentState, setAgentState] = useState("listening");
  const [speakingItemId, setSpeakingItemId] = useState(null);
  const [userState, setUserState] = useState("idle");
  const [audioOnly, setAudioOnly] = useState(false);
  const boxRef = useRef(null), transcriptEnd = useRef(null), busy = useRef(false), disposed = useRef(false);
  const requestRef = useRef(null);

  const load = useCallback(async (signal) => {
    setLoading(true); setError(null);
    try { const data = await callRequest(assistantId, undefined, signal); if (!signal?.aborted && !disposed.current) setConfiguration(data); }
    catch (error) { if (!signal?.aborted && !disposed.current) setError(callError(error)); }
    finally { if (!signal?.aborted && !disposed.current) setLoading(false); }
  }, [assistantId]);
  useEffect(() => {
    disposed.current = false;
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void load(controller.signal); });
    const onConversation = ({ call }) => { setActive(call?.state === "active"); if (call?.state !== "active") setStarting(false); };
    const onTranscript = item => setTranscript(current => mergeTranscript(current, item));
    const onError = error => { setError(callError(error)); setStarting(false); };
    const onAgent = ({ state, itemId }) => { setAgentState(state); setSpeakingItemId(state === "speaking" ? itemId : null); };
    const onUser = ({ state }) => setUserState(state);
    const onFallback = () => setAudioOnly(true);
    client.on("conversation.user.state", onUser);
    client.on("conversation.update", onConversation); client.on("transcript.item", onTranscript);
    client.on("agent.error", onError); client.on("conversation.agent.state", onAgent); client.on("avatar.unavailable", onFallback);
    return () => {
      disposed.current = true; controller.abort(); requestRef.current?.abort();
      client.off("conversation.user.state", onUser);
      client.off("conversation.update", onConversation); client.off("transcript.item", onTranscript);
      client.off("agent.error", onError); client.off("conversation.agent.state", onAgent); client.off("avatar.unavailable", onFallback);
      void client.disconnect();
    };
  }, [client, load]);
  useEffect(() => {
    const resize = () => setPosition(current => ({ x: Math.min(current?.x ?? Infinity, Math.max(PAD, window.innerWidth - WIDTH - PAD)), y: Math.min(current?.y ?? Infinity, Math.max(PAD, window.innerHeight - HEIGHT - PAD)) }));
    resize(); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => { transcriptEnd.current?.scrollIntoView({ block: "nearest" }); }, [transcript, userState]);

  const toggleConversation = async () => {
    if (busy.current || loading) return;
    busy.current = true;
    try {
      if (active || starting) { requestRef.current?.abort(); await client.endConversation(); setStarting(false); return; }
      if (!configuration) { await load(); return; }
      setError(null); setStarting(true); setTranscript([]); setMuted(false); setHeld(false); setAudioOnly(false); client.setPlaybackHeld(false);
      requestRef.current = new AbortController();
      await client.startConversation({ avatarSession: () => callRequest(assistantId, { avatar: configuration.avatar }, requestRef.current.signal) });
    } catch (error) { if (!disposed.current) setError(callError(error)); }
    finally { busy.current = false; if (!disposed.current) setStarting(false); }
  };
  const toggleMic = () => {
    if (!active) return;
    if (muted) client.call?.unmuteAudio(); else client.call?.muteAudio();
    setMuted(!muted);
    if (!muted) setUserState("idle");
  };
  const toggleSpeaker = () => { client.setPlaybackHeld(!held); setHeld(!held); };
  const close = async () => { requestRef.current?.abort(); await client.disconnect(); onClose(); };
  const send = event => {
    event.preventDefault();
    if (!active || !input.trim()) return;
    try {
      client.sendConversationMessage(input.trim());
      setInput("");
    } catch (error) { setError(callError(error)); }
  };
  const bridge = useMemo(() => ({ client, isPlaybackHeld: held, hasActiveConversation: active, prepareAvatar: async () => {}, setAvatarPlaybackActive: noop }), [client, held, active]);
  const subtitle = useMemo(() => latestTranscriptLine(transcript, { clean: stripTtsExpressionTags }), [transcript]);
  const controls = { hasActiveConversation: active, isCallControlDisabled: starting || loading, isMicrophoneMuted: muted, isPlaybackHeld: held, toggleConversation, toggleMicrophoneMuted: toggleMic, togglePlaybackHeld: toggleSpeaker };
  const status = error ? tUi("Connection error") : loading ? tUi("Loading assistant…") : starting ? tUi("Connecting…") : active ? tUi(agentState === "speaking" ? "Speaking" : agentState === "thinking" ? "Thinking…" : "Listening") : tUi("Ready to call");
  const statusBadge = <span role="status" className={`inline-flex min-w-0 items-center gap-2 rounded-full border px-2.5 py-1 text-xs ${error ? "border-red-500/40 text-red-500" : active ? "border-emerald-500/40 text-emerald-500" : "border-border text-muted-foreground"}`}><span className={`size-1.5 shrink-0 rounded-full ${active ? "bg-emerald-500" : error ? "bg-red-500" : "bg-current"}`} />{status}</span>;
  const waveform = <div className="flex min-h-24 flex-col items-center justify-center gap-2 p-4 text-muted-foreground">{active && (client.stream || client.playbackStream) ? <AudioVisualizer stream={client.stream || client.playbackStream} className="h-16 w-full" backgroundColor="transparent" /> : <Bot className="size-8 text-primary" />}<p className="text-center text-xs">{audioOnly ? tUi("Video is unavailable. Your voice conversation continues.") : active ? status : tUi("Start a call to talk with the assistant")}</p></div>;
  const avatarFallback = <div className="rounded-xl border border-border bg-muted/30 p-3">{waveform}{subtitle && <div className="rounded-lg border border-white/20 bg-black/65 px-3 py-2 text-center text-sm text-white" aria-live="polite"><p className="text-[10px] font-semibold uppercase tracking-wide text-primary">{tUi(subtitle.role === "user" ? "You" : "Assistant")}</p>{subtitle.content}</div>}</div>;

  return <div ref={boxRef} data-assistant-call className="fixed z-50 flex flex-col rounded-2xl border border-border bg-background shadow-2xl" style={{ left: position?.x, top: position?.y, right: position ? undefined : PAD, bottom: position ? undefined : PAD, width: `min(${WIDTH}px, calc(100vw - 24px))`, height: `min(${HEIGHT}px, calc(100dvh - 24px))` }}>
    <header className="flex touch-none items-center justify-between gap-2 rounded-t-2xl border-b bg-muted px-3 py-3" onPointerDown={event => {
      if (event.target.closest("button") || event.button !== 0) return;
      const rect = boxRef.current.getBoundingClientRect(), dx = event.clientX - rect.left, dy = event.clientY - rect.top;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.dx = dx; event.currentTarget.dataset.dy = dy;
    }} onPointerMove={event => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const rect = boxRef.current.getBoundingClientRect();
      setPosition({ x: Math.max(PAD, Math.min(event.clientX - Number(event.currentTarget.dataset.dx), window.innerWidth - rect.width - PAD)), y: Math.max(PAD, Math.min(event.clientY - Number(event.currentTarget.dataset.dy), window.innerHeight - rect.height - PAD)) });
    }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}>
      <Phone className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{configuration?.name || assistantName || tUi("AI assistant")}</p>{statusBadge}</div>
      <Button variant="ghost" size="icon" aria-label={tUi("Close call window")} onClick={close}><X className="size-4" /></Button>
    </header>
    <div className="flex min-h-0 flex-1 flex-col">
      {error && <div role="alert" className="m-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"><p className="break-words">{tUi(error)}</p><Button variant="outline" size="sm" className="mt-2 gap-2" onClick={() => configuration ? toggleConversation() : load()} disabled={starting}><RotateCcw className="size-3.5" />{tUi("Retry")}</Button></div>}
      {loading ? <div aria-label={tUi("Loading assistant")} className="space-y-3 p-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-80 w-full rounded-xl" /><Skeleton className="h-12 w-full" /></div> : <>
        <div className="flex shrink-0 items-center justify-center gap-4 p-3">
          <Button variant="outline" size="icon" className="size-11 rounded-full" disabled={!active} onClick={toggleMic} aria-label={tUi(muted ? "Unmute microphone" : "Mute microphone")}>{muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}</Button>
          <Button className={`size-14 rounded-full ${active ? "bg-red-500 text-white hover:bg-red-600" : "bg-emerald-500 text-black hover:bg-emerald-400"}`} disabled={starting || !configuration} onClick={toggleConversation} aria-label={tUi(active ? "End call" : "Start call")}>{starting ? <Loader2 className="size-6 animate-spin" /> : active ? <PhoneOff className="size-5" /> : <Phone className="size-5" />}</Button>
          <Button variant="outline" size="icon" className="size-11 rounded-full" disabled={!active} onClick={toggleSpeaker} aria-label={tUi(held ? "Resume speaker" : "Mute speaker")}>{held ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}</Button>
        </div>
        {configuration?.avatar ? <div className="flex min-h-0 flex-1 flex-col px-3 pb-3"><AvatarBridgeProvider value={bridge}><AvatarMediaPanel settings={configuration.avatar} assistantId={assistantId} expanded={expanded} onExpandedChange={setExpanded} controls={controls} statusSlot={statusBadge} latestSubtitle={subtitle} stretch appearance={{ maxHeight: "none", radius: 12, showSubtitles: true }} labels={{ title: configuration.name, connect: tUi("Start call"), disconnect: tUi("End call"), you: tUi("You"), assistant: tUi("Assistant"), expand: tUi("Expand avatar"), collapse: tUi("Exit expanded avatar"), hold: tUi("Mute speaker"), resume: tUi("Resume speaker") }} fallback={avatarFallback} /></AvatarBridgeProvider></div> : waveform}
        {!configuration?.avatar && <AssistantCallTranscript transcript={transcript} active={active} userState={muted ? "idle" : userState} speakingItemId={agentState === "speaking" ? speakingItemId : null} endRef={transcriptEnd} />}
      </>}
    </div>
    <footer className="shrink-0 rounded-b-2xl border-t p-3"><form className="flex gap-2" onSubmit={send}><Input value={input} maxLength={8000} onChange={event => setInput(event.target.value)} disabled={!active} aria-label={tUi("Message to assistant")} placeholder={tUi(active ? "Type a message…" : "Start a call to send a message")} /><Button type="submit" size="icon" disabled={!active || !input.trim()} aria-label={tUi("Send message")}><SendHorizontal className="size-4" /></Button></form><p className="mt-2 flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground"><ShieldCheck className="size-3" />{tUi("Secure calls with your Contact Center account")}</p></footer>
  </div>;
}

export default function AssistantPhoneWidget({ assistantId, assistantName, open, onClose }) {
  if (!open || !assistantId) return null;
  return <FloatingPhone key={assistantId} assistantId={assistantId} assistantName={assistantName} onClose={onClose} />;
}
