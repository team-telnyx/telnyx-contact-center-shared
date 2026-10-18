"use client";
import { statusLabel } from "@/lib/i18n/status-labels.mjs";
import { useUiText } from "@/components/i18n/use-ui-text";


import { Activity, CheckCheck, Clock3, Layers, ShieldCheck, Users } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCapacityUtilization } from "@/lib/contact-center/capacity-display.mjs";

const statusColors = { available: "#10b981", busy: "#0ea5e9", wrapup: "#8b5cf6", away: "#f59e0b", break: "#f59e0b", lunch: "#f59e0b", offline: "#64748b" };
const statusColor = name => {
  const key = String(name).toLowerCase().replace(/[_ ]/g, "");
  return Object.hasOwn(statusColors, key) ? statusColors[key] : "#64748b";
};
const count = value => Number(value || 0).toLocaleString();
const percent = value => value == null ? "—" : `${Number(value).toFixed(1)}%`;
const duration = value => {
  if (value == null) return "—";
  const seconds = Math.max(0, Math.round(Number(value)));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
};

function Metric({ icon: Icon, label, value, detail, tone }) {
  return <Card><CardContent className="p-5">
    <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className={`size-4 ${tone}`} />{label}</div>
    <div className="mt-3 text-3xl font-semibold tabular-nums">{value}</div>
    <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
  </CardContent></Card>;
}
function Panel({ icon: Icon, title, description, children, action }) {
  return <Card className="min-w-0"><CardContent className="p-5">
    <div className="flex items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-sm font-semibold"><Icon className="size-4 text-sky-500" />{title}</h3>{action}</div>
    <p className="mb-4 mt-2 text-xs text-muted-foreground">{description}</p>{children}
  </CardContent></Card>;
}
function ChartTooltip({ active, payload, label, translateName = name => name }) {
  if (!active || !payload?.length) return null;
  return <div className="rounded-xl border bg-popover p-3 text-xs text-popover-foreground shadow-lg">
    {label && <div className="mb-2 font-medium">{label}</div>}
    {payload.map(row => <div key={row.name} className="flex justify-between gap-5"><span>{translateName(row.name)}</span><strong>{count(row.value)}</strong></div>)}
  </div>;
}
function Table({ headers, rows, label }) {
  const tUi = useUiText();
  return <div role="region" aria-label={label} tabIndex={0} className="max-h-80 overflow-auto rounded-xl border"><table className="w-full text-left text-xs">
    <thead className="sticky top-0 bg-card text-muted-foreground"><tr>{headers.map(header => <th key={header} className="whitespace-nowrap border-b px-3 py-3 font-medium">{tUi(header)}</th>)}</tr></thead>
    <tbody className="divide-y">{rows.length ? rows.map(({ id, cells }) => <tr key={id}>{cells.map((cell, i) => <td key={i} className="whitespace-nowrap px-3 py-3 tabular-nums">{cell}</td>)}</tr>) : <tr><td colSpan={headers.length} className="p-8 text-center text-muted-foreground">{tUi("No matching records.")}</td></tr>}</tbody>
  </table></div>;
}

/** Operational snapshot; the separate Dashboard owns date-range performance trends. */
export function OverviewDashboardView({ overall = {}, agents = [], queues = [], onSelectSection }) {
  const tUi = useUiText();
  const calls = overall.calls || {}, sla = overall.sla || {};
  const queueRows = [...queues].sort((a, b) => Number(b.realtime?.waitingCalls || 0) - Number(a.realtime?.waitingCalls || 0) || Number(b.realtime?.longestWaitSeconds || 0) - Number(a.realtime?.longestWaitSeconds || 0) || Number(b.realtime?.activeCalls || 0) - Number(a.realtime?.activeCalls || 0));
  const workload = queueRows.slice(0, 8).map(queue => ({ name: queue.queueName, waiting: Number(queue.realtime?.waitingCalls || 0), active: Number(queue.realtime?.activeCalls || 0) }));
  const statusCounts = new Map();
  for (const agent of agents) statusCounts.set(agent.status || "Unknown", (statusCounts.get(agent.status || "Unknown") || 0) + 1);
  const statuses = [...statusCounts].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value }));
  const agentRows = [...agents].sort((a, b) => Number(b.currentInteractions || 0) - Number(a.currentInteractions || 0) || Number(b.today?.completedCalls || 0) - Number(a.today?.completedCalls || 0));
  const link = (section, text) => <Button size="sm" variant="ghost" onClick={() => onSelectSection(section)}>{tUi(text)}</Button>;
  return <div className="space-y-4" data-testid="monitor-overview">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric icon={Clock3} label={tUi("Waiting now")} value={count(overall.queues?.totalWaitingCalls)} detail={tUi("Queued and offered interactions")} tone="text-amber-500" />
      <Metric icon={Activity} label={tUi("Handling now")} value={count(calls.active)} detail={tUi("Active interactions across selected channels")} tone="text-sky-500" />
      <Metric icon={Users} label={tUi("Available agents")} value={count(overall.agents?.available)} detail={tUi("{value0} using capacity · {value1} online", {value0:count(overall.agents?.busy), value1:count(overall.agents?.totalActive)})} tone="text-violet-500" />
      <Metric icon={ShieldCheck} label={tUi("Today's service level")} value={percent(sla.rate)} detail={tUi("{value0} met · {value1} evaluated measurements", {value0:count(sla.met), value1:count(sla.denominator)})} tone="text-emerald-500" />
    </div>
    <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
      <Panel icon={Layers} title={tUi("Live queue workload")} description={tUi("Up to eight queues, ordered by waiting interactions and longest wait.")}>
        {workload.some(row => row.waiting || row.active) ? <div className="h-64"><ResponsiveContainer width="100%" height="100%"><BarChart data={workload} margin={{ left: -20, right: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" /><XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} /><YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-muted)", fillOpacity: 0.5 }} /><Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
          <Bar isAnimationActive={false} dataKey="waiting" name={tUi("Waiting")} fill="#f59e0b" stackId="work" maxBarSize={40} /><Bar isAnimationActive={false} dataKey="active" name={tUi("Handling")} fill="#0ea5e9" stackId="work" maxBarSize={40} />
        </BarChart></ResponsiveContainer></div> : <div className="grid h-64 place-items-center text-sm text-muted-foreground">{tUi("No live queue workload.")}</div>}
      </Panel>
      <Panel icon={Users} title={tUi("Agent presence")} description={tUi("Current roster statuses. Presence is global; routing availability follows the selected channel.")}>
        {statuses.length ? <div className="h-64"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie isAnimationActive={false} data={statuses} dataKey="value" nameKey="name" innerRadius={65} outerRadius={92} stroke="var(--color-card)">{statuses.map(row => <Cell key={row.name} fill={statusColor(row.name)} />)}</Pie><Tooltip content={<ChartTooltip translateName={name => statusLabel(tUi, name)} />} /><Legend iconType="circle" formatter={(name) => `${statusLabel(tUi, name)} · ${statusCounts.get(name)}`} wrapperStyle={{ fontSize: 11 }} /></PieChart></ResponsiveContainer></div> : <div className="grid h-64 place-items-center text-sm text-muted-foreground">{tUi("No agents in the roster.")}</div>}
      </Panel>
    </div>
    <Panel icon={Layers} title={tUi("Queue status")} description={tUi("Current pressure and today's stored service-level measurements, across all monitored queues.")} action={link("queues", "View queues")}>
      <Table label={tUi("Overview queue status")} headers={["Queue", "Waiting", "Handling", "Longest wait", "Available agents", "Closed today", "SLA today"]} rows={queueRows.map(queue => ({ id: queue.queueId, cells: [queue.queueName, count(queue.realtime?.waitingCalls), count(queue.realtime?.activeCalls), duration(queue.realtime?.longestWaitSeconds), count(queue.agents?.available), count(queue.today?.totalCalls), percent(queue.sla?.rate)] }))} />
    </Panel>
    <Panel icon={CheckCheck} title={tUi("Agent activity")} description={tUi("Live assignments and interactions completed today with each agent's participation. Shared interactions can involve several agents.")} action={link("agents", "View agents")}>
      <Table label={tUi("Overview agent activity")} headers={["Agent", "Status", "Live interactions", "Global capacity", "Completed today", "Average handling"]} rows={agentRows.map(agent => ({ id: agent.userId, cells: [[agent.firstName, agent.lastName].filter(Boolean).join(" ") || agent.username, <Badge key="status" variant="outline">{statusLabel(tUi, agent.status)}</Badge>, count(agent.currentInteractions), formatCapacityUtilization(agent.usedCapacity ?? 0, agent.capacityBudget ?? 1), count(agent.today?.completedCalls), duration(agent.today?.avgHandleTimeSeconds)] }))} />
    </Panel>
  </div>;
}
