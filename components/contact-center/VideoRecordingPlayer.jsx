"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";

// Playback for composed video recordings (mp4). Mirrors the imperative
// seekToTime contract of RecordingPlayer so transcript cards can drive it.
const VideoRecordingPlayer = forwardRef(function VideoRecordingPlayer({ src, poster = null, onTimeUpdate, onPlayingChange, className = "" }, ref) {
  const videoRef = useRef(null);
  useImperativeHandle(ref, () => ({
    seekToTime(seconds) {
      const element = videoRef.current;
      if (!element || !Number.isFinite(seconds)) return;
      element.currentTime = Math.max(0, seconds);
      element.play?.().catch(() => undefined);
    },
  }), []);
  return (
    <div className={`overflow-hidden rounded-xl border bg-black ${className}`} data-testid="video-recording-player">
      <video ref={videoRef} src={src} poster={poster || undefined} controls preload="metadata" playsInline className="aspect-video w-full"
        onTimeUpdate={(event) => onTimeUpdate?.(event.currentTarget.currentTime)}
        onPlay={() => onPlayingChange?.(true)} onPause={() => onPlayingChange?.(false)} onEnded={() => onPlayingChange?.(false)} />
    </div>
  );
});

export default VideoRecordingPlayer;
