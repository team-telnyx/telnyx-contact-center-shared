"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  IconArrowDownLeft,
  IconArrowUpRight,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconExternalLink,
  IconHistory,
  IconInfoCircle,
  IconRefresh,
} from "@tabler/icons-react";
import InteractionDetailsSheet from "@/components/contact-center/InteractionDetailsSheet";
import { notify } from "@/components/ToastNotify";
import {
  SupervisorPageContent,
  SupervisorPageHeader,
  SupervisorPageShell,
} from "@/components/contact-center/SupervisorPageLayout";
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
    setPage(1);
    setSupervisorCallHistoryDateRange({ from: next.from, to: next.to });
    setFilters(next);
  };

  const setQuickDateRange = (days) => {
    const nextRange = quickCallHistoryDateRange(days);
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

  const content = (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden shadow-sm">
      <CardHeader className="shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <IconHistory className="size-5" />
              Call History
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Completed and abandoned interactions with recordings and workflow details.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <IconRefresh className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 space-y-6 overflow-y-auto py-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-wrap items-end gap-4 w-full md:w-auto">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">From</div>
              <Input type="datetime-local" value={filters.from} onChange={(e) => updateDateRangeFilter({ from: e.target.value })} className="w-full md:w-[200px] bg-transparent dark:bg-input/30 dark:hover:bg-input/50" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">To</div>
              <Input type="datetime-local" value={filters.to} onChange={(e) => updateDateRangeFilter({ to: e.target.value })} className="w-full md:w-[200px] bg-transparent dark:bg-input/30 dark:hover:bg-input/50" />
            </div>
            <div className="flex flex-col gap-1">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Quick range</div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setQuickDateRange(1)}>1 day</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setQuickDateRange(7)}>7 days</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setQuickDateRange(30)}>30 days</Button>
              </div>
            </div>
          </div>
          <div className="flex items-end gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Queue</div>
              <Select value={filters.queue} onValueChange={(value) => { setPage(1); setFilters((prev) => ({ ...prev, queue: value })); }}>
                <SelectTrigger><SelectValue placeholder="All queues" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All queues</SelectItem>
                  {filterOptions.queues.map((queue) => (<SelectItem key={queue} value={queue}>{queue}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Agent</div>
              <Select value={filters.agent} onValueChange={(value) => { setPage(1); setFilters((prev) => ({ ...prev, agent: value })); }}>
                <SelectTrigger><SelectValue placeholder="All agents" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All agents</SelectItem>
                  {filterOptions.agents.map((agent) => (<SelectItem key={agent.username} value={agent.username}>{agent.name}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto border-t pt-4">
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
                    <TableRow key={item.id}>
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

        <div className="border-t pt-4 flex flex-wrap items-center justify-between gap-4">
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
        </div>
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
      <SupervisorPageContent>{content}</SupervisorPageContent>
      {details}
    </SupervisorPageShell>
  );
}
