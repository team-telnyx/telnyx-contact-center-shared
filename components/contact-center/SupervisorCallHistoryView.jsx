"use client";

import { InteractionChannel } from "./InteractionChannel";
import AnalyticsReportFilters from "./AnalyticsReportFilters";
import { channelDefinition } from "@/lib/acd/channel-registry.mjs";
import ConversationPreview from "./ConversationPreview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
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
  IconArrowDownLeft,
  IconArrowUpRight,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconAlertCircle,
  IconCheck,
  IconClock,
  IconExternalLink,
  IconInfoCircle,
  IconPhoneIncoming,
} from "@tabler/icons-react";
import InteractionDetailsSheet from "@/components/contact-center/InteractionDetailsSheet";
import { notify } from "@/components/ToastNotify";
import {
  SupervisorPageShell,
} from "@/components/contact-center/SupervisorPageLayout";
import { SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import { AnalyticsSectionRailNav } from "@/components/contact-center/AnalyticsSectionNav";
import useAppStateStore from "@/lib/stores/app-state-store";
import { TelephonyAddress } from "@/components/contact-center/TelephonyAddress";
import { callHistoryAddressDisplayName } from "@/lib/contact-center/telephony-address";
import { quickCallHistoryDateRange, resolveCallHistoryDateRange, toIsoDateTime } from "@/lib/contact-center/call-history-date-range.mjs";

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "-";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(
    2,
    "0",
  )}:${String(secs).padStart(2, "0")}`;
}

function formatShortNumber(value) {
  return Number(value || 0).toLocaleString();
}

function pct(value, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(value || 0) / Number(total || 1)) * 100)));
}

function HistoryMetricCard({ icon: Icon, label, value, detail, progress = 0, chip = "Range", tone = "slate" }) {
  const tones = {
    slate: "from-slate-500/15 to-zinc-500/5 text-slate-700 dark:text-slate-200",
    emerald: "from-emerald-500/15 to-teal-500/5 text-emerald-700 dark:text-emerald-300",
    sky: "from-sky-500/15 to-blue-500/5 text-sky-700 dark:text-sky-300",
    amber: "from-amber-500/15 to-orange-500/5 text-amber-700 dark:text-amber-300",
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

export default function SupervisorCallHistoryView({ embedded = false }) {
  const supervisorCallHistoryDateRange = useAppStateStore(
    (state) => state.supervisorCallHistoryDateRange,
  );
  const setSupervisorCallHistoryDateRange = useAppStateStore(
    (state) => state.setSupervisorCallHistoryDateRange,
  );
  const [items, setItems] = useState([]);
  const [totals,setTotals]=useState({});
  const [loadError,setLoadError]=useState(null);
  const [channel,setChannel]=useState("all");
  const [search,setSearch]=useState("");
  const [outcome,setOutcome]=useState("all");
  const [filters, setFilters] = useState(() => ({
    queue: "all",
    agent: "all",
  }));
  const [filterOptions, setFilterOptions] = useState({
    queues: [],
    agents: [],
  });
  const [loading, setLoading] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const requestRef = useRef(null);
  const dateRange = useMemo(
    () => resolveCallHistoryDateRange(supervisorCallHistoryDateRange),
    [supervisorCallHistoryDateRange],
  );
  const historyRange = dateRange.range;
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedInteraction, setSelectedInteraction] = useState(null);

  useEffect(() => {
    // Wait for the persisted browser state before sending the first request.
    setHydrated(true);
  }, []);

  const updateDateRangeFilter = (updates) => {
    const next = { ...dateRange, ...updates, range: "custom" };
    setPage(1);
    setSupervisorCallHistoryDateRange(next);
  };

  const setQuickDateRange = (days) => {
    const nextRange = quickCallHistoryDateRange(days);
    setPage(1);
    setSupervisorCallHistoryDateRange(nextRange);
  };

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("channel", channel);
    sp.set("timezone",Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC");
    if(search)sp.set("search",search);
    if(outcome!=="all")sp.set("outcome",outcome);
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    const fromIso = toIsoDateTime(dateRange.from);
    const toIso = toIsoDateTime(dateRange.to);
    if (fromIso) sp.set("from", fromIso);
    if (toIso) sp.set("to", toIso);
    if (filters.queue && filters.queue !== "all")
      sp.set("queue", filters.queue);
    if (filters.agent && filters.agent !== "all")
      sp.set("agent", filters.agent);
    return sp.toString();
  }, [page, pageSize, filters, dateRange,channel,search,outcome]);

  const load = useCallback(async () => {
    if (!hydrated) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/contact-center/interactions/history?${query}`,
        {
          cache: "no-store",
          signal: controller.signal,
        },
      );
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (!res.ok)
        throw new Error(data?.error || "Failed to load interaction history");
      setItems(data.rows || []);
      setTotal(Number(data.count || 0));
      setTotals(data.totals||{});setLoadError(null);
      if (data.filters) {
        setFilterOptions({
          queues: data.filters.queues || [],
          agents: data.filters.agents || [],
        });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setLoadError(err.message);
      notify({
        title: "Load failed",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [hydrated, query]);

  useEffect(() => {
    load();
    return () => requestRef.current?.abort();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const openDetails = (interaction) => {
    setSelectedInteraction(interaction);
    setDetailsOpen(true);
  };


  const historyMetrics = { total,visible:items.length,completed:Number(totals.completed||0),missed:Number(totals.missed||0),recordings:Number(totals.recordings||0),conversations:Number(totals.conversations||0),evidence:Number(totals.recordings||0)+Number(totals.conversations||0),
    completionRate:pct(Number(totals.completed||0),total),missedRate:pct(Number(totals.missed||0),total),recordingRate:pct(Number(totals.recordings||0),total) };

  const content = (
    <div className="h-full min-h-0 space-y-4 overflow-y-auto">
      <AnalyticsReportFilters
        channel={channel}
        onChannelChange={(value) => { setChannel(value); setPage(1); }}
        range={historyRange}
        onRangeChange={(value) => value === "custom" ? updateDateRangeFilter({}) : setQuickDateRange(Number(value.slice(0, -1)))}
        from={dateRange.from}
        to={dateRange.to}
        onFromChange={(from) => updateDateRangeFilter({ from })}
        onToChange={(to) => updateDateRangeFilter({ to })}
        onRefresh={load}
        loading={loading}
        queueFilter={(
          <select aria-label="Queue" value={filters.queue} onChange={(event) => { setPage(1); setFilters((previous) => ({ ...previous, queue: event.target.value })); }} className="h-10 max-w-48 rounded-lg border bg-background px-3 text-xs">
            <option value="all">All queues</option>
            {filterOptions.queues.map((queue) => <option key={queue} value={queue}>{queue}</option>)}
          </select>
        )}
      >
        <select aria-label="Agent" value={filters.agent} onChange={(event) => { setPage(1); setFilters((previous) => ({ ...previous, agent: event.target.value })); }} className="h-9 max-w-full rounded-lg border bg-background px-3 text-xs">
          <option value="all">All agents</option>
          {filterOptions.agents.map((agent) => <option key={agent.username} value={agent.username}>{agent.name}</option>)}
        </select>
        <select aria-label="Outcome" value={outcome} onChange={(event) => { setOutcome(event.target.value); setPage(1); }} className="h-9 max-w-full rounded-lg border bg-background px-3 text-xs">
          <option value="all">All outcomes</option><option value="completed">Completed</option><option value="abandoned">Abandoned</option><option value="failed">Failed</option>
        </select>
        <Input aria-label="Search interactions" placeholder="Customer, address or interaction ID" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className="h-9 w-full sm:max-w-xs sm:flex-1" />
      </AnalyticsReportFilters>
          {loading ? <Skeleton className="h-32 w-full"/> : loadError ? <p role="alert" className="mt-4 text-sm text-destructive">{loadError}</p> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <HistoryMetricCard icon={IconPhoneIncoming} label="Interactions" value={formatShortNumber(historyMetrics.total)} detail={`${formatShortNumber(historyMetrics.visible)} visible on current page`} progress={pct(historyMetrics.visible, Math.max(historyMetrics.total, 1))} chip="Range" tone="sky" />
            <HistoryMetricCard icon={IconCheck} label="Completed" value={formatShortNumber(historyMetrics.completed)} detail={`${historyMetrics.completionRate}% of matching interactions`} progress={historyMetrics.completionRate} chip="Range" tone="emerald" />
            <HistoryMetricCard icon={IconAlertCircle} label="Unserved" value={formatShortNumber(historyMetrics.missed)} detail={`${historyMetrics.missedRate}% abandoned / failed`} progress={historyMetrics.missedRate} chip="Range" tone="amber" />
            <HistoryMetricCard icon={IconClock} label="Evidence" value={formatShortNumber(historyMetrics.evidence)} detail={`${historyMetrics.conversations} conversations · ${historyMetrics.recordings} recordings`} progress={pct(historyMetrics.evidence,total)} chip="Assets" tone="slate" />
          </div>}
        <Card className="border-border/70 bg-card shadow-sm">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Channel</TableHead><TableHead>Direction</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Queue</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Evidence</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    Array.from({ length: 6 }).map((_, idx) => (
                      <TableRow key={`skeleton-${idx}`}>
                        {Array.from({ length: 11 }).map((__, cellIdx) => (<TableCell key={`skeleton-${idx}-${cellIdx}`}><Skeleton className="h-4 w-full" /></TableCell>))}
                      </TableRow>
                    ))
                  ) : loadError ? (<TableRow><TableCell colSpan={11} role="alert" className="p-6 text-destructive">{loadError}</TableCell></TableRow>) : items.length === 0 ? (
                    <TableRow><TableCell colSpan={11} className="text-center text-sm">No matching interactions found.</TableCell></TableRow>
                  ) : (
                    items.map((item) => {
                      const startedAt = item.customer_started_at || (Number(item.transfer_count || 0) > 0 ? item.created_at : null) || item.answered_at || item.assigned_at || item.enqueued_at || item.created_at;
                      const durationSeconds = item.interaction_duration_seconds ?? item.handle_time_seconds ?? (item.completed_at && startedAt ? Math.floor((new Date(item.completed_at) - new Date(startedAt)) / 1000) : null);
                      const hasRecording = Boolean(item.recording_url || item.metadata?.recording?.recording_url || item.metadata?.recording?.recording_urls?.mp3);
                      const state = String(item.state || "").toLowerCase();
                      const statusClass = state.includes("complete") ? "border-green-500 text-green-500" : state.includes("abandon") || state.includes("fail") || state.includes("hangup") ? "border-red-500 text-red-500" : "border-blue-500 text-blue-500";
                      return (
                        <TableRow key={item.id} className="hover:bg-muted/50">
                          <TableCell><InteractionChannel channel={item.interaction_type} /></TableCell>
                          <TableCell>{item.direction === "inbound" ? <IconArrowDownLeft className="h-4 w-4 text-green-500" /> : <IconArrowUpRight className="h-4 w-4 text-blue-500" />}</TableCell>
                          <TableCell className="w-[180px] max-w-[180px]">
                            {item.subject && <p className="mb-1 truncate text-xs font-medium" title={item.subject}>{item.subject}</p>}
                            {item.interaction_type === "voice" ? <TelephonyAddress
                              value={item.from_number}
                              displayName={callHistoryAddressDisplayName(item, "from")}
                            /> : <span className="block truncate text-xs" title={item.from_number}>{item.from_number || "—"}</span>}
                          </TableCell>
                          <TableCell className="w-[180px] max-w-[180px]">
                            {item.interaction_type === "voice" ? <TelephonyAddress
                              value={item.to_number}
                              displayName={callHistoryAddressDisplayName(item, "to")}
                            /> : <span className="block truncate text-xs" title={item.to_number}>{item.to_number || "—"}</span>}
                          </TableCell>
                          <TableCell>{item.queue_name || "-"}</TableCell>
                          <TableCell>{item.agent_name || item.agent_username || "-"}</TableCell>
                          <TableCell>{formatDateTime(startedAt)}</TableCell>
                          <TableCell>{formatDuration(durationSeconds)}</TableCell>
                          <TableCell><Badge variant="outline" className={`uppercase bg-transparent ${statusClass}`}>{item.state || "unknown"}</Badge></TableCell>
                          <TableCell>{channelDefinition(item.interaction_type).capabilities.conversation ? <Badge variant="outline">Conversation</Badge> : hasRecording ? <Badge className="bg-green-500/10 text-green-500 border border-green-500/40">Available</Badge> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Button size="icon" variant="ghost" aria-label={`Preview interaction ${item.id}`} onClick={() => openDetails(item)}><IconInfoCircle className="h-4 w-4" /></Button>
                              <Button size="icon" variant="ghost" asChild><Link aria-label={`Open interaction ${item.id}`} href={`/supervisor/interactions-history/${item.id}`}><IconExternalLink className="h-4 w-4" /></Link></Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card shadow-sm">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
            <div className="text-sm font-medium text-foreground">Page {page} of {totalPages}</div>
            <div className="flex items-center gap-3">
              <Button size="icon" variant="outline" onClick={() => setPage(1)} disabled={page === 1} className="rounded-full"><IconChevronsLeft className="h-4 w-4" /></Button>
              <Button size="icon" variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="rounded-full"><IconChevronLeft className="h-4 w-4" /></Button>
              <Button size="icon" variant="outline" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="rounded-full"><IconChevronRight className="h-4 w-4" /></Button>
              <Button size="icon" variant="outline" onClick={() => setPage(totalPages)} disabled={page === totalPages} className="rounded-full"><IconChevronsRight className="h-4 w-4" /></Button>
              <span className="text-sm font-medium text-foreground ml-2">Rows per page</span>
              <Select value={String(pageSize)} onValueChange={(value) => { setPage(1); setPageSize(Number(value)); }}>
                <SelectTrigger className="w-[110px] rounded-full px-4"><SelectValue placeholder="Rows" /></SelectTrigger>
                <SelectContent>{[10, 25, 50, 100].map((size) => (<SelectItem key={size} value={String(size)}>{size}</SelectItem>))}</SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
    </div>
  );

  const details = (
    channelDefinition(selectedInteraction?.interaction_type).capabilities.conversation ? <ConversationPreview open={detailsOpen} onOpenChange={setDetailsOpen} interaction={selectedInteraction} /> : <InteractionDetailsSheet open={detailsOpen} onOpenChange={setDetailsOpen} interaction={selectedInteraction} />
  );

  if (embedded) {
    return <>{content}{details}</>;
  }

  return (
    <SupervisorPageShell>
      <main
        className={SECTION_RAIL_PAGE_GRID_CLASS}
        style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}
      >
        <AnalyticsSectionRailNav activeId="call-history" />
        <section className="h-full min-h-0 overflow-hidden pr-1">{content}</section>
      </main>
      {details}
    </SupervisorPageShell>
  );
}
