"use client";

import React, { useEffect, useState, useMemo } from "react";
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
  IconPhone,
  IconPhoneCall,
  IconCheck,
  IconClock,
  IconGauge,
  IconPhoneX,
  IconTrendingUp,
  IconTrendingDown,
  IconUsers,
  IconActivity,
  IconStar,
  IconStarFilled,
} from "@tabler/icons-react";
import {
  Area,
  AreaChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { Progress } from "@/components/ui/progress";

/* ── Helpers ── */

function pct(value, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(value || 0) / Number(total || 1)) * 100)));
}

function formatShortNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDurationHuman(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  if (total >= 3600) return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
  if (total >= 60) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${total}s`;
}

/* ── KPI Card ── */

function KpiCard({ icon: Icon, label, value, change, changeDirection, tone = "teal", suffix }) {
  const tones = {
    teal: "from-teal-500/15 to-cyan-500/5 text-teal-600 dark:text-teal-300",
    emerald: "from-emerald-500/15 to-green-500/5 text-emerald-600 dark:text-emerald-300",
    violet: "from-violet-500/15 to-fuchsia-500/5 text-violet-600 dark:text-violet-300",
    amber: "from-amber-500/15 to-orange-500/5 text-amber-600 dark:text-amber-300",
  sky: "from-sky-500/15 to-blue-500/5 text-sky-600 dark:text-sky-300",
  rose: "from-rose-500/15 to-red-500/5 text-rose-600 dark:text-rose-300",
  purple: "from-purple-500/15 to-indigo-500/5 text-purple-600 dark:text-purple-300",
  green: "from-green-500/15 to-emerald-500/5 text-green-600 dark:text-green-300",
  blue: "from-blue-500/15 to-sky-500/5 text-blue-600 dark:text-blue-300",
    slate: "from-slate-500/15 to-zinc-500/5 text-slate-600 dark:text-slate-300",
  };

  return (
    <Card className="overflow-hidden border bg-background/85 shadow-sm transition hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <span className={`rounded-2xl bg-gradient-to-br p-3 ${tones[tone] || tones.teal}`}>
            <Icon className="h-5 w-5" />
          </span>
          {change !== undefined && change !== null && (
            <div className={`flex items-center gap-1 text-xs font-medium ${changeDirection === "down" ? "text-emerald-500" : changeDirection === "up" ? "text-rose-500" : "text-muted-foreground"}`}>
              {changeDirection === "down" ? <IconTrendingDown className="h-3.5 w-3.5" /> : changeDirection === "up" ? <IconTrendingUp className="h-3.5 w-3.5" /> : null}
              {change}
            </div>
          )}
        </div>
        <div className="mt-5 text-3xl font-semibold tracking-tight">
          {value}
          {suffix && <span className="ml-1 text-lg text-muted-foreground">{suffix}</span>}
        </div>
        <div className="text-sm font-medium text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

/* ── Chart Tooltip ── */

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl">
      <div className="mb-1 font-semibold">{label}</div>
      <div className="space-y-1">
        {payload.map((entry) => (
          <div key={entry.dataKey} className="flex min-w-32 items-center justify-between gap-4">
            <span className="capitalize text-muted-foreground">{String(entry.name || entry.dataKey).replace(/([A-Z])/g, " $1")}</span>
            <span className="font-semibold">{Number(entry.value || 0).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Donut Chart Tooltip ── */

function DonutTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const item = payload[0];
  if (!item) return null;
  return (
    <div className="rounded-xl border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.payload?.fill }} />
        <span className="font-medium">{item.name}</span>
      </div>
      <div className="mt-1 text-muted-foreground">
        {Number(item.value || 0).toLocaleString()} ({pct(item.value, item.payload?.total || 1)}%)
      </div>
    </div>
  );
}

/* ── Section Card ── */

function SectionCard({ title, subtitle, icon: Icon, action, children, className = "" }) {
  return (
    <Card className={`border bg-background/85 shadow-sm ${className}`}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {Icon && <Icon className="h-5 w-5 text-muted-foreground" />}
            {title}
          </CardTitle>
          {action}
        </div>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/* ── Status Badge ── */

function StatusBadge({ status }) {
  const s = String(status || "").toLowerCase();
  const styles = {
    available: "border-emerald-500 text-emerald-600 bg-emerald-500/10",
    "on call": "border-sky-500 text-sky-600 bg-sky-500/10",
    "on_call": "border-sky-500 text-sky-600 bg-sky-500/10",
    "wrap up": "border-violet-500 text-violet-600 bg-violet-500/10",
    "wrap_up": "border-violet-500 text-violet-600 bg-violet-500/10",
    offline: "border-zinc-400 text-zinc-500 bg-zinc-400/10",
    break: "border-amber-500 text-amber-600 bg-amber-500/10",
  };
  const cls = styles[s] || "border-zinc-400 text-zinc-500 bg-zinc-400/10";
  return (
    <Badge variant="outline" className={`gap-1 text-xs ${cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status || "Unknown"}
    </Badge>
  );
}

/* ── Star Rating ── */

function StarRating({ value }) {
  const v = Number(value || 0);
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i}>
          {i + 1 <= Math.round(v) ? (
            <IconStarFilled className="h-3.5 w-3.5 text-yellow-400" />
          ) : (
            <IconStar className="h-3.5 w-3.5 text-zinc-300" />
          )}
        </span>
      ))}
      <span className="ml-1 text-xs text-muted-foreground">{v.toFixed(1)}</span>
    </div>
  );
}

/* ── Queue Color ── */

const QUEUE_COLORS = ["#10b981", "#3b82f6", "#f97316", "#a855f7", "#06b6d4", "#ec4899", "#eab308", "#22c55e"];

/* ── Main Overview Dashboard View ── */

export function OverviewDashboardView({ overall, agents, queues, timestamp }) {
  const [today, setToday] = useState(null);
  const [todayLoading, setTodayLoading] = useState(true);

  // Fetch today's analytics data
  useEffect(() => {
    let cancelled = false;
    async function loadToday() {
      try {
        const from = new Date();
        from.setHours(0, 0, 0, 0);
        const sp = new URLSearchParams();
        sp.set("report", "dashboard-today");
        sp.set("from", from.toISOString());
        sp.set("to", new Date().toISOString());
        const res = await fetch(`/api/contact-center/analytics?${sp.toString()}`, { cache: "no-store" });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload?.error || "Failed to load today statistics");
        if (!cancelled) setToday(payload.data || null);
      } catch (error) {
        if (!cancelled) {
          setToday(null);
        }
      } finally {
        if (!cancelled) setTodayLoading(false);
      }
    }
    loadToday();
    const interval = setInterval(loadToday, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const todayTotals = today?.totals || {};
  const totalCalls = Number(todayTotals.total ?? overall.calls?.total ?? 0);
  const answered = Number(todayTotals.answered ?? overall.calls?.answered ?? 0);
  const abandoned = Number(todayTotals.abandoned ?? overall.calls?.abandoned ?? 0);
  const outbound = Number(todayTotals.outbound ?? overall.calls?.outbound ?? 0);
  const voicemail = Number(todayTotals.voicemail ?? 0);
  const missed = Number(todayTotals.missed ?? 0);
  const avgWait = Math.round(Number(todayTotals.avgWaitSeconds ?? overall.calls?.avgWaitTimeSeconds ?? 0));
  const avgHandle = Math.round(Number(todayTotals.avgHandleSeconds ?? overall.calls?.avgHandleTimeSeconds ?? 0));

  const active = overall.calls?.active || 0;
  const totalAgents = agents.length || overall.agents?.totalActive || 0;
  const available = overall.agents?.available || agents.filter((a) => a.status === "Available").length;
  const serviceLevel = pct(answered, Math.max(totalCalls, answered + abandoned));
  const abandonmentRate = pct(abandoned, Math.max(totalCalls, 1));

  // Hourly call volume data for area chart
  const hourly = today?.hourly || [];

  // Calls by outcome for donut chart
  const outcomeData = useMemo(() => {
    const items = [
      { name: "Answered", value: answered, fill: "#10b981" },
      { name: "Voicemail", value: voicemail, fill: "#22c55e" },
      { name: "Abandoned", value: abandoned, fill: "#f97316" },
      { name: "Missed", value: missed, fill: "#a855f7" },
    ].filter((d) => d.value > 0);
    return items.length > 0 ? items : [
      { name: "Answered", value: 0, fill: "#10b981" },
      { name: "Voicemail", value: 0, fill: "#22c55e" },
      { name: "Abandoned", value: 0, fill: "#f97316" },
      { name: "Missed", value: 0, fill: "#a855f7" },
    ];
  }, [answered, voicemail, abandoned, missed]);

  // Queue status data
  const queueStatus = queues.map((q, i) => {
    const realtime = q.realtime || {};
    const todayData = today?.queues?.find((tq) => tq.queueName === (q.queueName || q.name)) || {};
    const activeCalls = Number(realtime.activeCalls || 0);
    const waitingCalls = Number(realtime.waitingCalls || 0);
    const longestWait = Number(realtime.longestWaitingSeconds || 0);
    const sla = todayData.answerRatePct || pct(todayData.answered, Math.max(todayData.total, 1));
    return {
      name: q.queueName || q.name || q.displayName || "Unknown",
      color: QUEUE_COLORS[i % QUEUE_COLORS.length],
      active: activeCalls,
      waiting: waitingCalls,
      longestWait,
      sla,
    };
  });

  // Agent performance data (top agents from analytics, fallback to live agents)
  const topAgents = today?.topAgents || [];
  const agentRows = topAgents.length > 0
    ? topAgents.slice(0, 5).map((a) => ({
        name: a.name || a.username || "Unknown",
        status: a.status || "Available",
        handled: a.handled || 0,
        answered: a.answered || 0,
        answerRate: pct(a.answered, a.handled),
        aht: a.avgHandleSeconds || 0,
        csat: a.csat || 0,
        serviceLevel: a.serviceLevel || pct(a.answered, a.handled),
      }))
    : agents.slice(0, 5).map((a) => ({
        name: a.name || a.username || "Unknown",
        status: a.status || "Available",
        handled: Number(a.currentCalls || 0),
        answered: Number(a.currentCalls || 0),
        answerRate: 0,
        aht: 0,
        csat: 0,
        serviceLevel: 0,
      }));

  const lastUpdated = timestamp
    ? new Date(timestamp).toLocaleTimeString()
    : todayLoading ? "Loading..." : "Ready";

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Overview</h2>
          <p className="mt-1 text-sm text-muted-foreground">Real-time contact center performance</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="bg-background/70 px-3 py-1 text-xs">
            Last updated: {lastUpdated}
          </Badge>
        </div>
      </div>

      {/* KPI Cards Row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {todayLoading ? (
          Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[130px] w-full rounded-2xl" />)
        ) : (
          <>
            <KpiCard icon={IconPhone} label="Total Calls" value={formatShortNumber(totalCalls)} change={totalCalls > 0 ? `${pct(totalCalls, Math.max(totalCalls, 1))}%` : undefined} changeDirection="up" tone="teal" />
            <KpiCard icon={IconPhoneCall} label="Answered Calls" value={formatShortNumber(answered)} change={answered > 0 ? `${serviceLevel}%` : undefined} changeDirection="up" tone="emerald" />
            <KpiCard icon={IconGauge} label="Service Level" value={serviceLevel} suffix="%" change={serviceLevel > 0 ? `${serviceLevel}%` : undefined} changeDirection="up" tone="sky" />
            <KpiCard icon={IconClock} label="Avg Handle Time" value={formatDuration(avgHandle)} change={avgHandle > 0 ? formatDurationHuman(avgHandle) : undefined} changeDirection="down" tone="violet" />
            <KpiCard icon={IconPhoneX} label="Abandonment Rate" value={abandonmentRate} suffix="%" change={abandonmentRate >= 0 ? `${abandonmentRate}%` : undefined} changeDirection="down" tone="amber" />
          </>
        )}
      </div>

      {/* Charts Row */}
      <div className="grid gap-4 lg:grid-cols-[1.4fr_0.6fr]">
        {/* Call Volume Area Chart */}
        <SectionCard
          title="Call Volume"
          subtitle={`${formatShortNumber(totalCalls)} calls`}
          icon={IconActivity}
        >
          {todayLoading ? (
            <Skeleton className="h-[280px] w-full" />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={hourly.length ? hourly : [{ label: "No data", answered: 0, abandoned: 0 }]} margin={{ left: -20, right: 10, top: 5 }}>
                <defs>
                  <linearGradient id="callVolumeGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
                <Area type="monotone" dataKey="answered" name="Calls" stroke="#10b981" strokeWidth={2} fill="url(#callVolumeGradient)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </SectionCard>

        {/* Calls by Outcome Donut Chart */}
        <SectionCard
          title="Calls by Outcome"
          subtitle="Today"
          icon={IconGauge}
        >
          {todayLoading ? (
            <Skeleton className="h-[280px] w-full" />
          ) : (
            <div className="flex flex-col items-center">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={outcomeData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {outcomeData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip content={<DonutTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              {/* Center total */}
              <div className="-mt-[125px] flex flex-col items-center pointer-events-none">
                <span className="text-2xl font-bold">{formatShortNumber(totalCalls)}</span>
                <span className="text-xs text-muted-foreground">Total</span>
              </div>
              <div className="mt-[100px] w-full space-y-1.5">
                {outcomeData.map((d) => (
                  <div key={d.name} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: d.fill }} />
                      <span className="text-muted-foreground">{d.name}</span>
                    </div>
                    <span className="font-medium">
                      {formatShortNumber(d.value)} ({pct(d.value, Math.max(totalCalls, 1))}%)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      {/* Queue Status + Agent Performance Row */}
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        {/* Queue Status Table */}
        <SectionCard
          title="Queue Status"
          icon={IconActivity}
          action={<a href="/supervisor/monitor?section=queues" className="text-xs text-teal-600 hover:underline dark:text-teal-400">View all queues &gt;</a>}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Queue</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
                <TableHead className="text-right">Longest Wait</TableHead>
                <TableHead className="text-right">SL</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queueStatus.length > 0 ? (
                queueStatus.map((q) => (
                  <TableRow key={q.name}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: q.color }} />
                        {q.name}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{formatShortNumber(q.active)}</TableCell>
                    <TableCell className="text-right">{formatShortNumber(q.waiting)}</TableCell>
                    <TableCell className="text-right">{formatDuration(q.longestWait)}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant="outline" className={`bg-transparent ${q.sla >= 80 ? "border-green-500 text-green-600" : q.sla >= 50 ? "border-amber-500 text-amber-600" : "border-red-500 text-red-500"}`}>
                        {q.sla}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    No queue data available.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </SectionCard>

        {/* Agent Performance Table */}
        <SectionCard
          title="Agent Performance"
          icon={IconUsers}
          action={<a href="/supervisor/monitor?section=agents" className="text-xs text-teal-600 hover:underline dark:text-teal-400">View all agents &gt;</a>}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Answered</TableHead>
                <TableHead className="text-right">AHT</TableHead>
                <TableHead>CSAT</TableHead>
                <TableHead className="text-right">SL</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agentRows.length > 0 ? (
                agentRows.map((a) => (
                  <TableRow key={a.name}>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell><StatusBadge status={a.status} /></TableCell>
                    <TableCell className="text-right">{formatShortNumber(a.handled)}</TableCell>
                    <TableCell className="text-right">{formatShortNumber(a.answered)} ({a.answerRate}%)</TableCell>
                    <TableCell className="text-right">{formatDuration(a.aht)}</TableCell>
                    <TableCell><StarRating value={a.csat} /></TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Progress value={a.serviceLevel} className="h-1.5 w-12" />
                        <span className="text-xs text-muted-foreground">{a.serviceLevel}%</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                    No agent data available.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </SectionCard>
      </div>
    </div>
  );
}
