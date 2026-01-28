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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  UsersRound,
  Clock,
  PhoneCall,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STATUS_ICON_MAP,
  STATUS_NAME_ICON_FALLBACK,
  DEFAULT_STATUS_ICON,
} from "@/config/status-icons";

// Prevent hydration mismatch by only rendering Select components after mount
// Radix UI generates random IDs that differ between server and client renders
function ClientOnlySelect({ children, ...props }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    // Return a placeholder that matches SelectTrigger styling
    return (
      <div className="border-input data-placeholder:text-muted-foreground flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs">
        <span className="text-muted-foreground">Loading...</span>
      </div>
    );
  }

  return <Select {...props}>{children}</Select>;
}

/**
 * Extract all available phone numbers from a customer or patient record
 */
function extractPhoneNumbers(record, recordType) {
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
    { key: "sip_uri", label: "SIP URI", icon: Network, color: "text-cyan-500" },
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
}

export function NumberSelectionModal({
  open,
  onOpenChange,
  onSelect,
  mode = "dial", // "dial" or "transfer"
  title,
  description,
}) {
  const [mounted, setMounted] = useState(false);
  const [selectionType, setSelectionType] = useState("queues"); // "queues", "users", "contact", "assistants", or "manual"
  const [selectedQueueId, setSelectedQueueId] = useState("");
  const [selectedRecordId, setSelectedRecordId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedAssistantId, setSelectedAssistantId] = useState("");
  const [selectedNumber, setSelectedNumber] = useState("");
  const [manualNumber, setManualNumber] = useState("");
  const [queues, setQueues] = useState([]);
  const [queueStats, setQueueStats] = useState(null);
  const [agents, setAgents] = useState([]);
  const [agentStats, setAgentStats] = useState(null);
  const [agentFilter, setAgentFilter] = useState("all");
  const [selectedAgentNumber, setSelectedAgentNumber] = useState("");
  const [agentFullProfiles, setAgentFullProfiles] = useState(new Map());
  const [customers, setCustomers] = useState([]);
  const [patients, setPatients] = useState([]);
  const [registeredUsers, setRegisteredUsers] = useState([]);
  const [assistants, setAssistants] = useState([]);
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState(null);

  // Refs for polling intervals
  const queueStatsIntervalRef = useRef(null);
  const agentStatsIntervalRef = useRef(null);

  // Ensure component is mounted before rendering to prevent hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  // Default title and description based on mode
  const defaultTitle =
    mode === "transfer" ? "Transfer Call" : "Select Number to Call";
  const defaultDescription =
    mode === "transfer"
      ? "Choose where to transfer this call"
      : "Choose a number from contacts, users, AI assistants, or enter manually";

  const modalTitle = title || defaultTitle;
  const modalDescription = description || defaultDescription;

  // Load user info and records
  useEffect(() => {
    if (open) {
      loadUserAndRecords();
      // Reset selections when modal opens
      setSelectedQueueId("");
      setSelectedRecordId("");
      setSelectedUserId("");
      setSelectedAssistantId("");
      setSelectedNumber("");
      setSelectedAgentNumber("");
      setManualNumber("");
      setSelectionType("queues");
      setQueueStats(null);
      setAgentStats(null);
      setAgentFilter("all");
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
      }, 2000);
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
    if (open && selectedUserId) {
      loadAgentStats(selectedUserId);
      // Set up polling for agent stats
      if (agentStatsIntervalRef.current) {
        clearInterval(agentStatsIntervalRef.current);
      }
      agentStatsIntervalRef.current = setInterval(() => {
        loadAgentStats(selectedUserId);
      }, 2000);
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
  }, [open, selectedUserId]);

  const loadUserAndRecords = async () => {
    setLoading(true);
    try {
      // Get current user
      const userRes = await fetch("/api/auth/me", { cache: "no-store" });
      const userData = await userRes.json();
      if (userData.isAuth && userData.user) {
        setUser(userData.user);

        // Fetch customers and patients for this user via server-side endpoint
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
      }
    } catch (err) {
      console.error("Failed to load records:", err);
    } finally {
      setLoading(false);
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
      console.error("[NumberSelectionModal] Failed to load queue stats:", err);
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
      console.error("[NumberSelectionModal] Failed to load agent stats:", err);
    }
  };

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

  // Filter agents based on filter dropdown
  const filteredAgents = agents.filter((agent) => {
    if (agentFilter === "all") return true;
    if (agentFilter === "available") return agent.status === "Available";
    if (agentFilter === "busy") return agent.status === "Busy";
    if (agentFilter === "offline") return agent.status === "Offline";
    return true;
  });

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

  // Get all records with their available numbers
  const recordsWithNumbers = [
    ...customers.map((c) => ({
      ...c,
      recordType: "customer",
      numbers: extractPhoneNumbers(c, "customer"),
      displayName:
        `${c.first_name || ""} ${c.last_name || ""}`.trim() ||
        c.customer_id ||
        "Unknown Customer",
    })),
    ...patients.map((p) => ({
      ...p,
      recordType: "patient",
      numbers: extractPhoneNumbers(p, "patient"),
      displayName:
        `${p.first_name || ""} ${p.last_name || ""}`.trim() ||
        p.patient_id ||
        "Unknown Patient",
    })),
  ].filter((r) => r.numbers.length > 0); // Only show records with at least one number

  // Get numbers for selected record
  const selectedRecord = recordsWithNumbers.find(
    (r) => r.id === selectedRecordId,
  );
  const availableNumbers = selectedRecord?.numbers || [];

  // Get numbers for selected user (for contacts section)
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

  // Get agent numbers for users section
  const selectedAgent = agents.find((a) => a.userId === selectedUserId);
  const selectedAgentFullProfile = agentFullProfiles.get(selectedUserId);
  const agentNumbers = selectedAgent
    ? getAgentNumbers(selectedAgent, selectedAgentFullProfile)
    : [];

  const handleConfirm = () => {
    let numberToSelect = "";

    if (selectionType === "queues" && selectedQueueId) {
      // For dial mode, select the queue name
      const queue = queues.find((q) => q.id === selectedQueueId);
      if (queue) {
        numberToSelect = queue.name;
      }
    } else if (
      selectionType === "users" &&
      selectedUserId &&
      selectedAgentNumber
    ) {
      numberToSelect = selectedAgentNumber;
    } else if (
      selectionType === "contact" &&
      selectedRecordId &&
      selectedNumber
    ) {
      numberToSelect = selectedNumber;
    } else if (selectionType === "assistants" && selectedAssistantId) {
      // Generate SIP URI for assistant: sip:user@{assistantId}.sip.telnyx.com
      numberToSelect = `sip:user@${selectedAssistantId}.sip.telnyx.com`;
    } else if (selectionType === "manual" && manualNumber.trim()) {
      numberToSelect = manualNumber.trim();
    }

    if (numberToSelect) {
      onSelect?.(numberToSelect);
      // Close modal after selection
      onOpenChange(false);
    }
  };

  const isValid = () => {
    if (selectionType === "queues") {
      return !!selectedQueueId;
    } else if (selectionType === "users") {
      return selectedUserId && selectedAgentNumber;
    } else if (selectionType === "contact") {
      return selectedRecordId && selectedNumber;
    } else if (selectionType === "assistants") {
      return selectedAssistantId;
    } else if (selectionType === "manual") {
      const v = manualNumber.trim();
      return v && (v.startsWith("+") || v.startsWith("sip:"));
    }
    return false;
  };

  // Don't render modal content until mounted to prevent hydration mismatch
  if (!mounted) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] dark:bg-zinc-900">
        <DialogHeader>
          <DialogTitle>{modalTitle}</DialogTitle>
          <DialogDescription>{modalDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Selection Type */}
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
              onClick={() => setSelectionType("users")}
              className={cn(
                "flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all",
                selectionType === "users"
                  ? "bg-purple-500 text-white border-purple-600"
                  : "bg-purple-500/10 text-purple-600 border-purple-500/20 hover:bg-purple-500/20",
              )}
            >
              <UserCheck className="h-5 w-5" />
              <div className="font-semibold text-xs">Users</div>
              {selectionType === "users" && (
                <CheckCircle2 className="h-3 w-3" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setSelectionType("contact")}
              className={cn(
                "flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all",
                selectionType === "contact"
                  ? "bg-green-500 text-white border-green-600"
                  : "bg-green-500/10 text-green-600 border-green-500/20 hover:bg-green-500/20",
              )}
            >
              <Users className="h-5 w-5" />
              <div className="font-semibold text-xs">Contacts</div>
              {selectionType === "contact" && (
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
              <div className="font-semibold text-xs">AI Assistants</div>
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
                {loading ? (
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

          {/* Users Selection */}
          {selectionType === "users" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm font-semibold flex items-center gap-2">
                    <UserCheck className="h-4 w-4 text-purple-600" />
                    Select User
                  </Label>
                  <ClientOnlySelect
                    value={agentFilter}
                    onValueChange={setAgentFilter}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="available">Available</SelectItem>
                      <SelectItem value="busy">Busy</SelectItem>
                      <SelectItem value="offline">Offline</SelectItem>
                    </SelectContent>
                  </ClientOnlySelect>
                </div>
                {loading ? (
                  <div className="text-sm text-muted-foreground flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading users...
                  </div>
                ) : filteredAgents.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No users found
                  </div>
                ) : (
                  <ClientOnlySelect
                    value={selectedUserId}
                    onValueChange={(value) => {
                      setSelectedUserId(value);
                      setSelectedAgentNumber("");
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a user" />
                    </SelectTrigger>
                    <SelectContent>
                      {filteredAgents.map((agent) => {
                        const displayName =
                          `${agent.firstName || ""} ${agent.lastName || ""}`.trim() ||
                          agent.username ||
                          "Unknown User";
                        // Get status icon (will fetch status metadata later if needed)
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
                      Loading user statistics...
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

          {/* Contact Selection */}
          {selectionType === "contact" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-semibold flex items-center gap-2">
                  <Users className="h-4 w-4 text-blue-600" />
                  Select Contact
                </Label>
                {loading ? (
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
                            {record.recordType === "customer" ? (
                              <UserCircle className="h-4 w-4 text-blue-500" />
                            ) : (
                              <UserCircle className="h-4 w-4 text-purple-500" />
                            )}
                            <span className="font-medium">
                              {record.displayName}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              (
                              {record.recordType === "customer"
                                ? "Customer"
                                : "Patient"}
                              )
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

          {/* AI Assistants Selection */}
          {selectionType === "assistants" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-semibold flex items-center gap-2">
                  <Bot className="h-4 w-4 text-indigo-600" />
                  Select AI Assistant
                </Label>
                {loading ? (
                  <div className="text-sm text-muted-foreground">
                    Loading assistants...
                  </div>
                ) : assistants.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No AI assistants found
                  </div>
                ) : (
                  <ClientOnlySelect
                    value={selectedAssistantId}
                    onValueChange={setSelectedAssistantId}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose an AI assistant" />
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
                    {mode === "transfer" ? "Will transfer to" : "Will call"}:
                    sip:user@{selectedAssistantId}.sip.telnyx.com
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Manual Entry */}
          {selectionType === "manual" && (
            <div className="space-y-2">
              <Label className="text-sm font-semibold flex items-center gap-2">
                <Phone className="h-4 w-4 text-green-600" />
                Phone Number or SIP URI
              </Label>
              <Input
                type="tel"
                placeholder="+1234567890 or sip:user@domain.com"
                value={manualNumber}
                onChange={(e) => setManualNumber(e.target.value)}
                className="w-full"
              />
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={!isValid() || loading}
              className="min-w-[120px]"
            >
              {mode === "transfer" ? "Transfer" : "Select"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
