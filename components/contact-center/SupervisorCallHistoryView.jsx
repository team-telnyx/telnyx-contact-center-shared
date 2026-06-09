"use client";

import { useEffect, useMemo, useState } from "react";
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
  IconHistory,
  IconInfoCircle,
  IconPhoneIncoming,
  IconRefresh,
} from "@tabler/icons-react";
import InteractionDetailsSheet from "@/components/contact-center/InteractionDetailsSheet";
import { notify } from "@/components/ToastNotify";
import {
  SupervisorPageHeader,
  SupervisorPageShell,
} from "@/components/contact-center/SupervisorPageLayout";
import { SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import { MonitorSectionRailNav } from "@/components/contact-center/MonitorSectionNav";
import useAppStateStore from "@/lib/stores/app-state-store";

function toLocalDateTimeInput(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function defaultCallHistoryDateRange() {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date();
  to.setHours(23, 59, 0, 0);
  return {
    from: toLocalDateTimeInput(from),
    to: toLocalDateTimeInput(to),
  };
}

function quickCallHistoryDateRange(days) {
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

function isValidDateRange(value) {
  return Boolean(
    value &&
      typeof value.from === "string" &&
      typeof value.to === "string" &&
      toIsoDateTime(value.from) &&
      toIsoDateTime(value.to),
  );
}

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

function toIsoDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export default function SupervisorCallHistoryView({ embedded = false }) {
  const supervisorCallHistoryDateRange = useAppStateStore(
    (state) => state.supervisorCallHistoryDateRange,
  );
  const setSupervisorCallHistoryDateRange = useAppStateStore(
    (state) => state.setSupervisorCallHistoryDateRange,
  );
  const [items, setItems] = useState([]);
  const [historyRange, setHistoryRange] = useState("1d");
  const [filters, setFilters] = useState(() => ({
    ...defaultCallHistoryDateRange(),
    queue: "all",
    agent: "all",
  }));
  const [filterOptions, setFilterOptions] = useState({
    queues: [],
    agents: [],
  });
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedInteraction, setSelectedInteraction] = useState(null);

  useEffect(() => {
    if (!isValidDateRange(supervisorCallHistoryDateRange)) return;
    setFilters((prev) => {
      if (
        prev.from === supervisorCallHistoryDateRange.from &&
        prev.to === supervisorCallHistoryDateRange.to
      ) {
        return prev;
      }
      return {
        ...prev,
        from: supervisorCallHistoryDateRange.from,
        to: supervisorCallHistoryDateRange.to,
      };
    });
  }, [supervisorCallHistoryDateRange]);

  const updateDateRangeFilter = (updates) => {
    const next = { ...filters, ...updates };
    setHistoryRange("custom");
    setPage(1);
    setSupervisorCallHistoryDateRange({ from: next.from, to: next.to });
    setFilters(next);
  };

  const setQuickDateRange = (days) => {
    const nextRange = quickCallHistoryDateRange(days);
    setHistoryRange(`${days}d`);
    setPage(1);
    setSupervisorCallHistoryDateRange(nextRange);
    setFilters((prev) => ({ ...prev, ...nextRange }));
  };

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    const fromIso = toIsoDateTime(filters.from);
    const toIso = toIsoDateTime(filters.to);
    if (fromIso) sp.set("from", fromIso);
    if (toIso) sp.set("to", toIso);
    if (filters.queue && filters.queue !== "all")
      sp.set("queue", filters.queue);
    if (filters.agent && filters.agent !== "all")
      sp.set("agent", filters.agent);
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/contact-center/interactions/history?${query}`,
        {
          cache: "no-store",
        },
      );
      const data = await res.json();
      if (!res.ok)
        throw new Error(data?.error || "Failed to load call history");
      setItems(data.rows || []);
      setTotal(Number(data.count || 0));
      if (data.filters) {
        setFilterOptions({
          queues: data.filters.queues || [],
          agents: data.filters.agents || [],
        });
      }
    } catch (err) {
      notify({
        title: "Load failed",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [query]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const openDetails = (interaction) => {
    setSelectedInteraction(interaction);
    setDetailsOpen(true);
  };


  const historyMetrics = useMemo(() => {
    const completed = items.filter((item) => String(item.state || "").toLowerCase().includes("complete")).length;
    const missed = items.filter((item) => {
      const state = String(item.state || "").toLowerCase();
      return state.includes("abandon") || state.includes("fail") || state.includes("hangup");
    }).length;
    const recordings = items.filter((item) => Boolean(item.recording_url || item.metadata?.recording?.recording_url || item.metadata?.recording?.recording_urls?.mp3)).length;
    return {
      total,
      visible: items.length,
      completed,
      missed,
      recordings,
      completionRate: pct(completed, Math.max(items.length, 1)),
      missedRate: pct(missed, Math.max(items.length, 1)),
      recordingRate: pct(recordings, Math.max(items.length, 1)),
    };
  }, [items, total]);

  const commandCardDateControls = (
    <div className="flex flex-wrap items-end justify-start gap-3 xl:justify-end" data-testid="call-history-command-card-controls">
      <div className="flex rounded-xl border bg-muted/40 p-1">
        <Button type="button" size="sm" variant={historyRange === "1d" ? "default" : "ghost"} onClick={() => setQuickDateRange(1)}>1 day</Button>
        <Button type="button" size="sm" variant={historyRange === "7d" ? "default" : "ghost"} onClick={() => setQuickDateRange(7)}>7 days</Button>
        <Button type="button" size="sm" variant={historyRange === "30d" ? "default" : "ghost"} onClick={() => setQuickDateRange(30)}>30 days</Button>
        <Button type="button" size="sm" variant={historyRange === "custom" ? "default" : "ghost"} onClick={() => setHistoryRange("custom")}>Custom range</Button>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">From</div>
        <Input type="datetime-local" value={filters.from} onChange={(e) => updateDateRangeFilter({ from: e.target.value })} className="w-[190px] bg-transparent dark:bg-input/30 dark:hover:bg-input/50" />
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">To</div>
        <Input type="datetime-local" value={filters.to} onChange={(e) => updateDateRangeFilter({ to: e.target.value })} className="w-[190px] bg-transparent dark:bg-input/30 dark:hover:bg-input/50" />
      </div>
      <Button variant="outline" size="sm" onClick={load} disabled={loading} className="mb-1">
        <IconRefresh className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        {loading ? "Loading…" : "Refresh"}
      </Button>
    </div>
  );

  const content = (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden shadow-sm">
      <CardContent className="flex-1 min-h-0 space-y-5 overflow-y-auto p-6">
        <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm dark:bg-zinc-950/70">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                <IconHistory className="h-4 w-4 text-telnyx-green" />
                Call history command center
              </div>
              <h3 className="mt-2 text-xl font-semibold tracking-tight">Interaction archive for the selected range</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Select a quick or custom range, then review matching history tiles and interaction rows.
              </p>
            </div>
            {commandCardDateControls}
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <HistoryMetricCard icon={IconPhoneIncoming} label="Interactions" value={formatShortNumber(historyMetrics.total)} detail={`${formatShortNumber(historyMetrics.visible)} visible on current page`} progress={pct(historyMetrics.visible, Math.max(historyMetrics.total, 1))} chip="Range" tone="sky" />
            <HistoryMetricCard icon={IconCheck} label="Completed" value={formatShortNumber(historyMetrics.completed)} detail={`${historyMetrics.completionRate}% of visible rows`} progress={historyMetrics.completionRate} chip="Visible" tone="emerald" />
            <HistoryMetricCard icon={IconAlertCircle} label="Missed" value={formatShortNumber(historyMetrics.missed)} detail={`${historyMetrics.missedRate}% abandoned / failed`} progress={historyMetrics.missedRate} chip="Visible" tone="amber" />
            <HistoryMetricCard icon={IconClock} label="Recordings" value={formatShortNumber(historyMetrics.recordings)} detail={`${historyMetrics.recordingRate}% with recordings`} progress={historyMetrics.recordingRate} chip="Assets" tone="slate" />
          </div>
        </div>

        <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Queue</div>
                <Select value={filters.queue} onValueChange={(value) => { setPage(1); setFilters((prev) => ({ ...prev, queue: value })); }}>
                  <SelectTrigger className="w-[180px]"><SelectValue placeholder="All queues" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All queues</SelectItem>
                    {filterOptions.queues.map((queue) => (<SelectItem key={queue} value={queue}>{queue}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Agent</div>
                <Select value={filters.agent} onValueChange={(value) => { setPage(1); setFilters((prev) => ({ ...prev, agent: value })); }}>
                  <SelectTrigger className="w-[180px]"><SelectValue placeholder="All agents" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All agents</SelectItem>
                    {filterOptions.agents.map((agent) => (<SelectItem key={agent.username} value={agent.username}>{agent.name}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Direction</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Queue</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Recording</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    Array.from({ length: 6 }).map((_, idx) => (
                      <TableRow key={`skeleton-${idx}`}>
                        {Array.from({ length: 10 }).map((__, cellIdx) => (<TableCell key={`skeleton-${idx}-${cellIdx}`}><Skeleton className="h-4 w-full" /></TableCell>))}
                      </TableRow>
                    ))
                  ) : items.length === 0 ? (
                    <TableRow><TableCell colSpan={10} className="text-center text-sm">No completed interactions found.</TableCell></TableRow>
                  ) : (
                    items.map((item) => {
                      const startedAt = item.answered_at || item.assigned_at || item.enqueued_at || item.created_at;
                      const durationSeconds = item.handle_time_seconds || (item.completed_at && startedAt ? Math.floor((new Date(item.completed_at) - new Date(startedAt)) / 1000) : null);
                      const hasRecording = Boolean(item.recording_url || item.metadata?.recording?.recording_url || item.metadata?.recording?.recording_urls?.mp3);
                      const state = String(item.state || "").toLowerCase();
                      const statusClass = state.includes("complete") ? "border-green-500 text-green-500" : state.includes("abandon") || state.includes("fail") || state.includes("hangup") ? "border-red-500 text-red-500" : "border-blue-500 text-blue-500";
                      return (
                        <TableRow key={item.id} className="hover:bg-muted/50">
                          <TableCell>{item.direction === "inbound" ? <IconArrowDownLeft className="h-4 w-4 text-green-500" /> : <IconArrowUpRight className="h-4 w-4 text-blue-500" />}</TableCell>
                          <TableCell className="min-w-[140px]">{item.from_name || item.from_number || "-"}</TableCell>
                          <TableCell className="min-w-[140px]">{item.to_name || item.to_number || "-"}</TableCell>
                          <TableCell>{item.queue_name || "-"}</TableCell>
                          <TableCell>{item.agent_name || item.agent_username || "-"}</TableCell>
                          <TableCell>{formatDateTime(startedAt)}</TableCell>
                          <TableCell>{formatDuration(durationSeconds)}</TableCell>
                          <TableCell><Badge variant="outline" className={`uppercase bg-transparent ${statusClass}`}>{item.state || "unknown"}</Badge></TableCell>
                          <TableCell>{hasRecording ? <Badge className="bg-green-500/10 text-green-500 border border-green-500/40">Available</Badge> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Button size="icon" variant="ghost" onClick={() => openDetails(item)}><IconInfoCircle className="h-4 w-4" /></Button>
                              <Button size="icon" variant="ghost" asChild><Link href={`/supervisor/call-history/${item.id}`}><IconExternalLink className="h-4 w-4" /></Link></Button>
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

        <Card className="border-border/70 bg-card shadow-sm dark:bg-zinc-950/70">
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
      </CardContent>
    </Card>
  );

  const details = (
    <InteractionDetailsSheet open={detailsOpen} onOpenChange={setDetailsOpen} interaction={selectedInteraction} />
  );

  if (embedded) {
    return <>{content}{details}</>;
  }

  return (
    <SupervisorPageShell>
      <SupervisorPageHeader title="Call History" />
      <main
        className={SECTION_RAIL_PAGE_GRID_CLASS}
        style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr)` }}
      >
        <MonitorSectionRailNav activeId="call-history" />
        <section className="h-full min-h-0 overflow-hidden pr-1">{content}</section>
      </main>
      {details}
    </SupervisorPageShell>
  );
}
