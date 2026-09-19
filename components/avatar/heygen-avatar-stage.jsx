"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAvatarBridge } from "@/components/avatar/avatar-bridge";
import {
  getAvatarDisplayAspectRatio,
  HEYGEN_AVATAR_PROVIDER,
  pcmBytesToBase64,
} from "@/lib/ai/avatar-config.mjs";
import {
  concatUint8Arrays,
  normalizeAssistantPcm16Format,
  pcm16FormatsMatch,
  StreamingPcm16MonoResampler,
} from "@/lib/ai/avatar-audio-pipeline.mjs";

// 200 ms at 24 kHz mono PCM16. This is enough pre-roll for smooth playback
// without adding a noticeable delay to the first visible utterance.
const FIRST_AUDIO_CHUNK_BYTES = 9600;
const NEXT_AUDIO_CHUNK_BYTES = 48000;
const STREAM_READY_TIMEOUT_MS = 10000;
const KEEP_ALIVE_INTERVAL_MS = 60000;

// HeyGen LiveAvatar (LITE mode) driven by the assistant pre-playout audio.
// Ported from the Demo Portal; the Telnyx client and playback arbitration
// come from the avatar bridge instead of the React provider.
export function HeyGenAvatarStage({
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
  const responseRef = useRef({
    responseId: null,
    eventId: null,
    sequence: -1,
    buffer: new Uint8Array(),
    firstChunkSent: false,
    done: false,
    sourceFormat: null,
    resampler: null,
  });
  const playbackRef = useRef({ responseId: null, eventId: null });
  const [phase, setPhase] = useState("idle");
  const [preparationRequest, setPreparationRequest] = useState(0);
  const aspectRatio = getAvatarDisplayAspectRatio(
    avatarConfig.displayFormat || avatarConfig.display_format
  );

  useEffect(() => {
    phaseRef.current = phase;
    if (videoRef.current) {
      videoRef.current.muted =
        phase !== "ready" || !hasActiveConversation || isPlaybackHeld;
    }
  }, [hasActiveConversation, isPlaybackHeld, phase]);

  const fail = useCallback(
    (reason = "provider_error") => {
      if (stoppedRef.current) return;
      onUnavailable?.(reason);
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
    if (preparationPromiseRef.current) {
      return preparationPromiseRef.current;
    }

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
    playbackRef.current = { responseId: null, eventId: null };
    settlePreparation({ ready: false, reason: "cancelled" });
    setPreparationRequest(0);
    setPhase("idle");
  }, [settlePreparation]);

  useEffect(
    () =>
      registerAvatarController({
        prepare: prepareAvatar,
        stop: stopAvatar,
      }),
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
    let keepAliveInterval;
    let liveAvatarSession = null;
    let AgentEventsEnum = null;
    let sessionStartResolved = false;
    let streamPlaybackReady = false;
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
      responseRef.current = {
        responseId: null,
        eventId: null,
        sequence: -1,
        buffer: new Uint8Array(),
        firstChunkSent: false,
        done: false,
        sourceFormat: null,
        resampler: null,
      };
    };

    const sendEnd = () => {
      const response = responseRef.current;
      // SDK 0.0.18 exposes repeatAudio only as a complete utterance. LITE
      // streaming needs multiple agent.speak chunks followed by one speak_end,
      // so use its guarded WebSocket while keeping all session lifecycle in SDK.
      const socket = liveAvatarSession?._sessionEventSocket;
      if (!response.eventId || !socket || socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      socket.send(
        JSON.stringify({ type: "agent.speak_end", event_id: response.eventId })
      );
      return true;
    };

    const flushAudio = (force = false) => {
      const response = responseRef.current;
      const socket = liveAvatarSession?._sessionEventSocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;

      let threshold = response.firstChunkSent
        ? NEXT_AUDIO_CHUNK_BYTES
        : FIRST_AUDIO_CHUNK_BYTES;
      while (
        response.buffer.byteLength >= threshold ||
        (force && response.buffer.byteLength > 0)
      ) {
        const size = force
          ? Math.min(response.buffer.byteLength, threshold)
          : threshold;
        const chunk = response.buffer.slice(0, size);
        response.buffer = response.buffer.slice(size);
        socket.send(
          JSON.stringify({
            type: "agent.speak",
            event_id: response.eventId,
            audio: pcmBytesToBase64(chunk),
          })
        );
        response.firstChunkSent = true;
        threshold = NEXT_AUDIO_CHUNK_BYTES;
      }

      if (force && response.done && response.buffer.byteLength === 0) {
        sendEnd();
      }
      return true;
    };

    const interruptPreviousResponse = () => {
      if (!responseRef.current.responseId && !playbackRef.current.responseId) {
        return;
      }
      try {
        liveAvatarSession?.interrupt();
      } finally {
        resetResponse();
        playbackRef.current = { responseId: null, eventId: null };
      }
    };

    const onAudioDelta = (info) => {
      try {
        if (!(info?.audio instanceof Uint8Array) || !info?.responseId) {
          throw new TypeError("Assistant audio delta is incomplete");
        }
        if (!claimAvatarAudioResponse(info.responseId)) return;
        const sourceFormat = normalizeAssistantPcm16Format(info.format);
        const sequence = Number(info.sequence);
        if (!Number.isInteger(sequence) || sequence < 0) {
          throw new TypeError("Assistant audio sequence is invalid");
        }

        if (responseRef.current.responseId !== info.responseId) {
          const previousResponseId =
            responseRef.current.responseId || playbackRef.current.responseId;
          if (previousResponseId && previousResponseId !== info.responseId) {
            console.warn(
              `[HeyGen LiveAvatar] Response ${info.responseId} superseded ${previousResponseId}`
            );
            interruptPreviousResponse();
          }
          const eventId = crypto.randomUUID();
          responseRef.current.responseId = info.responseId;
          responseRef.current.eventId = eventId;
          responseRef.current.sourceFormat = sourceFormat;
          responseRef.current.resampler = new StreamingPcm16MonoResampler(
            sourceFormat,
            24000
          );
          playbackRef.current = { responseId: info.responseId, eventId };
        } else if (
          !pcm16FormatsMatch(responseRef.current.sourceFormat, sourceFormat)
        ) {
          throw new Error(
            `Assistant audio format changed during response ${info.responseId}`
          );
        }
        if (sequence <= responseRef.current.sequence) return;
        if (
          responseRef.current.sequence >= 0 &&
          sequence !== responseRef.current.sequence + 1
        ) {
          console.warn(
            `[HeyGen LiveAvatar] Audio sequence gap for ${info.responseId}: expected ${
              responseRef.current.sequence + 1
            }, received ${sequence}`
          );
        }
        responseRef.current.sequence = sequence;

        const pcm24k = responseRef.current.resampler.push(info.audio);
        responseRef.current.buffer = concatUint8Arrays(
          responseRef.current.buffer,
          pcm24k
        );
        flushAudio(false);
      } catch (error) {
        console.error("[HeyGen LiveAvatar] Audio bridge failed:", error);
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
      if (!responseRef.current.responseId) return;
      responseRef.current.buffer = concatUint8Arrays(
        responseRef.current.buffer,
        responseRef.current.resampler?.flush() || new Uint8Array()
      );
      responseRef.current.resampler = null;
      responseRef.current.done = true;
      if (flushAudio(true)) resetResponse();
    };

    const onAudioInterrupted = (info) => {
      const trackedResponseIds = [
        responseRef.current.responseId,
        playbackRef.current.responseId,
      ].filter(Boolean);
      if (
        info?.responseId &&
        trackedResponseIds.length > 0 &&
        !trackedResponseIds.includes(info.responseId)
      ) {
        return;
      }
      try {
        liveAvatarSession?.interrupt();
      } catch (error) {
        console.warn("[HeyGen LiveAvatar] Interrupt failed:", error);
      } finally {
        resetResponse();
        playbackRef.current = { responseId: null, eventId: null };
      }
    };

    const onAvatarSpeakEnded = (event) => {
      const activeEventId = playbackRef.current.eventId;
      if (
        !activeEventId ||
        event?.event_id === activeEventId ||
        event?.source_event_id === activeEventId
      ) {
        playbackRef.current = { responseId: null, eventId: null };
      }
    };

    const markReadyIfComplete = () => {
      if (
        isStale() ||
        failureReported ||
        !sessionStartResolved ||
        !streamPlaybackReady ||
        !videoRef.current
      ) {
        return;
      }
      const socket = liveAvatarSession?._sessionEventSocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        failSession("audio_bridge_unavailable");
        return;
      }
      clearTimeout(streamReadyTimeout);
      phaseRef.current = "ready";
      setPhase("ready");
      settlePreparation({ ready: true });
    };

    const startSession = async () => {
      try {
        const [tokenData, sdk] = await Promise.all([
          requestAvatarSession({
            assistantId,
            avatarId,
            provider: HEYGEN_AVATAR_PROVIDER,
          }),
          import("@heygen/liveavatar-web-sdk"),
        ]);
        if (isStale()) return;
        const { LiveAvatarSession, SessionEvent } = sdk;
        AgentEventsEnum = sdk.AgentEventsEnum;

        liveAvatarSession = new LiveAvatarSession(tokenData.sessionToken, {
          voiceChat: false,
        });

        liveAvatarSession.on(SessionEvent.SESSION_STREAM_READY, () => {
          if (isStale() || !videoRef.current) return;
          // LiveAvatar attaches its synchronized audio and video tracks to the
          // same media element. Telnyx playback is reserved by the playback
          // controller while this stage is mounted, so this is the only audible
          // assistant output once playback starts.
          liveAvatarSession.attach(videoRef.current);
          videoRef.current.volume = 1;
          // Pre-warm playback muted before the Telnyx call starts. The shared
          // playback effect unmutes it only after the call becomes active.
          videoRef.current.muted = true;
          void Promise.resolve(videoRef.current.play())
            .then(() => {
              if (isStale()) return;
              streamPlaybackReady = true;
              markReadyIfComplete();
            })
            .catch((error) => {
              console.warn("[HeyGen LiveAvatar] Playback failed:", error);
              if (!isStale()) failSession("playback_failed");
            });
        });
        liveAvatarSession.on(SessionEvent.SESSION_DISCONNECTED, (reason) => {
          if (!isStale()) {
            console.warn("[HeyGen LiveAvatar] Session disconnected:", reason);
            failSession("session_disconnected");
          }
        });
        liveAvatarSession.on(
          AgentEventsEnum.AVATAR_SPEAK_ENDED,
          onAvatarSpeakEnded
        );

        client?.on("assistant.audio.delta", onAudioDelta);
        client?.on("assistant.audio.done", onAudioDone);
        client?.on("assistant.audio.interrupted", onAudioInterrupted);
        streamReadyTimeout = setTimeout(
          () => {
            if (!isStale()) failSession("stream_timeout");
          },
          STREAM_READY_TIMEOUT_MS
        );
        await liveAvatarSession.start();
        if (isStale()) {
          await liveAvatarSession.stop().catch(() => {});
          return;
        }
        sessionStartResolved = true;
        markReadyIfComplete();

        keepAliveInterval = setInterval(() => {
          void liveAvatarSession.keepAlive().catch((error) => {
            console.warn("[HeyGen LiveAvatar] Keep-alive failed:", error);
          });
        }, KEEP_ALIVE_INTERVAL_MS);
      } catch (error) {
        console.error("[HeyGen LiveAvatar] Session start failed:", error);
        if (!isStale()) failSession(error?.reason || "provider_error");
      }
    };

    void startSession();

    return () => {
      stoppedRef.current = true;
      if (generationRef.current === generation) generationRef.current += 1;
      clearTimeout(streamReadyTimeout);
      clearInterval(keepAliveInterval);
      client?.off("assistant.audio.delta", onAudioDelta);
      client?.off("assistant.audio.done", onAudioDone);
      client?.off("assistant.audio.interrupted", onAudioInterrupted);
      resetResponse();
      playbackRef.current = { responseId: null, eventId: null };
      const sessionToStop = liveAvatarSession;
      liveAvatarSession = null;
      if (sessionToStop && AgentEventsEnum) {
        sessionToStop.removeListener(
          AgentEventsEnum.AVATAR_SPEAK_ENDED,
          onAvatarSpeakEnded
        );
      }
      if (sessionToStop) void sessionToStop.stop().catch(() => {});
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
  ]);

  const previewUrl = avatarConfig.previewUrl || avatarConfig.preview_url;
  const avatarName = avatarConfig.name || "HeyGen LiveAvatar";

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
