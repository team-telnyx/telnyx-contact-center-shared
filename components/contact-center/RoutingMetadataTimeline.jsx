"use client";

import {
  IconPhone,
  IconPhoneCall,
  IconPhoneIncoming,
  IconPhoneOutgoing,
  IconClock,
  IconUser,
  IconUsers,
  IconTransfer,
  IconPlayerPause,
  IconPlayerPlay,
  IconCheck,
  IconX,
  IconAlertCircle,
  IconCircleDot,
  IconHistory,
  IconFileText,
  IconClockHour4,
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

function getEventIcon(type, event = {}) {
  const key = String(type || "").toLowerCase();
  // Check if this is a transfer event by looking for transfer-related fields
  const isTransferEvent =
    key === "transfer" ||
    (event.transferredBy && (event.to || event.callControlId));

  if (isTransferEvent) return IconTransfer;
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

function getEventColor(type, event = {}) {
  const key = String(type || "").toLowerCase();
  // Check if this is a transfer event by looking for transfer-related fields
  const isTransferEvent =
    key === "transfer" ||
    (event.transferredBy && (event.to || event.callControlId));

  if (isTransferEvent) return "text-violet-600 bg-violet-50 border-violet-200";
  if (key.includes("initiated"))
    return "text-teal-600 bg-teal-50 border-teal-200";
  if (key.includes("enqueued"))
    return "text-blue-600 bg-blue-50 border-blue-200";
  if (key.includes("offered"))
    return "text-purple-600 bg-purple-50 border-purple-200";
  if (key.includes("alerting"))
    return "text-orange-600 bg-orange-50 border-orange-200";
  if (key.includes("answered"))
    return "text-emerald-600 bg-emerald-50 border-emerald-200";
  if (key.includes("connected") || key.includes("bridged")) {
    return "text-green-600 bg-green-50 border-green-200";
  }
  if (key.includes("hold"))
    return "text-amber-600 bg-amber-50 border-amber-200";
  if (key.includes("resume")) return "text-lime-600 bg-lime-50 border-lime-200";
  if (key.includes("wrapup"))
    return "text-fuchsia-600 bg-fuchsia-50 border-fuchsia-200";
  if (
    key.includes("disconnect") ||
    key.includes("abandon") ||
    key.includes("hangup")
  ) {
    return "text-red-600 bg-red-50 border-red-200";
  }
  return "text-slate-600 bg-slate-50 border-slate-200";
}

function getEventDescription(event) {
  const type = String(event.type || "").toLowerCase();
  const parts = [];

  // Handle transfer events - the type field might be overwritten with transfer type (queue/agent)
  // Check for transfer-related fields to identify transfer events
  const isTransferEvent =
    type === "transfer" ||
    (event.transferredBy && (event.to || event.callControlId));

  if (isTransferEvent) {
    parts.push("Call transferred");
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
    parts.push("Call initiated");
    if (event.from) parts.push(`from ${event.from}`);
    if (event.to) parts.push(`to ${event.to}`);
    if (event.direction) parts.push(`(${event.direction})`);
  } else if (type.includes("enqueued")) {
    parts.push("Call enqueued");
    if (event.queueName) parts.push(`in queue "${event.queueName}"`);
    if (event.currentPosition != null) {
      parts.push(`at position ${event.currentPosition + 1}`);
    }
    if (event.queueAvgWaitTimeSecs != null) {
      const waitTime = formatDuration(event.queueAvgWaitTimeSecs);
      if (waitTime) parts.push(`(avg wait: ${waitTime})`);
    }
  } else if (type.includes("offered")) {
    parts.push("Call offered");
    if (event.agentUsername) parts.push(`to agent ${event.agentUsername}`);
  } else if (type.includes("alerting")) {
    parts.push("Agent alerting");
    if (event.agentUsername) parts.push(`(${event.agentUsername})`);
    // Note: routingAlgorithm is displayed as a badge separately, not in description
    if (event.reEvaluated) parts.push("(re-evaluated)");
  } else if (type.includes("answered")) {
    parts.push("Call answered");
    if (event.agentUsername) parts.push(`by ${event.agentUsername}`);
    if (event.alertingDurationSeconds != null) {
      const duration = formatDuration(event.alertingDurationSeconds);
      if (duration) parts.push(`(alerting: ${duration})`);
    }
  } else if (type.includes("connected") || type.includes("bridged")) {
    parts.push("Call connected");
    if (event.agentUsername) parts.push(`with ${event.agentUsername}`);
  } else if (type.includes("hold")) {
    parts.push("Call placed on hold");
    if (event.holdNumber != null) parts.push(`(hold #${event.holdNumber})`);
  } else if (type.includes("resume")) {
    parts.push("Call resumed");
    if (event.holdDuration != null) {
      const duration = formatDuration(event.holdDuration);
      if (duration) parts.push(`(held for ${duration})`);
    }
  } else if (type.includes("wrapup_start")) {
    parts.push("Wrap-up started");
    if (event.agentUsername) parts.push(`by ${event.agentUsername}`);
  } else if (type.includes("wrapup_end")) {
    parts.push("Wrap-up completed");
    if (event.agentUsername) parts.push(`by ${event.agentUsername}`);
    if (event.wrapupDurationSeconds != null) {
      const duration = formatDuration(event.wrapupDurationSeconds);
      if (duration) parts.push(`(duration: ${duration})`);
    }
  } else if (type.includes("disconnected")) {
    parts.push("Call disconnected");
    if (event.reason) parts.push(`(${event.reason})`);
    if (event.hangupCause) parts.push(`- ${event.hangupCause}`);
  } else if (type.includes("abandoned")) {
    parts.push("Call abandoned");
    if (event.waitTimeSeconds != null) {
      const waitTime = formatDuration(event.waitTimeSeconds);
      if (waitTime) parts.push(`(waited ${waitTime})`);
    }
  } else {
    parts.push(titleCase(event.type || "Event"));
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

  // Check for FIFO variations
  if (
    algo === "fifo" ||
    algo === "first_in_first_out" ||
    algo.includes("fifo") ||
    (algo.includes("first") && algo.includes("out"))
  ) {
    return "FIFO";
  }

  // Check for Skill-based variations
  if (
    algo === "skills_based" ||
    algo === "skill_based" ||
    algo.includes("skill")
  ) {
    return "Skill-based";
  }

  // Check for Priority-based variations
  if (algo === "priority_based" || algo.includes("priority")) {
    return "Priority-based";
  }

  return null;
}

function RoutingTypeBadge({ routingAlgorithm }) {
  // Convert routing algorithm to routing strategy format
  const routingStrategy = getRoutingStrategyFromAlgorithm(routingAlgorithm);

  // Map to display text - always use short form (FIFO, not "First In First Out")
  let displayText;
  if (routingStrategy === "FIFO") {
    displayText = "FIFO";
  } else if (routingStrategy === "Skill-based") {
    displayText = "SKILL-BASED";
  } else if (routingStrategy === "Priority-based") {
    displayText = "PRIORITY-BASED";
  } else {
    // If we couldn't map it, use the original value formatted nicely
    displayText = String(routingAlgorithm || "")
      .replace(/_/g, " ")
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ")
      .toUpperCase();
  }

  return (
    <Badge
      className={`text-xs uppercase ${
        routingStrategy === "FIFO"
          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
          : routingStrategy === "Skill-based"
            ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
            : routingStrategy === "Priority-based"
              ? "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"
              : "bg-gray-100 text-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
      }`}
      variant="outline"
    >
      {displayText}
    </Badge>
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
    <div className="space-y-0">
      {sorted.map((event, index) => {
        const Icon = getEventIcon(event.type, event);
        const colorClasses = getEventColor(event.type, event);
        const description = getEventDescription(event);
        const timeSincePrevious = calculateTimeSincePrevious(
          event,
          sorted[index - 1],
        );

        return (
          <div
            key={`${event.type}-${event.timestamp}-${index}`}
            className="relative"
          >
            {/* Timeline line */}
            {index < sorted.length - 1 && (
              <div className="absolute left-5 top-12 bottom-0 w-0.5 bg-border" />
            )}

            <div className="flex gap-4 pb-6">
              {/* Icon */}
              <div
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 ${colorClasses}`}
              >
                <Icon className="h-5 w-5" />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{description}</div>
                    {event.timestamp && (
                      <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                        <IconClock className="h-3 w-3" />
                        <span>{formatDateTime(event.timestamp)}</span>
                        {timeSincePrevious != null && timeSincePrevious > 0 && (
                          <span className="text-muted-foreground/70">
                            (+{formatDuration(timeSincePrevious)})
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {event.timestamp && (
                    <div className="text-xs text-muted-foreground font-mono shrink-0">
                      {formatTime(event.timestamp)}
                    </div>
                  )}
                </div>

                {/* Additional details */}
                {(event.queueId ||
                  event.agentId ||
                  event.callControlId ||
                  event.routingAlgorithm ||
                  event.waitTimeSeconds != null ||
                  event.alertingDurationSeconds != null ||
                  event.holdDuration != null ||
                  event.wrapupDurationSeconds != null) && (
                  <div className="mt-2 space-y-1">
                    {event.queueId && (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium">Queue ID:</span>{" "}
                        {event.queueId}
                      </div>
                    )}
                    {event.agentId && (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium">Agent ID:</span>{" "}
                        {event.agentId}
                      </div>
                    )}
                    {event.callControlId && (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium">Call Control ID:</span>{" "}
                        <code className="bg-muted px-1 py-0.5 rounded text-[10px]">
                          {event.callControlId}
                        </code>
                      </div>
                    )}
                    {event.routingAlgorithm && (
                      <div className="text-xs text-muted-foreground flex items-center gap-2">
                        <span className="font-medium">Routing:</span>
                        <RoutingTypeBadge
                          routingAlgorithm={event.routingAlgorithm}
                        />
                      </div>
                    )}
                    {event.waitTimeSeconds != null && (
                      <div className="text-xs text-muted-foreground flex items-center gap-1">
                        <IconClockHour4 className="h-3 w-3" />
                        <span>
                          <span className="font-medium">Wait time:</span>{" "}
                          {formatDuration(event.waitTimeSeconds)}
                        </span>
                      </div>
                    )}
                    {event.alertingDurationSeconds != null && (
                      <div className="text-xs text-muted-foreground flex items-center gap-1">
                        <IconAlertCircle className="h-3 w-3" />
                        <span>
                          <span className="font-medium">
                            Alerting duration:
                          </span>{" "}
                          {formatDuration(event.alertingDurationSeconds)}
                        </span>
                      </div>
                    )}
                    {event.holdDuration != null && (
                      <div className="text-xs text-muted-foreground flex items-center gap-1">
                        <IconPlayerPause className="h-3 w-3" />
                        <span>
                          <span className="font-medium">Hold duration:</span>{" "}
                          {formatDuration(event.holdDuration)}
                        </span>
                      </div>
                    )}
                    {event.wrapupDurationSeconds != null && (
                      <div className="text-xs text-muted-foreground flex items-center gap-1">
                        <IconFileText className="h-3 w-3" />
                        <span>
                          <span className="font-medium">Wrap-up duration:</span>{" "}
                          {formatDuration(event.wrapupDurationSeconds)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
