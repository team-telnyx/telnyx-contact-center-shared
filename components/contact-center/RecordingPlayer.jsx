"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  IconPlayerPlay,
  IconPlayerPause,
  IconPlayerSkipBack,
  IconPlayerSkipForward,
  IconVolume,
  IconVolumeOff,
} from "@tabler/icons-react";
import WaveSurfer from "wavesurfer.js";

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "00:00";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
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
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.6);

  useEffect(() => {
    if ((!src && !recordingId) || !waveformRef.current) return;

    const timer = setTimeout(() => {
      const loadUrl = recordingId
        ? `/api/voice/recordings/${encodeURIComponent(recordingId)}/stream`
        : src;
      const wavesurfer = WaveSurfer.create({
        container: waveformRef.current,
        waveColor: "#6b7280",
        progressColor: "#374151",
        cursorColor: "#111827",
        barWidth: 2,
        barRadius: 3,
        responsive: true,
        height: 80,
        normalize: true,
        backend: "WebAudio",
        mediaControls: false,
      });

      wavesurferRef.current = wavesurfer;

      wavesurfer.on("ready", () => {
        setDuration(wavesurfer.getDuration() || 0);
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
      });

      try {
        wavesurfer.load(loadUrl);
      } catch (error) {
        console.error("[RecordingPlayer] Error loading recording:", error);
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
    };
  }, [src, recordingId]);

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

  return (
    <Card>
      <CardHeader className="text-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-semibold text-base">
            <IconPlayerPlay className="h-5 w-5 text-telnyx-green" />
            Call Recording
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {formatLabel ? <span>Format:</span> : null}
            {formatLabel ? (
              <Badge
                variant="outline"
                className="border-telnyx-green/60 text-telnyx-green"
              >
                {formatLabel}
              </Badge>
            ) : null}
            {channelLabel ? <span>Channels:</span> : null}
            {channelLabel ? (
              <Badge
                variant="outline"
                className="border-telnyx-green/60 text-telnyx-green"
              >
                {channelLabel}
              </Badge>
            ) : null}
            <span>Duration:</span>
            <Badge
              variant="outline"
              className="border-telnyx-green/60 text-telnyx-green"
            >
              {formatDuration(duration)}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="w-full border border-telnyx-green rounded-xl p-3">
          <div ref={waveformRef} className="w-full" />
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>0:00</span>
          <span>{formatDuration(duration)}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => seek(-5)}>
            <IconPlayerSkipBack className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            onClick={togglePlay}
            className="px-6 rounded-[10px] bg-muted text-foreground hover:bg-muted/80"
          >
            {playing ? (
              <>
                <IconPlayerPause className="h-4 w-4 mr-2" />
                Pause
              </>
            ) : (
              <>
                <IconPlayerPlay className="h-4 w-4 mr-2" />
                Play
              </>
            )}
          </Button>
          <Button size="sm" variant="outline" onClick={() => seek(5)}>
            <IconPlayerSkipForward className="h-4 w-4" />
          </Button>
          <div className="ml-auto flex items-center gap-2 w-40">
            {muted ? (
              <IconVolumeOff className="h-4 w-4 text-muted-foreground" />
            ) : (
              <IconVolume className="h-4 w-4 text-muted-foreground" />
            )}
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(volume * 100)}
              onChange={(e) => setVolume(Number(e.target.value) / 100)}
              className="h-2 w-full cursor-pointer accent-primary"
              aria-label="Volume"
            />
          </div>
          <Button
            size="sm"
            onClick={() => setMuted(!muted)}
            className="px-5 rounded-[10px] bg-muted text-foreground hover:bg-muted/80"
          >
            {muted ? (
              <>
                <IconVolumeOff className="h-4 w-4 mr-2" />
                Unmute
              </>
            ) : (
              <>
                <IconVolume className="h-4 w-4 mr-2" />
                Mute
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

