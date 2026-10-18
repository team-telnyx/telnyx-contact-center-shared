"use client";
import { useEffect, useRef, useState } from "react";
import { useAvatarBridge } from "./avatar-bridge";
import { getAvatarDisplayAspectRatio } from "@/lib/ai/avatar-config.mjs";
import { telnyxAvatarPreviewUrl } from "@/lib/ai/telnyx-avatar-catalog.mjs";

export function TelnyxAvatarStage({ avatarId, avatarConfig = {}, onUnavailable, fill = false, fit = "cover", focusY = 25 }) {
  const { client, isPlaybackHeld } = useAvatarBridge();
  const ref = useRef(null);
  const [presentedMedia, setPresentedMedia] = useState(null);
  const previewUrl = telnyxAvatarPreviewUrl(avatarId);
  const hasVideoFrame = Boolean(client?.stream && presentedMedia?.client === client && presentedMedia.stream === client.stream);
  useEffect(() => {
    if (!client?.attachVideo) return;
    const video = ref.current;
    let frameCallback = null;
    let disposed = false;
    const cancelFrame = () => {
      if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback);
      frameCallback = null;
    };
    const resetPreview = () => {
      cancelFrame();
      setPresentedMedia(null);
    };
    const awaitFrame = () => {
      const stream = video.srcObject;
      if (!stream || video.readyState < 2 || !video.videoWidth || !video.videoHeight || frameCallback !== null) return;
      const revealVideo = () => {
        frameCallback = null;
        if (!disposed && video.srcObject === stream && client.stream === stream) {
          setPresentedMedia({ client, stream });
        }
      };
      // A connected transport / "ready" event can precede visible video.
      // Keep the portrait until this element actually presents a frame.
      if (typeof video.requestVideoFrameCallback === "function") {
        frameCallback = video.requestVideoFrameCallback(revealVideo);
      } else if (!video.paused) {
        // Older browsers: playing + decoded video data, never transport state.
        revealVideo();
      }
    };
    const handlePhase = (phase) => {
      if (phase === "idle" || phase === "starting") resetPreview();
    };
    video.addEventListener("loadeddata", awaitFrame);
    video.addEventListener("playing", awaitFrame);
    video.addEventListener("emptied", resetPreview);
    client.on("avatar.phase", handlePhase);
    client.on("avatar.unavailable", onUnavailable);
    client.attachVideo(video);
    return () => {
      disposed = true;
      cancelFrame();
      video.removeEventListener("loadeddata", awaitFrame);
      video.removeEventListener("playing", awaitFrame);
      video.removeEventListener("emptied", resetPreview);
      client.off("avatar.phase", handlePhase);
      client.off("avatar.unavailable", onUnavailable);
      client.attachVideo(null);
    };
  }, [client, onUnavailable]);
  useEffect(() => { client?.setPlaybackHeld?.(isPlaybackHeld); }, [client, isPlaybackHeld]);
  return <div className={`relative overflow-hidden bg-zinc-950 ${fill ? "h-full w-full" : "w-full"}`} style={fill ? undefined : { aspectRatio: getAvatarDisplayAspectRatio(avatarConfig.displayFormat) }}>
    <video ref={ref} autoPlay playsInline className="absolute inset-0 h-full w-full" style={{ objectFit: fit, objectPosition: `50% ${focusY}%` }} />
    {!hasVideoFrame && (previewUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={previewUrl} alt={avatarConfig.name || avatarId} className="absolute inset-0 h-full w-full" style={{ objectFit: fit, objectPosition: `50% ${focusY}%` }} />
    ) : <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white"><span className="text-4xl">{(avatarConfig.name || "Telnyx").slice(0, 1)}</span><span className="text-sm">{avatarConfig.name || "Telnyx"}</span></div>)}
  </div>;
}
