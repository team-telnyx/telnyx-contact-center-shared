"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  IconAlertTriangle,
  IconCloud,
  IconDatabase,
  IconGitBranch,
  IconPhone,
  IconRefresh,
  IconRobot,
  IconRoute,
  IconServer,
  IconShieldCheck,
  IconSparkles,
  IconUsers,
} from "@tabler/icons-react";

import { SystemSectionPage } from "@/components/admin/SystemSectionNav";
import {
  AdminPageHeader,
  AdminPageShell,
} from "@/components/contact-center/WorkspacePageLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const RANGE_OPTIONS = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
];

const INVENTORY_TILES = [
  {
    key: "users",
    label: "Users",
    icon: IconUsers,
    detail: (inventory) =>
      inventory.usersActive == null
        ? "Verification status unavailable"
        : `${inventory.usersActive} verified accounts`,
    tone: "from-sky-500/15 to-blue-500/5 text-sky-700 dark:text-sky-300",
  },
  {
    key: "queues",
    label: "Queues",
    icon: IconRoute,
    detail: (inventory) =>
      inventory.queuesActive == null
        ? "Queue status unavailable"
        : `${inventory.queuesActive} active queues`,
    tone: "from-violet-500/15 to-purple-500/5 text-violet-700 dark:text-violet-300",
  },
  {
    key: "numbers",
    label: "Numbers",
    icon: IconPhone,
    detail: () => "Telnyx number inventory",
    tone: "from-cyan-500/15 to-sky-500/5 text-cyan-700 dark:text-cyan-300",
  },
  {
    key: "assistants",
    label: "AI Assistants",
    icon: IconRobot,
    detail: () => "Assistants available in Telnyx",
    tone: "from-emerald-500/15 to-teal-500/5 text-emerald-700 dark:text-emerald-300",
  },
  {
    key: "flows",
    label: "Call & App Flows",
    icon: IconGitBranch,
    detail: () => "Locally configured flows",
    tone: "from-amber-500/15 to-orange-500/5 text-amber-700 dark:text-amber-300",
  },
  {
    key: "skills",
    label: "Skills",
    icon: IconSparkles,
    detail: (inventory) =>
      inventory.skillsActive == null
        ? "Skill status unavailable"
        : `${inventory.skillsActive} active skills`,
    tone: "from-rose-500/15 to-pink-500/5 text-rose-700 dark:text-rose-300",
  },
];

function formatValue(value) {
  return value == null ? "—" : Number(value).toLocaleString();
}

function formatTimestamp(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatActivityType(value) {
  return String(value || "activity")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function DashboardTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl">
      <div className="mb-1 font-semibold">{label}</div>
      <div className="space-y-1">
        {payload.map((entry) => (
          <div
            key={entry.dataKey || entry.name}
            className="flex min-w-36 items-center justify-between gap-4"
          >
            <span className="capitalize text-muted-foreground">
              {String(entry.name || entry.dataKey)}
            </span>
            <span className="font-semibold">
              {Number(entry.value || 0).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function InventoryTile({ item, inventory }) {
  const Icon = item.icon;
  return (
    <Card className="overflow-hidden border bg-card shadow-sm transition hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <span className={`rounded-2xl bg-gradient-to-br p-3 ${item.tone}`}>
            <Icon className="size-5" />
          </span>
          <span className="text-3xl font-semibold tracking-tight">
            {formatValue(inventory[item.key])}
          </span>
        </div>
        <div className="mt-5">
          <h3 className="font-semibold">{item.label}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {item.detail(inventory)}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ServiceCard({ icon: Icon, label, service }) {
  const ready = service?.ready === true;
  const unavailable = service?.status === "not_configured";
  return (
    <Card className="border bg-card shadow-sm">
      <CardContent className="flex items-start gap-4 p-5">
        <span
          className={`flex size-11 shrink-0 items-center justify-center rounded-2xl ${
            ready
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
              : "bg-amber-500/15 text-amber-600 dark:text-amber-300"
          }`}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{label}</h3>
            <Badge
              variant="outline"
              className={
                ready
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              }
            >
              {ready ? "Connected" : unavailable ? "Not configured" : "Attention"}
            </Badge>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {service?.detail || "Status unavailable"}
          </p>
          {service?.latencyMs != null ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {service.latencyMs} ms query latency
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function DashboardLoading() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-36 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-32 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}

export default function SystemDashboardPage() {
  const [range, setRange] = useState("24h");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/admin/system-dashboard?range=${encodeURIComponent(range)}`,
        { cache: "no-store" },
      );
      const payload = await response.json();
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || "Could not load dashboard");
      }
      setData(payload);
    } catch (loadError) {
      setError(loadError?.message || "Could not load dashboard");
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const totalActivity = useMemo(
    () =>
      (data?.traffic || []).reduce(
        (total, item) => total + Number(item.interactions || 0) + Number(item.executions || 0),
        0,
      ),
    [data],
  );

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      {RANGE_OPTIONS.map((option) => (
        <Button
          key={option.id}
          size="sm"
          variant={range === option.id ? "default" : "outline"}
          onClick={() => setRange(option.id)}
        >
          {option.label}
        </Button>
      ))}
      <Button variant="outline" onClick={loadDashboard} disabled={loading}>
        <IconRefresh className={`size-4 ${loading ? "animate-spin" : ""}`} />
        Refresh
      </Button>
    </div>
  );

  return (
    <AdminPageShell>
      <AdminPageHeader
        title="System Dashboard"
        icon={IconShieldCheck}
        badges={
          <Badge variant="secondary">
            Updated {formatTimestamp(data?.generatedAt)}
          </Badge>
        }
        actions={headerActions}
      />
      <SystemSectionPage activeId="dashboard">
        <div className="space-y-5 overflow-y-auto pr-1 pb-4">
          {error ? (
            <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              <IconAlertTriangle className="mt-0.5 size-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">Dashboard unavailable</div>
                <div className="mt-1 opacity-90">{error}</div>
              </div>
              <Button size="sm" variant="outline" onClick={loadDashboard}>
                Retry
              </Button>
            </div>
          ) : null}

          {loading && !data ? (
            <DashboardLoading />
          ) : data ? (
            <>
              <section>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {INVENTORY_TILES.map((item) => (
                    <InventoryTile key={item.key} item={item} inventory={data.inventory || {}} />
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <div>
                  <h2 className="text-lg font-semibold">Connections</h2>
                  <p className="text-sm text-muted-foreground">
                    Health checks expose availability without revealing credentials.
                  </p>
                </div>
                <div className="grid gap-4 xl:grid-cols-3">
                  <ServiceCard icon={IconDatabase} label="Primary database" service={data.services?.database} />
                  <ServiceCard icon={IconCloud} label="Telnyx account" service={data.services?.telnyx} />
                  <ServiceCard icon={IconServer} label="Application API" service={data.services?.application} />
                </div>
              </section>

              <section className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,0.65fr)]">
                <Card className="border bg-card shadow-sm">
                  <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
                    <div>
                      <CardTitle>Platform activity</CardTitle>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Interactions, flow executions, and exceptions in the selected range.
                      </p>
                    </div>
                    <Badge variant="outline">{formatValue(totalActivity)} operations</Badge>
                  </CardHeader>
                  <CardContent>
                    <div className="h-72">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={data.traffic || []} margin={{ left: -20, right: 10, top: 8 }}>
                          <defs>
                            <linearGradient id="interactionsGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                              <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                          <XAxis dataKey="label" tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
                          <YAxis allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} tickLine={false} axisLine={false} />
                          <Tooltip content={<DashboardTooltip />} />
                          <Area type="monotone" dataKey="interactions" name="Interactions" stroke="#10b981" fill="url(#interactionsGradient)" strokeWidth={2} />
                          <Area type="monotone" dataKey="executions" name="Flow executions" stroke="#38bdf8" fill="transparent" strokeWidth={2} />
                          <Area type="monotone" dataKey="exceptions" name="Exceptions" stroke="#f97316" fill="transparent" strokeWidth={2} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border bg-card shadow-sm">
                  <CardHeader>
                    <CardTitle>Role distribution</CardTitle>
                    <p className="text-sm text-muted-foreground">
                      Assigned roles across all user accounts.
                    </p>
                  </CardHeader>
                  <CardContent>
                    <div className="h-72">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={data.roleDistribution || []} layout="vertical" margin={{ left: 12, right: 10 }}>
                          <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="3 3" />
                          <XAxis type="number" allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} tickLine={false} axisLine={false} />
                          <YAxis type="category" dataKey="role" width={78} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} tickLine={false} axisLine={false} />
                          <Tooltip content={<DashboardTooltip />} />
                          <Bar dataKey="total" name="Users" fill="#a78bfa" radius={[0, 6, 6, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              </section>

              <Card className="border bg-card shadow-sm">
                <CardHeader>
                  <CardTitle>Recent platform activity</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Latest authenticated user and queue events recorded by the contact center.
                  </p>
                </CardHeader>
                <CardContent>
                  {data.recentActivity?.length ? (
                    <div className="divide-y rounded-xl border">
                      {data.recentActivity.map((event, index) => (
                        <div
                          key={`${event.createdAt || "event"}-${index}`}
                          className="flex flex-col justify-between gap-2 px-4 py-3 sm:flex-row sm:items-center"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
                            <div className="min-w-0">
                              <div className="font-medium">{formatActivityType(event.type)}</div>
                              <div className="truncate text-xs text-muted-foreground">
                                {event.actor}
                                {event.value ? ` · ${event.value}` : ""}
                              </div>
                            </div>
                          </div>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatTimestamp(event.createdAt)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                      No recent platform activity is available.
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          ) : null}
        </div>
      </SystemSectionPage>
    </AdminPageShell>
  );
}
