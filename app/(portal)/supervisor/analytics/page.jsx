"use client";

import AnalyticsReportFilters from "@/components/contact-center/AnalyticsReportFilters";
import MultichannelDashboard from "@/components/contact-center/MultichannelDashboard";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useAnalyticsQueueOptions } from "@/components/contact-center/useAnalyticsQueueOptions";
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
  IconAlertCircle,
  IconFilter,
  IconHistory,
  IconArrowBounce,
  IconCheck,
  IconClock,
  IconClockPause,
  IconExternalLink,
  IconHourglassLow,
  IconLogin,
  IconPhoneOff,
  IconPuzzle,
  IconRobot,
  IconSpeakerphone,
  IconTrendingUp,
  IconUsers,
} from "@tabler/icons-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { notify } from "@/components/ToastNotify";
import {
  SupervisorPageShell,
} from "@/components/contact-center/SupervisorPageLayout";
import { SectionRail, SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import SupervisorCallHistoryView from "@/components/contact-center/SupervisorCallHistoryView";
import {
  ANALYTICS_ACTIVE_SECTION_STORAGE_KEY,
  ANALYTICS_RAIL_ITEMS,
  persistAnalyticsSection,
} from "@/components/contact-center/AnalyticsSectionNav";

const ANALYTICS_UI_STATE_STORAGE_KEYS = {
  activeSection: ANALYTICS_ACTIVE_SECTION_STORAGE_KEY,
};

function pct(value, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(value || 0) / Number(total || 1)) * 100)));
}

function formatShortNumber(value) {
  if(value==null)return "—";
  return Number(value || 0).toLocaleString();
}

function formatDurationShort(seconds) {
  if(seconds==null)return "—";
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
  to.setDate(to.getDate() + 1);
  to.setHours(0, 0, 0, 0);
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
    <Card className="overflow-hidden border bg-card shadow-sm transition hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md">
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

function ReportCardTitle({ icon: Icon, tone = "sky", children }) {
  const tones = {
    sky: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  };
  return <CardTitle className="flex items-center gap-2.5 text-base">
    {Icon && <span className={`rounded-lg p-2 ${tones[tone]}`}><Icon className="size-4" aria-hidden="true" /></span>}
    {children}
  </CardTitle>;
}

function GraphCard({ title, description, children, icon, tone }) {
  return (
    <Card className="border bg-card shadow-sm">
      <CardHeader>
        <ReportCardTitle icon={icon} tone={tone}>{title}</ReportCardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const STATUS_TONES = {
  Available: "border-green-500 text-green-700 dark:text-green-300",
  Busy: "border-sky-500 text-sky-700 dark:text-sky-300",
  Wrapup: "border-violet-500 text-violet-700 dark:text-violet-300",
  Break: "border-amber-500 text-amber-700 dark:text-amber-300",
  Lunch: "border-amber-500 text-amber-700 dark:text-amber-300",
  Away: "border-orange-500 text-orange-700 dark:text-orange-300",
  Offline: "border-zinc-400 text-zinc-600 dark:text-zinc-400",
};

function statusBadgeClass(status) {
  return Object.hasOwn(STATUS_TONES, status)
    ? STATUS_TONES[status]
    : "border-border text-muted-foreground";
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
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-muted)", fillOpacity: 0.5 }} />
              <Bar dataKey="minutes" name="minutes" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
        <Card className="border-border/70 bg-card shadow-sm">
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

      <Card className="border-border/70 bg-card shadow-sm">
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
                  <TableHead className="text-right">Busy time</TableHead>
                  <TableHead className="text-right">Break</TableHead>
                  <TableHead className="text-right">Availability</TableHead>
                  <TableHead className="text-right">Busy share</TableHead>
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
        <OverviewMetricCard icon={IconArrowBounce} label="Transfers" value={formatShortNumber(totals.transferCount)} detail={`${totals.transferRatePct}% of interactions had a transfer`} progress={totals.transferRatePct || 0} chip="Range" tone="amber" />
        <OverviewMetricCard icon={IconHourglassLow} label="Hold events" value={formatShortNumber(totals.holdCount)} detail={`${totals.holdRatePct}% of interactions had a hold`} progress={totals.holdRatePct || 0} chip="Range" tone="violet" />
        <OverviewMetricCard icon={IconClock} label="Avg hold time" value={formatDurationShort(totals.avgHoldSeconds)} detail={`${formatDurationShort(totals.holdDurationSeconds)} total hold time`} progress={pct(totals.avgHoldSeconds, Math.max(totals.maxHoldSeconds, 1))} chip="Holds" tone="sky" />
        <OverviewMetricCard icon={IconAlertCircle} label="Longest hold" value={formatDurationShort(totals.maxHoldSeconds)} detail="Worst single-call hold time" progress={100} chip="Outlier" tone="slate" />
      </div>

      <GraphCard title="Transfer and hold pressure by queue" description="Which queues generate rework and customer waiting.">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={queueChartData.length ? queueChartData : [{ label: "No data", transfers: 0, holds: 0 }]} margin={{ left: -20, right: 10 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
            <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-muted)", fillOpacity: 0.5 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="transfers" name="transfers" fill="#f59e0b" radius={[6, 6, 0, 0]} />
            <Bar dataKey="holds" name="holds" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </GraphCard>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-border/70 bg-card shadow-sm">
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

        <Card className="border-border/70 bg-card shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">Longest holds</CardTitle>
            <p className="text-sm text-muted-foreground">Worst caller experiences — review these recordings first.</p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[420px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
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
                            <Link href={`/supervisor/interactions-history/${row.id}`}><IconExternalLink className="h-4 w-4" /></Link>
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
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-muted)", fillOpacity: 0.5 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="total" name="handoffs" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
              <Bar dataKey="processed" name="processed" fill="#10b981" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
        <Card className="border-border/70 bg-card shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">Handoff destinations</CardTitle>
            <p className="text-sm text-muted-foreground">Queues that receive AI handoffs and their linked interaction outcomes.</p>
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

      <Card className="border-border/70 bg-card shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">Recent handoff events</CardTitle>
          <p className="text-sm text-muted-foreground">Latest AI → agent handoffs with processing status; failures need attention.</p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[420px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
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
                            <Link href={`/supervisor/interactions-history/${row.interactionId}`}><IconExternalLink className="h-4 w-4" /></Link>
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

function campaignRunBadgeClass(status) {
  if (status === "completed") return "border-green-500 text-green-600";
  if (status === "running") return "border-sky-500 text-sky-600";
  if (status === "paused") return "border-amber-500 text-amber-600";
  return "border-zinc-400 text-zinc-500";
}

function OutboundCampaignsView({ data, loading }) {
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
        <OverviewMetricCard icon={IconSpeakerphone} label="Dial attempts" value={formatShortNumber(totals.attempts)} detail={`${formatShortNumber(totals.campaigns)} campaigns · ${formatShortNumber(totals.runs)} runs in range`} progress={pct(totals.attempts, Math.max(totals.attempts, 1))} chip="Range" tone="sky" />
        <OverviewMetricCard icon={IconCheck} label="Connect rate" value={`${totals.connectRatePct || 0}%`} detail={`${formatShortNumber(totals.answered + totals.completed)} connected calls`} progress={totals.connectRatePct || 0} chip="Range" tone="emerald" />
        <OverviewMetricCard icon={IconAlertCircle} label="Failed attempts" value={formatShortNumber(totals.failed)} detail={`${pct(totals.failed, Math.max(totals.attempts, 1))}% of attempts failed`} progress={pct(totals.failed, Math.max(totals.attempts, 1))} chip="Range" tone="amber" />
        <OverviewMetricCard icon={IconPhoneOff} label="Suppressed / skipped" value={formatShortNumber(totals.suppressed)} detail="DNC, filters, and cancelled attempts" progress={pct(totals.suppressed, Math.max(totals.attempts, 1))} chip="Compliance" tone="violet" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <GraphCard icon={IconFilter} tone="sky" title="Attempt funnel" description="Ledger statuses for all dial attempts in the selected range.">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.funnel?.length ? data.funnel : [{ status: "No data", total: 0 }]} layout="vertical" margin={{ left: 30, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis type="number" tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
              <YAxis type="category" dataKey="status" tickLine={false} axisLine={false} fontSize={11} width={100} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-muted)", fillOpacity: 0.5 }} />
              <Bar dataKey="total" name="attempts" fill="#0ea5e9" radius={[0, 6, 6, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
        <GraphCard icon={IconClock} tone="emerald" title="Best calling hours" description="Attempts vs connected by hour of day — when outreach works.">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.hourly?.length ? data.hourly : [{ label: "No data", attempts: 0, connected: 0 }]} margin={{ left: -20, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-muted)", fillOpacity: 0.5 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="attempts" name="attempts" fill="#71717a" radius={[6, 6, 0, 0]} />
              <Bar dataKey="connected" name="connected" fill="#10b981" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraphCard>
      </div>

      <Card className="border-border/70 bg-card shadow-sm">
        <CardHeader>
          <ReportCardTitle icon={IconSpeakerphone} tone="violet">Campaign effectiveness</ReportCardTitle>
          <p className="text-sm text-muted-foreground">Attempts, outcomes, and connect rate per campaign in the selected range.</p>
        </CardHeader>
        <CardContent className="p-0">
          <div role="region" aria-label="Campaign effectiveness" tabIndex={0} className="max-h-[440px] overflow-auto overscroll-contain [&>[data-slot=table-container]]:overflow-visible">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead className="text-right">Answered</TableHead>
                  <TableHead className="text-right">Completed</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Suppressed</TableHead>
                  <TableHead className="text-right">Connect rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.campaigns?.length ? (
                  data.campaigns.map((campaign) => (
                    <TableRow key={campaign.id} className="h-10 hover:bg-muted/50 [&>td]:py-0">
                      <TableCell className="max-w-[420px] truncate font-medium" title={campaign.name}>{campaign.name}</TableCell>
                      <TableCell><Badge variant="outline" className={`bg-transparent uppercase ${campaignRunBadgeClass(campaign.campaignStatus)}`}>{campaign.campaignStatus || "—"}</Badge></TableCell>
                      <TableCell className="text-right">{formatShortNumber(campaign.runs)}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(campaign.attempts)}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(campaign.answered)}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(campaign.completed)}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(campaign.failed)}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(campaign.suppressed)}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="outline" className={campaign.connectRatePct >= 40 ? "border-green-500 text-green-600" : campaign.connectRatePct >= 15 ? "border-amber-500 text-amber-600" : "border-red-500 text-red-500"}>
                          {campaign.connectRatePct}%
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={9} className="text-center text-sm">No campaigns with activity in the selected range.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-border/70 bg-card shadow-sm">
          <CardHeader>
            <ReportCardTitle icon={IconAlertCircle} tone="amber">Failure reasons</ReportCardTitle>
            <p className="text-sm text-muted-foreground">Why dial attempts failed in the selected range.</p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.failures?.length ? (
                  data.failures.map((row) => (
                    <TableRow key={row.reason} className="hover:bg-muted/50">
                      <TableCell className="font-medium">{row.reason}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(row.total)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={2} className="text-center text-sm">No failed attempts in the selected range. 🎉</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card shadow-sm">
          <CardHeader>
            <ReportCardTitle icon={IconHistory} tone="sky">Recent runs</ReportCardTitle>
            <p className="text-sm text-muted-foreground">Latest campaign runs with who started them and why they stopped.</p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[360px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Started by</TableHead>
                    <TableHead className="text-right">Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recentRuns?.length ? (
                    data.recentRuns.map((run) => (
                      <TableRow key={run.id} className="hover:bg-muted/50">
                        <TableCell className="font-medium">{run.campaignName}</TableCell>
                        <TableCell><Badge variant="outline" className={`bg-transparent uppercase ${campaignRunBadgeClass(run.status)}`} title={run.stopReason || undefined}>{run.status}</Badge></TableCell>
                        <TableCell>{run.startedBy || "—"}</TableCell>
                        <TableCell className="text-right text-xs">{formatDateTime(run.startedAt)}</TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow><TableCell colSpan={4} className="text-center text-sm">No campaign runs in the selected range.</TableCell></TableRow>
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

function SkillsGapView({ data, loading }) {
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const totals = data.totals || {};
  const supplyChart = (data.supply || []).map((row) => ({
    label: row.skillName,
    agents: row.agents,
    avgProficiency: row.avgProficiency,
  }));
  const worstGap = (data.demand || []).filter((row) => row.coverageGap > 0).sort((a, b) => b.coverageGap - a.coverageGap)[0];
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OverviewMetricCard icon={IconPuzzle} label="Active skills" value={formatShortNumber(totals.skills)} detail={`${formatShortNumber(totals.skillsInDemand)} skills requested by interactions in range`} progress={pct(totals.skillsInDemand, Math.max(totals.skills, 1))} chip="Catalog" tone="sky" />
        <OverviewMetricCard icon={IconAlertCircle} label="Uncovered skills" value={formatShortNumber(totals.uncoveredSkills)} detail="Requested by interactions but no agent has them" progress={pct(totals.uncoveredSkills, Math.max(totals.skillsInDemand, 1))} chip="Gap" tone="amber" />
        <OverviewMetricCard icon={IconUsers} label="Deepest skill pool" value={formatShortNumber(totals.totalSkilledAgents)} detail="Most agents sharing a single skill" progress={pct(totals.totalSkilledAgents, Math.max(totals.totalSkilledAgents, 1))} chip="Supply" tone="emerald" />
        <OverviewMetricCard icon={IconTrendingUp} label="Biggest gap" value={worstGap ? worstGap.skillName : "—"} detail={worstGap ? `Required ~L${worstGap.avgRequiredLevel.toFixed(1)} vs avg L${worstGap.avgProficiency.toFixed(1)}` : "Supply covers current demand"} progress={worstGap ? Math.min(100, Math.round(worstGap.coverageGap * 20)) : 0} chip="Insight" tone="violet" />
      </div>

      <GraphCard title="Skill supply" description="Agents per skill with average proficiency (1–5 scale).">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={supplyChart.length ? supplyChart : [{ label: "No skills", agents: 0, avgProficiency: 0 }]} margin={{ left: -20, right: 10 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} interval={0} angle={-15} height={50} textAnchor="end" />
            <YAxis tickLine={false} axisLine={false} fontSize={12} allowDecimals={false} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-muted)", fillOpacity: 0.5 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="agents" name="agents" fill="#0ea5e9" radius={[6, 6, 0, 0]} />
            <Bar dataKey="avgProficiency" name="avg proficiency" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </GraphCard>

      <Card className="border-border/70 bg-card shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">Demand vs supply</CardTitle>
          <p className="text-sm text-muted-foreground">Skills requested by interactions in range, against the current agent pool.</p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Skill</TableHead>
                  <TableHead className="text-right">Interactions requiring</TableHead>
                  <TableHead className="text-right">Avg required level</TableHead>
                  <TableHead className="text-right">Agents with skill</TableHead>
                  <TableHead className="text-right">Avg proficiency</TableHead>
                  <TableHead className="text-right">Avg wait</TableHead>
                  <TableHead className="text-right">Abandon rate</TableHead>
                  <TableHead className="text-right">Coverage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.demand?.length ? (
                  data.demand.map((row) => (
                    <TableRow key={row.skillName} className="hover:bg-muted/50">
                      <TableCell className="font-medium">{row.skillName}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(row.interactions)}</TableCell>
                      <TableCell className="text-right">L{row.avgRequiredLevel.toFixed(1)}</TableCell>
                      <TableCell className="text-right">{formatShortNumber(row.agentsWithSkill)}</TableCell>
                      <TableCell className="text-right">{row.avgProficiency ? `L${row.avgProficiency.toFixed(1)}` : "—"}</TableCell>
                      <TableCell className="text-right">{formatDurationShort(row.avgWaitSeconds)}</TableCell>
                      <TableCell className="text-right">{row.abandonRatePct}%</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="outline" className={row.agentsWithSkill === 0 ? "border-red-500 text-red-500" : row.coverageGap > 0.5 ? "border-amber-500 text-amber-600" : "border-green-500 text-green-600"}>
                          {row.agentsWithSkill === 0 ? "Uncovered" : row.coverageGap > 0.5 ? "Below level" : "Covered"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={8} className="text-center text-sm">No skill-based routing demand in the selected range.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/70 bg-card shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">Queue skill requirements</CardTitle>
          <p className="text-sm text-muted-foreground">Configured queue requirements and how many agents currently qualify.</p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Queue</TableHead>
                <TableHead>Skill</TableHead>
                <TableHead className="text-right">Required level</TableHead>
                <TableHead className="text-right">Qualified agents</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.queueRequirements?.length ? (
                data.queueRequirements.map((row, idx) => (
                  <TableRow key={`${row.queueName}-${row.skillName}-${idx}`} className="hover:bg-muted/50">
                    <TableCell className="font-medium">{row.queueName}</TableCell>
                    <TableCell>{row.skillName}</TableCell>
                    <TableCell className="text-right">L{row.requiredLevel}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant="outline" className={row.qualifiedAgents === 0 ? "border-red-500 text-red-500" : row.qualifiedAgents < 2 ? "border-amber-500 text-amber-600" : "border-green-500 text-green-600"}>
                        {formatShortNumber(row.qualifiedAgents)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow><TableCell colSpan={4} className="text-center text-sm">No queues with skill requirements configured.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export default function SupervisorAnalyticsPage() {
  const [activeReport, setActiveReport] = useState("queue-performance");
  const [range, setRange] = useState("7d");
  const [dateRange, setDateRange] = useState(() => quickAnalyticsDateRange(7));
  const [channel,setChannel]=useState("all");
  const [queueFilter, setQueueFilter] = useState("all");
  const [reportData, setReportData] = useState(null);
  const [reportError,setReportError]=useState(null);
  const [applicability,setApplicability]=useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    try {
      const requested = new URLSearchParams(window.location.search).get("section");
      if (requested && ANALYTICS_RAIL_ITEMS.some((item) => item.id === requested)) {
        setActiveReport(requested);
        return;
      }

      const saved = localStorage.getItem(ANALYTICS_UI_STATE_STORAGE_KEYS.activeSection);
      if (saved && ANALYTICS_RAIL_ITEMS.some((item) => item.id === saved)) setActiveReport(saved);
    } catch {
      // Ignore storage errors so analytics still works without persisted UI state.
    }
  }, []);

  useEffect(() => {
    persistAnalyticsSection(activeReport);
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("section") !== activeReport) {
        url.searchParams.set("section", activeReport);
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {}
  }, [activeReport]);

  const analyticsQuery = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("report", activeReport);
    sp.set("channel",channel);
    sp.set("timezone",Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC");
    const fromIso = toIsoDateTime(dateRange.from);
    const toIso = toIsoDateTime(dateRange.to);
    if (fromIso) sp.set("from", fromIso);
    if (toIso) sp.set("to", toIso);
    if (queueFilter && queueFilter !== "all") sp.set("queue", queueFilter);
    return sp.toString();
  }, [activeReport, dateRange, queueFilter,channel]);

  useEffect(() => {
    let cancelled = false;
    async function loadReport() {
      setLoading(true);
      setReportError(null);
      setApplicability(null);
      try {
        const res = await fetch(`/api/contact-center/analytics?${analyticsQuery}`, { cache: "no-store" });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload?.error || "Failed to load analytics report");
        if (!cancelled) {setReportData(payload.data || null);setReportError(null);setApplicability(payload.applicability||null);}
      } catch (error) {
        if (!cancelled) {
          setReportData(null);setReportError(error.message);
          notify({ title: "Analytics load failed", description: String(error.message || error), variant: "error" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    // Call history embeds its own view with dedicated data loading.
    if (["call-history","queue-performance","agent-performance","abandonment","wrapup-codes"].includes(activeReport)) {
      setLoading(false);
      return undefined;
    }
    loadReport();
    return () => {
      cancelled = true;
    };
  }, [analyticsQuery, refreshNonce, activeReport]);

  const { queues: queueOptions, loading: queuesLoading, error: queuesError } = useAnalyticsQueueOptions(refreshNonce);

  const setQuickAnalyticsRange = (days) => {
    setRange(`${days}d`);
    setDateRange(quickAnalyticsDateRange(days));
  };

  const reportFilters = (
    <AnalyticsReportFilters
      channel={channel}
      onChannelChange={setChannel}
      range={range}
      onRangeChange={(value) => value === "custom" ? setRange(value) : setQuickAnalyticsRange(Number(value.slice(0, -1)))}
      from={dateRange.from}
      to={dateRange.to}
      onFromChange={(from) => { setRange("custom"); setDateRange((previous) => ({ ...previous, from })); }}
      onToChange={(to) => { setRange("custom"); setDateRange((previous) => ({ ...previous, to })); }}
      onRefresh={() => setRefreshNonce((nonce) => nonce + 1)}
      loading={loading}
      queueFilter={activeReport !== "agent-adherence" && (
        queuesLoading ? <Skeleton aria-label="Loading queue options" className="h-10 w-48" /> : queuesError ? <span role="alert" className="max-w-48 text-xs text-destructive">{queuesError}</span> : <select aria-label="Queue" value={queueFilter} onChange={(event) => setQueueFilter(event.target.value)} className="h-10 max-w-48 rounded-lg border bg-background px-3 text-xs">
          <option value="all">All queues</option>
          {queueFilter !== "all" && !queueOptions.includes(queueFilter) && <option value={queueFilter}>{queueFilter} (unavailable)</option>}
          {queueOptions.map((queue) => <option key={queue} value={queue}>{queue}</option>)}
        </select>
      )}
    />
  );

  return (
    <SupervisorPageShell>
      <main className={SECTION_RAIL_PAGE_GRID_CLASS} style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}>
        <SectionRail items={ANALYTICS_RAIL_ITEMS} activeId={activeReport} onSelect={setActiveReport} ariaLabel="Supervisor analytics reports" screenGroup="supervisor.analytics" />
        <section className="h-full min-h-0 overflow-hidden">
          {activeReport === "call-history" ? (
            <SupervisorCallHistoryView embedded />
          ) : ["queue-performance","agent-performance","abandonment","wrapup-codes"].includes(activeReport) ? (<div className="h-full overflow-y-auto"><MultichannelDashboard key={activeReport} report={activeReport}/></div>) : (
          <div className="h-full min-h-0 space-y-4 overflow-y-auto">
                {reportFilters}
                <p className="text-xs text-muted-foreground">{activeReport==="agent-adherence"?"Adherence is global workforce time; the channel filter does not divide presence.":activeReport==="outbound-campaigns"?"Voice campaign attempts and outcomes.":activeReport==="transfers-holds"?"Transfers across channels; hold measurements apply to Voice.":reportData?.scope}</p>
                {reportError?<div role="alert" className="rounded-xl border border-destructive/40 p-5 text-sm">{reportError}</div>:applicability?<div className="rounded-xl border p-5 text-sm">{applicability}</div>:activeReport === "agent-adherence" ? (
                  <AgentAdherenceView data={reportData} loading={loading} />
                ) : activeReport === "transfers-holds" ? (
                  <TransfersHoldsView data={reportData} loading={loading} />
                ) : activeReport === "ai-handoffs" ? (
                  <AiHandoffsView data={reportData} loading={loading} />
                ) : activeReport === "outbound-campaigns" ? (
                  <OutboundCampaignsView data={reportData} loading={loading} />
                ) : activeReport === "skills-gap" ? (
                  <SkillsGapView data={reportData} loading={loading} />
                ) : (
                  <p className="text-sm text-muted-foreground">Choose a report.</p>
                )}
          </div>
          )}
        </section>
      </main>
    </SupervisorPageShell>
  );
}
