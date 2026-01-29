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
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STATUS_ICON_MAP,
  STATUS_NAME_ICON_FALLBACK,
  DEFAULT_STATUS_ICON,
} from "@/config/status-icons";

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

export function TransferModal({ open, onOpenChange, interaction, onTransfer }) {
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [selectionType, setSelectionType] = useState("queues"); // "queues", "agents", "contacts", "assistants", or "manual"

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
      // Get call control ID from stores
      let storeState;
      let callsStoreState;

      try {
        const { default: useActiveCallStore } =
          await import("@/lib/stores/active-call-store");
        const { default: useCallsStore } =
          await import("@/lib/stores/calls-store");
        storeState = useActiveCallStore.getState();
        callsStoreState = useCallsStore.getState();
      } catch (importErr) {
        console.error("[TransferModal] Error importing stores:", importErr);
        alert("Failed to access call state. Please try again.");
        return;
      }

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
        // Record transfer in active call store
        try {
          const { default: useActiveCallStore } =
            await import("@/lib/stores/active-call-store");
          const store = useActiveCallStore.getState();
          store.recordTransfer({
            to: targetValue,
            type: transferType,
            callControlId: callControlId,
          });
        } catch (storeErr) {
          console.error(
            "[TransferModal] Error recording transfer in store:",
            storeErr,
          );
        }

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
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                        const statusColor =
                          agent.status === "Available"
                            ? "text-green-600"
                            : agent.status === "Busy"
                              ? "text-orange-600"
                              : agent.status === "Away"
                                ? "text-yellow-600"
                                : "text-gray-600";
                        return (
                          <SelectItem key={agent.userId} value={agent.userId}>
                            <div className="flex items-center gap-2">
                              <StatusIcon
                                className={cn("h-4 w-4", statusColor)}
                              />
                              <span className="font-medium">{displayName}</span>
                              <span className={cn("text-xs", statusColor)}>
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

              {selectedAgent && (
                <div className="space-y-3 p-4 bg-muted rounded-lg">
                  {agentStats ? (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label className="text-xs text-muted-foreground">
                            Status
                          </Label>
                          <div className="flex items-center gap-2 mt-1">
                            {(() => {
                              const StatusIcon =
                                STATUS_NAME_ICON_FALLBACK[agentStats.status] ||
                                STATUS_ICON_MAP[DEFAULT_STATUS_ICON];
                              const statusColor =
                                agentStats.status === "Available"
                                  ? "text-green-600"
                                  : agentStats.status === "Busy"
                                    ? "text-orange-600"
                                    : agentStats.status === "Away"
                                      ? "text-yellow-600"
                                      : "text-gray-600";
                              return (
                                <>
                                  <StatusIcon
                                    className={cn("h-4 w-4", statusColor)}
                                  />
                                  <span
                                    className={cn(
                                      "text-sm font-medium",
                                      statusColor,
                                    )}
                                  >
                                    {agentStats.status || "Unknown"}
                                  </span>
                                </>
                              );
                            })()}
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">
                            On Call
                          </Label>
                          <div className="mt-1">
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
                                      : "bg-gray-500 text-white",
                                  )}
                                >
                                  {isOnCall ? "Yes" : "No"}
                                </Badge>
                              );
                            })()}
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading agent statistics...
                    </div>
                  )}
                </div>
              )}

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

          {/* Action Buttons */}
          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
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
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
