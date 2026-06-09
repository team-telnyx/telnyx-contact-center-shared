"use client";

import {
  IconAlertCircle,
  IconFileText,
  IconHeadset,
  IconPhoneCall,
  IconRobot,
  IconUsers,
} from "@tabler/icons-react";

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
  alert: { classes: "bg-gradient-to-b from-orange-500 to-orange-600", icon: IconAlertCircle, label: "Alert" },
  wrapup: { classes: "bg-gradient-to-b from-fuchsia-500 to-fuchsia-600", icon: IconFileText, label: "Wrapup" },
  hold: { classes: "bg-gradient-to-b from-amber-500 to-amber-600", icon: IconPhoneCall, label: "Hold" },
  transfer: { classes: "bg-gradient-to-b from-purple-500 to-purple-600", icon: IconPhoneCall, label: "Transfer" },
  ended: { classes: "bg-gradient-to-b from-red-500 to-red-600", icon: IconPhoneCall, label: "Ended" },
  recording: { classes: "bg-gradient-to-b from-indigo-500 to-indigo-600", icon: IconPhoneCall, label: "Recording" },
  other: { classes: "bg-gradient-to-b from-slate-500 to-slate-600", icon: IconPhoneCall, label: "Event" },
};

function getSegmentStyle(type) {
  const key = String(type || "").toLowerCase();
  if (key.includes("initiated")) return SEGMENT_STYLES.ivr;
  if (key.includes("enqueued")) return SEGMENT_STYLES.queue;
  if (
    key.includes("answered") ||
    key.includes("connected") ||
    key.includes("bridged") ||
    key.includes("offered") ||
    key.includes("resume")
  ) {
    return SEGMENT_STYLES.interact;
  }
  if (key.includes("alerting") || key.includes("ringing")) return SEGMENT_STYLES.alert;
  if (key.includes("wrapup")) return SEGMENT_STYLES.wrapup;
  if (key.includes("hold")) return SEGMENT_STYLES.hold;
  if (key.includes("transfer")) return SEGMENT_STYLES.transfer;
  if (key.includes("abandon") || key.includes("hangup") || key.includes("disconnect")) {
    return SEGMENT_STYLES.ended;
  }
  if (key.includes("recording")) return SEGMENT_STYLES.recording;
  return { ...SEGMENT_STYLES.other, label: titleCase(type || "Event") };
}

function titleCase(value) {
  return String(value || "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

export default function InteractionTimeline({ events = [] }) {
  if (!Array.isArray(events) || events.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No timeline events recorded.
      </div>
    );
  }

  const sorted = [...events].sort((a, b) => {
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

  const segments = withDurations
    .filter((event) => event._durationSeconds != null && event._durationSeconds > 0)
    .map((event, idx) => ({
      ...event,
      _id: `${event.type || "event"}-${idx}`,
    }));

  if (segments.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No timeline segments available.
      </div>
    );
  }

  const totalSeconds = segments.reduce(
    (sum, seg) => sum + (seg._durationSeconds || 0),
    0
  );
  const normalized = segments.map((segment) => {
    const widthPercent =
      totalSeconds > 0
        ? Math.max(4, ((segment._durationSeconds || 0) / totalSeconds) * 100)
        : 100 / segments.length;
    return {
      ...segment,
      _width: widthPercent,
      _sharePct: totalSeconds > 0 ? Math.round(((segment._durationSeconds || 0) / totalSeconds) * 100) : 0,
    };
  });

  // Legend aggregates total time per phase across all segments.
  const legendByLabel = new Map();
  for (const segment of normalized) {
    const style = getSegmentStyle(segment.type);
    const existing = legendByLabel.get(style.label) || { ...style, seconds: 0 };
    existing.seconds += segment._durationSeconds || 0;
    legendByLabel.set(style.label, existing);
  }

  return (
    <div className="space-y-4">
      {/* Phase bar */}
      <div className="flex h-14 w-full gap-[3px] overflow-visible">
        {normalized.map((segment) => {
          const style = getSegmentStyle(segment.type);
          const Icon = style.icon;
          return (
            <div
              key={segment._id}
              className={`group relative flex items-center justify-center first:rounded-l-xl last:rounded-r-xl rounded-[4px] text-white shadow-sm transition-transform hover:z-10 hover:scale-y-105 ${style.classes}`}
              style={{ width: `${segment._width}%` }}
              data-testid="phase-segment"
            >
              <div className="flex min-w-0 items-center gap-1.5 px-2">
                <Icon className="hidden h-3.5 w-3.5 shrink-0 opacity-80 sm:block" />
                <span className="truncate text-xs font-semibold drop-shadow-sm">{style.label}</span>
              </div>

              {/* Hover tooltip */}
              <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden min-w-[230px] max-w-xs -translate-x-1/2 rounded-xl border border-border bg-popover p-3 text-xs text-popover-foreground shadow-xl group-hover:block">
                <div className="mb-1.5 flex items-center gap-2 font-semibold">
                  <span className={`h-2.5 w-2.5 rounded-full ${style.classes}`} />
                  {style.label}
                  <span className="ml-auto font-normal text-muted-foreground">{segment._sharePct}% of call</span>
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
              </div>
            </div>
          );
        })}
      </div>

      {/* Time markers */}
      <div className="flex w-full gap-[3px] text-[11px] text-muted-foreground">
        {normalized.map((segment) => (
          <div
            key={`${segment._id}-meta`}
            style={{ width: `${segment._width}%` }}
            className="min-w-0 text-center"
          >
            <div className="truncate font-mono tabular-nums">{formatDateTimeShort(segment.timestamp)}</div>
            <div className="truncate font-medium text-foreground/70">{formatDuration(segment._durationSeconds)}</div>
          </div>
        ))}
      </div>

      {/* Legend with per-phase totals */}
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
    </div>
  );
}
