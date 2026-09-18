"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Mic, MicOff, Minimize2, MonitorUp, MonitorX, PhoneOff, Video, VideoOff } from "lucide-react";
import { widgetDirection, widgetTranslations } from "@/lib/widgets/locales";
import { requestFreshWidgetBootstrap } from "@/lib/widgets/bootstrap-client";
import { useVideoRoom } from "@/hooks/use-video-room";
import { VideoLayoutSwitch, VideoStage, WaitingPlaylist } from "@/components/video/VideoStage";
import { sceneAspect } from "@/lib/video/scenes.mjs";
import HandoffTimeline from "./HandoffTimeline";
import { handoffTimelinePhases } from "@/lib/widgets/handoff-timeline";
import WidgetIcon from "./WidgetIcon";

const TOKEN_REFRESH_MS = 10 * 60 * 1000;
// Every video frame keeps 4:3; the scene planner arranges them per scene
// (the internal documentation §1). The enlarged modal takes the
// configured share of the page width unless the height limit makes it
// narrower, so the frames keep their proportions.
const FRAME_ASPECT = 4 / 3, MODAL_MAX_HEIGHT_PERCENT = 85;
const MODAL_WIDTH_PERCENT = { small: 50, medium: 75, large: 90, fullscreen: 100 };

function interpolate(template, values) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
}

async function widgetFetch(path, token, { method = "GET", body = null, keepalive = false } = {}) {
  const response = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    keepalive,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || "Request failed"), { status: response.status });
  return result;
}

// "Voice & Video Call": the visitor joins a Telnyx room straight from the
// widget, waits in the Contact Center queue (playlist + handoff timeline), then
// talks to the agent 1:1. Audio-only is the same session with the camera off.
export default function VideoWidgetRuntime({ widget, preview = false, previewScenario = null, onClose, onHome }) {
  const config = widget.config;
  // Widget Studio previews one call state: connected (default), waiting in
  // the queue, the agent sharing a screen, or a supervisor as a third tile.
  const scenario = preview ? String(previewScenario || "").replace(/^video:/, "") || "connected" : null;
  const video = config.channels.video || {};
  // The page gets the public projection (`recording` as a boolean); the Studio
  // previews the draft, where it is still `{ enabled, layout }`.
  const recordingEnabled = video.recording && typeof video.recording === "object" ? video.recording.enabled !== false : Boolean(video.recording);
  const edgeInsets = widget.edgeToEdge && widget.edgeInsets ? widget.edgeInsets : { top: 0, right: 0, bottom: 0, left: 0 };
  const ui = widgetTranslations(config.locale);
  const direction = widgetDirection(config.locale);
  const [phase, setPhase] = useState(preview ? (scenario === "waiting" || scenario === "prejoin" ? scenario : "connected") : "prejoin"); // prejoin | starting | waiting | connected | ended | error
  const [error, setError] = useState("");
  const [handoff, setHandoff] = useState(preview ? (scenario === "prejoin" ? null : { status: scenario === "waiting" ? "waiting" : "connected", queueName: ui.preview.fallbackQueue, agentName: scenario === "waiting" ? null : "Anna Kowalska" }) : null);
  const [sessionToken, setSessionToken] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [chromeHeight, setChromeHeight] = useState(0);
  const mainRef = useRef(null);
  const sessionTokenRef = useRef(null);
  const joinRef = useRef(null);
  const leftRef = useRef(false);
  const room = useVideoRoom({
    role: "customer",
    name: String(widget.decisionContext?.["customer.name"] || widget.decisionContext?.customer_name || "Website visitor"),
    initialCamera: video.camera !== "off",
    initialLayout: video.scenes?.default || "pip",
    onRemoteLayout: (next) => room.setLayout(next, { broadcast: false }),
  });
  const { setLayout, setSupervision } = room;
  // The Studio preview follows the configured default scene as it is edited.
  useEffect(() => { if (preview && video.scenes?.default) setLayout(video.scenes.default, { broadcast: false }); }, [preview, setLayout, video.scenes?.default]);

  const colors = config.theme.colors;
  // Floating controls scale with the configured panel size.
  const overlayScale = { compact: 0.8, regular: 1, large: 1.25 }[video.controls?.overlay?.size] || 1;
  const baseControls = config.components.voice.controls;
  const controls = useMemo(() => video.controls?.position !== "overlay" || overlayScale === 1 ? baseControls
    : { ...baseControls, buttonSize: Math.round(baseControls.buttonSize * overlayScale), callButtonSize: Math.round(baseControls.callButtonSize * overlayScale), iconSize: Math.round(baseControls.iconSize * overlayScale), gap: Math.round(baseControls.gap * overlayScale) },
  [baseControls, overlayScale, video.controls?.position]);
  const frameStyle = useMemo(() => ({
    backgroundColor: colors.surface,
    color: colors.text,
    borderColor: colors.border,
    borderRadius: widget.edgeToEdge ? 0 : config.theme.shape.panelRadius,
    borderWidth: widget.edgeToEdge ? 0 : undefined,
    fontFamily: `"${config.theme.typography.fontFamily}", ui-sans-serif, system-ui, sans-serif`,
    fontSize: config.theme.typography.baseSize,
  }), [colors, config.theme, widget.edgeToEdge]);

  // Camera preview before the call.
  useEffect(() => {
    if (preview || phase !== "prejoin") return;
    room.prepare().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, preview]);

  const start = useCallback(async () => {
    if (preview || !["prejoin", "error"].includes(phase)) return;
    setError("");
    setPhase("starting");
    try {
      const fresh = await requestFreshWidgetBootstrap(widget.id);
      const result = await widgetFetch(`/api/widgets/${encodeURIComponent(widget.id)}/sessions`, fresh.bootstrapToken, {
        method: "POST",
        body: { channel: "video", clientKey: crypto.randomUUID(), context: fresh.decisionContext || widget.decisionContext || {} },
      });
      sessionTokenRef.current = result.sessionToken;
      setSessionToken(result.sessionToken);
      setHandoff(result.handoff || null);
      window.parent.postMessage({ type: "telnyx-widget-session", active: true }, new URLSearchParams(window.location.search).get("parentOrigin") || "*");
      const joined = await widgetFetch("/api/widget-sessions/video/join", result.sessionToken, { method: "POST" });
      joinRef.current = joined.join;
      await room.join({ roomId: joined.join.roomId, token: joined.join.token });
      setPhase(joined.handoff?.status === "connected" ? "connected" : "waiting");
    } catch (startError) {
      console.error("[telnyx-widget-video] start failed:", startError);
      const token = sessionTokenRef.current;
      sessionTokenRef.current = null;
      setSessionToken(null);
      await room.leave().catch(() => undefined);
      if (token) await widgetFetch("/api/widget-sessions/video/leave", token, { method: "POST", keepalive: true }).catch(() => undefined);
      setError(config.content.videoErrorMessage);
      setPhase("error");
    }
  }, [config.content.videoErrorMessage, phase, preview, room, widget]);

  const leave = useCallback(async ({ silent = false } = {}) => {
    if (leftRef.current) return;
    leftRef.current = true;
    const token = sessionTokenRef.current;
    await room.leave();
    if (token) await widgetFetch("/api/widget-sessions/video/leave", token, { method: "POST", keepalive: true }).catch(() => undefined);
    if (!silent) setPhase("ended");
  }, [room]);

  // Queue and agent state, polled while the session lives; it also keeps the session alive.
  useEffect(() => {
    if (preview || !sessionToken || ["ended", "error"].includes(phase)) return undefined;
    let cancelled = false, timer;
    async function poll() {
      try {
        const state = await widgetFetch("/api/widget-sessions/video-state", sessionToken);
        if (cancelled) return;
        setHandoff(state.handoff || null);
        setSupervision(state.supervision || null);
        if (state.handoff?.status === "disconnected") {
          await leave({ silent: true });
          setPhase("ended");
          return;
        }
        setPhase((current) => (current === "waiting" || current === "connected") ? (state.handoff?.status === "connected" ? "connected" : "waiting") : current);
      } catch (pollError) {
        if (!cancelled && [401, 403, 409].includes(pollError.status)) { await leave({ silent: true }); setPhase("ended"); return; }
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 2000);
      }
    }
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [leave, phase, preview, sessionToken, setSupervision]);

  // Join tokens live 15 minutes; refresh well before that.
  useEffect(() => {
    if (preview || !sessionToken || !["waiting", "connected"].includes(phase)) return undefined;
    const timer = window.setInterval(async () => {
      const refreshToken = joinRef.current?.refreshToken;
      if (!refreshToken) return;
      try {
        const result = await widgetFetch("/api/widget-sessions/video/token", sessionToken, { method: "POST", body: { refreshToken } });
        joinRef.current = { ...joinRef.current, ...result.join };
        await room.updateToken(result.join.token);
      } catch { /* the next poll surfaces a dead session */ }
    }, TOKEN_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [phase, preview, room, sessionToken]);

  useEffect(() => {
    if (preview) return undefined;
    const onHide = () => { if (["waiting", "connected"].includes(phase)) void leave({ silent: true }); };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [leave, phase, preview]);

  // The enlarged video needs more room than the panel: the loader grows the
  // embedding iframe to a centered modal behind a dimmed backdrop and restores
  // the panel afterwards. The header, status row and docked controls stay in
  // the frame; their height (everything but the scene's box, which absorbs
  // any slack) is measured while enlarged and re-measured whenever the footer
  // changes, e.g. when the handoff timeline appears, so the modal's height
  // keeps following the 4:3 frames (two side by side when split).
  const inCall = phase === "waiting" || phase === "connected";
  // Scene tiles: the visitor's own camera (and screen), then every remote
  // stream the room delivers (agent, a barging supervisor, a shared screen).
  // In the Studio preview a placeholder agent stands in for the remote side.
  const tiles = useMemo(() => {
    const remoteLabelFor = (tile) => tile.role === "supervisor" ? (tile.name || ui.video.supervisor) : tile.role === "agent" ? (handoff?.agentName || tile.name || config.components.messages.humanLabel) : (tile.name || ui.video.agent);
    // The Studio has no camera: the self tile stands in for the configured
    // camera state (a preview placeholder, or "camera off" when configured off).
    const own = room.tiles.filter((tile) => tile.self).map((tile) => ({ ...tile, label: tile.kind === "screen" ? `${ui.video.you} · ${ui.video.screen}` : ui.video.you,
      cameraOff: preview ? video.camera === "off" : tile.cameraOff, cameraOffLabel: preview && video.camera !== "off" ? ui.video.cameraPreview : ui.video.cameraOff }));
    const remote = room.tiles.filter((tile) => !tile.self).map((tile) => ({ ...tile, label: tile.kind === "screen" ? `${remoteLabelFor(tile)} · ${ui.video.screen}` : remoteLabelFor(tile), cameraOffLabel: ui.video.agentCameraOff }));
    if (preview && !remote.length && scenario !== "waiting" && scenario !== "prejoin") {
      const agentName = handoff?.agentName || config.components.messages.humanLabel;
      remote.push({ id: "preview-agent", role: "agent", kind: "camera", self: false, track: null, cameraOff: false, label: agentName, cameraOffLabel: interpolate(ui.video.agentJoining, { agent: agentName }) });
      if (scenario === "screen") remote.push({ id: "preview-agent:screen", role: "agent", kind: "screen", self: false, track: null, cameraOff: false, label: `${agentName} · ${ui.video.screen}`, cameraOffLabel: ui.video.screen });
      if (scenario === "supervisor") remote.push({ id: "preview-supervisor", role: "supervisor", kind: "camera", self: false, track: null, cameraOff: false, label: ui.video.supervisor, cameraOffLabel: ui.video.agentCameraOff });
    }
    return [...own, ...remote];
  }, [config.components.messages.humanLabel, handoff?.agentName, preview, room.tiles, scenario, ui.video, video.camera]);
  const modalAspect = sceneAspect({ scene: room.layout, count: Math.min(4, tiles.length), orientation: "row", aspect: FRAME_ASPECT });
  const modalWidthPercent = MODAL_WIDTH_PERCENT[video.modal?.size] || 75;
  const toggleExpanded = () => setExpanded((current) => !current);
  // Widget Studio → Video → Panel size: the video surface may use its own
  // panel size; the loader restores the configured dimensions afterwards.
  useEffect(() => {
    if (preview || video.sizing?.mode !== "video") return undefined;
    const parentOrigin = new URLSearchParams(window.location.search).get("parentOrigin") || "*";
    window.parent.postMessage({ type: "telnyx-widget-panel-size", width: video.sizing.width, height: video.sizing.height }, parentOrigin);
    return () => window.parent.postMessage({ type: "telnyx-widget-panel-size-reset" }, parentOrigin);
  }, [preview, video.sizing?.mode, video.sizing?.width, video.sizing?.height]);
  useEffect(() => {
    const main = mainRef.current;
    if (!expanded || !main) return undefined;
    const measure = () => {
      const box = main.querySelector("[data-video-stage]");
      if (box) setChromeHeight(Math.max(0, Math.round(main.offsetHeight - box.offsetHeight)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    for (const child of main.children) observer.observe(child);
    return () => observer.disconnect();
  }, [expanded, phase]);
  useEffect(() => {
    if (preview || !expanded) return undefined;
    const parentOrigin = new URLSearchParams(window.location.search).get("parentOrigin") || "*";
    // The loader sizes the stage from the frame width; the scene is narrower
    // by the content padding, so that difference is folded into the chrome.
    const padX = 24 + edgeInsets.left + edgeInsets.right;
    window.parent.postMessage({ type: "telnyx-widget-expand", widthPercent: modalWidthPercent, heightPercent: MODAL_MAX_HEIGHT_PERCENT, aspectRatio: modalAspect, headerHeight: Math.round(chromeHeight - padX / modalAspect), backdrop: true }, parentOrigin);
    return () => window.parent.postMessage({ type: "telnyx-widget-collapse" }, parentOrigin);
  }, [chromeHeight, edgeInsets.left, edgeInsets.right, expanded, modalAspect, modalWidthPercent, preview]);
  useEffect(() => {
    if (!expanded) return undefined;
    if (phase === "ended" || phase === "error") { setExpanded(false); return undefined; }
    const onKey = (event) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, phase]);

  const close = async () => { if (!preview) await leave().catch(() => undefined); onClose?.(); };
  const home = async () => { if (!preview) await leave().catch(() => undefined); onHome?.(); };

  const statusText = phase === "error" ? (error || config.content.videoErrorMessage)
    : phase === "starting" ? config.content.videoConnectingMessage
    : phase === "waiting" ? interpolate(ui.video.queuePosition, { queue: handoff?.queueName || ui.preview.fallbackQueue })
    : phase === "connected" ? config.content.videoActiveMessage
    : phase === "ended" ? config.content.videoEndedMessage
    : config.content.videoSubtitle;
  const controlStyle = (selected = false, danger = false) => ({
    width: controls.buttonSize, height: controls.buttonSize, borderRadius: controls.radius, borderColor: controls.borderColor,
    backgroundColor: danger ? controls.endBackgroundColor : selected ? controls.activeBackgroundColor : controls.backgroundColor,
    color: danger ? controls.endTextColor : selected ? controls.activeTextColor : controls.textColor,
  });
  // Handoff notices (queued, assigned, connected) live on the video frame,
  // never under the controls; Widget Studio → Video can switch them off.
  const noticesEnabled = video.notices?.enabled !== false;
  const handoffNotice = useMemo(() => {
    if (!handoff || !noticesEnabled) return "";
    const phases = handoffTimelinePhases(handoff);
    const key = phases.failed ? "handoffFailedMessage" : phases.connected ? "handoffConnectedMessage" : phases.assigned ? "handoffAssignedMessage" : "handoffWaitingMessage";
    return String(config.content[key] || "").replaceAll("{queue}", handoff.queueName || ui.preview.fallbackQueue).replaceAll("{agent}", handoff.agentName || ui.preview.fallbackAgent);
  }, [config.content, handoff, noticesEnabled, ui.preview.fallbackAgent, ui.preview.fallbackQueue]);
  // A notice stays on the frame for the configured time (default 3 s): the
  // connected pill, and the queue card while waiting. Studio keeps it visible.
  const noticeMs = Math.max(1, Math.min(30, Number(video.notices?.seconds) || 3)) * 1000;
  const [noticeShown, setNoticeShown] = useState("");
  const [waitingCardShown, setWaitingCardShown] = useState(true);
  useEffect(() => {
    if (!handoffNotice || phase !== "connected") { setNoticeShown(""); return undefined; }
    setNoticeShown(handoffNotice);
    if (preview) return undefined;
    const timer = setTimeout(() => setNoticeShown(""), noticeMs);
    return () => clearTimeout(timer);
  }, [handoffNotice, noticeMs, phase, preview]);
  useEffect(() => {
    if (phase !== "waiting") return undefined;
    setWaitingCardShown(true);
    if (preview) return undefined;
    const timer = setTimeout(() => setWaitingCardShown(false), noticeMs);
    return () => clearTimeout(timer);
  }, [handoffNotice, noticeMs, phase, preview]);
  // Above the floating controls (their height plus the scene padding).
  const waitingCardOffset = video.controls?.position === "overlay" ? Math.round(controls.callButtonSize + 16 * overlayScale) + 12 : 0;
  // The Studio edits the draft config, where library items still carry the
  // media id; the public projection has already resolved them to URLs.
  const playlistItems = useMemo(() => (video.waiting?.items || []).map((item) => item.source === "library" && item.mediaId ? { ...item, url: `/api/video/media/${encodeURIComponent(item.mediaId)}` } : item), [video.waiting?.items]);
  const waitingOverlay = phase === "waiting" ? (
    <div className="flex h-full w-full flex-col justify-end">
      <WaitingPlaylist items={playlistItems} mode={video.waiting?.mode || "rotate"} muted={preview || video.waiting?.sound === false} labels={{ unmute: ui.aria.resumeSpeaker, mute: ui.aria.muteSpeaker }} className="absolute inset-0 h-full w-full object-cover" onEmpty={null} />
      {waitingCardShown && (
        <div className="relative m-3 rounded-lg px-3 py-2 text-sm" style={{ backgroundColor: "rgba(0,0,0,0.55)", color: "#fff", marginBottom: 12 + waitingCardOffset }} aria-live="polite">
          <p className="font-medium">{config.content.videoWaitingMessage}</p>
          <p className="text-xs opacity-80">{noticesEnabled && handoffNotice ? handoffNotice : statusText}</p>
        </div>
      )}
    </div>
  ) : null;

  const controlsPosition = video.controls?.position || "bottom";
  const controlButtons = (
    <div className="flex items-center justify-center" style={{ gap: controls.gap }}>
      <button type="button" onClick={() => void room.toggleMic()} disabled={preview} className="grid place-items-center border transition-transform hover:scale-105 disabled:opacity-40" style={controlStyle(!room.micOn)} aria-label={room.micOn ? config.content.muteLabel : config.content.unmuteLabel}>
        {room.micOn ? <Mic style={{ width: controls.iconSize, height: controls.iconSize }} /> : <MicOff style={{ width: controls.iconSize, height: controls.iconSize }} />}
      </button>
      {phase === "prejoin" || phase === "error" ? (
        <button type="button" onClick={() => void start()} disabled={preview} className="flex items-center gap-2 px-5 font-semibold transition-transform hover:scale-105 disabled:opacity-45" style={{ height: controls.callButtonSize, borderRadius: controls.radius, backgroundColor: controls.callBackgroundColor, color: controls.callTextColor }} aria-label={config.content.joinVideoLabel}>
          <Video style={{ width: controls.iconSize + 2, height: controls.iconSize + 2 }} /><span>{config.content.joinVideoLabel}</span>
        </button>
      ) : (
        <button type="button" onClick={() => void leave()} disabled={preview || phase === "starting"} className="grid place-items-center transition-transform hover:scale-105 disabled:opacity-45" style={{ width: controls.callButtonSize, height: controls.callButtonSize, borderRadius: controls.radius, backgroundColor: controls.endBackgroundColor, color: controls.endTextColor }} aria-label={ui.video.leave}>
          <PhoneOff style={{ width: controls.iconSize + 3, height: controls.iconSize + 3 }} />
        </button>
      )}
      <button type="button" onClick={() => void room.toggleCamera()} disabled={preview} className="grid place-items-center border transition-transform hover:scale-105 disabled:opacity-40" style={controlStyle(!room.cameraOn)} aria-label={room.cameraOn ? config.content.cameraOffLabel : config.content.cameraOnLabel}>
        {room.cameraOn ? <Video style={{ width: controls.iconSize, height: controls.iconSize }} /> : <VideoOff style={{ width: controls.iconSize, height: controls.iconSize }} />}
      </button>
      {video.allowScreenShare && phase === "connected" && (
        <button type="button" onClick={() => void room.toggleScreenShare()} disabled={preview} className="grid place-items-center border transition-transform hover:scale-105 disabled:opacity-40" style={controlStyle(room.screenSharing)} aria-label={room.screenSharing ? ui.video.stopSharing : ui.video.shareScreen} title={room.screenSharing ? ui.video.stopSharing : ui.video.shareScreen}>
          {room.screenSharing ? <MonitorX style={{ width: controls.iconSize, height: controls.iconSize }} /> : <MonitorUp style={{ width: controls.iconSize, height: controls.iconSize }} />}
        </button>
      )}
    </div>
  );

  return (
    <main ref={mainRef} lang={config.locale} dir={direction} className={`relative flex flex-col overflow-hidden border ${preview ? "h-full min-h-0" : "h-dvh min-h-[420px]"}`} style={expanded && !preview ? { ...frameStyle, borderRadius: config.theme.shape.panelRadius } : frameStyle}>
      <header className={`flex shrink-0 items-center gap-3 border-b ${config.components.header.alignment === "center" ? "text-center" : "text-start"}`} style={{ minHeight: config.dimensions.headerHeight + edgeInsets.top, paddingTop: edgeInsets.top, paddingLeft: config.dimensions.headerPaddingX + edgeInsets.left, paddingRight: config.dimensions.headerPaddingX + edgeInsets.right, backgroundColor: colors.headerBackground, color: colors.headerText, borderColor: colors.border }}>
        {config.components.header.showIcon && <span className="grid shrink-0 place-items-center rounded-full" style={{ backgroundColor: colors.primary, color: colors.onPrimary, width: config.components.header.iconSize, height: config.components.header.iconSize }}><Video style={{ width: Math.round(config.components.header.iconSize * 0.5), height: Math.round(config.components.header.iconSize * 0.5) }} /></span>}
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold" style={{ fontSize: config.theme.typography.titleSize }}>{config.content.title}</h1>
          {config.components.header.showDescription && <p className="truncate opacity-65" style={{ fontSize: config.theme.typography.descriptionSize }}>{config.content.videoSubtitle}</p>}
        </div>
        <button type="button" onClick={() => void home()} className="rounded-full p-2 hover:bg-black/5" aria-label={ui.aria.home}><WidgetIcon name="home" fallback="home" size={19} /></button>
        {config.components.header.showClose && <button type="button" onClick={() => void close()} className="rounded-full p-2 hover:bg-black/5" aria-label={ui.aria.close}><WidgetIcon name={config.components.header.closeIcon} fallback="x" size={19} /></button>}
      </header>

      {phase !== "ended" && controlsPosition === "top" && (
        <footer className="grid shrink-0 gap-2 border-b p-3" style={{ borderColor: colors.border, paddingLeft: 12 + edgeInsets.left, paddingRight: 12 + edgeInsets.right }}>
            {(phase === "prejoin" || phase === "starting" || phase === "error") && (
              <p className="text-center text-xs opacity-70">{recordingEnabled ? ui.video.recordingNotice : ""}</p>
            )}
            {controlsPosition !== "overlay" && controlButtons}
            {room.error && phase !== "error" && <p className="text-center text-xs" style={{ color: "#b91c1c" }}>{room.error}</p>}
        </footer>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3" style={{ paddingLeft: 12 + edgeInsets.left, paddingRight: 12 + edgeInsets.right }}>
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2 border px-3 py-1.5 text-xs font-medium" role="status" aria-live="polite"
            style={{ borderRadius: config.components.voice.statusBadge.radius, backgroundColor: phase === "error" ? "#fef2f2" : config.components.voice.statusBadge.backgroundColor, color: phase === "error" ? "#b91c1c" : config.components.voice.statusBadge.textColor, borderColor: phase === "error" ? "#fecaca" : config.components.voice.statusBadge.borderColor }}>
            {inCall && <span className="relative grid size-3 shrink-0 place-items-center" aria-hidden="true"><span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 motion-safe:animate-ping" /><span className="relative inline-flex size-1.5 rounded-full bg-current" /></span>}
            <span className="min-w-0 truncate">{statusText}</span>
          </span>
          {(inCall || preview) && (
            <VideoLayoutSwitch layout={room.layout} onChange={(next) => setLayout(next)} scenes={video.scenes?.available} labels={ui.video} size={30} iconSize={15}
              buttonStyle={{ borderRadius: controls.radius, borderColor: controls.borderColor, backgroundColor: controls.backgroundColor, color: controls.textColor }}
              activeStyle={{ backgroundColor: controls.activeBackgroundColor, color: controls.activeTextColor }} />
          )}
        </div>

        {phase === "ended" ? (
          <div className="grid flex-1 place-items-center rounded-xl border p-6 text-center" style={{ borderColor: colors.border, backgroundColor: colors.surfaceMuted }}>
            <div className="grid gap-3">
              <p className="text-sm">{config.content.videoEndedMessage}</p>
              {handoff && (handoff.queueName || handoff.agentName) && <HandoffTimeline config={config} handoff={handoff} ui={ui} phase="closing" />}
              <button type="button" onClick={() => void home()} className="mx-auto px-4 py-2 text-sm font-semibold" style={{ backgroundColor: colors.primary, color: colors.onPrimary, borderRadius: config.theme.shape.buttonRadius }}>{ui.actions.startNewConversation}</button>
            </div>
          </div>
        ) : (
          <VideoStage
            scene={room.layout}
            tiles={tiles}
            viewerRole="customer"
            orientation={expanded ? "row" : "column"}
            frameAspect={FRAME_ASPECT}
            hiddenLabel={(hidden) => interpolate(ui.video.hiddenParticipants, { count: hidden.length })}
            corner={video.modal?.enabled !== false ? (
              <button type="button" onClick={toggleExpanded} aria-label={expanded ? ui.video.collapse : ui.video.expand} title={expanded ? ui.video.collapse : ui.video.expand}
                className="grid size-8 place-items-center rounded-lg border border-white/25 bg-black/35 text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
                {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </button>
            ) : null}
            thumbShare={(video.scenes?.pipThumbnail || 30) / 100}
            notice={noticeShown ? <span className="rounded-full px-3 py-1 text-xs font-medium text-white" style={{ backgroundColor: "rgba(0,0,0,0.55)" }}>{noticeShown}</span> : null}
            bottom={controlsPosition === "overlay" && phase !== "ended" ? <div className="rounded-full backdrop-blur-sm" style={{ backgroundColor: `rgba(0,0,0,${((video.controls?.overlay?.opacity ?? 35) / 100).toFixed(2)})`, padding: `${Math.round(8 * overlayScale)}px ${Math.round(12 * overlayScale)}px` }}>{controlButtons}</div> : null}
            mixedAudioTrack={room.mixedAudioTrack}
            radius={config.theme.shape.bubbleRadius}
            overlay={waitingOverlay}
          />
        )}
      </div>

      {phase !== "ended" && controlsPosition !== "top" && (
        <footer className="grid shrink-0 gap-2 border-t p-3" style={{ borderColor: colors.border, paddingLeft: 12 + edgeInsets.left, paddingRight: 12 + edgeInsets.right, paddingBottom: 12 + edgeInsets.bottom }}>
            {(phase === "prejoin" || phase === "starting" || phase === "error") && (
              <p className="text-center text-xs opacity-70">{recordingEnabled ? ui.video.recordingNotice : ""}</p>
            )}
            {controlsPosition !== "overlay" && controlButtons}
            {room.error && phase !== "error" && <p className="text-center text-xs" style={{ color: "#b91c1c" }}>{room.error}</p>}
        </footer>
      )}
    </main>
  );
}
