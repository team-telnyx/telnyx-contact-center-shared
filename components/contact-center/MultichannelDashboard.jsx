"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCheck,
  Clock3,
  Layers,
  ShieldCheck,
  Users,
} from "lucide-react";
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
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { InteractionChannel } from "./InteractionChannel";
import AnalyticsReportFilters from "./AnalyticsReportFilters";
import { quickCallHistoryDateRange } from "@/lib/contact-center/call-history-date-range.mjs";
import { channelDefinition } from "@/lib/acd/channel-registry.mjs";
import { formatCapacityUtilization } from "@/lib/contact-center/capacity-display.mjs";
import ConversationPreview from "./ConversationPreview";
import InteractionRecordPreview from "./InteractionRecordPreview";
import SupervisorReportContent from "./SupervisorReportContent";
const colors = {
  sky: "#0284c7",
  emerald: "#059669",
  green: "#16a34a",
  violet: "#8b5cf6",
  amber: "#d97706",
  slate: "#64748b",
};
const metricIconTones = {
  sky: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  green: "bg-green-600/10 text-green-700 dark:text-green-400",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  slate: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
};
export const duration = (value) =>
  value == null
    ? "—"
    : value >= 3600
      ? `${(value / 3600).toFixed(1)}h`
      : value >= 60
        ? `${Math.round(value / 60)}m ${Math.round(value % 60)}s`
        : `${Math.round(value)}s`;
const percent = (value) =>
  value == null ? "—" : `${Number(value).toFixed(1)}%`;
function Metric({
  label,
  value,
  detail,
  icon: Icon = Layers,
  tone = "slate",
  loading = false,
}) {
  return (
    <Card className="overflow-hidden border-border/70 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
          {label}
          <span className={`rounded-xl p-2 ${metricIconTones[tone]}`}>
            <Icon className="size-4" />
          </span>
        </div>
        {loading ? (
          <Skeleton className="my-3 h-9 w-24" />
        ) : (
          <div className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">
            {value ?? "—"}
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}
function ReportTable({ headers, children, empty = false }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card text-card-foreground">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            {headers.map((h) => (
              <th key={h} className="whitespace-nowrap px-4 py-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {empty ? (
            <tr>
              <td
                colSpan={headers.length}
                className="p-8 text-center text-muted-foreground"
              >
                No matching interactions in this period.
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}
function WorkloadCard({ workload, personal = false, loading = false, channel, queueId, onOpenInteraction }) {
  return (
    <Card data-testid="live-workload-card">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Users className="size-4 text-emerald-600 dark:text-emerald-400" />
              {personal ? "Working now" : "Workforce capacity"}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {workload?.scope || "All channels, including offered work and wrap-up"}. Capacity remains global when
              filtering a channel.
            </p>
          </div>
          {loading ? <Skeleton className="h-7 w-28" /> : (
            <span className="text-lg font-semibold tabular-nums">
              {formatCapacityUtilization(workload.used, workload.budget)}
            </span>
          )}
        </div>
        {loading ? <Skeleton className="mt-4 h-2 w-full" /> : (
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{
                width: `${Math.min(100, workload.budget ? (workload.used / workload.budget) * 100 : 0)}%`,
              }}
            />
          </div>
        )}
        {personal && !loading && (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {workload.interactions
              .filter(
                (item) =>
                  (channel === "all" || item.channel === channel) &&
                  (queueId === "all" ||
                    item.queue_id === queueId ||
                    (queueId === "none" && !item.queue_id)),
              )
              .map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => onOpenInteraction?.(item)}
                  disabled={!onOpenInteraction}
                  className="flex items-center gap-3 rounded-xl border p-3 text-left enabled:hover:bg-muted/50"
                >
                  <InteractionChannel channel={item.channel} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {item.customer_address || "Customer"}
                    </span>
                    <span className="mt-1 block text-[10px] text-muted-foreground">
                      {item.queue_name || "No queue"} ·{" "}
                      {item.assignment_state || item.state}
                    </span>
                  </span>
                  <ArrowUpRight className="size-3" />
                </button>
              ))}
            {!workload.interactions.length && (
              <p className="text-xs text-muted-foreground">
                No current assignments.
              </p>
            )}
            {!onOpenInteraction &&
              workload.interactions.length > 0 && (
                <Link
                  href="/agent/desktop"
                  className="text-xs underline"
                >
                  Open Agent Desktop to handle interactions
                </Link>
              )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
const td = "whitespace-nowrap px-4 py-3";
export default function MultichannelDashboard({
  personal = false,
  className = "",
  report = "overview",
  onOpenInteraction,
  refreshKey,
}) {
  const [channel, setChannel] = useState("all"),
    [period, setPeriod] = useState("today"),
    [queueId, setQueueId] = useState("all");
  const [customFrom, setCustomFrom] = useState(""),
    [customTo, setCustomTo] = useState(""),
    [timezone, setTimezone] = useState(null);
  const [data, setData] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(null),
    [selected, setSelected] = useState(null),
    [selectedRecord, setSelectedRecord] = useState(null);
  const request = useRef(null),
    lastQuery = useRef(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setChannel(params.get("channel") || "all");
    setPeriod(params.get("period") || "today");
    setQueueId(params.get("queueId") || "all");
    setCustomFrom(params.get("reportFrom") || "");
    setCustomTo(params.get("reportTo") || "");
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  }, []);
  useEffect(() => {
    if (!timezone) return;
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries({
      channel,
      period,
      queueId,
      reportFrom: customFrom,
      reportTo: customTo,
    })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, "", url);
  }, [channel, period, queueId, customFrom, customTo, timezone]);
  const query = useMemo(() => {
    const params = new URLSearchParams({
      channel,
      period,
      report,
      timezone: timezone || "UTC",
    });
    if (queueId !== "all") params.set("queueId", queueId);
    if (customFrom && Number.isFinite(Date.parse(customFrom)))
      params.set("from", new Date(customFrom).toISOString());
    if (customTo && Number.isFinite(Date.parse(customTo)))
      params.set("to", new Date(customTo).toISOString());
    return params.toString();
  }, [channel, period, report, queueId, timezone, customFrom, customTo]);
  const load = useCallback(async () => {
    if (!timezone) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (lastQuery.current !== query) {
      setData(null);
      lastQuery.current = query;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `${personal ? "/api/dashboard/stats" : "/api/contact-center/reporting"}?${query}`,
        { cache: "no-store", signal: controller.signal },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Report unavailable");
      if (!controller.signal.aborted) {
        setData(payload);
        setError(null);
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(e.message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [personal, query, timezone]);
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 15000);
    const events = [
      "contact-center:acd-state",
      "contact-center:chat-changed",
      "contact-center:refresh-interactions",
    ];
    let debounce;
    const refresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(load, 250);
    };
    events.forEach((name) => window.addEventListener(name, refresh));
    return () => {
      clearInterval(timer);
      clearTimeout(debounce);
      request.current?.abort();
      events.forEach((name) => window.removeEventListener(name, refresh));
    };
  }, [load]);
  useEffect(() => {
    if (refreshKey != null) load();
  }, [refreshKey, load]);
  const trend = useMemo(() => {
    const points = new Map();
    for (const row of data?.trend || []) {
      const point = points.get(row.bucket) || { bucket: row.bucket };
      point[row.channel] = row.total;
      points.set(row.bucket, point);
    }
    return [...points.values()];
  }, [data]);
  const totals = data?.totals,
    workload = data?.workload,
    initial = loading && !data;
  const reportTitles = {
    overview: personal ? "My performance" : "Contact center overview",
    "queue-performance": "Queue performance",
    "agent-performance": "Agent scorecard",
    abandonment: "Unserved & abandonment",
    "wrapup-codes": "Wrap-up outcomes",
    "transfers-holds": "Transfers & holds",
  };
  const openRow = (row) => {
    if (personal && row.work_state && !row.terminal_at) {
      const assigned = workload?.interactions.find(
        (item) => item.id === row.work_item_id && !item.release_requested_at,
      );
      if (assigned) onOpenInteraction?.(assigned);
      return;
    }
    if (channelDefinition(row.channel).capabilities.conversation)
      setSelected({ id: row.work_item_id || row.id, channel: row.channel });
    else setSelectedRecord(row);
  };
  const ServiceLevelSection = personal ? "section" : "details";
  const ServiceLevelHeading = personal ? "h3" : "summary";
  return (
    <div
      className={`space-y-4 ${className}`}
      data-testid={
        personal
          ? "agent-multichannel-dashboard"
          : "supervisor-multichannel-dashboard"
      }
    >
      {personal && (
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{reportTitles[report] || "Interaction performance"}</h2>
          {personal && <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">Your participation across channels. SLA describes the customer’s experience, including waiting before assignment.</p>}
        </div>
      )}
      <AnalyticsReportFilters
        channel={channel}
        onChannelChange={setChannel}
        range={customFrom || customTo ? "custom" : { today: "1d", "7days": "7d", "30days": "30d" }[period]}
        onRangeChange={(value) => {
          if (value === "custom") {
            const dates = quickCallHistoryDateRange({ today: 1, "7days": 7, "30days": 30 }[period] || 1);
            setCustomFrom(dates.from);
            setCustomTo(dates.to);
          } else {
            setPeriod({ "1d": "today", "7d": "7days", "30d": "30days" }[value]);
            setCustomFrom("");
            setCustomTo("");
          }
        }}
        from={customFrom}
        to={customTo}
        onFromChange={setCustomFrom}
        onToChange={setCustomTo}
        onRefresh={load}
        loading={loading}
        queueFilter={(
          <select aria-label="Queue" value={queueId} onChange={(event) => setQueueId(event.target.value)} className="h-10 max-w-48 rounded-lg border bg-background px-3 text-xs">
            <option value="all">All queues</option>
            <option value="none">No queue</option>
            {data?.filters?.queues.map((queue) => <option key={queue.id} value={queue.id}>{queue.display_name || queue.name}</option>)}
          </select>
        )}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          Timezone: {timezone || "…"} · Outcomes: closed in range · SLA: started
          in range
        </span>
        <span>
          {data
            ? `Updated ${new Date(data.timestamp).toLocaleTimeString()}`
            : error
              ? "Report unavailable"
              : "Loading report…"}
        </span>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm"
        >
          {error}
          {data ? " · Showing the last successful snapshot." : ""}
        </div>
      )}
      {(data || initial) && (!personal && report !== "overview" ? (
        <SupervisorReportContent report={report} data={data} loading={initial} onPreview={openRow} />
      ) : (
        <>
          {personal && (workload || initial) && (
            <WorkloadCard workload={workload} personal loading={initial} channel={channel} queueId={queueId} onOpenInteraction={onOpenInteraction} />
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              loading={initial}
              icon={ArrowDownLeft}
              tone="sky"
              label="Received in range"
              value={totals?.received}
              detail="Distinct interactions created"
            />
            <Metric
              loading={initial}
              icon={CheckCheck}
              tone="emerald"
              label="Closed in range"
              value={totals?.closed}
              detail="Completed, abandoned and failed"
            />
            <Metric
              loading={initial}
              icon={Clock3}
              tone="amber"
              label="Waiting now"
              value={totals ? totals.waiting + totals.offered : null}
              detail="Queued and offered interactions"
            />
            <Metric
              loading={initial}
              icon={Activity}
              tone="violet"
              label="Handling now"
              value={totals?.active}
              detail="Live interactions · all ages"
            />
          </div>
          {initial ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Skeleton className="h-64 rounded-2xl" />
              <Skeleton className="h-64 rounded-2xl" />
            </div>
          ) : (
            <>
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_330px]">
                <Card>
                  <CardContent className="p-5">
                    <div className="mb-5 flex items-center justify-between">
                      <h3 className="text-sm font-semibold">
                        Closed interactions by channel
                      </h3>
                      <Badge variant="outline">
                        {data.scope.bucket === "hour" ? "Hourly" : "Daily"}
                      </Badge>
                    </div>
                    {trend.length ? (
                      <div className="h-80">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={trend}>
                            <CartesianGrid
                              vertical={false}
                              strokeDasharray="3 3"
                              opacity={0.25}
                            />
                            <XAxis
                              dataKey="bucket"
                              tick={{ fontSize: 10 }}
                              tickFormatter={(v) =>
                                data.scope.bucket === "hour"
                                  ? v.slice(11)
                                  : v.slice(5, 10)
                              }
                            />
                            <YAxis
                              allowDecimals={false}
                              tick={{ fontSize: 10 }}
                              width={35}
                            />
                            <Tooltip
                              cursor={{ fill: "var(--color-muted)", fillOpacity: 0.5 }}
                              contentStyle={{
                                background: "var(--color-popover)",
                                color: "var(--color-popover-foreground)",
                                borderColor: "var(--color-border)",
                                borderRadius: 12,
                                fontSize: 12,
                              }}
                            />
                            <Legend
                              iconType="circle"
                              wrapperStyle={{ fontSize: 11 }}
                            />
                            {data.channels.map((row) => (
                              <Bar
                                key={row.channel}
                                dataKey={row.channel}
                                name={row.label}
                                stackId="volume"
                                fill={
                                  colors[channelDefinition(row.channel).tone] ||
                                  colors.slate
                                }
                                maxBarSize={40}
                              />
                            ))}
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <div className="grid h-60 place-items-center text-sm text-muted-foreground">
                        No closed interactions in this period.
                      </div>
                    )}
                  </CardContent>
                </Card>
                <Card data-testid="dashboard-service-level">
                  <CardContent className="p-5">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <ShieldCheck className="size-4 text-emerald-600" />
                      Service level
                    </div>
                    <div className="mt-5 text-4xl font-semibold tracking-tight">
                      {percent(data.sla.rate)}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {data.sla.denominator} evaluated measurements
                    </p>
                    <div className="mt-5 grid grid-cols-2 gap-3 text-xs">
                      {[
                        ["Within SLA", data.sla.met],
                        ["Breached", data.sla.breached],
                        ["Unserved", data.sla.unserved],
                        ["Pending", data.sla.pending],
                      ].map(([label, value]) => (
                        <div
                          key={label}
                          className="rounded-lg border bg-background/60 p-3"
                        >
                          <span className="text-muted-foreground">{label}</span>
                          <strong className="mt-1 block text-lg tabular-nums">
                            {value}
                          </strong>
                        </div>
                      ))}
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
                      {[
                        ["At risk", data.sla.atRisk],
                        ["Not configured", data.sla.not_configured],
                        ["Disabled", data.sla.disabled],
                        ["Excluded", data.sla.excluded],
                        ["No historical rule", data.sla.unavailable],
                      ].map(([label, value]) => (
                        <div key={label} className="flex justify-between gap-2">
                          <dt>{label}</dt>
                          <dd className="font-medium text-foreground">
                            {value ?? 0}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-4 text-[10px] leading-relaxed text-muted-foreground">
                      Met ÷ (met + breached + unserved). Pending and
                      unconfigured measurements are excluded. Voice counts queue
                      visits; messaging counts first replies.
                    </p>
                  </CardContent>
                </Card>
              </div>
              {personal && data.workforce && (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">
                    My workforce time · all channels
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    Elapsed presence and status time in the selected period,
                    including the current interval. Concurrent interactions do
                    not multiply these durations.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {[
                      ["Logged in", data.workforce.agents[0]?.loggedInSeconds],
                      ["Available", data.workforce.agents[0]?.availableSeconds],
                      ["Break time", data.workforce.agents[0]?.breakSeconds],
                    ].map(([label, value]) => (
                      <Metric
                        key={label}
                        label={label}
                        value={duration(value)}
                        detail="Global workforce time"
                      />
                    ))}
                  </div>
                </section>
              )}
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Channel performance</h3>
                <ReportTable
                  headers={[
                    "Channel",
                    "Received",
                    "Closed",
                    "Completed",
                    "Abandoned",
                    "Failed",
                    "Queue wait",
                    "Handling elapsed",
                    "Voice talk",
                    "Customer first response",
                    ...(personal ? ["My first response"] : []),
                    "Resolution",
                    "SLA",
                  ]}
                >
                  {data.channels.map((row) => (
                    <tr key={row.channel}>
                      <td className={td}>
                        <InteractionChannel channel={row.channel} label />
                      </td>
                      {[
                        "received",
                        "closed",
                        "completed",
                        "abandoned",
                        "failed",
                      ].map((key) => (
                        <td key={key} className={td}>
                          {row[key]}
                        </td>
                      ))}
                      {[
                        "avgWaitSeconds",
                        "avgHandlingSeconds",
                        "avgTalkSeconds",
                        "avgResponseSeconds",
                        ...(personal ? ["avgAgentResponseSeconds"] : []),
                        "avgResolutionSeconds",
                      ].map((key) => (
                        <td
                          key={key}
                          className={td}
                          title={
                            key === "avgResponseSeconds"
                              ? `${row.responseCoverage} interactions with measured evidence`
                              : undefined
                          }
                        >
                          {duration(row[key])}
                        </td>
                      ))}
                      <td className={td}>
                        {percent(row.sla.rate)}
                        <span className="mt-1 block text-[10px] text-muted-foreground">
                          {row.sla.not_configured
                            ? "Not configured for some work"
                            : row.sla.disabled
                              ? "Disabled for some work"
                              : `${row.sla.denominator} measurements`}
                        </span>
                      </td>
                    </tr>
                  ))}
                </ReportTable>
                <p className="text-[10px] text-muted-foreground">
                  Durations are averages. Messaging handling is elapsed
                  assignment time, including concurrent work; it is not talk
                  time or occupancy. My first response measures each assignment
                  until the agent’s first persisted reply or accepted email
                  send.
                </p>
              </section>
              <ServiceLevelSection className={personal ? "space-y-3" : "rounded-xl border bg-card p-4"}>
                <ServiceLevelHeading className={`text-sm font-semibold ${personal ? "" : "cursor-pointer"}`}>
                  Service-level detail and trend
                </ServiceLevelHeading>
                <div className="mt-4 space-y-4">
                  <ReportTable
                    headers={[
                      "Channel",
                      "Evaluated",
                      "Met",
                      "Breached",
                      "Unserved",
                      "Avg lateness",
                      "P95 lateness",
                    ]}
                  >
                    {data.channels.map((row) => (
                      <tr key={row.channel}>
                        <td className={td}>
                          <InteractionChannel channel={row.channel} label />
                        </td>
                        {["denominator", "met", "breached", "unserved"].map(
                          (key) => (
                            <td key={key} className={td}>
                              {row.sla[key]}
                            </td>
                          ),
                        )}
                        <td className={td}>
                          {duration(row.sla.avgLatenessSeconds)}
                        </td>
                        <td className={td}>
                          {duration(row.sla.p95LatenessSeconds)}
                        </td>
                      </tr>
                    ))}
                  </ReportTable>
                  <p className="text-[11px] text-muted-foreground">
                    Lateness covers breached measurements. Pending work is not
                    counted as met. Each bucket uses the measurement start time.
                  </p>
                  <div className="max-h-80 overflow-y-auto">
                    <ReportTable
                      headers={[
                        "Channel",
                        "Started",
                        "Met",
                        "Evaluated",
                        "Attainment",
                        "Breached",
                        "Pending",
                      ]}
                      empty={!data.slaTrend?.length}
                    >
                      {(data.slaTrend || []).map((row, i) => (
                        <tr key={i}>
                          <td className={td}>
                            <InteractionChannel channel={row.channel} />
                          </td>
                          <td className={td}>{row.bucket}</td>
                          <td className={td}>{row.met}</td>
                          <td className={td}>{row.evaluated}</td>
                          <td className={td}>
                            {percent(
                              row.evaluated
                                ? (100 * row.met) / row.evaluated
                                : null,
                            )}
                          </td>
                          <td className={td}>{row.breached}</td>
                          <td className={td}>{row.pending}</td>
                        </tr>
                      ))}
                    </ReportTable>
                  </div>
                </div>
              </ServiceLevelSection>
              {!personal && workload && <WorkloadCard workload={workload} />}
              {report === "overview" && (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Queue participation</h3>
                  <ReportTable
                    headers={[
                      "Channel",
                      "Queue",
                      "Interactions",
                      "Completed",
                      "Abandoned",
                      "Failed",
                    ]}
                    empty={!data.queues.length}
                  >
                    {data.queues.map((row, i) => (
                      <tr key={i}>
                        <td className={td}>
                          <InteractionChannel channel={row.channel} />
                        </td>
                        <td className={td}>{row.queue_name}</td>
                        {["total", "completed", "abandoned", "failed"].map(
                          (key) => (
                            <td key={key} className={td}>
                              {row[key]}
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </ReportTable>
                  <p className="text-[10px] text-muted-foreground">
                    A transferred interaction can participate in several queues.
                    Global totals count it once.
                  </p>
                </section>
              )}
              {!personal && !!data.breaches.length && (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">
                    SLA attention · latest {data.breaches.length} measurements
                  </h3>
                  <ReportTable
                    headers={[
                      "Channel",
                      "Customer",
                      "Queue",
                      "Status",
                      "Deadline",
                      "Evidence",
                    ]}
                  >
                    {data.breaches.map((row) => (
                      <tr key={row.id}>
                        <td className={td}>
                          <InteractionChannel channel={row.channel} />
                        </td>
                        <td className={td}>
                          {row.customer_address || "Customer"}
                        </td>
                        <td className={td}>{row.queue_name || "No queue"}</td>
                        <td className={td}>
                          <Badge variant="outline">
                            {row.at_risk ? "At risk" : row.state}
                          </Badge>
                        </td>
                        <td className={td}>
                          {new Date(row.deadline_at).toLocaleString()}
                        </td>
                        <td className={td}>
                          {
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={
                                personal &&
                                !row.terminal_at &&
                                (!onOpenInteraction ||
                                  !workload?.interactions.some(
                                    (item) =>
                                      item.id === row.work_item_id &&
                                      !item.release_requested_at,
                                  ))
                              }
                              onClick={() => openRow(row)}
                            >
                              {personal && !row.terminal_at
                                ? "Open assigned work"
                                : channelDefinition(row.channel).capabilities
                                      .conversation
                                  ? "Conversation"
                                  : "Details"}
                            </Button>
                          }
                        </td>
                      </tr>
                    ))}
                  </ReportTable>
                </section>
              )}
            </>
          )}
        </>
      ))}
      <InteractionRecordPreview
        interaction={selectedRecord}
        onOpenChange={(open) => {
          if (!open) setSelectedRecord(null);
        }}
      />
      <ConversationPreview
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        interaction={selected}
      />
    </div>
  );
}
