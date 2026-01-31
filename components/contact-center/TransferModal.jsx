"use client";

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
import {
  STATUS_ICON_MAP,
  STATUS_NAME_ICON_FALLBACK,
  DEFAULT_STATUS_ICON,
} from "@/config/status-icons";
import { useTelnyx } from "@/components/telephony-provider";
import useActiveCallStore, {
  useActiveCall,
  useCallUI,
  useCallStatus,
  useIsRinging,
} from "@/lib/stores/active-call-store";
import useCallsStore from "@/lib/stores/calls-store";

// Prevent hydration mismatch by only rendering Select components after mount
function ClientOnlySelect({ children, ...props }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
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

// Helper to detect VoIP/SIP numbers (long generated telephony account names)
function isVoipNumber(number) {
  if (!number) return false;
  const str = String(number).trim();
  // Detect SIP URIs or long alphanumeric strings (generated telephony usernames)
  return (
    str.startsWith("sip:") ||
    str.includes("@sip.") ||
    str.includes("@") ||
    (str.length > 20 && /^[a-zA-Z0-9_-]+$/.test(str))
  );
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

export function TransferModal({ open, onOpenChange, interaction, onTransfer }) {
  const { client } = useTelnyx();
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [selectionType, setSelectionType] = useState("queues"); // "queues", "agents", "contacts", "assistants", or "manual"

  // Call control hooks
  const activeCall = useActiveCall();
  const callUI = useCallUI();
  const callStatus = useCallStatus(); // Get call status from store root (not ui)
  const isRinging = useIsRinging();
  const { clearActiveCall, setMuted } = useActiveCallStore();

  // Queue state
  const [queues, setQueues] = useState([]);
  const [selectedQueueId, setSelectedQueueId] = useState("");
  const [queueStats, setQueueStats] = useState(null);
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
    parkedCall: null, // { callControlId, fromNumber, fromName, interactionId }
    consultantCall: null, // { callControlId, toNumber, toName }
    agentCallControlId: null, // Agent's WebRTC call control ID
  });

  // Helper to clean up consult state in database (for error recovery)
  const cleanupConsultStateInDb = async (interactionId, hangupParked = false) => {
    if (!interactionId) return;
    try {
      const url = hangupParked
        ? `/api/contact-center/interactions/${interactionId}/consult?hangupParked=true`
        : `/api/contact-center/interactions/${interactionId}/consult`;
      const res = await fetch(url, { method: "DELETE" });
      const data = await res.json();
      console.log(`[TransferModal] Cleaned up consult state in DB:`, data);
    } catch (err) {
      console.error(`[TransferModal] Failed to cleanup consult state in DB:`, err);
    }
  };

  // Reset consult state when CONSULT call ends (not the original call)
  // We need to be careful here - when we start consult, the original call hangs up first
  // We should only reset when the CONSULT call ends, not the original
  useEffect(() => {
    // Skip if consult is not active or is being initiated
    if (!consultState.isActive || consultState.initiating) {
      return;
    }

    // CRITICAL: Get callControlId from store to verify this is actually the consult call ending
    // not stale status from the old call
    const storeCallControlId = useActiveCallStore.getState().callControlId;
    const consultCallControlId = consultState.consultantCall?.callControlId;
    
    // If store's callControlId doesn't match our consult call, skip
    // This prevents resetting state when stale "ended" status from old call triggers this effect
    if (consultCallControlId && storeCallControlId && storeCallControlId !== consultCallControlId) {
      console.log("[TransferModal] Skipping reset - callControlId mismatch", {
        storeCallControlId,
        consultCallControlId,
      });
      return;
    }

    // Use callStatus from hook (not callUI.status which is undefined)
    const effectiveStatus = callStatus || activeCall?.state || "";
    const lowerStatus = String(effectiveStatus).toLowerCase();
    
    // Only check for actual end states, NOT "idle" (which could be initial state)
    const isCallEnded = ["hangup", "ended", "destroy", "purge", "terminated"].includes(
      lowerStatus,
    );

    // Only reset if the consult call itself ended (not the original call being parked)
    // Check that we actually have an active consult call that's ending
    if (isCallEnded && consultCallControlId) {
      console.log("[TransferModal] Consult call ended, resetting consult state. status=", effectiveStatus);
      setConsultState({
        isActive: false,
        initiating: false,
        parkedCall: null,
        consultantCall: null,
        agentCallControlId: null,
      });
    }
  }, [activeCall, callStatus, consultState.isActive, consultState.initiating, consultState.consultantCall?.callControlId]);

  // Refs for polling intervals
  const queueStatsIntervalRef = useRef(null);
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
      // Reset consult state when modal opens (fresh start)
      setConsultState({
        isActive: false,
        initiating: false,
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
          (q) => q.name === interaction.queueName,
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
      if (queueStatsIntervalRef.current) {
        clearInterval(queueStatsIntervalRef.current);
      }
    };
  }, [open, selectedQueueId]);

  // Load agent stats when agent is selected
  useEffect(() => {
    if (open && selectedAgentId) {
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
  }, [open, selectedAgentId]);

  const loadData = async () => {
    setLoadingData(true);
    try {
      // Get current user
      const userRes = await fetch("/api/auth/me", { cache: "no-store" });
      const userData = await userRes.json();
      if (userData.isAuth && userData.user) {
        setUser(userData.user);
      }

      // Load queues
      const queuesRes = await fetch("/api/contact-center/queues/list", {
        cache: "no-store",
      });
      const queuesData = await queuesRes.json();
      if (queuesData.queues) {
        setQueues(queuesData.queues);
      }

      // Load agents stats
      const agentsRes = await fetch("/api/contact-center/stats/agents", {
        cache: "no-store",
      });
      const agentsData = await agentsRes.json();
      if (agentsData.stats && Array.isArray(agentsData.stats)) {
        setAgents(agentsData.stats);
      }

      // Load contacts for fallback and to get full user profiles with telephony_user_name
      const contactsRes = await fetch("/api/user/contacts", {
        cache: "no-store",
      });
      const contactsData = await contactsRes.json();
      if (contactsData.ok) {
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
      const statusesRes = await fetch("/api/user/statuses", {
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
    try {
      const res = await fetch(
        `/api/contact-center/stats/queues?queueId=${encodeURIComponent(queueId)}`,
        { cache: "no-store" },
      );
      const data = await res.json();
      if (data.stats) {
        setQueueStats(data.stats);
      }
    } catch (err) {
      console.error("[TransferModal] Failed to load queue stats:", err);
    }
  };

  const loadAgentStats = async (agentId) => {
    try {
      const res = await fetch(
        `/api/contact-center/stats/agents?userId=${encodeURIComponent(agentId)}`,
        { cache: "no-store" },
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
      (s) => s.name === statusName || s.id === statusName.toLowerCase(),
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

  const handleTransfer = async (
    target,
    type = "external",
    preserveRouting = false,
  ) => {
    // Allow transfer even without interaction (for direct WebRTC calls)
    let interactionId = interaction?.id;
    let callControlId =
      interaction?.metadata?.original_call_control_id ||
      interaction?.call_control_id;

    if (!interactionId && !callControlId) {
      // Get call control ID from stores (use statically imported stores)
      const storeState = useActiveCallStore.getState();
      const callsStoreState = useCallsStore.getState();

      if (!storeState.call) {
        alert("No active call to transfer");
        return;
      }

      const webrtcCallControlId = storeState.callControlId;
      if (webrtcCallControlId) {
        const callData = callsStoreState.getCall(webrtcCallControlId);
        if (callData?.originalCallControlId) {
          callControlId = callData.originalCallControlId;
        }
      }

      if (!callControlId && storeState.originalCallControlId) {
        callControlId = storeState.originalCallControlId;
      }

      if (!callControlId && (storeState.rtcCallId || webrtcCallControlId)) {
        try {
          const lookupId = storeState.rtcCallId || webrtcCallControlId;
          const res = await fetch(
            `/api/voice/call-leg/${encodeURIComponent(lookupId)}`,
          );
          const data = await res.json();

          if (data.ok && data.call_control_id) {
            callControlId = data.call_control_id;
          }
        } catch (err) {
          // Silently handle error
        }
      }

      if (!callControlId) {
        callControlId = webrtcCallControlId;
      }

      if (!callControlId) {
        alert(
          "Cannot determine call control ID for transfer. Missing call information.",
        );
        return;
      }
    }

    setLoading(true);
    try {
      const transferType = type || "external";
      const targetValue = target.trim();

      if (!targetValue) {
        alert("Please select a transfer destination");
        setLoading(false);
        return;
      }

      let endpoint;
      let body;

      if (interactionId) {
        endpoint = `/api/contact-center/interactions/${interactionId}/transfer`;
        body = {
          type: transferType,
          target: targetValue,
          preserveRoutingOptions: preserveRouting,
        };
      } else if (callControlId) {
        endpoint = `/api/contact-center/interactions/by-call-control-id/transfer?callControlId=${encodeURIComponent(
          callControlId,
        )}`;
        body = {
          type: transferType,
          target: targetValue,
          preserveRoutingOptions: preserveRouting,
        };
      } else {
        alert("Cannot determine call control ID for transfer");
        setLoading(false);
        return;
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (data.ok) {
        // Record transfer in active call store (use statically imported store)
        useActiveCallStore.getState().recordTransfer({
          to: targetValue,
          type: transferType,
          callControlId: callControlId,
        });

        onOpenChange(false);
        try {
          onTransfer?.();
        } catch (callbackErr) {
          console.error(
            "[TransferModal] Error in onTransfer callback:",
            callbackErr,
          );
        }
      } else {
        alert(data.error || "Transfer failed");
      }
    } catch (err) {
      console.error("[TransferModal] Transfer error:", err);
      alert("Transfer failed: " + (err.message || "Unknown error"));
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = () => {
    let target = "";
    let transferType = "external"; // Default to external transfer

    if (selectionType === "queues" && selectedQueueId) {
      // Transfer to queue - use queue ID
      target = selectedQueueId;
      transferType = "queue";
    } else if (
      selectionType === "agents" &&
      selectedAgentId &&
      selectedAgentNumber
    ) {
      target = selectedAgentNumber;
      transferType = "external";
    } else if (
      selectionType === "contacts" &&
      selectedRecordId &&
      selectedNumber
    ) {
      target = selectedNumber;
      transferType = "external";
    } else if (selectionType === "assistants" && selectedAssistantId) {
      target = `sip:user@${selectedAssistantId}.sip.telnyx.com`;
      transferType = "external";
    } else if (selectionType === "manual" && manualNumber.trim()) {
      target = manualNumber.trim();
      transferType = "external";
    }

    if (target) {
      handleTransfer(target, transferType);
    }
  };

  const handleConsult = async () => {
    let target = "";
    let transferType = "external";

    if (selectionType === "queues" && selectedQueueId) {
      alert("Consult is only available for external transfers");
      return;
    } else if (
      selectionType === "agents" &&
      selectedAgentId &&
      selectedAgentNumber
    ) {
      target = selectedAgentNumber;
      transferType = "external";
    } else if (
      selectionType === "contacts" &&
      selectedRecordId &&
      selectedNumber
    ) {
      target = selectedNumber;
      transferType = "external";
    } else if (selectionType === "assistants" && selectedAssistantId) {
      target = `sip:user@${selectedAssistantId}.sip.telnyx.com`;
      transferType = "external";
    } else if (selectionType === "manual" && manualNumber.trim()) {
      target = manualNumber.trim();
      transferType = "external";
    }

    if (!target) {
      alert("Please select a consult destination");
      return;
    }

    setLoading(true);
    try {
      // Get active call from store (use statically imported stores)
      const storeState = useActiveCallStore.getState();
      const callsStoreState = useCallsStore.getState();

      if (!storeState.call) {
        alert("No active call to consult");
        setLoading(false);
        return;
      }

      const activeCallFromStore = storeState.call;
      
      let interactionId = interaction?.id;
      let currentInteraction = interaction;
      
      // Get call_session_id from store - this is the most reliable way to find the interaction
      const callSessionId =
        storeState.originalCallSessionId ||
        storeState.call?.callSessionId ||
        storeState.call?.call_session_id ||
        activeCall?.callSessionId ||
        activeCall?.call_session_id;

      // If we don't have agent_call_control_id in metadata, fetch interaction by call_session_id
      if (!currentInteraction?.metadata?.agent_call_control_id && callSessionId) {
        try {
          const interactionRes = await fetch(
            `/api/contact-center/interactions/by-call-session-id?callSessionId=${encodeURIComponent(callSessionId)}`,
            { cache: "no-store" },
          );
          if (interactionRes.ok) {
            const interactionData = await interactionRes.json();
            if (interactionData.interaction) {
              currentInteraction = interactionData.interaction;
              interactionId = currentInteraction.id;
            }
          }
        } catch (err) {
          console.error(
            "[TransferModal] Failed to fetch interaction by call_session_id:",
            err,
          );
        }
      }

      // If still no agent_call_control_id, try fetching by interactionId
      if (!currentInteraction?.metadata?.agent_call_control_id && interactionId) {
        try {
          const interactionRes = await fetch(
            `/api/contact-center/interactions/${encodeURIComponent(interactionId)}`,
            { cache: "no-store" },
          );
          if (interactionRes.ok) {
            const interactionData = await interactionRes.json();
            if (interactionData.interaction) {
              currentInteraction = interactionData.interaction;
            }
          }
        } catch (err) {
          console.error(
            "[TransferModal] Failed to fetch interaction by ID:",
            err,
          );
        }
      }

      // Get agent_call_control_id from interaction metadata - this is the ONLY correct ID to use
      // NOT the rtcCallId from WebRTC store!
      const agentCallControlId =
        currentInteraction?.metadata?.agent_call_control_id;

      if (!agentCallControlId) {
        alert(
          "Cannot find agent call control ID in interaction metadata. Please ensure the call is properly connected.",
        );
        setLoading(false);
        return;
      }

      let parkedCallControlId =
        currentInteraction?.metadata?.original_call_control_id ||
        currentInteraction?.call_control_id ||
        storeState.originalCallControlId;

      // CRITICAL: Set consultInProgress flag BEFORE API call to prevent clearActiveCall
      // from being called when the original call hangs up (race condition protection)
      useActiveCallStore.getState().setConsultInProgress(true);
      console.log("[TransferModal] Set consultInProgress=true to protect against clearActiveCall");

      // Step 1: Call API to set consult state BEFORE disconnecting WebRTC
      // This is critical - the webhook handler checks consult_state.isActive to know
      // whether to hang up the original call leg or keep it parked
      let endpoint;
      if (interactionId) {
        endpoint = `/api/contact-center/interactions/${interactionId}/consult`;
      } else {
        // Use agent_call_control_id from metadata to find the interaction
        endpoint = `/api/contact-center/interactions/by-call-control-id/consult?callControlId=${encodeURIComponent(
          agentCallControlId,
        )}`;
      }

      const requestBody = {
        type: transferType,
        target: target.trim(),
        agentCallControlId: agentCallControlId, // Use the correct ID from metadata
      };

      console.log(
        `[TransferModal] Consult request: endpoint=${endpoint}, body=${JSON.stringify(requestBody)}, interactionId=${interactionId}, agentCallControlId=${agentCallControlId}, parkedCallControlId=${parkedCallControlId}`,
      );

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      // Check if API call succeeded before disconnecting WebRTC
      const data = await res.json();
      if (!data.ok) {
        console.error(
          `[TransferModal] Consult API failed: ${JSON.stringify(data)}`,
        );
        // Clear consultInProgress flag on API error
        useActiveCallStore.getState().setConsultInProgress(false);
        alert(data.error || "Consult failed");
        setLoading(false);
        return;
      }

      console.log(
        `[TransferModal] Consult API succeeded: ${JSON.stringify(data)}. Server hung up agent's call leg. Initiating WebRTC call to consultant.`,
      );

      // Get consultant target from response or use the one from form
      const consultantTarget = data.consultantTarget || target.trim();
      const fromNumber =
        currentInteraction?.from_number ||
        currentInteraction?.to_number ||
        storeState.call?.fromNumber ||
        null;

      // Set consultState.initiating=true BEFORE WebRTC call to show loading state
      // Keep isActive=false so buttons remain visible (but disabled with loading spinner)
      // isActive will be set to true AFTER WebRTC call is established
      setConsultState({
        isActive: false, // Not active yet - still setting up
        initiating: true, // Flag to show loading state on buttons
        parkedCall: {
          callControlId: data.parkedCallControlId || parkedCallControlId,
          fromNumber: currentInteraction?.from_number || null,
          fromName: currentInteraction?.from_name || null,
          interactionId: interactionId,
        },
        consultantCall: {
          callControlId: null, // Will be set when WebRTC call is established
          toNumber: consultantTarget,
          toName: null,
        },
        agentCallControlId: null, // Will be set when WebRTC call is established
      });

      console.log(
        `[TransferModal] Set consultState.initiating=true, keeping buttons visible with loading`,
      );

      // Step 2: Initiate WebRTC call to consultant (same as softphone outbound call)
      // This will trigger call.initiated webhook which will use dialAndBridge
      if (!client) {
        alert("WebRTC client not available. Please ensure you're connected.");
        setLoading(false);
        // Clear consultInProgress flag on error
        useActiveCallStore.getState().setConsultInProgress(false);
        // Reset consult state on error
        setConsultState({
          isActive: false,
          initiating: false,
          parkedCall: null,
          consultantCall: null,
          agentCallControlId: null,
        });
        // Clean up consult state in database since we can't proceed
        if (interactionId) {
          cleanupConsultStateInDb(interactionId, true);
        }
        return;
      }

      console.log(
        `[TransferModal] Initiating WebRTC call to consultant: destinationNumber=${consultantTarget}, callerNumber=${fromNumber}`,
      );

      try {
        // Enable microphone
        try {
          client.enableMicrophone?.();
        } catch (_) {}

        // Create new WebRTC call (same as softphone outbound call)
        const call = client.newCall({
          destinationNumber: consultantTarget,
          callerNumber: fromNumber || undefined,
          audio: true,
          video: false,
        });

        // Set active call in store (consult call) - use statically imported store
        // Small delay to ensure any pending clearActiveCall calls have been blocked
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const activeCallStore = useActiveCallStore.getState();
        console.log(`[TransferModal] Before setActiveCall: consultInProgress=${activeCallStore.consultInProgress}, currentCall=${!!activeCallStore.call}, currentStatus=${activeCallStore.status}`);
        
        activeCallStore.setActiveCall(call, {
          direction: "outbound",
          fromNumber: fromNumber,
          toNumber: consultantTarget,
        });

        // Update status immediately
        const initialState = call.state || "trying";
        if (initialState) {
          activeCallStore.updateStatus(initialState);
        }

        console.log(`[TransferModal] After setActiveCall: call=${!!useActiveCallStore.getState().call}, status=${useActiveCallStore.getState().status}, initialState=${initialState}`);

        // Wire call events (comprehensive - same as softphone)
        if (typeof call.on === "function") {
          call.on("ringing", () => {
            console.log("[TransferModal] Call event: ringing");
            useActiveCallStore.getState().updateStatus("ringing");
          });
          call.on("active", () => {
            console.log("[TransferModal] Call event: active");
            useActiveCallStore.getState().updateStatus("active");
          });
          call.on("connected", () => {
            console.log("[TransferModal] Call event: connected");
            useActiveCallStore.getState().updateStatus("connected");
          });
          call.on("answered", () => {
            console.log("[TransferModal] Call event: answered");
            useActiveCallStore.getState().updateStatus("answered");
          });
          call.on("held", () => {
            console.log("[TransferModal] Call event: held");
            useActiveCallStore.getState().setHeld(true);
          });
          call.on("hangup", () => {
            console.log("[TransferModal] Call event: hangup");
            useActiveCallStore.getState().updateStatus("ended");
          });
          call.on("destroy", () => {
            console.log("[TransferModal] Call event: destroy");
            useActiveCallStore.getState().updateStatus("ended");
          });
          call.on("ended", () => {
            console.log("[TransferModal] Call event: ended");
            useActiveCallStore.getState().updateStatus("ended");
          });
          call.on("stateChanged", (newState) => {
            console.log(`[TransferModal] Call event: stateChanged to ${newState}`);
            if (newState) {
              const lowerState = String(newState).toLowerCase();
              useActiveCallStore.getState().updateStatus(lowerState);
            }
          });
        }

        // Send invite to initiate the call
        call.invite?.();

        // Get the WebRTC call control ID from the call object
        const newAgentCallControlId = call.callControlId || call.call_control_id || call.id || null;

        console.log(
          `[TransferModal] WebRTC call initiated. callControlId=${newAgentCallControlId}. Waiting for call.initiated webhook to trigger dialAndBridge.`,
        );

        // Step 3: Wait a moment for store to stabilize before setting isActive
        // This prevents race condition where useEffect sees stale "ended" status
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify store has the new call before activating consult UI
        const verifyStore = useActiveCallStore.getState();
        console.log(`[TransferModal] Verify store before isActive: call=${!!verifyStore.call}, status=${verifyStore.status}, callControlId=${verifyStore.callControlId}`);

        // CRITICAL: Only activate if store shows a valid call state (not ended/idle)
        const storeStatus = String(verifyStore.status || "").toLowerCase();
        const isStoreCallValid = verifyStore.call && 
          !["ended", "hangup", "destroy", "idle", "terminated", "purge"].includes(storeStatus);

        if (!isStoreCallValid) {
          console.warn(`[TransferModal] Store call not valid, status=${storeStatus}. Waiting for valid state...`);
          // Wait a bit more and check again
          await new Promise(resolve => setTimeout(resolve, 300));
          const retryStore = useActiveCallStore.getState();
          const retryStatus = String(retryStore.status || "").toLowerCase();
          console.log(`[TransferModal] Retry verify: call=${!!retryStore.call}, status=${retryStatus}`);
        }

        // Step 4: Update consult state with the new call's control ID
        // NOW set isActive=true since call is established - this hides the Consult/Transfer buttons
        // and shows the call legs UI
        setConsultState((prev) => ({
          ...prev,
          isActive: true, // NOW activate - call is established
          initiating: false, // No longer initiating
          agentCallControlId: newAgentCallControlId,
          consultantCall: {
            ...prev.consultantCall,
            callControlId: newAgentCallControlId,
          },
        }));

        // Clear consultInProgress flag - new call is now set in the store
        useActiveCallStore.getState().setConsultInProgress(false);
        console.log("[TransferModal] Cleared consultInProgress flag - new consult call is established");

        // Keep modal open and stop loading - consult call is being initiated
        setLoading(false);
        // Don't close the modal - user needs to see consult call legs and can switch between them
        console.log(
          `[TransferModal] Consult call initiated. Modal will stay open for call leg management.`,
        );
      } catch (callErr) {
        console.error("[TransferModal] Failed to initiate WebRTC call:", callErr);
        alert("Failed to initiate consult call: " + (callErr.message || "Unknown error"));
        setLoading(false);
        // Clear consultInProgress flag on error
        useActiveCallStore.getState().setConsultInProgress(false);
        // Reset consult state on error and cleanup in database
        setConsultState({
          isActive: false,
          initiating: false,
          parkedCall: null,
          consultantCall: null,
          agentCallControlId: null,
        });
        // Clean up consult state in database and hangup parked call since consult failed
        if (interactionId) {
          cleanupConsultStateInDb(interactionId, true);
        }
        return;
      }
    } catch (err) {
      console.error("[TransferModal] Consult error:", err);
      alert("Consult failed: " + (err.message || "Unknown error"));
      // Clear consultInProgress flag on error
      useActiveCallStore.getState().setConsultInProgress(false);
      // Reset consult state on outer error
      setConsultState({
        isActive: false,
        initiating: false,
        parkedCall: null,
        consultantCall: null,
        agentCallControlId: null,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchCallLeg = async (targetLegType) => {
    // targetLegType: 'parked' or 'consultant'
    // We need to use the correct call control IDs from the interaction metadata
    // The parked call uses original_call_control_id
    // The consultant call uses the current WebRTC call's ID
    
    const interactionId = consultState.parkedCall?.interactionId || interaction?.id;
    
    if (!interactionId) {
      alert("Cannot switch call leg. Missing interaction information.");
      return;
    }

    setLoading(true);
    try {
      // Fetch the latest interaction to get correct call control IDs
      const interactionRes = await fetch(
        `/api/contact-center/interactions/${interactionId}`,
        { cache: "no-store" },
      );
      const interactionData = await interactionRes.json();
      
      if (!interactionData.ok || !interactionData.interaction) {
        alert("Failed to fetch interaction data");
        setLoading(false);
        return;
      }
      
      const currentInteraction = interactionData.interaction;
      const parkedCallControlId = currentInteraction.metadata?.original_call_control_id;
      const agentCallControlId = currentInteraction.metadata?.agent_call_control_id;
      
      console.log(`[TransferModal] Switch call leg: targetLegType=${targetLegType}, parkedCallControlId=${parkedCallControlId}, agentCallControlId=${agentCallControlId}`);
      
      // For switching, we need to bridge the current WebRTC connection to the target leg
      // Get the current active WebRTC call control ID (use statically imported store)
      const switchStoreState = useActiveCallStore.getState();
      const currentWebRtcCallControlId = switchStoreState.callControlId || switchStoreState.call?.callControlId || switchStoreState.call?.call_control_id || switchStoreState.call?.id;
      
      if (!currentWebRtcCallControlId) {
        alert("Cannot switch call leg. No active WebRTC call.");
        setLoading(false);
        return;
      }
      
      const targetCallControlId = targetLegType === 'parked' ? parkedCallControlId : agentCallControlId;
      
      if (!targetCallControlId) {
        alert(`Cannot switch to ${targetLegType} call. Missing call control ID.`);
        setLoading(false);
        return;
      }
      
      console.log(`[TransferModal] Bridging currentWebRtcCallControlId=${currentWebRtcCallControlId} to targetCallControlId=${targetCallControlId}`);

      const res = await fetch("/api/voice/call-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "bridge",
          callControlId: currentWebRtcCallControlId,
          params: {
            call_control_id: targetCallControlId,
          },
        }),
      });

      const data = await res.json();
      if (!data.ok) {
        alert(data.error || "Failed to switch call leg");
      } else {
        console.log(`[TransferModal] Successfully switched to ${targetLegType} call leg`);
      }
    } catch (err) {
      console.error("[TransferModal] Switch call leg error:", err);
      alert("Failed to switch call leg: " + (err.message || "Unknown error"));
    } finally {
      setLoading(false);
    }
  };

  // Call control handlers (similar to SupervisionModal)
  const handleDisconnectCall = () => {
    // Get interactionId before resetting state
    const interactionId = consultState.parkedCall?.interactionId || interaction?.id;
    const wasConsultActive = consultState.isActive || consultState.initiating;
    
    if (!activeCall) {
      clearActiveCall();
      // Reset consult state when call ends
      setConsultState({
        isActive: false,
        initiating: false,
        parkedCall: null,
        consultantCall: null,
        agentCallControlId: null,
      });
      // Clean up consult state in database if we were in a consult process
      if (wasConsultActive && interactionId) {
        cleanupConsultStateInDb(interactionId, true);
      }
      return;
    }
    try {
      activeCall.hangup?.();
      clearActiveCall();
      // Reset consult state when call ends
      setConsultState({
        isActive: false,
        initiating: false,
        parkedCall: null,
        consultantCall: null,
        agentCallControlId: null,
      });
      // Clean up consult state in database if we were in a consult process
      if (wasConsultActive && interactionId) {
        cleanupConsultStateInDb(interactionId, true);
      }
    } catch (err) {
      console.error("[TransferModal] Error disconnecting call:", err);
      clearActiveCall();
      setConsultState({
        isActive: false,
        initiating: false,
        parkedCall: null,
        consultantCall: null,
        agentCallControlId: null,
      });
      // Clean up consult state in database on error
      if (wasConsultActive && interactionId) {
        cleanupConsultStateInDb(interactionId, true);
      }
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
      const { setHeld, updateStatus } = useActiveCallStore.getState();
      if (callUI.isHeld) {
        activeCall.unhold?.() || activeCall.resume?.();
        updateStatus("active");
      } else {
        activeCall.hold?.() || activeCall.pause?.();
        updateStatus("held");
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

  const isCallActive = () => {
    if (!activeCall) return false;
    const status = getEffectiveCallStatus();
    const lowerStatus = String(status).toLowerCase();
    return !["hangup", "ended", "destroy", "purge", "idle", "terminated", ""].includes(
      lowerStatus,
    );
  };

  const isCallConnected = () => {
    if (!activeCall) return false;
    const status = getEffectiveCallStatus();
    const lowerStatus = String(status).toLowerCase();
    return ["active", "connected", "answered", "held"].includes(lowerStatus);
  };

  // Prevent modal from closing when consult call is active or being initiated
  const handleModalOpenChange = (newOpen) => {
    if (!newOpen) {
      // Check consultState (isActive or initiating) and activeCall to prevent closing during consult
      const hasActiveConsultCall = 
        consultState.isActive || 
        consultState.initiating || 
        (activeCall && isCallActive());
      
      if (hasActiveConsultCall) {
        // Prevent closing if consult call is active or being initiated
        console.log(
          "[TransferModal] Cannot close modal while consult call is in progress",
          { 
            consultStateIsActive: consultState.isActive, 
            consultStateInitiating: consultState.initiating,
            hasActiveCall: !!activeCall, 
            isCallActive: isCallActive() 
          },
        );
        return;
      }
    }
    console.log("[TransferModal] Modal close allowed", { newOpen, consultStateIsActive: consultState.isActive, consultStateInitiating: consultState.initiating });
    onOpenChange(newOpen);
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
    (r) => r.id === selectedRecordId,
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
  const agentNumbers = selectedAgent
    ? getAgentNumbers(selectedAgent, selectedAgentFullProfile)
    : [];

  if (!mounted) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={handleModalOpenChange}>
      <DialogContent className="sm:max-w-[700px] dark:bg-zinc-900 max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Transfer Call</DialogTitle>
          <DialogDescription>
            Choose where to transfer this call
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Selection Type Tiles */}
          <div className="grid grid-cols-5 gap-2">
            <button
              type="button"
              onClick={() => setSelectionType("queues")}
              className={cn(
                "flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all",
                selectionType === "queues"
                  ? "bg-blue-500 text-white border-blue-600"
                  : "bg-blue-500/10 text-blue-600 border-blue-500/20 hover:bg-blue-500/20",
              )}
            >
              <UsersRound className="h-5 w-5" />
              <div className="font-semibold text-xs">Queues</div>
              {selectionType === "queues" && (
                <CheckCircle2 className="h-3 w-3" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setSelectionType("agents")}
              className={cn(
                "flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all",
                selectionType === "agents"
                  ? "bg-purple-500 text-white border-purple-600"
                  : "bg-purple-500/10 text-purple-600 border-purple-500/20 hover:bg-purple-500/20",
              )}
            >
              <UserCheck className="h-5 w-5" />
              <div className="font-semibold text-xs">Users</div>
              {selectionType === "agents" && (
                <CheckCircle2 className="h-3 w-3" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setSelectionType("contacts")}
              className={cn(
                "flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all",
                selectionType === "contacts"
                  ? "bg-green-500 text-white border-green-600"
                  : "bg-green-500/10 text-green-600 border-green-500/20 hover:bg-green-500/20",
              )}
            >
              <Users className="h-5 w-5" />
              <div className="font-semibold text-xs">Contacts</div>
              {selectionType === "contacts" && (
                <CheckCircle2 className="h-3 w-3" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setSelectionType("assistants")}
              className={cn(
                "flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all",
                selectionType === "assistants"
                  ? "bg-indigo-500 text-white border-indigo-600"
                  : "bg-indigo-500/10 text-indigo-600 border-indigo-500/20 hover:bg-indigo-500/20",
              )}
            >
              <Bot className="h-5 w-5" />
              <div className="font-semibold text-xs">AI Agents</div>
              {selectionType === "assistants" && (
                <CheckCircle2 className="h-3 w-3" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setSelectionType("manual")}
              className={cn(
                "flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all",
                selectionType === "manual"
                  ? "bg-orange-500 text-white border-orange-600"
                  : "bg-orange-500/10 text-orange-600 border-orange-500/20 hover:bg-orange-500/20",
              )}
            >
              <Phone className="h-5 w-5" />
              <div className="font-semibold text-xs">Manual</div>
              {selectionType === "manual" && (
                <CheckCircle2 className="h-3 w-3" />
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
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a queue" />
                    </SelectTrigger>
                    <SelectContent>
                      {queues.map((queue) => (
                        <SelectItem key={queue.id} value={queue.id}>
                          <div className="flex items-center gap-2">
                            <UsersRound className="h-4 w-4 text-blue-500" />
                            <span className="font-medium">
                              {queue.display_name || queue.name}
                            </span>
                            <Badge
                              className={cn(
                                "text-xs",
                                getQueueTypeBadgeColor(queue.routing_strategy),
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
                              ? `${Math.round(queueStats.realtime.longestWaitSeconds)}s`
                              : "—"}
                          </div>
                        </div>
                      </div>

                      {/* Preserve Routing Options Toggle */}
                      {(() => {
                        const targetQueue = queues.find(
                          (q) => q.id === selectedQueueId,
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
                    </>
                  ) : (
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading queue statistics...
                    </div>
                  )}
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
                      setSelectedAgentId(value);
                      setSelectedAgentNumber("");
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a user" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => {
                        const displayName =
                          `${agent.firstName || ""} ${agent.lastName || ""}`.trim() ||
                          agent.username ||
                          "Unknown Agent";
                        // Get status icon
                        const StatusIcon =
                          STATUS_NAME_ICON_FALLBACK[agent.status] ||
                          STATUS_ICON_MAP[DEFAULT_STATUS_ICON];
                        // Get status color from database, fallback to hardcoded colors
                        const statusColorHex = getStatusColor(agent.status);
                        const statusColorClass =
                          !statusColorHex
                            ? agent.status === "Available"
                              ? "text-green-600"
                              : agent.status === "Busy"
                                ? "text-orange-600"
                                : agent.status === "Away"
                                  ? "text-yellow-600"
                                  : "text-gray-600"
                            : null;
                        return (
                          <SelectItem key={agent.userId} value={agent.userId}>
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
                                  num.iconColor || "text-gray-500",
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
              {selectedAgent && (
                <div className="p-3 bg-muted rounded-lg">
                  {agentStats ? (
                    <div className="flex items-center justify-between gap-4">
                      {/* Status - label and value in one line */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Status:</span>
                        {(() => {
                          const StatusIcon =
                            STATUS_NAME_ICON_FALLBACK[agentStats.status] ||
                            STATUS_ICON_MAP[DEFAULT_STATUS_ICON];
                          const statusColorHex = getStatusColor(agentStats.status);
                          const statusColorClass =
                            !statusColorHex
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
                                style={statusColorHex ? { color: statusColorHex } : undefined}
                              />
                              <span
                                className={cn("text-sm font-medium", statusColorClass)}
                                style={statusColorHex ? { color: statusColorHex } : undefined}
                              >
                                {agentStats.status || "Unknown"}
                              </span>
                            </>
                          );
                        })()}
                      </div>
                      {/* On Call - label and value in one line */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">On Call:</span>
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
                                isOnCall ? "bg-green-500 text-white" : "bg-gray-500 text-white",
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
                                  num.iconColor || "text-gray-500",
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
                        <SelectItem key={assistant.id} value={assistant.id}>
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
                placeholder="+1234567890 or sip:user@domain.com"
                value={manualNumber}
                onChange={(e) => setManualNumber(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          )}

          {/* Consult Call Tiles - Horizontal colored rectangles */}
          {/* Show when: isActive, initiating, OR when we have parkedCall data and an active call */}
          {(consultState.isActive || consultState.initiating || (consultState.parkedCall && isCallActive())) && (
            <div className="space-y-3 pt-4 border-t">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-semibold flex items-center gap-2">
                  <PhoneCall className="h-4 w-4 text-blue-600" />
                  Call Legs
                </Label>
                {/* Call Status Badge */}
                <Badge
                  className={cn(
                    "text-xs",
                    isCallConnected()
                      ? "bg-green-500 text-white"
                      : callStatus === "ringing" || callStatus === "early"
                        ? "bg-yellow-500 text-white"
                        : "bg-blue-500 text-white",
                  )}
                >
                  {callStatus || activeCall?.state || "initiating"}
                </Badge>
              </div>
              <div className="flex gap-3">
                {/* Parked Call Tile - Dimmed (not active) */}
                {consultState.parkedCall && (
                  <div
                    onClick={() => handleSwitchCallLeg('parked')}
                    className={cn(
                      "flex-1 p-3 rounded-lg cursor-pointer transition-all",
                      "bg-amber-500/20 border-2 border-amber-500/40",
                      "opacity-50 hover:opacity-75",
                    )}
                    title="Click to switch to parked caller"
                  >
                    <div className="flex items-center gap-2">
                      <div className="h-3 w-3 rounded-full bg-amber-500 animate-pulse" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-amber-700 dark:text-amber-400 truncate">
                          {consultState.parkedCall.fromName || "Customer"}
                        </div>
                        <div className="text-xs text-amber-600/70 dark:text-amber-500/70 truncate">
                          {formatPhoneDisplay(consultState.parkedCall.fromNumber)}
                        </div>
                      </div>
                      <span className="text-xs font-medium text-amber-600 dark:text-amber-400 whitespace-nowrap">
                        PARKED
                      </span>
                    </div>
                  </div>
                )}

                {/* Consultant Call Tile - Active */}
                {consultState.consultantCall && (
                  <div
                    onClick={() => handleSwitchCallLeg('consultant')}
                    className={cn(
                      "flex-1 p-3 rounded-lg cursor-pointer transition-all",
                      "bg-green-500/20 border-2 border-green-500",
                      "hover:bg-green-500/30",
                    )}
                    title="Currently connected to consultant"
                  >
                    <div className="flex items-center gap-2">
                      <div className="h-3 w-3 rounded-full bg-green-500 animate-pulse" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-green-700 dark:text-green-400 truncate">
                          {consultState.consultantCall.toName || "Consultant"}
                        </div>
                        <div className="text-xs text-green-600/70 dark:text-green-500/70 truncate flex items-center gap-1">
                          {formatPhoneDisplay(consultState.consultantCall.toNumber)}
                          {isVoipNumber(consultState.consultantCall.toNumber) && (
                            <span 
                              className="inline-flex items-center cursor-help" 
                              title={consultState.consultantCall.toNumber}
                            >
                              <Network className="h-3 w-3" />
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="text-xs font-medium text-green-600 dark:text-green-400 whitespace-nowrap">
                        ACTIVE
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Call Control Buttons - Minimal height, just buttons */}
          {/* Show when: isActive, initiating, OR when we have parkedCall data and an active call */}
          {(consultState.isActive || consultState.initiating || (consultState.parkedCall && isCallActive())) && (
            <div className="flex items-center justify-center gap-3 pt-3">
              {!isCallConnected() ? (
                <>
                  {/* Disconnect button when call not yet connected */}
                  <button
                    onClick={handleDisconnectCall}
                    disabled={loading}
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
                    disabled={loading}
                    className={cn(
                      "h-10 w-10 rounded-full grid place-items-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                      callUI.isMuted
                        ? "bg-zinc-700 hover:bg-zinc-800 text-white"
                        : "bg-zinc-600 hover:bg-zinc-700 text-white",
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
                    disabled={loading}
                    className="h-10 w-10 rounded-full grid place-items-center bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Disconnect"
                  >
                    <PhoneOff className="h-4 w-4" />
                  </button>
                  <button
                    onClick={handleToggleHold}
                    disabled={loading}
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
              onClick={() => handleModalOpenChange(false)}
              disabled={loading || consultState.isActive || consultState.initiating}
              title={
                consultState.isActive || consultState.initiating
                  ? "Cannot close while consult call is in progress"
                  : "Cancel"
              }
            >
              Cancel
            </Button>
            {/* Show Consult/Transfer buttons when NOT in active consult session */}
            {/* Hide when: isActive OR initiating OR (parkedCall exists AND call is active) */}
            {!(consultState.isActive || consultState.initiating || (consultState.parkedCall && isCallActive())) && (
              <>
                <Button
                  onClick={handleConsult}
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
                  onClick={handleConfirm}
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
