"use client";

import { useState, useEffect, useId } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Phone, PhoneIncoming, Clock, MicOff, Pause } from "lucide-react";
import { IconPhone, IconRobot, IconMessageCircle, IconMail, IconMessage, IconBrandWhatsapp, IconVideo } from "@tabler/icons-react";
import { usesNativeLifecycle } from "@/lib/acd/channel-registry.mjs";
import { getStatusDisplay } from "@/lib/call-status-utils";
import AiConversationSheet from "./AiConversationSheet";
import MessagingInteractionActions from "./MessagingInteractionActions";
import VoiceInteractionActions from "./VoiceInteractionActions";
import { matchesInteractionCall, voiceInteractionPhase } from "@/lib/telephony/interaction-controls.mjs";

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
      "0",
    )}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// Calculate live duration for active interactions
function useCallDuration(interaction) {
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const calculateDuration = () => {
      if (!interaction) {
        setDuration(0);
        return;
      }
      if (
        interaction.completed_at ||
        interaction.abandoned_at ||
        interaction.state === "completed" ||
        interaction.state === "abandoned"
      ) {
        setDuration(
          interaction.talk_time_seconds ||
            interaction.handle_time_seconds ||
            0,
        );
        return;
      }
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

    const initialUpdate = setTimeout(calculateDuration, 0);
    if (
      !interaction ||
      interaction.completed_at ||
      interaction.abandoned_at ||
      interaction.state === "completed" ||
      interaction.state === "abandoned"
    ) {
      return () => clearTimeout(initialUpdate);
    }
    const interval = setInterval(calculateDuration, 1000);
    return () => {
      clearTimeout(initialUpdate);
      clearInterval(interval);
    };
  }, [interaction]);

  return duration;
}

// Get real-time WebRTC status and state for an interaction
function getWebRTCStatus(interaction, webrtcCallState) {
  if (!matchesInteractionCall(interaction, webrtcCallState)) return null;
  return {
    status: webrtcCallState.status || webrtcCallState.call.state || null,
    isMuted: webrtcCallState.ui?.isMuted || false,
    isHeld: webrtcCallState.ui?.isHeld || false,
  };
}

// Keep the visual offer state aligned with the call controls, including SDK
// updates that arrive before the database refresh. A stale offer stops glowing
// at its deadline even when the next interaction refresh is delayed.
function useIncomingOffer(interaction, callState) {
  const [expiredDeadline, setExpiredDeadline] = useState(null);
  const messaging = usesNativeLifecycle(interaction?.channel);
  const offered = messaging
    ? ["ringing", "offered"].includes(interaction?.state) && !interaction?.completed_at && !interaction?.abandoned_at
    : voiceInteractionPhase(interaction, callState) === "incoming";
  const deadline = interaction?.offer_deadline;
  useEffect(() => {
    if (!offered || !deadline) return;
    const expiresAt = new Date(deadline).getTime();
    if (!Number.isFinite(expiresAt)) return;
    const timer = setTimeout(() => setExpiredDeadline(deadline), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [offered, deadline]);
  return offered && (!deadline || expiredDeadline !== deadline);
}

function IncomingLabel() {
  return <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-1.5 rounded-full bg-current" />Incoming</span>;
}

// Selection is a sibling of the controls, so buttons and portalled dialogs do
// not select a card or create nested interactive elements.
function InteractionCardFrame({interaction,isSelected,onSelect,label,className,incoming,children}) {
  const descriptionId = useId();
  return <div className={cn("relative w-full text-left",className,incoming && "cc-interaction-offer")} data-incoming={incoming || undefined} data-channel={interaction.channel || "voice"} data-testid={`${interaction.channel||"voice"}-interaction-card`} data-work-item-id={interaction.id}>
    <button type="button" onClick={()=>onSelect(interaction)} aria-label={label} aria-pressed={isSelected} aria-describedby={incoming ? descriptionId : undefined}
      className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"/>
    {incoming && <span id={descriptionId} className="sr-only">Incoming interaction awaiting your response.</span>}
    <div className="pointer-events-none relative">{children}</div>
  </div>;
}

// Contact Center Interaction Card Component
function InteractionCard({
  interaction,
  isSelected,
  onSelect,
  webrtcState,
  callState,
  onChanged,
}) {
  const duration = useCallDuration(interaction);
  const incoming = useIncomingOffer(interaction, callState);
  if (!interaction) return null;
  if (interaction.channel === "email") return <InteractionCardFrame interaction={interaction} incoming={incoming} isSelected={isSelected} onSelect={onSelect} label={`Email from ${interaction.from_name||"Email customer"}`}
    className={cn("w-full rounded-lg border-2 bg-card p-2.5 text-left transition-all hover:shadow-lg",isSelected?"border-amber-500 shadow-lg ring-1 ring-amber-500/30":"border-amber-500/60 hover:border-amber-500")}
    >
    <div className="mb-2 flex items-start gap-2">
      <div className="relative shrink-0 rounded-lg bg-amber-500 p-2 text-white shadow-sm"><IconMail className="size-4"/>{interaction.attributes?.handoff&&<span className="absolute -right-1 -top-1 rounded-full bg-violet-500 p-0.5"><IconRobot className="size-3.5"/></span>}</div>
      <div className="min-w-0 flex-1"><div className="mb-1 flex items-start justify-between gap-2"><div className="min-w-0 flex-1">
        <div className="mb-0.5 truncate text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">{interaction.queue_name||"Contact Center"}</div>
        <div className="truncate text-sm font-bold text-amber-700 dark:text-amber-300">{interaction.from_name||"Email customer"}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{interaction.attributes?.subject||"Email"}</div>
      </div><span className="shrink-0 rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">{incoming ? <IncomingLabel /> : ["ringing", "offered"].includes(interaction.state) ? "Offered" : interaction.state === "wrapup" ? "Wrap-up" : "Active"}</span></div></div>
    </div>
    <div className="flex items-center justify-between border-t border-amber-500/30 pt-2"><div className="flex items-center gap-1.5"><Clock className="size-3 text-amber-600"/><span className="font-mono text-xs font-semibold text-amber-700 dark:text-amber-300">{formatDuration(duration)}</span>{interaction.state!=="wrapup"&&<span className="text-xs text-amber-500">●</span>}</div><MessagingInteractionActions interaction={interaction} onChanged={onChanged}/></div>
  </InteractionCardFrame>;
  if (interaction.channel === "sms") return <InteractionCardFrame interaction={interaction} incoming={incoming} isSelected={isSelected} onSelect={onSelect} label={`SMS from ${interaction.from_name||interaction.customer_address||"Mobile customer"}`}
    className={cn("w-full rounded-lg border-2 bg-card p-2.5 text-left transition-all hover:shadow-lg",isSelected?"border-sky-500 shadow-lg ring-1 ring-sky-500/30":"border-sky-500/60 hover:border-sky-500")}
    >
    <div className="mb-2 flex items-start gap-2">
      <div className="relative shrink-0 rounded-lg bg-sky-500 p-2 text-white shadow-sm"><IconMessage className="size-4"/></div>
      <div className="min-w-0 flex-1"><div className="mb-1 flex items-start justify-between gap-2"><div className="min-w-0 flex-1">
        <div className="mb-0.5 truncate text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">{interaction.queue_name||"Contact Center"}</div>
        <div className="truncate text-sm font-bold text-sky-700 dark:text-sky-300">{interaction.from_name||interaction.customer_address||"Mobile customer"}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{interaction.attributes?.number_name?`SMS · ${interaction.attributes.number_name}`:interaction.attributes?.business_number?`SMS · ${interaction.attributes.business_number}`:"SMS"}</div>
      </div><span className="shrink-0 rounded border border-sky-500/25 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">{incoming ? <IncomingLabel /> : ["ringing", "offered"].includes(interaction.state) ? "Offered" : interaction.state === "wrapup" ? "Wrap-up" : "Active"}</span></div></div>
    </div>
    <div className="flex items-center justify-between border-t border-sky-500/30 pt-2"><div className="flex items-center gap-1.5"><Clock className="size-3 text-sky-600"/><span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300">{formatDuration(duration)}</span>{interaction.state!=="wrapup"&&<span className="text-xs text-sky-500">●</span>}</div><MessagingInteractionActions interaction={interaction} onChanged={onChanged}/></div>
  </InteractionCardFrame>;
  if (interaction.channel === "whatsapp") return <InteractionCardFrame interaction={interaction} incoming={incoming} isSelected={isSelected} onSelect={onSelect} label={`WhatsApp from ${interaction.from_name||interaction.customer_address||"WhatsApp customer"}`}
    className={cn("w-full rounded-lg border-2 bg-card p-2.5 text-left transition-all hover:shadow-lg",isSelected?"border-green-600 shadow-lg ring-1 ring-green-600/30":"border-green-600/60 hover:border-green-600")}
    >
    <div className="mb-2 flex items-start gap-2">
      <div className="relative shrink-0 rounded-lg bg-green-600 p-2 text-white shadow-sm"><IconBrandWhatsapp className="size-4"/></div>
      <div className="min-w-0 flex-1"><div className="mb-1 flex items-start justify-between gap-2"><div className="min-w-0 flex-1">
        <div className="mb-0.5 truncate text-[10px] font-semibold uppercase tracking-wide text-green-700 dark:text-green-300">{interaction.queue_name||"Contact Center"}</div>
        <div className="truncate text-sm font-bold text-green-700 dark:text-green-300">{interaction.from_name||interaction.customer_address||"WhatsApp customer"}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{interaction.attributes?.number_name?`WhatsApp · ${interaction.attributes.number_name}`:interaction.attributes?.business_number?`WhatsApp · ${interaction.attributes.business_number}`:"WhatsApp"}</div>
      </div><span className="shrink-0 rounded border border-green-600/25 bg-green-600/10 px-1.5 py-0.5 text-[10px] font-semibold text-green-700 dark:text-green-300">{incoming ? <IncomingLabel /> : ["ringing", "offered"].includes(interaction.state) ? "Offered" : interaction.state === "wrapup" ? "Wrap-up" : "Active"}</span></div></div>
    </div>
    <div className="flex items-center justify-between border-t border-green-600/30 pt-2"><div className="flex items-center gap-1.5"><Clock className="size-3 text-green-600"/><span className="font-mono text-xs font-semibold text-green-700 dark:text-green-300">{formatDuration(duration)}</span>{interaction.state!=="wrapup"&&<span className="text-xs text-green-600">●</span>}</div><MessagingInteractionActions interaction={interaction} onChanged={onChanged}/></div>
  </InteractionCardFrame>;
  if (interaction.channel === "video") return <InteractionCardFrame interaction={interaction} incoming={incoming} isSelected={isSelected} onSelect={onSelect} label={`Video call with ${interaction.from_name||"Website visitor"}`}
    className={cn("w-full rounded-lg border-2 bg-card p-2.5 text-left transition-all hover:shadow-lg",isSelected?"border-rose-500 shadow-lg ring-1 ring-rose-500/30":"border-rose-500/60 hover:border-rose-500")}
    >
    <div className="mb-2 flex items-start gap-2">
      <div className="relative shrink-0 rounded-lg bg-rose-500 p-2 text-white shadow-sm"><IconVideo className="size-4"/></div>
      <div className="min-w-0 flex-1"><div className="mb-1 flex items-start justify-between gap-2"><div className="min-w-0 flex-1">
        <div className="mb-0.5 truncate text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">{interaction.queue_name||"Contact Center"}</div>
        <div className="truncate text-sm font-bold text-rose-700 dark:text-rose-300">{interaction.from_name||"Website visitor"}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">Web video call</div>
      </div><span className="shrink-0 rounded border border-rose-500/25 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:text-rose-300">{incoming ? <IncomingLabel /> : ["ringing", "offered"].includes(interaction.state) ? "Offered" : interaction.state === "wrapup" ? "Wrap-up" : "Active"}</span></div></div>
    </div>
    <div className="flex items-center justify-between border-t border-rose-500/30 pt-2"><div className="flex items-center gap-1.5"><Clock className="size-3 text-rose-600"/><span className="font-mono text-xs font-semibold text-rose-700 dark:text-rose-300">{formatDuration(duration)}</span>{interaction.state!=="wrapup"&&<span className="text-xs text-rose-500">●</span>}</div><MessagingInteractionActions interaction={interaction} onChanged={onChanged}/></div>
  </InteractionCardFrame>;
  if (interaction.channel === "chat") return <InteractionCardFrame interaction={interaction} incoming={incoming} isSelected={isSelected} onSelect={onSelect} label={`Chat with ${interaction.from_name||"Website visitor"}`}
    className={cn("w-full rounded-lg border-2 bg-card p-2.5 text-left transition-all hover:shadow-lg",isSelected?"border-teal-500 shadow-lg ring-1 ring-teal-500/30":"border-teal-500/60 hover:border-teal-500")}
    >
    <div className="mb-2 flex items-start gap-2">
      <div className="relative shrink-0 rounded-lg bg-teal-500 p-2 text-white shadow-sm"><IconMessageCircle className="size-4"/>{interaction.attributes?.handoff&&<span className="absolute -right-1 -top-1 rounded-full bg-violet-500 p-0.5"><IconRobot className="size-3.5"/></span>}</div>
      <div className="min-w-0 flex-1"><div className="mb-1 flex items-start justify-between gap-2"><div className="min-w-0 flex-1">
        <div className="mb-0.5 truncate text-[10px] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-300">{interaction.queue_name||"Contact Center"}</div>
        <div className="truncate text-sm font-bold text-teal-700 dark:text-teal-300">{interaction.from_name||"Website visitor"}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{interaction.attributes?.handoff?"AI handoff · Web chat":"Web chat"}</div>
      </div><span className="shrink-0 rounded border border-teal-500/25 bg-teal-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-teal-700 dark:text-teal-300">{incoming ? <IncomingLabel /> : ["ringing", "offered"].includes(interaction.state) ? "Offered" : interaction.state === "wrapup" ? "Wrap-up" : "Active"}</span></div></div>
    </div>
    <div className="flex items-center justify-between border-t border-teal-500/30 pt-2"><div className="flex items-center gap-1.5"><Clock className="size-3 text-teal-600"/><span className="font-mono text-xs font-semibold text-teal-700 dark:text-teal-300">{formatDuration(duration)}</span>{interaction.state!=="wrapup"&&<span className="text-xs text-teal-500">●</span>}</div><MessagingInteractionActions interaction={interaction} onChanged={onChanged}/></div>
  </InteractionCardFrame>;

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
    interaction.from_number && interaction.from_number.trim() !== ""
      ? interaction.from_number
      : interaction.fromNumber && interaction.fromNumber.trim() !== ""
        ? interaction.fromNumber
        : interaction.from && interaction.from.trim() !== ""
          ? interaction.from
          : interaction.caller_number && interaction.caller_number.trim() !== ""
            ? interaction.caller_number
            : interaction.callerNumber && interaction.callerNumber.trim() !== ""
              ? interaction.callerNumber
              : null;

  // Fallback: try to extract from routing_metadata timeline if still missing
  if (!callerNumber && interaction.routing_metadata?.timeline) {
    const initiatedEvent = interaction.routing_metadata.timeline.find(
      (e) => e.type === "initiated" && e.from,
    );
    if (initiatedEvent?.from && initiatedEvent.from.trim() !== "") {
      callerNumber = initiatedEvent.from;
    }
  }

  const callerNumberLabel = callerNumber || "Unknown number";
  const callerNameLabel = callerName || null;

  // Check if this is an AI-transferred call
  // Handle both parsed metadata object and string metadata
  const metadata =
    typeof interaction.metadata === "string"
      ? (() => {
          try {
            return JSON.parse(interaction.metadata);
          } catch {
            return {};
          }
        })()
      : interaction.metadata || {};

  const isAiCall = !!(
    metadata?.ai_call_control_id || interaction.ai_call_control_id
  );

  return (
    <InteractionCardFrame interaction={interaction} incoming={incoming} isSelected={isSelected} onSelect={onSelect} label={`Voice call with ${callerNameLabel||callerNumberLabel}`}
      className={cn(
        "p-2.5 rounded-lg border-2 cursor-pointer transition-all hover:shadow-lg bg-card",
        isSelected
          ? "border-orange-500 shadow-lg ring-1 ring-orange-500/30"
          : isActive
            ? "border-orange-500/70 hover:border-orange-500 hover:shadow-md"
            : "border-border hover:border-muted-foreground/50",
      )}
    >
      <div className="flex items-start gap-2 mb-2">
        <div
          className={cn(
            "p-2 rounded-lg shrink-0 shadow-sm relative",
            isActive
              ? "bg-orange-500 text-white"
              : isEnded
                ? "bg-gray-400 text-gray-600"
                : "bg-orange-500 text-white",
          )}
        >
          <PhoneIncoming className="h-4 w-4" />
          {isAiCall && (
            <div className="absolute -top-1 -right-1 bg-violet-500 rounded-full p-0.5">
              <IconRobot className="h-3.5 w-3.5 text-white" />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-1">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <div className="text-[10px] font-semibold text-orange-600 uppercase tracking-wide">
                  {interaction.queue_name || "Contact Center"}
                </div>
              </div>
              <div className="font-bold text-sm text-orange-600 truncate">
                {callerNameLabel || callerNumberLabel}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 truncate">
                {callerNumberLabel}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <div className="pointer-events-auto relative z-10"><AiConversationSheet interaction={interaction} triggerClassName="h-6 w-6" iconClassName="h-4 w-4" stopPropagation/></div>
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
                {incoming ? <IncomingLabel /> : statusDisplay.text}
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
            <span className="text-orange-500 text-xs">●</span>
          )}
        </div>
        <VoiceInteractionActions interaction={interaction} callState={callState}/>
      </div>
    </InteractionCardFrame>
  );
}

export function InteractionsList({
  interactions,
  selectedId,
  onSelect,
  webrtcCallState,
  currentUsername,
  onChanged,
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 bg-muted/50 border-b rounded-t-lg">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-primary/10">
            <IconPhone className="h-4 w-4 text-primary" />
          </div>
          <h2 className="text-base font-semibold text-foreground">
            Interactions
          </h2>
        </div>
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <div className="p-3 space-y-3">
          {(() => {
            const filteredInteractions = interactions.filter((interaction) => {
              if (!interaction || !interaction.id) return false;

              // Filter out timeout re-enqueued interactions
              const metadata = interaction.metadata || {};
              const wasTimeoutReEnqueued =
                metadata.timeout_re_enqueued === true;

              // Also filter out interactions that are in "queued" state and have no agent_username
              // (they were re-enqueued after timeout)
              const isReEnqueued =
                interaction.state === "queued" &&
                !interaction.agent_username &&
                !interaction.agentUsername;

              if (wasTimeoutReEnqueued || isReEnqueued) {
                return false;
              }

              return true;
            });

            if (filteredInteractions.length === 0) {
              return (
                <div className="flex items-center justify-center w-full -mx-3 min-h-[200px]">
                  <div className="text-center text-muted-foreground text-sm">
                    <Phone className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>No interactions</p>
                  </div>
                </div>
              );
            }

            return filteredInteractions.map((interaction) => {
              // Get real-time WebRTC status if available
              const webrtcState = getWebRTCStatus(
                interaction,
                webrtcCallState,
              );
              return (
                <InteractionCard
                  key={interaction.id}
                  interaction={interaction}
                  isSelected={selectedId === interaction.id}
                  onSelect={onSelect}
                  webrtcState={webrtcState}
                  callState={webrtcCallState}
                  onChanged={onChanged}
                />
              );
            });
          })()}
        </div>
      </ScrollArea>
    </div>
  );
}
