"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// How long WebRTC speech may run without a pre-playout chunk before the avatar
// cedes the first response (typically a static greeting) to WebRTC playback.
const STREAM_FALLBACK_GRACE_MS = 1200;

// Shared avatar playback arbitration for the assistant test phone (React
// provider) and the widget voice runtime (raw client). It decides which
// output is audible: the Telnyx WebRTC track or the synchronized avatar
// stream fed from the assistant pre-playout audio, and keeps the "hold"
// state in sync with the conversation audio element.
export function useAvatarPlayback({
  hasActiveConversation,
  agentStateName,
  transcript,
}) {
  const [isAvatarPlaybackActive, setIsAvatarPlaybackActive] = useState(false);
  const [isPlaybackHeld, setIsPlaybackHeld] = useState(false);
  const [isPreparingAvatar, setIsPreparingAvatar] = useState(false);
  const avatarControllerRef = useRef(null);
  const conversationAudioElementRef = useRef(null);
  const avatarPlaybackActiveRef = useRef(false);
  const playbackHeldRef = useRef(false);
  const avatarResponseDecisionsRef = useRef(new Map());
  const avatarReadyRef = useRef(false);
  const greetingFallbackRef = useRef(false);
  const streamFallbackTimerRef = useRef(null);
  const transcriptStateRef = useRef({ hasAssistantTurn: false, hasUserTurn: false });

  const syncConversationAudioMuted = useCallback(() => {
    const element = conversationAudioElementRef.current;
    if (element) {
      element.muted = avatarPlaybackActiveRef.current || playbackHeldRef.current;
    }
  }, []);

  const setAvatarPlaybackActive = useCallback(
    (active) => {
      const nextActive = Boolean(active);
      avatarPlaybackActiveRef.current = nextActive;
      // Apply synchronously: waiting for React could briefly play both the
      // WebRTC track and the pre-playout avatar stream.
      syncConversationAudioMuted();
      setIsAvatarPlaybackActive(nextActive);
    },
    [syncConversationAudioMuted]
  );

  const setPlaybackHeld = useCallback(
    (held) => {
      const nextHeld =
        typeof held === "function" ? Boolean(held(playbackHeldRef.current)) : Boolean(held);
      playbackHeldRef.current = nextHeld;
      syncConversationAudioMuted();
      setIsPlaybackHeld(nextHeld);
    },
    [syncConversationAudioMuted]
  );

  const registerConversationAudioElement = useCallback(
    (element) => {
      conversationAudioElementRef.current = element || null;
      syncConversationAudioMuted();
      return () => {
        if (conversationAudioElementRef.current === element) {
          conversationAudioElementRef.current = null;
        }
      };
    },
    [syncConversationAudioMuted]
  );

  useEffect(() => {
    transcriptStateRef.current = {
      hasAssistantTurn: (transcript || []).some(
        (item) => item?.role === "assistant" && String(item?.content || "").trim()
      ),
      hasUserTurn: (transcript || []).some(
        (item) => item?.role === "user" && String(item?.content || "").trim()
      ),
    };
  }, [transcript]);

  useEffect(() => {
    if (hasActiveConversation) return;
    avatarResponseDecisionsRef.current.clear();
    greetingFallbackRef.current = false;
    clearTimeout(streamFallbackTimerRef.current);
    streamFallbackTimerRef.current = null;
    setAvatarPlaybackActive(false);
    setPlaybackHeld(false);
  }, [hasActiveConversation, setAvatarPlaybackActive, setPlaybackHeld]);

  const claimAvatarAudioResponse = useCallback(
    (responseId) => {
      if (!responseId) {
        setAvatarPlaybackActive(true);
        return true;
      }
      if (avatarResponseDecisionsRef.current.has(responseId)) {
        return avatarResponseDecisionsRef.current.get(responseId);
      }
      clearTimeout(streamFallbackTimerRef.current);
      streamFallbackTimerRef.current = null;

      // When WebRTC already took over the first response because no chunk
      // arrived in time, let it finish instead of replaying the greeting.
      const { hasUserTurn } = transcriptStateRef.current;
      const shouldPlay = !(greetingFallbackRef.current && !hasUserTurn);

      avatarResponseDecisionsRef.current.set(responseId, shouldPlay);
      if (shouldPlay) {
        // From this point the stream owns output.
        setAvatarPlaybackActive(true);
      } else {
        console.info(
          `[Avatar] Skipped response ${responseId}: WebRTC already played the greeting`
        );
      }
      return shouldPlay;
    },
    [setAvatarPlaybackActive]
  );

  useEffect(() => {
    if (
      !hasActiveConversation ||
      agentStateName !== "speaking" ||
      !avatarPlaybackActiveRef.current ||
      avatarResponseDecisionsRef.current.size > 0 ||
      streamFallbackTimerRef.current
    ) {
      return;
    }
    // WebRTC carries assistant speech but no pre-playout chunk claimed it.
    // Give the stream a moment, then let WebRTC be heard instead of silence.
    streamFallbackTimerRef.current = setTimeout(() => {
      streamFallbackTimerRef.current = null;
      if (
        avatarResponseDecisionsRef.current.size > 0 ||
        !avatarPlaybackActiveRef.current
      ) {
        return;
      }
      greetingFallbackRef.current = true;
      setAvatarPlaybackActive(false);
      console.info(
        "[Avatar] No pre-playout audio for the first response; playing it through WebRTC"
      );
    }, STREAM_FALLBACK_GRACE_MS);
  }, [agentStateName, hasActiveConversation, setAvatarPlaybackActive]);

  useEffect(() => () => clearTimeout(streamFallbackTimerRef.current), []);

  const registerAvatarController = useCallback((controller) => {
    avatarControllerRef.current = controller;
    return () => {
      if (avatarControllerRef.current === controller) {
        avatarControllerRef.current = null;
      }
    };
  }, []);

  const prepareAvatar = useCallback(async () => {
    const controller = avatarControllerRef.current;
    if (!controller?.prepare) {
      avatarReadyRef.current = false;
      return { ready: false, skipped: true };
    }

    setIsPreparingAvatar(true);
    try {
      const result = await controller.prepare();
      avatarReadyRef.current = result?.ready === true;
      return result;
    } catch (error) {
      avatarReadyRef.current = false;
      throw error;
    } finally {
      setIsPreparingAvatar(false);
    }
  }, []);

  const stopAvatar = useCallback(async () => {
    avatarReadyRef.current = false;
    setIsPreparingAvatar(false);
    await avatarControllerRef.current?.stop?.();
  }, []);

  // Call right before the Telnyx conversation starts. A ready avatar owns
  // playback from the first response: Telnyx streams the greeting through the
  // pre-playout channel as well, so keeping WebRTC audible until the first
  // chunk would play the greeting twice.
  const beginConversation = useCallback(() => {
    avatarResponseDecisionsRef.current.clear();
    greetingFallbackRef.current = false;
    transcriptStateRef.current = { hasAssistantTurn: false, hasUserTurn: false };
    setAvatarPlaybackActive(avatarReadyRef.current);
  }, [setAvatarPlaybackActive]);

  const abortConversationStart = useCallback(() => {
    avatarResponseDecisionsRef.current.clear();
    setAvatarPlaybackActive(false);
  }, [setAvatarPlaybackActive]);

  return {
    abortConversationStart,
    beginConversation,
    claimAvatarAudioResponse,
    isAvatarPlaybackActive,
    isPlaybackHeld,
    isPreparingAvatar,
    prepareAvatar,
    registerAvatarController,
    registerConversationAudioElement,
    setAvatarPlaybackActive,
    setPlaybackHeld,
    stopAvatar,
  };
}
