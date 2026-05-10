"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PieChart,
  Pie,
  Cell,
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
  IconPhone,
  IconClock,
  IconCheck,
  IconX,
  IconTrendingUp,
  IconTrendingDown,
  IconRefresh,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// Custom Tooltip component for Recharts that respects dark/light theme
function CustomTooltip({ active, payload, label }) {
  const { theme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Check initial theme
    const checkDark = () => {
      if (theme === "dark") {
        setIsDark(true);
      } else if (theme === "system") {
        setIsDark(document.documentElement.classList.contains("dark"));
      } else {
        setIsDark(false);
      }
    };
    checkDark();

    // Listen for theme changes
    const observer = new MutationObserver(checkDark);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, [theme]);

  if (!active || !payload || !payload.length) {
    return null;
  }

  return (
    <div
      className={cn(
        "rounded-lg border p-3 shadow-md",
        isDark
          ? "bg-card border-border text-card-foreground"
          : "bg-popover border-border text-popover-foreground",
      )}
    >
      <p className="font-medium mb-2">{label}</p>
      {payload.map((entry, index) => (
        <p key={index} className="text-sm">
          <span
            className="inline-block w-3 h-3 rounded-sm mr-2"
            style={{ backgroundColor: entry.color }}
          />
          {entry.name}: {entry.value}
        </p>
      ))}
    </div>
  );
}

function formatTime(seconds) {
  if (!seconds || seconds === 0) return "0s";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

function MetricCard({
  title,
  value,
  description,
  icon: Icon,
  trend,
  className,
}) {
  return (
    <Card className={cn("relative overflow-hidden", className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {Icon && (
          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
            <Icon className="h-4 w-4 text-primary" />
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
        {trend && (
          <div className="flex items-center gap-1 mt-2 text-xs">
            {trend > 0 ? (
              <>
                <IconTrendingUp className="h-3 w-3 text-emerald-500" />
                <span className="text-emerald-500">+{trend}%</span>
              </>
            ) : trend < 0 ? (
              <>
                <IconTrendingDown className="h-3 w-3 text-red-500" />
                <span className="text-red-500">{trend}%</span>
              </>
            ) : null}
            <span className="text-muted-foreground ml-1">vs yesterday</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChartCard({ title, description, children, className }) {
  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function AgentDashboard({ className }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState("today");

  async function fetchData() {
    try {
      setRefreshing(true);
      const res = await fetch(`/api/dashboard/stats?period=${period}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error("Failed to fetch dashboard data");
      }
      const result = await res.json();
      setData(result);
      setError(null);
    } catch (err) {
      console.error("Error fetching dashboard data:", err);
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    fetchData();
  }, [period]);

  if (loading) {
    return (
      <div className={cn("space-y-6", className)}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn(className)}>
        <Card>
          <CardContent className="pt-6">
            <p className="text-destructive">Error loading dashboard: {error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const metrics = data?.metrics || {};
  const charts = data?.charts || {};

  // Prepare pie chart data
  const performanceData = charts.performanceDistribution || [];
  const totalPerformance = performanceData.reduce(
    (sum, item) => sum + item.value,
    0,
  );

  // Prepare hourly activity data
  const hourlyData = charts.hourlyActivity || [];
  // Fill in missing hours with 0
  const fullHourlyData = Array.from({ length: 24 }, (_, i) => {
    const existing = hourlyData.find((d) => d.hour === i);
    return (
      existing || {
        hour: i,
        hourLabel: `${String(i).padStart(2, "0")}:00`,
        total: 0,
        completed: 0,
        abandoned: 0,
      }
    );
  });

  // Prepare queue distribution data
  const queueData = charts.queueDistribution || [];

  return (
    <div className={cn("space-y-6 pb-6", className)}>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            Your performance metrics and activity overview
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Period Switcher */}
          <div className="flex gap-2 bg-muted/50 rounded-lg p-1">
            <button
              onClick={() => setPeriod("today")}
              disabled={loading || refreshing}
              className={cn(
                "px-4 py-2 rounded-md text-sm font-medium transition-all",
                period === "today"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-background",
              )}
            >
              Today
            </button>
            <button
              onClick={() => setPeriod("7days")}
              disabled={loading || refreshing}
              className={cn(
                "px-4 py-2 rounded-md text-sm font-medium transition-all",
                period === "7days"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-background",
              )}
            >
              7 Days
            </button>
            <button
              onClick={() => setPeriod("30days")}
              disabled={loading || refreshing}
              className={cn(
                "px-4 py-2 rounded-md text-sm font-medium transition-all",
                period === "30days"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-background",
              )}
            >
              30 Days
            </button>
          </div>

          <Button
            onClick={fetchData}
            disabled={refreshing || loading}
            variant="outline"
            size="sm"
          >
            <IconRefresh
              className={cn(
                "h-4 w-4 mr-2",
                (refreshing || loading) && "animate-spin",
              )}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Metrics Cards - Single Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title={period === "today" ? "Today's Calls" : "Total Calls"}
          value={metrics.totalCalls || 0}
          description={`${metrics.completedCalls || 0} completed, ${
            metrics.abandonedCalls || 0
          } abandoned`}
          icon={IconPhone}
          className="border-l-4 border-l-blue-500"
        />
        <MetricCard
          title="Average Handle Time"
          value={formatTime(metrics.avgHandleTime)}
          description="Average time to handle a call"
          icon={IconClock}
          className="border-l-4 border-l-purple-500"
        />
        <MetricCard
          title="Completion Rate"
          value={
            metrics.totalCalls > 0
              ? `${Math.round(
                  (metrics.completedCalls / metrics.totalCalls) * 100,
                )}%`
              : "0%"
          }
          description={`${metrics.completedCalls || 0} of ${
            metrics.totalCalls || 0
          } calls completed`}
          icon={IconCheck}
          className="border-l-4 border-l-emerald-500"
        />
        <MetricCard
          title="Total Talk Time"
          value={formatTime(metrics.totalTalkTime)}
          description={`Total time spent on calls ${
            period === "today"
              ? "today"
              : `in ${period === "7days" ? "7 days" : "30 days"}`
          }`}
          icon={IconPhone}
          className="border-l-4 border-l-orange-500"
        />
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Performance Distribution Pie Chart */}
        <ChartCard
          title="Call Performance"
          description="Completed vs Abandoned calls"
          className="col-span-1"
        >
          {totalPerformance > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={performanceData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) =>
                    `${name}: ${(percent * 100).toFixed(0)}%`
                  }
                  outerRadius={100}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {performanceData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <RechartsTooltip content={<CustomTooltip />} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[300px] text-muted-foreground">
              <div className="text-center">
                <IconPhone className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>No calls today</p>
              </div>
            </div>
          )}
        </ChartCard>

        {/* Queue Distribution Bar Chart */}
        <ChartCard
          title="Calls by Queue"
          description="Distribution of calls across queues"
          className="col-span-1"
        >
          {queueData.length > 0 ? (
            <ResponsiveContainer width="100%" height={350}>
              <BarChart
                data={queueData}
                margin={{ top: 20, right: 30, left: 20, bottom: 60 }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="queueName"
                  angle={0}
                  textAnchor="middle"
                  tick={{ fontSize: 12 }}
                  interval={0}
                  height={60}
                />
                <YAxis />
                <RechartsTooltip content={<CustomTooltip />} />
                <Legend />
                <Bar
                  dataKey="completed"
                  stackId="a"
                  fill="#10b981"
                  name="Completed"
                />
                <Bar
                  dataKey="abandoned"
                  stackId="a"
                  fill="#ef4444"
                  name="Abandoned"
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[300px] text-muted-foreground">
              <div className="text-center">
                <IconPhone className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>No queue data available</p>
              </div>
            </div>
          )}
        </ChartCard>
      </div>

      {/* Hourly Activity Chart */}
      <ChartCard
        title="Hourly Activity"
        description="Call volume throughout the day"
        className="col-span-1"
      >
        {hourlyData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={fullHourlyData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="hourLabel" tick={{ fontSize: 11 }} interval={2} />
              <YAxis />
              <RechartsTooltip content={<CustomTooltip />} />
              <Legend />
              <Bar dataKey="completed" fill="#10b981" name="Completed" />
              <Bar dataKey="abandoned" fill="#ef4444" name="Abandoned" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-[300px] text-muted-foreground">
            <div className="text-center">
              <IconClock className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No hourly activity data</p>
            </div>
          </div>
        )}
      </ChartCard>
    </div>
  );
}
