"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChannelFilter } from "./InteractionChannel";

export default function MonitoringFilters({ channel, onChannelChange, onRefresh, loading = false, status, children }) {
  return <div role="region" aria-label="Monitoring filters" data-testid="monitoring-filters" className="shrink-0 rounded-2xl border border-border/70 bg-card p-3 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3"><ChannelFilter value={channel} onChange={onChannelChange} />{children}</div>
      <div className="ml-auto flex items-center gap-3">
        {status && <span className="text-xs text-muted-foreground" aria-live="polite">{status}</span>}
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}><RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />Refresh</Button>
      </div>
    </div>
  </div>;
}
