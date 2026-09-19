"use client";

import { useState } from "react";
import { Copy, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ToastNotify";
import { useAIWidgetUI } from "@/components/ai-widget-ui-provider";

const toneClasses = {
  danger: "border-red-500/60 bg-red-500/10 text-red-500",
  info: "border-blue-500/60 bg-blue-500/10 text-blue-500",
  neutral: "border-zinc-500/60 bg-zinc-500/10 text-zinc-400",
  success: "border-emerald-500/60 bg-emerald-500/10 text-emerald-500",
  warning: "border-amber-500/60 bg-amber-500/10 text-amber-500",
};

export function AIWidgetStatus({ compact = false }) {
  const { diagnostics, error, status } = useAIWidgetUI();
  const [open, setOpen] = useState(false);

  const copyDiagnostics = async () => {
    const payload = JSON.stringify({ status: status.key, error, ...diagnostics }, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      notify({ title: "Connection details copied", variant: "success" });
    } catch {
      notify({ title: "Could not copy connection details", variant: "error" });
    }
  };

  return (
    <div
      className="relative"
      data-ai-widget-status
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium ${
          toneClasses[status.tone]
        }`}
        aria-label={`${status.label}. Show connection details`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className={`size-1.5 rounded-full bg-current ${status.animated ? "animate-pulse" : ""}`}
        />
        {status.label}
      </button>

      {open && (
        <div
          className={`absolute left-0 top-full z-50 mt-2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl ${
            compact ? "w-64" : "w-72"
          }`}
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold">{status.label}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{status.description}</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close details">
              <X className="size-3.5 text-muted-foreground" />
            </button>
          </div>
          <dl className="space-y-1 border-t border-border pt-2 text-[10px]">
            {[
              ["Connection", diagnostics.connectionState],
              ["Call", diagnostics.callState],
              ["Region", diagnostics.region],
              ["Datacenter", diagnostics.datacenter],
              ["Session ID", diagnostics.sessionId],
              ["Call report ID", diagnostics.callReportId],
              ["Response latency", diagnostics.responseLatencyMs == null ? null : `${diagnostics.responseLatencyMs} ms`],
              ["Greeting latency", diagnostics.greetingLatencyMs == null ? null : `${diagnostics.greetingLatencyMs} ms`],
            ].map(([label, value]) => (
              <div key={label} className="grid grid-cols-[78px_1fr] gap-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="truncate font-mono" title={value || undefined}>{value || "—"}</dd>
              </div>
            ))}
          </dl>
          <Button type="button" variant="outline" size="sm" className="mt-3 h-7 w-full text-xs" onClick={copyDiagnostics}>
            <Copy className="mr-1.5 size-3" /> Copy diagnostics
          </Button>
        </div>
      )}
    </div>
  );
}

export function AIWidgetConnectionAlert() {
  const { canRetryConnection, clearError, error, retryConnection, status } = useAIWidgetUI();
  if (!error && status.key !== "disconnected") return null;
  const showRetry = canRetryConnection || status.key === "disconnected";

  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600" role="alert">
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {showRetry ? "Could not connect" : "Action required"}
        </p>
        <p className="mt-0.5 break-words text-[11px] opacity-80">
          {error || "Reconnect before starting another conversation."}
        </p>
      </div>
      {showRetry && (
        <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 border-red-500/40 px-2 text-[11px]" onClick={retryConnection}>
          <RotateCcw className="mr-1 size-3" /> Retry
        </Button>
      )}
      {error && (
        <button type="button" aria-label="Dismiss error" className="mt-1" onClick={clearError}>
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
