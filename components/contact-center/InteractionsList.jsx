"use client";

import { useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Phone, PhoneIncoming, Clock, Mic, MicOff, Pause } from "lucide-react";
import { IconPhone } from "@tabler/icons-react";
import { getStatusDisplay } from "@/lib/call-status-utils";
import useActiveCallStore from "@/lib/stores/active-call-store";
import AiConversationSheet from "./AiConversationSheet";

// Format duration in seconds to MM:SS or HH:MM:SS
function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) {
    return "00:00";
  }
  const numSeconds = Number(seconds);
  if (isNaN(numSeconds) || numSeconds < 0) {
    return "00:00";
  }
  const hrs = Math.floor(numSeconds / 3600);
  const mins = Math.floor((numSeconds % 3600) / 60);
  const secs = Math.floor(numSeconds % 60);
  if (hrs > 0) {
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(
      2,
      "0"
    )}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// Calculate live duration for active interactions
function useCallDuration(interaction) {
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (!interaction) {
      setDuration(0);
      return;
    }

    // If interaction has ended, use stored duration
    if (
      interaction.completed_at ||
      interaction.abandoned_at ||
      interaction.state === "completed" ||
      interaction.state === "abandoned"
    ) {
      const storedDuration =
        (interaction.talk_time_seconds !== undefined &&
        interaction.talk_time_seconds !== null
          ? interaction.talk_time_seconds
          : 0) ||
        (interaction.handle_time_seconds !== undefined &&
        interaction.handle_time_seconds !== null
          ? interaction.handle_time_seconds
          : 0) ||
        0;
      setDuration(storedDuration);
      return;
    }

    // Calculate live duration
    const calculateDuration = () => {
      const startTime =
        interaction.answered_at ||
        interaction.assigned_at ||
        interaction.enqueued_at ||
        interaction.created_at;
      if (!startTime) {
        setDuration(0);
        return;
      }
      const start = new Date(startTime).getTime();
      const now = Date.now();
      const diffSeconds = Math.floor((now - start) / 1000);
      setDuration(Math.max(0, diffSeconds));
    };

    calculateDuration();
    const interval = setInterval(calculateDuration, 1000);
    return () => clearInterval(interval);
  }, [interaction]);

  return duration;
}

// Get real-time WebRTC status and state for an interaction
function getWebRTCStatus(interaction, webrtcCallState) {
  // If there's an active WebRTC call, check if we should use its status
  if (!webrtcCallState || !webrtcCallState.call) {
    return null; // No WebRTC call, use database status
  }

  const call = webrtcCallState.call;
  const callControlId = interaction.call_control_id;
  const interactionId = interaction.id;

  // Try to match by call_control_id or interaction_id
  const webrtcCallId =
    call.callId || call.callControlId || call.id || call.call_control_id;

  const isOutbound =
    interaction.direction === "outgoing" ||
    interaction.direction === "outbound";
  const isInbound =
    interaction.direction === "inbound" ||
    interaction.direction === "incoming" ||
    !isOutbound; // Default to inbound if direction not set

  const idsMatch = webrtcCallId === callControlId;
  const interactionIdsMatch =
    webrtcCallState.contactCenter?.interactionId === interactionId;

  // For contact center calls (inbound), prioritize matching by interaction ID
  // This is important because inbound calls transferred to agents have different
  // call_control_id values (original PSTN leg vs agent's WebRTC leg)
  if (interactionIdsMatch) {
    const isMuted = webrtcCallState.ui?.isMuted || false;
    const isHeld = webrtcCallState.ui?.isHeld || false;
    const webrtcStatus = webrtcCallState.status || call.state || null;

    return {
      status: webrtcStatus,
      isMuted,
      isHeld,
    };
  }

  // For inbound calls, also try matching by call_control_id (for cases where interactionId isn't set)
  if (isInbound && idsMatch) {
    const isMuted = webrtcCallState.ui?.isMuted || false;
    const isHeld = webrtcCallState.ui?.isHeld || false;
    const webrtcStatus = webrtcCallState.status || call.state || null;

    return {
      status: webrtcStatus,
      isMuted,
      isHeld,
    };
  }

  // For outbound calls or matching IDs, use WebRTC status
  if (idsMatch || (isOutbound && webrtcCallId)) {
    const callState = call.state || "";
    const storeStatus = webrtcCallState.status || "";
    const webrtcStatus = String(storeStatus || callState).toLowerCase();

    // If status indicates call ended, return null so we show database state
    if (
      ["hangup", "ended", "destroy", "idle", "terminated"].includes(
        webrtcStatus
      )
    ) {
      return null;
    }

    const isMuted = webrtcCallState.ui?.isMuted || false;
    const isHeld = webrtcCallState.ui?.isHeld || false;

    return {
      status: webrtcStatus || null,
      isMuted,
      isHeld,
    };
  }

  // Fallback: For inbound calls, if there's an active WebRTC call and this interaction is active,
  // match them even if interactionId isn't set in the store
  // This handles cases where the store metadata wasn't properly set but we still want to show
  // real-time status (hold, mute) for the active call
  if (isInbound && webrtcCallState.call) {
    // Only match if this interaction is active (not completed/abandoned)
    const isActive =
      !interaction.completed_at &&
      !interaction.abandoned_at &&
      interaction.state !== "completed" &&
      interaction.state !== "abandoned";

    // Also check if the interaction state suggests it's an active call
    const isActiveState = [
      "ringing",
      "active",
      "connected",
      "answered",
      "queued",
    ].includes(interaction.state?.toLowerCase());

    if (isActive && isActiveState) {
      const isMuted = webrtcCallState.ui?.isMuted || false;
      const isHeld = webrtcCallState.ui?.isHeld || false;
      const webrtcStatus = webrtcCallState.status || call.state || null;

      return {
        status: webrtcStatus,
        isMuted,
        isHeld,
      };
    }
  }

  return null; // No match, use database status
}

// Contact Center Interaction Card Component
function InteractionCard({
  interaction,
  isSelected,
  onSelect,
  webrtcState,
  currentUsername,
}) {
  if (!interaction) return null;
  const duration = useCallDuration(interaction);

  // Get WebRTC status if available
  const webrtcStatus = webrtcState?.status || null;
  const isMuted = webrtcState?.isMuted || false;
  const isHeld = webrtcState?.isHeld || false;

  // ALWAYS use WebRTC status if available (real-time), otherwise fall back to database status
  // BUT: if call is on hold, show "held" status regardless of other status
  let displayState = webrtcStatus !== null ? webrtcStatus : interaction.state;
  if (isHeld) {
    displayState = "held"; // Force "held" status when on hold
  }

  // Active states
  const activeStates = [
    "ringing",
    "active",
    "connected",
    "answered",
    "parked",
    "initiated",
    "bridging",
  ];
  const isActive = activeStates.includes(displayState?.toLowerCase());

  const isEnded =
    interaction.completed_at ||
    interaction.abandoned_at ||
    displayState === "completed" ||
    displayState === "abandoned" ||
    displayState === "hangup" ||
    displayState === "ended" ||
    displayState === "destroy" ||
    displayState === "idle" ||
    displayState === "terminated";

  // Get status display
  // Check if there's an active WebRTC call for this interaction
  const hasActiveCall = webrtcState && webrtcState.status && !isEnded;
  const statusDisplay = getStatusDisplay(displayState, hasActiveCall);

  const callerName =
    interaction.from_name ||
    interaction.fromName ||
    interaction.caller_name ||
    interaction.callerName ||
    null;
  // Prioritize from_number (database field) - it's the source of truth
  // Check for both truthiness and non-empty string
  let callerNumber =
    (interaction.from_number && interaction.from_number.trim() !== "")
      ? interaction.from_number
      : (interaction.fromNumber && interaction.fromNumber.trim() !== "")
      ? interaction.fromNumber
      : (interaction.from && interaction.from.trim() !== "")
      ? interaction.from
      : (interaction.caller_number && interaction.caller_number.trim() !== "")
      ? interaction.caller_number
      : (interaction.callerNumber && interaction.callerNumber.trim() !== "")
      ? interaction.callerNumber
      : null;
  
  // Fallback: try to extract from routing_metadata timeline if still missing
  if (!callerNumber && interaction.routing_metadata?.timeline) {
    const initiatedEvent = interaction.routing_metadata.timeline.find(
      (e) => e.type === "initiated" && e.from
    );
    if (initiatedEvent?.from && initiatedEvent.from.trim() !== "") {
      callerNumber = initiatedEvent.from;
    }
  }
  
  const callerNumberLabel = callerNumber || "Unknown number";
  const callerNameLabel = callerName || null;

  return (
    <div
      onClick={() => onSelect(interaction)}
      className={cn(
        "p-2.5 rounded-lg border-2 cursor-pointer transition-all hover:shadow-lg bg-card",
        isSelected
          ? "border-orange-500 shadow-lg ring-1 ring-orange-500/30"
          : isActive
          ? "border-orange-500/70 hover:border-orange-500 hover:shadow-md"
          : "border-border hover:border-muted-foreground/50"
      )}
    >
      <div className="flex items-start gap-2 mb-2">
        <div
          className={cn(
            "p-2 rounded-lg shrink-0 shadow-sm",
            isActive
              ? "bg-orange-500 text-white"
              : isEnded
              ? "bg-gray-400 text-gray-600"
              : "bg-orange-500 text-white"
          )}
        >
          <PhoneIncoming className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-1">
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-semibold text-orange-600 uppercase tracking-wide mb-0.5">
                {interaction.queue_name || "Contact Center"}
              </div>
              <div className="font-bold text-sm text-orange-600 truncate">
                {callerNameLabel || callerNumberLabel}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 truncate">
                {callerNumberLabel}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {(isMuted || isHeld) && (
                <div className="flex items-center gap-0.5">
                  {isMuted && (
                    <MicOff className="h-3 w-3 text-orange-600" title="Muted" />
                  )}
                  {isHeld && (
                    <Pause
                      className="h-3 w-3 text-orange-600"
                      title="On Hold"
                    />
                  )}
                </div>
              )}
              <span
                className={`border px-1.5 py-0.5 rounded text-[10px] font-semibold ${statusDisplay.color}`}
              >
                {statusDisplay.text}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-orange-500/30">
        <div className="flex items-center gap-1.5">
          <Clock className="h-3 w-3 text-orange-600" />
          <span className="font-mono font-semibold text-xs text-orange-600">
            {formatDuration(duration)}
          </span>
          {isActive && !isEnded && (
            <span className="text-orange-500 animate-pulse text-xs">●</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {interaction.to_number && (
            <div className="text-[10px] text-gray-600 font-medium bg-gray-100 px-1.5 py-0.5 rounded">
              {interaction.to_number}
            </div>
          )}
          <AiConversationSheet
            interaction={interaction}
            triggerClassName="h-6 w-6"
            iconClassName="h-3.5 w-3.5"
            stopPropagation
          />
        </div>
      </div>

      {/* All calls are controlled from WebRTC mini/floating phones */}
      {/* Answer/Reject buttons are shown in the WebRTC client, not here */}
    </div>
  );
}

export function InteractionsList({
  interactions,
  selectedId,
  onSelect,
  webrtcCallState,
  currentUsername,
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 bg-muted/50 border-b -mt-6 rounded-t-xl">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-primary/10">
            <IconPhone className="h-4 w-4 text-primary" />
          </div>
          <h2 className="text-base font-semibold text-foreground">
            Interactions
          </h2>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          {interactions.length === 0 ? (
            <div className="text-center text-muted-foreground py-12 text-sm">
              <Phone className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No interactions</p>
            </div>
          ) : (
            interactions
              .filter((interaction) => interaction && interaction.id)
              .map((interaction) => {
                // Get real-time WebRTC status if available
                const webrtcState = getWebRTCStatus(
                  interaction,
                  webrtcCallState
                );
                return (
                  <InteractionCard
                    key={interaction.id}
                    interaction={interaction}
                    isSelected={selectedId === interaction.id}
                    onSelect={onSelect}
                    webrtcState={webrtcState}
                    currentUsername={currentUsername}
                  />
                );
              })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
