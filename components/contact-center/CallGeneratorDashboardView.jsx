"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export default function CallGeneratorDashboardView({ refreshNonce = 0 }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/call-generator/runs");
        if (!res.ok) throw new Error("Failed to load runs");
        const data = await res.json();
        if (!cancelled) setRuns(data.runs || []);
      } catch {
        if (!cancelled) setRuns([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [refreshNonce]);

  const stats = {
    active: runs.filter((r) => r.status === "running").length,
    completed: runs.filter((r) => r.status === "completed").length,
    failed: runs.filter((r) => r.status === "failed").length,
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Active runs</div>
            <div className="mt-1 text-2xl font-semibold">{stats.active}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Completed</div>
            <div className="mt-1 text-2xl font-semibold">{stats.completed}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Failed</div>
            <div className="mt-1 text-2xl font-semibold">{stats.failed}</div>
          </CardContent>
        </Card>
      </div>

      <div className="rounded-2xl border bg-card p-5 shadow-sm">
        <h4 className="text-sm font-semibold">Recent runs</h4>
        {loading ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : runs.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No runs yet. Create a scenario and start your first run.</p>
        ) : (
          <div className="mt-4 space-y-2">
            {runs.map((run) => (
              <div key={run.id} className="flex items-center justify-between rounded-lg border p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{run.scenario_name || run.scenario_id}</div>
                  <div className="text-xs text-muted-foreground">{new Date(run.created_at).toLocaleString()}</div>
                </div>
                <Badge variant="outline" className={
                  run.status === "running"
                    ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : run.status === "completed"
                    ? "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                    : run.status === "failed"
                    ? "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                    : "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300"
                }>
                  {run.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
