"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAvatarBridge } from "@/components/avatar/avatar-bridge";
import {
  ANAM_AVATAR_PROVIDER,
  getAvatarDisplayAspectRatio,
} from "@/lib/ai/avatar-config.mjs";
import {
  createLeadingSilenceTrimmer,
  discardPendingLeadingSilence,
  normalizeAssistantPcm16Format,
  pcm16FormatsMatch,
  splitPcm16ByDuration,
  trimLeadingSilencePcm16,
} from "@/lib/ai/avatar-audio-pipeline.mjs";

const STREAM_READY_TIMEOUT_MS = 30000;
const MAX_ANAM_CHUNK_MS = 500;

// Anam avatar with audio passthrough driven by the assistant pre-playout
// audio. Ported from the Demo Portal; the Telnyx client and playback
// arbitration come from the avatar bridge instead of the React provider.
export function AnamAvatarStage({
  assistantId,
  avatarId,
  avatarConfig = {},
  onUnavailable,
  fill = false,
  // Embedded appearance: crop ("cover") or letterbox ("contain") and the
  // vertical crop focus in percent.
  fit = "cover",
  focusY = 25,
}) {
  const videoId = `anam-avatar-${useId().replace(/:/g, "")}`;
  const {
    client,
    claimAvatarAudioResponse,
    hasActiveConversation,
    isPlaybackHeld,
    registerAvatarController,
    requestAvatarSession,
  } = useAvatarBridge();
  const videoRef = useRef(null);
  const phaseRef = useRef("idle");
  const preparationPromiseRef = useRef(null);
  const preparationResolveRef = useRef(null);
  const hadActiveConversationRef = useRef(false);
  const stoppedRef = useRef(false);
  const generationRef = useRef(0);
  const responseRef = useRef({ responseId: null, sequence: -1 });
  const playbackResponseIdRef = useRef(null);
  const [phase, setPhase] = useState("idle");
  const [preparationRequest, setPreparationRequest] = useState(0);
  const displayFormat =
    avatarConfig.displayFormat || avatarConfig.display_format;
  const aspectRatio = getAvatarDisplayAspectRatio(displayFormat);

  useEffect(() => {
    phaseRef.current = phase;
    if (videoRef.current) {
      videoRef.current.muted =
        phase !== "ready" || !hasActiveConversation || isPlaybackHeld;
    }
  }, [hasActiveConversation, isPlaybackHeld, phase]);

  const fail = useCallback(
    (reason = "provider_error") => {
      if (!stoppedRef.current) onUnavailable?.(reason);
    },
    [onUnavailable]
  );

  const settlePreparation = useCallback((result) => {
    const resolve = preparationResolveRef.current;
    preparationPromiseRef.current = null;
    preparationResolveRef.current = null;
    resolve?.(result);
  }, []);

  const prepareAvatar = useCallback(() => {
    if (phaseRef.current === "ready") {
      return Promise.resolve({ ready: true });
    }
    if (preparationPromiseRef.current) return preparationPromiseRef.current;

    const promise = new Promise((resolve) => {
      preparationResolveRef.current = resolve;
    });
    preparationPromiseRef.current = promise;
    setPreparationRequest((current) => current + 1);
    return promise;
  }, []);

  const stopAvatar = useCallback(() => {
    stoppedRef.current = true;
    generationRef.current += 1;
    phaseRef.current = "idle";
    playbackResponseIdRef.current = null;
    settlePreparation({ ready: false, reason: "cancelled" });
    setPreparationRequest(0);
    setPhase("idle");
  }, [settlePreparation]);

  useEffect(
    () => registerAvatarController({ prepare: prepareAvatar, stop: stopAvatar }),
    [prepareAvatar, registerAvatarController, stopAvatar]
  );

  useEffect(() => {
    if (hasActiveConversation) {
      hadActiveConversationRef.current = true;
      return;
    }
    if (hadActiveConversationRef.current) {
      hadActiveConversationRef.current = false;
      stopAvatar();
    }
  }, [hasActiveConversation, stopAvatar]);

  useEffect(() => {
    if (!preparationRequest) {
      setPhase("idle");
      return undefined;
    }
    if (!assistantId || !avatarId) {
      settlePreparation({ ready: false, reason: "invalid_configuration" });
      fail("invalid_configuration");
      return undefined;
    }

    stoppedRef.current = false;
    const generation = ++generationRef.current;
    phaseRef.current = "connecting";
    setPhase("connecting");
    let streamReadyTimeout;
    let anamClient = null;
    let audioInputStream = null;
    let audioInputFormat = null;
    let leadingSilenceTrimmer = null;
    let AnamEvent = null;
    let sessionReady = false;
    let videoPlaybackReady = false;
    let streamStartResolved = false;
    let failureReported = false;
    const isStale = () =>
      stoppedRef.current || generationRef.current !== generation;
    const failSession = (reason) => {
      if (failureReported || isStale()) return;
      failureReported = true;
      clearTimeout(streamReadyTimeout);
      settlePreparation({ ready: false, reason });
      fail(reason);
    };
    const resetResponse = () => {
      responseRef.current = { responseId: null, sequence: -1 };
      leadingSilenceTrimmer = null;
    };
    const finishActiveSequence = ({ interrupt = false } = {}) => {
      const hasActiveInput = Boolean(responseRef.current.responseId);
      let sequenceError = null;
      if (hasActiveInput) {
        try {
          discardPendingLeadingSilence(leadingSilenceTrimmer);
          audioInputStream?.endSequence();
        } catch (error) {
          sequenceError = error;
        }
        resetResponse();
      }
      if (interrupt) {
        try {
          anamClient?.interruptPersona();
        } catch (error) {
          sequenceError ||= error;
        }
        playbackResponseIdRef.current = null;
        audioInputStream = null;
        audioInputFormat = null;
      }
      if (sequenceError) throw sequenceError;
    };

    const ensureAudioInput = (format) => {
      const normalized = normalizeAssistantPcm16Format(format);
      if (audioInputStream && pcm16FormatsMatch(audioInputFormat, normalized)) {
        return normalized;
      }
      if (audioInputStream && responseRef.current.responseId) {
        throw new Error(
          `Assistant audio format changed during response ${responseRef.current.responseId}`
        );
      }
      audioInputStream = anamClient?.createAgentAudioInputStream(normalized);
      if (!audioInputStream) throw new Error("Anam audio input is not ready");
      audioInputFormat = normalized;
      return normalized;
    };

    const onAudioDelta = (info) => {
      try {
        if (!(info?.audio instanceof Uint8Array) || !info?.responseId) {
          throw new TypeError("Assistant audio delta is incomplete");
        }
        if (!claimAvatarAudioResponse(info.responseId)) return;
        const format = normalizeAssistantPcm16Format(info.format);
        const sequence = Number(info.sequence);
        if (!Number.isInteger(sequence) || sequence < 0) {
          throw new TypeError("Assistant audio sequence is invalid");
        }

        if (responseRef.current.responseId !== info.responseId) {
          const previousResponseId =
            responseRef.current.responseId || playbackResponseIdRef.current;
          if (previousResponseId && previousResponseId !== info.responseId) {
            console.warn(
              `[Anam Avatar] Response ${info.responseId} superseded ${previousResponseId}`
            );
            finishActiveSequence({ interrupt: true });
          }
          ensureAudioInput(info.format);
          responseRef.current = { responseId: info.responseId, sequence: -1 };
          playbackResponseIdRef.current = info.responseId;
          leadingSilenceTrimmer = createLeadingSilenceTrimmer(format);
        } else {
          ensureAudioInput(info.format);
        }

        if (sequence <= responseRef.current.sequence) return;
        if (
          responseRef.current.sequence >= 0 &&
          sequence !== responseRef.current.sequence + 1
        ) {
          console.warn(
            `[Anam Avatar] Audio sequence gap for ${info.responseId}: expected ${
              responseRef.current.sequence + 1
            }, received ${sequence}`
          );
        }

        let audio = info.audio;
        if (leadingSilenceTrimmer?.pending) {
          const trimmed = trimLeadingSilencePcm16(leadingSilenceTrimmer, audio);
          audio = trimmed.audio;
        }
        for (const chunk of splitPcm16ByDuration(
          audio,
          audioInputFormat,
          MAX_ANAM_CHUNK_MS
        )) {
          audioInputStream.sendAudioChunk(chunk);
        }
        responseRef.current.sequence = sequence;
      } catch (error) {
        console.error("[Anam Avatar] Audio bridge failed:", error);
        failSession(
          error instanceof TypeError ? "unsupported_audio" : "audio_bridge_failed"
        );
      }
    };

    const onAudioDone = (info) => {
      if (
        responseRef.current.responseId &&
        info?.responseId &&
        responseRef.current.responseId !== info.responseId
      ) {
        return;
      }
      finishActiveSequence();
    };

    const onAudioInterrupted = (info) => {
      const trackedResponseIds = [
        responseRef.current.responseId,
        playbackResponseIdRef.current,
      ].filter(Boolean);
      if (
        info?.responseId &&
        trackedResponseIds.length > 0 &&
        !trackedResponseIds.includes(info.responseId)
      ) {
        return;
      }
      try {
        finishActiveSequence({ interrupt: true });
      } catch (error) {
        console.warn("[Anam Avatar] Interrupt failed:", error);
        resetResponse();
        playbackResponseIdRef.current = null;
      }
    };

    const markReadyIfComplete = () => {
      if (
        isStale() ||
        failureReported ||
        !sessionReady ||
        !videoPlaybackReady ||
        !streamStartResolved ||
        !videoRef.current
      ) {
        return;
      }
      clearTimeout(streamReadyTimeout);
      videoRef.current.volume = 1;
      videoRef.current.muted = true;
      phaseRef.current = "ready";
      setPhase("ready");
      settlePreparation({ ready: true });
    };
    const onSessionReady = () => {
      sessionReady = true;
      markReadyIfComplete();
    };
    const onVideoPlaybackStarted = () => {
      videoPlaybackReady = true;
      markReadyIfComplete();
    };

    const onConnectionClosed = (code) => {
      if (!isStale()) {
        console.warn("[Anam Avatar] Session disconnected:", code);
        failSession("session_disconnected");
      }
    };

    const startSession = async () => {
      try {
        const [tokenData, sdk] = await Promise.all([
          requestAvatarSession({
            assistantId,
            avatarId,
            provider: ANAM_AVATAR_PROVIDER,
          }),
          import("@anam-ai/js-sdk"),
        ]);
        if (isStale()) return;
        AnamEvent = sdk.AnamEvent;
        anamClient = sdk.createClient(tokenData.sessionToken, {
          disableInputAudio: true,
        });
        anamClient.addListener(AnamEvent.SESSION_READY, onSessionReady);
        anamClient.addListener(
          AnamEvent.VIDEO_PLAY_STARTED,
          onVideoPlaybackStarted
        );
        anamClient.addListener(AnamEvent.CONNECTION_CLOSED, onConnectionClosed);

        client?.on("assistant.audio.delta", onAudioDelta);
        client?.on("assistant.audio.done", onAudioDone);
        client?.on("assistant.audio.interrupted", onAudioInterrupted);
        streamReadyTimeout = setTimeout(() => {
          if (!isStale()) failSession("stream_timeout");
        }, STREAM_READY_TIMEOUT_MS);

        await anamClient.streamToVideoElement(videoId);
        if (isStale()) {
          await anamClient.stopStreaming().catch(() => {});
          return;
        }
        streamStartResolved = true;
        markReadyIfComplete();
      } catch (error) {
        console.error("[Anam Avatar] Session start failed:", error);
        if (!isStale()) failSession(error?.reason || "provider_error");
      }
    };

    void startSession();

    return () => {
      stoppedRef.current = true;
      if (generationRef.current === generation) generationRef.current += 1;
      clearTimeout(streamReadyTimeout);
      client?.off("assistant.audio.delta", onAudioDelta);
      client?.off("assistant.audio.done", onAudioDone);
      client?.off("assistant.audio.interrupted", onAudioInterrupted);
      resetResponse();
      playbackResponseIdRef.current = null;
      const clientToStop = anamClient;
      if (clientToStop && AnamEvent) {
        clientToStop.removeListener(AnamEvent.SESSION_READY, onSessionReady);
        clientToStop.removeListener(
          AnamEvent.VIDEO_PLAY_STARTED,
          onVideoPlaybackStarted
        );
        clientToStop.removeListener(
          AnamEvent.CONNECTION_CLOSED,
          onConnectionClosed
        );
      }
      anamClient = null;
      audioInputStream = null;
      audioInputFormat = null;
      if (clientToStop) void clientToStop.stopStreaming().catch(() => {});
    };
  }, [
    assistantId,
    avatarId,
    client,
    claimAvatarAudioResponse,
    fail,
    preparationRequest,
    requestAvatarSession,
    settlePreparation,
    videoId,
  ]);

  const previewUrl =
    (displayFormat === "landscape"
      ? avatarConfig.landscapePreviewUrl
      : avatarConfig.portraitPreviewUrl) ||
    avatarConfig.previewUrl ||
    avatarConfig.preview_url;
  const avatarName = avatarConfig.name || "Anam avatar";

  const mediaStyle = {
    objectFit: fit === "contain" ? "contain" : "cover",
    objectPosition: `50% ${Math.min(100, Math.max(0, Number(focusY) || 0))}%`,
  };

  return (
    <div
      className={`relative w-full overflow-hidden bg-zinc-950 ${
        fill ? "h-full rounded-none" : "rounded-xl"
      }`}
      style={fill ? undefined : { aspectRatio }}
      data-ai-avatar-stage
      data-ai-avatar-phase={phase}
    >
      <video
        id={videoId}
        ref={videoRef}
        style={mediaStyle}
        className={`size-full transition-opacity ${
          phase === "ready" && hasActiveConversation ? "opacity-100" : "opacity-0"
        }`}
        autoPlay
        playsInline
        muted={phase !== "ready" || !hasActiveConversation || isPlaybackHeld}
        aria-label={`${avatarName} live video`}
      />
      {(phase !== "ready" || !hasActiveConversation) && previewUrl && (
        // The URL is normalized by the server before it is persisted.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewUrl}
          alt={avatarName}
          style={mediaStyle}
          className="absolute inset-0 size-full"
        />
      )}
    </div>
  );
}
