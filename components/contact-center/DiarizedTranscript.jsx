"use client";

import { useEffect, useMemo, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { IconHeadset, IconUser } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

// Speaker tones cycle for diarized turns (speaker 0, 1, 2, ...). Matches the
// emerald/sky language used across the Agent Desktop / quality views.
const SPEAKER_TONES = [
  { bubble: "bg-emerald-600 text-white", avatar: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/40" },
  { bubble: "bg-sky-600 text-white", avatar: "bg-sky-500/15 text-sky-600 dark:text-sky-300 border-sky-500/40" },
  { bubble: "bg-violet-600 text-white", avatar: "bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/40" },
  { bubble: "bg-amber-600 text-white", avatar: "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/40" },
];

function speakerToneFor(speaker) {
  const index = Number(speaker);
  if (Number.isFinite(index)) return SPEAKER_TONES[Math.abs(index) % SPEAKER_TONES.length];
  const hash = String(speaker).split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return SPEAKER_TONES[hash % SPEAKER_TONES.length];
}

function formatClock(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatConfidence(confidence) {
  if (confidence == null || !Number.isFinite(Number(confidence))) return null;
  return `${Math.round(Number(confidence) * 100)}%`;
}

// Synced diarized transcript rendered as chat bubbles. When wired to a player
// (currentTime / isPlaying / onSeek) it highlights the turn currently being
// played, scrolls it into view, and lets the user click a bubble to seek the
// recording to that turn — mirroring the demo-portal conversation view.
//
// Speaker turns carry `start`/`end` in SECONDS relative to recording start
// (Deepgram diarization), so they map directly onto the player's currentTime.
export default function DiarizedTranscript({
  speakerTurns = [],
  currentTime = 0,
  isPlaying = false,
  onSeek = null,
  className,
}) {
  const turnRefs = useRef({});

  const synced = onSeek != null;

  // Index of the turn currently being played (latest turn whose start has passed,
  // with a small 0.3s lead-in to feel responsive). -1 when not playing/synced.
  const currentIndex = useMemo(() => {
    if (!synced || speakerTurns.length === 0) return -1;
    const adjusted = Number(currentTime) + 0.3;
    for (let i = speakerTurns.length - 1; i >= 0; i--) {
      const start = Number(speakerTurns[i]?.start);
      if (Number.isFinite(start) && adjusted >= start) return i;
    }
    return -1;
  }, [synced, currentTime, speakerTurns]);

  // Auto-scroll the active turn into view during playback.
  useEffect(() => {
    if (!isPlaying || currentIndex < 0) return;
    const el = turnRefs.current[currentIndex];
    if (!el) return;
    const id = setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }, 100);
    return () => clearTimeout(id);
  }, [currentIndex, isPlaying]);

  return (
    <div className={cn("space-y-4 px-4 pb-4", className)} data-testid="diarized-transcript">
      {speakerTurns.map((turn, index) => {
        const isRight = Number(turn.speaker) % 2 === 1;
        const tone = speakerToneFor(turn.speaker);
        const confidenceLabel = formatConfidence(turn.confidence);
        const hasStart = Number.isFinite(Number(turn.start));
        const isActive = synced && index === currentIndex;
        const clickable = synced && hasStart;

        return (
          <div
            key={`${turn.speaker}-${turn.start}-${index}`}
            ref={(el) => {
              if (el) turnRefs.current[index] = el;
            }}
            className={`flex w-full items-end gap-2 ${isRight ? "flex-row-reverse" : "flex-row"}`}
          >
            <div className={`flex size-8 shrink-0 items-center justify-center rounded-full border ${tone.avatar}`}>
              {isRight ? <IconHeadset className="size-4" /> : <IconUser className="size-4" />}
            </div>
            <div className={`flex min-w-0 max-w-[85%] flex-col ${isRight ? "items-end" : "items-start"}`}>
              <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-medium">Speaker {Number(turn.speaker) + 1}</span>
                {hasStart && (
                  <span className="font-mono tabular-nums">
                    {formatClock(turn.start)}
                    {Number.isFinite(Number(turn.end)) ? `–${formatClock(turn.end)}` : ""}
                  </span>
                )}
                {confidenceLabel && (
                  <Badge variant="outline" className="h-4 border-border/70 px-1 text-[9px]">
                    {confidenceLabel}
                  </Badge>
                )}
              </div>
              <div
                className={cn(
                  "rounded-2xl px-3.5 py-2 text-sm shadow-sm transition-all",
                  isRight ? `${tone.bubble} rounded-br-md` : "rounded-bl-md bg-muted text-foreground",
                  isActive && "ring-2 ring-orange-500 shadow-lg shadow-orange-500/30",
                  clickable && "cursor-pointer hover:opacity-90",
                )}
                onClick={() => {
                  if (clickable) onSeek(Math.max(0, Number(turn.start) - 0.3));
                }}
                title={clickable ? "Click to play from here" : undefined}
              >
                <p className="whitespace-pre-wrap leading-relaxed">{turn.text}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
