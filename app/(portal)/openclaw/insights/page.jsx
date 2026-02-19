"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  IconBrain,
  IconPuzzle,
  IconClock,
  IconRobot,
  IconRefresh,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function OpenClawInsightsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/openclaw/insights");
      const json = await res.json();
      setData(json);
    } catch (e) {
      console.error("Failed to fetch insights:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const statCards = data
    ? [
        { label: "Sessions Today", value: data.sessionsToday, icon: IconBrain, color: "text-blue-500" },
        { label: "Skills Installed", value: data.skillsInstalled, icon: IconPuzzle, color: "text-green-500" },
        { label: "Uptime (hours)", value: data.uptimeHours, icon: IconClock, color: "text-yellow-500" },
        { label: "Active Automations", value: data.activeAutomations, icon: IconRobot, color: "text-purple-500" },
      ]
    : [];

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">OpenClaw Insights</h1>
          <p className="text-muted-foreground">Usage metrics and analytics</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <IconRefresh className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardHeader className="pb-2">
                  <Skeleton className="h-4 w-24" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-16" />
                </CardContent>
              </Card>
            ))
          : statCards.map((s) => (
              <Card key={s.label}>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardDescription>{s.label}</CardDescription>
                  <s.icon className={cn("h-5 w-5", s.color)} />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">{s.value}</div>
                </CardContent>
              </Card>
            ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Usage Over Time</CardTitle>
          <CardDescription>Sessions and automations — last 7 days</CardDescription>
        </CardHeader>
        <CardContent>
          {loading || !data ? (
            <Skeleton className="h-[300px] w-full" />
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.usageOverTime}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" className="text-xs" />
                <YAxis className="text-xs" />
                <RechartsTooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "var(--radius)",
                    color: "hsl(var(--popover-foreground))",
                  }}
                />
                <Legend />
                <Bar dataKey="sessions" fill="hsl(var(--chart-1, 220 70% 50%))" radius={[4, 4, 0, 0]} />
                <Bar dataKey="automations" fill="hsl(var(--chart-2, 160 60% 45%))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
