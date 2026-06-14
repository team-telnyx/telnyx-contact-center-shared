"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { notify } from "@/components/ToastNotify";
import {
  IconActivity,
  IconAlertTriangle,
  IconHeadphones,
  IconLoader2,
  IconPhoneCall,
  IconPhoneOff,
  IconPlayerStop,
  IconWifi,
  IconWifiOff,
} from "@tabler/icons-react";

const STREAM_URL = "/api/admin/call-generator/stream";

const statusBadgeClass = (status) => {
  const value = String(status || "").toLowerCase();
  if (["running", "answered", "talking", "completed"].includes(value)) return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (["dialing", "ringing", "pending"].includes(value)) return "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300";
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

function formatSecs(secs) {
  if (!secs && secs !== 0) return "—";
  const total = Math.max(0, Math.round(Number(secs)));
  const mins = Math.floor(total / 60);
  const rest = total % 60;
  return mins ? `${mins}m ${rest}s` : `${rest}s`;
}

// Elapsed seconds for a call. Active calls tick live off `now` (answered_at, or
// started_at before answer); finished calls use the persisted duration_ms.
function callElapsedSecs(call, nowMs) {
  if (["completed", "failed", "abandoned", "stopped"].includes(call.status)) {
    if (call.duration_ms || call.duration_ms === 0) return Math.round(Number(call.duration_ms) / 1000);
    return null;
  }
  const anchor = call.answered_at || call.started_at;
  if (!anchor) return null;
  const start = new Date(anchor).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.round((nowMs - start) / 1000));
}

// Color the live timer as it nears the configured max-call-duration hangup:
// red within 15s of the limit, orange within 60s, default otherwise.
function durationToneClass(remainingSecs) {
  if (remainingSecs === null || remainingSecs === undefined) return "text-muted-foreground";
  if (remainingSecs <= 15) return "text-rose-600 dark:text-rose-400 font-semibold";
  if (remainingSecs <= 60) return "text-amber-600 dark:text-amber-400 font-medium";
  return "";
}

function formatTime(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleTimeString();
  } catch {
    return "—";
  }
}

export default function CallGeneratorDashboardView({ refreshNonce = 0 }) {
  const [snapshot, setSnapshot] = useState(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(null);
  const [disconnectBusy, setDisconnectBusy] = useState(null);
  // 1s tick so active-call duration counts up live (the SSE snapshot only
  // refreshes every 2s and carries no live timer for in-progress calls).
  const [now, setNow] = useState(() => Date.now());
  // Custom confirm dialogs (no native browser confirm — project convention).
  const [confirmDisconnectAll, setConfirmDisconnectAll] = useState(false);
  const [confirmPanic, setConfirmPanic] = useState(null); // holds runId
  const sourceRef = useRef(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const source = new EventSource(STREAM_URL);
    sourceRef.current = source;

    source.addEventListener("cg_update", (event) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(event.data);
        setSnapshot(data);
        setLoading(false);
        setConnected(true);
      } catch {}
    });
    source.onopen = () => { if (!cancelled) setConnected(true); };
    source.onerror = () => { if (!cancelled) setConnected(false); };

    return () => {
      cancelled = true;
      try { source.close(); } catch {}
      sourceRef.current = null;
    };
  }, [refreshNonce]);

  async function runAction(runId, action) {
    setActionBusy(`${runId}:${action}`);
    try {
      const res = await fetch(`/api/admin/call-generator/runs/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `${action} failed`);
      }
      const data = await res.json();
      notify({
        title: action === "panic" ? "Panic stop executed" : "Run stopped",
        description: action === "panic" ? `${data.stoppedCalls ?? 0} active calls were hung up.` : "The run has been stopped.",
        variant: action === "panic" ? "warning" : "success",
      });
    } catch (err) {
      notify({ title: "Action failed", description: err.message, variant: "error" });
    } finally {
      setActionBusy(null);
    }
  }

  async function disconnectCall(call) {
    setDisconnectBusy(call.id);
    try {
      const res = await fetch(`/api/admin/call-generator/calls/${call.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Disconnect failed");
      }
      notify({ title: "Call disconnected", description: call.to_number || call.id, variant: "success" });
    } catch (err) {
      notify({ title: "Disconnect failed", description: err.message, variant: "error" });
    } finally {
      setDisconnectBusy(null);
    }
  }

  async function disconnectAllCalls() {
    setDisconnectBusy("all");
    try {
      const res = await fetch("/api/admin/call-generator/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect_all" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Disconnect all failed");
      }
      const data = await res.json();
      notify({ title: "Calls disconnected", description: `${data.disconnected ?? 0} active calls were hung up.`, variant: "success" });
    } catch (err) {
      notify({ title: "Disconnect all failed", description: err.message, variant: "error" });
    } finally {
      setDisconnectBusy(null);
    }
  }

  const totals = snapshot?.totals || { activeCalls: 0, dialing: 0, ringing: 0, answered: 0, runningRuns: 0 };
  // Dashboard shows only LIVE runs (real-time). Historical runs live under the
  // Logs rail section with pagination + per-run report accordions.
  const runs = (snapshot?.runs || []).filter((r) => ["pending", "running"].includes(String(r.status)));
  const statsByRun = snapshot?.statsByRun || {};
  const recentCalls = snapshot?.recentCalls || [];

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Badge variant="outline" className={connected ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"}>
          {connected ? <IconWifi className="mr-1 h-3.5 w-3.5" /> : <IconWifiOff className="mr-1 h-3.5 w-3.5" />}
          {connected ? "Live" : "Reconnecting…"}
        </Badge>
        <span className="text-xs text-muted-foreground">Updates every 2s · {snapshot?.timestamp ? formatTime(snapshot.timestamp) : "—"}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard icon={IconActivity} label="Active calls" value={totals.activeCalls} tone="emerald" />
        <MetricCard icon={IconPhoneCall} label="Dialing" value={totals.dialing} tone="sky" />
        <MetricCard icon={IconPhoneCall} label="Ringing" value={totals.ringing} tone="violet" />
        <MetricCard icon={IconHeadphones} label="Answered" value={totals.answered} tone="amber" />
        <MetricCard icon={IconActivity} label="Running runs" value={totals.runningRuns} tone="rose" />
      </div>

      <div className="rounded-2xl border bg-card p-5 shadow-sm">
        <h4 className="text-sm font-semibold">Active runs</h4>
        {runs.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No active runs. Start one from the Scenarios section. Completed runs appear under Logs.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scenario</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const stats = statsByRun[run.id] || run.stats || {};
                  const done = (stats.completed || 0) + (stats.failed || 0) + (stats.abandoned || 0);
                  const total = Object.values(stats).reduce((sum, n) => sum + (Number(n) || 0), 0);
                  const isRunning = run.status === "running";
                  return (
                    <TableRow key={run.id}>
                      <TableCell className="font-medium">{run.scenario_name || run.scenario_id}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusBadgeClass(run.status)}>{run.status}</Badge>
                      </TableCell>
                      <TableCell className="tabular-nums text-sm">
                        {done}/{total}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {stats.completed ? `✓${stats.completed} ` : ""}{stats.failed ? `✗${stats.failed} ` : ""}{stats.abandoned ? `⊘${stats.abandoned}` : ""}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatTime(run.started_at)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {isRunning ? (
                            <>
                              <Button size="sm" variant="outline" disabled={actionBusy === `${run.id}:stop`} onClick={() => runAction(run.id, "stop")}>
                                {actionBusy === `${run.id}:stop` ? <IconLoader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <IconPlayerStop className="mr-1 h-3.5 w-3.5" />}
                                Stop
                              </Button>
                              <Button size="sm" variant="destructive" disabled={actionBusy === `${run.id}:panic`} onClick={() => setConfirmPanic(run.id)}>
                                {actionBusy === `${run.id}:panic` ? <IconLoader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <IconAlertTriangle className="mr-1 h-3.5 w-3.5" />}
                                Panic
                              </Button>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">Pending…</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <div className="rounded-2xl border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold">Recent calls</h4>
          <Button
            size="sm"
            variant="outline"
            className="border-rose-500/35 text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-300 dark:hover:text-rose-200"
            disabled={disconnectBusy === "all" || totals.activeCalls === 0}
            onClick={() => setConfirmDisconnectAll(true)}
            data-testid="cg-disconnect-all"
          >
            {disconnectBusy === "all" ? <IconLoader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <IconPhoneOff className="mr-1 h-3.5 w-3.5" />}
            Disconnect all
          </Button>
        </div>
        {recentCalls.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No generated calls in the last 15 minutes.</p>
        ) : (
          <div className="mt-3 max-h-[420px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>To</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Answered</TableHead>
                  <TableHead>Duration / Max</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">Disconnect</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentCalls.map((call) => {
                  const isActive = ["dialing", "ringing", "answered", "talking"].includes(call.status);
                  const elapsedSecs = callElapsedSecs(call, now);
                  const maxSecs = Number(call.max_duration_secs) > 0 ? Number(call.max_duration_secs) : null;
                  // Remaining only matters while the call is live and counting
                  // toward its max-duration hangup.
                  const remainingSecs = isActive && maxSecs !== null && elapsedSecs !== null ? maxSecs - elapsedSecs : null;
                  const toneClass = isActive ? durationToneClass(remainingSecs) : "";
                  return (
                    <TableRow key={call.id}>
                      <TableCell className="font-mono text-xs">{call.to_number || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{call.from_number || "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusBadgeClass(call.status)}>{call.status}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatTime(call.started_at)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatTime(call.answered_at)}</TableCell>
                      <TableCell className="text-xs tabular-nums">
                        <span className={toneClass}>
                          {elapsedSecs === null ? "—" : formatSecs(elapsedSecs)}
                        </span>
                        {maxSecs !== null ? (
                          <span className="ml-1 text-muted-foreground">/ {formatSecs(maxSecs)}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {call.result?.reason || call.result?.hangup_cause || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {isActive ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 rounded-full text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-300 dark:hover:text-rose-200"
                            title="Disconnect call"
                            disabled={disconnectBusy === call.id}
                            onClick={() => disconnectCall(call)}
                            data-testid="cg-disconnect-call"
                          >
                            {disconnectBusy === call.id ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> : <IconPhoneOff className="h-3.5 w-3.5" />}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Custom confirm: Disconnect all (replaces native browser confirm) */}
      <AlertDialog open={confirmDisconnectAll} onOpenChange={(open) => { if (!open) setConfirmDisconnectAll(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect all active calls?</AlertDialogTitle>
            <AlertDialogDescription>
              This will immediately hang up all {totals.activeCalls} active generated call{totals.activeCalls === 1 ? "" : "s"}. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { setConfirmDisconnectAll(false); disconnectAllCalls(); }}
            >
              Disconnect all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Custom confirm: Panic stop (replaces native browser confirm) */}
      <AlertDialog open={confirmPanic !== null} onOpenChange={(open) => { if (!open) setConfirmPanic(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Panic stop this run?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the run and hangs up ALL of its active generated calls immediately. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { const runId = confirmPanic; setConfirmPanic(null); if (runId) runAction(runId, "panic"); }}
            >
              Panic stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
