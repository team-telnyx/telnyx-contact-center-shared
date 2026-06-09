"use client";

import {
  IconPhoneCall,
  IconPhoneIncoming,
  IconPhoneOutgoing,
  IconClock,
  IconUsers,
  IconTransfer,
  IconPlayerPause,
  IconPlayerPlay,
  IconCheck,
  IconX,
  IconAlertCircle,
  IconCircleDot,
  IconFileText,
  IconClockHour4,
  IconRoute,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad2 = (n) => String(n).padStart(2, "0");
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${hh}:${mm}:${ss}`;
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return null;
  const total = Math.max(0, Math.floor(Number(seconds)));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hrs}h ${remainingMins}m ${secs}s`;
}

function isTransfer(type, event = {}) {
  const key = String(type || "").toLowerCase();
  return key === "transfer" || (event.transferredBy && (event.to || event.callControlId));
}

function getEventIcon(type, event = {}) {
  const key = String(type || "").toLowerCase();
  if (isTransfer(type, event)) return IconTransfer;
  if (key.includes("initiated")) return IconPhoneOutgoing;
  if (key.includes("enqueued")) return IconUsers;
  if (key.includes("offered")) return IconPhoneIncoming;
  if (key.includes("alerting")) return IconAlertCircle;
  if (key.includes("answered")) return IconPhoneCall;
  if (key.includes("connected") || key.includes("bridged")) return IconCheck;
  if (key.includes("hold")) return IconPlayerPause;
  if (key.includes("resume")) return IconPlayerPlay;
  if (key.includes("wrapup")) return IconFileText;
  if (
    key.includes("disconnect") ||
    key.includes("abandon") ||
    key.includes("hangup")
  ) {
    return IconX;
  }
  return IconCircleDot;
}

// Dark-mode friendly tones: translucent tinted node + matching accent strip.
const EVENT_TONES = {
  transfer: { node: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300", accent: "bg-violet-500", glow: "shadow-violet-500/20" },
  initiated: { node: "border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-300", accent: "bg-teal-500", glow: "shadow-teal-500/20" },
  enqueued: { node: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300", accent: "bg-sky-500", glow: "shadow-sky-500/20" },
  offered: { node: "border-purple-500/40 bg-purple-500/10 text-purple-600 dark:text-purple-300", accent: "bg-purple-500", glow: "shadow-purple-500/20" },
  alerting: { node: "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-300", accent: "bg-orange-500", glow: "shadow-orange-500/20" },
  answered: { node: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300", accent: "bg-emerald-500", glow: "shadow-emerald-500/20" },
  connected: { node: "border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-300", accent: "bg-green-500", glow: "shadow-green-500/20" },
  hold: { node: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300", accent: "bg-amber-500", glow: "shadow-amber-500/20" },
  resume: { node: "border-lime-500/40 bg-lime-500/10 text-lime-600 dark:text-lime-300", accent: "bg-lime-500", glow: "shadow-lime-500/20" },
  wrapup: { node: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-300", accent: "bg-fuchsia-500", glow: "shadow-fuchsia-500/20" },
  ended: { node: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300", accent: "bg-red-500", glow: "shadow-red-500/20" },
  default: { node: "border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300", accent: "bg-zinc-500", glow: "shadow-zinc-500/20" },
};

function getEventTone(type, event = {}) {
  const key = String(type || "").toLowerCase();
  if (isTransfer(type, event)) return EVENT_TONES.transfer;
  if (key.includes("initiated")) return EVENT_TONES.initiated;
  if (key.includes("enqueued")) return EVENT_TONES.enqueued;
  if (key.includes("offered")) return EVENT_TONES.offered;
  if (key.includes("alerting")) return EVENT_TONES.alerting;
  if (key.includes("answered")) return EVENT_TONES.answered;
  if (key.includes("connected") || key.includes("bridged")) return EVENT_TONES.connected;
  if (key.includes("hold")) return EVENT_TONES.hold;
  if (key.includes("resume")) return EVENT_TONES.resume;
  if (key.includes("wrapup")) return EVENT_TONES.wrapup;
  if (
    key.includes("disconnect") ||
    key.includes("abandon") ||
    key.includes("hangup")
  ) {
    return EVENT_TONES.ended;
  }
  return EVENT_TONES.default;
}

function getEventTitle(event) {
  const type = String(event.type || "").toLowerCase();
  if (isTransfer(event.type, event)) return "Call transferred";
  if (type.includes("initiated")) return "Call initiated";
  if (type.includes("enqueued")) return "Call enqueued";
  if (type.includes("offered")) return "Call offered";
  if (type.includes("alerting")) return "Agent alerting";
  if (type.includes("answered")) return "Call answered";
  if (type.includes("connected") || type.includes("bridged")) return "Call connected";
  if (type.includes("hold")) return "Call placed on hold";
  if (type.includes("resume")) return "Call resumed";
  if (type.includes("wrapup_start")) return "Wrap-up started";
  if (type.includes("wrapup_end")) return "Wrap-up completed";
  if (type.includes("disconnected")) return "Call disconnected";
  if (type.includes("abandoned")) return "Call abandoned";
  return titleCase(event.type || "Event");
}

function getEventDetail(event) {
  const type = String(event.type || "").toLowerCase();
  const parts = [];

  if (isTransfer(event.type, event)) {
    if (event.to) {
      if (type === "queue" || event.type === "queue") {
        parts.push(`to queue "${event.to}"`);
      } else if (type === "agent" || event.type === "agent") {
        parts.push(`to agent ${event.to}`);
      } else {
        parts.push(`to ${event.to}`);
      }
    }
    if (event.transferredBy) parts.push(`by ${event.transferredBy}`);
    if (type !== "transfer" && type !== "queue" && type !== "agent" && type) {
      parts.push(`(${type})`);
    }
  } else if (type.includes("initiated")) {
    if (event.from) parts.push(`from ${event.from}`);
    if (event.to) parts.push(`to ${event.to}`);
    if (event.direction) parts.push(`(${event.direction})`);
  } else if (type.includes("enqueued")) {
    if (event.queueName) parts.push(`queue "${event.queueName}"`);
    if (event.currentPosition != null) {
      parts.push(`position ${event.currentPosition + 1}`);
    }
    if (event.queueAvgWaitTimeSecs != null) {
      const waitTime = formatDuration(event.queueAvgWaitTimeSecs);
      if (waitTime) parts.push(`(avg wait: ${waitTime})`);
    }
  } else if (type.includes("offered")) {
    if (event.agentUsername) parts.push(`to agent ${event.agentUsername}`);
  } else if (type.includes("alerting")) {
    if (event.agentUsername) parts.push(event.agentUsername);
    if (event.reEvaluated) parts.push("(re-evaluated)");
  } else if (type.includes("answered")) {
    if (event.agentUsername) parts.push(`by ${event.agentUsername}`);
    if (event.alertingDurationSeconds != null) {
      const duration = formatDuration(event.alertingDurationSeconds);
      if (duration) parts.push(`(alerting: ${duration})`);
    }
  } else if (type.includes("connected") || type.includes("bridged")) {
    if (event.agentUsername) parts.push(`with ${event.agentUsername}`);
  } else if (type.includes("hold")) {
    if (event.holdNumber != null) parts.push(`hold #${event.holdNumber}`);
  } else if (type.includes("resume")) {
    if (event.holdDuration != null) {
      const duration = formatDuration(event.holdDuration);
      if (duration) parts.push(`held for ${duration}`);
    }
  } else if (type.includes("wrapup_start")) {
    if (event.agentUsername) parts.push(`by ${event.agentUsername}`);
  } else if (type.includes("wrapup_end")) {
    if (event.agentUsername) parts.push(`by ${event.agentUsername}`);
    if (event.wrapupDurationSeconds != null) {
      const duration = formatDuration(event.wrapupDurationSeconds);
      if (duration) parts.push(`(duration: ${duration})`);
    }
  } else if (type.includes("disconnected")) {
    if (event.reason) parts.push(event.reason);
    if (event.hangupCause) parts.push(`· ${event.hangupCause}`);
  } else if (type.includes("abandoned")) {
    if (event.waitTimeSeconds != null) {
      const waitTime = formatDuration(event.waitTimeSeconds);
      if (waitTime) parts.push(`waited ${waitTime}`);
    }
  }

  return parts.join(" ");
}

function titleCase(value) {
  return String(value || "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

function getRoutingStrategyFromAlgorithm(algorithm) {
  // Convert routing algorithm names to routing strategy format
  // Values can be: "fifo", "first_in_first_out", "skills_based", "priority_based", "manual", etc.
  const algo = String(algorithm || "").toLowerCase();

  if (
    algo === "fifo" ||
    algo === "first_in_first_out" ||
    algo.includes("fifo") ||
    (algo.includes("first") && algo.includes("out"))
  ) {
    return "FIFO";
  }

  if (
    algo === "skills_based" ||
    algo === "skill_based" ||
    algo.includes("skill")
  ) {
    return "Skill-based";
  }

  if (algo === "priority_based" || algo.includes("priority")) {
    return "Priority-based";
  }

  return null;
}

function RoutingTypeBadge({ routingAlgorithm }) {
  const routingStrategy = getRoutingStrategyFromAlgorithm(routingAlgorithm);

  let displayText;
  if (routingStrategy === "FIFO") {
    displayText = "FIFO";
  } else if (routingStrategy === "Skill-based") {
    displayText = "SKILL-BASED";
  } else if (routingStrategy === "Priority-based") {
    displayText = "PRIORITY-BASED";
  } else {
    displayText = String(routingAlgorithm || "")
      .replace(/_/g, " ")
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ")
      .toUpperCase();
  }

  return (
    <Badge
      className={`text-[10px] uppercase tracking-wide ${
        routingStrategy === "FIFO"
          ? "bg-blue-500/10 text-blue-700 border-blue-500/40 dark:text-blue-300"
          : routingStrategy === "Skill-based"
            ? "bg-green-500/10 text-green-700 border-green-500/40 dark:text-green-300"
            : routingStrategy === "Priority-based"
              ? "bg-purple-500/10 text-purple-700 border-purple-500/40 dark:text-purple-300"
              : "bg-zinc-500/10 text-zinc-700 border-zinc-500/40 dark:text-zinc-300"
      }`}
      variant="outline"
    >
      <IconRoute className="mr-1 h-3 w-3" />
      {displayText}
    </Badge>
  );
}

function DetailChip({ icon: Icon, label, value, mono = false }) {
  if (value == null || value === "") return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
      {Icon ? <Icon className="h-3 w-3 shrink-0" /> : null}
      <span className="font-medium text-foreground/70">{label}</span>
      <span className={mono ? "font-mono text-[10px]" : ""}>{value}</span>
    </span>
  );
}

function calculateTimeSincePrevious(event, previousEvent) {
  if (!event.timestamp || !previousEvent?.timestamp) return null;
  const current = new Date(event.timestamp).getTime();
  const previous = new Date(previousEvent.timestamp).getTime();
  if (Number.isNaN(current) || Number.isNaN(previous)) return null;
  const diffSeconds = Math.max(0, Math.floor((current - previous) / 1000));
  return diffSeconds;
}

export default function RoutingMetadataTimeline({ events = [] }) {
  if (!Array.isArray(events) || events.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4 text-center">
        No routing events recorded for this call.
      </div>
    );
  }

  // Filter out agent_timeout events - these are internal routing events that shouldn't be displayed
  const filteredEvents = events.filter(
    (event) => event.type !== "agent_timeout",
  );

  if (filteredEvents.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4 text-center">
        No routing events recorded for this call.
      </div>
    );
  }

  // Sort events by timestamp
  const sorted = [...filteredEvents].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });

  return (
    <div className="relative">
      {/* Gradient spine connecting the event nodes */}
      <div className="absolute left-[21px] top-3 bottom-3 w-px bg-gradient-to-b from-teal-500/50 via-border to-red-500/40" aria-hidden="true" />

      <div className="space-y-3">
        {sorted.map((event, index) => {
          const Icon = getEventIcon(event.type, event);
          const tone = getEventTone(event.type, event);
          const title = getEventTitle(event);
          const detail = getEventDetail(event);
          const timeSincePrevious = calculateTimeSincePrevious(
            event,
            sorted[index - 1],
          );

          const hasChips =
            event.queueId ||
            event.agentId ||
            event.callControlId ||
            event.routingAlgorithm ||
            event.waitTimeSeconds != null ||
            event.alertingDurationSeconds != null ||
            event.holdDuration != null ||
            event.wrapupDurationSeconds != null;

          return (
            <div
              key={`${event.type}-${event.timestamp}-${index}`}
              className="relative flex gap-4"
              data-testid="routing-timeline-event"
            >
              {/* Node */}
              <div className={`relative z-10 mt-1.5 flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full border-2 shadow-lg ${tone.node} ${tone.glow} bg-background`}>
                <span className={`absolute inset-[3px] rounded-full opacity-15 ${tone.accent}`} aria-hidden="true" />
                <Icon className="relative h-5 w-5" />
              </div>

              {/* Event card */}
              <div className="group relative min-w-0 flex-1 overflow-hidden rounded-2xl border border-border/70 bg-card/70 shadow-sm transition hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md">
                <span className={`absolute inset-y-0 left-0 w-1 ${tone.accent}`} aria-hidden="true" />
                <div className="p-3 pl-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <div className="min-w-0">
                      <span className="text-sm font-semibold">{title}</span>
                      {detail ? (
                        <span className="ml-2 text-sm text-muted-foreground">{detail}</span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {timeSincePrevious != null && timeSincePrevious > 0 && (
                        <Badge variant="outline" className="border-border/70 bg-muted/40 px-1.5 py-0 text-[10px] font-medium text-muted-foreground">
                          +{formatDuration(timeSincePrevious)}
                        </Badge>
                      )}
                      {event.timestamp && (
                        <span className="font-mono text-xs tabular-nums text-muted-foreground" title={formatDateTime(event.timestamp)}>
                          {formatTime(event.timestamp)}
                        </span>
                      )}
                    </div>
                  </div>

                  {hasChips && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {event.routingAlgorithm && (
                        <RoutingTypeBadge routingAlgorithm={event.routingAlgorithm} />
                      )}
                      <DetailChip icon={IconClockHour4} label="Wait" value={formatDuration(event.waitTimeSeconds)} />
                      <DetailChip icon={IconAlertCircle} label="Alerting" value={formatDuration(event.alertingDurationSeconds)} />
                      <DetailChip icon={IconPlayerPause} label="Hold" value={formatDuration(event.holdDuration)} />
                      <DetailChip icon={IconFileText} label="Wrap-up" value={formatDuration(event.wrapupDurationSeconds)} />
                      <DetailChip icon={IconUsers} label="Queue ID" value={event.queueId} mono />
                      <DetailChip icon={IconCircleDot} label="Agent ID" value={event.agentId} mono />
                      <DetailChip icon={IconPhoneCall} label="Call Control ID" value={event.callControlId} mono />
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
