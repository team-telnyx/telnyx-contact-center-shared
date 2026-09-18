"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Phone,
  PhoneOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { AIAvatarStage } from "@/components/avatar/ai-avatar-stage";
import { useAvatarBridge } from "@/components/avatar/avatar-bridge";
import { Switch } from "@/components/ui/switch";
import {
  ANAM_AVATAR_PROVIDER,
  AVATAR_EXPAND_MODAL,
  getAvatarDisplayAspectRatio,
  normalizeAIMediaSettings,
} from "@/lib/ai/avatar-config.mjs";

const DEFAULT_APPEARANCE = {
  maxHeight: 260,
  radius: 16,
  fit: "cover",
  focusY: 25,
  showExpandButton: true,
  showSubtitles: false,
  subtitleFontSize: 12,
  subtitlePosition: "bottom",
};

const DEFAULT_LABELS = {
  title: "Avatar",
  connect: "Connect",
  disconnect: "Disconnect",
  mute: "Mute microphone",
  unmute: "Unmute microphone",
  hold: "Hold call",
  resume: "Resume call",
  transcript: "Transcription",
  expand: "Expand avatar",
  collapse: "Exit expanded avatar",
  you: "You",
  assistant: "Assistant",
};

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ROUND_BUTTON =
  "inline-flex size-11 items-center justify-center rounded-full border text-white shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-35 md:size-12";

// Avatar surface shared by the assistant test phone and the widget voice
// call. Embedded, it renders the stage with an expand button; expanded, it
// takes the whole screen or a centered modal (75% of the screen width),
// with call controls, status and live subtitles. `expandedLayout` is "frame"
// when the panel lives in the widget iframe (the loader already resized it)
// and "preview" inside the Widget Studio preview, where it covers the panel.
//
// The element tree is the same in both views (only classes change), so the
// stage — and with it the provider session and its <video> — survives the
// switch; a remount would stop the avatar mid-conversation.
export function AvatarMediaPanel({
  settings,
  assistantId,
  expanded,
  onExpandedChange,
  expandedLayout = "frame",
  controls,
  statusSlot = null,
  latestSubtitle = null,
  labels: labelOverrides,
  accentColor = "#00d6a0",
  // Embedded appearance (components.voice.avatar of the widget config).
  appearance = {},
  // Fill the available height of the panel instead of keeping the aspect ratio.
  stretch = false,
  compact = false,
  prewarm = false,
  fallback = null,
  onAvatarFailure,
}) {
  const mediaSettings = normalizeAIMediaSettings(settings);
  const labels = { ...DEFAULT_LABELS, ...(labelOverrides || {}) };
  const look = { ...DEFAULT_APPEARANCE, ...(appearance || {}) };
  const { prepareAvatar, setAvatarPlaybackActive } = useAvatarBridge();
  const [avatarFailure, setAvatarFailure] = useState(null);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const expandButtonRef = useRef(null);
  const closeButtonRef = useRef(null);
  const containerRef = useRef(null);
  const subtitleScrollRef = useRef(null);
  const transcriptionSwitchId = `avatar-transcription-${useId().replace(/:/g, "")}`;
  const provider = mediaSettings.avatarConfig.provider;
  const avatarId = mediaSettings.avatarId;
  const expandMode = mediaSettings.avatarConfig.expandMode;
  const avatarAvailable = mediaSettings.avatarEnabled && Boolean(avatarId) && !avatarFailure;
  const {
    hasActiveConversation = false,
    isCallControlDisabled = false,
    isMicrophoneMuted = false,
    isPlaybackHeld = false,
    toggleConversation,
    toggleMicrophoneMuted,
    togglePlaybackHeld,
  } = controls || {};

  const handleUnavailable = useCallback(
    (reason) => {
      setAvatarFailure(reason);
      onAvatarFailure?.(reason);
    },
    [onAvatarFailure]
  );
  // The expand button is only rendered in the embedded view, so the ref is
  // read when focus is restored, not when the effect was set up.
  const focusExpandButton = useCallback(() => {
    expandButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!hasActiveConversation) setAvatarFailure(null);
  }, [hasActiveConversation]);

  useEffect(() => {
    setAvatarFailure(null);
  }, [provider, avatarId]);

  useEffect(() => {
    if (avatarAvailable) return;
    onExpandedChange?.(false);
  }, [avatarAvailable, onExpandedChange]);

  useEffect(() => {
    if (!expanded) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        onExpandedChange?.(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        containerRef.current?.querySelectorAll(FOCUSABLE) || []
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      requestAnimationFrame(focusExpandButton);
    };
  }, [expanded, focusExpandButton, onExpandedChange]);

  useEffect(() => {
    if (!expanded || !showSubtitles || !latestSubtitle) return undefined;
    const frame = requestAnimationFrame(() => {
      const element = subtitleScrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, latestSubtitle, showSubtitles]);

  useEffect(() => {
    if (!mediaSettings.avatarEnabled) return;
    const sdkPromise =
      provider === ANAM_AVATAR_PROVIDER
        ? import("@anam-ai/js-sdk")
        : import("@heygen/liveavatar-web-sdk");
    void sdkPromise.catch((error) => {
      console.warn(`[${provider} avatar] SDK preload failed:`, error);
    });
  }, [mediaSettings.avatarEnabled, provider]);

  useEffect(() => {
    if (!prewarm || !avatarAvailable) return;
    // Start the provider session while the user is looking at the panel so
    // the call only has to establish the Telnyx conversation. The call path
    // awaits this same promise and cannot lose greeting audio.
    void prepareAvatar().catch((error) => {
      console.warn("[Avatar] Pre-warm failed:", error);
    });
  }, [assistantId, avatarAvailable, avatarId, prepareAvatar, prewarm, provider]);

  useEffect(() => {
    // Keep WebRTC audible while no call is running or after an avatar
    // failure. The playback controller mutes it at conversation start once
    // the avatar is ready and unmutes it only if the stream never claims a
    // response.
    if (avatarAvailable) setAvatarPlaybackActive(false);
    return () => setAvatarPlaybackActive(false);
  }, [avatarAvailable, setAvatarPlaybackActive]);

  if (!avatarAvailable) {
    return (
      <div data-ai-media={avatarFailure ? "waveform-fallback" : "waveform"} data-avatar-failure={avatarFailure || undefined}>
        {fallback}
      </div>
    );
  }

  const isExpanded = Boolean(expanded);
  const modal = expandMode === AVATAR_EXPAND_MODAL;
  // In the widget iframe the loader resizes the frame (and draws the modal
  // backdrop on the host page), so the expanded surface fills the document;
  // in the Studio preview it fills the previewed panel instead.
  const surfaceClassName = isExpanded
    ? `flex flex-col overflow-hidden bg-black text-white ${
        expandedLayout === "preview" ? "absolute inset-0 z-40" : "fixed inset-0 z-[9999] h-dvh w-screen"
      } ${modal ? "rounded-2xl border border-white/15" : ""}`
    : `relative w-full overflow-hidden ${stretch ? "min-h-0 flex-1" : ""}`;
  const surfaceStyle = isExpanded
    ? undefined
    : {
        borderRadius: look.radius,
        aspectRatio: stretch ? undefined : getAvatarDisplayAspectRatio(mediaSettings.avatarConfig.displayFormat),
        maxHeight: look.maxHeight,
      };

  return (
    <div className="contents">
      <div
        ref={containerRef}
        className={surfaceClassName}
        style={surfaceStyle}
        data-ai-media="avatar"
        data-avatar-expanded={isExpanded ? "true" : "false"}
        data-avatar-expand-mode={expandMode}
        role={isExpanded ? "dialog" : undefined}
        aria-modal={isExpanded ? "true" : undefined}
        aria-label={isExpanded ? labels.title : undefined}
        onClick={isExpanded ? (event) => event.stopPropagation() : undefined}
      >
        {isExpanded && (
          <div className="relative h-28 shrink-0 border-b border-white/15 bg-zinc-950/95 px-3 shadow-lg backdrop-blur md:h-24 md:px-6">
            <div className="absolute left-3 top-2 z-10 flex items-center gap-2 md:left-6 md:top-1/2 md:-translate-y-1/2">
              <span className="hidden text-base font-semibold text-white lg:inline">{labels.title}</span>
              {statusSlot}
            </div>

            <div
              className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-2 sm:gap-3 md:bottom-auto md:top-1/2 md:-translate-y-1/2"
              data-avatar-call-controls
            >
              <button
                type="button"
                onClick={() => void toggleConversation?.()}
                disabled={isCallControlDisabled || !toggleConversation}
                aria-label={hasActiveConversation ? labels.disconnect : labels.connect}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-full border px-3 text-sm font-medium text-white shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-45 md:h-12 md:px-5"
                style={
                  hasActiveConversation
                    ? { backgroundColor: "rgba(239,68,68,.9)", borderColor: "rgba(248,113,113,.6)" }
                    : { backgroundColor: accentColor, borderColor: accentColor }
                }
              >
                {hasActiveConversation ? <PhoneOff className="size-5" /> : <Phone className="size-5" />}
                <span className="hidden md:inline">
                  {hasActiveConversation ? labels.disconnect : labels.connect}
                </span>
              </button>

              <button
                type="button"
                onClick={() => toggleMicrophoneMuted?.()}
                disabled={!hasActiveConversation || !toggleMicrophoneMuted}
                aria-label={isMicrophoneMuted ? labels.unmute : labels.mute}
                aria-pressed={isMicrophoneMuted}
                className={`${ROUND_BUTTON} ${
                  isMicrophoneMuted
                    ? "border-red-400/60 bg-red-500/90 hover:bg-red-500"
                    : "border-white/20 bg-white/10 hover:bg-white/20"
                }`}
              >
                {isMicrophoneMuted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
              </button>

              <button
                type="button"
                onClick={() => togglePlaybackHeld?.()}
                disabled={!hasActiveConversation || !togglePlaybackHeld}
                aria-label={isPlaybackHeld ? labels.resume : labels.hold}
                aria-pressed={isPlaybackHeld}
                className={`${ROUND_BUTTON} ${
                  isPlaybackHeld
                    ? "border-amber-300/60 bg-amber-500/90 hover:bg-amber-500"
                    : "border-white/20 bg-white/10 hover:bg-white/20"
                }`}
              >
                {isPlaybackHeld ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
              </button>
            </div>

            <div className="absolute right-3 top-2 flex items-center gap-3 md:right-6 md:top-1/2 md:-translate-y-1/2 md:gap-4">
              <label
                htmlFor={transcriptionSwitchId}
                className="flex cursor-pointer items-center gap-2 text-sm text-white/90"
              >
                <span className="hidden lg:inline">{labels.transcript}</span>
                <Switch
                  id={transcriptionSwitchId}
                  checked={showSubtitles}
                  onCheckedChange={setShowSubtitles}
                  aria-label={labels.transcript}
                  className="scale-90 data-[state=unchecked]:bg-white/25"
                  checkedTrackColor={accentColor}
                />
              </label>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => onExpandedChange?.(false)}
                aria-label={labels.collapse}
                title={labels.collapse}
                className="inline-flex size-9 items-center justify-center rounded-md border border-white/15 bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <Minimize2 className="size-4" />
              </button>
            </div>
          </div>
        )}

        <div className={isExpanded ? "relative min-h-0 flex-1 overflow-hidden" : "contents"}>
          <AIAvatarStage
            assistantId={assistantId}
            avatarId={avatarId}
            avatarConfig={mediaSettings.avatarConfig}
            onUnavailable={handleUnavailable}
            fill
            fit={isExpanded ? "cover" : look.fit}
            focusY={isExpanded ? 25 : look.focusY}
          />

          {!isExpanded && look.showExpandButton && (
            <button
              ref={expandButtonRef}
              type="button"
              onClick={() => onExpandedChange?.(true)}
              aria-label={labels.expand}
              title={labels.expand}
              className={`absolute right-2 top-2 inline-flex items-center justify-center rounded-lg border border-white/20 bg-black/55 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
                compact ? "size-8" : "size-9"
              }`}
            >
              <Maximize2 className="size-4" />
            </button>
          )}

          {!isExpanded && look.showSubtitles && latestSubtitle && (
            <div
              className={`pointer-events-none absolute inset-x-0 flex justify-center px-2 ${
                look.subtitlePosition === "top" ? "top-0 pt-2" : "bottom-0 pb-2"
              } ${look.subtitlePosition === "top" && look.showExpandButton ? "pr-11" : ""}`}
              aria-live="polite"
              data-avatar-subtitles="embedded"
            >
              <div
                className="max-w-full rounded-lg border border-white/20 bg-black/65 px-3 py-1.5 text-center leading-snug text-white shadow-lg backdrop-blur-sm"
                style={{ fontSize: look.subtitleFontSize }}
              >
                <span className="mr-1.5 font-semibold uppercase tracking-wider" style={{ color: accentColor }}>
                  {latestSubtitle.role === "user" ? labels.you : labels.assistant}
                </span>
                <span key={latestSubtitle.id} className="line-clamp-2">{latestSubtitle.content}</span>
              </div>
            </div>
          )}

          {isExpanded && showSubtitles && latestSubtitle && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-4 pb-[max(2rem,env(safe-area-inset-bottom))] md:px-10 md:pb-[max(3rem,env(safe-area-inset-bottom))]"
              aria-live="polite"
              data-avatar-subtitles
            >
              <div className="w-full max-w-4xl overflow-hidden rounded-xl border border-white/20 bg-black/70 px-5 py-3 text-white shadow-2xl backdrop-blur-md md:px-8 md:py-4">
                <div
                  ref={subtitleScrollRef}
                  className="max-h-[5.25rem] overflow-y-auto text-center text-lg leading-7 [scrollbar-width:none] md:max-h-[6.75rem] md:text-2xl md:leading-9 [&::-webkit-scrollbar]:hidden"
                >
                  <span key={latestSubtitle.id}>{latestSubtitle.content}</span>
                </div>
                <div className="mt-2 flex justify-center border-t border-white/10 pt-2 md:mt-3 md:pt-3">
                  <span
                    className="rounded-full border bg-black/55 px-3 py-1 text-xs font-semibold uppercase tracking-wider shadow-sm md:text-sm"
                    style={{ color: accentColor, borderColor: `${accentColor}59` }}
                  >
                    {latestSubtitle.role === "user" ? labels.you : labels.assistant}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Last spoken line of a transcript, used for the expanded-view subtitles.
export function latestTranscriptLine(items, { clean = (value) => value } = {}) {
  for (let index = (items || []).length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || !["user", "assistant"].includes(item.role)) continue;
    const content = item.role === "assistant" ? clean(item.content) : item.content;
    if (String(content || "").trim()) {
      return {
        id: item.id || `${item.role}-${index}`,
        role: item.role,
        content: String(content).trim(),
      };
    }
  }
  return null;
}
