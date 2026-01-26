"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  IconActivity,
  IconPhone,
  IconUsers,
  IconClock,
  IconTrendingUp,
  IconAlertCircle,
  IconInfoCircle,
  IconCheck,
  IconX,
  IconRefresh,
  IconArrowLeft,
  IconFilter,
  IconEye,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  STATUS_ICON_MAP,
  STATUS_NAME_ICON_FALLBACK,
  DEFAULT_STATUS_ICON,
} from "@/config/status-icons";
import { SupervisionModal } from "@/components/contact-center/SupervisionModal";

export default function MonitorPage() {
  // Helper function to format seconds into hours and minutes
  const formatTime = (seconds) => {
    if (!seconds || seconds === 0) return "0h 0m";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [agentQueues, setAgentQueues] = useState([]);
  const [loadingQueues, setLoadingQueues] = useState(false);
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const [availableStatuses, setAvailableStatuses] = useState([]);
  const [highlightedCells, setHighlightedCells] = useState(new Set());
  const [activeTab, setActiveTab] = useState("agents");
  const [selectedQueue, setSelectedQueue] = useState(null);
  const [queueCalls, setQueueCalls] = useState([]);
  const [loadingQueueCalls, setLoadingQueueCalls] = useState(false);
  const [selectedAgentDetail, setSelectedAgentDetail] = useState(null);
  const [agentCalls, setAgentCalls] = useState([]);
  const [agentActiveCalls, setAgentActiveCalls] = useState([]);
  const [loadingAgentCalls, setLoadingAgentCalls] = useState(false);
  const [agentTimeTracking, setAgentTimeTracking] = useState(null);
  const [statusMeta, setStatusMeta] = useState({});
  const [currentTime, setCurrentTime] = useState(new Date());
  const [skillMatchDialogOpen, setSkillMatchDialogOpen] = useState(false);
  const [selectedCallForSkills, setSelectedCallForSkills] = useState(null);
  const [availableAgentsForSkills, setAvailableAgentsForSkills] = useState([]);
  const [loadingAgentsForSkills, setLoadingAgentsForSkills] = useState(false);
  const [agentNameFilter, setAgentNameFilter] = useState("");
  const [selectedStatuses, setSelectedStatuses] = useState([]);
  const [selectedQueues, setSelectedQueues] = useState([]);
  const [supervisionModalOpen, setSupervisionModalOpen] = useState(false);
  const [selectedCallForSupervision, setSelectedCallForSupervision] =
    useState(null);
  const selectedQueueRef = useRef(null);
  const loadQueueCallsRef = useRef(null);

  useEffect(() => {
    selectedQueueRef.current = selectedQueue;
  }, [selectedQueue]);

  // Update current time every second for real-time calculations
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    // Initial load
    loadDashboard();
    loadStatuses();

    // Set up SSE stream for real-time updates
    const eventSource = new EventSource("/api/contact-center/monitor/stream");

    eventSource.onopen = () => {
      setConnected(true);
      console.log("[Monitor] SSE connection opened");
    };

    eventSource.addEventListener("monitor_update", (event) => {
      try {
        const update = JSON.parse(event.data);

        setData((currentData) => {
          if (!currentData) {
            setLoading(false);
            return update;
          }

          // Store previous data for comparison
          const prevAgents = currentData.agents?.stats || [];
          const prevQueues = currentData.queues?.stats || [];
          const updateAgents = update.agents?.stats || [];
          const updateQueues = update.queues?.stats || [];

          // Check for changes and highlight BEFORE updating
          prevAgents.forEach((prevAgent) => {
            const updatedAgent = updateAgents.find(
              (a) => String(a.userId) === String(prevAgent.userId)
            );
            if (updatedAgent) {
              if (prevAgent.activeQueues !== updatedAgent.activeQueues) {
                highlightCell(`agent-${String(prevAgent.userId)}-queues`);
              }
              if (prevAgent.currentCalls !== updatedAgent.currentCalls) {
                highlightCell(`agent-${String(prevAgent.userId)}-calls`);
              }
            }
          });

          prevQueues.forEach((prevQueue) => {
            const updatedQueue = updateQueues.find(
              (q) => String(q.queueId) === String(prevQueue.queueId)
            );
            if (updatedQueue) {
              if (
                prevQueue.realtime?.activeCalls !==
                updatedQueue.realtime?.activeCalls
              ) {
                highlightCell(`queue-${String(prevQueue.queueId)}-active`);
              }
              if (
                prevQueue.realtime?.waitingCalls !==
                updatedQueue.realtime?.waitingCalls
              ) {
                highlightCell(`queue-${String(prevQueue.queueId)}-waiting`);
              }
            }
          });

          // Merge agents stats - update only changed agents
          const currentAgents = currentData.agents?.stats || [];
          const mergedAgents = currentAgents.map((currentAgent) => {
            const updatedAgent = updateAgents.find(
              (a) => String(a.userId) === String(currentAgent.userId)
            );
            return updatedAgent || currentAgent;
          });

          // Add any new agents that weren't in the current list
          const currentAgentIds = new Set(
            currentAgents.map((a) => String(a.userId))
          );
          const newAgents = updateAgents.filter(
            (a) => !currentAgentIds.has(String(a.userId))
          );

          // Merge queues stats - update only changed queues
          const currentQueues = currentData.queues?.stats || [];
          const mergedQueues = currentQueues.map((currentQueue) => {
            const updatedQueue = updateQueues.find(
              (q) => String(q.queueId) === String(currentQueue.queueId)
            );
            return updatedQueue || currentQueue;
          });

          // Add any new queues that weren't in the current list
          const currentQueueIds = new Set(
            currentQueues.map((q) => String(q.queueId))
          );
          const newQueues = updateQueues.filter(
            (q) => !currentQueueIds.has(String(q.queueId))
          );

          const mergedData = {
            ...update,
            agents: {
              ...update.agents,
              stats: [...mergedAgents, ...newAgents],
            },
            queues: {
              ...update.queues,
              stats: [...mergedQueues, ...newQueues],
            },
          };

          // Check if selected queue needs to be refreshed
          const selectedQueue = selectedQueueRef.current;
          if (selectedQueue?.id && loadQueueCallsRef.current) {
            const prevQueue = prevQueues.find(
              (queue) => String(queue.queueId) === String(selectedQueue.id)
            );
            const nextQueue = updateQueues.find(
              (queue) => String(queue.queueId) === String(selectedQueue.id)
            );
            const queueChanged =
              prevQueue &&
              nextQueue &&
              (prevQueue.realtime?.waitingCalls !==
                nextQueue.realtime?.waitingCalls ||
                prevQueue.realtime?.activeCalls !==
                  nextQueue.realtime?.activeCalls ||
                prevQueue.realtime?.longestWaitSeconds !==
                  nextQueue.realtime?.longestWaitSeconds);
            if (queueChanged) {
              setTimeout(() => {
                loadQueueCallsRef.current(selectedQueue.id, { silent: true });
              }, 0);
            }
          }

          return mergedData;
        });
      } catch (error) {
        console.error("[Monitor] Error parsing update:", error);
      }
    });

    // Listen for status changes and queue activation changes
    eventSource.addEventListener("status_changed", (event) => {
      try {
        const update = JSON.parse(event.data);
        // Update only the specific agent's status
        if (update.userId && update.status) {
          updateAgentStatus(update.userId, update.status);
        }
      } catch (error) {
        console.error("[Monitor] Error handling status change:", error);
      }
    });

    eventSource.addEventListener("queue_changed", (event) => {
      try {
        const update = JSON.parse(event.data);
        // Update only the specific agent's queue count
        if (
          update.userId &&
          update.queueIds &&
          Array.isArray(update.queueIds)
        ) {
          updateAgentQueues(
            update.userId,
            update.queueIds,
            update.activated === true
          );

          // If the queue dialog is open for this agent, update the local queue list
          if (
            selectedAgent &&
            String(selectedAgent.userId) === String(update.userId)
          ) {
            setAgentQueues((prevQueues) =>
              prevQueues.map((queue) =>
                update.queueIds.includes(queue.id)
                  ? { ...queue, isActivated: update.activated === true }
                  : queue
              )
            );
          }
        }
      } catch (error) {
        console.error("[Monitor] Error handling queue change:", error);
      }
    });

    eventSource.onerror = (error) => {
      console.error("[Monitor] SSE error:", error);
      setConnected(false);
      // Fallback to polling if SSE fails
      if (!data) {
        const pollInterval = setInterval(() => {
          loadDashboard();
        }, 5000);
        return () => clearInterval(pollInterval);
      }
    };

    return () => {
      eventSource.close();
    };
  }, []);

  async function loadStatuses() {
    try {
      const res = await fetch("/api/user/statuses", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const items = Array.isArray(data.statuses) ? data.statuses : [];
      // Filter to only user-selectable statuses for supervisor status changes
      const userSelectableStatuses = items.filter(
        (item) => item.user_selectable !== false
      );
      const next = {};
      userSelectableStatuses.forEach((item) => {
        if (item?.name) {
          next[item.name] = {
            icon: item.icon || null,
            color: item.color || null,
          };
        }
      });
      setStatusMeta(next);
      setAvailableStatuses(userSelectableStatuses);
    } catch (error) {
      console.error("[Monitor] Failed to load statuses:", error);
    }
  }

  async function loadDashboard() {
    try {
      setLoading(true);
      // Add timestamp to prevent caching
      const timestamp = new Date().getTime();
      const res = await fetch(
        `/api/contact-center/monitor/dashboard?t=${timestamp}`,
        {
          cache: "no-store",
          headers: {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache",
          },
        }
      );
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to load dashboard");
      }
      const dashboardData = await res.json();
      setData(dashboardData);
      setLoading(false);
    } catch (error) {
      console.error("[Monitor] Error loading dashboard:", error);
      setLoading(false);
      notify({
        title: "Load failed",
        description: error.message,
        variant: "error",
      });
    }
  }

  // Highlight a cell for 1 second
  function highlightCell(cellKey) {
    setHighlightedCells((prev) => new Set(prev).add(cellKey));
    setTimeout(() => {
      setHighlightedCells((prev) => {
        const next = new Set(prev);
        next.delete(cellKey);
        return next;
      });
    }, 1000);
  }

  // Update specific agent's status without reloading entire dashboard
  function updateAgentStatus(userId, newStatus) {
    const userIdStr = String(userId);
    setData((prevData) => {
      if (!prevData || !prevData.agents?.stats) return prevData;

      const updatedStats = prevData.agents.stats.map((agent) => {
        const agentUserIdStr = String(agent.userId);
        if (agentUserIdStr === userIdStr) {
          return { ...agent, status: newStatus };
        }
        return agent;
      });

      return {
        ...prevData,
        agents: {
          ...prevData.agents,
          stats: updatedStats,
        },
      };
    });
  }

  // Update specific agent's queue count without reloading entire dashboard
  function updateAgentQueues(userId, queueIds, activated) {
    const userIdStr = String(userId);
    highlightCell(`agent-${userIdStr}-queues`);

    // Update the agent's activeQueues count in the main list
    setData((prevData) => {
      if (!prevData || !prevData.agents?.stats) return prevData;

      const updatedStats = prevData.agents.stats.map((agent) => {
        const agentUserIdStr = String(agent.userId);
        if (agentUserIdStr === userIdStr) {
          // Calculate new activeQueues count
          const currentActiveQueues = agent.activeQueues || 0;
          const change = activated ? queueIds.length : -queueIds.length;
          const newActiveQueues = Math.max(0, currentActiveQueues + change);

          return {
            ...agent,
            activeQueues: newActiveQueues,
            activeQueueIds: activated
              ? [...new Set([...(agent.activeQueueIds || []), ...queueIds])]
              : (agent.activeQueueIds || []).filter(
                  (id) => !queueIds.includes(id)
                ),
          };
        }
        return agent;
      });

      return {
        ...prevData,
        agents: {
          ...prevData.agents,
          stats: updatedStats,
        },
      };
    });
  }

  async function loadAgentQueues(userId) {
    try {
      setLoadingQueues(true);
      const res = await fetch(
        `/api/contact-center/agent/queues/list?userId=${userId}`,
        {
          cache: "no-store",
        }
      );
      if (!res.ok) {
        throw new Error("Failed to load queues");
      }
      const data = await res.json();
      setAgentQueues(data.queues || []);
    } catch (error) {
      console.error("[Monitor] Error loading agent queues:", error);
      notify({
        title: "Failed to load queues",
        description: error.message,
        variant: "error",
      });
    } finally {
      setLoadingQueues(false);
    }
  }

  function getQueueCallId(call) {
    return call?.id || call?.callControlId || call?.callSessionId || null;
  }

  function isQueueCallDifferent(prevCall, nextCall) {
    return (
      prevCall?.fromNumber !== nextCall?.fromNumber ||
      prevCall?.toNumber !== nextCall?.toNumber ||
      prevCall?.state !== nextCall?.state ||
      prevCall?.agentName !== nextCall?.agentName ||
      prevCall?.agentUsername !== nextCall?.agentUsername ||
      prevCall?.enqueuedAt !== nextCall?.enqueuedAt ||
      prevCall?.answeredAt !== nextCall?.answeredAt ||
      prevCall?.waitSeconds !== nextCall?.waitSeconds ||
      prevCall?.talkSeconds !== nextCall?.talkSeconds
    );
  }

  function mergeQueueCalls(prevCalls, nextCalls) {
    const prevMap = new Map(
      (prevCalls || []).map((call) => [getQueueCallId(call), call])
    );
    let changed = (prevCalls || []).length !== (nextCalls || []).length;
    const merged = (nextCalls || []).map((call) => {
      const callId = getQueueCallId(call);
      const prev = prevMap.get(callId);
      if (!prev) {
        changed = true;
        return call;
      }
      if (isQueueCallDifferent(prev, call)) {
        changed = true;
        return call;
      }
      return prev;
    });
    return changed ? merged : prevCalls;
  }

  async function loadQueueCalls(queueId, options = {}) {
    const { silent = false } = options;
    try {
      if (!silent) setLoadingQueueCalls(true);
      const res = await fetch(`/api/contact-center/queues/${queueId}/calls`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error("Failed to load queue calls");
      }
      const data = await res.json();
      if (data.ok) {
        setQueueCalls((prev) => mergeQueueCalls(prev, data.calls || []));
        if (!silent) setSelectedQueue(data.queue);
      } else {
        throw new Error(data.error || "Failed to load queue calls");
      }
    } catch (error) {
      console.error("[Monitor] Error loading queue calls:", error);
      if (!silent) {
        notify({
          title: "Failed to load queue calls",
          description: error.message,
          variant: "error",
        });
      }
    } finally {
      if (!silent) setLoadingQueueCalls(false);
    }
  }

  useEffect(() => {
    loadQueueCallsRef.current = loadQueueCalls;
  });

  async function loadAgentCalls(userId) {
    try {
      setLoadingAgentCalls(true);
      const res = await fetch(`/api/contact-center/agents/${userId}/calls`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error("Failed to load agent calls");
      }
      const data = await res.json();
      if (data.ok) {
        setAgentCalls(data.calls || []);
        setAgentActiveCalls(data.activeCalls || []);
        setSelectedAgentDetail(data.agent);
        setAgentTimeTracking(data.timeTracking || null);
      } else {
        throw new Error(data.error || "Failed to load agent calls");
      }
    } catch (error) {
      console.error("[Monitor] Error loading agent calls:", error);
      notify({
        title: "Failed to load agent calls",
        description: error.message,
        variant: "error",
      });
    } finally {
      setLoadingAgentCalls(false);
    }
  }

  async function toggleQueueActivation(queueId, currentlyActivated) {
    try {
      if (!selectedAgent) {
        throw new Error("No agent selected");
      }

      const endpoint = currentlyActivated
        ? "/api/contact-center/agent/queues/deactivate"
        : "/api/contact-center/agent/queues/activate";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queueIds: [queueId],
          userId: selectedAgent.userId, // Pass the target user's ID
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to update queue");
      }

      // Update only the specific queue in the local state instead of reloading
      setAgentQueues((prevQueues) =>
        prevQueues.map((queue) =>
          queue.id === queueId
            ? { ...queue, isActivated: !currentlyActivated }
            : queue
        )
      );

      // Update the agent's queue count in the main list
      updateAgentQueues(selectedAgent?.userId, [queueId], !currentlyActivated);
    } catch (error) {
      console.error("[Monitor] Error toggling queue:", error);
      notify({
        title: "Update failed",
        description: error.message,
        variant: "error",
      });
    }
  }

  async function changeAgentStatus(newStatus) {
    try {
      if (!selectedAgent) {
        throw new Error("No agent selected");
      }

      const res = await fetch("/api/contact-center/agent/status", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: newStatus,
          userId: selectedAgent.userId, // Pass the target user's ID
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to update status");
      }

      // Update the agent's status in the main list
      updateAgentStatus(selectedAgent.userId, newStatus);

      notify({
        title: "Status updated",
        description: `Agent status changed to ${newStatus}`,
        variant: "success",
      });

      // Close dialog
      setStatusDialogOpen(false);
    } catch (error) {
      console.error("[Monitor] Error changing status:", error);
      notify({
        title: "Update failed",
        description: error.message,
        variant: "error",
      });
    }
  }

  if (loading && !data) {
    return (
      <div className="px-4 lg:px-6 space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const overall = data?.overall || {};
  const queues = data?.queues?.stats || [];
  const allAgents = data?.agents?.stats || [];

  // Get unique statuses and queues for filters
  const uniqueStatuses = Array.from(
    new Set(allAgents.map((agent) => agent.status).filter(Boolean))
  ).sort();

  const uniqueQueues = Array.from(
    new Set(
      allAgents.flatMap((agent) => agent.activeQueueIds || []).filter(Boolean)
    )
  ).sort();

  // Get queue names for display
  const queueNamesMap = new Map(
    queues.map((q) => [q.queueId, q.queueName || q.queueId])
  );

  // Filter agents based on filters
  const agents = allAgents.filter((agent) => {
    // Filter by agent name - use same logic as table display
    if (agentNameFilter && agentNameFilter.trim()) {
      const searchTerm = agentNameFilter.trim().toLowerCase();

      // Build display name using same logic as table
      let displayName = "";
      const firstName = agent.firstName || agent.first_name || null;
      const lastName = agent.lastName || agent.last_name || null;

      if (firstName || lastName) {
        displayName = `${firstName || ""} ${lastName || ""}`.trim();
      } else if (agent.username) {
        // If username is an email, extract the name part before @
        const emailMatch = agent.username.match(/^([^@]+)@/);
        displayName = emailMatch ? emailMatch[1] : agent.username;
      } else {
        displayName = "Unknown";
      }

      const username = agent.username || "";

      // Search in first name, last name, display name, and username separately
      const firstNameStr = (firstName || "").trim();
      const lastNameStr = (lastName || "").trim();
      const firstNameLower = firstNameStr.toLowerCase();
      const lastNameLower = lastNameStr.toLowerCase();
      const displayNameLower = displayName.toLowerCase();
      const usernameLower = username.toLowerCase();

      // Check if search term matches any part (first name, last name, full name, or username)
      // Check first name separately - must have content and match
      const matchesFirstName =
        firstNameStr.length > 0 && firstNameLower.includes(searchTerm);
      // Check last name separately - must have content and match
      const matchesLastName =
        lastNameStr.length > 0 && lastNameLower.includes(searchTerm);
      // Check full display name
      const matchesDisplayName = displayNameLower.includes(searchTerm);
      // Check username
      const matchesUsername = usernameLower.includes(searchTerm);

      if (
        !matchesFirstName &&
        !matchesLastName &&
        !matchesDisplayName &&
        !matchesUsername
      ) {
        return false;
      }
    }

    // Filter by status
    if (
      selectedStatuses.length > 0 &&
      !selectedStatuses.includes(agent.status)
    ) {
      return false;
    }

    // Filter by active queues
    if (selectedQueues.length > 0) {
      const agentQueueIds = agent.activeQueueIds || [];
      const hasMatchingQueue = selectedQueues.some((queueId) =>
        agentQueueIds.includes(queueId)
      );
      if (!hasMatchingQueue) {
        return false;
      }
    }

    return true;
  });

  return (
    <div className="px-4 lg:px-4 py-0 pb-2 space-y-6">
      {/* Connection Status */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <IconActivity className="size-6 text-telnyx-green" />
          Supervisory Console
        </h1>
        <div className="flex items-center gap-3">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="agents" className="flex items-center gap-2">
                <IconUsers className="h-4 w-4" />
                Agents
              </TabsTrigger>
              <TabsTrigger value="queues" className="flex items-center gap-2">
                <IconTrendingUp className="h-4 w-4" />
                Queues
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            onClick={() => {
              setLoading(true);
              loadDashboard();
            }}
            disabled={loading}
            size="sm"
            className="flex items-center gap-2"
          >
            <IconRefresh
              className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
            />
            {loading ? "Loading..." : "Refresh"}
          </Button>
          <Badge
            variant="outline"
            className={`flex items-center gap-1.5 px-3 py-1.5 font-semibold ${
              connected
                ? "border-green-500 text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20"
                : "border-red-500 text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/20"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                connected ? "bg-green-500 animate-pulse" : "bg-red-500"
              }`}
            />
            {connected ? "Connected" : "Disconnected"}
          </Badge>
        </div>
      </div>

      {/* Overall Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <Card className="border-l-4 border-l-blue-500 bg-blue-50/50 dark:bg-blue-950/20">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 pt-0 px-4">
            <CardTitle className="text-sm font-medium text-blue-700 dark:text-blue-300">
              Total Calls Today
            </CardTitle>
            <IconPhone className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          </CardHeader>
          <CardContent className="pt-0 px-4 pb-3">
            <div className="text-4xl font-bold text-blue-900 dark:text-blue-100">
              {overall.calls?.total || 0}
            </div>
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">
              {overall.calls?.answered || 0} answered,{" "}
              {overall.calls?.abandoned || 0} abandoned
            </p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-green-500 bg-green-50/50 dark:bg-green-950/20">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 pt-0 px-4">
            <CardTitle className="text-sm font-medium text-green-700 dark:text-green-300">
              Active Agents
            </CardTitle>
            <IconUsers className="h-4 w-4 text-green-600 dark:text-green-400" />
          </CardHeader>
          <CardContent className="pt-0 px-4 pb-3">
            <div className="text-4xl font-bold text-green-900 dark:text-green-100">
              {overall.agents?.totalActive || 0}
            </div>
            <p className="text-xs text-green-600 dark:text-green-400 mt-0.5">
              {overall.agents?.available || 0} available,{" "}
              {overall.agents?.busy || 0} busy
            </p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-purple-500 bg-purple-50/50 dark:bg-purple-950/20">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 pt-0 px-4">
            <CardTitle className="text-sm font-medium text-purple-700 dark:text-purple-300">
              Active Calls
            </CardTitle>
            <IconActivity className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          </CardHeader>
          <CardContent className="pt-0 px-4 pb-3">
            <div className="text-4xl font-bold text-purple-900 dark:text-purple-100">
              {overall.calls?.active || 0}
            </div>
            <p className="text-xs text-purple-600 dark:text-purple-400 mt-0.5">
              {overall.queues?.totalWaitingCalls || 0} waiting in queues
            </p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-orange-500 bg-orange-50/50 dark:bg-orange-950/20">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 pt-0 px-4">
            <CardTitle className="text-sm font-medium text-orange-700 dark:text-orange-300">
              Avg Wait Time
            </CardTitle>
            <IconClock className="h-4 w-4 text-orange-600 dark:text-orange-400" />
          </CardHeader>
          <CardContent className="pt-0 px-4 pb-3">
            <div className="text-4xl font-bold text-orange-900 dark:text-orange-100">
              {Math.round(overall.calls?.avgWaitTimeSeconds || 0)}s
            </div>
            <p className="text-xs text-orange-600 dark:text-orange-400 mt-0.5">
              Avg handle: {Math.round(overall.calls?.avgHandleTimeSeconds || 0)}
              s
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Statistics Section */}
      <Card className="mb-0 flex flex-col h-[calc(100vh-360px)] min-h-[100px]">
        <CardHeader className="flex-shrink-0">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              {selectedQueue ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelectedQueue(null);
                      setQueueCalls([]);
                    }}
                    className="mr-2 -ml-2"
                  >
                    <IconArrowLeft className="h-4 w-4 mr-1" />
                    Back
                  </Button>
                  <IconTrendingUp className="size-5" />
                  {selectedQueue.displayName || selectedQueue.name} - Calls
                </>
              ) : selectedAgentDetail ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelectedAgentDetail(null);
                      setAgentCalls([]);
                      setAgentActiveCalls([]);
                      setAgentTimeTracking(null);
                    }}
                    className="mr-2 -ml-2"
                  >
                    <IconArrowLeft className="h-4 w-4 mr-1" />
                    Back
                  </Button>
                  <IconUsers className="size-5" />
                  {selectedAgentDetail.name} - Calls
                </>
              ) : activeTab === "agents" ? (
                <>
                  <IconUsers className="size-5" />
                  Agent Statistics
                </>
              ) : (
                <>
                  <IconTrendingUp className="size-5" />
                  Queue Statistics
                </>
              )}
            </CardTitle>
            {data?.timestamp && (
              <div className="text-xs text-muted-foreground">
                Last updated: {new Date(data.timestamp).toLocaleString()}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto min-h-0 pb-2 px-6">
          {selectedQueue ? (
            <>
              {loadingQueueCalls ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : (
                <div className="overflow-x-auto h-full -mx-6 px-6">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>From</TableHead>
                        <TableHead>To</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Agent</TableHead>
                        <TableHead>Wait Time</TableHead>
                        <TableHead>Talk Time</TableHead>
                        <TableHead>Waiting Reason</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {queueCalls.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={8}
                            className="text-center text-muted-foreground py-4"
                          >
                            No calls found for this queue
                          </TableCell>
                        </TableRow>
                      ) : (
                        queueCalls.map((call) => {
                          // Calculate real-time wait time
                          const waitTimeSeconds = call.enqueuedAt
                            ? Math.max(
                                0,
                                Math.floor(
                                  (currentTime.getTime() -
                                    new Date(call.enqueuedAt).getTime()) /
                                    1000
                                )
                              )
                            : call.waitSeconds || 0;

                          // Calculate real-time talk time
                          const talkTimeSeconds = call.answeredAt
                            ? Math.max(
                                0,
                                Math.floor(
                                  (currentTime.getTime() -
                                    new Date(call.answeredAt).getTime()) /
                                    1000
                                )
                              )
                            : call.talkSeconds || 0;

                          // Determine state - if answered but state is still ringing, show as connected
                          const displayState =
                            call.answeredAt &&
                            (call.state === "ringing" ||
                              call.state === "bridging")
                              ? "connected"
                              : call.state;

                          const stateColor =
                            displayState === "completed"
                              ? "text-green-600 border-green-600 dark:text-green-400 dark:border-green-400"
                              : displayState === "abandoned"
                              ? "text-red-600 border-red-600 dark:text-red-400 dark:border-red-400"
                              : displayState === "answered" ||
                                displayState === "connected" ||
                                displayState === "active"
                              ? "text-blue-600 border-blue-600 dark:text-blue-400 dark:border-blue-400"
                              : displayState === "enqueued" ||
                                displayState === "queued" ||
                                displayState === "ringing"
                              ? "text-yellow-600 border-yellow-600 dark:text-yellow-400 dark:border-yellow-400"
                              : "text-gray-600 border-gray-600 dark:text-gray-400 dark:border-gray-400";

                          // Determine waiting reason
                          const getWaitingReason = () => {
                            if (
                              !displayState ||
                              !["queued", "enqueued", "ringing"].includes(
                                displayState
                              )
                            ) {
                              return null;
                            }

                            if (!call.agentUsername) {
                              // Check if it's a skills matching issue
                              const routingMetadata =
                                call.routingMetadata || {};
                              const skillMatch = routingMetadata.skillMatch;
                              const requiredSkills = call.requiredSkills || {};

                              if (
                                skillMatch &&
                                skillMatch.matchRatio !== undefined &&
                                skillMatch.matchRatio < 1 &&
                                Object.keys(requiredSkills).length > 0
                              ) {
                                return {
                                  type: "no_skills_matching",
                                  skillMatch,
                                  requiredSkills,
                                };
                              }

                              return { type: "no_agents_available" };
                            }

                            return null;
                          };

                          const waitingReason = getWaitingReason();

                          return (
                            <TableRow key={call.id}>
                              <TableCell>{call.fromNumber || "—"}</TableCell>
                              <TableCell>{call.toNumber || "—"}</TableCell>
                              <TableCell>
                                <span
                                  className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium border ${stateColor} bg-transparent`}
                                >
                                  {displayState || "unknown"}
                                </span>
                              </TableCell>
                              <TableCell>
                                {call.agentName || call.agentUsername || "—"}
                              </TableCell>
                              <TableCell>
                                {waitTimeSeconds > 0
                                  ? `${Math.round(waitTimeSeconds)}s`
                                  : "—"}
                              </TableCell>
                              <TableCell>
                                {talkTimeSeconds > 0
                                  ? `${Math.round(talkTimeSeconds)}s`
                                  : "—"}
                              </TableCell>
                              <TableCell>
                                {waitingReason ? (
                                  <div className="flex items-center gap-2">
                                    <span>
                                      {waitingReason.type ===
                                      "no_skills_matching"
                                        ? "Skills not matched"
                                        : "No agents available"}
                                    </span>
                                    {waitingReason.type ===
                                      "no_skills_matching" && (
                                      <button
                                        onClick={async () => {
                                          setSelectedCallForSkills(call);
                                          setSkillMatchDialogOpen(true);
                                          // Fetch available agents for the queue
                                          if (selectedQueue?.id) {
                                            setLoadingAgentsForSkills(true);
                                            try {
                                              const res = await fetch(
                                                `/api/contact-center/queues/${selectedQueue.id}/agents`,
                                                { cache: "no-store" }
                                              );
                                              if (res.ok) {
                                                const data = await res.json();
                                                setAvailableAgentsForSkills(
                                                  data.agents || []
                                                );
                                              }
                                            } catch (error) {
                                              console.error(
                                                "[Monitor] Error loading agents:",
                                                error
                                              );
                                            } finally {
                                              setLoadingAgentsForSkills(false);
                                            }
                                          }
                                        }}
                                        className="text-muted-foreground hover:text-foreground transition-colors"
                                        title="View skill matching details"
                                      >
                                        <IconInfoCircle className="h-4 w-4" />
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  "—"
                                )}
                              </TableCell>
                              <TableCell>
                                <button
                                  onClick={() => {
                                    setSelectedCallForSupervision(call);
                                    setSupervisionModalOpen(true);
                                  }}
                                  className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
                                  title="Supervise this call"
                                >
                                  <IconEye className="h-4 w-4" />
                                </button>
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          ) : selectedAgentDetail ? (
            <>
              {loadingAgentCalls ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Agent Stats Summary */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <Card className="border-l-4 border-l-blue-500 bg-blue-50/50 dark:bg-blue-950/20">
                      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 pt-0 px-4">
                        <CardTitle className="text-sm font-medium text-blue-700 dark:text-blue-300">
                          Time on Calls
                        </CardTitle>
                        <IconPhone className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                      </CardHeader>
                      <CardContent className="pt-0 px-4 pb-3">
                        <div className="text-2xl font-bold text-blue-900 dark:text-blue-100">
                          {agentTimeTracking
                            ? formatTime(agentTimeTracking.callSeconds)
                            : "0h 0m"}
                        </div>
                        <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">
                          Today
                        </p>
                      </CardContent>
                    </Card>
                    <Card className="border-l-4 border-l-orange-500 bg-orange-50/50 dark:bg-orange-950/20">
                      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 pt-0 px-4">
                        <CardTitle className="text-sm font-medium text-orange-700 dark:text-orange-300">
                          Time on Break
                        </CardTitle>
                        <IconClock className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                      </CardHeader>
                      <CardContent className="pt-0 px-4 pb-3">
                        <div className="text-2xl font-bold text-orange-900 dark:text-orange-100">
                          {agentTimeTracking
                            ? formatTime(agentTimeTracking.breakSeconds)
                            : "0h 0m"}
                        </div>
                        <p className="text-xs text-orange-600 dark:text-orange-400 mt-0.5">
                          Today
                        </p>
                      </CardContent>
                    </Card>
                    <Card className="border-l-4 border-l-purple-500 bg-purple-50/50 dark:bg-purple-950/20">
                      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 pt-0 px-4">
                        <CardTitle className="text-sm font-medium text-purple-700 dark:text-purple-300">
                          Total Work Time
                        </CardTitle>
                        <IconActivity className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                      </CardHeader>
                      <CardContent className="pt-0 px-4 pb-3">
                        <div className="text-2xl font-bold text-purple-900 dark:text-purple-100">
                          {agentTimeTracking
                            ? formatTime(agentTimeTracking.workSeconds)
                            : "0h 0m"}
                        </div>
                        <p className="text-xs text-purple-600 dark:text-purple-400 mt-0.5">
                          Today
                        </p>
                      </CardContent>
                    </Card>
                    <Card className="border-l-4 border-l-green-500 bg-green-50/50 dark:bg-green-950/20">
                      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 pt-0 px-4">
                        <CardTitle className="text-sm font-medium text-green-700 dark:text-green-300">
                          Calls Handled
                        </CardTitle>
                        <IconPhone className="h-4 w-4 text-green-600 dark:text-green-400" />
                      </CardHeader>
                      <CardContent className="pt-0 px-4 pb-3">
                        <div className="text-2xl font-bold text-green-900 dark:text-green-100">
                          {(() => {
                            const today = new Date().toDateString();
                            return agentCalls.filter((call) => {
                              const callDate = call.createdAt
                                ? new Date(call.createdAt).toDateString()
                                : null;
                              return (
                                callDate === today &&
                                call.state &&
                                ["completed", "answered"].includes(
                                  call.state.toLowerCase()
                                )
                              );
                            }).length;
                          })()}
                        </div>
                        <p className="text-xs text-green-600 dark:text-green-400 mt-0.5">
                          Today
                        </p>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Active Calls Section */}
                  {agentActiveCalls.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-lg font-semibold">Active Calls</h3>
                        <div className="flex gap-2">
                          {agentActiveCalls.map((call) => (
                            <Button
                              key={call.id}
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                // TODO: Implement monitor live call functionality
                                notify({
                                  title: "Monitor Call",
                                  description: `Monitoring call ${
                                    call.callControlId?.slice(0, 8) ||
                                    call.id?.slice(0, 8)
                                  } - Feature coming soon`,
                                  variant: "info",
                                });
                              }}
                              className="flex items-center gap-2"
                            >
                              <IconPhone className="h-4 w-4" />
                              Monitor{" "}
                              {call.callControlId?.slice(0, 8) ||
                                call.id?.slice(0, 8)}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Call ID</TableHead>
                              <TableHead>From</TableHead>
                              <TableHead>To</TableHead>
                              <TableHead>Queue</TableHead>
                              <TableHead>State</TableHead>
                              <TableHead>Answered</TableHead>
                              <TableHead>Talk Time</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {agentActiveCalls.map((call) => {
                              const stateColor =
                                call.state === "answered" ||
                                call.state === "active"
                                  ? "text-green-600 border-green-600 dark:text-green-400 dark:border-green-400"
                                  : call.state === "ringing" ||
                                    call.state === "bridging"
                                  ? "text-yellow-600 border-yellow-600 dark:text-yellow-400 dark:border-yellow-400"
                                  : call.state === "hold"
                                  ? "text-orange-600 border-orange-600 dark:text-orange-400 dark:border-orange-400"
                                  : "text-gray-600 border-gray-600 dark:text-gray-400 dark:border-gray-400";

                              return (
                                <TableRow key={call.id}>
                                  <TableCell className="font-mono text-xs">
                                    {call.callControlId?.slice(0, 8) ||
                                      call.id?.slice(0, 8) ||
                                      "—"}
                                  </TableCell>
                                  <TableCell>
                                    {call.fromNumber || "—"}
                                  </TableCell>
                                  <TableCell>{call.toNumber || "—"}</TableCell>
                                  <TableCell>{call.queueName || "—"}</TableCell>
                                  <TableCell>
                                    <span
                                      className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium border ${stateColor} bg-transparent`}
                                    >
                                      {call.state || "unknown"}
                                    </span>
                                  </TableCell>
                                  <TableCell className="text-xs">
                                    {call.answeredAt
                                      ? new Date(
                                          call.answeredAt
                                        ).toLocaleString()
                                      : "—"}
                                  </TableCell>
                                  <TableCell>
                                    {call.talkSeconds > 0
                                      ? `${Math.round(call.talkSeconds)}s`
                                      : "—"}
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}

                  {/* All Calls Table */}
                  <div>
                    <h3 className="text-lg font-semibold mb-3">All Calls</h3>
                    <div className="overflow-x-auto h-full -mx-6 px-6">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Call ID</TableHead>
                            <TableHead>From</TableHead>
                            <TableHead>To</TableHead>
                            <TableHead>Queue</TableHead>
                            <TableHead>State</TableHead>
                            <TableHead>Enqueued</TableHead>
                            <TableHead>Answered</TableHead>
                            <TableHead>Completed</TableHead>
                            <TableHead>Wait Time</TableHead>
                            <TableHead>Talk Time</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {agentCalls.length === 0 ? (
                            <TableRow>
                              <TableCell
                                colSpan={10}
                                className="text-center text-muted-foreground py-4"
                              >
                                No calls found
                              </TableCell>
                            </TableRow>
                          ) : (
                            agentCalls.map((call) => {
                              const stateColor =
                                call.state === "completed"
                                  ? "text-green-600 border-green-600 dark:text-green-400 dark:border-green-400"
                                  : call.state === "abandoned"
                                  ? "text-red-600 border-red-600 dark:text-red-400 dark:border-red-400"
                                  : call.state === "answered" ||
                                    call.state === "active"
                                  ? "text-blue-600 border-blue-600 dark:text-blue-400 dark:border-blue-400"
                                  : call.state === "enqueued" ||
                                    call.state === "ringing"
                                  ? "text-yellow-600 border-yellow-600 dark:text-yellow-400 dark:border-yellow-400"
                                  : "text-gray-600 border-gray-600 dark:text-gray-400 dark:border-gray-400";

                              return (
                                <TableRow key={call.id}>
                                  <TableCell className="font-mono text-xs">
                                    {call.callControlId?.slice(0, 8) ||
                                      call.id?.slice(0, 8) ||
                                      "—"}
                                  </TableCell>
                                  <TableCell>
                                    {call.fromNumber || "—"}
                                  </TableCell>
                                  <TableCell>{call.toNumber || "—"}</TableCell>
                                  <TableCell>{call.queueName || "—"}</TableCell>
                                  <TableCell>
                                    <span
                                      className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium border ${stateColor} bg-transparent`}
                                    >
                                      {call.state || "unknown"}
                                    </span>
                                  </TableCell>
                                  <TableCell className="text-xs">
                                    {call.enqueuedAt
                                      ? new Date(
                                          call.enqueuedAt
                                        ).toLocaleString()
                                      : "—"}
                                  </TableCell>
                                  <TableCell className="text-xs">
                                    {call.answeredAt
                                      ? new Date(
                                          call.answeredAt
                                        ).toLocaleString()
                                      : "—"}
                                  </TableCell>
                                  <TableCell className="text-xs">
                                    {call.completedAt
                                      ? new Date(
                                          call.completedAt
                                        ).toLocaleString()
                                      : call.abandonedAt
                                      ? new Date(
                                          call.abandonedAt
                                        ).toLocaleString()
                                      : "—"}
                                  </TableCell>
                                  <TableCell>
                                    {call.waitSeconds > 0
                                      ? `${Math.round(call.waitSeconds)}s`
                                      : "—"}
                                  </TableCell>
                                  <TableCell>
                                    {call.talkSeconds > 0
                                      ? `${Math.round(call.talkSeconds)}s`
                                      : "—"}
                                  </TableCell>
                                </TableRow>
                              );
                            })
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : activeTab === "agents" ? (
            <>
              {loading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Filters */}
                  <div className="flex flex-wrap items-center gap-3 pb-2 border-b">
                    <div className="flex items-center gap-2">
                      <IconFilter className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">Filters:</span>
                    </div>
                    <Input
                      placeholder="Search by agent name..."
                      value={agentNameFilter}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value.length <= 50) {
                          setAgentNameFilter(value);
                        }
                      }}
                      maxLength={50}
                      className="h-9 w-[200px]"
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="h-9">
                          Status
                          {selectedStatuses.length > 0 && (
                            <Badge
                              variant="secondary"
                              className="ml-2 h-5 min-w-5 px-1.5"
                            >
                              {selectedStatuses.length}
                            </Badge>
                          )}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-56">
                        <DropdownMenuLabel>Filter by Status</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {uniqueStatuses.map((status) => {
                          const statusInfo = statusMeta[status] || {};
                          const StatusIcon =
                            STATUS_ICON_MAP[statusInfo.icon] ||
                            STATUS_NAME_ICON_FALLBACK[status] ||
                            STATUS_ICON_MAP[DEFAULT_STATUS_ICON];
                          const statusColor =
                            status === "Available"
                              ? "text-green-600 border-green-600 dark:text-green-400 dark:border-green-400"
                              : status === "Busy"
                              ? "text-orange-600 border-orange-600 dark:text-orange-400 dark:border-orange-400"
                              : status === "Away"
                              ? "text-yellow-600 border-yellow-600 dark:text-yellow-400 dark:border-yellow-400"
                              : "text-gray-600 border-gray-600 dark:text-gray-400 dark:border-gray-400";
                          const statusStyle = statusInfo.color
                            ? {
                                color: statusInfo.color,
                                borderColor: statusInfo.color,
                              }
                            : undefined;

                          return (
                            <DropdownMenuCheckboxItem
                              key={status}
                              checked={selectedStatuses.includes(status)}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setSelectedStatuses([
                                    ...selectedStatuses,
                                    status,
                                  ]);
                                } else {
                                  setSelectedStatuses(
                                    selectedStatuses.filter((s) => s !== status)
                                  );
                                }
                              }}
                              className="flex items-center justify-between gap-2 [&>span:first-child]:hidden"
                            >
                              <div className="flex items-center gap-2 flex-1 min-w-0">
                                <StatusIcon
                                  className="h-4 w-4 shrink-0"
                                  style={
                                    statusInfo.color
                                      ? { color: statusInfo.color }
                                      : undefined
                                  }
                                />
                                <span className="text-left">{status}</span>
                              </div>
                              {selectedStatuses.includes(status) && (
                                <IconCheck className="h-4 w-4 shrink-0 text-telnyx-green" />
                              )}
                            </DropdownMenuCheckboxItem>
                          );
                        })}
                        {selectedStatuses.length > 0 && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuCheckboxItem
                              onCheckedChange={() => setSelectedStatuses([])}
                              checked={false}
                            >
                              Clear all
                            </DropdownMenuCheckboxItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="h-9">
                          Active Queues
                          {selectedQueues.length > 0 && (
                            <Badge
                              variant="secondary"
                              className="ml-2 h-5 min-w-5 px-1.5"
                            >
                              {selectedQueues.length}
                            </Badge>
                          )}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-56">
                        <DropdownMenuLabel>
                          Filter by Active Queues
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {uniqueQueues.length === 0 ? (
                          <div className="px-2 py-1.5 text-sm text-muted-foreground">
                            No queues available
                          </div>
                        ) : (
                          uniqueQueues.map((queueId) => (
                            <DropdownMenuCheckboxItem
                              key={queueId}
                              checked={selectedQueues.includes(queueId)}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setSelectedQueues([
                                    ...selectedQueues,
                                    queueId,
                                  ]);
                                } else {
                                  setSelectedQueues(
                                    selectedQueues.filter((q) => q !== queueId)
                                  );
                                }
                              }}
                            >
                              {queueNamesMap.get(queueId) || queueId}
                            </DropdownMenuCheckboxItem>
                          ))
                        )}
                        {selectedQueues.length > 0 && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuCheckboxItem
                              onCheckedChange={() => setSelectedQueues([])}
                              checked={false}
                            >
                              Clear all
                            </DropdownMenuCheckboxItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setAgentNameFilter("");
                        setSelectedStatuses([]);
                        setSelectedQueues([]);
                      }}
                      className="h-9"
                      disabled={
                        !agentNameFilter &&
                        selectedStatuses.length === 0 &&
                        selectedQueues.length === 0
                      }
                    >
                      <IconX className="h-4 w-4 mr-1" />
                      Clear filters
                    </Button>
                  </div>

                  {/* Agents Table */}
                  {agents.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      {allAgents.length === 0
                        ? "No agents with activated queues"
                        : "No agents match the selected filters"}
                    </p>
                  ) : (
                    <div className="overflow-x-auto h-full -mx-6 px-6">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Agent</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Active Queues</TableHead>
                            <TableHead>Current Calls</TableHead>
                            <TableHead>Today: Total</TableHead>
                            <TableHead>Today: Completed</TableHead>
                            <TableHead>Avg Talk Time</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {agents.map((agent) => {
                            // Prefer first/last name, fallback to username but extract name part if it's an email
                            let displayName = "";
                            // Check both camelCase and snake_case properties
                            const firstName =
                              agent.firstName || agent.first_name || null;
                            const lastName =
                              agent.lastName || agent.last_name || null;

                            if (firstName || lastName) {
                              displayName = `${firstName || ""} ${
                                lastName || ""
                              }`.trim();
                            } else if (agent.username) {
                              // If username is an email, extract the name part before @
                              const emailMatch =
                                agent.username.match(/^([^@]+)@/);
                              displayName = emailMatch
                                ? emailMatch[1]
                                : agent.username;
                            } else {
                              displayName = "Unknown";
                            }
                            const statusInfo = statusMeta[agent.status] || {};
                            const statusColor =
                              agent.status === "Available"
                                ? "text-green-600 border-green-600 dark:text-green-400 dark:border-green-400"
                                : agent.status === "Busy"
                                ? "text-orange-600 border-orange-600 dark:text-orange-400 dark:border-orange-400"
                                : agent.status === "Away"
                                ? "text-yellow-600 border-yellow-600 dark:text-yellow-400 dark:border-yellow-400"
                                : "text-gray-600 border-gray-600 dark:text-gray-400 dark:border-gray-400";
                            const StatusIcon =
                              STATUS_ICON_MAP[statusInfo.icon] ||
                              STATUS_NAME_ICON_FALLBACK[agent.status] ||
                              STATUS_ICON_MAP[DEFAULT_STATUS_ICON];
                            const statusStyle = statusInfo.color
                              ? {
                                  color: statusInfo.color,
                                  borderColor: statusInfo.color,
                                }
                              : undefined;

                            return (
                              <TableRow key={agent.userId}>
                                <TableCell className="font-medium">
                                  <button
                                    onClick={() => loadAgentCalls(agent.userId)}
                                    className="text-left text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                                  >
                                    {displayName}
                                  </button>
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-medium border min-w-[96px] justify-center ${
                                        statusInfo.color ? "" : statusColor
                                      } bg-transparent`}
                                      style={statusStyle}
                                    >
                                      <StatusIcon
                                        className="h-3.5 w-3.5"
                                        style={
                                          statusInfo.color
                                            ? { color: statusInfo.color }
                                            : undefined
                                        }
                                      />
                                      {agent.status}
                                    </span>
                                    <button
                                      onClick={() => {
                                        setSelectedAgent(agent);
                                        setStatusDialogOpen(true);
                                      }}
                                      className="text-muted-foreground hover:text-foreground transition-colors"
                                      title="Change status"
                                    >
                                      <IconInfoCircle className="h-4 w-4" />
                                    </button>
                                  </div>
                                </TableCell>
                                <TableCell
                                  className={
                                    highlightedCells.has(
                                      `agent-${String(agent.userId)}-queues`
                                    )
                                      ? "border border-orange-400 dark:border-orange-500 rounded transition-colors duration-1000"
                                      : ""
                                  }
                                >
                                  <div className="flex items-center gap-2">
                                    <span>{agent.activeQueues || 0}</span>
                                    <button
                                      onClick={async () => {
                                        setSelectedAgent(agent);
                                        setQueueDialogOpen(true);
                                        await loadAgentQueues(agent.userId);
                                      }}
                                      className="text-muted-foreground hover:text-foreground transition-colors"
                                      title="View queue assignments"
                                    >
                                      <IconInfoCircle className="h-4 w-4" />
                                    </button>
                                  </div>
                                </TableCell>
                                <TableCell
                                  className={
                                    highlightedCells.has(
                                      `agent-${String(agent.userId)}-calls`
                                    )
                                      ? "border border-orange-400 dark:border-orange-500 rounded transition-colors duration-1000"
                                      : ""
                                  }
                                >
                                  {agent.currentCalls} /{" "}
                                  {agent.maxConcurrentCalls}
                                </TableCell>
                                <TableCell>
                                  {agent.today?.totalCalls || 0}
                                </TableCell>
                                <TableCell>
                                  {agent.today?.completedCalls || 0}
                                </TableCell>
                                <TableCell>
                                  {agent.today?.avgTalkTimeSeconds
                                    ? `${Math.round(
                                        agent.today.avgTalkTimeSeconds
                                      )}s`
                                    : "—"}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              {loading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : queues.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No queues configured or enabled
                </p>
              ) : (
                <div className="overflow-x-auto h-full -mx-6 px-6">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Queue Name</TableHead>
                        <TableHead>Waiting</TableHead>
                        <TableHead>Active</TableHead>
                        <TableHead>Agents</TableHead>
                        <TableHead>Longest Wait</TableHead>
                        <TableHead>Today: Total</TableHead>
                        <TableHead>Today: Answered</TableHead>
                        <TableHead>Service Level</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {queues.map((queue) => (
                        <TableRow key={queue.queueId}>
                          <TableCell className="font-medium">
                            <button
                              onClick={() => loadQueueCalls(queue.queueId)}
                              className="text-left text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                            >
                              {queue.queueName || queue.queueId}
                            </button>
                          </TableCell>
                          <TableCell
                            className={
                              highlightedCells.has(
                                `queue-${queue.queueId}-waiting`
                              )
                                ? "border border-orange-400 dark:border-orange-500 rounded transition-colors duration-1000"
                                : ""
                            }
                          >
                            <Badge
                              variant={
                                queue.realtime?.waitingCalls > 10
                                  ? "destructive"
                                  : queue.realtime?.waitingCalls > 5
                                  ? "secondary"
                                  : "outline"
                              }
                            >
                              {queue.realtime?.waitingCalls || 0}
                            </Badge>
                          </TableCell>
                          <TableCell
                            className={
                              highlightedCells.has(
                                `queue-${queue.queueId}-active`
                              )
                                ? "border border-orange-400 dark:border-orange-500 rounded transition-colors duration-1000"
                                : ""
                            }
                          >
                            {queue.realtime?.activeCalls || 0}
                          </TableCell>
                          <TableCell>
                            <div className="text-xs">
                              <div className="text-green-600">
                                {queue.agents?.available || 0} avail
                              </div>
                              <div className="text-orange-600">
                                {queue.agents?.busy || 0} busy
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            {queue.realtime?.longestWaitSeconds
                              ? `${Math.round(
                                  queue.realtime.longestWaitSeconds
                                )}s`
                              : "—"}
                          </TableCell>
                          <TableCell>{queue.today?.totalCalls || 0}</TableCell>
                          <TableCell>
                            {queue.today?.answeredCalls || 0}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              {queue.today?.serviceLevelPercentage >= 80 ? (
                                <Badge
                                  variant="default"
                                  className="bg-green-600"
                                >
                                  {queue.today?.serviceLevelPercentage.toFixed(
                                    1
                                  )}
                                  %
                                </Badge>
                              ) : queue.today?.serviceLevelPercentage >= 60 ? (
                                <Badge variant="secondary">
                                  {queue.today?.serviceLevelPercentage.toFixed(
                                    1
                                  )}
                                  %
                                </Badge>
                              ) : (
                                <Badge variant="destructive">
                                  {queue.today?.serviceLevelPercentage.toFixed(
                                    1
                                  )}
                                  %
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Status Change Dialog */}
      <Dialog open={statusDialogOpen} onOpenChange={setStatusDialogOpen}>
        <DialogContent
          className="max-w-md"
          style={{
            backgroundColor: "var(--sheet, var(--muted))",
            color: "var(--sheet-foreground, var(--foreground))",
            borderColor: "var(--sheet-border, var(--border))",
          }}
        >
          <DialogHeader>
            <DialogTitle>
              Change Agent Status
              {selectedAgent && (
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  {selectedAgent.firstName || selectedAgent.first_name
                    ? `${selectedAgent.firstName || selectedAgent.first_name} ${
                        selectedAgent.lastName || selectedAgent.last_name || ""
                      }`.trim()
                    : selectedAgent.username}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>
              Select a new status for this agent.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {availableStatuses.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                Loading statuses...
              </p>
            ) : (
              <div className="space-y-2">
                {availableStatuses.map((status) => {
                  const statusInfo = statusMeta[status.name] || {};
                  const StatusIcon =
                    STATUS_ICON_MAP[statusInfo.icon] ||
                    STATUS_NAME_ICON_FALLBACK[status.name] ||
                    STATUS_ICON_MAP[DEFAULT_STATUS_ICON];
                  const isCurrentStatus = selectedAgent?.status === status.name;
                  const statusColor =
                    status.name === "Available"
                      ? "text-green-600 border-green-600 dark:text-green-400 dark:border-green-400"
                      : status.name === "Busy"
                      ? "text-orange-600 border-orange-600 dark:text-orange-400 dark:border-orange-400"
                      : status.name === "Away"
                      ? "text-yellow-600 border-yellow-600 dark:text-yellow-400 dark:border-yellow-400"
                      : "text-gray-600 border-gray-600 dark:text-gray-400 dark:border-gray-400";
                  const statusStyle = statusInfo.color
                    ? {
                        color: statusInfo.color,
                        borderColor: statusInfo.color,
                      }
                    : undefined;

                  return (
                    <button
                      key={status.name}
                      onClick={() => changeAgentStatus(status.name)}
                      disabled={isCurrentStatus}
                      className={`w-full flex items-center justify-between p-3 border rounded-lg transition-colors ${
                        isCurrentStatus
                          ? "bg-muted cursor-not-allowed opacity-60"
                          : "hover:bg-accent cursor-pointer"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <StatusIcon
                          className="h-5 w-5"
                          style={
                            statusInfo.color
                              ? { color: statusInfo.color }
                              : undefined
                          }
                        />
                        <div className="text-left">
                          <div className="font-medium">{status.name}</div>
                          {status.description && (
                            <div className="text-xs text-muted-foreground">
                              {status.description}
                            </div>
                          )}
                        </div>
                      </div>
                      {isCurrentStatus && (
                        <Badge variant="outline" className="text-xs">
                          Current
                        </Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Queue Management Dialog */}
      <Dialog open={queueDialogOpen} onOpenChange={setQueueDialogOpen}>
        <DialogContent
          className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col p-0"
          style={{
            backgroundColor: "var(--sheet, var(--muted))",
            color: "var(--sheet-foreground, var(--foreground))",
            borderColor: "var(--sheet-border, var(--border))",
          }}
        >
          <DialogHeader className="px-6 py-4 border-b">
            <DialogTitle>
              Queue Assignments
              {selectedAgent && (
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  {selectedAgent.firstName || selectedAgent.first_name
                    ? `${selectedAgent.firstName || selectedAgent.first_name} ${
                        selectedAgent.lastName || selectedAgent.last_name || ""
                      }`.trim()
                    : selectedAgent.username}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>
              Manage queue activations for this agent. Only activated queues
              will receive calls.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto min-h-0">
            <Card className="mx-5 my-4">
              <CardContent className="p-6">
                {loadingQueues ? (
                  <div className="space-y-2 py-4">
                    <div className="h-10 bg-muted animate-pulse rounded" />
                    <div className="h-10 bg-muted animate-pulse rounded" />
                    <div className="h-10 bg-muted animate-pulse rounded" />
                  </div>
                ) : agentQueues.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No queues assigned to this agent
                  </p>
                ) : (
                  <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-2">
                    {agentQueues.map((queue) => (
                      <div
                        key={queue.id}
                        className="flex items-center justify-between p-3 border rounded-lg"
                      >
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">
                              {queue.displayName}
                            </span>
                            {queue.isActivated ? (
                              <Badge
                                variant="outline"
                                className="text-green-600 border-green-600 dark:text-green-400 dark:border-green-400"
                              >
                                <IconCheck className="h-3 w-3 mr-1" />
                                Active
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-gray-600 border-gray-600 dark:text-gray-400 dark:border-gray-400"
                              >
                                <IconX className="h-3 w-3 mr-1" />
                                Inactive
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                            <span>Type: {queue.routingType || "FIFO"}</span>
                            {queue.priority !== null && (
                              <span>Priority: {queue.priority}</span>
                            )}
                          </div>
                        </div>
                        <Switch
                          checked={queue.isActivated}
                          onCheckedChange={() =>
                            toggleQueueActivation(queue.id, queue.isActivated)
                          }
                          className="ml-4"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </DialogContent>
      </Dialog>

      {/* Skill Matching Details Dialog */}
      <Dialog
        open={skillMatchDialogOpen}
        onOpenChange={(open) => {
          setSkillMatchDialogOpen(open);
          if (!open) {
            setSelectedCallForSkills(null);
            setAvailableAgentsForSkills([]);
          }
        }}
      >
        <DialogContent
          className="max-w-3xl max-h-[80vh] overflow-y-auto"
          style={{
            backgroundColor: "var(--sheet, var(--muted))",
            color: "var(--sheet-foreground, var(--foreground))",
            borderColor: "var(--sheet-border, var(--border))",
          }}
        >
          <DialogHeader>
            <DialogTitle>Skills Not Matched</DialogTitle>
            <DialogDescription>
              Required skills for this call and available agents' skills
            </DialogDescription>
          </DialogHeader>
          {selectedCallForSkills && (
            <div className="space-y-4 py-4">
              <div>
                <h4 className="font-semibold mb-2">Required Skills for Call</h4>
                <div className="space-y-1">
                  {Object.keys(selectedCallForSkills.requiredSkills || {})
                    .length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No required skills specified
                    </p>
                  ) : (
                    Object.entries(
                      selectedCallForSkills.requiredSkills || {}
                    ).map(([skillName, requiredLevel]) => (
                      <div
                        key={skillName}
                        className="flex items-center justify-between p-2 border rounded"
                      >
                        <span className="font-medium">{skillName}</span>
                        <Badge variant="outline">
                          Required: {requiredLevel}
                        </Badge>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <h4 className="font-semibold mb-2">Available Agents</h4>
                {loadingAgentsForSkills ? (
                  <div className="space-y-2 py-4">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : availableAgentsForSkills.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No agents available in this queue
                  </p>
                ) : (
                  <div className="space-y-3">
                    {availableAgentsForSkills.map((agent) => {
                      const requiredSkills =
                        selectedCallForSkills.requiredSkills || {};
                      const agentSkills = agent.skills || {};

                      // Calculate which skills are missing or insufficient
                      const skillAnalysis = Object.entries(requiredSkills).map(
                        ([skillName, requiredLevel]) => {
                          const agentLevel = agentSkills[skillName] || 0;
                          const hasSkill = agentLevel >= requiredLevel;
                          return {
                            skillName,
                            requiredLevel,
                            agentLevel,
                            hasSkill,
                            missing: !hasSkill,
                          };
                        }
                      );

                      const missingSkills = skillAnalysis.filter(
                        (s) => s.missing
                      );
                      const hasAllSkills = missingSkills.length === 0;

                      // Build agent display name
                      const agentDisplayName =
                        agent.firstName || agent.lastName
                          ? `${agent.firstName || ""} ${
                              agent.lastName || ""
                            }`.trim()
                          : agent.username || "Unknown";

                      return (
                        <div
                          key={agent.id}
                          className="border rounded-lg p-3 space-y-2"
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <span className="font-medium">
                                {agentDisplayName}
                              </span>
                              <span className="text-sm text-muted-foreground ml-2">
                                ({agent.username})
                              </span>
                            </div>
                            <Badge
                              variant={hasAllSkills ? "default" : "destructive"}
                            >
                              {hasAllSkills
                                ? "Has all skills"
                                : `Missing ${missingSkills.length} skill${
                                    missingSkills.length > 1 ? "s" : ""
                                  }`}
                            </Badge>
                          </div>

                          <div className="space-y-1">
                            {skillAnalysis.map((skill) => (
                              <div
                                key={skill.skillName}
                                className="flex items-center justify-between text-sm"
                              >
                                <span className="flex items-center gap-2">
                                  <span className="font-medium">
                                    {skill.skillName}
                                  </span>
                                  {skill.hasSkill ? (
                                    <IconCheck className="h-4 w-4 text-green-600" />
                                  ) : (
                                    <IconX className="h-4 w-4 text-red-600" />
                                  )}
                                </span>
                                <div className="flex items-center gap-2">
                                  <span className="text-muted-foreground">
                                    Required: {skill.requiredLevel}
                                  </span>
                                  <span
                                    className={
                                      skill.hasSkill
                                        ? "text-green-600 font-medium"
                                        : "text-red-600 font-medium"
                                    }
                                  >
                                    Agent: {skill.agentLevel}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Supervision Modal */}
      <SupervisionModal
        open={supervisionModalOpen}
        onOpenChange={setSupervisionModalOpen}
        call={selectedCallForSupervision}
      />
    </div>
  );
}
