"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  IconPlayerPlayFilled,
  IconPlayerPauseFilled,
  IconRewindBackward10,
  IconRewindForward10,
  IconVolume,
  IconVolumeOff,
  IconLoader2,
  IconWaveSine,
} from "@tabler/icons-react";
import WaveSurfer from "wavesurfer.js";
import { notify } from "@/components/ToastNotify";

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "00:00";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];

// Telnyx green vertical gradient builders (WaveSurfer v7 accepts CanvasGradient
// for waveColor/progressColor). Falls back to a solid color if the canvas 2D
// context is unavailable (e.g. SSR / headless).
function buildWaveGradient(ctx, height) {
  if (!ctx || typeof ctx.createLinearGradient !== "function") return "#10b98166";
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, "#34d399");      // emerald-400 (top)
  g.addColorStop(0.5, "#10b981");    // emerald-500 (mid)
  g.addColorStop(1, "#059669aa");    // emerald-600, faded (bottom)
  return g;
}

function buildProgressGradient(ctx, height) {
  if (!ctx || typeof ctx.createLinearGradient !== "function") return "#10b981";
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, "#6ee7b7");      // emerald-300 (top)
  g.addColorStop(0.5, "#10b981");    // emerald-500 (mid)
  g.addColorStop(1, "#047857");      // emerald-700 (bottom)
  return g;
}

// Two render styles for the waveform:
//  - "bars" (default, option B): dense thin bars with a vertical gradient
//  - "wave" (option C): continuous filled wave (no bars), gradient fill
const WAVE_STYLE_OPTIONS = [
  { value: "bars", label: "Bars" },
  { value: "wave", label: "Wave" },
];

// Bar geometry per style. Style C (wave) is a continuous fill — in WaveSurfer v7
// that means barWidth/barGap = 0. Returned as a full object so it can be passed
// to both WaveSurfer.create() and the live setOptions() toggle without recreating
// the instance (avoids re-decoding the audio / blinking the card).
function barOptionsFor(style) {
  return style === "wave"
    ? { barWidth: 0, barGap: 0, barRadius: 0 }
    : { barWidth: 2, barGap: 1, barRadius: 3 };
}

export default function RecordingPlayer({
  src,
  recordingId,
  format,
  channels,
}) {
  const waveformRef = useRef(null);
  const wavesurferRef = useRef(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [waveReady, setWaveReady] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.6);
  const [playbackRate, setPlaybackRate] = useState(1);
  // Waveform render style — "bars" (B, default) or "wave" (C, continuous).
  const [waveStyle, setWaveStyle] = useState("bars");
  // Ref mirror so the create-effect can read the current style at mount time
  // without re-subscribing (toggling style must NOT recreate the instance).
  const waveStyleRef = useRef(waveStyle);
  waveStyleRef.current = waveStyle;

  useEffect(() => {
    // Prefer recordingId over src to avoid CORS issues with direct S3 URLs
    const hasRecordingId = recordingId && String(recordingId).trim() !== "";
    if ((!src && !hasRecordingId) || !waveformRef.current) return;

    const timer = setTimeout(() => {
      // Always use proxy endpoint to avoid CORS issues
      let loadUrl;
      if (hasRecordingId) {
        // Use recording ID proxy endpoint (preferred)
        loadUrl = `/api/voice/recordings/${encodeURIComponent(recordingId)}/stream`;
      } else if (src && (src.startsWith("http://") || src.startsWith("https://"))) {
        // Use URL proxy endpoint for direct URLs to avoid CORS
        loadUrl = `/api/voice/recordings/proxy?url=${encodeURIComponent(src)}`;
      } else {
        // Fallback to src if it's a relative URL
        loadUrl = src;
      }

      const WAVE_HEIGHT = 96;
      // WaveSurfer v7 renders to a canvas; grab a 2D context to build gradients.
      const gradientCtx = document.createElement("canvas").getContext("2d");
      const waveColor = buildWaveGradient(gradientCtx, WAVE_HEIGHT);
      const progressColor = buildProgressGradient(gradientCtx, WAVE_HEIGHT);

      // Style B (bars): dense thin bars. Style C (wave): continuous fill.
      // Read from the ref so a later style toggle won't recreate this instance.
      const styleOptions = barOptionsFor(waveStyleRef.current);

      const wavesurfer = WaveSurfer.create({
        container: waveformRef.current,
        waveColor,
        progressColor,
        cursorColor: "#10b981",
        cursorWidth: 2,
        ...styleOptions,
        height: WAVE_HEIGHT,
        normalize: true,
        mediaControls: false,
      });

      wavesurferRef.current = wavesurfer;

      wavesurfer.on("ready", () => {
        setDuration(wavesurfer.getDuration() || 0);
        setWaveReady(true);
      });

      wavesurfer.on("play", () => {
        setPlaying(true);
      });

      wavesurfer.on("pause", () => {
        setPlaying(false);
      });

      wavesurfer.on("finish", () => {
        setPlaying(false);
      });

      wavesurfer.on("timeupdate", (time) => {
        setCurrentTime(time || 0);
      });

      wavesurfer.on("error", (error) => {
        console.error("[RecordingPlayer] WaveSurfer error:", error);
        const errorMessage = error?.message || String(error) || "";
        const errorString = errorMessage.toLowerCase();

        if (errorString.includes("failed to fetch") || errorString.includes("cors") || errorString.includes("networkerror")) {
          notify({ title: "Failed to load recording. The recording may be unavailable, expired, or there was a network error.", variant: "error" });
        } else {
          notify({ title: `Failed to load recording: ${errorMessage || "Unknown error"}`, variant: "error" });
        }
      });

      try {
        wavesurfer.load(loadUrl);
      } catch (error) {
        console.error("[RecordingPlayer] Error loading recording:", error);
        notify({ title: "Failed to initialize recording player", variant: "error" });
      }
    }, 100);

    return () => {
      clearTimeout(timer);
      if (wavesurferRef.current) {
        if (wavesurferRef.current.isPlaying()) {
          wavesurferRef.current.stop();
        }
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
      }
      setWaveReady(false);
    };
  }, [src, recordingId]);

  // Toggling the waveform style repaints in place via setOptions() — no destroy /
  // re-decode, so only the canvas updates and the rest of the card never blinks.
  useEffect(() => {
    const ws = wavesurferRef.current;
    if (!ws || !waveReady) return;
    try {
      ws.setOptions(barOptionsFor(waveStyle));
    } catch {
      // setOptions is best-effort; ignore if the instance is mid-teardown.
    }
  }, [waveStyle, waveReady]);

  useEffect(() => {
    if (wavesurferRef.current) {
      wavesurferRef.current.setVolume(volume);
    }
  }, [volume]);

  useEffect(() => {
    if (wavesurferRef.current) {
      wavesurferRef.current.setMuted(muted);
    }
  }, [muted]);

  useEffect(() => {
    if (wavesurferRef.current && waveReady) {
      try {
        wavesurferRef.current.setPlaybackRate(playbackRate);
      } catch {
        // Playback rate is a nice-to-have; ignore unsupported backends.
      }
    }
  }, [playbackRate, waveReady]);

  const togglePlay = () => {
    if (!wavesurferRef.current) return;
    wavesurferRef.current.playPause();
  };

  const seek = (delta) => {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer) return;
    const next = Math.max(
      0,
      Math.min(wavesurfer.getDuration() || 0, currentTime + delta)
    );
    const durationValue = wavesurfer.getDuration() || 0;
    if (durationValue > 0) {
      wavesurfer.seekTo(next / durationValue);
    }
  };

  const cyclePlaybackRate = () => {
    const idx = PLAYBACK_RATES.indexOf(playbackRate);
    const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(next);
  };

  const formatLabel = format ? String(format).toUpperCase() : null;
  const channelLabel = (() => {
    if (channels === null || channels === undefined) return null;
    if (typeof channels === "number") {
      return channels > 1 ? "Dual" : "Single";
    }
    const normalized = String(channels).toLowerCase();
    if (normalized.includes("dual") || normalized === "stereo") return "Dual";
    if (normalized.includes("single") || normalized === "mono")
      return "Single";
    return String(channels);
  })();

  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <Card className="overflow-hidden border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
      <CardContent className="p-0">
        {/* Header strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-muted/30 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
              <IconWaveSine className="h-5 w-5" />
            </span>
            <div>
              <div className="text-sm font-semibold leading-tight">Call Recording</div>
              <div className="text-xs text-muted-foreground">
                {playing ? "Playing" : waveReady ? "Ready to play" : "Loading waveform…"}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Waveform style toggle: Bars (B, default) ↔ Wave (C, continuous) */}
            <div
              className="inline-flex items-center rounded-full border border-border/70 bg-background/60 p-0.5"
              role="group"
              aria-label="Waveform style"
              data-testid="recording-wave-style-toggle"
            >
              {WAVE_STYLE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setWaveStyle(opt.value)}
                  className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide transition ${
                    waveStyle === opt.value
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  aria-pressed={waveStyle === opt.value}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {formatLabel ? (
              <Badge variant="outline" className="border-border/70 bg-background/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                {formatLabel}
              </Badge>
            ) : null}
            {channelLabel ? (
              <Badge variant="outline" className="border-border/70 bg-background/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                {channelLabel} channel
              </Badge>
            ) : null}
            <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
              {formatDuration(duration)}
            </Badge>
          </div>
        </div>

        {/* Waveform stage */}
        <div className="px-5 pt-5">
          <div className="relative rounded-2xl border border-border/70 bg-gradient-to-b from-muted/40 to-muted/10 p-4 dark:from-zinc-900/60 dark:to-zinc-950/40">
            {!waveReady && (
              <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <IconLoader2 className="h-4 w-4 animate-spin" />
                Loading waveform…
              </div>
            )}
            <div ref={waveformRef} className="w-full" />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-mono tabular-nums text-foreground/80" data-testid="recording-current-time">
              {formatDuration(currentTime)}
            </span>
            <div className="mx-3 hidden h-1 flex-1 overflow-hidden rounded-full bg-muted sm:block">
              <div className="h-full rounded-full bg-emerald-500/70 transition-[width]" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="font-mono tabular-nums">{formatDuration(duration)}</span>
          </div>
        </div>

        {/* Transport controls */}
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 pb-5 pt-3">
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="outline"
              onClick={() => seek(-10)}
              className="h-10 w-10 rounded-full"
              aria-label="Back 10 seconds"
              title="Back 10s"
            >
              <IconRewindBackward10 className="h-5 w-5" />
            </Button>
            <Button
              size="icon"
              onClick={togglePlay}
              className="h-14 w-14 rounded-full bg-emerald-600 text-white shadow-lg shadow-emerald-600/25 transition hover:scale-105 hover:bg-emerald-500"
              aria-label={playing ? "Pause" : "Play"}
              data-testid="recording-play-button"
            >
              {playing ? (
                <IconPlayerPauseFilled className="h-6 w-6" />
              ) : (
                <IconPlayerPlayFilled className="ml-0.5 h-6 w-6" />
              )}
            </Button>
            <Button
              size="icon"
              variant="outline"
              onClick={() => seek(10)}
              className="h-10 w-10 rounded-full"
              aria-label="Forward 10 seconds"
              title="Forward 10s"
            >
              <IconRewindForward10 className="h-5 w-5" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={cyclePlaybackRate}
              className="ml-1 h-8 w-14 rounded-full font-mono text-xs"
              aria-label="Playback speed"
              title="Playback speed"
            >
              {playbackRate}x
            </Button>
          </div>

          <div className="flex min-w-[200px] flex-1 items-center justify-end gap-2 sm:flex-none">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setMuted(!muted)}
              className="h-9 w-9 rounded-full"
              aria-label={muted ? "Unmute" : "Mute"}
            >
              {muted ? (
                <IconVolumeOff className="h-4.5 w-4.5 text-muted-foreground" />
              ) : (
                <IconVolume className="h-4.5 w-4.5 text-muted-foreground" />
              )}
            </Button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round((muted ? 0 : volume) * 100)}
              onChange={(e) => {
                setMuted(false);
                setVolume(Number(e.target.value) / 100);
              }}
              className="h-1.5 w-36 cursor-pointer accent-emerald-600"
              aria-label="Volume"
            />
            <span className="w-9 text-right font-mono text-xs tabular-nums text-muted-foreground">
              {muted ? 0 : Math.round(volume * 100)}%
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
