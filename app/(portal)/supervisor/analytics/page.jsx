"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  IconAlertCircle,
  IconArrowBounce,
  IconChartBar,
  IconCheck,
  IconClock,
  IconClockPause,
  IconExternalLink,
  IconHeadset,
  IconHourglassLow,
  IconLogin,
  IconPhoneIncoming,
  IconPhoneOff,
  IconRefresh,
  IconRobot,
  IconSparkles,
  IconStopwatch,
  IconTag,
  IconTrendingUp,
  IconUsers,
} from "@tabler/icons-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { notify } from "@/components/ToastNotify";
import {
  SupervisorPageHeader,
  SupervisorPageShell,
} from "@/components/contact-center/SupervisorPageLayout";
import { SectionRail, SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";

const ANALYTICS_RAIL_ITEMS = [
  { id: "queue-performance", label: "Queue Performance", icon: IconTrendingUp, description: "Historical queue volumes, SLA, and handle times" },
  { id: "agent-performance", label: "Agent Scorecard", icon: IconUsers, description: "Agent handled volume, AHT, holds, transfers, occupancy" },
  { id: "abandonment", label: "Abandonment", icon: IconPhoneOff, description: "Abandon rates, wait distribution, and callback list" },
  { id: "agent-adherence", label: "Adherence", icon: IconClockPause, description: "Agent status mix, logins, breaks, and recent transitions" },
  { id: "transfers-holds", label: "Transfers & Holds", icon: IconArrowBounce, description: "Transfer and hold pressure by agent and queue" },
  { id: "wrapup-codes", label: "Wrap-up Codes", icon: IconTag, description: "Why customers call — disposition mix and coverage" },
  { id: "ai-handoffs", label: "AI Handoffs", icon: IconRobot, description: "AI assistant to agent handoffs, outcomes, and health" },
];
const ANALYTICS_UI_STATE_STORAGE_KEYS = {
  activeSection: "supervisor.analytics.activeSection",
};

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

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function toLocalDateTimeInput(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function quickAnalyticsDateRange(days) {
  const safeDays = Math.max(1, Number(days) || 1);
  const from = new Date();
  from.setDate(from.getDate() - (safeDays - 1));
  from.setHours(0, 0, 0, 0);
  const to = new Date();
  to.setHours(23, 59, 0, 0);
  return {
    from: toLocalDateTimeInput(from),
    to: toLocalDateTimeInput(to),
  };
}

function toIsoDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
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

function CommandCard({ icon: Icon, kicker, title, description, controls, children }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm dark:bg-zinc-950/70">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <Icon className="h-4 w-4 text-telnyx-green" />
            {kicker}
          </div>
          <h3 className="mt-2 text-xl font-semibold tracking-tight">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {controls}
      </div>
      {children}
    </div>
  );
}

const HEATMAP_DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function VolumeHeatmap({ cells }) {
  const byKey = useMemo(() => {
    const map = new Map();
    for (const cell of cells || []) map.set(`${cell.dow}-${cell.hour}`, cell.total);
    return map;
  }, [cells]);
  const max = useMemo(() => Math.max(1, ...(cells || []).map((cell) => cell.total)), [cells]);

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[44px_repeat(24,minmax(0,1fr))] gap-1">
          <div />
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={`h-${hour}`} className="text-center text-[10px] text-muted-foreground">
              {hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}
            </div>
          ))}
          {HEATMAP_DOW_LABELS.map((dowLabel, dowIdx) => (
            <Fragment key={dowLabel}>
              <div className="flex items-center text-[11px] font-medium text-muted-foreground">{dowLabel}</div>
              {Array.from({ length: 24 }, (_, hour) => {
                const total = byKey.get(`${dowIdx + 1}-${hour}`) || 0;
                const intensity = total / max;
                return (
                  <div
                    key={`${dowLabel}-${hour}`}
                    title={`${dowLabel} ${String(hour).padStart(2, "0")}:00 — ${total} calls`}
                    className="flex h-7 items-center justify-center rounded-md border border-border/40 text-[10px] font-medium"
                    style={{
                      backgroundColor: total === 0 ? "transparent" : `rgba(14,165,233,${0.12 + intensity * 0.78})`,
                      color: intensity > 0.55 ? "white" : undefined,
                    }}
                  >
                    {total > 0 ? total : ""}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Calls by weekday and hour for the selected range — darker means busier. Use it to plan staffing.</p>
      </div>
    </div>
  );
}

function QueuePerformanceView({ data, loading }) {
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const totals = data.totals || {};
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OverviewMetricCard icon={IconPhoneIncoming} label="Calls offered" value={formatShortNumber(totals.total)} detail={`${formatShortNumber(totals.answered)} answered · ${formatShortNumber(totals.abandoned)} abandoned`} progress={pct(totals.answered, Math.max(totals.total, 1))} chip="Range" tone="sky" />
        <OverviewMetricCard icon={IconCheck} label="Answer rate" value={`${totals.answerRatePct || 0}%`} detail={`${formatShortNumber(totals.answered)} answered calls`} progress={totals.answerRatePct || 0} chip="Range" tone="emerald" />
        <OverviewMetricCard icon={IconStopwatch} label={`Service level (${data.slaSeconds}s)`} value={`${totals.serviceLevelPct || 0}%`} detail={`${formatShortNumber(totals.answeredWithinSla)} within threshold`} progress={totals.serviceLevelPct || 0} chip="SLA" tone="violet" />
        <OverviewMetricCard icon={IconAlertCircle} label="Abandoned" value={formatShortNumber(totals.abandoned)} detail="Lost interactions in range" progress={pct(totals.abandoned, Math.max(totals.total, 1))} chip="Range" tone="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <GraphCard title="Daily volume and outcomes" description="Offered, answered, and abandoned calls per day.">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.daily?.length ? data.daily : [{ label: "No data", total: 0, answered: 0, abandoned: 0 }]} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
              <Bar dataKey="total" name="offered" fill="#0ea5e9" radius={[6, 6, 0, 0]} />
              <Bar dataKey="answered" name="answered" fill="#10b981" radius={[6, 6, 0, 0]} />
              <Bar dataKey="abandoned" name="abandoned" fill="#f97316" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
        <GraphCard title="Average wait trend" description="Average speed of answer per day in seconds.">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data.daily?.length ? data.daily : [{ label: "No data", avgWaitSeconds: 0 }]} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: "hsl(var(--muted-foreground) / 0.3)" }} />
              <Line type="monotone" dataKey="avgWaitSeconds" name="avg wait (s)" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </GraphCard>
      </div>

      <GraphCard title="Volume heatmap" description="When calls actually arrive — weekday × hour grid for staffing decisions.">
        <VolumeHeatmap cells={data.heatmap} />
      </GraphCard>

      <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queue</TableHead>
                  <TableHead className="text-right">Offered</TableHead>
                  <TableHead className="text-right">Answered</TableHead>
                  <TableHead className="text-right">Abandoned</TableHead>
                  <TableHead className="text-right">Service level</TableHead>
                  <TableHead className="text-right">Avg wait</TableHead>
                  <TableHead className="text-right">Max wait</TableHead>
                  <TableHead className="text-right">Avg handle</TableHead>
                  <TableHead className="text-right">Avg talk</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.queues?.length ? (
                  data.queues.map((queue) => (
                    <TableRow key={queue.queueName} className="hover:bg-muted/50">
                      <TableCell className="font-medium">{queue.queueName}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(queue.total)}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(queue.answered)}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(queue.abandoned)}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="outline" className={queue.serviceLevelPct >= 80 ? "border-green-500 text-green-600" : queue.serviceLevelPct >= 50 ? "border-amber-500 text-amber-600" : "border-red-500 text-red-500"}>
                          {queue.serviceLevelPct}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{formatDurationShort(queue.avgWaitSeconds)}</TableCell>
                      <TableCell className="text-right">{formatDurationShort(queue.maxWaitSeconds)}</TableCell>
                      <TableCell className="text-right">{formatDurationShort(queue.avgHandleSeconds)}</TableCell>
                      <TableCell className="text-right">{formatDurationShort(queue.avgTalkSeconds)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={9} className="text-center text-sm">No queue activity in the selected range.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AgentPerformanceView({ data, loading }) {
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const totals = data.totals || {};
  const chartData = (data.agents || []).slice(0, 10).map((agent) => ({
    label: agent.name,
    handled: agent.handled,
    avgHandle: Math.round(agent.avgHandleSeconds),
  }));
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OverviewMetricCard icon={IconUsers} label="Active agents" value={formatShortNumber(totals.agents)} detail="Agents with handled calls in range" progress={pct(totals.agents, Math.max(totals.agents, 1))} chip="Range" tone="sky" />
        <OverviewMetricCard icon={IconHeadset} label="Calls handled" value={formatShortNumber(totals.handled)} detail={`${formatShortNumber(totals.completed)} completed`} progress={pct(totals.completed, Math.max(totals.handled, 1))} chip="Range" tone="emerald" />
        <OverviewMetricCard icon={IconArrowBounce} label="Transfers" value={formatShortNumber(totals.transferCount)} detail={`${pct(totals.transferCount, Math.max(totals.handled, 1))}% of handled calls`} progress={pct(totals.transferCount, Math.max(totals.handled, 1))} chip="Range" tone="amber" />
        <OverviewMetricCard icon={IconHourglassLow} label="Holds" value={formatShortNumber(totals.holdCount)} detail="Hold events across agents" progress={pct(totals.holdCount, Math.max(totals.handled, 1))} chip="Range" tone="violet" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <GraphCard title="Top agents by handled calls" description="Highest-volume agents in the selected range.">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData.length ? chartData : [{ label: "No data", handled: 0 }]} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} interval={0} angle={-20} height={50} textAnchor="end" />
              <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
              <Bar dataKey="handled" name="handled" fill="#0ea5e9" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
        <GraphCard title="Daily handled volume" description="Team-wide handled interactions per day with handle-time trend.">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.daily?.length ? data.daily : [{ label: "No data", handled: 0 }]} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
              <Bar dataKey="handled" name="handled" fill="#10b981" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
      </div>

      <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Handled</TableHead>
                  <TableHead className="text-right">Completed</TableHead>
                  <TableHead className="text-right">Avg handle</TableHead>
                  <TableHead className="text-right">Avg talk</TableHead>
                  <TableHead className="text-right">Holds</TableHead>
                  <TableHead className="text-right">Hold time</TableHead>
                  <TableHead className="text-right">Transfer rate</TableHead>
                  <TableHead className="text-right">Logged in</TableHead>
                  <TableHead className="text-right">Occupancy</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.agents?.length ? (
                  data.agents.map((agent) => (
                    <TableRow key={agent.username} className="hover:bg-muted/50">
                      <TableCell className="font-medium">{agent.name}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(agent.handled)}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(agent.completed)}</TableCell>
                      <TableCell className="text-right">{formatDurationShort(agent.avgHandleSeconds)}</TableCell>
                      <TableCell className="text-right">{formatDurationShort(agent.avgTalkSeconds)}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(agent.holdCount)}</TableCell>
                      <TableCell className="text-right">{formatDurationShort(agent.holdDurationSeconds)}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="outline" className={agent.transferRatePct <= 10 ? "border-green-500 text-green-600" : agent.transferRatePct <= 25 ? "border-amber-500 text-amber-600" : "border-red-500 text-red-500"}>
                          {agent.transferRatePct}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{agent.loggedInSeconds ? formatDurationShort(agent.loggedInSeconds) : "—"}</TableCell>
                      <TableCell className="text-right">{agent.occupancyPct == null ? "—" : `${agent.occupancyPct}%`}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={10} className="text-center text-sm">No agent activity in the selected range.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AbandonmentView({ data, loading }) {
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const totals = data.totals || {};
  const worstQueue = (data.queues || []).filter((q) => q.abandoned > 0).sort((a, b) => b.abandonRatePct - a.abandonRatePct)[0];
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OverviewMetricCard icon={IconPhoneIncoming} label="Calls offered" value={formatShortNumber(totals.total)} detail="All interactions in range" progress={pct(totals.total, Math.max(totals.total, 1))} chip="Range" tone="sky" />
        <OverviewMetricCard icon={IconPhoneOff} label="Abandoned" value={formatShortNumber(totals.abandoned)} detail={`${totals.abandonRatePct || 0}% abandon rate`} progress={totals.abandonRatePct || 0} chip="Range" tone="amber" />
        <OverviewMetricCard icon={IconClock} label="Most common wait" value={(data.buckets || []).reduce((best, bucket) => (bucket.total > (best?.total || 0) ? bucket : best), null)?.label || "—"} detail="Wait bucket with most abandons" progress={pct((data.buckets || []).reduce((best, bucket) => (bucket.total > (best?.total || 0) ? bucket : best), null)?.total, Math.max(totals.abandoned, 1))} chip="Distribution" tone="violet" />
        <OverviewMetricCard icon={IconAlertCircle} label="Worst queue" value={worstQueue ? worstQueue.queueName : "—"} detail={worstQueue ? `${worstQueue.abandonRatePct}% abandon rate` : "No abandons in range"} progress={worstQueue?.abandonRatePct || 0} chip="Hotspot" tone="slate" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <GraphCard title="Wait time before abandoning" description="How long callers waited before hanging up.">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.buckets?.length ? data.buckets : [{ label: "No data", total: 0 }]} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
              <Bar dataKey="total" name="abandoned" fill="#f97316" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
        <GraphCard title="Answered vs abandoned by hour" description="Hour-of-day pattern — where coverage gaps lose callers.">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.hourly?.length ? data.hourly : [{ label: "No data", answered: 0, abandoned: 0 }]} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="answered" name="answered" stackId="calls" fill="#10b981" radius={[0, 0, 0, 0]} />
              <Bar dataKey="abandoned" name="abandoned" stackId="calls" fill="#f97316" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
          <CardHeader>
            <CardTitle className="text-base">Abandon rate by queue</CardTitle>
            <p className="text-sm text-muted-foreground">Queues ranked by lost callers in the selected range.</p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queue</TableHead>
                  <TableHead className="text-right">Offered</TableHead>
                  <TableHead className="text-right">Abandoned</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Avg wait before abandon</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.queues?.length ? (
                  data.queues.map((queue) => (
                    <TableRow key={queue.queueName} className="hover:bg-muted/50">
                      <TableCell className="font-medium">{queue.queueName}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(queue.total)}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(queue.abandoned)}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="outline" className={queue.abandonRatePct <= 5 ? "border-green-500 text-green-600" : queue.abandonRatePct <= 15 ? "border-amber-500 text-amber-600" : "border-red-500 text-red-500"}>
                          {queue.abandonRatePct}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{formatDurationShort(queue.avgWaitBeforeAbandonSeconds)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={5} className="text-center text-sm">No queue data in the selected range.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
          <CardHeader>
            <CardTitle className="text-base">Callback list</CardTitle>
            <p className="text-sm text-muted-foreground">Most recent abandoned callers — reach back out before they churn.</p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[420px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Caller</TableHead>
                    <TableHead>Queue</TableHead>
                    <TableHead className="text-right">Waited</TableHead>
                    <TableHead className="text-right">Abandoned at</TableHead>
                    <TableHead className="text-right">Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.callbacks?.length ? (
                    data.callbacks.map((row) => (
                      <TableRow key={row.id} className="hover:bg-muted/50">
                        <TableCell className="font-medium">{row.fromName || row.fromNumber || "Unknown"}</TableCell>
                        <TableCell>{row.queueName || "-"}</TableCell>
                        <TableCell className="text-right">{formatDurationShort(row.waitTimeSeconds)}</TableCell>
                        <TableCell className="text-right text-xs">{formatDateTime(row.abandonedAt)}</TableCell>
                        <TableCell className="text-right">
                          <Button size="icon" variant="ghost" asChild>
                            <Link href={`/supervisor/call-history/${row.id}`}><IconExternalLink className="h-4 w-4" /></Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow><TableCell colSpan={5} className="text-center text-sm">No abandoned calls in the selected range. 🎉</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const STATUS_TONES = {
  Available: "border-green-500 text-green-600",
  Busy: "border-sky-500 text-sky-600",
  Wrapup: "border-violet-500 text-violet-600",
  Break: "border-amber-500 text-amber-600",
  Lunch: "border-amber-500 text-amber-600",
  Away: "border-orange-500 text-orange-600",
  Offline: "border-zinc-400 text-zinc-500",
};

function statusBadgeClass(status) {
  return STATUS_TONES[status] || "border-blue-500 text-blue-500";
}

function AgentAdherenceView({ data, loading }) {
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const totals = data.totals || {};
  const statusMixData = (data.statusMix || []).map((entry) => ({
    label: entry.status,
    minutes: Math.round(entry.durationSeconds / 60),
    changes: entry.changes,
  }));
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OverviewMetricCard icon={IconUsers} label="Agents tracked" value={formatShortNumber(totals.agents)} detail="Agents with status activity in range" progress={pct(totals.agents, Math.max(totals.agents, 1))} chip="Range" tone="sky" />
        <OverviewMetricCard icon={IconLogin} label="Logins" value={formatShortNumber(totals.logins)} detail="Login events in range" progress={pct(totals.logins, Math.max(totals.logins, 1))} chip="Range" tone="emerald" />
        <OverviewMetricCard icon={IconClockPause} label="Status changes" value={formatShortNumber(totals.statusChanges)} detail="Transitions across all agents" progress={pct(totals.statusChanges, Math.max(totals.statusChanges, 1))} chip="Range" tone="violet" />
        <OverviewMetricCard icon={IconClock} label="Top status" value={statusMixData[0]?.label || "—"} detail={statusMixData[0] ? `${formatDurationShort(statusMixData[0].minutes * 60)} total time` : "No status data"} progress={pct(statusMixData[0]?.minutes, Math.max(statusMixData.reduce((sum, item) => sum + item.minutes, 0), 1))} chip="Mix" tone="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <GraphCard title="Status time mix" description="Minutes spent in each status across all agents.">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={statusMixData.length ? statusMixData : [{ label: "No data", minutes: 0 }]} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} interval={0} angle={-15} height={45} textAnchor="end" />
              <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
              <Bar dataKey="minutes" name="minutes" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
        <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
          <CardHeader>
            <CardTitle className="text-base">Recent status transitions</CardTitle>
            <p className="text-sm text-muted-foreground">Latest transitions from the immutable status ledger.</p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[300px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>From → To</TableHead>
                    <TableHead className="text-right">In previous</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recentTransitions?.length ? (
                    data.recentTransitions.map((row, idx) => (
                      <TableRow key={`${row.agentUsername}-${row.createdAt}-${idx}`} className="hover:bg-muted/50">
                        <TableCell className="font-medium">{row.agentUsername}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className={`bg-transparent ${statusBadgeClass(row.previousStatus)}`}>{row.previousStatus || "—"}</Badge>
                            <span className="text-muted-foreground">→</span>
                            <Badge variant="outline" className={`bg-transparent ${statusBadgeClass(row.status)}`}>{row.status}</Badge>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{formatDurationShort(row.durationSeconds)}</TableCell>
                        <TableCell className="text-right text-xs">{formatDateTime(row.createdAt)}</TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow><TableCell colSpan={4} className="text-center text-sm">No status transitions in the selected range.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
        <CardHeader>
          <CardTitle className="text-base">Agent adherence summary</CardTitle>
          <p className="text-sm text-muted-foreground">Per-agent logins, time accounting, and routing readiness for the selected range.</p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Logins</TableHead>
                  <TableHead className="text-right">First login</TableHead>
                  <TableHead className="text-right">Status changes</TableHead>
                  <TableHead className="text-right">Logged in</TableHead>
                  <TableHead className="text-right">On call</TableHead>
                  <TableHead className="text-right">Break</TableHead>
                  <TableHead className="text-right">Availability</TableHead>
                  <TableHead className="text-right">Occupancy</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.agents?.length ? (
                  data.agents.map((agent) => (
                    <TableRow key={agent.username} className="hover:bg-muted/50">
                      <TableCell className="font-medium">{agent.name}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(agent.logins)}</TableCell>
                      <TableCell className="text-right text-xs">{agent.firstLogin ? formatDateTime(agent.firstLogin) : "—"}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(agent.statusChanges)}</TableCell>
                      <TableCell className="text-right">{agent.loggedInSeconds ? formatDurationShort(agent.loggedInSeconds) : "—"}</TableCell>
                      <TableCell className="text-right">{agent.callSeconds ? formatDurationShort(agent.callSeconds) : "—"}</TableCell>
                      <TableCell className="text-right">{agent.breakSeconds ? formatDurationShort(agent.breakSeconds) : "—"}</TableCell>
                      <TableCell className="text-right">{agent.availabilityPct == null ? "—" : `${agent.availabilityPct}%`}</TableCell>
                      <TableCell className="text-right">{agent.occupancyPct == null ? "—" : `${agent.occupancyPct}%`}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={9} className="text-center text-sm">No adherence data in the selected range.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TransfersHoldsView({ data, loading }) {
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const totals = data.totals || {};
  const queueChartData = (data.queues || []).slice(0, 10).map((queue) => ({
    label: queue.queueName,
    transfers: queue.transferCount,
    holds: queue.holdCount,
  }));
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OverviewMetricCard icon={IconArrowBounce} label="Transfers" value={formatShortNumber(totals.transferCount)} detail={`${totals.transferRatePct}% of calls had a transfer`} progress={totals.transferRatePct || 0} chip="Range" tone="amber" />
        <OverviewMetricCard icon={IconHourglassLow} label="Hold events" value={formatShortNumber(totals.holdCount)} detail={`${totals.holdRatePct}% of calls had a hold`} progress={totals.holdRatePct || 0} chip="Range" tone="violet" />
        <OverviewMetricCard icon={IconClock} label="Avg hold time" value={formatDurationShort(totals.avgHoldSeconds)} detail={`${formatDurationShort(totals.holdDurationSeconds)} total hold time`} progress={pct(totals.avgHoldSeconds, Math.max(totals.maxHoldSeconds, 1))} chip="Holds" tone="sky" />
        <OverviewMetricCard icon={IconAlertCircle} label="Longest hold" value={formatDurationShort(totals.maxHoldSeconds)} detail="Worst single-call hold time" progress={100} chip="Outlier" tone="slate" />
      </div>

      <GraphCard title="Transfer and hold pressure by queue" description="Which queues generate rework and customer waiting.">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={queueChartData.length ? queueChartData : [{ label: "No data", transfers: 0, holds: 0 }]} margin={{ left: -20, right: 10 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
            <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="transfers" name="transfers" fill="#f59e0b" radius={[6, 6, 0, 0]} />
            <Bar dataKey="holds" name="holds" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </GraphCard>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
          <CardHeader>
            <CardTitle className="text-base">Agents with most transfers and holds</CardTitle>
            <p className="text-sm text-muted-foreground">High transfer rate often signals routing or skill gaps, not agent failure.</p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Handled</TableHead>
                  <TableHead className="text-right">Transfers</TableHead>
                  <TableHead className="text-right">Transfer rate</TableHead>
                  <TableHead className="text-right">Holds</TableHead>
                  <TableHead className="text-right">Hold time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.agents?.length ? (
                  data.agents.map((agent) => (
                    <TableRow key={agent.username} className="hover:bg-muted/50">
                      <TableCell className="font-medium">{agent.name}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(agent.handled)}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(agent.transferCount)}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="outline" className={agent.transferRatePct <= 10 ? "border-green-500 text-green-600" : agent.transferRatePct <= 25 ? "border-amber-500 text-amber-600" : "border-red-500 text-red-500"}>
                          {agent.transferRatePct}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{formatShortNumber(agent.holdCount)}</TableCell>
                      <TableCell className="text-right">{formatDurationShort(agent.holdDurationSeconds)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={6} className="text-center text-sm">No agent transfer/hold activity in range.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
          <CardHeader>
            <CardTitle className="text-base">Longest holds</CardTitle>
            <p className="text-sm text-muted-foreground">Worst caller experiences — review these recordings first.</p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[420px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Caller</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-right">Holds</TableHead>
                    <TableHead className="text-right">Hold time</TableHead>
                    <TableHead className="text-right">Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.longestHolds?.length ? (
                    data.longestHolds.map((row) => (
                      <TableRow key={row.id} className="hover:bg-muted/50">
                        <TableCell className="font-medium">{row.fromName || row.fromNumber || "Unknown"}</TableCell>
                        <TableCell>{row.agentUsername || "-"}</TableCell>
                        <TableCell className="text-right">{formatShortNumber(row.holdCount)}</TableCell>
                        <TableCell className="text-right">{formatDurationShort(row.holdDurationSeconds)}</TableCell>
                        <TableCell className="text-right">
                          <Button size="icon" variant="ghost" asChild>
                            <Link href={`/supervisor/call-history/${row.id}`}><IconExternalLink className="h-4 w-4" /></Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow><TableCell colSpan={5} className="text-center text-sm">No holds in the selected range. 🎉</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const WRAPUP_SERIES_COLORS = ["#0ea5e9", "#10b981", "#8b5cf6", "#f59e0b", "#ec4899", "#71717a"];

function WrapupCodesView({ data, loading }) {
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const totals = data.totals || {};
  const topCode = data.codes?.[0];
  const dailySeries = [...(data.topCodes || []), "other"];
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OverviewMetricCard icon={IconTag} label="Coded interactions" value={formatShortNumber(totals.withCodes)} detail={`${totals.coveragePct}% of completed calls have wrap-up codes`} progress={totals.coveragePct || 0} chip="Coverage" tone="emerald" />
        <OverviewMetricCard icon={IconChartBar} label="Distinct codes used" value={formatShortNumber(totals.distinctCodes)} detail="Unique dispositions in range" progress={pct(totals.distinctCodes, Math.max(totals.distinctCodes, 1))} chip="Range" tone="sky" />
        <OverviewMetricCard icon={IconCheck} label="Top reason" value={topCode?.codeName || "—"} detail={topCode ? `${formatShortNumber(topCode.total)} interactions` : "No coded interactions"} progress={pct(topCode?.total, Math.max(totals.withCodes, 1))} chip="Top" tone="violet" />
        <OverviewMetricCard icon={IconAlertCircle} label="Missing codes" value={formatShortNumber(Math.max(totals.completed - totals.withCodes, 0))} detail="Completed calls without disposition" progress={Math.max(0, 100 - (totals.coveragePct || 0))} chip="Hygiene" tone="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <GraphCard title="Disposition mix" description="Why customers contacted you — top wrap-up codes in range.">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={(data.codes || []).slice(0, 10)} layout="vertical" margin={{ left: 30, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis type="number" tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
              <YAxis type="category" dataKey="codeName" tickLine={false} axisLine={false} fontSize={11} width={130} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
              <Bar dataKey="total" name="interactions" fill="#0ea5e9" radius={[0, 6, 6, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
        <GraphCard title="Disposition trend" description="Daily stacked mix of the top codes — watch for rising contact reasons.">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data.daily?.length ? data.daily : [{ label: "No data" }]} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {dailySeries.map((series, idx) => (
                <Bar key={series} dataKey={series} name={series} stackId="codes" fill={WRAPUP_SERIES_COLORS[idx % WRAPUP_SERIES_COLORS.length]} radius={idx === dailySeries.length - 1 ? [6, 6, 0, 0] : [0, 0, 0, 0]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
      </div>

      <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
        <CardHeader>
          <CardTitle className="text-base">Dispositions by queue</CardTitle>
          <p className="text-sm text-muted-foreground">Contact reasons per queue — spot mismatched routing or emerging issues.</p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[420px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queue</TableHead>
                  <TableHead>Wrap-up code</TableHead>
                  <TableHead className="text-right">Interactions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byQueue?.length ? (
                  data.byQueue.map((row, idx) => (
                    <TableRow key={`${row.queueName}-${row.codeId}-${idx}`} className="hover:bg-muted/50">
                      <TableCell className="font-medium">{row.queueName}</TableCell>
                      <TableCell><Badge variant="outline" className="bg-transparent border-sky-500/50 text-sky-600 dark:text-sky-300">{row.codeName}</Badge></TableCell>
                      <TableCell className="text-right">{formatShortNumber(row.total)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={3} className="text-center text-sm">No coded interactions in the selected range.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function handoffStatusBadgeClass(status) {
  if (status === "processed") return "border-green-500 text-green-600";
  if (String(status || "").startsWith("pending")) return "border-amber-500 text-amber-600";
  return "border-red-500 text-red-500";
}

function AiHandoffsView({ data, loading }) {
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const totals = data.totals || {};
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OverviewMetricCard icon={IconRobot} label="AI handoffs" value={formatShortNumber(totals.handoffs)} detail={`${formatShortNumber(totals.aiHandledInteractions)} AI-tagged agent interactions`} progress={pct(totals.handoffs, Math.max(totals.handoffs, 1))} chip="Range" tone="violet" />
        <OverviewMetricCard icon={IconCheck} label="Processed" value={`${totals.processedRatePct || 0}%`} detail={`${formatShortNumber(totals.processed)} insight payloads delivered to agents`} progress={totals.processedRatePct || 0} chip="Health" tone="emerald" />
        <OverviewMetricCard icon={IconAlertCircle} label="Pending / failed" value={`${formatShortNumber(totals.pending)} / ${formatShortNumber(totals.failed)}`} detail={`${formatShortNumber(totals.withErrors)} with error messages`} progress={pct(totals.pending + totals.failed, Math.max(totals.handoffs, 1))} chip="Health" tone="amber" />
        <OverviewMetricCard icon={IconClock} label="Agent AHT after handoff" value={formatDurationShort(totals.avgHandleSecondsAfterHandoff)} detail={`${formatShortNumber(totals.aiCompleted)} completed after AI handoff`} progress={pct(totals.aiCompleted, Math.max(totals.aiHandledInteractions, 1))} chip="Outcome" tone="sky" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <GraphCard title="Handoffs per day" description="Total handoff events and successfully processed insight payloads.">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.daily?.length ? data.daily : [{ label: "No data", total: 0, processed: 0 }]} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.18)" }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="total" name="handoffs" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
              <Bar dataKey="processed" name="processed" fill="#10b981" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
        <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
          <CardHeader>
            <CardTitle className="text-base">Handoff destinations</CardTitle>
            <p className="text-sm text-muted-foreground">Queues that receive AI-transferred callers and how those calls end.</p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queue</TableHead>
                  <TableHead className="text-right">Handoffs</TableHead>
                  <TableHead className="text-right">Completed</TableHead>
                  <TableHead className="text-right">Avg handle after AI</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byQueue?.length ? (
                  data.byQueue.map((row) => (
                    <TableRow key={row.queueName} className="hover:bg-muted/50">
                      <TableCell className="font-medium">{row.queueName}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(row.handoffs)}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(row.completed)}</TableCell>
                      <TableCell className="text-right">{formatDurationShort(row.avgHandleSeconds)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={4} className="text-center text-sm">No AI handoffs reached a queue in the selected range.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
        <CardHeader>
          <CardTitle className="text-base">Recent handoff events</CardTitle>
          <p className="text-sm text-muted-foreground">Latest AI → agent handoffs with processing status; failures need attention.</p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[420px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Caller</TableHead>
                  <TableHead>Queue</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">When</TableHead>
                  <TableHead className="text-right">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recent?.length ? (
                  data.recent.map((row) => (
                    <TableRow key={row.id} className="hover:bg-muted/50">
                      <TableCell className="font-medium">{row.fromName || row.fromNumber || "Unknown"}</TableCell>
                      <TableCell>{row.queueName || "-"}</TableCell>
                      <TableCell>{row.agentUsername || "-"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`bg-transparent ${handoffStatusBadgeClass(row.status)}`} title={row.errorMessage || undefined}>
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-xs">{formatDateTime(row.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        {row.interactionId ? (
                          <Button size="icon" variant="ghost" asChild>
                            <Link href={`/supervisor/call-history/${row.interactionId}`}><IconExternalLink className="h-4 w-4" /></Link>
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={6} className="text-center text-sm">No AI handoff events in the selected range.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const REPORT_META = {
  "queue-performance": {
    kicker: "Queue performance report",
    title: "Historical queue health for the selected range",
    description: "Offered volume, answer rate, service level, wait and handle times per queue.",
    icon: IconTrendingUp,
  },
  "agent-performance": {
    kicker: "Agent scorecard",
    title: "Agent productivity for the selected range",
    description: "Handled calls, handle time, holds, transfers, and occupancy per agent.",
    icon: IconUsers,
  },
  abandonment: {
    kicker: "Abandonment analysis",
    title: "Lost callers for the selected range",
    description: "Where, when, and how long callers waited before giving up — plus a callback list.",
    icon: IconPhoneOff,
  },
  "agent-adherence": {
    kicker: "Agent adherence report",
    title: "Status discipline for the selected range",
    description: "Logins, status mix, breaks, availability, and the latest status transitions per agent.",
    icon: IconClockPause,
  },
  "transfers-holds": {
    kicker: "Transfers & holds report",
    title: "Rework and caller waiting for the selected range",
    description: "Transfer and hold pressure by agent and queue, plus the longest holds to review.",
    icon: IconArrowBounce,
  },
  "wrapup-codes": {
    kicker: "Wrap-up codes report",
    title: "Contact reasons for the selected range",
    description: "Disposition mix, daily trend, per-queue breakdown, and wrap-up coverage hygiene.",
    icon: IconTag,
  },
  "ai-handoffs": {
    kicker: "AI handoff report",
    title: "AI assistant to agent handoffs for the selected range",
    description: "Handoff volume, insight processing health, destination queues, and agent outcomes after AI.",
    icon: IconRobot,
  },
};

export default function SupervisorAnalyticsPage() {
  const [activeReport, setActiveReport] = useState("queue-performance");
  const [range, setRange] = useState("7d");
  const [dateRange, setDateRange] = useState(() => quickAnalyticsDateRange(7));
  const [queueFilter, setQueueFilter] = useState("all");
  const [queueOptions, setQueueOptions] = useState([]);
  const [reportData, setReportData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(ANALYTICS_UI_STATE_STORAGE_KEYS.activeSection);
      if (saved && ANALYTICS_RAIL_ITEMS.some((item) => item.id === saved)) setActiveReport(saved);
    } catch {
      // Ignore storage errors so analytics still works without persisted UI state.
    }
  }, []);

  useEffect(() => {
    try { localStorage.setItem(ANALYTICS_UI_STATE_STORAGE_KEYS.activeSection, activeReport); } catch {}
  }, [activeReport]);

  const analyticsQuery = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("report", activeReport);
    const fromIso = toIsoDateTime(dateRange.from);
    const toIso = toIsoDateTime(dateRange.to);
    if (fromIso) sp.set("from", fromIso);
    if (toIso) sp.set("to", toIso);
    if (queueFilter && queueFilter !== "all") sp.set("queue", queueFilter);
    return sp.toString();
  }, [activeReport, dateRange, queueFilter]);

  useEffect(() => {
    let cancelled = false;
    async function loadReport() {
      setLoading(true);
      try {
        const res = await fetch(`/api/contact-center/analytics?${analyticsQuery}`, { cache: "no-store" });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload?.error || "Failed to load analytics report");
        if (!cancelled) setReportData(payload.data || null);
      } catch (error) {
        if (!cancelled) {
          setReportData(null);
          notify({ title: "Analytics load failed", description: String(error.message || error), variant: "error" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadReport();
    return () => {
      cancelled = true;
    };
  }, [analyticsQuery, refreshNonce]);

  useEffect(() => {
    let cancelled = false;
    async function loadQueueOptions() {
      try {
        const res = await fetch("/api/contact-center/interactions/history?page=1&pageSize=1", { cache: "no-store" });
        const payload = await res.json();
        if (!res.ok) return;
        if (!cancelled) setQueueOptions(payload?.filters?.queues || []);
      } catch {
        // Queue filter options are a convenience; the page works without them.
      }
    }
    loadQueueOptions();
    return () => {
      cancelled = true;
    };
  }, []);

  const setQuickAnalyticsRange = (days) => {
    setRange(`${days}d`);
    setDateRange(quickAnalyticsDateRange(days));
  };

  const meta = REPORT_META[activeReport] || REPORT_META["queue-performance"];

  const commandControls = (
    <div className="flex flex-wrap items-end justify-start gap-3 xl:justify-end" data-testid="analytics-command-card-controls">
      <div className="flex rounded-xl border bg-muted/40 p-1">
        <Button type="button" size="sm" variant={range === "1d" ? "default" : "ghost"} className={range === "1d" ? neutralActionClass : ""} onClick={() => setQuickAnalyticsRange(1)}>1 day</Button>
        <Button type="button" size="sm" variant={range === "7d" ? "default" : "ghost"} className={range === "7d" ? neutralActionClass : ""} onClick={() => setQuickAnalyticsRange(7)}>7 days</Button>
        <Button type="button" size="sm" variant={range === "30d" ? "default" : "ghost"} className={range === "30d" ? neutralActionClass : ""} onClick={() => setQuickAnalyticsRange(30)}>30 days</Button>
        <Button type="button" size="sm" variant={range === "custom" ? "default" : "ghost"} className={range === "custom" ? neutralActionClass : ""} onClick={() => setRange("custom")}>Custom range</Button>
      </div>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">From</div>
        <Input type="datetime-local" value={dateRange.from} onChange={(event) => { setRange("custom"); setDateRange((prev) => ({ ...prev, from: event.target.value })); }} className="w-[190px] bg-transparent dark:bg-input/30 dark:hover:bg-input/50" />
      </div>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">To</div>
        <Input type="datetime-local" value={dateRange.to} onChange={(event) => { setRange("custom"); setDateRange((prev) => ({ ...prev, to: event.target.value })); }} className="w-[190px] bg-transparent dark:bg-input/30 dark:hover:bg-input/50" />
      </div>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Queue</div>
        <Select value={queueFilter} onValueChange={setQueueFilter}>
          <SelectTrigger className="w-[170px]"><SelectValue placeholder="All queues" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All queues</SelectItem>
            {queueOptions.map((queue) => (<SelectItem key={queue} value={queue}>{queue}</SelectItem>))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );

  return (
    <SupervisorPageShell>
      <SupervisorPageHeader
        title="Analytics"
        badges={(
          <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">
            Historical reports
          </Badge>
        )}
        actions={(
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRefreshNonce((nonce) => nonce + 1)}
            disabled={loading}
          >
            <IconRefresh className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Loading…" : "Refresh"}
          </Button>
        )}
      />
      <main className={SECTION_RAIL_PAGE_GRID_CLASS} style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}>
        <SectionRail items={ANALYTICS_RAIL_ITEMS} activeId={activeReport} onSelect={setActiveReport} ariaLabel="Supervisor analytics reports" />
        <section className="h-full min-h-0 overflow-hidden pr-1">
          <Card className="flex h-full min-h-0 flex-col overflow-hidden">
            <CardContent className="flex-1 min-h-0 overflow-y-auto p-6">
              <div className="space-y-5">
                <CommandCard icon={meta.icon || IconSparkles} kicker={meta.kicker} title={meta.title} description={meta.description} controls={commandControls} />
                {activeReport === "queue-performance" ? (
                  <QueuePerformanceView data={reportData} loading={loading} />
                ) : activeReport === "agent-performance" ? (
                  <AgentPerformanceView data={reportData} loading={loading} />
                ) : activeReport === "agent-adherence" ? (
                  <AgentAdherenceView data={reportData} loading={loading} />
                ) : activeReport === "transfers-holds" ? (
                  <TransfersHoldsView data={reportData} loading={loading} />
                ) : activeReport === "wrapup-codes" ? (
                  <WrapupCodesView data={reportData} loading={loading} />
                ) : activeReport === "ai-handoffs" ? (
                  <AiHandoffsView data={reportData} loading={loading} />
                ) : (
                  <AbandonmentView data={reportData} loading={loading} />
                )}
              </div>
            </CardContent>
          </Card>
        </section>
      </main>
    </SupervisorPageShell>
  );
}
