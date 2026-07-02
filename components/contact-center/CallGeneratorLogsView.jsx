"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { notify } from "@/components/ToastNotify";
import {
  IconActivity,
  IconAlertTriangle,
  IconChevronLeft,
  IconChevronRight,
  IconHeadphones,
  IconLoader2,
  IconPhoneCall,
  IconPhoneOff,
} from "@tabler/icons-react";

const PAGE_SIZE_OPTIONS = [10, 25, 50];

const statusBadgeClass = (status) => {
  const value = String(status || "").toLowerCase();
  if (["completed"].includes(value)) return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (["failed", "abandoned"].includes(value)) return "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  if (["stopped"].includes(value)) return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300";
};

function MetricCard({ icon: Icon, label, value, tone = "sky" }) {
  const tones = {
    sky: "from-sky-500/15 to-blue-500/5 text-sky-600 dark:text-sky-300",
    emerald: "from-emerald-500/15 to-teal-500/5 text-emerald-600 dark:text-emerald-300",
    violet: "from-violet-500/15 to-fuchsia-500/5 text-violet-600 dark:text-violet-300",
    amber: "from-amber-500/18 to-orange-500/5 text-amber-600 dark:text-amber-300",
    rose: "from-rose-500/15 to-red-500/5 text-rose-600 dark:text-rose-300",
  };
  return (
    <div className="rounded-2xl border bg-background/85 p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <span className={`rounded-xl bg-gradient-to-br p-2 ${tones[tone] || tones.sky}`}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
        </div>
      </div>
    </div>
  );
}

function formatDateTime(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "—";
  }
}

// Per-run report body, rendered inside an accordion when the row is expanded.
// Mirrors the stat tiles the Dashboard "Report" view used to show.
function RunReportPanel({ runId }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/call-generator/runs/${runId}/report`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Report failed");
        }
        const data = await res.json();
        if (!cancelled) setReport(data);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [runId]);

  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p>;
  }

  const summary = report?.report?.summary || {};
  const assertions = report?.report?.assertions || [];
  const queues = summary.queues || {};

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard icon={IconPhoneCall} label="Total" value={summary.total ?? 0} tone="sky" />
        <MetricCard icon={IconActivity} label="Correlated" value={summary.correlated ?? 0} tone="violet" />
        <MetricCard icon={IconHeadphones} label="Answered" value={summary.answered ?? 0} tone="emerald" />
        <MetricCard icon={IconPhoneOff} label="Abandoned" value={summary.abandoned ?? 0} tone="amber" />
        <MetricCard icon={IconAlertTriangle} label="Failed" value={summary.failed ?? 0} tone="rose" />
        <MetricCard icon={IconActivity} label="Avg wait (s)" value={summary.avgWaitSecs ?? "—"} tone="sky" />
      </div>

      {Object.keys(queues).length ? (
        <div className="flex flex-wrap gap-2">
          {Object.entries(queues).map(([queue, count]) => (
            <Badge key={queue} variant="outline" className="border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300">
              {queue}: {count}
            </Badge>
          ))}
        </div>
      ) : null}

      {assertions.length ? (
        <div className="space-y-2">
          {assertions.map((a, idx) => (
            <div key={idx} className="flex items-center justify-between rounded-lg border bg-background/70 px-3 py-2 text-sm">
              <span className="font-mono text-xs">{a.type}{a.queue ? ` → ${a.queue}` : ""}{a.seconds ? ` ≤ ${a.seconds}s` : ""}{a.percent !== undefined ? ` ${a.percent}%` : ""}</span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{a.detail}</span>
                <Badge variant="outline" className={a.passed ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"}>
                  {a.passed ? "PASS" : "FAIL"}
                </Badge>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No assertions configured on this scenario. Add them in the scenario config to get pass/fail evaluation.</p>
      )}
    </div>
  );
}

export default function CallGeneratorLogsView({ refreshNonce = 0 }) {
  const [runs, setRuns] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ scope: "historical", page: String(page), pageSize: String(pageSize) });
      const res = await fetch(`/api/admin/call-generator/runs?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load logs");
      }
      const data = await res.json();
      setRuns(Array.isArray(data.runs) ? data.runs : []);
      setTotal(Number(data.total) || 0);
    } catch (err) {
      setError(err.message);
      notify({ title: "Failed to load logs", description: err.message, variant: "error" });
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => { load(); }, [load, refreshNonce]);

  // Reset to first page when page size changes.
  function changePageSize(next) {
    setPageSize(next);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold">Run logs</h4>
            <p className="text-xs text-muted-foreground">Completed, stopped, failed and abandoned runs. Expand a run to see its report.</p>
          </div>
          <Badge variant="outline" className="bg-card">{total} total</Badge>
        </div>

        {loading ? (
          <div className="mt-4 space-y-2">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : error ? (
          <p className="mt-4 text-sm text-rose-600 dark:text-rose-300">{error}</p>
        ) : runs.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No historical runs yet. Completed runs from the Dashboard will appear here.</p>
        ) : (
          <Accordion type="multiple" className="mt-3 rounded-xl border">
            {runs.map((run) => {
              const stats = run.stats || {};
              const completed = stats.completed || 0;
              const failed = stats.failed || 0;
              const abandoned = stats.abandoned || 0;
              return (
                <AccordionItem key={run.id} value={run.id} className="px-4">
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex flex-1 items-center justify-between gap-3 pr-2">
                      <div className="min-w-0 text-left">
                        <div className="truncate text-sm font-medium">{run.scenario_name || run.scenario_id}</div>
                        <div className="text-xs text-muted-foreground">{formatDateTime(run.created_at)}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                          {completed ? `✓${completed} ` : ""}{failed ? `✗${failed} ` : ""}{abandoned ? `⊘${abandoned}` : ""}
                        </span>
                        <Badge variant="outline" className={statusBadgeClass(run.status)}>{run.status}</Badge>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="px-1">
                    <RunReportPanel runId={run.id} />
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        )}

        {/* Pager */}
        <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Rows per page</span>
            <div className="flex overflow-hidden rounded-lg border">
              {PAGE_SIZE_OPTIONS.map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => changePageSize(size)}
                  className={`px-2.5 py-1 text-xs transition ${pageSize === size ? "bg-sky-500/15 font-semibold text-sky-700 dark:text-sky-300" : "hover:bg-muted/60"}`}
                  data-testid="cg-logs-page-size"
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground tabular-nums">
              {rangeStart}–{rangeEnd} of {total}
            </span>
            <div className="flex items-center gap-1">
              <Button size="icon" variant="outline" className="h-8 w-8" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">
                {loading ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> : <IconChevronLeft className="h-4 w-4" />}
              </Button>
              <span className="px-1 text-xs tabular-nums text-muted-foreground">{page} / {totalPages}</span>
              <Button size="icon" variant="outline" className="h-8 w-8" disabled={page >= totalPages || loading} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} aria-label="Next page">
                {loading ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> : <IconChevronRight className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
