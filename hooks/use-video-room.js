"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLocalMedia, joinVideoRoom, stopTracks } from "@/lib/video/room-client.mjs";
import { VIDEO_SCENES } from "@/lib/video/scenes.mjs";

export const VIDEO_LAYOUTS = VIDEO_SCENES;

// Which remote streams a participant receives, by role and supervision mode
// (the internal documentation §2): the supervisor hears everyone;
// the agent hears the supervisor when whispering or barging; the visitor only
// when barging. A monitoring supervisor publishes nothing anyway.
export function subscriptionPolicy(role, supervisionMode) {
  return ({ role: remoteRole }) => {
    if (remoteRole !== "supervisor") return true;
    if (role === "supervisor") return true;
    if (role === "agent") return supervisionMode === "whisper" || supervisionMode === "barge";
    return supervisionMode === "barge";
  };
}

/**
 * Shared room controller for the visitor widget and the agent desktop.
 *
 * Local media is acquired up front (preview), then published on join. Camera
 * and microphone toggles update the published stream so the other side gets
 * track_enabled/track_disabled events; layout changes are broadcast as a
 * suggestion through room messages.
 */
export function useVideoRoom({ role, name, initialCamera = true, initialLayout = "pip", onRemoteLayout, onSupervision } = {}) {
  const [status, setStatus] = useState("idle"); // idle | preview | joining | connected | disconnected | error
  const [error, setError] = useState("");
  const [local, setLocal] = useState({ audio: null, video: null });
  const [cameraOn, setCameraOn] = useState(initialCamera);
  const [micOn, setMicOn] = useState(true);
  const [layout, setLayoutState] = useState(initialLayout);
  const [remote, setRemote] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [localScreen, setLocalScreen] = useState(null);
  const [supervision, setSupervisionState] = useState(null); // { mode, participantId?, name? } | null
  const [mixedAudioTrack, setMixedAudioTrack] = useState(null);
  const [audioTracks, setAudioTracks] = useState([]);
  const controllerRef = useRef(null);
  const localRef = useRef({ audio: null, video: null });
  const cameraWantedRef = useRef(initialCamera);
  const micWantedRef = useRef(true);
  const onRemoteLayoutRef = useRef(onRemoteLayout);
  onRemoteLayoutRef.current = onRemoteLayout;
  const onSupervisionRef = useRef(onSupervision);
  onSupervisionRef.current = onSupervision;
  const supervisionRef = useRef(null);
  const screenRef = useRef(null);

  const releaseLocal = useCallback(() => {
    stopTracks(localRef.current.audio, localRef.current.video);
    localRef.current = { audio: null, video: null };
    setLocal({ audio: null, video: null });
  }, []);

  // Acquire (or re-acquire) devices for the pre-join preview.
  const prepare = useCallback(async ({ camera = cameraWantedRef.current } = {}) => {
    setError("");
    try {
      releaseLocal();
      let media;
      try {
        media = await getLocalMedia({ audio: true, video: camera });
      } catch (mediaError) {
        if (!camera) throw mediaError;
        // A missing camera must not block an audio-only call.
        media = await getLocalMedia({ audio: true, video: false });
        camera = false;
      }
      localRef.current = media;
      setLocal(media);
      cameraWantedRef.current = camera;
      setCameraOn(camera && Boolean(media.video));
      setStatus((current) => (current === "idle" ? "preview" : current));
      return media;
    } catch (mediaError) {
      setError(mediaError?.message || "Media devices are unavailable");
      setStatus((current) => (current === "idle" ? "preview" : current));
      throw mediaError;
    }
  }, [releaseLocal]);

  // `media: false` joins receive-only without touching devices (a monitoring
  // supervisor); the microphone and camera toggles publish on first use.
  const join = useCallback(async ({ roomId, token, context = {}, media = true }) => {
    if (controllerRef.current) return controllerRef.current;
    setStatus("joining");
    setError("");
    if (!media) { micWantedRef.current = false; setMicOn(false); }
    try {
      // The policy reads the mode from the ref at evaluation time, so a
      // supervisor already in the room when this client joins (a refreshed
      // page) is honoured by the initial subscriptions; once the controller
      // exists the subscriptions are reconciled again.
      const policy = (stream) => subscriptionPolicy(role, supervisionRef.current?.mode || null)(stream);
      const applySupervision = (next, { announce = true } = {}) => {
        const mode = next && ["monitor", "whisper", "barge"].includes(next.mode) ? next : null;
        supervisionRef.current = mode;
        setSupervisionState(mode);
        void controllerRef.current?.applySubscriptions();
        if (announce) onSupervisionRef.current?.(mode);
      };
      // Devices are acquired in parallel with signaling: a pending permission
      // prompt or denied devices must not block joining. The participant is
      // connected receive-only until the tracks arrive, then publishes them.
      const mediaReady = !media ? Promise.resolve() : localRef.current.audio || localRef.current.video ? Promise.resolve() : prepare().catch(() => undefined);
      const controller = await joinVideoRoom({
        roomId,
        token,
        context: { role, name, ...context },
        onChange: (snapshot) => {
          setRemote(snapshot.remote);
          setParticipants(snapshot.participants || []);
          setMixedAudioTrack(snapshot.mixedAudioTrack);
          setAudioTracks(snapshot.audioTracks || []);
          if (snapshot.error) setError(snapshot.error?.message || String(snapshot.error));
          if (snapshot.status === "connected") setStatus("connected");
          // A supervisor's join context carries the mode; leaving clears it.
          const supervisor = (snapshot.participants || []).find((item) => item.role === "supervisor" && !item.self);
          if (supervisor && !supervisionRef.current) applySupervision({ mode: supervisor.mode || "monitor", participantId: supervisor.participantId, name: supervisor.name });
          else if (!supervisor && supervisionRef.current?.participantId && snapshot.status === "connected") applySupervision(null);
        },
        onMessage: (payload, from) => {
          if (payload?.layout && VIDEO_LAYOUTS.includes(payload.layout)) onRemoteLayoutRef.current?.(payload.layout);
          if (payload?.type === "supervision") applySupervision(payload.mode ? { mode: payload.mode, participantId: from, name: payload.name || supervisionRef.current?.name || null } : null);
        },
        onDisconnected: () => setStatus("disconnected"),
        shouldSubscribe: policy,
      });
      controllerRef.current = controller;
      void controller.applySubscriptions();
      setStatus("connected");
      void mediaReady.then(async () => {
        if (controllerRef.current !== controller || !media) return;
        const video = cameraWantedRef.current ? localRef.current.video : null;
        // The visitor may have muted while the permission prompt was open:
        // apply the current wish before the track goes out, not after.
        if (localRef.current.audio) localRef.current.audio.enabled = micWantedRef.current;
        if (localRef.current.audio || video) await controller.publish({ audio: localRef.current.audio, video }).catch((publishError) => setError(publishError?.message || "Unable to publish media"));
      });
      return controller;
    } catch (joinError) {
      setError(joinError?.message || "Unable to join the video call");
      setStatus("error");
      throw joinError;
    }
  }, [name, prepare, role]);

  const stopScreenShare = useCallback(async () => {
    const track = screenRef.current;
    screenRef.current = null;
    setLocalScreen(null);
    if (track) stopTracks(track);
    await controllerRef.current?.stopScreen();
  }, []);

  // Screen share is a second stream (`screen`); the browser's own "stop
  // sharing" control ends the track, which unpublishes it.
  const toggleScreenShare = useCallback(async () => {
    if (screenRef.current) { await stopScreenShare(); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { setError("Screen sharing is unavailable"); return; }
    const controller = controllerRef.current;
    if (!controller) { setError("Join the call before sharing your screen"); return; }
    let track = null;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
      track = stream.getVideoTracks()[0];
      if (!track) return;
      // The share is "on" only once the room accepted the stream; otherwise
      // the browser would keep capturing a screen nobody receives.
      await controller.shareScreen(track);
      if (controllerRef.current !== controller) { stopTracks(track); await controller.stopScreen(); return; }
      screenRef.current = track;
      setLocalScreen(track);
      track.addEventListener("ended", () => { if (screenRef.current === track) void stopScreenShare(); });
    } catch (shareError) {
      if (track) stopTracks(track);
      if (shareError?.name !== "NotAllowedError") setError(shareError?.message || "Screen sharing failed");
    }
  }, [stopScreenShare]);

  const leave = useCallback(async () => {
    const controller = controllerRef.current;
    controllerRef.current = null;
    if (screenRef.current) { stopTracks(screenRef.current); screenRef.current = null; setLocalScreen(null); }
    if (controller) await controller.leave();
    releaseLocal();
    setRemote([]);
    setParticipants([]);
    supervisionRef.current = null;
    setSupervisionState(null);
    setMixedAudioTrack(null); setAudioTracks([]);
    setStatus("disconnected");
  }, [releaseLocal]);

  // Server-known supervision (polled state) seeds or corrects the room view.
  const setSupervision = useCallback((next) => {
    const mode = next?.mode ? { mode: next.mode, participantId: next.participantId || supervisionRef.current?.participantId || null, name: next.name || supervisionRef.current?.name || null } : null;
    if ((mode?.mode || null) === (supervisionRef.current?.mode || null)) return;
    supervisionRef.current = mode;
    setSupervisionState(mode);
    void controllerRef.current?.applySubscriptions();
  }, []);

  // The supervisor announces a mode change to the room; the others adjust
  // their subscriptions from the message.
  const announceSupervision = useCallback((mode) => {
    controllerRef.current?.sendMessage({ type: "supervision", mode: mode || null, name, from: role });
  }, [name, role]);

  const resumeAfterHandoff = useCallback(async () => {
    const {audio, video} = localRef.current;
    if (!controllerRef.current) throw new Error("Video disconnected before the move completed");
    if (audio) audio.enabled = true;
    await controllerRef.current.publish({audio, video});
    micWantedRef.current = Boolean(audio); setMicOn(Boolean(audio));
    cameraWantedRef.current = Boolean(video); setCameraOn(Boolean(video));
  }, []);

  const toggleCamera = useCallback(async () => {
    const next = !cameraWantedRef.current;
    cameraWantedRef.current = next;
    try {
      if (next && !localRef.current.video) {
        const media = await getLocalMedia({ audio: false, video: true });
        localRef.current = { ...localRef.current, video: media.video };
        setLocal({ ...localRef.current });
      }
      if (controllerRef.current) await controllerRef.current.setVideoTrack(next ? localRef.current.video : null);
      if (!next && localRef.current.video) {
        stopTracks(localRef.current.video);
        localRef.current = { ...localRef.current, video: null };
        setLocal({ ...localRef.current });
      }
      setCameraOn(next && Boolean(localRef.current.video));
    } catch (cameraError) {
      cameraWantedRef.current = false;
      setCameraOn(false);
      setError(cameraError?.message || "Camera is unavailable");
    }
  }, []);

  // The ref is the source of truth: a media-less join mutes synchronously,
  // before the next render refreshes `micOn` in this callback's closure.
  const toggleMic = useCallback(async () => {
    const next = !micWantedRef.current;
    micWantedRef.current = next;
    if (!localRef.current.audio && next) {
      try {
        const media = await getLocalMedia({ audio: true, video: false });
        localRef.current = { ...localRef.current, audio: media.audio };
        setLocal({ ...localRef.current });
        if (controllerRef.current) await controllerRef.current.setAudioTrack(media.audio);
        setError("");
      } catch (audioError) {
        // Still muted: the next click must try the microphone again.
        micWantedRef.current = false;
        setError(audioError?.message || "Microphone is unavailable");
        return;
      }
    }
    if (localRef.current.audio) localRef.current.audio.enabled = next;
    setMicOn(next);
  }, []);

  const setLayout = useCallback((next, { broadcast = true } = {}) => {
    if (!VIDEO_LAYOUTS.includes(next)) return;
    setLayoutState(next);
    if (broadcast) controllerRef.current?.sendMessage({ layout: next, from: role });
  }, [role]);

  const updateToken = useCallback((token) => controllerRef.current?.updateToken(token), []);

  useEffect(() => () => {
    // Unmount without leave(): stop the screen capture too, or the browser
    // keeps sharing a screen nobody receives.
    if (screenRef.current) { stopTracks(screenRef.current); screenRef.current = null; }
    void controllerRef.current?.leave();
    releaseLocal();
  }, [releaseLocal]);
  // Development aid: the room view model is otherwise invisible outside React DevTools.
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || typeof window === "undefined") return;
    window.__ccVideoRoom = { role, status, error, cameraOn, micOn, layout, remote: remote.map((item) => ({ role: item.role, key: item.key, video: item.videoEnabled, audio: item.audioEnabled })), mixedAudio: Boolean(mixedAudioTrack) };
  }, [cameraOn, error, layout, micOn, mixedAudioTrack, remote, role, status]);

  const peer = useMemo(() => remote.find((item) => item.key === "self" && item.role !== "supervisor") || remote.find((item) => item.key === "self") || remote[0] || null, [remote]);
  const screen = useMemo(() => remote.find((item) => item.key === "screen") || null, [remote]);
  // Scene tiles (lib/video/scenes.mjs): own camera, own screen, every remote stream.
  const tiles = useMemo(() => [
    { id: "self", role, kind: "camera", self: true, track: local.video, cameraOff: !cameraOn, name: null },
    ...(localScreen ? [{ id: "self:screen", role, kind: "screen", self: true, track: localScreen, cameraOff: false, name: null }] : []),
    ...remote.map((item) => ({ id: `${item.participantId}:${item.key}`, role: item.role, kind: item.key === "screen" ? "screen" : "camera", self: false,
      track: item.videoTrack, cameraOff: item.key !== "screen" && !item.videoEnabled, name: item.name, participantId: item.participantId })),
  ], [cameraOn, local.video, localScreen, remote, role]);

  return { resumeAfterHandoff, status, error, local, cameraOn, micOn, layout, remote, participants, peer, screen, tiles, localScreen, screenSharing: Boolean(localScreen), supervision, mixedAudioTrack, audioTracks,
    prepare, join, leave, toggleCamera, toggleMic, toggleScreenShare, stopScreenShare, setLayout, setSupervision, announceSupervision, updateToken, clearError: () => setError("") };
}

// Attach a MediaStreamTrack (or null) to a <video>/<audio> element.
export function useTrackElement(ref, track, { muted = false } = {}) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    element.muted = muted;
    element.srcObject = track ? new MediaStream([track]) : null;
    if (track) element.play?.().catch(() => undefined);
    return () => { if (element.srcObject) element.srcObject = null; };
  }, [ref, track, muted]);
}
