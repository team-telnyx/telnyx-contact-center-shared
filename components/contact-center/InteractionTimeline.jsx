"use client";

import {
  IconAlertCircle,
  IconFileText,
  IconHeadset,
  IconPhoneCall,
  IconRobot,
  IconUsers,
} from "@tabler/icons-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { splitTransferWrapupEvents } from "@/lib/acd/transfer-wrapup-timeline.mjs";

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "-";
  const total = Math.max(0, Math.floor(Number(seconds)));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}m ${secs}s`;
}

function formatDateTimeShort(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad2 = (n) => String(n).padStart(2, "0");
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${hh}:${mm}:${ss}`;
}

const SEGMENT_STYLES = {
  ivr: { classes: "bg-gradient-to-b from-teal-500 to-teal-600", icon: IconRobot, label: "IVR" },
  queue: { classes: "bg-gradient-to-b from-sky-500 to-sky-600", icon: IconUsers, label: "In Queue" },
  interact: { classes: "bg-gradient-to-b from-emerald-500 to-emerald-600", icon: IconHeadset, label: "Interact" },
  consult: { classes: "bg-gradient-to-b from-indigo-500 to-violet-600", icon: IconUsers, label: "Consult" },
  alert: { classes: "bg-gradient-to-b from-orange-500 to-orange-600", icon: IconAlertCircle, label: "Alert" },
  wrapup: { classes: "bg-gradient-to-b from-fuchsia-500 to-fuchsia-600", icon: IconFileText, label: "Wrapup" },
  hold: { classes: "bg-gradient-to-b from-amber-500 to-amber-600", icon: IconPhoneCall, label: "Hold" },
  transfer: { classes: "bg-gradient-to-b from-purple-500 to-purple-600", icon: IconPhoneCall, label: "Transfer" },
  ended: { classes: "bg-gradient-to-b from-red-500 to-red-600", icon: IconPhoneCall, label: "Ended" },
  recording: { classes: "bg-gradient-to-b from-indigo-500 to-indigo-600", icon: IconPhoneCall, label: "Recording" },
  other: { classes: "bg-gradient-to-b from-slate-500 to-slate-600", icon: IconPhoneCall, label: "Event" },
};

const MIN_SEGMENT_WIDTH_PX = 104;
const MIN_TIMELINE_WIDTH_PX = 720;
const SEGMENT_GAP_PX = 3;

function getSegmentStyle(type, channel = "voice") {
  const key = String(type || "").toLowerCase();
  if (key === "received") return { ...SEGMENT_STYLES.ivr, label: "Intake", icon: IconFileText };
  if (key.includes("initiated")) return channel === "voice" ? SEGMENT_STYLES.ivr : { ...SEGMENT_STYLES.ivr, label: "Intake", icon: IconFileText };
  if (key.includes("enqueued")) return SEGMENT_STYLES.queue;
  if (
    key === "consult_customer_active" ||
    key === "consult_customer_restored" ||
    key === "consult_failed"
  ) {
    return SEGMENT_STYLES.interact;
  }
  if (key.startsWith("consult_")) return SEGMENT_STYLES.consult;
  if (key.includes("abandon") || key.includes("hangup") || key.includes("disconnect")) {
    return SEGMENT_STYLES.ended;
  }
  if (
    key.includes("answered") ||
    key.includes("connected") ||
    key.includes("bridged") ||
    key.includes("offered") ||
    key.includes("resume")
  ) {
    return SEGMENT_STYLES.interact;
  }
  if (
    key.includes("alerting") ||
    key.includes("ringing") ||
    key.includes("not_answering") ||
    key.includes("no_answer")
  ) {
    return SEGMENT_STYLES.alert;
  }
  if (key.includes("wrapup")) return SEGMENT_STYLES.wrapup;
  if (key.includes("hold")) return SEGMENT_STYLES.hold;
  if (key.includes("transfer")) return SEGMENT_STYLES.transfer;
  if (key.includes("recording")) return SEGMENT_STYLES.recording;
  return { ...SEGMENT_STYLES.other, label: titleCase(type || "Event") };
}

function titleCase(value) {
  return String(value || "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

export function coalesceAdjacentCallPhases(segments = []) {
  const merged = [];

  for (const segment of segments) {
    const phase = getSegmentStyle(segment.type).label;
    const previous = merged.at(-1);
    const previousPhase = previous
      ? getSegmentStyle(previous.type).label
      : null;
    const shouldMerge =
      previous &&
      phase === previousPhase &&
      (phase === "Consult" || phase === "Interact");

    if (shouldMerge) {
      previous._durationSeconds += segment._durationSeconds || 0;
      previous._phaseEventCount = (previous._phaseEventCount || 1) + 1;
      continue;
    }

    merged.push({ ...segment, _phaseEventCount: 1 });
  }

  return merged;
}

export default function InteractionTimeline({ events = [], channel = "voice" }) {
  if (!Array.isArray(events) || events.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No timeline events recorded.
      </div>
    );
  }

  const { events: sequentialEvents, wrapups: transferWrapups } = splitTransferWrapupEvents(events);
  const sorted = [...sequentialEvents].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });

  const withDurations = sorted.map((event, idx) => {
    const currentTs = event.timestamp
      ? new Date(event.timestamp).getTime()
      : null;
    const next = sorted[idx + 1];
    const nextTs = next?.timestamp ? new Date(next.timestamp).getTime() : null;
    const durationSeconds =
      currentTs && nextTs
        ? Math.max(0, Math.floor((nextTs - currentTs) / 1000))
        : null;
    return {
      ...event,
      _durationSeconds: durationSeconds,
    };
  });

  const phaseIntervals = withDurations
    .filter((event) => event._durationSeconds != null && event._durationSeconds > 0)
    .map((event) => ({ ...event }));
  // Event Journey intentionally keeps every routing event. The compact Call
  // Phases bar, however, should present uninterrupted Consult/Interact time as
  // one phase even when internal switch/bridge events split it into intervals.
  const segments = coalesceAdjacentCallPhases(phaseIntervals).map(
    (event, idx) => ({
      ...event,
      _id: `${event.type || "event"}-${idx}`,
    }),
  );

  if (segments.length === 0) {
    return (
      <div className="space-y-3">
        <div className="text-sm text-muted-foreground">No timeline segments available.</div>
        <TransferWrapups wrapups={transferWrapups} />
      </div>
    );
  }

  const totalSeconds = segments.reduce(
    (sum, seg) => sum + (seg._durationSeconds || 0),
    0
  );
  const proportionalTrackWidth = Math.max(
    MIN_TIMELINE_WIDTH_PX,
    segments.length * MIN_SEGMENT_WIDTH_PX
  );
  const normalized = segments.map((segment) => {
    const share =
      totalSeconds > 0
        ? (segment._durationSeconds || 0) / totalSeconds
        : 1 / segments.length;
    const proportionalWidth = share * proportionalTrackWidth;
    return {
      ...segment,
      _widthPx: Math.max(MIN_SEGMENT_WIDTH_PX, proportionalWidth),
      _sharePct: Math.round(share * 100),
    };
  });
  const timelineMinWidth =
    normalized.reduce((sum, segment) => sum + segment._widthPx, 0) +
    Math.max(0, normalized.length - 1) * SEGMENT_GAP_PX;
  const segmentLayoutStyle = (segment) => ({
    flexBasis: `${segment._widthPx}px`,
    flexGrow: Math.max(1, segment._durationSeconds || 0),
    flexShrink: 0,
  });

  // Legend aggregates total time per phase across all segments.
  const legendByLabel = new Map();
  for (const segment of normalized) {
    const style = getSegmentStyle(segment.type, channel);
    const existing = legendByLabel.get(style.label) || { ...style, seconds: 0 };
    existing.seconds += segment._durationSeconds || 0;
    legendByLabel.set(style.label, existing);
  }

  return (
    <div className="space-y-4">
      <div
        className="w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain pb-2 [scrollbar-gutter:stable]"
        data-testid="phase-timeline-scroll"
      >
        <div className="w-full" style={{ minWidth: `${timelineMinWidth}px` }}>
          {/* Phase bar */}
          <div className="flex h-14 w-full gap-[3px]">
            {normalized.map((segment) => {
              const style = getSegmentStyle(segment.type, channel);
              const Icon = style.icon;
              return (
                <Tooltip key={segment._id}>
                  <TooltipTrigger asChild>
                    <div
                      className={`relative flex items-center justify-center first:rounded-l-xl last:rounded-r-xl rounded-[4px] text-white shadow-sm transition-transform hover:z-10 hover:scale-y-105 ${style.classes}`}
                      style={segmentLayoutStyle(segment)}
                      data-testid="phase-segment"
                    >
                      <div className="flex items-center gap-1.5 px-2">
                        <Icon className="h-3.5 w-3.5 shrink-0 opacity-80" />
                        <span className="whitespace-nowrap text-xs font-semibold drop-shadow-sm">{style.label}</span>
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    sideOffset={8}
                    className="min-w-[230px] max-w-xs rounded-xl border border-border bg-popover p-3 text-xs text-popover-foreground shadow-xl"
                  >
                    <div className="mb-1.5 flex items-center gap-2 font-semibold">
                      <span className={`h-2.5 w-2.5 rounded-full ${style.classes}`} />
                      {style.label}
                      <span className="ml-auto font-normal text-muted-foreground">{segment._sharePct}% of interaction</span>
                    </div>
                    <div className="space-y-0.5 text-muted-foreground">
                      <div className="flex justify-between gap-4"><span>Start</span><span className="font-mono">{formatDateTime(segment.timestamp)}</span></div>
                      <div className="flex justify-between gap-4"><span>Duration</span><span className="font-mono">{formatDuration(segment._durationSeconds)}</span></div>
                      {segment.alertingDurationSeconds != null && (
                        <div className="flex justify-between gap-4"><span>Alerting</span><span className="font-mono">{formatDuration(segment.alertingDurationSeconds)}</span></div>
                      )}
                      {segment.holdDuration != null && (
                        <div className="flex justify-between gap-4"><span>Hold</span><span className="font-mono">{formatDuration(segment.holdDuration)}</span></div>
                      )}
                      {segment.waitTimeSeconds != null && (
                        <div className="flex justify-between gap-4"><span>Wait</span><span className="font-mono">{formatDuration(segment.waitTimeSeconds)}</span></div>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>

          {/* Time markers use exactly the same sizing as their phase. */}
          <div className="mt-4 flex w-full gap-[3px] text-[11px] text-muted-foreground">
            {normalized.map((segment) => (
              <div
                key={`${segment._id}-meta`}
                style={segmentLayoutStyle(segment)}
                className="text-center"
              >
                <div className="whitespace-nowrap font-mono tabular-nums">{formatDateTimeShort(segment.timestamp)}</div>
                <div className="whitespace-nowrap font-medium text-foreground/70">{formatDuration(segment._durationSeconds)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Legend with per-phase totals stays fixed inside the card. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border/60 pt-3 text-xs text-muted-foreground" data-testid="phase-legend">
        {Array.from(legendByLabel.values()).map((entry) => (
          <span key={entry.label} className="inline-flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${entry.classes}`} />
            <span className="font-medium text-foreground/80">{entry.label}</span>
            <span className="font-mono tabular-nums">{formatDuration(entry.seconds)}</span>
          </span>
        ))}
        <span className="ml-auto inline-flex items-center gap-1.5">
          <span className="font-medium text-foreground/80">Total</span>
          <span className="font-mono tabular-nums">{formatDuration(totalSeconds)}</span>
        </span>
      </div>
      <TransferWrapups wrapups={transferWrapups} />
    </div>
  );
}

function TransferWrapups({ wrapups }) {
  return (<>
      {wrapups.length > 0 && (
        <div className="space-y-2 border-t pt-3" data-testid="transfer-wrapups">
          <p className="text-xs text-muted-foreground">Agent wrap-up after transfer · runs alongside the continuing interaction</p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {wrapups.map(wrapup => (
              <div key={wrapup.segmentId} className="flex items-center gap-3 rounded-lg border border-fuchsia-500/20 bg-card p-3" data-testid="transfer-wrapup-segment">
                <span className="rounded-lg bg-fuchsia-500/10 p-2 text-fuchsia-600 dark:text-fuchsia-400"><IconFileText className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium" title={wrapup.agentName || wrapup.agentUsername || wrapup.agentId}>{wrapup.agentName || wrapup.agentUsername || wrapup.agentId || "Agent"}</div>
                  <div className="text-xs text-muted-foreground">{formatDateTimeShort(wrapup.timestamp)} – {wrapup.endedAt ? formatDateTimeShort(wrapup.endedAt) : "In progress"}</div>
                </div>
                <span className="shrink-0 font-mono text-sm tabular-nums">{wrapup.durationSeconds == null ? "Pending" : formatDuration(wrapup.durationSeconds)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
  </>);
}
