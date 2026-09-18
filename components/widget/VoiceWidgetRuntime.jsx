"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TelnyxAIAgent } from "@telnyx/ai-agent-lib";
import { widgetDirection, widgetTranslations } from "@/lib/widgets/locales";
import { requestFreshWidgetBootstrap } from "@/lib/widgets/bootstrap-client";
import { widgetDynamicVariableHeaders } from "@/lib/widgets/dynamic-variables";
import { mergeTranscript } from "@/lib/widgets/voice-transcript";
import { telnyxCallControlId } from "@/lib/widgets/voice-call";
import { useAvatarPlayback } from "@/hooks/use-avatar-playback";
import { AvatarBridgeProvider, readAvatarSessionResponse } from "@/components/avatar/avatar-bridge";
import { AvatarMediaPanel, latestTranscriptLine } from "@/components/avatar/avatar-media-panel";
import { getAvatarExpandGeometry, normalizeAIMediaSettings } from "@/lib/ai/avatar-config.mjs";
import { stripTtsExpressionTags } from "@/lib/ai/tts-expression-text.mjs";
import { TtsExpressionMarkdown } from "@/components/tts-expression-text";
import AudioWaveform from "./AudioWaveform";
import HandoffTimeline from "./HandoffTimeline";
import WidgetIcon from "./WidgetIcon";

function Avatar({ spec, color, textColor, size = 36 }) {
  if (spec?.type === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} src={spec.value} alt="" />;
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full text-xs font-bold"
      style={{ backgroundColor: color, color: textColor, width: size, height: size }}
    >
      {spec?.type === "initials" ? spec.value.slice(0, 3) : <WidgetIcon name={spec?.value} fallback="bot" size={Math.max(14, Math.round(size * 0.48))} />}
    </span>
  );
}

// connect() resolves as soon as the socket opens, while startConversation needs a
// completed login. The library signals that with agent.connected / login.success.
function waitForAgentReady(client, timeoutMs = 20_000) {
  if (client.isAuthenticated && client.sessionId) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      client.off("agent.connected", onReady);
      client.off("agent.login.success", onReady);
      client.off("agent.error", onFailure);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish(null);
    const onFailure = (error) => finish(error instanceof Error ? error : new Error("Voice connection failed"));
    const timer = window.setTimeout(
      () => finish(new Error("Timed out connecting to the voice assistant")),
      timeoutMs
    );
    client.on("agent.connected", onReady);
    client.on("agent.login.success", onReady);
    client.on("agent.error", onFailure);
  });
}

async function reportVoiceState(token, state) {
  if (!token) return;
  await fetch("/api/widget-sessions/voice-state", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(state),
    keepalive: state.status !== "active",
  }).catch(() => undefined);
}

// The session badge answers "is there a call?"; the conversation badge answers
// "what is the agent doing right now?". Keeping them apart stops a long combined
// string from truncating and lets each sit on its own side of the panel.
function statusText(status, content) {
  if (status === "connecting" || status === "starting" || status === "ending") {
    return content.voiceConnectingMessage;
  }
  if (status === "active") return content.voiceActiveMessage;
  if (status === "ended") return content.voiceEndedMessage;
  if (status === "error") return content.voiceErrorMessage;
  return content.voiceReadyMessage;
}

function agentStateBadge(agentState, content, statusBadge) {
  const states = {
    listening: { label: content.voiceListeningMessage, icon: statusBadge.listeningIcon, fallback: "mic" },
    speaking: { label: content.voiceSpeakingMessage, icon: statusBadge.speakingIcon, fallback: "volume-2" },
    thinking: { label: content.voiceThinkingMessage, icon: statusBadge.thinkingIcon, fallback: "bot" },
  };
  return states[agentState] || null;
}

function previewTranscript(locale) {
  const preview = widgetTranslations(locale).preview;
  const timestamp = new Date().toISOString();
  return [
    { id: "preview-voice-user", role: "user", content: preview.voiceRequest, timestamp },
    { id: "preview-voice-agent", role: "assistant", content: preview.voiceReply, timestamp },
  ];
}

export default function VoiceWidgetRuntime({ widget, preview = false, onClose, onHome }) {
  const config = widget.config;
  const edgeInsets = widget.edgeToEdge && widget.edgeInsets
    ? widget.edgeInsets
    : { top: 0, right: 0, bottom: 0, left: 0 };
  const ui = widgetTranslations(config.locale);
  const direction = widgetDirection(config.locale);
  const [connectionStatus, setConnectionStatus] = useState(preview ? "active" : "connecting");
  const [agentState, setAgentState] = useState(null);
  const [conversation, setConversation] = useState(null);
  const [transcript, setTranscript] = useState(preview ? previewTranscript(config.locale) : []);
  const [input, setInput] = useState("");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [sessionToken, setSessionToken] = useState(null);
  const [handoff, setHandoff] = useState(null);
  const [clientEpoch, setClientEpoch] = useState(0);
  const [voiceClient, setVoiceClient] = useState(null);
  const [avatarExpanded, setAvatarExpanded] = useState(false);
  const clientRef = useRef(null);
  const clientConnectPromiseRef = useRef(null);
  const audioRef = useRef(null);
  const sessionTokenRef = useRef(null);
  const callWasActiveRef = useRef(false);
  const endReportedRef = useRef(false);
  const callAttemptRef = useRef(0);
  const clientRecycleScheduledRef = useRef(false);
  const messagesEndRef = useRef(null);
  const messageInputRef = useRef(null);
  const callState = conversation?.call?.state || null;
  const active = connectionStatus === "active" || callState === "active";
  // Real-time avatar configured for the voice assistant (Admin -> AI Assistants ->
  // Widget). It replaces the waveform and, when the call is active, owns the
  // assistant audio: the WebRTC element stays muted while the avatar speaks.
  const avatarSettings = useMemo(
    () => normalizeAIMediaSettings(config.channels.voice.avatar),
    [config.channels.voice.avatar]
  );
  const avatarEnabled = avatarSettings.avatarEnabled;
  const {
    abortConversationStart,
    beginConversation,
    claimAvatarAudioResponse,
    isPlaybackHeld: speakerMuted,
    isPreparingAvatar,
    prepareAvatar,
    registerAvatarController,
    registerConversationAudioElement,
    setAvatarPlaybackActive,
    setPlaybackHeld,
    stopAvatar,
  } = useAvatarPlayback({ hasActiveConversation: active, agentStateName: agentState, transcript });

  const recycleVoiceClient = useCallback(() => {
    if (clientRecycleScheduledRef.current) return;
    clientRecycleScheduledRef.current = true;
    setClientEpoch((current) => current + 1);
  }, []);

  useEffect(() => {
    if (preview) setTranscript(previewTranscript(config.locale));
  }, [config.locale, preview]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (conversation?.call?.remoteStream) audio.srcObject = conversation.call.remoteStream;
  }, [conversation]);

  // The playback controller keeps the element muted while the avatar speaks
  // or the speaker is held.
  useEffect(
    () => registerConversationAudioElement(audioRef.current),
    [registerConversationAudioElement]
  );

  const frameStyle = useMemo(
    () => ({
      backgroundColor: config.theme.colors.surface,
      color: config.theme.colors.text,
      borderColor: config.theme.colors.border,
      borderRadius: widget.edgeToEdge ? 0 : config.theme.shape.panelRadius,
      borderWidth: widget.edgeToEdge ? 0 : undefined,
      fontFamily: `"${config.theme.typography.fontFamily}", ui-sans-serif, system-ui, sans-serif`,
      fontSize: config.theme.typography.baseSize,
    }),
    [config, widget.edgeToEdge]
  );

  useEffect(() => {
    if (preview) return;
    let disposed = false;
    clientRecycleScheduledRef.current = false;
    // "main" is the admin placeholder for "whatever the assistant currently runs".
    // Telnyx WebRTC rejects it as a target_version_id (-32001 Login Incorrect), so
    // it is omitted and the platform resolves the current version itself.
    const assistantVersionId = String(config.channels.voice.assistantVersionId || "").trim();
    const agentOptions = {
      agentId: config.channels.voice.assistantId,
      widgetVersion: "contact-center-widget/1.0.0",
      ...(assistantVersionId && assistantVersionId !== "main" ? { versionId: assistantVersionId } : {}),
      // The avatar stage is fed from the assistant pre-playout audio stream.
      streamingAudio: avatarEnabled,
    };
    if (config.channels.voice.region && config.channels.voice.region !== "auto") {
      agentOptions.region = config.channels.voice.region;
    }
    const client = new TelnyxAIAgent(agentOptions);
    clientRef.current = client;
    setVoiceClient(client);

    const onConnected = () => {
      if (!disposed) setConnectionStatus((current) => current === "connecting" ? "ready" : current);
    };
    const onDisconnected = () => {
      if (!disposed && callWasActiveRef.current) setConnectionStatus("ended");
    };
    const onError = (agentError) => {
      if (disposed) return;
      // The library reports the real cause (for example 46001 LOGIN_FAILED when the
      // assistant does not accept unauthenticated web calls); the panel only has
      // room for the configured copy, so the detail goes to the console.
      console.error("[telnyx-widget-voice] agent error:", agentError);
      setError(config.content.voiceErrorMessage);
      setConnectionStatus(callWasActiveRef.current ? "active" : "error");
    };
    const onTranscript = (item) => {
      if (!disposed) setTranscript((current) => mergeTranscript(current, item));
    };
    const onAgentState = (data) => {
      if (!disposed) setAgentState(data?.state || null);
    };
    const onConversation = (notification) => {
      if (disposed) return;
      setConversation(notification);
      const nextState = notification?.call?.state;
      if (nextState === "active") {
        callWasActiveRef.current = true;
        setConnectionStatus("active");
        const callId = telnyxCallControlId(notification.call);
        void reportVoiceState(sessionTokenRef.current, {
          status: "active",
          ...(callId ? { telnyxCallId: String(callId) } : {}),
        });
      } else if (callWasActiveRef.current && !endReportedRef.current) {
        endReportedRef.current = true;
        setConnectionStatus("ended");
        void reportVoiceState(sessionTokenRef.current, { status: "completed" });
        recycleVoiceClient();
      }
    };

    client.on("agent.connected", onConnected);
    client.on("agent.disconnected", onDisconnected);
    client.on("agent.error", onError);
    client.on("transcript.item", onTranscript);
    client.on("conversation.agent.state", onAgentState);
    client.on("conversation.update", onConversation);
    const connectPromise = client.connect().catch(onError);
    clientConnectPromiseRef.current = connectPromise;

    return () => {
      disposed = true;
      if (callWasActiveRef.current && !endReportedRef.current) {
        endReportedRef.current = true;
        void reportVoiceState(sessionTokenRef.current, { status: "completed" });
      }
      void client.endConversation()?.catch(() => undefined);
      void client.disconnect().catch(() => undefined);
      clientRef.current = null;
      setVoiceClient((current) => (current === client ? null : current));
      if (clientConnectPromiseRef.current === connectPromise) {
        clientConnectPromiseRef.current = null;
      }
    };
  }, [avatarEnabled, clientEpoch, config, preview, recycleVoiceClient]);

  // The expanded avatar needs more room than the panel: the loader grows the
  // embedding iframe to the whole screen or to a centered 75%-wide modal.
  useEffect(() => {
    if (preview) return undefined;
    const parentOrigin = new URLSearchParams(window.location.search).get("parentOrigin") || "*";
    if (!avatarExpanded) return undefined;
    const geometry = getAvatarExpandGeometry(avatarSettings.avatarConfig);
    window.parent.postMessage(
      {
        type: "telnyx-widget-expand",
        widthPercent: geometry.widthPercent,
        heightPercent: geometry.heightPercent,
        aspectRatio: geometry.aspectRatio,
        headerHeight: geometry.headerHeight,
        backdrop: geometry.backdrop,
      },
      parentOrigin
    );
    return () => {
      window.parent.postMessage({ type: "telnyx-widget-collapse" }, parentOrigin);
    };
  }, [avatarExpanded, avatarSettings.avatarConfig, preview]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [transcript, agentState, handoff?.status]);

  useEffect(() => {
    if (preview || !sessionToken) return undefined;
    let cancelled = false;
    let timer;
    async function pollVoiceHandoff() {
      try {
        const response = await fetch("/api/widget-sessions/voice-state", {
          headers: { Authorization: `Bearer ${sessionToken}` },
          cache: "no-store",
        });
        const result = await response.json().catch(() => ({}));
        if (!cancelled && response.ok) setHandoff(result.handoff || null);
      } catch {
        // Contact Center notifications are persisted by the backend; a transient read
        // failure must not interrupt the active audio call.
      } finally {
        if (!cancelled) timer = window.setTimeout(pollVoiceHandoff, 1_500);
      }
    }
    void pollVoiceHandoff();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [preview, sessionToken]);

  const startCall = useCallback(async () => {
    const client = clientRef.current;
    if (!client || connectionStatus === "connecting" || connectionStatus === "starting") return;
    setError("");
    setTranscript([]);
    setConversation(null);
    setHandoff(null);
    setSessionToken(null);
    sessionTokenRef.current = null;
    setMuted(false);
    setConnectionStatus("starting");
    callWasActiveRef.current = false;
    endReportedRef.current = false;
    const attempt = ++callAttemptRef.current;
    let token;
    try {
      const freshWidget = await requestFreshWidgetBootstrap(widget.id);
      if (!client.isAuthenticated) {
        await clientConnectPromiseRef.current;
      }
      await waitForAgentReady(client);
      const response = await fetch(`/api/widgets/${encodeURIComponent(widget.id)}/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${freshWidget.bootstrapToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: "voice",
          clientKey: crypto.randomUUID(),
          context: freshWidget.decisionContext || widget.decisionContext || {},
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Unable to create voice session");
      token = result.sessionToken;
      sessionTokenRef.current = token;
      setSessionToken(token);
      if (attempt !== callAttemptRef.current) {
        await reportVoiceState(token, { status: "failed" });
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone is unavailable");
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      permissionStream.getTracks().forEach((track) => track.stop());
      if (attempt !== callAttemptRef.current) {
        await reportVoiceState(token, { status: "failed" });
        return;
      }

      // The avatar session is authorised by the voice session token, so it can
      // only start now. A provider failure falls back to the waveform through the
      // stage's onUnavailable; the call itself continues over WebRTC audio.
      if (avatarEnabled) {
        await prepareAvatar().catch((avatarError) => {
          console.warn("[telnyx-widget-voice] avatar preparation failed:", avatarError);
        });
        if (attempt !== callAttemptRef.current) {
          await stopAvatar();
          await reportVoiceState(token, { status: "failed" });
          return;
        }
      }
      beginConversation();

      await client.startConversation({
        callerNumber: config.channels.voice.callerNumber,
        callerName: "Web Call",
        customHeaders: [
          { name: "X-Widget-Session-Id", value: result.session.id },
          { name: "X-Widget-Id", value: widget.id },
          // Telnyx exposes each X- header on the invite as a {{dynamic_variable}}.
          ...widgetDynamicVariableHeaders(freshWidget.decisionContext || widget.decisionContext || {}),
        ],
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (attempt !== callAttemptRef.current) {
        await client.endConversation();
      }
    } catch {
      abortConversationStart();
      await stopAvatar();
      if (attempt !== callAttemptRef.current) return;
      setError(config.content.voiceErrorMessage);
      setConnectionStatus("error");
      await reportVoiceState(token, { status: "failed" });
    }
  }, [abortConversationStart, avatarEnabled, beginConversation, config.channels.voice.callerNumber, config.content.voiceErrorMessage, connectionStatus, prepareAvatar, stopAvatar, widget]);

  const endCall = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    callAttemptRef.current += 1;
    setConnectionStatus("ending");
    try {
      await client.endConversation();
    } finally {
      await stopAvatar();
      if (!endReportedRef.current) {
        endReportedRef.current = true;
        await reportVoiceState(sessionTokenRef.current, {
          status: callWasActiveRef.current ? "completed" : "failed",
        });
      }
      setConnectionStatus("ended");
      setMuted(false);
      recycleVoiceClient();
    }
  }, [recycleVoiceClient, stopAvatar]);

  const toggleMute = () => {
    if (preview) {
      setMuted((current) => !current);
      return;
    }
    const call = conversation?.call;
    if (!call || !active) return;
    const nextMuted = !muted;
    if (nextMuted && typeof call.muteAudio === "function") call.muteAudio();
    else if (!nextMuted && typeof call.unmuteAudio === "function") call.unmuteAudio();
    else call.localStream?.getAudioTracks?.().forEach((track) => { track.enabled = !nextMuted; });
    setMuted(nextMuted);
  };

  const toggleSpeaker = () => {
    if (!preview && !active) return;
    setPlaybackHeld((current) => !current);
  };

  const requestAvatarSession = useCallback(async (body) => {
    const token = sessionTokenRef.current;
    if (!token) {
      throw Object.assign(new Error("Voice session is not ready"), { reason: "session_required" });
    }
    return readAvatarSessionResponse(
      await fetch(`/api/widgets/${encodeURIComponent(widget.id)}/avatar-session`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      })
    );
  }, [widget.id]);

  const avatarBridge = useMemo(
    () => ({
      client: voiceClient,
      claimAvatarAudioResponse,
      hasActiveConversation: active,
      isPlaybackHeld: speakerMuted,
      prepareAvatar,
      registerAvatarController,
      requestAvatarSession,
      setAvatarPlaybackActive,
    }),
    [active, claimAvatarAudioResponse, prepareAvatar, registerAvatarController, requestAvatarSession, setAvatarPlaybackActive, speakerMuted, voiceClient]
  );
  const latestSubtitle = useMemo(
    () => latestTranscriptLine(transcript, { clean: stripTtsExpressionTags }),
    [transcript]
  );

  const sendText = (event) => {
    event.preventDefault();
    const value = input.trim();
    if (!value || !active || !clientRef.current) return;
    try {
      clientRef.current.sendConversationMessage(value);
      setInput("");
      window.requestAnimationFrame(() => {
        if (active) messageInputRef.current?.focus({ preventScroll: true });
      });
    } catch {
      setError(config.content.sendFailedMessage);
    }
  };

  const close = async () => {
    if (active || connectionStatus === "starting") await endCall().catch(() => undefined);
    onClose?.();
  };

  const home = async () => {
    if (active || connectionStatus === "starting") await endCall().catch(() => undefined);
    onHome?.();
  };

  const displayStatus = error || statusText(connectionStatus, config.content);
  // A hung-up AI call closes the session with a bare "disconnected" handoff
  // state; the timeline is only for calls that were handed to a queue.
  const handoffTimeline = handoff && (handoff.queueName || handoff.agentName) ? handoff : null;
  const activeAgentState = active && !error
    ? agentStateBadge(agentState, config.content, config.components.voice.statusBadge)
    : null;
  const badgeStyle = (errored) => ({
    backgroundColor: errored ? "#fef2f2" : config.components.voice.statusBadge.backgroundColor,
    color: errored ? "#b91c1c" : config.components.voice.statusBadge.textColor,
    borderColor: errored ? "#fecaca" : config.components.voice.statusBadge.borderColor,
  });
  const voice = config.components.voice;
  const avatarLook = voice.avatar || {};
  const controls = voice.controls;
  const footer = config.components.footer;
  const callInProgress = active || connectionStatus === "starting";
  const failed = connectionStatus === "error" || Boolean(error);
  const callControlDisabled = preview || connectionStatus === "connecting" || connectionStatus === "ending" || isPreparingAvatar;
  const avatarControls = {
    hasActiveConversation: active,
    isCallControlDisabled: callControlDisabled,
    isMicrophoneMuted: muted,
    isPlaybackHeld: speakerMuted,
    toggleConversation: preview ? undefined : callInProgress ? endCall : startCall,
    toggleMicrophoneMuted: toggleMute,
    togglePlaybackHeld: toggleSpeaker,
  };
  const avatarLabels = {
    title: ui.aria.avatarTitle,
    connect: ui.aria.connectCall,
    disconnect: ui.aria.disconnectCall,
    mute: config.content.muteLabel,
    unmute: config.content.unmuteLabel,
    hold: ui.aria.holdCall,
    resume: ui.aria.resumeCall,
    transcript: ui.aria.avatarTranscript,
    expand: ui.aria.avatarExpand,
    collapse: ui.aria.avatarCollapse,
    you: config.components.messages.customerLabel,
    assistant: config.components.messages.assistantLabel,
  };
  const avatarStatusChip = voice.statusBadge.enabled ? (
    <span
      className="flex min-w-0 max-w-[min(26vw,320px)] items-center gap-2 border px-3 py-1.5 font-medium"
      style={{ ...badgeStyle(failed), borderRadius: voice.statusBadge.radius, fontSize: voice.statusBadge.fontSize }}
      role="status"
      aria-live="polite"
    >
      <span className="min-w-0 truncate">{activeAgentState?.label || displayStatus}</span>
    </span>
  ) : null;
  const controlStyle = (selected = false) => ({
    width: controls.buttonSize,
    height: controls.buttonSize,
    borderRadius: controls.radius,
    borderColor: controls.borderColor,
    backgroundColor: selected ? controls.activeBackgroundColor : controls.backgroundColor,
    color: selected ? controls.activeTextColor : controls.textColor,
  });

  // Voice transcript area; without it (and without a handoff) the avatar may
  // stretch down to the message input.
  const transcriptVisible = config.features.voiceTranscript || Boolean(handoffTimeline);
  const avatarStretch = avatarEnabled && !transcriptVisible;
  const avatarPosition = avatarLook.position === "top" ? "top" : "middle";
  const mediaBlock = (
avatarEnabled ? (
        <AvatarBridgeProvider value={avatarBridge}>
          <div
            className={`border-b ${avatarStretch ? "flex min-h-0 flex-1 flex-col" : "shrink-0"}`}
            style={{
              borderColor: config.theme.colors.border,
              backgroundColor: avatarLook.backgroundColor || voice.waveform.backgroundColor,
              padding: avatarLook.padding ?? voice.waveform.padding,
            }}
          >
            <AvatarMediaPanel
              settings={avatarSettings}
              assistantId={config.channels.voice.assistantId}
              expanded={avatarExpanded}
              onExpandedChange={setAvatarExpanded}
              expandedLayout={preview ? "preview" : "frame"}
              controls={avatarControls}
              statusSlot={avatarStatusChip}
              latestSubtitle={latestSubtitle}
              labels={avatarLabels}
              accentColor={controls.callBackgroundColor}
              appearance={avatarLook}
              stretch={avatarStretch}
              compact
              fallback={
                voice.waveform.enabled ? (
                  <div className="overflow-hidden" style={{ borderRadius: voice.waveform.radius }}>
                    <AudioWaveform
                      stream={conversation?.call?.remoteStream || null}
                      {...voice.waveform}
                      active={active}
                      preview={preview}
                    />
                  </div>
                ) : null
              }
            />
          </div>
        </AvatarBridgeProvider>
      ) : voice.waveform.enabled && (
        <div
          className="shrink-0 border-b"
          style={{
            borderColor: config.theme.colors.border,
            backgroundColor: voice.waveform.backgroundColor,
            padding: voice.waveform.padding,
          }}
        >
          <div className="overflow-hidden" style={{ borderRadius: voice.waveform.radius }}>
            <AudioWaveform
              stream={conversation?.call?.remoteStream || null}
              {...voice.waveform}
              active={active}
              preview={preview}
            />
          </div>
        </div>
      )
  );

  return (
    <main lang={config.locale} dir={direction} className={`relative flex flex-col overflow-hidden border ${preview ? "h-full min-h-0" : "h-dvh min-h-[420px]"}`} style={frameStyle}>
      <header className={`flex shrink-0 items-center gap-3 border-b ${config.components.header.alignment === "center" ? "text-center" : "text-start"}`} style={{ minHeight: config.dimensions.headerHeight + edgeInsets.top, paddingTop: edgeInsets.top, paddingLeft: config.dimensions.headerPaddingX + edgeInsets.left, paddingRight: config.dimensions.headerPaddingX + edgeInsets.right, backgroundColor: config.theme.colors.headerBackground, color: config.theme.colors.headerText, borderColor: config.theme.colors.border }}>
        {config.components.header.showIcon && <Avatar spec={{ type: "icon", value: config.components.header.icon }} color={config.theme.colors.primary} textColor={config.theme.colors.onPrimary} size={config.components.header.iconSize} />}
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold" style={{ fontSize: config.theme.typography.titleSize }}>{config.content.title}</h1>
          {config.components.header.showDescription && <p className="truncate opacity-65" style={{ fontSize: config.theme.typography.descriptionSize }}>{config.content.voiceSubtitle}</p>}
        </div>
        <button type="button" onClick={() => void home()} className="rounded-full p-2 hover:bg-black/5" aria-label={ui.aria.home}>
          <WidgetIcon name="home" fallback="home" size={19} />
        </button>
        {config.components.header.showClose && (
          <button type="button" onClick={() => void close()} className="rounded-full p-2 hover:bg-black/5" aria-label={ui.aria.close}>
            <WidgetIcon name={config.components.header.closeIcon} fallback="x" size={19} />
          </button>
        )}
      </header>

      {avatarPosition === "top" && mediaBlock}

      <div className="shrink-0 border-b px-4" style={{ borderColor: config.theme.colors.border, backgroundColor: config.theme.colors.surface, paddingBlock: controls.verticalPadding }}>
        {voice.statusBadge.enabled && (
          <div className="mb-3 flex items-center justify-between gap-2 px-1">
            <span
              className="flex min-w-0 items-center gap-2 border px-3 py-1.5 font-medium"
              style={{ ...badgeStyle(failed), borderRadius: voice.statusBadge.radius, fontSize: voice.statusBadge.fontSize }}
              role="status"
              aria-live="polite"
            >
              {callInProgress ? (
                <span className="relative grid shrink-0 place-items-center" style={{ width: voice.statusBadge.iconSize, height: voice.statusBadge.iconSize }} aria-hidden="true">
                  <span className="absolute inline-flex rounded-full opacity-60 motion-safe:animate-ping" style={{ width: "100%", height: "100%", backgroundColor: "currentColor" }} />
                  <span className="relative inline-flex rounded-full" style={{ width: "55%", height: "55%", backgroundColor: "currentColor" }} />
                </span>
              ) : (
                <WidgetIcon name={voice.statusBadge.icon} size={voice.statusBadge.iconSize} className="shrink-0" />
              )}
              <span className="min-w-0 truncate">{displayStatus}</span>
            </span>
            {/* Reserved even while idle so the controls below never shift as the
                agent moves between listening, thinking and speaking. */}
            <span
              className={`flex min-w-0 items-center gap-2 border px-3 py-1.5 font-medium transition-opacity ${activeAgentState ? "opacity-100" : "opacity-0"}`}
              style={{ ...badgeStyle(false), borderRadius: voice.statusBadge.radius, fontSize: voice.statusBadge.fontSize }}
              role="status"
              aria-live="polite"
              aria-hidden={activeAgentState ? undefined : "true"}
            >
              <WidgetIcon
                name={activeAgentState?.icon || voice.statusBadge.listeningIcon}
                fallback={activeAgentState?.fallback || "mic"}
                size={voice.statusBadge.iconSize}
                className="shrink-0"
              />
              <span className="min-w-0 truncate">{activeAgentState?.label || config.content.voiceListeningMessage}</span>
            </span>
          </div>
        )}
        <div className="flex items-center justify-center" style={{ gap: controls.gap }}>
          <button
            type="button"
            onClick={toggleMute}
            disabled={!preview && !active}
            className="grid place-items-center border transition-transform hover:scale-105 disabled:opacity-35"
            style={controlStyle(muted)}
            aria-label={muted ? config.content.unmuteLabel : config.content.muteLabel}
          >
            <WidgetIcon name={muted ? controls.unmuteIcon : controls.muteIcon} fallback={muted ? "mic-off" : "mic"} size={controls.iconSize} />
          </button>
          <button
            type="button"
            onClick={preview ? undefined : callInProgress ? () => void endCall() : () => void startCall()}
            disabled={!preview && (connectionStatus === "connecting" || connectionStatus === "ending")}
            className="grid place-items-center transition-transform hover:scale-105 disabled:opacity-45"
            style={{
              width: controls.callButtonSize,
              height: controls.callButtonSize,
              borderRadius: controls.radius,
              backgroundColor: callInProgress ? controls.endBackgroundColor : controls.callBackgroundColor,
              color: callInProgress ? controls.endTextColor : controls.callTextColor,
            }}
            aria-label={callInProgress ? config.content.endCallLabel : config.content.startCallLabel}
          >
            <WidgetIcon name={callInProgress ? controls.endCallIcon : controls.callIcon} fallback={callInProgress ? "phone-off" : "phone"} size={controls.iconSize + 3} />
          </button>
          <button
            type="button"
            onClick={toggleSpeaker}
            disabled={!preview && !active}
            className="grid place-items-center border transition-transform hover:scale-105 disabled:opacity-35"
            style={controlStyle(speakerMuted)}
            aria-label={speakerMuted ? ui.aria.resumeSpeaker : ui.aria.muteSpeaker}
          >
            <WidgetIcon name={speakerMuted ? controls.speakerMutedIcon : controls.speakerIcon} fallback={speakerMuted ? "volume-x" : "volume-2"} size={controls.iconSize} />
          </button>
        </div>
        <audio ref={audioRef} autoPlay playsInline className="hidden" />
      </div>

      {avatarPosition !== "top" && mediaBlock}

      {transcriptVisible && (
      <section className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4" style={{ paddingLeft: 16 + edgeInsets.left, paddingRight: 16 + edgeInsets.right }}>
        {config.features.voiceTranscript && transcript.length > 0 && (
          <div className="grid" style={{ gap: config.components.messages.spacing }} aria-live="polite">
            {transcript.map((message) => {
              const customer = message.role === "user";
              return (
                <div key={message.id} className={`flex items-end gap-2 ${customer ? "justify-end" : "justify-start"}`}>
                  {config.components.messages.showAvatars && !customer && <Avatar spec={config.avatars.bot} color={config.theme.colors.primary} textColor={config.theme.colors.onPrimary} size={config.components.messages.avatarSize} />}
                  <div className={customer ? "text-end" : "text-start"} style={{ maxWidth: `${config.dimensions.messageMaxWidth}%` }}>
                    {config.components.messages.showParticipantNames && <p className="mb-1 px-1" style={{ color: config.theme.colors.mutedText, fontSize: config.theme.typography.participantSize }}>{customer ? config.components.messages.customerLabel : config.components.messages.assistantLabel}</p>}
                    <div
                      className="whitespace-pre-wrap px-4 py-3 text-start"
                      style={{ borderRadius: config.theme.shape.bubbleRadius, backgroundColor: customer ? config.theme.colors.customerBubble : config.theme.colors.assistantBubble, color: customer ? config.theme.colors.customerText : config.theme.colors.assistantText, fontSize: config.theme.typography.messageSize }}
                    >
                      {customer ? message.content : (
                        <TtsExpressionMarkdown>{message.content}</TtsExpressionMarkdown>
                      )}
                    </div>
                    {config.components.messages.showTimestamps && message.timestamp && (
                      <time className="mt-1 block px-1 opacity-55" style={{ color: config.theme.colors.mutedText, fontSize: config.theme.typography.metaSize }}>
                        {new Intl.DateTimeFormat(config.locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(message.timestamp))}{customer && config.components.messages.showDeliveryStatus ? ` · ${ui.preview.delivered}` : ""}
                      </time>
                    )}
                  </div>
                  {config.components.messages.showAvatars && customer && <Avatar spec={config.avatars.customer} color={config.theme.colors.customerBubble} textColor={config.theme.colors.customerText} size={config.components.messages.avatarSize} />}
                </div>
              );
            })}
          </div>
        )}
        {handoffTimeline && (
          <HandoffTimeline config={config} handoff={handoffTimeline} ui={ui} />
        )}
        {handoffTimeline && (
          <HandoffTimeline config={config} handoff={handoffTimeline} ui={ui} phase="closing" />
        )}
        <div ref={messagesEndRef} />
      </section>
      )}

      {config.features.voiceTextInput && (
        <footer className="shrink-0 border-t" style={{ minHeight: config.dimensions.footerHeight + edgeInsets.bottom, paddingTop: 10, paddingBottom: 10 + edgeInsets.bottom, paddingLeft: config.dimensions.footerPaddingX + edgeInsets.left, paddingRight: config.dimensions.footerPaddingX + edgeInsets.right, borderColor: config.theme.colors.border, backgroundColor: config.theme.colors.footerBackground, color: config.theme.colors.footerText }}>
          <form className="flex items-center gap-2" onSubmit={sendText}>
            <input
              ref={messageInputRef}
              disabled={!active}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              maxLength={8000}
              className="min-w-0 flex-1 border px-4 disabled:opacity-60"
              style={{ height: footer.buttonSize, backgroundColor: config.theme.colors.inputBackground, color: config.theme.colors.inputText, borderColor: config.theme.colors.border, borderRadius: config.theme.shape.inputRadius, fontSize: config.theme.typography.messageSize }}
              placeholder={config.content.inputPlaceholder}
              aria-label={config.content.inputPlaceholder}
            />
            <button
              disabled={!active || !input.trim()}
              type="submit"
              className="grid place-items-center disabled:opacity-50"
              style={{ width: footer.buttonSize, height: footer.buttonSize, backgroundColor: footer.buttonBackgroundColor, color: footer.buttonTextColor, borderRadius: config.theme.shape.buttonRadius }}
              aria-label={ui.aria.send}
            >
              <WidgetIcon name={footer.sendIcon} fallback="send" size={footer.iconSize} />
            </button>
          </form>
        </footer>
      )}
    </main>
  );
}
