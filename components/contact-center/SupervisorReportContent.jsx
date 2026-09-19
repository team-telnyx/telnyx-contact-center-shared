"use client";

import { Activity, ArrowDownLeft, ArrowUpRight, ChartColumn, CheckCheck, Clock3, Grid3X3, ShieldCheck, Tag, TriangleAlert, Users } from "lucide-react";
import { Bar, BarChart, ComposedChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { InteractionChannel } from "./InteractionChannel";

const tones = {
  sky: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};
const palette = ["#0ea5e9", "#10b981", "#8b5cf6", "#f59e0b", "#f43f5e", "#06b6d4", "#6366f1", "#84cc16", "#d946ef", "#64748b"];
const count = value => value == null ? "—" : Number(value).toLocaleString();
const seconds = value => {
  if (value == null) return "—";
  const total = Math.max(0, Math.round(Number(value)));
  if (total >= 3600) return `${(total / 3600).toFixed(1)}h`;
  if (total >= 60) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${total}s`;
};
const percent = value => value == null ? "—" : `${Number(value).toFixed(1)}%`;
const ratio = (part, total) => total ? 100 * part / total : null;
const outcomeSeries = [{ key: "completed", label: "Completed", color: palette[1] }, { key: "abandoned", label: "Abandoned", color: palette[3] }, { key: "failed", label: "Failed", color: palette[4] }];

function Stat({ icon: Icon, label, value, detail, tone = "sky" }) {
  return <Card className="min-w-0 border-border/70 shadow-sm"><CardContent className="p-5">
    <div className="flex items-center gap-3"><span className={`rounded-xl p-2.5 ${tones[tone]}`}><Icon className="size-4" /></span><span className="text-xs font-medium text-muted-foreground">{label}</span></div>
    <div className="mt-4 truncate text-3xl font-semibold tracking-tight tabular-nums" title={String(value)}>{value}</div>
    <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
  </CardContent></Card>;
}
function Panel({ title, description, icon: Icon = ChartColumn, tone = "sky", children }) {
  return <Card className="min-w-0 border-border/70 shadow-sm"><CardContent className="p-5">
    <h3 className="flex items-center gap-2.5 text-sm font-semibold"><span className={`rounded-lg p-2 ${tones[tone]}`}><Icon className="size-4" /></span>{title}</h3>
    {description && <p className="mb-5 mt-2 text-xs leading-relaxed text-muted-foreground">{description}</p>}
    {children}
  </CardContent></Card>;
}
function Grid({ children }) { return <div className="grid gap-4 xl:grid-cols-2">{children}</div>; }
function Stats({ children }) { return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{children}</div>; }
function ReportTooltip({ active, label, payload, timing }) {
  if (!active || !payload?.length) return null;
  return <div className="rounded-xl border border-border bg-popover p-3 text-xs text-popover-foreground shadow-xl">
    <div className="mb-2 max-w-64 font-medium">{label}</div>
    {payload.map(row => <div key={row.dataKey} className="flex items-center justify-between gap-5 py-0.5"><span className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: row.color }} />{row.name}</span><strong>{timing || String(row.dataKey).endsWith("_seconds") ? seconds(row.value) : count(row.value)}</strong></div>)}
  </div>;
}
function Chart({ rows = [], series, axis = "bucket", timing = false, line = false, horizontal = false, stacked = false, secondaryTiming = false }) {
  if (!rows.length) return <div className="grid h-64 place-items-center text-xs text-muted-foreground">No matching data in this period.</div>;
  const Component = secondaryTiming ? ComposedChart : line ? LineChart : BarChart;
  const axisFormat = value => axis === "bucket" ? String(value).slice(5,16) : String(value);
  return <div className="h-72 min-w-0"><ResponsiveContainer width="100%" height="100%">
    <Component data={rows} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: 8, right: 15, left: horizontal ? 10 : 0, bottom: 5 }}>
      <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
      <XAxis type={horizontal ? "number" : "category"} dataKey={horizontal ? undefined : axis} tickFormatter={horizontal ? (timing ? seconds : undefined) : axisFormat} tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} allowDecimals={timing} />
      <YAxis type={horizontal ? "category" : "number"} dataKey={horizontal ? axis : undefined} width={horizontal ? 130 : 48} tickFormatter={horizontal ? v => String(v).length>20 ? `${String(v).slice(0,19)}…` : v : timing ? seconds : undefined} tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} allowDecimals={timing} />
      {secondaryTiming && <YAxis yAxisId="duration" orientation="right" tickFormatter={seconds} tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} width={50} />}
      <Tooltip content={<ReportTooltip timing={timing} />} cursor={line ? { stroke: "var(--color-border)" } : { fill: "var(--color-muted)", fillOpacity: 0.5 }} />
      <Legend iconType="circle" wrapperStyle={{ fontSize: 11, paddingTop: 12 }} />
      {series.map(({ key, label, color, duration }, index) => line || duration ? <Line key={key} yAxisId={duration ? "duration" : 0} dataKey={key} name={label} stroke={color || palette[index % palette.length]} strokeWidth={2} dot={rows.length < 3} connectNulls={false} /> : <Bar key={key} dataKey={key} name={label} fill={color || palette[index % palette.length]} stackId={stacked ? "outcome" : undefined} maxBarSize={32} radius={stacked ? 0 : 4} />)}
    </Component>
  </ResponsiveContainer></div>;
}
function DataTable({ columns, rows = [], label, emptyMessage = "No matching interactions in this period." }) {
  return <div role="region" aria-label={label} tabIndex={0} className="max-h-[480px] overflow-auto rounded-xl border">
    <table className="w-full text-left text-xs"><thead className="sticky top-0 z-10 bg-card text-muted-foreground"><tr>{columns.map(col => <th key={col.key} className="whitespace-nowrap border-b px-3 py-3 font-medium">{col.label}</th>)}</tr></thead>
      <tbody className="divide-y">{rows.length ? rows.map((row, index) => <tr key={row.id || index} className="hover:bg-muted/30">{columns.map(col => <td key={col.key} className="whitespace-nowrap px-3 py-3 tabular-nums">{col.render ? col.render(row) : count(row[col.key])}</td>)}</tr>) : <tr><td colSpan={columns.length} className="p-8 text-center text-muted-foreground">{emptyMessage}</td></tr>}</tbody>
    </table>
  </div>;
}
const channelColumn = { key: "channel", label: "Channel", render: row => <InteractionChannel channel={row.channel} /> };
const textColumn = (key, label) => ({ key, label, render: row => row[key] || "—" });
const timeColumn = (key, label) => ({ key, label, render: row => seconds(row[key]) });

function Heatmap({ cells }) {
  const maximum = Math.max(1, ...cells.map(cell => cell.total));
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return <div className="overflow-x-auto"><div className="grid min-w-[760px] gap-1" style={{ gridTemplateColumns: `40px repeat(24,minmax(${Math.max(28, String(maximum).length * 6 + 8)}px,1fr))` }}>
    <span />{Array.from({ length:24 }, (_,hour) => <span key={hour} className="pb-1 text-center text-[10px] text-muted-foreground">{String(hour).padStart(2,"0")}</span>)}
    {days.map((day,index) => <div key={day} className="contents"><span className="self-center text-[11px] text-muted-foreground">{day}</span>{Array.from({ length:24 },(_,hour) => {
      const total = cells.find(cell => cell.day===index+1 && cell.hour===hour)?.total || 0;
      return <div key={hour} role="img" aria-label={`${day} ${hour}:00 · ${total} received`} title={`${day} ${hour}:00 · ${total} received`} data-arrival-count={total} className={`grid h-8 place-items-center rounded border border-border/40 bg-muted/30 px-1 text-[10px] font-medium tabular-nums ${total / maximum >= 0.75 ? "text-slate-950" : "text-foreground"}`} style={total ? { background: `color-mix(in srgb, #0ea5e9 ${15+85*total/maximum}%, var(--color-card))` } : undefined}>{total > 0 ? count(total) : null}</div>;
    })}</div>)}
  </div><div className="mt-3 flex justify-end gap-2 text-[10px] text-muted-foreground">Less <span className="w-20 rounded bg-gradient-to-r from-sky-500/10 to-sky-500" /> More</div></div>;
}

function QueueReport({ data, detail, onPreview }) {
  return <div className="space-y-5" data-report="queue-performance">
    <Stats>
      <Stat icon={ArrowDownLeft} label="Closed interactions" value={count(data.totals.closed)} detail={`${count(data.totals.received)} received in this period`} />
      <Stat icon={CheckCheck} label="Completion rate" value={percent(ratio(data.totals.completed,data.totals.closed))} detail={`${count(data.totals.completed)} completed`} tone="emerald" />
      <Stat icon={ShieldCheck} label="Service level" value={percent(data.sla.rate)} detail={`${data.sla.met} met · ${data.sla.breached} breached · ${data.sla.unserved} unserved`} tone="violet" />
      <Stat icon={Clock3} label="Average queue wait" value={seconds(detail.timing.avg_wait_seconds)} detail={`Longest cumulative wait: ${seconds(detail.timing.max_wait_seconds)}`} tone="amber" />
    </Stats>
    <Grid>
      <Panel title="Volume and outcomes" description="Completed, abandoned and failed interactions by closing time." icon={ChartColumn}><Chart rows={detail.trend} series={outcomeSeries} stacked /></Panel>
      <Panel title="Average wait trend" description="Queue waiting time for interactions closed in each interval." icon={Clock3} tone="amber"><Chart rows={detail.trend} series={[{ key:"avg_wait_seconds", label:"Queue wait", color:palette[3] }]} line timing /></Panel>
    </Grid>
    <Panel title="Arrival heatmap" description="Received interactions by weekday and hour in the selected timezone. Use this pattern to plan coverage." icon={Grid3X3}><Heatmap cells={detail.heatmap} /></Panel>
    <Panel title="Queue performance breakdown" description="Each queue receives its own segment durations. Transferred interactions may appear in several queues. SLA uses measurements started in range; pending and unconfigured measurements are excluded from the rate." icon={Activity} tone="emerald">
      <DataTable label="Queue performance" rows={detail.queues} columns={[channelColumn,textColumn("queue_name","Queue"),{key:"total",label:"Closed"},{key:"completed",label:"Completed"},{key:"abandoned",label:"Abandoned"},{key:"failed",label:"Failed"},{key:"sla",label:"SLA / evaluated",render:r => `${percent(r.sla.rate)} · ${r.sla.denominator}`},timeColumn("avg_wait_seconds","Avg wait"),timeColumn("max_wait_seconds","Max wait"),timeColumn("avg_handling_seconds","Avg handling"),timeColumn("avg_talk_seconds","Voice talk"),timeColumn("avg_response_seconds","First reply")]} />
    </Panel>
    <Panel title="Service level by channel" description="Snapshot-based SLA measurements started in range. Voice measures queue visits; messaging measures the first human reply. Missing historical policies do not count as met or breached." icon={ShieldCheck} tone="violet">
      <DataTable label="Service level by channel" rows={data.channels} columns={[channelColumn,{key:"rate",label:"SLA / target",render:r=>`${percent(r.sla.rate)} / ${percent(r.sla.target)}`},...[["met","Within SLA"],["breached","Breached"],["unserved","Unserved"],["pending","Pending"],["atRisk","At risk"],["not_configured","Not configured"],["disabled","Disabled"],["excluded","Excluded"],["unavailable","No historical rule"]].map(([key,label])=>({key,label,render:r=>count(r.sla[key])}))]} />
    </Panel>
    {!!data.breaches.length && <Panel title="SLA attention" description="Latest 100 breached, unserved or at-risk measurements. Open the interaction to inspect its evidence." icon={TriangleAlert} tone="amber">
      <DataTable label="SLA attention" rows={data.breaches} columns={[channelColumn,textColumn("customer_address","Customer"),textColumn("queue_name","Queue"),{key:"state",label:"Status",render:r=>r.at_risk?"At risk":r.state},{key:"deadline_at",label:"Deadline",render:r=>new Date(r.deadline_at).toLocaleString()},{key:"preview",label:"Evidence",render:r=><Button size="sm" variant="ghost" onClick={()=>onPreview(r)}>Preview</Button>}]} />
    </Panel>}
  </div>;
}
function AgentReport({ detail }) {
  const rankings = new Map();
  for (const row of detail.agents) { const previous=rankings.get(row.agent_id); rankings.set(row.agent_id,{name:row.name,total:(previous?.total||0)+row.total}); }
  return <div className="space-y-5" data-report="agent-performance">
    <Stats>
      <Stat icon={Users} label="Participating agents" value={count(detail.totals.agents)} detail="Agents assigned to closed interactions" />
      <Stat icon={CheckCheck} label="Handled interactions" value={count(detail.totals.total)} detail="Distinct interactions across the team" tone="emerald" />
      <Stat icon={ArrowUpRight} label="Transfers" value={count(detail.totals.transfers || 0)} detail="Transfer outcomes on agent segments" tone="amber" />
      <Stat icon={Clock3} label="Average handling time" value={seconds(detail.totals.avg_handling_seconds)} detail="Per agent participation, including wrap-up" tone="violet" />
    </Stats>
    <Grid>
      <Panel title="Top agents by handled interactions" description="Top 10 agents in the selected channels and queues." icon={Users}><Chart rows={[...rankings.values()].sort((a,b)=>b.total-a.total).slice(0,10)} axis="name" series={[{key:"total",label:"Handled"}]} horizontal /></Panel>
      <Panel title="Handled volume over time" description="Distinct interactions by closing time, with average handling per agent participation on the right axis." icon={Activity} tone="emerald"><Chart rows={detail.trend} secondaryTiming series={[{key:"total",label:"Handled",color:palette[1]},{key:"avg_handling_seconds",label:"Avg handling",color:palette[2],duration:true}]} /></Panel>
    </Grid>
    <Panel title="Agent scorecard" description="Durations belong to each agent’s own segments. First reply measures a human reply after assignment; only accepted sends count for delivery-based channels. Talk and holds apply only to supported channels." icon={Users} tone="violet">
      <DataTable label="Agent scorecard" rows={detail.agents} columns={[channelColumn,textColumn("name","Agent"),{key:"total",label:"Handled"},{key:"completed",label:"Completed"},timeColumn("avg_handling_seconds","Avg handling"),timeColumn("avg_talk_seconds","Voice talk"),timeColumn("avg_response_seconds","First reply"),{key:"holds",label:"Holds"},timeColumn("hold_seconds","Hold time"),{key:"transfers",label:"Transfers"},{key:"transfer_rate",label:"Transferred / handled",render:r=>percent(ratio(r.transferred,r.total))}]} />
    </Panel>
    <Panel title="Workforce time" description="All-channel workforce time for participating agents within the selected dates. Busy status measures elapsed time, so simultaneous interactions do not multiply it." icon={Clock3} tone="amber">
      <DataTable label="Workforce time" emptyMessage="No workforce time was recorded for these agents in this period." rows={detail.workforce} columns={[textColumn("name","Agent"),timeColumn("loggedInSeconds","Logged in"),timeColumn("callSeconds","Busy"),timeColumn("availableSeconds","Available"),timeColumn("breakSeconds","Breaks"),{key:"occupancyPct",label:"Busy / logged in",render:r=>percent(r.occupancyPct)}]} />
    </Panel>
  </div>;
}
function AbandonmentReport({ data, detail, onPreview }) {
  return <div className="space-y-5" data-report="abandonment">
    <Stats>
      <Stat icon={ArrowUpRight} label="Abandoned interactions" value={count(data.totals.abandoned)} detail="Closed with an abandoned outcome" tone="amber" />
      <Stat icon={TriangleAlert} label="Failed interactions" value={count(data.totals.failed)} detail="Closed with a failed outcome" />
      <Stat icon={Activity} label="Lost outcome rate" value={percent(ratio(data.totals.abandoned+data.totals.failed,data.totals.closed))} detail="Abandoned + failed / all closed" tone="violet" />
      <Stat icon={ShieldCheck} label="Unserved SLA measurements" value={count(data.sla.unserved)} detail="Ended without service · started in range" tone="emerald" />
    </Stats>
    <Grid>
      <Panel title="Wait before abandonment or failure" description="Cumulative queue wait. Missing waiting evidence stays separate; ranges also cover asynchronous channels." icon={Clock3} tone="amber"><Chart rows={detail.buckets} axis="label" series={outcomeSeries.slice(1)} stacked /></Panel>
      <Panel title="Outcomes by arrival hour" description="Closing outcomes grouped by the local arrival hour to reveal gaps in coverage." icon={Activity}><Chart rows={detail.hourly.map(r=>({...r,label:`${String(r.hour).padStart(2,"0")}:00`}))} axis="label" series={outcomeSeries} stacked /></Panel>
    </Grid>
    <Panel title="Loss rate by queue" description="Closed interactions attributed to every queue they visited; rates use that queue’s closed population." icon={TriangleAlert} tone="amber">
      <DataTable label="Loss rate by queue" rows={detail.queues} columns={[channelColumn,textColumn("queue_name","Queue"),{key:"total",label:"Closed"},{key:"abandoned",label:"Abandoned"},{key:"failed",label:"Failed"},{key:"rate",label:"Lost rate",render:r=>percent(ratio(r.abandoned+r.failed,r.total))},timeColumn("avg_wait_seconds","Avg wait before loss")]} />
    </Panel>
    <Panel title="Recorded loss reasons" description="Terminal reasons recorded for abandoned and failed interactions." icon={Tag} tone="violet"><DataTable label="Recorded loss reasons" rows={detail.reasons} columns={[channelColumn,textColumn("state","Outcome"),textColumn("reason","Reason"),{key:"total",label:"Interactions"}]} /></Panel>
    <Panel title="Recovery list" description="Latest 100 abandoned or failed interactions. Open the conversation or voice record to review the customer’s experience." icon={ArrowUpRight}>
      <DataTable label="Recovery list" rows={detail.recent} columns={[channelColumn,textColumn("customer_address","Customer"),textColumn("queue_name","Queue"),textColumn("state","Outcome"),timeColumn("avg_wait_seconds","Queue wait"),textColumn("terminal_reason","Reason"),{key:"terminal_at",label:"Closed",render:r=>new Date(r.terminal_at).toLocaleString()},{key:"preview",label:"Evidence",render:r=><Button size="sm" variant="ghost" onClick={()=>onPreview(r)}>Preview</Button>}]} />
    </Panel>
  </div>;
}
function WrapupReport({ detail }) {
  const mix = new Map();
  for (const row of detail.codes) { const previous=mix.get(row.wrapup_code_id); mix.set(row.wrapup_code_id,{id:row.wrapup_code_id,label:row.name,interactions:(previous?.interactions||0)+row.interactions}); }
  const ranked=[...mix.values()].sort((a,b)=>b.interactions-a.interactions), top=ranked.find(r=>r.id!=null);
  const leaders=ranked.slice(0,8), points=new Map();
  for (const row of detail.trend) {
    const index=leaders.findIndex(c=>c.id===row.wrapup_code_id);
    if (index<0) continue;
    const point=points.get(row.bucket)||Object.fromEntries([["bucket",row.bucket],...leaders.map((_,i)=>[`code_${i}`,0])]);
    point[`code_${index}`]=row.interactions; points.set(row.bucket,point);
  }
  return <div className="space-y-5" data-report="wrapup-codes">
    <Stats>
      <Stat icon={CheckCheck} label="Disposition coverage" value={percent(ratio(detail.totals.coded,detail.totals.eligible))} detail={`${count(detail.totals.coded)} of ${count(detail.totals.eligible)} completed agent-handled interactions`} tone="emerald" />
      <Stat icon={Tag} label="Distinct codes used" value={count(detail.totals.distinct_codes)} detail="Across closed interactions in range" />
      <Stat icon={ChartColumn} label="Most used disposition" value={top?.label||"—"} detail={top ? `${count(top.interactions)} interactions` : "No recorded codes in range"} tone="violet" />
      <Stat icon={TriangleAlert} label="Missing dispositions" value={count(detail.totals.eligible-detail.totals.coded)} detail="Completed agent-handled interactions without a code" tone="amber" />
    </Stats>
    <Grid>
      <Panel title="Disposition mix" description="Top 10 dispositions, including interactions with uncoded agent segments." icon={Tag}><Chart rows={ranked.slice(0,10)} axis="label" series={[{key:"interactions",label:"Interactions",color:palette[2]}]} horizontal /></Panel>
      <Panel title="Disposition trend" description="Top 8 dispositions by closing time. An interaction can have several codes after transfers." icon={Activity} tone="violet"><Chart rows={[...points.values()]} series={leaders.map((r,i)=>({key:`code_${i}`,label:r.label,color:palette[i]}))} stacked /></Panel>
    </Grid>
    <Panel title="Disposition breakdown" description="Interactions are distinct within each code and channel; agent segments show repeated use of a code." icon={Tag} tone="emerald"><DataTable label="Disposition breakdown" rows={detail.codes} columns={[channelColumn,textColumn("name","Disposition"),{key:"interactions",label:"Interactions"},{key:"segments",label:"Agent segments"}]} /></Panel>
    <Panel title="Dispositions by queue" description="Codes are attributed to the queue of the segment where the agent recorded them." icon={Grid3X3} tone="violet"><DataTable label="Dispositions by queue" rows={detail.queues} columns={[channelColumn,textColumn("queue_name","Queue"),textColumn("name","Disposition"),{key:"interactions",label:"Interactions"},{key:"segments",label:"Agent segments"}]} /></Panel>
  </div>;
}
export default function SupervisorReportContent({ report, data, loading, onPreview }) {
  if (loading) return <div className="space-y-5" aria-label="Loading report"><Stats>{[0,1,2,3].map(i=><Skeleton key={i} className="h-40 rounded-xl" />)}</Stats><Grid><Skeleton className="h-96 rounded-xl" /><Skeleton className="h-96 rounded-xl" /></Grid><Skeleton className="h-64 rounded-xl" /></div>;
  if (!data?.detail || data.detail.report!==report) return <p role="alert" className="rounded-xl border p-5 text-sm text-muted-foreground">Report details are unavailable. Refresh to try again.</p>;
  const props={data,detail:data.detail,onPreview};
  if (report==="queue-performance") return <QueueReport {...props} />;
  if (report==="agent-performance") return <AgentReport {...props} />;
  if (report==="abandonment") return <AbandonmentReport {...props} />;
  return <WrapupReport {...props} />;
}
