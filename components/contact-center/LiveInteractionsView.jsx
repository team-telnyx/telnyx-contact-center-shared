"use client";
import { useEffect, useState } from "react";
import { Activity, ArrowDownWideNarrow, ArrowUpWideNarrow, Clock3, GitBranch, Layers } from "lucide-react";
import MonitoringFilters from "./MonitoringFilters";
import InteractionStateBadge from "./InteractionStateBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { InteractionChannel } from "./InteractionChannel";
import InteractionPreviewAction from "./InteractionPreviewAction";
import InteractionSla from "./InteractionSla";
import { realtimeDurations } from "@/lib/acd/realtime-display.mjs";

const duration = value => value == null ? "—" : value >= 3600 ? `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m` : value >= 60 ? `${Math.floor(value / 60)}m ${value % 60}s` : `${value}s`;
const kindLabels = { inbound_flow: "Inbound flow", manual_outbound: "Manual outbound", direct_inbound: "Direct inbound", consultation: "Consultation", consult_target: "Consultation", transfer: "Transfer", supervision: "Supervision", campaign: "Campaign", queue: "Inbound queue", inbound: "Inbound", outbound: "Outbound" };

export default function LiveInteractionsView({ channel = "all", onChannelChange, refreshToken }) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [oldestFirst, setOldestFirst] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let disposed = false, timer;
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch(`/api/contact-center/monitor/interactions?channel=${encodeURIComponent(channel)}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Unable to refresh live interactions");
        const result = await response.json();
        if (!disposed) { setSnapshot({ ...result, channel }); setError(null); }
      } catch (failure) {
        if (!disposed && failure.name !== "AbortError") setError(failure.message);
      } finally {
        // Wait after completion: slow responses never accumulate requests.
        if (!disposed) timer = setTimeout(refresh, 3000);
      }
    }
    refresh();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [channel, revision, refreshToken]);
  const current = snapshot?.channel === channel ? snapshot : null;
  const rows = [...(current?.interactions || [])].sort((a, b) => (oldestFirst ? 1 : -1) * (Date.parse(a.createdAt) - Date.parse(b.createdAt)) || a.id.localeCompare(b.id));
  const metrics = current ? [
    [Layers, "Active interactions", current.totals.interactions, "text-sky-500"],
    [GitBranch, "Additional live legs", current.totals.legs, "text-violet-500"],
    [Clock3, "Waiting / offered", rows.filter(row => !row.legId && ["open", "queued", "ringing", "offered"].includes(row.state)).length, "text-amber-500"],
    [Activity, "Longest running", duration(Math.max(0, ...rows.map(row => realtimeDurations(row, now).elapsed || 0))), "text-emerald-500"],
  ] : null;
  return <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="live-interactions-view">
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <MonitoringFilters channel={channel} onChannelChange={onChannelChange} onRefresh={() => setRevision(value => value + 1)} status={error ? "Update failed" : current ? `Updated ${new Date(current.timestamp).toLocaleTimeString()}` : "Connecting…"} />
      {error && <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}. {current ? "Showing the last successful snapshot." : "Retry using Refresh."}</div>}
      {!current && !error ? <div className="space-y-4" aria-label="Loading live interactions">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14" />)}
      </div> : current && <>
        <div className="grid shrink-0 grid-cols-2 gap-3 xl:grid-cols-4">
          {metrics.map(([Icon, label, value, tone]) => <div key={label} className="rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className={`size-4 ${tone}`} />{label}</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
          </div>)}
        </div>
        <p className="shrink-0 text-xs text-muted-foreground">All live channels, including inbound flows from initiation, queue traffic, manual calls and consultation legs. Queue-answer SLA applies to inbound voice; messaging SLA measures the first human response.</p>
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border bg-card [&_[data-slot=table-container]]:overflow-visible">
          <Table className="min-w-[1250px]">
            <TableHeader className="sticky top-0 z-10 bg-card"><TableRow>
              {["Channel", "From", "To", "Type", "State", "Queue", "Agent", "Required skills", "Priority"].map(label => <TableHead key={label}>{label}</TableHead>)}
              <TableHead aria-sort={oldestFirst ? "descending" : "ascending"}><button className="inline-flex items-center gap-1 whitespace-nowrap" onClick={() => setOldestFirst(value => !value)}>Elapsed {oldestFirst ? <ArrowDownWideNarrow className="size-4" /> : <ArrowUpWideNarrow className="size-4" />}</button></TableHead>
              <TableHead>Wait time</TableHead><TableHead>Handling elapsed</TableHead><TableHead>SLA</TableHead><TableHead>Actions</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.length === 0 ? <TableRow><TableCell colSpan={14} className="h-36 text-center text-muted-foreground">No active interactions in this channel</TableCell></TableRow> : rows.map(row => {
                const times = realtimeDurations(row, now);
                return <TableRow key={row.id} data-interaction-row={row.id}>
                  <TableCell><InteractionChannel channel={row.channel} /></TableCell>
                  <TableCell className="max-w-56 truncate" title={row.customerName || row.fromNumber}>{row.customerName || row.fromNumber || "—"}</TableCell>
                  <TableCell className="max-w-48 truncate" title={row.toNumber}>{row.toNumber || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{kindLabels[row.kind] || row.kind?.replaceAll("_", " ") || "—"}</TableCell>
                  <TableCell><InteractionStateBadge state={row.state} /></TableCell>
                  <TableCell>{row.queueName || "Outside queues"}</TableCell>
                  <TableCell>{row.agentName || row.agentUsername || "—"}</TableCell>
                  <TableCell className="max-w-44 text-xs">{Object.entries(row.requiredSkills || {}).map(([skill, level]) => `${row.skillNames?.[skill] || skill} (${level})`).join(", ") || "—"}</TableCell>
                  <TableCell>{row.priority ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap font-medium tabular-nums">{duration(times.elapsed)}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{duration(times.wait)}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{duration(times.handling)}</TableCell>
                  <TableCell><InteractionSla now={now} sla={row.sla} /></TableCell>
                  <TableCell><InteractionPreviewAction interaction={row} /></TableCell>
                </TableRow>;
              })}
            </TableBody>
          </Table>
        </div>
      </>}
    </div>
  </div>;
}
