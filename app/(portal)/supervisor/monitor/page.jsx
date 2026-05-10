"use client";

import React, { useEffect, useRef, useState } from "react";
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
  IconStar,
  IconStarFilled,
  IconArrowDown,
  IconChartBar,
  IconSparkles,
  IconPhoneIncoming,
  IconPhoneOutgoing,
  IconGauge,
} from "@tabler/icons-react";
import { ChevronDownIcon } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
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
import { SectionRail, SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import {
  SupervisorPageHeader,
  SupervisorPageShell,
} from "@/components/contact-center/SupervisorPageLayout";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
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
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

const MONITOR_RAIL_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: IconActivity, description: "Live workspace overview" },
  { id: "agents", label: "Agents", icon: IconUsers, description: "Agent status and live calls" },
  { id: "queues", label: "Queues", icon: IconTrendingUp, description: "Queue performance and waiting calls" },
  { id: "graphs", label: "Graphs", icon: IconChartBar, description: "Trend visualizations" },
];

const neutralActionClass = "bg-zinc-950 text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200";

// Component to display skills with relaxation indicator
function RelaxationIndicator({ requiredSkills, relaxedSkills, isRelaxed }) {
  // Use relaxed skills if available, otherwise use original required skills
  const skillsToDisplay = relaxedSkills || requiredSkills;

  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <div className="flex items-center gap-2 cursor-pointer">
          <Badge variant="outline" className="text-xs">
            {Object.keys(requiredSkills).length}{" "}
            {Object.keys(requiredSkills).length === 1 ? "skill" : "skills"}
          </Badge>
          <IconInfoCircle className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
          {isRelaxed && (
            <IconArrowDown className="h-4 w-4 text-red-500" strokeWidth={2.5} />
          )}
        </div>
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <div className="space-y-2">
          <h4 className="text-sm font-semibold mb-3">
            {isRelaxed ? "Required Skills (Relaxed)" : "Required Skills"}
          </h4>
          {Object.entries(skillsToDisplay).map(([skillName, proficiency]) => {
            const originalProficiency = requiredSkills[skillName];
            const isRelaxedSkill =
              isRelaxed && proficiency < originalProficiency;

            return (
              <div
                key={skillName}
                className="flex items-center justify-between py-1"
              >
                <span className="text-sm font-medium">{skillName}</span>
                <div className="flex items-center gap-1">
                  {Array.from({ length: 5 }, (_, i) => {
                    const starValue = i + 1;
                    const filled = starValue <= proficiency;
                    return (
                      <span key={i}>
                        {filled ? (
                          <IconStarFilled
                            className={`w-4 h-4 ${
                              isRelaxedSkill
                                ? "text-orange-400"
                                : "text-yellow-400"
                            }`}
                          />
                        ) : (
                          <IconStar className="w-4 h-4 text-gray-300" />
                        )}
                      </span>
                    );
                  })}
                  {isRelaxedSkill && (
                    <span className="text-xs text-muted-foreground ml-1">
                      (was {originalProficiency})
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

// Component to display agent skills on hover
function AgentSkillsIndicator({ agentUserId }) {
  const [agentSkills, setAgentSkills] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);

  const loadAgentSkills = async () => {
    if (hasLoaded || loading || !agentUserId) return;

    setLoading(true);
    try {
      const res = await fetch(
        `/api/contact-center/agents/${agentUserId}/skills`,
        { cache: "no-store" },
      );
      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.agent) {
          setAgentSkills(data.agent.skills || {});
          setHasLoaded(true);
        }
      }
    } catch (error) {
      console.error("[Monitor] Error loading agent skills:", error);
    } finally {
      setLoading(false);
    }
  };

  if (!agentUserId) return null;

  return (
    <HoverCard
      onOpenChange={(open) => {
        if (open && !hasLoaded) {
          loadAgentSkills();
        }
      }}
    >
      <HoverCardTrigger asChild>
        <div className="inline-flex items-center cursor-pointer">
          <IconInfoCircle className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
        </div>
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <div className="space-y-2">
          <h4 className="text-sm font-semibold mb-3">Agent Skills</h4>
          {loading ? (
            <div className="space-y-2 py-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ) : agentSkills && Object.keys(agentSkills).length > 0 ? (
            Object.entries(agentSkills).map(([skillName, proficiency]) => (
              <div
                key={skillName}
                className="flex items-center justify-between py-1"
              >
                <span className="text-sm font-medium">{skillName}</span>
                <div className="flex items-center gap-1">
                  {Array.from({ length: 5 }, (_, i) => {
                    const starValue = i + 1;
                    const filled = starValue <= proficiency;
                    return (
                      <span key={i}>
                        {filled ? (
                          <IconStarFilled className="w-4 h-4 text-yellow-400" />
                        ) : (
                          <IconStar className="w-4 h-4 text-gray-300" />
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No skills assigned</p>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}


function pct(value, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(value || 0) / Number(total || 1)) * 100)));
}

function formatShortNumber(value) {
  return Number(value || 0).toLocaleString();
}

function OverviewMetricCard({ icon: Icon, label, value, detail, progress = 0, chip = "Live", tone = "slate" }) {
  const tones = {
    slate: "from-slate-500/15 to-zinc-500/5 text-slate-700 dark:text-slate-200",
    emerald: "from-emerald-500/15 to-teal-500/5 text-emerald-700 dark:text-emerald-300",
    sky: "from-sky-500/15 to-blue-500/5 text-sky-700 dark:text-sky-300",
    violet: "from-violet-500/15 to-fuchsia-500/5 text-violet-700 dark:text-violet-300",
  };

  return (
    <Card className="overflow-hidden border bg-background/85 shadow-sm transition hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <span className={`rounded-2xl bg-gradient-to-br p-3 ${tones[tone] || tones.slate}`}>
            <Icon className="h-5 w-5" />
          </span>
          <Badge variant="outline" className="bg-background/70 text-[11px]">
            {chip}
          </Badge>
        </div>
        <div className="mt-5 text-3xl font-semibold tracking-tight">{value}</div>
        <div className="text-sm font-medium text-muted-foreground">{label}</div>
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{detail}</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} className="h-2" />
        </div>
      </CardContent>
    </Card>
  );
}

function MonitorDashboardView({ overall, agents, queues, timestamp }) {
  const totalCalls = overall.calls?.total || 0;
  const answered = overall.calls?.answered || 0;
  const abandoned = overall.calls?.abandoned || 0;
  const active = overall.calls?.active || 0;
  const totalAgents = agents.length || overall.agents?.totalActive || 0;
  const available = overall.agents?.available || agents.filter((a) => a.status === "Available").length;
  const busy = overall.agents?.busy || agents.filter((a) => Number(a.currentCalls || 0) > 0).length;
  const waiting = overall.queues?.totalWaitingCalls || queues.reduce((sum, q) => sum + Number(q.realtime?.waitingCalls || 0), 0);
  const activeQueues = queues.filter((q) => Number(q.realtime?.activeCalls || 0) > 0 || Number(q.realtime?.waitingCalls || 0) > 0).length;
  const inbound = totalCalls || active + waiting;
  const outbound = overall.calls?.outbound || 0;

  const healthRows = [
    { label: "Answered calls", value: answered, total: Math.max(totalCalls, answered + abandoned), hint: `${abandoned} abandoned` },
    { label: "Agent availability", value: available, total: Math.max(totalAgents, available + busy), hint: `${busy} busy` },
    { label: "Queues active now", value: activeQueues, total: Math.max(queues.length, 1), hint: `${queues.length} total queues` },
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OverviewMetricCard icon={IconUsers} label="Users / agents" value={formatShortNumber(totalAgents)} detail={`${available} available · ${busy} busy`} progress={pct(available, Math.max(totalAgents, available + busy))} chip="Users" tone="emerald" />
        <OverviewMetricCard icon={IconTrendingUp} label="Queues" value={formatShortNumber(queues.length)} detail={`${waiting} waiting · ${activeQueues} active`} progress={pct(activeQueues, Math.max(queues.length, 1))} chip="Queues" tone="sky" />
        <OverviewMetricCard icon={IconPhoneIncoming} label="Inbound volume" value={formatShortNumber(inbound)} detail={`${answered} answered · ${abandoned} missed`} progress={pct(answered, Math.max(totalCalls, answered + abandoned))} chip="Today" tone="violet" />
        <OverviewMetricCard icon={IconPhoneOutgoing} label="Outbound volume" value={formatShortNumber(outbound)} detail="Live outbound aggregate if available" progress={outbound ? 100 : 0} chip={outbound ? "Live" : "No data"} tone="slate" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <Card className="border bg-background/85 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <IconGauge className="h-5 w-5 text-sky-600" />
              Operations health
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {healthRows.map((row) => (
              <div key={row.label} className="rounded-2xl border bg-card/70 p-4">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <div>
                    <div className="font-semibold">{row.label}</div>
                    <div className="text-xs text-muted-foreground">{row.hint}</div>
                  </div>
                  <div className="text-2xl font-semibold">{pct(row.value, row.total)}%</div>
                </div>
                <Progress value={pct(row.value, row.total)} className="mt-3 h-2" />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border bg-gradient-to-br from-slate-950 to-zinc-900 text-white shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-sky-200">
              <IconSparkles className="h-5 w-5" />
              <span className="text-sm font-semibold uppercase tracking-[0.18em]">Supervisor signal</span>
            </div>
            <h3 className="mt-5 text-2xl font-semibold">Live data, safe defaults</h3>
            <p className="mt-2 text-sm text-slate-300">
              This overview uses the current monitor API. Missing aggregates render as zero/no-data instead of simulated operational values.
            </p>
            <div className="mt-5 grid gap-2 text-sm">
              <div className="rounded-xl bg-white/10 p-3">Active calls: <strong>{active}</strong></div>
              <div className="rounded-xl bg-white/10 p-3">Average wait: <strong>{Math.round(overall.calls?.avgWaitTimeSeconds || 0)}s</strong></div>
              <div className="rounded-xl bg-white/10 p-3">Last update: <strong>{timestamp ? new Date(timestamp).toLocaleTimeString() : "—"}</strong></div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function buildTrendData(range, overall, agents, queues) {
  const points = range === "1d" ? 8 : range === "7d" ? 7 : 10;
  const total = Number(overall.calls?.total || 0);
  const answered = Number(overall.calls?.answered || 0);
  const abandoned = Number(overall.calls?.abandoned || 0);
  const active = Number(overall.calls?.active || 0);
  const waiting = queues.reduce((sum, q) => sum + Number(q.realtime?.waitingCalls || 0), 0);
  const available = Number(overall.agents?.available || agents.filter((a) => a.status === "Available").length);
  const busy = Number(overall.agents?.busy || agents.filter((a) => Number(a.currentCalls || 0) > 0).length);
  const divisor = Math.max(points, 1);

  return Array.from({ length: points }, (_, idx) => {
    const weight = (idx + 1) / divisor;
    return {
      label: range === "1d" ? `${idx * 3}:00` : range === "7d" ? `D${idx + 1}` : `W${idx + 1}`,
      inbound: Math.round((total || active + waiting) * weight),
      outbound: Math.round(Number(overall.calls?.outbound || 0) * weight),
      answered: Math.round(answered * weight),
      missed: Math.round(abandoned * weight),
      wait: Math.round((Number(overall.calls?.avgWaitTimeSeconds || 0) + waiting) * weight),
      available: Math.round(available * weight),
      occupied: Math.round(busy * weight),
    };
  });
}

function MonitorGraphsView({ overall, agents, queues }) {
  const [range, setRange] = useState("7d");
  const trendData = buildTrendData(range, overall, agents, queues);
  const rangeLabels = [
    { id: "1d", label: "1 day" },
    { id: "7d", label: "7 days" },
    { id: "30d", label: "30 days" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-background/85 p-4 shadow-sm">
        <div>
          <h2 className="font-semibold">Trend visualization scaffold</h2>
          <p className="text-sm text-muted-foreground">Derived from current monitor aggregates until historical time-series data is available.</p>
        </div>
        <div className="flex rounded-xl border bg-muted/40 p-1">
          {rangeLabels.map((item) => (
            <Button key={item.id} type="button" size="sm" variant={range === item.id ? "default" : "ghost"} className={range === item.id ? neutralActionClass : ""} onClick={() => setRange(item.id)}>
              {item.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <GraphCard title="Inbound / outbound volume" description="Current aggregate distributed across selected range.">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={trendData} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} />
              <Tooltip />
              <Area type="monotone" dataKey="inbound" stroke="#0ea5e9" fill="#0ea5e9" fillOpacity={0.16} />
              <Area type="monotone" dataKey="outbound" stroke="#71717a" fill="#71717a" fillOpacity={0.14} />
            </AreaChart>
          </ResponsiveContainer>
        </GraphCard>
        <GraphCard title="Answered / missed" description="Answered and abandoned call aggregates.">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={trendData} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} />
              <Tooltip />
              <Bar dataKey="answered" fill="#10b981" radius={[6, 6, 0, 0]} />
              <Bar dataKey="missed" fill="#71717a" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
        <GraphCard title="Queue wait pressure" description="Average wait plus current queue depth signal.">
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={trendData} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} />
              <Tooltip />
              <Area type="monotone" dataKey="wait" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.16} />
            </AreaChart>
          </ResponsiveContainer>
        </GraphCard>
        <GraphCard title="Agent availability / occupancy" description="Available and busy agent aggregates.">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={trendData} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} />
              <Tooltip />
              <Bar dataKey="available" fill="#0ea5e9" radius={[6, 6, 0, 0]} />
              <Bar dataKey="occupied" fill="#27272a" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
      </div>
    </div>
  );
}

function GraphCard({ title, description, children }) {
  return (
    <Card className="border bg-background/85 shadow-sm">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export default function MonitorPage() {
  // Helper function to format idle time in seconds to human-readable format
  const formatIdleTime = (seconds) => {
    if (!seconds || seconds <= 0) return "—";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  };

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
  const [activeTab, setActiveTab] = useState("dashboard");
  const [selectedQueue, setSelectedQueue] = useState(null);
  const [queueCalls, setQueueCalls] = useState([]);
  const [loadingQueueCalls, setLoadingQueueCalls] = useState(false);
  const [expandedAgentId, setExpandedAgentId] = useState(null);
  const [agentCallsMap, setAgentCallsMap] = useState({});
  const [agentActiveCallsMap, setAgentActiveCallsMap] = useState({});
  const [loadingAgentCalls, setLoadingAgentCalls] = useState(new Set());
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
  const isLoadingDashboardRef = useRef(false);
  const isPageVisibleRef = useRef(true);
  const pollIntervalRef = useRef(null);

  useEffect(() => {
    selectedQueueRef.current = selectedQueue;
  }, [selectedQueue]);

  // Handle page visibility to prevent excessive requests when page wakes up
  useEffect(() => {
    const handleVisibilityChange = () => {
      const isVisible = !document.hidden;
      isPageVisibleRef.current = isVisible;

      if (isVisible) {
        // Page became visible - reload dashboard once after a short delay
        // This prevents rapid-fire requests when waking up
        setTimeout(() => {
          if (isPageVisibleRef.current && !isLoadingDashboardRef.current) {
            loadDashboard();
          }
        }, 500);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Update current time every second for real-time calculations
  // Pause when page is hidden to prevent unnecessary updates
  useEffect(() => {
    const updateTime = () => {
      if (isPageVisibleRef.current) {
        setCurrentTime(new Date());
      }
    };

    const interval = setInterval(updateTime, 1000);
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
      // Skip updates when page is hidden to prevent queued requests
      if (!isPageVisibleRef.current) {
        return;
      }

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
              (a) => String(a.userId) === String(prevAgent.userId),
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
              (q) => String(q.queueId) === String(prevQueue.queueId),
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
          // Always use availableSince from server (database) as single source of truth
          // Client-side calculation will use this timestamp for real-time updates
          const currentAgents = currentData.agents?.stats || [];
          const mergedAgents = currentAgents.map((currentAgent) => {
            const updatedAgent = updateAgents.find(
              (a) => String(a.userId) === String(currentAgent.userId),
            );
            if (updatedAgent) {
              // Smart merge for availableSince:
              // 1. If server provides availableSince, use it (it's the source of truth)
              // 2. If server sends null but agent is still Available, preserve existing availableSince
              //    (prevents flickering when server temporarily doesn't have the value due to race conditions)
              // 3. If status changed or calls changed, always use server's value
              const statusChanged = updatedAgent.status !== currentAgent.status;
              const callsChanged =
                updatedAgent.currentCalls !== currentAgent.currentCalls;
              const isStillAvailable =
                updatedAgent.status === "Available" &&
                updatedAgent.currentCalls === 0 &&
                currentAgent.status === "Available" &&
                currentAgent.currentCalls === 0;

              if (
                !statusChanged &&
                !callsChanged &&
                isStillAvailable &&
                !updatedAgent.availableSince &&
                currentAgent.availableSince
              ) {
                // Agent is still Available with no changes, but server sent null availableSince
                // Preserve existing to prevent flickering (server might have race condition)
                return {
                  ...updatedAgent,
                  availableSince: currentAgent.availableSince,
                };
              }
              // Use server's value in all other cases (status/calls changed, or server provided value)
              return updatedAgent;
            }
            return currentAgent;
          });

          // Add any new agents that weren't in the current list
          const currentAgentIds = new Set(
            currentAgents.map((a) => String(a.userId)),
          );
          const newAgents = updateAgents.filter(
            (a) => !currentAgentIds.has(String(a.userId)),
          );

          // Merge queues stats - update only changed queues
          const currentQueues = currentData.queues?.stats || [];
          const mergedQueues = currentQueues.map((currentQueue) => {
            const updatedQueue = updateQueues.find(
              (q) => String(q.queueId) === String(currentQueue.queueId),
            );
            return updatedQueue || currentQueue;
          });

          // Add any new queues that weren't in the current list
          const currentQueueIds = new Set(
            currentQueues.map((q) => String(q.queueId)),
          );
          const newQueues = updateQueues.filter(
            (q) => !currentQueueIds.has(String(q.queueId)),
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
          // Only refresh if page is visible to prevent queued requests
          const selectedQueue = selectedQueueRef.current;
          if (
            selectedQueue?.id &&
            loadQueueCallsRef.current &&
            isPageVisibleRef.current
          ) {
            const prevQueue = prevQueues.find(
              (queue) => String(queue.queueId) === String(selectedQueue.id),
            );
            const nextQueue = updateQueues.find(
              (queue) => String(queue.queueId) === String(selectedQueue.id),
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
                // Double-check visibility before executing
                if (isPageVisibleRef.current && loadQueueCallsRef.current) {
                  loadQueueCallsRef.current(selectedQueue.id, { silent: true });
                }
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
            update.activated === true,
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
                  : queue,
              ),
            );
          }
        }
      } catch (error) {
        console.error("[Monitor] Error handling queue change:", error);
      }
    });

    // Listen for interaction updates (e.g., when calls are answered)
    eventSource.addEventListener("interaction_updated", (event) => {
      // Skip updates when page is hidden to prevent queued requests
      if (!isPageVisibleRef.current) {
        return;
      }

      try {
        const update = JSON.parse(event.data);
        // If we have a selected queue and the interaction belongs to it, refresh queue calls
        const selectedQueue = selectedQueueRef.current;
        if (
          selectedQueue?.id &&
          update.queueId &&
          String(selectedQueue.id) === String(update.queueId) &&
          loadQueueCallsRef.current
        ) {
          // Refresh queue calls to get updated state, answeredAt, etc.
          setTimeout(() => {
            // Double-check visibility before executing
            if (isPageVisibleRef.current && loadQueueCallsRef.current) {
              loadQueueCallsRef.current(selectedQueue.id, { silent: true });
            }
          }, 100); // Small delay to ensure DB is updated
        }
      } catch (error) {
        console.error("[Monitor] Error handling interaction update:", error);
      }
    });

    eventSource.onerror = (error) => {
      console.error("[Monitor] SSE error:", error);
      setConnected(false);
      // Fallback to polling if SSE fails
      if (!data && !pollIntervalRef.current) {
        pollIntervalRef.current = setInterval(() => {
          // Only poll when page is visible
          if (isPageVisibleRef.current && !isLoadingDashboardRef.current) {
            loadDashboard();
          }
        }, 5000);
      }
    };

    return () => {
      eventSource.close();
      // Clean up polling interval if it exists
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
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
        (item) => item.user_selectable !== false,
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
    // Prevent multiple simultaneous loads
    if (isLoadingDashboardRef.current) {
      return;
    }

    // Don't load if page is hidden
    if (!isPageVisibleRef.current) {
      return;
    }

    try {
      isLoadingDashboardRef.current = true;
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
        },
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
    } finally {
      isLoadingDashboardRef.current = false;
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
                  (id) => !queueIds.includes(id),
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
        },
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
      prevCall?.completedAt !== nextCall?.completedAt ||
      prevCall?.waitSeconds !== nextCall?.waitSeconds ||
      prevCall?.talkSeconds !== nextCall?.talkSeconds ||
      prevCall?.isRelaxed !== nextCall?.isRelaxed ||
      JSON.stringify(prevCall?.relaxedSkills) !==
        JSON.stringify(nextCall?.relaxedSkills) ||
      JSON.stringify(prevCall?.requiredSkills) !==
        JSON.stringify(nextCall?.requiredSkills)
    );
  }

  function mergeQueueCalls(prevCalls, nextCalls) {
    const prevMap = new Map(
      (prevCalls || []).map((call) => [getQueueCallId(call), call]),
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

  // Periodically refresh queue calls to update relaxed skills
  // Pause when page is hidden to prevent queued requests
  useEffect(() => {
    if (!selectedQueue?.id) return;

    // Refresh every 5 seconds to update relaxed skills based on wait time
    // This ensures queued calls show updated relaxed skill requirements
    const interval = setInterval(() => {
      // Only refresh when page is visible
      if (isPageVisibleRef.current && loadQueueCallsRef.current) {
        loadQueueCallsRef.current(selectedQueue.id, { silent: true });
      }
    }, 5000); // Refresh every 5 seconds

    return () => clearInterval(interval);
  }, [selectedQueue?.id]);

  async function loadAgentCalls(userId) {
    // Don't reload if already loaded
    if (agentCallsMap[userId]) {
      return;
    }

    try {
      setLoadingAgentCalls((prev) => new Set(prev).add(userId));
      const res = await fetch(`/api/contact-center/agents/${userId}/calls`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error("Failed to load agent calls");
      }
      const data = await res.json();
      if (data.ok) {
        setAgentCallsMap((prev) => ({
          ...prev,
          [userId]: data.calls || [],
        }));
        setAgentActiveCallsMap((prev) => ({
          ...prev,
          [userId]: data.activeCalls || [],
        }));
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
      setLoadingAgentCalls((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
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
            : queue,
        ),
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
    new Set(allAgents.map((agent) => agent.status).filter(Boolean)),
  ).sort();

  const uniqueQueues = Array.from(
    new Set(
      allAgents.flatMap((agent) => agent.activeQueueIds || []).filter(Boolean),
    ),
  ).sort();

  // Get queue names for display
  const queueNamesMap = new Map(
    queues.map((q) => [q.queueId, q.queueName || q.queueId]),
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
        agentQueueIds.includes(queueId),
      );
      if (!hasMatchingQueue) {
        return false;
      }
    }

    return true;
  });

  const selectMonitorSection = (value) => {
    setActiveTab(value);
    // Clear selected queue when switching tabs to ensure proper view rendering
    if (selectedQueue) {
      setSelectedQueue(null);
      setQueueCalls([]);
    }
  };

  const activeSection =
    MONITOR_RAIL_ITEMS.find((item) => item.id === activeTab) ||
    MONITOR_RAIL_ITEMS[0];

  return (
    <SupervisorPageShell>
        <SupervisorPageHeader
          title="Supervisory Console"
          badges={(
            <>
              <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">Live monitor</Badge>
              <Badge variant="outline" className="border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300">Agents · Queues · Graphs</Badge>
              <Badge
                variant="outline"
                className={`flex items-center gap-1.5 px-3 py-1 font-semibold ${
                  connected
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
                {connected ? "Connected" : "Disconnected"}
              </Badge>
            </>
          )}
          actions={(
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoading(true);
                loadDashboard();
              }}
              disabled={loading}
            >
              <IconRefresh className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Loading…" : "Refresh"}
            </Button>
          )}
        />

        <main className={SECTION_RAIL_PAGE_GRID_CLASS} style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}>
          <SectionRail items={MONITOR_RAIL_ITEMS} activeId={activeTab} onSelect={selectMonitorSection} ariaLabel="Supervisor monitor sections" />
          <section className="h-full min-h-0 overflow-hidden pr-1">
            {activeTab === "dashboard" ? (
              <Card className="flex h-full min-h-0 flex-col overflow-hidden">
                <CardHeader className="shrink-0">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <IconActivity className="size-5" />
                        {activeSection.label}
                      </CardTitle>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {activeSection.description}
                      </p>
                    </div>
                    {data?.timestamp && (
                      <div className="text-xs text-muted-foreground">
                        Last updated: {new Date(data.timestamp).toLocaleString()}
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
                  <MonitorDashboardView overall={overall} agents={allAgents} queues={queues} timestamp={data?.timestamp} />
                </CardContent>
              </Card>
            ) : activeTab === "graphs" ? (
              <Card className="flex h-full min-h-0 flex-col overflow-hidden">
                <CardHeader className="shrink-0">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <IconChartBar className="size-5" />
                        {activeSection.label}
                      </CardTitle>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {activeSection.description}
                      </p>
                    </div>
                    {data?.timestamp && (
                      <div className="text-xs text-muted-foreground">
                        Last updated: {new Date(data.timestamp).toLocaleString()}
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
                  <MonitorGraphsView overall={overall} agents={allAgents} queues={queues} />
                </CardContent>
              </Card>
            ) : (
              <>
      {/* Statistics Section */}
      <Card className="mb-0 flex h-full min-h-0 flex-col overflow-hidden">
        <CardHeader className="shrink-0">
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
                        <TableHead>Required Skills</TableHead>
                        <TableHead>Priority</TableHead>
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
                            colSpan={10}
                            className="text-center text-muted-foreground py-4"
                          >
                            No calls found for this queue
                          </TableCell>
                        </TableRow>
                      ) : (
                        queueCalls.map((call) => {
                          // Calculate real-time wait time
                          // Wait time stops when call is answered
                          const waitTimeSeconds = call.enqueuedAt
                            ? call.answeredAt
                              ? Math.max(
                                  0,
                                  Math.floor(
                                    (new Date(call.answeredAt).getTime() -
                                      new Date(call.enqueuedAt).getTime()) /
                                      1000,
                                  ),
                                )
                              : Math.max(
                                  0,
                                  Math.floor(
                                    (currentTime.getTime() -
                                      new Date(call.enqueuedAt).getTime()) /
                                      1000,
                                  ),
                                )
                            : call.waitSeconds || 0;

                          // Calculate real-time talk time
                          // Talk time starts when call is answered and continues until now (or completed)
                          const talkTimeSeconds = call.answeredAt
                            ? Math.max(
                                0,
                                Math.floor(
                                  (currentTime.getTime() -
                                    new Date(call.answeredAt).getTime()) /
                                    1000,
                                ),
                              )
                            : call.talkSeconds || 0;

                          // Determine state - if answered but state is still ringing/bridging, show as connected
                          // Also normalize "answered" state to "connected" for consistency
                          // But don't override terminal states (completed, abandoned, failed)
                          const displayState =
                            call.state &&
                            ["completed", "abandoned", "failed"].includes(
                              call.state.toLowerCase(),
                            )
                              ? call.state
                              : call.answeredAt &&
                                (call.state === "ringing" ||
                                  call.state === "bridging" ||
                                  call.state === "answered")
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
                                displayState,
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
                                <div className="flex items-center gap-2">
                                  <span>
                                    {call.agentName ||
                                      call.agentUsername ||
                                      "—"}
                                  </span>
                                  {call.agentUserId && (
                                    <AgentSkillsIndicator
                                      agentUserId={call.agentUserId}
                                    />
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>
                                {selectedQueue?.routingStrategy ===
                                  "Skill-based" &&
                                call.requiredSkills &&
                                Object.keys(call.requiredSkills).length > 0 ? (
                                  <RelaxationIndicator
                                    requiredSkills={call.requiredSkills}
                                    relaxedSkills={call.relaxedSkills}
                                    isRelaxed={call.isRelaxed}
                                  />
                                ) : (
                                  "—"
                                )}
                              </TableCell>
                              <TableCell>
                                {call.priority &&
                                call.priority >= 1 &&
                                call.priority <= 5 ? (
                                  <div className="flex items-center gap-1">
                                    {Array.from({ length: 5 }, (_, i) => {
                                      const starValue = i + 1;
                                      const filled = starValue <= call.priority;
                                      return (
                                        <span key={i}>
                                          {filled ? (
                                            <IconStarFilled className="w-4 h-4 text-yellow-400" />
                                          ) : (
                                            <IconStar className="w-4 h-4 text-gray-300" />
                                          )}
                                        </span>
                                      );
                                    })}
                                    <span className="text-xs text-muted-foreground ml-1">
                                      ({call.priority})
                                    </span>
                                  </div>
                                ) : (
                                  "—"
                                )}
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
                                                { cache: "no-store" },
                                              );
                                              if (res.ok) {
                                                const data = await res.json();
                                                setAvailableAgentsForSkills(
                                                  data.agents || [],
                                                );
                                              }
                                            } catch (error) {
                                              console.error(
                                                "[Monitor] Error loading agents:",
                                                error,
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
                                {/* Only show supervision button for answered calls (not queued) */}
                                {call.answeredAt ||
                                call.agentUsername ||
                                call.agentName ? (
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
                                ) : (
                                  "—"
                                )}
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
                                    selectedStatuses.filter(
                                      (s) => s !== status,
                                    ),
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
                                    selectedQueues.filter((q) => q !== queueId),
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
                            <TableHead>Idle Time</TableHead>
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
                            const agentId = String(agent.userId);
                            const isExpanded = expandedAgentId === agentId;
                            const activeCalls =
                              agentActiveCallsMap[agentId] || [];
                            const isLoading = loadingAgentCalls.has(agentId);

                            return (
                              <React.Fragment key={agent.userId}>
                                <TableRow className="hover:bg-muted/50">
                                  <TableCell className="font-medium">
                                    <button
                                      onClick={() => {
                                        const newValue =
                                          expandedAgentId === agentId
                                            ? null
                                            : agentId;
                                        setExpandedAgentId(newValue);
                                        if (
                                          newValue &&
                                          !agentCallsMap[agentId]
                                        ) {
                                          loadAgentCalls(agent.userId);
                                        }
                                      }}
                                      className="flex items-center gap-2 text-left text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                                    >
                                      <span>{displayName}</span>
                                      <ChevronDownIcon
                                        className={`text-muted-foreground size-4 shrink-0 transition-transform duration-200 ${
                                          isExpanded ? "rotate-180" : ""
                                        }`}
                                      />
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
                                        onClick={(e) => {
                                          e.stopPropagation();
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
                                  <TableCell>
                                    {(() => {
                                      // Database (availableSince) is the single source of truth
                                      // Calculate idle time client-side from availableSince timestamp for real-time updates
                                      if (
                                        agent.status === "Available" &&
                                        agent.currentCalls === 0 &&
                                        agent.availableSince
                                      ) {
                                        const availableSinceTime = new Date(
                                          agent.availableSince,
                                        ).getTime();
                                        const nowTime = currentTime.getTime();
                                        const idleSeconds = Math.max(
                                          0,
                                          Math.floor(
                                            (nowTime - availableSinceTime) /
                                              1000,
                                          ),
                                        );
                                        return formatIdleTime(idleSeconds);
                                      }
                                      // If availableSince is missing but agent is Available, show dash
                                      // This should be rare and indicates available_since needs initialization
                                      return "—";
                                    })()}
                                  </TableCell>
                                  <TableCell
                                    className={
                                      highlightedCells.has(
                                        `agent-${agentId}-queues`,
                                      )
                                        ? "border border-orange-400 dark:border-orange-500 rounded transition-colors duration-1000"
                                        : ""
                                    }
                                  >
                                    <div className="flex items-center gap-2">
                                      <span>{agent.activeQueues || 0}</span>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSelectedAgent(agent);
                                          setQueueDialogOpen(true);
                                          loadAgentQueues(agent.userId);
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
                                        `agent-${agentId}-calls`,
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
                                          agent.today.avgTalkTimeSeconds,
                                        )}s`
                                      : "—"}
                                  </TableCell>
                                </TableRow>
                                {isExpanded && (
                                  <TableRow>
                                    <TableCell
                                      colSpan={8}
                                      className="p-0 border-t bg-muted/30"
                                    >
                                      <div className="px-4 py-2">
                                        {isLoading ? (
                                          <div className="space-y-2 py-4">
                                            <Skeleton className="h-10 w-full" />
                                            <Skeleton className="h-10 w-full" />
                                          </div>
                                        ) : activeCalls.length === 0 ? (
                                          <p className="text-sm text-muted-foreground text-center py-4">
                                            No active calls
                                          </p>
                                        ) : (
                                          <div className="overflow-x-auto">
                                            <Table>
                                              <TableHeader>
                                                <TableRow>
                                                  <TableHead>From</TableHead>
                                                  <TableHead>To</TableHead>
                                                  <TableHead>State</TableHead>
                                                  <TableHead>Queue</TableHead>
                                                  <TableHead>
                                                    Talk Time
                                                  </TableHead>
                                                  <TableHead>Actions</TableHead>
                                                </TableRow>
                                              </TableHeader>
                                              <TableBody>
                                                {activeCalls.map((call) => {
                                                  // Calculate real-time talk time
                                                  const talkTimeSeconds =
                                                    call.answeredAt
                                                      ? Math.max(
                                                          0,
                                                          Math.floor(
                                                            (currentTime.getTime() -
                                                              new Date(
                                                                call.answeredAt,
                                                              ).getTime()) /
                                                              1000,
                                                          ),
                                                        )
                                                      : call.talkSeconds || 0;

                                                  // Determine state
                                                  // Don't override terminal states (completed, abandoned, failed)
                                                  const displayState =
                                                    call.state &&
                                                    [
                                                      "completed",
                                                      "abandoned",
                                                      "failed",
                                                    ].includes(
                                                      call.state.toLowerCase(),
                                                    )
                                                      ? call.state
                                                      : call.answeredAt &&
                                                        (call.state ===
                                                          "ringing" ||
                                                          call.state ===
                                                            "bridging" ||
                                                          call.state ===
                                                            "answered")
                                                      ? "connected"
                                                      : call.state;

                                                  const stateColor =
                                                    displayState === "completed"
                                                      ? "text-green-600 border-green-600 dark:text-green-400 dark:border-green-400"
                                                      : displayState ===
                                                        "abandoned"
                                                      ? "text-red-600 border-red-600 dark:text-red-400 dark:border-red-400"
                                                      : displayState ===
                                                          "answered" ||
                                                        displayState ===
                                                          "connected" ||
                                                        displayState ===
                                                          "active"
                                                      ? "text-blue-600 border-blue-600 dark:text-blue-400 dark:border-blue-400"
                                                      : displayState ===
                                                          "enqueued" ||
                                                        displayState ===
                                                          "queued" ||
                                                        displayState ===
                                                          "ringing"
                                                      ? "text-yellow-600 border-yellow-600 dark:text-yellow-400 dark:border-yellow-400"
                                                      : "text-gray-600 border-gray-600 dark:text-gray-400 dark:border-gray-400";

                                                  return (
                                                    <TableRow key={call.id}>
                                                      <TableCell>
                                                        {call.fromNumber || "—"}
                                                      </TableCell>
                                                      <TableCell>
                                                        {call.toNumber || "—"}
                                                      </TableCell>
                                                      <TableCell>
                                                        <span
                                                          className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium border ${stateColor} bg-transparent`}
                                                        >
                                                          {displayState ||
                                                            "unknown"}
                                                        </span>
                                                      </TableCell>
                                                      <TableCell>
                                                        {call.queueName || "—"}
                                                      </TableCell>
                                                      <TableCell>
                                                        {talkTimeSeconds > 0
                                                          ? `${Math.round(
                                                              talkTimeSeconds,
                                                            )}s`
                                                          : "—"}
                                                      </TableCell>
                                                      <TableCell>
                                                        {/* Only show supervision button for answered calls (not queued/ringing) */}
                                                        {call.answeredAt ? (
                                                          <button
                                                            onClick={() => {
                                                              setSelectedCallForSupervision(
                                                                call,
                                                              );
                                                              setSupervisionModalOpen(
                                                                true,
                                                              );
                                                            }}
                                                            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
                                                            title="Supervise this call"
                                                          >
                                                            <IconEye className="h-4 w-4" />
                                                          </button>
                                                        ) : (
                                                          "—"
                                                        )}
                                                      </TableCell>
                                                    </TableRow>
                                                  );
                                                })}
                                              </TableBody>
                                            </Table>
                                          </div>
                                        )}
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                )}
                              </React.Fragment>
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
                                `queue-${queue.queueId}-waiting`,
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
                                `queue-${queue.queueId}-active`,
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
                                  queue.realtime.longestWaitSeconds,
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
                                    1,
                                  )}
                                  %
                                </Badge>
                              ) : queue.today?.serviceLevelPercentage >= 60 ? (
                                <Badge variant="secondary">
                                  {queue.today?.serviceLevelPercentage.toFixed(
                                    1,
                                  )}
                                  %
                                </Badge>
                              ) : (
                                <Badge variant="destructive">
                                  {queue.today?.serviceLevelPercentage.toFixed(
                                    1,
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
              </>
            )}
          </section>
        </main>

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
                      selectedCallForSkills.requiredSkills || {},
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
                        },
                      );

                      const missingSkills = skillAnalysis.filter(
                        (s) => s.missing,
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
    </SupervisorPageShell>
  );
}
