"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChannelFilter } from "./InteractionChannel";

export default function AnalyticsReportFilters({
  channel,
  onChannelChange,
  range,
  onRangeChange,
  from,
  to,
  onFromChange,
  onToChange,
  onRefresh,
  loading = false,
  queueFilter,
  children,
}) {
  return (
    <div
      role="region"
      aria-label="Report filters"
      data-testid="analytics-report-filters"
      className="min-w-0 space-y-3 rounded-2xl border border-border/70 bg-card p-3 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <ChannelFilter value={channel} onChange={onChannelChange} />
          {queueFilter}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Reporting period"
            className="inline-flex items-center gap-1 rounded-xl border bg-muted/30 p-1"
          >
            {[["1d", "1 day"], ["7d", "7 days"], ["30d", "30 days"], ["custom", "Custom"]].map(([value, label]) => (
              <button
                key={value}
                type="button"
                value={value}
                aria-pressed={range === value}
                onClick={() => { if (range !== value) onRangeChange(value); }}
                className={`whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${range === value ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-background/70 hover:text-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>
      {range === "custom" && (
        <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
          <label className="min-w-0 space-y-1 text-xs text-muted-foreground">
            <span>From</span>
            <Input aria-label="From" type="datetime-local" value={from} onChange={(event) => onFromChange(event.target.value)} className="min-w-0 bg-background text-foreground" />
          </label>
          <label className="min-w-0 space-y-1 text-xs text-muted-foreground">
            <span>To (exclusive)</span>
            <Input aria-label="To (exclusive)" type="datetime-local" value={to} onChange={(event) => onToChange(event.target.value)} className="min-w-0 bg-background text-foreground" />
          </label>
        </div>
      )}
      {children && <div className="flex flex-wrap items-center gap-3 border-t pt-3">{children}</div>}
    </div>
  );
}
