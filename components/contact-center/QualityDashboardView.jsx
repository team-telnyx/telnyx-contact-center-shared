"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconChecklist,
  IconCircleCheck,
  IconGauge,
  IconRobot,
  IconUsers,
} from "@tabler/icons-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { notify } from "@/components/ToastNotify";

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-popover px-3 py-2 text-xs shadow-md dark:bg-zinc-950">
      <div className="font-medium text-foreground">{label}</div>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="mt-1 flex items-center gap-2 text-muted-foreground">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
          {entry.name}: <span className="font-medium text-foreground">{entry.value ?? "-"}</span>
        </div>
      ))}
    </div>
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

function RankedList({ title, rows, valueKey = "avgScorePercent", labelKey, countKey = "evaluations" }) {
  const medalClasses = [
    "bg-amber-500/15 text-amber-600 dark:text-amber-300",
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
    "bg-orange-700/15 text-orange-700 dark:text-orange-300",
  ];
  return (
    <Card className="border bg-background/85 shadow-sm">
      <CardContent className="p-5">
        <h4 className="text-sm font-semibold">{title}</h4>
        <div className="mt-4 space-y-3">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No evaluations in this range.</p>
          ) : (
            rows.map((row, index) => (
              <div key={`${row[labelKey]}-${index}`} className="flex items-center gap-3">
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    medalClasses[index] || "bg-muted text-muted-foreground"
                  }`}
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate font-medium">{row[labelKey]}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {row[valueKey] != null ? `${row[valueKey]}%` : "-"} · {row[countKey]}
                    </span>
                  </div>
                  <Progress value={Number(row[valueKey] || 0)} className="mt-1.5 h-1.5" />
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function QualityDashboardView({ from, to, refreshNonce = 0 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const sp = new URLSearchParams();
        if (from) sp.set("from", from);
        if (to) sp.set("to", to);
        const res = await fetch(`/api/contact-center/quality/dashboard?${sp.toString()}`, {
          cache: "no-store",
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload?.error || "Failed to load quality dashboard");
        if (!cancelled) setData(payload.data || null);
      } catch (error) {
        if (!cancelled) {
          setData(null);
          notify({
            title: "Quality dashboard load failed",
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
  }, [from, to, refreshNonce]);

  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-48 rounded-2xl" />
        ))}
      </div>
    );
  }

  const totals = data?.totals || {};
  const aiShare =
    totals.total > 0
      ? Math.round(((totals.aiEvaluations + totals.hybridEvaluations) / totals.total) * 100)
      : 0;

  return (
    <div className="space-y-5" data-testid="quality-dashboard-view">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={IconGauge}
          label="Average quality score"
          value={totals.avgScorePercent != null ? `${totals.avgScorePercent}%` : "-"}
          detail="Reviewed and final evaluations"
          progress={Math.round(Number(totals.avgScorePercent || 0))}
          tone="emerald"
        />
        <MetricTile
          icon={IconChecklist}
          label="Evaluations"
          value={totals.total ?? 0}
          detail={`${totals.inProgress ?? 0} in progress`}
          progress={totals.total > 0 ? Math.round(((totals.finalized || 0) / totals.total) * 100) : 0}
          tone="sky"
        />
        <MetricTile
          icon={IconCircleCheck}
          label="Finalized"
          value={totals.finalized ?? 0}
          detail={`${totals.disputed ?? 0} disputed`}
          progress={totals.total > 0 ? Math.round(((totals.finalized || 0) / totals.total) * 100) : 0}
          tone="slate"
        />
        <MetricTile
          icon={IconRobot}
          label="AI-assisted"
          value={`${aiShare}%`}
          detail={`${totals.aiDrafts ?? 0} AI drafts awaiting review`}
          progress={aiShare}
          tone="violet"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border bg-background/85 shadow-sm">
          <CardContent className="p-5">
            <h4 className="text-sm font-semibold">Quality trend</h4>
            <div className="mt-4 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data?.daily || []}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/60" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                  <Tooltip content={<ChartTooltip />} />
                  <Line
                    type="monotone"
                    dataKey="avgScorePercent"
                    name="Avg score %"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
        <Card className="border bg-background/85 shadow-sm">
          <CardContent className="p-5">
            <h4 className="text-sm font-semibold">Evaluations per day</h4>
            <div className="mt-4 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data?.daily || []}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/60" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="evaluations" name="Evaluations" fill="#0ea5e9" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <RankedList title="Top agents by quality" rows={data?.agents || []} labelKey="agentName" />
        <RankedList title="Scores by form" rows={data?.forms || []} labelKey="formName" />
        <RankedList title="Scores by queue" rows={data?.queues || []} labelKey="queueName" />
      </div>
    </div>
  );
}
