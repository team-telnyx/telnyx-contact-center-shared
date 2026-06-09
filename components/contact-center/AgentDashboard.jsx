"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  IconCheck,
  IconHeadset,
  IconPhone,
  IconRefresh,
  IconSparkles,
  IconStopwatch,
  IconTag,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";

const PERFORMANCE_COLORS = { Completed: "#10b981", Abandoned: "#f97316" };
const neutralActionClass = "bg-zinc-950 text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200";

function pct(value, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(value || 0) / Number(total || 1)) * 100)));
}

function formatShortNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatDurationShort(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  if (total >= 3600) return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
  if (total >= 60) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${total}s`;
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl">
      {label ? <div className="mb-1 font-semibold">{label}</div> : null}
      <div className="space-y-1">
        {payload.map((entry) => (
          <div key={entry.dataKey || entry.name} className="flex min-w-32 items-center justify-between gap-4">
            <span className="capitalize text-muted-foreground">{String(entry.name || entry.dataKey).replace(/([A-Z])/g, " $1")}</span>
            <span className="font-semibold">{Number(entry.value || 0).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OverviewMetricCard({ icon: Icon, label, value, detail, progress = 0, chip = "Range", tone = "slate" }) {
  const tones = {
    slate: "from-slate-500/15 to-zinc-500/5 text-slate-700 dark:text-slate-200",
    emerald: "from-emerald-500/15 to-teal-500/5 text-emerald-700 dark:text-emerald-300",
    sky: "from-sky-500/15 to-blue-500/5 text-sky-700 dark:text-sky-300",
    amber: "from-amber-500/15 to-orange-500/5 text-amber-700 dark:text-amber-300",
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

function MiniSignalTile({ label, value, detail }) {
  return (
    <div className="rounded-2xl border bg-card/70 p-4">
      <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
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

function statusBadgeClass(status) {
  if (status === "Available") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "Busy" || status === "On Call") return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (status === "Offline") return "border-zinc-400/40 bg-zinc-400/10 text-zinc-600 dark:text-zinc-300";
  return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

const PERIODS = [
  { id: "today", label: "Today" },
  { id: "7days", label: "7 days" },
  { id: "30days", label: "30 days" },
];

export function AgentDashboard({ className }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState("today");

  async function fetchData() {
    try {
      setRefreshing(true);
      const res = await fetch(`/api/dashboard/stats?period=${period}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error("Failed to fetch dashboard data");
      }
      const result = await res.json();
      setData(result);
      setError(null);
    } catch (err) {
      console.error("Error fetching dashboard data:", err);
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  if (loading) {
    return (
      <div className={cn("space-y-4", className)}>
        <Skeleton className="h-40 w-full" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn(className)}>
        <Card>
          <CardContent className="pt-6">
            <p className="text-destructive">Error loading dashboard: {error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const metrics = data?.metrics || {};
  const charts = data?.charts || {};
  const periodLabel = PERIODS.find((p) => p.id === period)?.label || "Today";

  const totalCalls = Number(metrics.totalCalls || 0);
  const completed = Number(metrics.completedCalls || 0);
  const abandoned = Number(metrics.abandonedCalls || 0);
  const completionRate = pct(completed, Math.max(totalCalls, 1));

  const performanceData = (charts.performanceDistribution || []).filter((entry) => Number(entry.value || 0) > 0);

  const hourlyData = charts.hourlyActivity || [];
  const fullHourlyData = Array.from({ length: 24 }, (_, i) => {
    const existing = hourlyData.find((d) => d.hour === i);
    return (
      existing || {
        hour: i,
        hourLabel: `${String(i).padStart(2, "0")}:00`,
        total: 0,
        completed: 0,
        abandoned: 0,
      }
    );
  });

  const queueData = charts.queueDistribution || [];
  const wrapupData = charts.wrapupDistribution || [];

  return (
    <div className={cn("space-y-5 pb-6", className)}>
      {/* Command card */}
      <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm dark:bg-zinc-950/70">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              <IconSparkles className="h-4 w-4 text-telnyx-green" />
              My performance
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h3 className="text-xl font-semibold tracking-tight">Your work summary — {periodLabel.toLowerCase()}</h3>
              <Badge variant="outline" className={`px-3 py-1 font-semibold ${statusBadgeClass(metrics.status)}`}>
                {metrics.status || "Offline"}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Calls handled, time accounting, and outcomes for the selected period.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3" data-testid="agent-dashboard-controls">
            <div className="flex rounded-xl border bg-muted/40 p-1">
              {PERIODS.map(({ id, label }) => (
                <Button
                  key={id}
                  type="button"
                  size="sm"
                  variant={period === id ? "default" : "ghost"}
                  className={period === id ? neutralActionClass : ""}
                  disabled={loading || refreshing}
                  onClick={() => setPeriod(id)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <Button onClick={fetchData} disabled={refreshing || loading} variant="outline" size="sm">
              <IconRefresh className={cn("mr-2 h-4 w-4", (refreshing || loading) && "animate-spin")} />
              {refreshing ? "Loading…" : "Refresh"}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <OverviewMetricCard
            icon={IconPhone}
            label="Calls handled"
            value={formatShortNumber(totalCalls)}
            detail={`${formatShortNumber(completed)} completed · ${formatShortNumber(abandoned)} abandoned`}
            progress={completionRate}
            chip={periodLabel}
            tone="sky"
          />
          <OverviewMetricCard
            icon={IconCheck}
            label="Completion rate"
            value={`${completionRate}%`}
            detail={`${formatShortNumber(completed)} of ${formatShortNumber(totalCalls)} calls completed`}
            progress={completionRate}
            chip={periodLabel}
            tone="emerald"
          />
          <OverviewMetricCard
            icon={IconStopwatch}
            label="Avg handle time"
            value={formatDurationShort(metrics.avgHandleTime)}
            detail={`Longest: ${formatDurationShort(metrics.longestHandleTime)}`}
            progress={pct(metrics.avgHandleTime, Math.max(metrics.longestHandleTime, 1))}
            chip="AHT"
            tone="violet"
          />
          <OverviewMetricCard
            icon={IconHeadset}
            label="Talk time"
            value={formatDurationShort(metrics.totalTalkTime)}
            detail={`Avg ${formatDurationShort(metrics.avgTalkTime)} per call`}
            progress={pct(metrics.totalTalkTime, Math.max(metrics.totalHandleTime, 1))}
            chip={periodLabel}
            tone="amber"
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MiniSignalTile
            label="Occupancy"
            value={metrics.occupancyPct == null ? "—" : `${metrics.occupancyPct}%`}
            detail={metrics.loggedInSeconds ? `${formatDurationShort(metrics.loggedInSeconds)} logged in` : "No time tracking in period"}
          />
          <MiniSignalTile
            label="Holds"
            value={formatShortNumber(metrics.holdCount)}
            detail={`${formatDurationShort(metrics.holdDurationSeconds)} total hold time`}
          />
          <MiniSignalTile
            label="Transfers"
            value={formatShortNumber(metrics.transferCount)}
            detail={`${pct(metrics.transferCount, Math.max(totalCalls, 1))}% of handled calls`}
          />
          <MiniSignalTile
            label="Break time"
            value={metrics.breakSeconds ? formatDurationShort(metrics.breakSeconds) : "—"}
            detail={metrics.availableSeconds ? `${formatDurationShort(metrics.availableSeconds)} available` : "No break data in period"}
          />
        </div>
      </div>

      {/* Charts */}
      <div className="grid gap-4 xl:grid-cols-2">
        <GraphCard title="Call outcomes" description="Completed vs abandoned calls in the selected period.">
          {performanceData.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={performanceData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={95}
                  paddingAngle={3}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {performanceData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color || PERFORMANCE_COLORS[entry.name] || "#71717a"} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[260px] items-center justify-center text-muted-foreground">
              <div className="text-center">
                <IconPhone className="mx-auto mb-2 h-12 w-12 opacity-50" />
                <p>No calls in this period</p>
              </div>
            </div>
          )}
        </GraphCard>

        <GraphCard title="My queues" description="Where your calls came from in the selected period.">
          {queueData.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={queueData} margin={{ left: -20, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="queueName" tickLine={false} axisLine={false} fontSize={12} interval={0} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="completed" name="completed" stackId="calls" fill="#10b981" radius={[0, 0, 0, 0]} />
                <Bar dataKey="abandoned" name="abandoned" stackId="calls" fill="#f97316" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[260px] items-center justify-center text-muted-foreground">
              <div className="text-center">
                <IconPhone className="mx-auto mb-2 h-12 w-12 opacity-50" />
                <p>No queue data available</p>
              </div>
            </div>
          )}
        </GraphCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <GraphCard title="Hourly activity" description="Your call volume through the day — completed and abandoned.">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={fullHourlyData} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="hourLabel" tickLine={false} axisLine={false} fontSize={11} interval={2} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="completed" name="completed" fill="#10b981" radius={[6, 6, 0, 0]} />
              <Bar dataKey="abandoned" name="abandoned" fill="#f97316" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>

        <GraphCard title="My wrap-up codes" description="How you dispositioned calls in the selected period.">
          {wrapupData.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={wrapupData} layout="vertical" margin={{ left: 30, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis type="number" tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
                <YAxis type="category" dataKey="codeName" tickLine={false} axisLine={false} fontSize={11} width={130} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
                <Bar dataKey="total" name="interactions" fill="#0ea5e9" radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[260px] items-center justify-center text-muted-foreground">
              <div className="text-center">
                <IconTag className="mx-auto mb-2 h-12 w-12 opacity-50" />
                <p>No wrap-up codes in this period</p>
              </div>
            </div>
          )}
        </GraphCard>
      </div>
    </div>
  );
}
