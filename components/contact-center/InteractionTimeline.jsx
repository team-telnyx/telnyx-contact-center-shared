"use client";

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "-";
  const total = Math.max(0, Math.floor(Number(seconds)));
  return `${total}s`;
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

function getSegmentColor(type) {
  const key = String(type || "").toLowerCase();
  if (key.includes("initiated")) return "bg-teal-500";
  if (key.includes("enqueued")) return "bg-blue-400";
  if (
    key.includes("answered") ||
    key.includes("connected") ||
    key.includes("bridged") ||
    key.includes("offered") ||
    key.includes("resume")
  )
    return "bg-emerald-600";
  if (key.includes("alerting") || key.includes("ringing"))
    return "bg-orange-500";
  if (key.includes("wrapup")) return "bg-fuchsia-500";
  if (key.includes("hold")) return "bg-amber-500";
  if (key.includes("transfer")) return "bg-purple-500";
  if (key.includes("abandon") || key.includes("hangup") || key.includes("disconnect")) {
    return "bg-red-500";
  }
  if (key.includes("recording")) return "bg-indigo-500";
  return "bg-slate-500";
}

function getSegmentLabel(type) {
  const key = String(type || "").toLowerCase();
  if (key.includes("initiated")) return "IVR";
  if (key.includes("enqueued")) return "In Queue";
  if (
    key.includes("answered") ||
    key.includes("connected") ||
    key.includes("bridged") ||
    key.includes("offered") ||
    key.includes("resume")
  )
    return "Interact";
  if (key.includes("alerting") || key.includes("ringing")) return "Alert";
  if (key.includes("wrapup")) return "Wrapup";
  return titleCase(type || "Event");
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
        ? Math.max(3, ((segment._durationSeconds || 0) / totalSeconds) * 100)
        : 100 / segments.length;
    return {
      ...segment,
      _width: widthPercent,
    };
  });

  return (
    <div className="space-y-3">
      <div className="w-full border border-border rounded-full overflow-hidden h-10 flex">
        {normalized.map((segment) => (
          <div
            key={segment._id}
            className={`group relative ${getSegmentColor(segment.type)} text-white text-xs font-semibold flex items-center justify-center`}
            style={{ width: `${segment._width}%` }}
          >
            <span className="truncate px-2">{getSegmentLabel(segment.type)}</span>
            <div className="pointer-events-none absolute bottom-full mb-2 hidden min-w-[220px] max-w-xs rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg group-hover:block">
              <div className="font-semibold mb-1">
                {getSegmentLabel(segment.type)}
              </div>
              <div className="text-muted-foreground">
                Start: {formatDateTime(segment.timestamp)}
              </div>
              <div className="text-muted-foreground">
                Duration: {formatDuration(segment._durationSeconds)}
              </div>
              {segment.alertingDurationSeconds != null && (
                <div className="text-muted-foreground">
                  Alerting: {formatDuration(segment.alertingDurationSeconds)}
                </div>
              )}
              {segment.holdDuration != null && (
                <div className="text-muted-foreground">
                  Hold: {formatDuration(segment.holdDuration)}
                </div>
              )}
              {segment.waitTimeSeconds != null && (
                <div className="text-muted-foreground">
                  Wait: {formatDuration(segment.waitTimeSeconds)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="flex w-full text-[11px] text-muted-foreground">
        {normalized.map((segment) => (
          <div
            key={`${segment._id}-meta`}
            style={{ width: `${segment._width}%` }}
            className="text-center"
          >
            <div>{formatDateTimeShort(segment.timestamp)}</div>
            <div>{formatDuration(segment._durationSeconds)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

