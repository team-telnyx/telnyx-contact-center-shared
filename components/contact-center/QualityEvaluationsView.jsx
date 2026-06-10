"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  IconChecklist,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconCircleCheck,
  IconClipboardCheck,
  IconGauge,
  IconMicrophone,
  IconRobot,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "-";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

const STATUS_BADGES = {
  not_evaluated: { label: "Not evaluated", className: "text-muted-foreground" },
  draft: { label: "Draft", className: "border-sky-500/40 text-sky-700 dark:text-sky-300" },
  ai_processing: { label: "AI processing", className: "border-violet-500/40 text-violet-700 dark:text-violet-300" },
  ai_draft: { label: "AI draft", className: "border-violet-500/40 text-violet-700 dark:text-violet-300" },
  reviewed: { label: "Reviewed", className: "border-amber-500/40 text-amber-700 dark:text-amber-300" },
  final: { label: "Final", className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" },
  disputed: { label: "Disputed", className: "border-red-500/40 text-red-600 dark:text-red-400" },
};

function EvaluationStatusBadge({ status }) {
  const config = STATUS_BADGES[status || "not_evaluated"] || STATUS_BADGES.not_evaluated;
  return (
    <Badge variant="outline" className={config.className}>
      {config.label}
    </Badge>
  );
}

function MetricTile({ icon: Icon, label, value, detail, progress = 0, tone = "slate" }) {
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
            Range
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

export default function QualityEvaluationsView({ from, to, refreshNonce = 0 }) {
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [filterOptions, setFilterOptions] = useState({ queues: [], agents: [] });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [count, setCount] = useState(0);
  const [queueFilter, setQueueFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [recordedOnly, setRecordedOnly] = useState(true);

  const [pickerInteraction, setPickerInteraction] = useState(null);
  const [forms, setForms] = useState([]);
  const [selectedFormId, setSelectedFormId] = useState("");
  const [creating, setCreating] = useState(false);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (queueFilter !== "all") sp.set("queue", queueFilter);
    if (agentFilter !== "all") sp.set("agent", agentFilter);
    if (statusFilter !== "all") sp.set("status", statusFilter);
    if (recordedOnly) sp.set("recordedOnly", "true");
    return sp.toString();
  }, [from, to, page, pageSize, queueFilter, agentFilter, statusFilter, recordedOnly]);

  useEffect(() => {
    setPage(1);
  }, [from, to, queueFilter, agentFilter, statusFilter, recordedOnly]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/contact-center/quality/evaluations?${query}`, {
          cache: "no-store",
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload?.error || "Failed to load evaluations");
        if (!cancelled) {
          setRows(payload.rows || []);
          setMetrics(payload.metrics || null);
          setCount(payload.count || 0);
          setFilterOptions(payload.filters || { queues: [], agents: [] });
        }
      } catch (error) {
        if (!cancelled) {
          setRows([]);
          notify({
            title: "Evaluations load failed",
            description: String(error.message || error),
            variant: "error",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [query, refreshNonce]);

  const openFormPicker = useCallback(async (interaction) => {
    setPickerInteraction(interaction);
    setSelectedFormId("");
    try {
      const res = await fetch("/api/contact-center/quality/forms?status=published", {
        cache: "no-store",
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Failed to load forms");
      setForms(payload.forms || []);
      if ((payload.forms || []).length > 0) setSelectedFormId(payload.forms[0].id);
    } catch (error) {
      notify({
        title: "Failed to load quality forms",
        description: String(error.message || error),
        variant: "error",
      });
    }
  }, []);

  const startEvaluation = useCallback(async () => {
    if (!pickerInteraction || !selectedFormId) return;
    setCreating(true);
    try {
      const res = await fetch("/api/contact-center/quality/evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interaction_id: pickerInteraction.id,
          form_id: selectedFormId,
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Failed to start evaluation");
      router.push(`/supervisor/quality/evaluations/${payload.evaluation.id}`);
    } catch (error) {
      notify({
        title: "Failed to start evaluation",
        description: String(error.message || error),
        variant: "error",
      });
      setCreating(false);
    }
  }, [pickerInteraction, selectedFormId, router]);

  const totalPages = Math.max(1, Math.ceil(count / pageSize));

  return (
    <div className="space-y-5" data-testid="quality-evaluations-view">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={IconMicrophone}
          label="Conversations"
          value={metrics?.total ?? 0}
          detail={`${metrics?.recorded ?? 0} with recording`}
          progress={metrics?.total > 0 ? Math.round(((metrics?.recorded || 0) / metrics.total) * 100) : 0}
          tone="sky"
        />
        <MetricTile
          icon={IconChecklist}
          label="Evaluated"
          value={metrics?.evaluated ?? 0}
          detail={`${metrics?.aiDrafts ?? 0} AI drafts to review`}
          progress={metrics?.total > 0 ? Math.round(((metrics?.evaluated || 0) / metrics.total) * 100) : 0}
          tone="violet"
        />
        <MetricTile
          icon={IconCircleCheck}
          label="Finalized"
          value={metrics?.finalized ?? 0}
          detail="Closed evaluations"
          progress={metrics?.evaluated > 0 ? Math.round(((metrics?.finalized || 0) / metrics.evaluated) * 100) : 0}
          tone="slate"
        />
        <MetricTile
          icon={IconGauge}
          label="Average score"
          value={metrics?.avgScorePercent != null ? `${metrics.avgScorePercent}%` : "-"}
          detail="Reviewed and final"
          progress={Math.round(Number(metrics?.avgScorePercent || 0))}
          tone="emerald"
        />
      </div>

      <Card className="border bg-background/85 shadow-sm">
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Queue</div>
              <Select value={queueFilter} onValueChange={setQueueFilter}>
                <SelectTrigger className="w-[170px]"><SelectValue placeholder="All queues" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All queues</SelectItem>
                  {filterOptions.queues.map((queue) => (
                    <SelectItem key={queue} value={queue}>{queue}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Agent</div>
              <Select value={agentFilter} onValueChange={setAgentFilter}>
                <SelectTrigger className="w-[180px]"><SelectValue placeholder="All agents" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All agents</SelectItem>
                  {filterOptions.agents.map((agent) => (
                    <SelectItem key={agent.username} value={agent.username}>{agent.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Status</div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[170px]"><SelectValue placeholder="All statuses" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="not_evaluated">Not evaluated</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="ai_draft">AI draft</SelectItem>
                  <SelectItem value="reviewed">Reviewed</SelectItem>
                  <SelectItem value="final">Final</SelectItem>
                  <SelectItem value="disputed">Disputed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant={recordedOnly ? "default" : "outline"}
              size="sm"
              className="mb-0.5"
              onClick={() => setRecordedOnly((value) => !value)}
            >
              <IconMicrophone className="mr-2 h-4 w-4" />
              {recordedOnly ? "Recorded only" : "All calls"}
            </Button>
          </div>

          {loading ? (
            <div className="space-y-2 py-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No conversations match the current filters.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Completed</TableHead>
                  <TableHead>Queue</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Talk time</TableHead>
                  <TableHead>Recording</TableHead>
                  <TableHead>Evaluation</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const hasRecording = Boolean(row.recording_url || row.recording_id);
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap text-sm">
                        {formatDateTime(row.completed_at || row.abandoned_at || row.created_at)}
                      </TableCell>
                      <TableCell className="text-sm">{row.queue_name || "-"}</TableCell>
                      <TableCell className="text-sm">{row.agent_name || "-"}</TableCell>
                      <TableCell className="text-sm">
                        {row.from_name || row.from_number || "-"}
                      </TableCell>
                      <TableCell className="text-sm">{formatDuration(row.talk_time_seconds)}</TableCell>
                      <TableCell>
                        {hasRecording ? (
                          <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                            <IconMicrophone className="mr-1 h-3 w-3" />
                            {row.has_transcript ? "Rec + transcript" : "Recorded"}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">None</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <EvaluationStatusBadge status={row.evaluation_status} />
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.evaluation_score_percent != null
                          ? `${Number(row.evaluation_score_percent)}%`
                          : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.evaluation_id ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => router.push(`/supervisor/quality/evaluations/${row.evaluation_id}`)}
                          >
                            <IconClipboardCheck className="mr-2 h-4 w-4" />
                            Open
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => openFormPicker(row)}
                          >
                            <IconRobot className="mr-2 h-4 w-4" />
                            Evaluate
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          <div className="flex flex-wrap items-center justify-between gap-4" data-testid="quality-evaluations-pagination">
            <div className="text-sm font-medium text-foreground">
              Page {page} of {totalPages}
              <span className="ml-2 font-normal text-muted-foreground">
                · {count.toLocaleString()} conversations
              </span>
            </div>
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

      <Dialog open={Boolean(pickerInteraction)} onOpenChange={(open) => !open && setPickerInteraction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start evaluation</DialogTitle>
            <DialogDescription>
              Choose the quality form used to score this conversation. You can fill it manually or
              let the AI assistant prepare a draft.
            </DialogDescription>
          </DialogHeader>
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Quality form</div>
            <Select value={selectedFormId} onValueChange={setSelectedFormId}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select a form" /></SelectTrigger>
              <SelectContent>
                {forms.map((form) => (
                  <SelectItem key={form.id} value={form.id}>
                    {form.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPickerInteraction(null)}>
              Cancel
            </Button>
            <Button type="button" disabled={!selectedFormId || creating} onClick={startEvaluation}>
              {creating ? "Starting…" : "Start evaluation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
