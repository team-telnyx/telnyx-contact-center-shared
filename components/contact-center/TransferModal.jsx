"use client";

import { voiceFetch } from "@/lib/telephony/endpoint-client";
import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { notify } from "@/components/ToastNotify";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Phone,
  Users,
  UserCircle,
  CheckCircle2,
  UserCheck,
  Smartphone,
  Building2,
  Home,
  Network,
  Bot,
  Clock,
  PhoneCall,
  UsersRound,
  Loader2,
  PhoneOff,
  Mic,
  MicOff,
  Pause,
  Play,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTelnyx } from "@/components/telephony-provider";
import {
  STATUS_ICON_MAP,
  STATUS_NAME_ICON_FALLBACK,
  DEFAULT_STATUS_ICON,
} from "@/config/status-icons";
import useActiveCallStore, {
  useActiveCall,
  useCallUI,
  useCallStatus,
} from "@/lib/stores/active-call-store";
import { transferDirectory } from "@/lib/contact-center/transfer-directory.mjs";
import { useAuth } from "@/components/auth-provider";
import { createLatestRequestScope } from "@/lib/contact-center/latest-request";

// Prevent hydration mismatch by only rendering Select components after mount
function ClientOnlySelect({ children, ...props }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Client-only Radix Select must wait until hydration has completed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="border-input data-placeholder:text-muted-foreground flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs">
        <span className="text-muted-foreground">Loading...</span>
      </div>
    );
  }

  return <Select {...props}>{children}</Select>;
}

// Helper to format phone display - show "VoIP Call" for generated telephony names
function formatPhoneDisplay(number) {
  if (!number) return "Unknown";
  const str = String(number).trim();

  // If it's a SIP URI with a long generated name, show "VoIP Call"
  if (str.startsWith("sip:") || str.includes("@sip.") || str.includes("@")) {
    // Extract username from SIP URI
    const match = str.match(/^(?:sip:)?([^@]+)@/);
    if (match && match[1]) {
      const username = match[1];
      // If username is long and looks generated (alphanumeric), show VoIP Call
      if (username.length > 15 && /^[a-zA-Z0-9_-]+$/.test(username)) {
        return "VoIP Call";
      }
      // Otherwise show the username
      return username;
    }
    return "VoIP Call";
  }

  // If it's a long alphanumeric string (generated telephony username)
  if (str.length > 20 && /^[a-zA-Z0-9_-]+$/.test(str)) {
    return "VoIP Call";
  }

  // Regular phone number - return as is
  return str;
}

function getCoreIntentFailure(intent) {
  if (!intent) return null;
  const failed =
    intent.state === "failed" ||
    (intent.state === "cancelled" &&
      intent.error &&
      intent.error !== "intent.cancel");
  if (!failed) return null;
  return intent.error || "The consultant call could not be created";
}

function ConsultTopology({
  activeLeg,
  agentName,
  customer,
  consultant,
  onSwitch,
  disabled,
  connecting,
}) {
  const customerActive = activeLeg === "parked";
  const consultantActive = activeLeg === "consultant";
  const connectorClass = (active, side) =>
    cn(
      "pointer-events-none absolute top-1/2 h-[calc(50%+3rem)] w-8 border-t-2",
      side === "left"
        ? "right-full rounded-tl-xl border-l-2"
        : "left-full rounded-tr-xl border-r-2",
      active
        ? side === "left"
          ? "border-blue-500"
          : "border-green-500"
        : "border-dashed border-zinc-500",
    );
  const partyCard = (kind, party, active, color) => (
    <button
      type="button"
      data-testid={`consult-party-${kind}`}
      data-active={active ? "true" : "false"}
      onClick={() => onSwitch(kind)}
      disabled={disabled || active}
      className={cn(
        "relative z-10 min-w-0 rounded-xl border-2 p-3 text-left transition-all disabled:cursor-default",
        active
          ? color === "blue"
            ? "border-blue-500 bg-blue-500/20 shadow-[0_0_18px_rgba(59,130,246,0.22)]"
            : "border-green-500 bg-green-500/20 shadow-[0_0_18px_rgba(34,197,94,0.22)]"
          : "border-border bg-background/95 hover:bg-muted/70",
      )}
      title={active ? "Active conversation" : `Switch to ${party.label}`}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-full",
            color === "blue" ? "bg-blue-500/20 text-blue-500" : "bg-green-500/20 text-green-500",
          )}
        >
          {color === "blue" ? <Phone className="h-4 w-4" /> : <Users className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{party.label}</div>
          <div className="truncate text-xs text-muted-foreground">{party.detail}</div>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 text-[10px]",
            active
              ? color === "blue"
                ? "border-blue-500 text-blue-500"
                : "border-green-500 text-green-500"
              : "text-muted-foreground",
          )}
        >
          {active ? "ACTIVE" : kind === "consultant" && connecting ? "RINGING" : "ON HOLD"}
        </Badge>
      </div>
    </button>
  );

  return (
    <div className="relative rounded-xl border bg-muted/20 p-4">
      <div className="relative z-10 mx-auto flex w-fit min-w-[220px] items-center gap-3 rounded-xl border-2 border-violet-500 bg-violet-500/15 px-4 py-3">
        <span
          aria-hidden="true"
          data-testid="consult-connector-customer"
          className={connectorClass(customerActive, "left")}
        />
        <span
          aria-hidden="true"
          data-testid="consult-connector-consultant"
          className={connectorClass(consultantActive, "right")}
        />
        <div className="grid h-9 w-9 place-items-center rounded-full bg-violet-500/20 text-violet-500">
          <UserCircle className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-violet-500">Agent</div>
          <div className="max-w-[240px] truncate text-sm font-semibold">{agentName}</div>
        </div>
      </div>

      <div className="h-12" aria-hidden="true" />

      <div className="grid grid-cols-2 gap-3">
        {partyCard("parked", customer, customerActive, "blue")}
        {partyCard("consultant", consultant, consultantActive, "green")}
      </div>
      <p className="mt-3 text-center text-xs text-muted-foreground">
        The solid line shows which party is currently connected to the agent.
      </p>
    </div>
  );
}

export function TransferModal({
  open,
  onOpenChange,
  interaction: currentInteraction,
  onTransfer,
  onConsultCallCreated,
}) {
  // Other agents' live statistics need agents:read (RBAC Phase 5); one's own are always visible.
  const { can } = useAuth();
  const canReadAgents = can("agents:read");
  const { client } = useTelnyx();
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [selectionType, setSelectionType] = useState("queues"); // "queues", "agents", "contacts", "assistants", or "manual"

  // Call control hooks
  const activeCall = useActiveCall();
  const callUI = useCallUI();
  const callStatus = useCallStatus(); // Get call status from store root (not ui)
  const { clearActiveCall, setActiveCall, updateStatus, setMuted } =
    useActiveCallStore();

  // Queue state
  const [queues, setQueues] = useState([]);
  const [selectedQueueId, setSelectedQueueId] = useState("");
  const [queueStats, setQueueStats] = useState(null);
  const [queueStatsUnavailable, setQueueStatsUnavailable] = useState(false);
  const [sourceQueue, setSourceQueue] = useState(null);
  const [preserveRoutingOptions, setPreserveRoutingOptions] = useState(true);

  // Agent state
  const [agents, setAgents] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [agentStats, setAgentStats] = useState(null);
  const [selectedAgentNumber, setSelectedAgentNumber] = useState("");
  const [agentFullProfiles, setAgentFullProfiles] = useState(new Map()); // Map of userId -> full profile

  // Contact/Assistant state
  const [selectedRecordId, setSelectedRecordId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedAssistantId, setSelectedAssistantId] = useState("");
  const [selectedNumber, setSelectedNumber] = useState("");
  const [manualNumber, setManualNumber] = useState("");
  const [customers, setCustomers] = useState([]);
  const [patients, setPatients] = useState([]);
  const [registeredUsers, setRegisteredUsers] = useState([]);
  const [assistants, setAssistants] = useState([]);

  const [user, setUser] = useState(null);
  const [loadingData, setLoadingData] = useState(false);
  const [statuses, setStatuses] = useState([]); // Statuses from database

  // Consult state
  const [consultState, setConsultState] = useState({
    isActive: false,
    initiating: false, // Flag to indicate consult is being set up (prevents premature state reset)
    activatedAt: null, // Timestamp when isActive became true - used to prevent immediate reset
    activeLeg: "consultant", // Which leg is currently active: 'parked' or 'consultant'
    parkedCall: null, // { callControlId, fromNumber, fromName, interactionId }
    consultantCall: null, // { callControlId, toNumber, toName }
    agentCallControlId: null, // Agent's WebRTC call control ID
  });
  const [coreIntent, setCoreIntent] = useState(null);
  const [completeRequested, setCompleteRequested] = useState(false);
  const [closeRequested, setCloseRequested] = useState(false);
  const closeCancelInFlightRef = useRef(false);
  const cancelConsultForCloseRef = useRef(null);
  const coreIntentFailureNotifiedRef = useRef(null);
  const consultStartPendingRef = useRef(false);
  const currentConsultSagaIdRef = useRef(null);
  // Replacing the original WebRTC leg briefly clears the parent softphone's
  // interaction lookup. Retain the authoritative Core object for the lifetime
  // of the open modal so completion/cancellation still address the same work.
  const retainedInteractionRef = useRef(null);
  if (currentInteraction?.id) retainedInteractionRef.current = currentInteraction;
  const interaction = currentInteraction?.id
    ? currentInteraction
    : retainedInteractionRef.current;
  // Every supported voice call is represented by an ACD Core work item.
  const hasCoreInteraction = Boolean(interaction?.id);

  const postCoreIntent = async (action, options = {}) => {
    if (!interaction?.id) throw new Error("Missing Core ACD interaction ID");
    const res = await voiceFetch(
      `/api/contact-center/interactions/${encodeURIComponent(interaction.id)}/intents`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...options }),
      },
    );
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Core ACD intent failed");
    setCoreIntent(data.intent || null);
    return data.intent || null;
  };

  useEffect(() => {
    if (!hasCoreInteraction || !interaction?.id) return undefined;
    const applyIntent = (intent) => {
      if (!intent) return;
      if (intent.intent !== "consult") return;
      // Polling can finish with the previous consult intent while a new start
      // request is in flight. Do not briefly tear down and recreate the graph;
      // fence updates by the new saga generation instead.
      if (consultStartPendingRef.current) return;
      if (
        currentConsultSagaIdRef.current &&
        intent.sagaId &&
        String(intent.sagaId) !== String(currentConsultSagaIdRef.current)
      ) {
        return;
      }
      if (intent.sagaId) currentConsultSagaIdRef.current = intent.sagaId;
      setCoreIntent(intent);
      const consultCompleted =
        ["succeeded", "completed"].includes(intent.state || intent.status) ||
        intent.step === "monitor_transfer";
      if (consultCompleted || ["failed", "cancelled"].includes(intent.state)) {
        useActiveCallStore.getState().setConsultInProgress(false);
        const failure = getCoreIntentFailure(intent);
        const failureKey = `${intent.sagaId || "consult"}:${intent.state}:${intent.step}:${failure || ""}`;
        if (failure && coreIntentFailureNotifiedRef.current !== failureKey) {
          coreIntentFailureNotifiedRef.current = failureKey;
          notify({ title: "Consult failed", description: failure, variant: "error" });
        }
        setConsultState({
          isActive: false,
          initiating: false,
          activatedAt: null,
          activeLeg: "consultant",
          parkedCall: null,
          consultantCall: null,
          agentCallControlId: null,
        });
        setCompleteRequested(false);
        if (consultCompleted) onOpenChange(false);
        return;
      }
      const active =
        ["running", "compensating", "active"].includes(intent.state || intent.status) &&
        ![
          "release_source_agent",
          "route_initial_hold_before_browser",
          "start_initial_browser_hold_audio",
          "speak_initial_browser_hold_announcement",
          "await_browser_originator",
          "dial_target",
          "await_target",
          "await_target_bridge",
        ].includes(intent.step);
      if (active) {
        // The fresh browser leg is now bridged and owns the consultation.
        // Only at this point can ordinary terminal notifications clear it.
        useActiveCallStore.getState().setConsultInProgress(false);
      }
      setConsultState((prev) => ({
        ...prev,
        isActive: active,
        initiating: !active && ["running", "compensating"].includes(intent.state || intent.status),
        activatedAt: active ? prev.activatedAt || Date.now() : null,
        activeLeg:
          intent.activeLeg ||
          ([
            "release_source_agent",
            "route_initial_hold_before_browser",
            "start_initial_browser_hold_audio",
            "speak_initial_browser_hold_announcement",
            "await_browser_originator",
            "dial_target",
            "await_target",
            "await_target_bridge",
          ].includes(intent.step)
            ? "parked"
            : prev.activeLeg || "parked"),
        parkedCall: prev.parkedCall || {
          callControlId:
            interaction?.metadata?.original_call_control_id || interaction?.call_control_id,
          fromNumber: interaction?.from_number || null,
          fromName: interaction?.from_name || null,
          interactionId: interaction.id,
        },
        consultantCall: {
          callControlId: prev.consultantCall?.callControlId || null,
          toNumber: intent.target || prev.consultantCall?.toNumber || null,
          toName: intent.targetLabel || prev.consultantCall?.toName || null,
        },
        agentCallControlId:
          prev.agentCallControlId || interaction?.metadata?.agent_call_control_id || null,
      }));
    };
    const onIntent = (event) => {
      const detail = event.detail || {};
      if (String(detail.interactionId) !== String(interaction.id)) return;
      applyIntent({
        ...detail,
        intent: detail.intent,
        state: detail.status,
        status: detail.status,
      });
    };
    window.addEventListener("contact-center:acd-intent-updated", onIntent);
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await voiceFetch(
          `/api/contact-center/interactions/${encodeURIComponent(interaction.id)}/intents`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (!cancelled && data.ok) applyIntent(data.intent);
      } catch (_) {}
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("contact-center:acd-intent-updated", onIntent);
    };
  }, [
    hasCoreInteraction,
    interaction?.id,
    interaction?.call_control_id,
    interaction?.from_name,
    interaction?.from_number,
    interaction?.metadata?.agent_call_control_id,
    interaction?.metadata?.original_call_control_id,
    onOpenChange,
  ]);

  // Listen for parked call hangup events
  useEffect(() => {
    if (!consultState.isActive || !consultState.parkedCall?.callControlId) {
      return;
    }

    const parkedCallControlId = consultState.parkedCall.callControlId;

    // Handler for interaction ended events
    const handleInteractionEvent = async () => {
      // Check if parked call is still active by fetching interaction
      if (!consultState.parkedCall?.interactionId) return;

      try {
        const res = await voiceFetch(
          `/api/contact-center/interactions/${consultState.parkedCall.interactionId}`,
          { cache: "no-store" }
        );
        const data = await res.json();

        if (data.ok && data.interaction) {
          const state = data.interaction.state?.toLowerCase();
          if (["completed", "abandoned", "ended"].includes(state)) {
            console.log("[TransferModal] Parked call has ended, removing tile");
            setConsultState((prev) => ({
              ...prev,
              parkedCall: null, // Remove parked call tile
              activeLeg: "consultant", // Switch to consultant
            }));
          }
        }
      } catch (err) {
        console.error(
          "[TransferModal] Error checking parked call status:",
          err
        );
      }
    };

    // Listen for refresh events
    window.addEventListener(
      "contact-center:refresh-interactions",
      handleInteractionEvent
    );

    // Also poll periodically while consult is active
    const pollInterval = setInterval(handleInteractionEvent, 5000);

    return () => {
      window.removeEventListener(
        "contact-center:refresh-interactions",
        handleInteractionEvent
      );
      clearInterval(pollInterval);
    };
  }, [
    consultState.isActive,
    consultState.parkedCall?.callControlId,
    consultState.parkedCall?.interactionId,
  ]);

  // Refs for polling intervals
  const queueStatsIntervalRef = useRef(null);
  const queueStatsRequestsRef = useRef(createLatestRequestScope());
  const queueStatsInFlightRef = useRef(null);
  const agentStatsIntervalRef = useRef(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Load data when modal opens
  useEffect(() => {
    if (open) {
      loadData();
      // Reset selections when modal opens
      setSelectedQueueId("");
      setSelectedAgentId("");
      setSelectedAgentNumber("");
      setSelectedRecordId("");
      setSelectedUserId("");
      setSelectedAssistantId("");
      setSelectedNumber("");
      setManualNumber("");
      setSelectionType("queues");
      setQueueStats(null);
      setAgentStats(null);
      setPreserveRoutingOptions(true);
      setCoreIntent(null);
      setCompleteRequested(false);
      coreIntentFailureNotifiedRef.current = null;
      consultStartPendingRef.current = false;
      currentConsultSagaIdRef.current = null;
      setCloseRequested(false);
      closeCancelInFlightRef.current = false;
      // Reset consult state when modal opens (fresh start)
      setConsultState({
        isActive: false,
        activeLeg: "consultant",
        initiating: false,
        activatedAt: null,
        parkedCall: null,
        consultantCall: null,
        agentCallControlId: null,
      });

      // Load source queue info if interaction exists
      if (interaction?.queue_id) {
        loadSourceQueue(interaction.queue_id);
      } else if (interaction?.queueName) {
        // Try to find queue by name if queue_id is not available
        const queueByName = queues.find(
          (q) => q.name === interaction.queueName
        );
        if (queueByName) {
          setSourceQueue(queueByName);
        } else {
          setSourceQueue(null);
        }
      } else {
        setSourceQueue(null);
      }
    } else {
      // Clear intervals when modal closes
      if (queueStatsIntervalRef.current) {
        clearInterval(queueStatsIntervalRef.current);
        queueStatsIntervalRef.current = null;
      }
      if (agentStatsIntervalRef.current) {
        clearInterval(agentStatsIntervalRef.current);
        agentStatsIntervalRef.current = null;
      }
    }
  }, [open]);

  // Load queue stats when queue is selected
  useEffect(() => {
    const requests = queueStatsRequestsRef.current;
    setQueueStats(null);
    setQueueStatsUnavailable(false);
    if (open && selectedQueueId) {
      loadQueueStats(selectedQueueId);
      // Set up polling for queue stats
      if (queueStatsIntervalRef.current) {
        clearInterval(queueStatsIntervalRef.current);
      }
      queueStatsIntervalRef.current = setInterval(() => {
        loadQueueStats(selectedQueueId);
      }, 2000); // Update every 2 seconds
    } else {
      if (queueStatsIntervalRef.current) {
        clearInterval(queueStatsIntervalRef.current);
        queueStatsIntervalRef.current = null;
      }
    }

    return () => {
      requests.cancel();
      if (queueStatsIntervalRef.current) {
        clearInterval(queueStatsIntervalRef.current);
      }
    };
  }, [open, selectedQueueId]);

  // Load agent stats when agent is selected
  useEffect(() => {
    if (open && selectedAgentId && (canReadAgents || selectedAgentId === user?.id)) {
      loadAgentStats(selectedAgentId);
      // Set up polling for agent stats
      if (agentStatsIntervalRef.current) {
        clearInterval(agentStatsIntervalRef.current);
      }
      agentStatsIntervalRef.current = setInterval(() => {
        loadAgentStats(selectedAgentId);
      }, 2000); // Update every 2 seconds
    } else {
      if (agentStatsIntervalRef.current) {
        clearInterval(agentStatsIntervalRef.current);
        agentStatsIntervalRef.current = null;
      }
    }

    return () => {
      if (agentStatsIntervalRef.current) {
        clearInterval(agentStatsIntervalRef.current);
      }
    };
  }, [open, selectedAgentId, user]);

  const loadData = async () => {
    setLoadingData(true);
    try {
      // Get current user
      const userRes = await voiceFetch("/api/auth/me", { cache: "no-store" });
      const userData = await userRes.json();
      if (userData.isAuth && userData.user) {
        setUser(userData.user);
      }

      // Load queues
      const queuesRes = await voiceFetch("/api/contact-center/queues/list", {
        cache: "no-store",
      });
      const queuesData = await queuesRes.json();
      if (queuesData.queues) {
        setQueues(queuesData.queues);
      }

      // Load contacts for fallback and to get full user profiles with telephony_user_name
      const contactsRes = await voiceFetch("/api/user/contacts", {
        cache: "no-store",
      });
      const contactsData = await contactsRes.json();
      if (contactsData.ok) {
        setAgents(transferDirectory(contactsData.users, userData.user?.id));
        setCustomers(contactsData.customers || []);
        setPatients(contactsData.patients || []);
        setRegisteredUsers(contactsData.users || []);
        setAssistants(contactsData.assistants || []);

        // Build map of user profiles by ID for quick lookup
        const profileMap = new Map();
        (contactsData.users || []).forEach((user) => {
          profileMap.set(user.id, user);
        });
        setAgentFullProfiles(profileMap);
      }

      // Load statuses for status colors
      const statusesRes = await voiceFetch("/api/user/statuses", {
        cache: "no-store",
      });
      const statusesData = await statusesRes.json();
      if (statusesData.ok && statusesData.statuses) {
        setStatuses(statusesData.statuses);
      }
    } catch (err) {
      console.error("[TransferModal] Failed to load data:", err);
    } finally {
      setLoadingData(false);
    }
  };

  const loadQueueStats = async (queueId) => {
    // A slow current request must be allowed to finish before the next poll.
    // Selection changes cancel its scope, so the new queue starts immediately.
    if (queueStatsInFlightRef.current?.isCurrent()) return;
    const request = queueStatsRequestsRef.current.begin();
    queueStatsInFlightRef.current = request;
    try {
      const res = await voiceFetch(
        `/api/contact-center/stats/queues?queueId=${encodeURIComponent(
          queueId
        )}`,
        { cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) }
      );
      const data = await res.json();
      if (!request.isCurrent()) return;
      if (res.ok && data.stats) {
        setQueueStats(data.stats);
        setQueueStatsUnavailable(false);
      } else {
        setQueueStats(null);
        setQueueStatsUnavailable(true);
      }
    } catch (err) {
      if (!request.isCurrent()) return;
      setQueueStats(null);
      setQueueStatsUnavailable(true);
      console.error("[TransferModal] Failed to load queue stats:", err);
    } finally {
      if (queueStatsInFlightRef.current === request) queueStatsInFlightRef.current = null;
    }
  };

  const loadAgentStats = async (agentId) => {
    try {
      const res = await voiceFetch(
        `/api/contact-center/stats/agents?userId=${encodeURIComponent(
          agentId
        )}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (data.stats && data.stats.length > 0) {
        setAgentStats(data.stats[0]);
      }
    } catch (err) {
      console.error("[TransferModal] Failed to load agent stats:", err);
    }
  };

  const loadSourceQueue = async (queueId) => {
    try {
      // Wait for queues to be loaded first
      if (queues.length === 0) {
        // Queues not loaded yet, will be set when queues load
        return;
      }
      const queue = queues.find((q) => q.id === queueId);
      setSourceQueue(queue || null);
    } catch (err) {
      console.error("[TransferModal] Failed to load source queue:", err);
      setSourceQueue(null);
    }
  };

  // Update source queue when queues are loaded
  useEffect(() => {
    if (queues.length > 0 && interaction?.queue_id && !sourceQueue) {
      const queue = queues.find((q) => q.id === interaction.queue_id);
      if (queue) {
        setSourceQueue(queue);
      }
    }
  }, [queues, interaction?.queue_id]);

  // Helper functions for queue type badge (from EnqueueNodeEditor)
  const getQueueTypeBadgeColor = (routingStrategy) => {
    switch (routingStrategy) {
      case "FIFO":
        return "bg-blue-500";
      case "Skill-based":
        return "bg-purple-500";
      case "Priority-based":
        return "bg-orange-500";
      default:
        return "bg-gray-500";
    }
  };

  const getQueueTypeDisplayName = (routingStrategy) => {
    switch (routingStrategy) {
      case "FIFO":
        return "FIFO";
      case "Skill-based":
        return "SKILLS";
      case "Priority-based":
        return "PRIORITY";
      default:
        return routingStrategy || "FIFO";
    }
  };

  // Helper function to get status color from statuses table
  const getStatusColor = (statusName) => {
    if (!statusName || !statuses.length) {
      return null; // Return null to use fallback colors
    }
    const status = statuses.find(
      (s) => s.name === statusName || s.id === statusName.toLowerCase()
    );
    return status?.color || null;
  };

  // Get agent numbers (Softphone first, then mobile, then voice)
  const getAgentNumbers = (agentStats, fullUserProfile) => {
    const numbers = [];

    // Merge agent stats with full user profile to get telephony_user_name
    const telephonyUserName =
      fullUserProfile?.telephony_user_name ||
      agentStats?.telephonyUserName ||
      agentStats?.telephony_user_name;
    const mobile = fullUserProfile?.mobile || agentStats?.mobile;
    const voiceNumber =
      fullUserProfile?.voice_number ||
      agentStats?.voiceNumber ||
      agentStats?.voice_number;

    // First: Softphone (if telephony_user_name exists)
    if (telephonyUserName && String(telephonyUserName).trim() !== "") {
      numbers.push({
        value: `sip:${telephonyUserName}@sip.telnyx.com`,
        label: "Softphone (VoIP call)",
        type: "sip",
        icon: Network,
        iconColor: "text-cyan-500",
      });
    }

    // Second: Mobile
    if (mobile && String(mobile).trim() !== "") {
      numbers.push({
        value: String(mobile).trim(),
        label: "Mobile",
        type: "phone",
        icon: Smartphone,
        iconColor: "text-green-500",
      });
    }

    // Third: Voice Number
    if (voiceNumber && String(voiceNumber).trim() !== "") {
      numbers.push({
        value: String(voiceNumber).trim(),
        label: "Voice Number",
        type: "phone",
        icon: Phone,
        iconColor: "text-blue-500",
      });
    }

    return numbers;
  };

  const getDefaultAgentNumber = (agentStats, fullUserProfile) =>
    getAgentNumbers(agentStats, fullUserProfile).find(
      (number) => number.type === "sip"
    )?.value || "";

  const handleTransfer = async (
    target,
    type = "external",
    preserveRouting = false,
    targetLabel = null,
  ) => {
    const interactionId = interaction?.id;
    if (!interactionId) {
      notify({
        title: "Transfer unavailable",
        description: "This call is not attached to an ACD Core work item.",
        variant: "warning",
      });
      return;
    }

    const transferType = type || "external";
    const targetValue = target.trim();
    const targetAgent =
      selectionType === "agents"
        ? agents.find((item) => item.userId === selectedAgentId)
        : null;

    if (!targetValue) {
      notify({
        title: "Destination required",
        description: "Please select a transfer destination",
        variant: "warning",
      });
      return;
    }

    setLoading(true);
    try {
      if (transferType === "queue") {
        // The destination agent may answer immediately. Persist this segment
        // before enqueue so their workflow panel can hydrate the full
        // conversation instead of racing the source component's unmount save.
        await useActiveCallStore.getState().syncAgentAssistToDb();
      }

      const res = await voiceFetch(
        `/api/contact-center/interactions/${encodeURIComponent(interactionId)}/intents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: transferType === "queue" ? "queue_transfer" : "blind_transfer",
            target: targetValue,
            targetKind: selectionType,
            targetUserId:
              selectionType === "agents"
                ? targetAgent?.userId || selectedAgentId || null
                : null,
            targetUsername: targetAgent?.username || null,
            targetLabel: targetLabel || targetValue,
            preserveRoutingOptions: preserveRouting,
          }),
        },
      );
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Transfer failed");
      }

      useActiveCallStore.getState().recordTransfer({
        to: targetValue,
        type: transferType,
        callControlId:
          interaction?.metadata?.original_call_control_id ||
          interaction?.call_control_id ||
          null,
      });
      if (transferType === "queue") {
        window.dispatchEvent(
          new CustomEvent("contact-center:queue-transfer-accepted", {
            detail: {
              interactionId,
              callControlId:
                interaction?.metadata?.original_call_control_id ||
                interaction?.call_control_id ||
                null,
            },
          }),
        );
      }
      onOpenChange(false);
      onTransfer?.();
    } catch (err) {
      console.error("[TransferModal] Transfer error:", err);
      notify({
        title: "Transfer failed",
        description: err.message || "Unknown error",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = () => {
    let target = "";
    let targetLabel = "";
    let transferType = "external"; // Default to external transfer

    if (selectionType === "queues" && selectedQueueId) {
      // Transfer to queue - use queue ID
      target = selectedQueueId;
      const queue = queues.find((item) => item.id === selectedQueueId);
      targetLabel = queue?.display_name || queue?.name || selectedQueueId;
      transferType = "queue";
    } else if (
      selectionType === "agents" &&
      selectedAgentId &&
      selectedAgentNumber
    ) {
      target = selectedAgentNumber;
      const agent = agents.find((item) => item.userId === selectedAgentId);
      targetLabel =
        `${agent?.firstName || ""} ${agent?.lastName || ""}`.trim() ||
        agent?.username ||
        selectedAgentNumber;
      transferType = "external";
    } else if (
      selectionType === "contacts" &&
      selectedRecordId &&
      selectedNumber
    ) {
      target = selectedNumber;
      targetLabel =
        recordsWithNumbers.find((item) => item.id === selectedRecordId)
          ?.displayName || selectedNumber;
      transferType = "external";
    } else if (selectionType === "assistants" && selectedAssistantId) {
      target = `sip:user@${selectedAssistantId}.sip.telnyx.com`;
      targetLabel =
        assistants.find((item) => item.id === selectedAssistantId)?.name ||
        selectedAssistantId;
      transferType = "external";
    } else if (selectionType === "manual" && manualNumber.trim()) {
      target = manualNumber.trim();
      targetLabel = target;
      transferType = "external";
    }

    if (target) {
      handleTransfer(
        target,
        transferType,
        preserveRoutingOptions,
        targetLabel || target,
      );
    }
  };

  const handleConsult = async () => {
    let target = "";
    let targetLabel = "";

    if (selectionType === "queues" && selectedQueueId) {
      notify({
        title: "Consult unavailable",
        description: "Consult is only available for external transfers",
        variant: "warning",
      });
      return;
    }
    if (
      selectionType === "agents" &&
      selectedAgentId &&
      selectedAgentNumber
    ) {
      target = selectedAgentNumber;
      const agent = agents.find((item) => item.userId === selectedAgentId);
      targetLabel =
        `${agent?.firstName || ""} ${agent?.lastName || ""}`.trim() ||
        agent?.username ||
        selectedAgentNumber;
    } else if (
      selectionType === "contacts" &&
      selectedRecordId &&
      selectedNumber
    ) {
      target = selectedNumber;
      targetLabel =
        recordsWithNumbers.find((item) => item.id === selectedRecordId)
          ?.displayName || selectedNumber;
    } else if (selectionType === "assistants" && selectedAssistantId) {
      target = `sip:user@${selectedAssistantId}.sip.telnyx.com`;
      targetLabel =
        assistants.find((item) => item.id === selectedAssistantId)?.name ||
        selectedAssistantId;
    } else if (selectionType === "manual" && manualNumber.trim()) {
      target = manualNumber.trim();
      targetLabel = target;
    }

    if (!target) {
      notify({
        title: "Destination required",
        description: "Please select a consult destination",
        variant: "warning",
      });
      return;
    }
    if (!interaction?.id) {
      notify({
        title: "Consult unavailable",
        description: "This call is not attached to an ACD Core work item.",
        variant: "warning",
      });
      return;
    }

    if (!client) {
      notify({
        title: "Consult unavailable",
        description: "The WebRTC phone is not connected.",
        variant: "warning",
      });
      return;
    }

    // Fence the normal call-end handler before Core releases the original
    // WebRTC leg. The consult replaces it with a fresh browser-originated leg.
    useActiveCallStore.getState().setConsultInProgress(true);
    consultStartPendingRef.current = true;
    currentConsultSagaIdRef.current = null;
    setConsultState({
      isActive: false,
      initiating: true,
      activatedAt: null,
      activeLeg: "parked",
      parkedCall: {
        callControlId:
          interaction?.metadata?.original_call_control_id ||
          interaction?.call_control_id,
        fromNumber: interaction?.from_number || null,
        fromName: interaction?.from_name || null,
        interactionId: interaction.id,
      },
      consultantCall: {
        callControlId: null,
        toNumber: target.trim(),
        toName: targetLabel || null,
      },
      agentCallControlId:
        interaction?.metadata?.agent_call_control_id || null,
    });

    setLoading(true);
    try {
      const selectedAgent =
        selectionType === "agents"
          ? agents.find((item) => item.userId === selectedAgentId)
          : null;
      const intent = await postCoreIntent("consult_start", {
        target: target.trim(),
        targetKind: selectionType,
        targetUserId: selectedAgent?.userId || null,
        targetUsername: selectedAgent?.username || null,
        targetLabel: targetLabel || target.trim(),
      });
      currentConsultSagaIdRef.current = intent?.sagaId || null;
      consultStartPendingRef.current = false;

      const failure = getCoreIntentFailure(intent);
      if (failure) {
        coreIntentFailureNotifiedRef.current =
          `${intent.sagaId || "consult"}:${intent.state}:${intent.step}:${failure}`;
        throw new Error(failure);
      }

      if (!intent?.browserCall?.customHeaders?.length) {
        throw new Error(
          "Core did not prepare the browser consultation call",
        );
      }

      try {
        client.enableMicrophone?.();
      } catch (_) {}

      const consultCall = client.newCall({
        customHeaders: intent.browserCall.customHeaders,
        destinationNumber:
          intent.browserCall.destinationNumber || target.trim(),
        callerNumber: intent.browserCall.callerNumber || undefined,
        audio: true,
        video: false,
      });
      setActiveCall(consultCall, {
        direction: "outbound",
        fromNumber: intent.browserCall.callerNumber || null,
        toNumber: intent.browserCall.destinationNumber || target.trim(),
        interactionId: interaction.id,
      });
      onConsultCallCreated?.(consultCall);
      updateStatus(consultCall.state || "trying");

      setConsultState((previous) => ({
        ...previous,
        isActive: intent?.step === "in_consult",
        initiating: intent?.step !== "in_consult",
        activatedAt: intent?.step === "in_consult" ? Date.now() : null,
        activeLeg: intent?.activeLeg || "parked",
        agentCallControlId:
          consultCall.callControlId ||
          consultCall.call_control_id ||
          consultCall.id ||
          null,
      }));
    } catch (err) {
      useActiveCallStore.getState().setConsultInProgress(false);
      if (currentConsultSagaIdRef.current) {
        void postCoreIntent("consult_cancel").catch((cancelError) =>
          console.error(
            "[TransferModal] Failed to cancel browser consultation:",
            cancelError,
          ),
        );
      }
      currentConsultSagaIdRef.current = null;
      setConsultState({
        isActive: false,
        initiating: false,
        activatedAt: null,
        activeLeg: "consultant",
        parkedCall: null,
        consultantCall: null,
        agentCallControlId: null,
      });
      notify({
        title: "Consult failed",
        description: err.message || "Unknown error",
        variant: "error",
      });
    } finally {
      consultStartPendingRef.current = false;
      setLoading(false);
    }
  };

  const handleSwitchCallLeg = async (targetLegType) => {
    if (!interaction?.id) {
      notify({
        title: "Cannot switch call leg",
        description: "This call is not attached to an ACD Core work item.",
        variant: "warning",
      });
      return;
    }

    setLoading(true);
    try {
      await postCoreIntent(
        targetLegType === "parked"
          ? "consult_switch_customer"
          : "consult_switch_consultant",
      );
      setConsultState((previous) => ({
        ...previous,
        activeLeg: targetLegType,
      }));
    } catch (err) {
      console.error("[TransferModal] Switch call leg error:", err);
      notify({
        title: "Switch call leg failed",
        description: err.message || "Unknown error",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnectCall = async () => {
    if (consultState.isActive || consultState.initiating) {
      if (!interaction?.id) {
        notify({
          title: "Cancel consult failed",
          description: "This call is not attached to an ACD Core work item.",
          variant: "error",
        });
        return false;
      }
      setLoading(true);
      try {
        await postCoreIntent("consult_cancel");
        return true;
      } catch (err) {
        notify({
          title: "Cancel consult failed",
          description: err.message,
          variant: "error",
        });
        return false;
      } finally {
        setLoading(false);
      }
    }

    try {
      activeCall?.hangup?.();
    } catch (err) {
      console.error("[TransferModal] Error disconnecting call:", err);
    } finally {
      clearActiveCall();
      setConsultState({
        isActive: false,
        activeLeg: "consultant",
        initiating: false,
        activatedAt: null,
        parkedCall: null,
        consultantCall: null,
        agentCallControlId: null,
      });
    }
    return true;
  };

  // Keep the latest cancellation handler available to the close-request
  // effect without retriggering that effect on every render.
  cancelConsultForCloseRef.current = handleDisconnectCall;

  const handleCompleteConsult = async () => {
    if (!hasCoreInteraction) return;
    setCompleteRequested(true);
    setLoading(true);
    try {
      const intent = await postCoreIntent("consult_complete");
      if (
        ["succeeded", "completed"].includes(intent?.state || intent?.status) ||
        intent?.step === "monitor_transfer"
      ) {
        onOpenChange(false);
      }
    } catch (err) {
      setCompleteRequested(false);
      notify({ title: "Complete transfer failed", description: err.message, variant: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleToggleMute = () => {
    if (!activeCall) return;
    try {
      if (callUI.isMuted) {
        activeCall.unmuteAudio?.() || activeCall.unmute?.();
        setMuted(false);
      } else {
        activeCall.muteAudio?.() || activeCall.mute?.();
        setMuted(true);
      }
    } catch (err) {
      console.error("[TransferModal] Toggle mute error:", err);
    }
  };

  const handleToggleHold = () => {
    if (!activeCall) return;
    try {
      const { updateStatus } = useActiveCallStore.getState();
      if (callUI.isHeld) {
        activeCall.unhold?.() || activeCall.resume?.();
        updateStatus("active");
        void postCoreIntent("unhold", { requestId: crypto.randomUUID() }).catch((err) =>
          console.error("[TransferModal] Core unhold intent failed:", err),
        );
      } else {
        activeCall.hold?.() || activeCall.pause?.();
        updateStatus("held");
        void postCoreIntent("hold", { requestId: crypto.randomUUID() }).catch((err) =>
          console.error("[TransferModal] Core hold intent failed:", err),
        );
      }
    } catch (err) {
      console.error("[TransferModal] Toggle hold error:", err);
    }
  };

  // Check if call is active (not ended/hungup)
  // Get effective call status - prefer store status, fallback to call object state
  const getEffectiveCallStatus = () => {
    return callStatus || activeCall?.state || "";
  };

  const isCallConnected = () => {
    if (!activeCall) return false;
    const status = getEffectiveCallStatus();
    const lowerStatus = String(status).toLowerCase();
    return ["active", "connected", "answered", "held"].includes(lowerStatus);
  };

  const handleModalOpenChange = (newOpen) => {
    if (newOpen) {
      onOpenChange(true);
      return;
    }

    if (consultState.isActive || consultState.initiating) {
      // Queue a safe consult cancellation. The effect below waits out any
      // short bridge transition, submits consult_cancel, then closes the UI.
      setCloseRequested(true);
      return;
    }

    onOpenChange(false);
  };

  const isValid = () => {
    if (selectionType === "queues") {
      return !!selectedQueueId;
    } else if (selectionType === "agents") {
      return selectedAgentId && selectedAgentNumber;
    } else if (selectionType === "contacts") {
      return selectedRecordId && selectedNumber;
    } else if (selectionType === "assistants") {
      return selectedAssistantId;
    } else if (selectionType === "manual") {
      const v = manualNumber.trim();
      return v && (v.startsWith("+") || v.startsWith("sip:"));
    }
    return false;
  };

  // Extract phone numbers from contact/patient record
  const extractPhoneNumbers = (record) => {
    const numbers = [];
    const phoneFields = [
      { key: "phone", label: "Phone", icon: Phone, color: "text-blue-500" },
      {
        key: "mobile",
        label: "Mobile",
        icon: Smartphone,
        color: "text-green-500",
      },
      {
        key: "business_phone_1",
        label: "Business Phone 1",
        icon: Building2,
        color: "text-purple-500",
      },
      {
        key: "business_phone_2",
        label: "Business Phone 2",
        icon: Building2,
        color: "text-purple-500",
      },
      {
        key: "home_phone_1",
        label: "Home Phone 1",
        icon: Home,
        color: "text-orange-500",
      },
      {
        key: "home_phone_2",
        label: "Home Phone 2",
        icon: Home,
        color: "text-orange-500",
      },
      {
        key: "sip_uri",
        label: "SIP URI",
        icon: Network,
        color: "text-cyan-500",
      },
    ];

    for (const field of phoneFields) {
      const value = record[field.key];
      if (value && String(value).trim() !== "") {
        numbers.push({
          value: String(value).trim(),
          label: field.label,
          type: field.key === "sip_uri" ? "sip" : "phone",
          icon: field.icon,
          iconColor: field.color,
        });
      }
    }

    return numbers;
  };

  const recordsWithNumbers = [
    ...customers.map((c) => ({
      ...c,
      recordType: "customer",
      numbers: extractPhoneNumbers(c),
      displayName:
        `${c.first_name || ""} ${c.last_name || ""}`.trim() ||
        c.customer_id ||
        "Unknown Customer",
    })),
    ...patients.map((p) => ({
      ...p,
      recordType: "patient",
      numbers: extractPhoneNumbers(p),
      displayName:
        `${p.first_name || ""} ${p.last_name || ""}`.trim() ||
        p.patient_id ||
        "Unknown Patient",
    })),
  ].filter((r) => r.numbers.length > 0);

  const selectedRecord = recordsWithNumbers.find(
    (r) => r.id === selectedRecordId
  );
  const availableNumbers = selectedRecord?.numbers || [];

  const selectedUser = registeredUsers.find((u) => u.id === selectedUserId);
  const userNumbers = [];
  if (selectedUser) {
    if (
      selectedUser.voice_number &&
      String(selectedUser.voice_number).trim() !== ""
    ) {
      userNumbers.push({
        value: String(selectedUser.voice_number).trim(),
        label: "Voice Number",
        type: "phone",
        icon: Phone,
        iconColor: "text-blue-500",
      });
    }
    if (selectedUser.mobile && String(selectedUser.mobile).trim() !== "") {
      userNumbers.push({
        value: String(selectedUser.mobile).trim(),
        label: "Mobile",
        type: "phone",
        icon: Smartphone,
        iconColor: "text-green-500",
      });
    }
  }

  const selectedAgent = agents.find((a) => a.userId === selectedAgentId);
  const selectedAgentFullProfile = agentFullProfiles.get(selectedAgentId);
  const currentAgentName =
    `${user?.first_name || user?.firstName || ""} ${
      user?.last_name || user?.lastName || ""
    }`.trim() ||
    user?.name ||
    user?.username ||
    interaction?.agent_name ||
    interaction?.agent_username ||
    "Agent";
  const coreConsultTransitioning =
    hasCoreInteraction && coreIntent?.intent === "consult" && coreIntent?.step !== "in_consult";
  const coreConsultCanCancel =
    !hasCoreInteraction ||
    [
      "await_target",
      "bridge_initial_consultant",
      "route_initial_hold_audio",
      "start_initial_hold_audio",
      "verify_initial_consult_bridge",
      "await_initial_consult_bridge",
      "protect_initial_consultant",
      "in_consult",
      "stop_hold_before_customer_switch",
      "bridge_customer",
      "bridge_consultant",
      "route_switched_hold_audio",
      "start_switched_hold_audio",
      "verify_switched_consult_bridge",
      "await_switched_consult_bridge",
    ].includes(coreIntent?.step);
  const agentNumbers = selectedAgent
    ? getAgentNumbers(selectedAgent, selectedAgentFullProfile)
    : [];

  useEffect(() => {
    if (!closeRequested) return;

    const consultOpen = consultState.isActive || consultState.initiating;
    if (!consultOpen) {
      setCloseRequested(false);
      onOpenChange(false);
      return;
    }

    if (loading || closeCancelInFlightRef.current) return;
    if (hasCoreInteraction && !coreConsultCanCancel) return;

    const cancelConsult = cancelConsultForCloseRef.current;
    if (!cancelConsult) return;

    closeCancelInFlightRef.current = true;
    Promise.resolve(cancelConsult())
      .then((accepted) => {
        if (accepted === false) {
          setCloseRequested(false);
          return;
        }
        // The Core endpoint has durably accepted cancellation. Its saga can
        // finish restoring the customer after the modal is no longer visible.
        setCloseRequested(false);
        onOpenChange(false);
      })
      .finally(() => {
        closeCancelInFlightRef.current = false;
      });
  }, [
    closeRequested,
    consultState.isActive,
    consultState.initiating,
    coreConsultCanCancel,
    hasCoreInteraction,
    loading,
    onOpenChange,
  ]);

  if (!mounted) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={handleModalOpenChange}>
      <DialogContent className="sm:max-w-[700px] dark:bg-zinc-900 max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Transfer Call</DialogTitle>
          <DialogDescription>
            Choose where to transfer this call{interaction?.from_name||interaction?.from_number?` from ${interaction.from_name||interaction.from_number}`:""}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Selection Type Tiles */}
          <div className="grid grid-cols-5 gap-2">
            <button
              type="button"
              data-testid="transfer-kind-queues" onClick={() => setSelectionType("queues")}
              className={cn(
                "flex flex-col items-center gap-2 rounded-lg border-2 bg-background p-3 text-foreground transition-all hover:bg-muted/60",
                selectionType === "queues"
                  ? "border-blue-500 ring-1 ring-blue-500/40"
                  : "border-border"
              )}
            >
              <UsersRound className="h-5 w-5 text-blue-500" />
              <div className="font-semibold text-xs">Queues</div>
              {selectionType === "queues" && (
                <CheckCircle2 className="h-3 w-3 text-blue-500" />
              )}
            </button>

            <button
              type="button"
              data-testid="transfer-kind-agents" onClick={() => setSelectionType("agents")}
              className={cn(
                "flex flex-col items-center gap-2 rounded-lg border-2 bg-background p-3 text-foreground transition-all hover:bg-muted/60",
                selectionType === "agents"
                  ? "border-purple-500 ring-1 ring-purple-500/40"
                  : "border-border"
              )}
            >
              <UserCheck className="h-5 w-5 text-purple-500" />
              <div className="font-semibold text-xs">Users</div>
              {selectionType === "agents" && (
                <CheckCircle2 className="h-3 w-3 text-purple-500" />
              )}
            </button>

            <button
              type="button"
              data-testid="transfer-kind-contacts" onClick={() => setSelectionType("contacts")}
              className={cn(
                "flex flex-col items-center gap-2 rounded-lg border-2 bg-background p-3 text-foreground transition-all hover:bg-muted/60",
                selectionType === "contacts"
                  ? "border-green-500 ring-1 ring-green-500/40"
                  : "border-border"
              )}
            >
              <Users className="h-5 w-5 text-green-500" />
              <div className="font-semibold text-xs">Contacts</div>
              {selectionType === "contacts" && (
                <CheckCircle2 className="h-3 w-3 text-green-500" />
              )}
            </button>

            <button
              type="button"
              data-testid="transfer-kind-assistants" onClick={() => setSelectionType("assistants")}
              className={cn(
                "flex flex-col items-center gap-2 rounded-lg border-2 bg-background p-3 text-foreground transition-all hover:bg-muted/60",
                selectionType === "assistants"
                  ? "border-indigo-500 ring-1 ring-indigo-500/40"
                  : "border-border"
              )}
            >
              <Bot className="h-5 w-5 text-indigo-500" />
              <div className="font-semibold text-xs">AI Agents</div>
              {selectionType === "assistants" && (
                <CheckCircle2 className="h-3 w-3 text-indigo-500" />
              )}
            </button>

            <button
              type="button"
              data-testid="transfer-kind-manual" onClick={() => setSelectionType("manual")}
              className={cn(
                "flex flex-col items-center gap-2 rounded-lg border-2 bg-background p-3 text-foreground transition-all hover:bg-muted/60",
                selectionType === "manual"
                  ? "border-orange-500 ring-1 ring-orange-500/40"
                  : "border-border"
              )}
            >
              <Phone className="h-5 w-5 text-orange-500" />
              <div className="font-semibold text-xs">Manual</div>
              {selectionType === "manual" && (
                <CheckCircle2 className="h-3 w-3 text-orange-500" />
              )}
            </button>
          </div>

          {/* Queues Selection */}
          {selectionType === "queues" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-semibold flex items-center gap-2">
                  <UsersRound className="h-4 w-4 text-blue-600" />
                  Select Queue
                </Label>
                {loadingData ? (
                  <div className="text-sm text-muted-foreground flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading queues...
                  </div>
                ) : queues.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No queues available
                  </div>
                ) : (
                  <ClientOnlySelect
                    value={selectedQueueId}
                    onValueChange={setSelectedQueueId}
                  >
                    <SelectTrigger
                      className="w-full"
                      data-testid="transfer-assistant-select"
                    >
                      <SelectValue data-testid="transfer-queue-select" placeholder="Choose a queue" />
                    </SelectTrigger>
                    <SelectContent>
                      {queues.map((queue) => (
                        <SelectItem data-testid="transfer-queue-option" data-queue-id={queue.id} key={queue.id} value={queue.id}>
                          <div className="flex items-center gap-2">
                            <UsersRound className="h-4 w-4 text-blue-500" />
                            <span className="font-medium">
                              {queue.display_name || queue.name}
                            </span>
                            <Badge
                              className={cn(
                                "text-xs",
                                getQueueTypeBadgeColor(queue.routing_strategy)
                              )}
                            >
                              {getQueueTypeDisplayName(queue.routing_strategy)}
                            </Badge>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </ClientOnlySelect>
                )}
              </div>

              {selectedQueueId && (
                <div className="space-y-3 p-4 bg-muted rounded-lg">
                  {queueStats ? (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label className="text-xs text-muted-foreground">
                            Available Agents
                          </Label>
                          <div className="text-sm font-medium text-green-600">
                            {queueStats.agents?.available || 0}
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">
                            Busy Agents
                          </Label>
                          <div className="text-sm font-medium text-orange-600">
                            {queueStats.agents?.busy || 0}
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">
                            Calls Awaiting
                          </Label>
                          <div className="text-sm font-medium text-yellow-600">
                            {queueStats.realtime?.waitingCalls || 0}
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Expected Wait Time
                          </Label>
                          <div className="text-sm font-medium">
                            {queueStats.realtime?.longestWaitSeconds
                              ? `${Math.round(
                                  queueStats.realtime.longestWaitSeconds
                                )}s`
                              : "—"}
                          </div>
                        </div>
                      </div>


                    </>
                  ) : queueStatsUnavailable ? (
                    <div className="text-sm text-muted-foreground">
                      Queue statistics are unavailable.
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading queue statistics...
                    </div>
                  )}

                  {/* Preserve Routing Options Toggle */}
                  {(() => {
                    const targetQueue = queues.find(
                      (q) => q.id === selectedQueueId
                    );
                    if (!targetQueue || !sourceQueue) return null;

                    const sourceRouting =
                      sourceQueue.routing_strategy || "FIFO";
                    const targetRouting =
                      targetQueue.routing_strategy || "FIFO";
                    const hasSkills =
                      interaction?.required_skills &&
                      typeof interaction.required_skills === "object" &&
                      Object.keys(interaction.required_skills).length > 0;

                    // Determine toggle label
                    let toggleLabel = "Preserve priority";
                    let toggleDescription = "";

                    if (
                      sourceRouting === "Skill-based" &&
                      targetRouting === "Skill-based" &&
                      hasSkills
                    ) {
                      toggleLabel = "Preserve priority and skills";
                      toggleDescription =
                        "Will preserve call priority and required skills when transferring";
                    } else if (
                      sourceRouting === "FIFO" ||
                      sourceRouting === "Priority-based" ||
                      targetRouting === "FIFO" ||
                      targetRouting === "Priority-based"
                    ) {
                      toggleLabel = "Preserve priority";
                      toggleDescription =
                        "Will preserve call priority when transferring";
                    } else {
                      // Both are skills-based but no skills assigned
                      toggleLabel = "Preserve priority";
                      toggleDescription =
                        "Will preserve call priority when transferring";
                    }

                    return (
                      <div className="flex items-center justify-end gap-2 pt-3 border-t mt-3">
                        <div className="flex flex-col items-end gap-1">
                          <Label
                            className="text-xs font-medium cursor-pointer"
                            htmlFor="preserve-routing"
                          >
                            {toggleLabel}
                          </Label>
                          {toggleDescription && (
                            <span className="text-xs text-muted-foreground">
                              {toggleDescription}
                            </span>
                          )}
                        </div>
                        <Switch
                          id="preserve-routing"
                          checked={preserveRoutingOptions}
                          onCheckedChange={setPreserveRoutingOptions}
                        />
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Agents Selection */}
          {selectionType === "agents" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-semibold flex items-center gap-2">
                  <UserCheck className="h-4 w-4 text-purple-600" />
                  Select User
                </Label>
                {loadingData ? (
                  <div className="text-sm text-muted-foreground flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading users...
                  </div>
                ) : agents.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No users found
                  </div>
                ) : (
                  <ClientOnlySelect
                    value={selectedAgentId}
                    onValueChange={(value) => {
                      const nextAgent = agents.find(
                        (agent) => agent.userId === value
                      );
                      setSelectedAgentId(value);
                      setSelectedAgentNumber(
                        getDefaultAgentNumber(
                          nextAgent,
                          agentFullProfiles.get(value)
                        )
                      );
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue data-testid="transfer-agent-select" placeholder="Choose a user" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => {
                        const displayName =
                          `${agent.firstName || ""} ${
                            agent.lastName || ""
                          }`.trim() ||
                          agent.username ||
                          "Unknown Agent";
                        // Get status icon
                        const StatusIcon =
                          STATUS_NAME_ICON_FALLBACK[agent.status] ||
                          STATUS_ICON_MAP[DEFAULT_STATUS_ICON];
                        // Get status color from database, fallback to hardcoded colors
                        const statusColorHex = getStatusColor(agent.status);
                        const statusColorClass = !statusColorHex
                          ? agent.status === "Available"
                            ? "text-green-600"
                            : agent.status === "Busy"
                            ? "text-orange-600"
                            : agent.status === "Away"
                            ? "text-yellow-600"
                            : "text-gray-600"
                          : null;
                        return (
                          <SelectItem data-testid="transfer-agent-option" data-agent-id={agent.userId} key={agent.userId} value={agent.userId}>
                            <div className="flex items-center gap-2">
                              <StatusIcon
                                className={cn("h-4 w-4", statusColorClass)}
                                style={
                                  statusColorHex
                                    ? { color: statusColorHex }
                                    : undefined
                                }
                              />
                              <span className="font-medium">{displayName}</span>
                              <span
                                className={cn("text-xs", statusColorClass)}
                                style={
                                  statusColorHex
                                    ? { color: statusColorHex }
                                    : undefined
                                }
                              >
                                ({agent.status})
                              </span>
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </ClientOnlySelect>
                )}
              </div>

              {/* Select Number - moved ABOVE agent stats */}
              {selectedAgent && agentNumbers.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-sm font-semibold flex items-center gap-2">
                    <Phone className="h-4 w-4 text-green-600" />
                    Select Number
                  </Label>
                  <ClientOnlySelect
                    value={selectedAgentNumber}
                    onValueChange={setSelectedAgentNumber}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a number" />
                    </SelectTrigger>
                    <SelectContent>
                      {agentNumbers.map((num, idx) => {
                        const IconComponent = num.icon || Phone;
                        return (
                          <SelectItem key={idx} value={num.value}>
                            <div className="flex items-center gap-2">
                              <IconComponent
                                className={cn(
                                  "h-4 w-4",
                                  num.iconColor || "text-gray-500"
                                )}
                              />
                              <span className="font-medium">
                                {num.type === "sip" ? num.label : num.value}
                              </span>
                              {num.type !== "sip" && (
                                <span className="text-xs text-muted-foreground">
                                  ({num.label})
                                </span>
                              )}
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </ClientOnlySelect>
                </div>
              )}

              {/* Agent stats - single line layout */}
              {selectedAgent && (canReadAgents || selectedAgentId === user?.id) && (
                <div className="p-3 bg-muted rounded-lg">
                  {agentStats ? (
                    <div className="flex items-center justify-between gap-4">
                      {/* Status - label and value in one line */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          Status:
                        </span>
                        {(() => {
                          const StatusIcon =
                            STATUS_NAME_ICON_FALLBACK[agentStats.status] ||
                            STATUS_ICON_MAP[DEFAULT_STATUS_ICON];
                          const statusColorHex = getStatusColor(
                            agentStats.status
                          );
                          const statusColorClass = !statusColorHex
                            ? agentStats.status === "Available"
                              ? "text-green-600"
                              : agentStats.status === "Busy"
                              ? "text-orange-600"
                              : agentStats.status === "Away"
                              ? "text-yellow-600"
                              : "text-gray-600"
                            : null;
                          return (
                            <>
                              <StatusIcon
                                className={cn("h-4 w-4", statusColorClass)}
                                style={
                                  statusColorHex
                                    ? { color: statusColorHex }
                                    : undefined
                                }
                              />
                              <span
                                className={cn(
                                  "text-sm font-medium",
                                  statusColorClass
                                )}
                                style={
                                  statusColorHex
                                    ? { color: statusColorHex }
                                    : undefined
                                }
                              >
                                {agentStats.status || "Unknown"}
                              </span>
                            </>
                          );
                        })()}
                      </div>
                      {/* On Call - label and value in one line */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          On Call:
                        </span>
                        {(() => {
                          const currentCallsCount =
                            typeof agentStats.currentCalls === "number"
                              ? agentStats.currentCalls
                              : agentStats.currentCalls?.length || 0;
                          const isOnCall = currentCallsCount > 0;
                          return (
                            <Badge
                              className={cn(
                                "text-xs",
                                isOnCall
                                  ? "bg-green-500 text-white"
                                  : "bg-gray-500 text-white"
                              )}
                            >
                              {isOnCall ? "Yes" : "No"}
                            </Badge>
                          );
                        })()}
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading...
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Contacts Selection (fallback) */}
          {selectionType === "contacts" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-semibold flex items-center gap-2">
                  <Users className="h-4 w-4 text-green-600" />
                  Select Contact
                </Label>
                {loadingData ? (
                  <div className="text-sm text-muted-foreground">
                    Loading contacts...
                  </div>
                ) : recordsWithNumbers.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No contacts with phone numbers found
                  </div>
                ) : (
                  <ClientOnlySelect
                    value={selectedRecordId}
                    onValueChange={setSelectedRecordId}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a contact" />
                    </SelectTrigger>
                    <SelectContent>
                      {recordsWithNumbers.map((record) => (
                        <SelectItem key={record.id} value={record.id}>
                          <div className="flex items-center gap-2">
                            <UserCircle className="h-4 w-4 text-blue-500" />
                            <span className="font-medium">
                              {record.displayName}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </ClientOnlySelect>
                )}
              </div>

              {selectedRecord && availableNumbers.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-sm font-semibold flex items-center gap-2">
                    <Phone className="h-4 w-4 text-green-600" />
                    Select Number
                  </Label>
                  <ClientOnlySelect
                    value={selectedNumber}
                    onValueChange={setSelectedNumber}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a number" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableNumbers.map((num, idx) => {
                        const IconComponent = num.icon || Phone;
                        return (
                          <SelectItem key={idx} value={num.value}>
                            <div className="flex items-center gap-2">
                              <IconComponent
                                className={cn(
                                  "h-4 w-4",
                                  num.iconColor || "text-gray-500"
                                )}
                              />
                              <span className="font-medium">{num.value}</span>
                              <span className="text-xs text-muted-foreground">
                                ({num.label})
                              </span>
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </ClientOnlySelect>
                </div>
              )}
            </div>
          )}

          {/* AI Agents Selection */}
          {selectionType === "assistants" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-semibold flex items-center gap-2">
                  <Bot className="h-4 w-4 text-indigo-600" />
                  Select AI Agent
                </Label>
                {loadingData ? (
                  <div className="text-sm text-muted-foreground">
                    Loading AI agents...
                  </div>
                ) : assistants.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No AI agents found
                  </div>
                ) : (
                  <ClientOnlySelect
                    value={selectedAssistantId}
                    onValueChange={setSelectedAssistantId}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose an AI agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {assistants.map((assistant) => (
                        <SelectItem
                          key={assistant.id}
                          value={assistant.id}
                          data-testid="transfer-assistant-option"
                          data-assistant-id={assistant.id}
                        >
                          <div className="flex items-center gap-2">
                            <Bot className="h-4 w-4 text-indigo-500" />
                            <span className="font-medium">
                              {assistant.name || assistant.id}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </ClientOnlySelect>
                )}
                {selectedAssistantId && (
                  <p className="text-xs text-muted-foreground">
                    Will transfer to: sip:user@{selectedAssistantId}
                    .sip.telnyx.com
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Manual Entry */}
          {selectionType === "manual" && (
            <div className="space-y-2">
              <Label className="text-sm font-semibold flex items-center gap-2">
                <Phone className="h-4 w-4 text-orange-600" />
                Phone Number or SIP URI
              </Label>
              <input
                type="tel"
                data-testid="transfer-manual-number" placeholder="+1234567890 or sip:user@domain.com"
                value={manualNumber}
                onChange={(e) => setManualNumber(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          )}

          {/* Active Call UI - Show when consult is active or being initiated */}
          {/* Only show when agent has started a consult call, not for regular CC calls */}
          {(consultState.isActive || consultState.initiating) && (
            <div className="space-y-3 pt-4 border-t">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-semibold flex items-center gap-2">
                  <PhoneCall className="h-4 w-4 text-blue-600" />
                  Call Legs
                </Label>
                {/* Call Status Badge - smaller, border/text only */}
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs font-medium uppercase",
                    isCallConnected()
                      ? "border-green-500 text-green-500"
                      : callStatus === "ringing" || callStatus === "early"
                      ? "border-yellow-500 text-yellow-500"
                      : "border-blue-500 text-blue-500"
                  )}
                >
                  {callStatus || activeCall?.state || "initiating"}
                </Badge>
              </div>

              <ConsultTopology
                activeLeg={consultState.activeLeg}
                agentName={currentAgentName}
                customer={{
                  label: consultState.parkedCall?.fromName || "Customer",
                  detail: formatPhoneDisplay(consultState.parkedCall?.fromNumber),
                }}
                consultant={{
                  label: consultState.consultantCall?.toName || "Consultant",
                  detail: formatPhoneDisplay(
                    consultState.consultantCall?.toNumber ||
                      useActiveCallStore.getState().toNumber ||
                      "Unknown",
                  ),
                }}
                onSwitch={handleSwitchCallLeg}
                disabled={
                  loading ||
                  completeRequested ||
                  consultState.initiating ||
                  coreConsultTransitioning
                }
                connecting={consultState.initiating}
              />
            </div>
          )}

          {/* Call Control Buttons - Show when consult is active or being initiated */}
          {(consultState.isActive || consultState.initiating) && (
            <div className="flex items-center justify-center gap-3 pt-3">
              {!isCallConnected() ? (
                <>
                  {/* Disconnect button when call not yet connected */}
                  <button
                    onClick={handleDisconnectCall}
                    disabled={loading || completeRequested || !coreConsultCanCancel}
                    className="h-10 w-10 rounded-full grid place-items-center bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Disconnect"
                  >
                    <PhoneOff className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <>
                  {/* Mute, Disconnect, and Hold buttons when answered */}
                  <button
                    onClick={handleToggleMute}
                    disabled={loading || completeRequested}
                    className={cn(
                      "h-10 w-10 rounded-full grid place-items-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                      callUI.isMuted
                        ? "bg-zinc-700 hover:bg-zinc-800 text-white"
                        : "bg-zinc-600 hover:bg-zinc-700 text-white"
                    )}
                    title={callUI.isMuted ? "Unmute" : "Mute"}
                  >
                    {callUI.isMuted ? (
                      <MicOff className="h-4 w-4" />
                    ) : (
                      <Mic className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    onClick={handleDisconnectCall}
                    disabled={loading || completeRequested || !coreConsultCanCancel}
                    className="h-10 w-10 rounded-full grid place-items-center bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Disconnect"
                  >
                    <PhoneOff className="h-4 w-4" />
                  </button>
                  <button
                    onClick={handleToggleHold}
                    disabled={loading || completeRequested}
                    className="h-10 w-10 rounded-full grid place-items-center bg-zinc-600 hover:bg-zinc-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={callUI.isHeld ? "Unhold" : "Hold"}
                  >
                    {callUI.isHeld ? (
                      <Play className="h-4 w-4" />
                    ) : (
                      <Pause className="h-4 w-4" />
                    )}
                  </button>
                </>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button
              variant="outline"
              data-testid="consult-cancel" onClick={() => handleModalOpenChange(false)}
              disabled={closeRequested || completeRequested}
              title={
                consultState.isActive || consultState.initiating
                  ? "Cancel consult and close"
                  : "Cancel"
              }
            >
              {closeRequested && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {closeRequested ? "Cancelling..." : "Cancel"}
            </Button>
            {hasCoreInteraction && consultState.isActive && (
              <Button
                data-testid="consult-complete" onClick={handleCompleteConsult}
                disabled={
                  loading ||
                  completeRequested ||
                  coreIntent?.step !== "in_consult"
                }
                className="min-w-[150px] bg-green-600 text-white hover:bg-green-700"
                title="Connect the customer to the consultant and leave the call"
              >
                {(loading || completeRequested) && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {completeRequested ? "Completing..." : "Complete transfer"}
              </Button>
            )}
            {/* Show Consult/Transfer buttons when NOT in consult mode */}
            {/* Hide when consult is active or being initiated */}
            {!(consultState.isActive || consultState.initiating) && (
              <>
                <Button
                  data-testid="consult-start" onClick={handleConsult}
                  disabled={
                    !isValid() ||
                    loading ||
                    loadingData ||
                    selectionType === "queues"
                  }
                  className="min-w-[120px] bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Consulting...
                    </>
                  ) : (
                    "Consult"
                  )}
                </Button>
                <Button
                  data-testid="transfer-submit" onClick={handleConfirm}
                  disabled={!isValid() || loading || loadingData}
                  className="min-w-[120px]"
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Transferring...
                    </>
                  ) : (
                    "Transfer"
                  )}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
