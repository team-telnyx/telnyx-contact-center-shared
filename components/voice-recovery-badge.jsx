"use client";
import { useTelnyx } from "@/components/telephony-provider";
import { recoveryBadge } from "@/lib/telephony/call-recovery.mjs";
import { Wifi, WifiOff, RefreshCw } from "lucide-react";

export function VoiceRecoveryBadge() {
  const { status, recovery } = useTelnyx();
  const { label, tone, description } = recoveryBadge(recovery?.state, status);
  const Icon = tone === "warning" ? RefreshCw : tone === "ready" ? Wifi : WifiOff;
  const colors = {
    ready: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
    warning: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
    error: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300",
    offline: "border-zinc-500/40 bg-zinc-500/10 text-zinc-500 dark:text-zinc-300",
  };
  return <span role="status" aria-live="polite" aria-atomic="true"
    data-testid="voice-recovery-badge" data-recovery-state={recovery?.state || "idle"}
    tabIndex={0} aria-label={`${label}. ${description}`} title={`${label}: ${description}`} className={`relative grid h-7 w-7 shrink-0 place-items-center rounded-full border ${colors[tone]}`}>
    <Icon aria-hidden="true" className={`h-4 w-4 ${tone === "warning" ? "motion-safe:animate-pulse" : ""}`} />
    <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-background bg-current" />
    <span className="sr-only">{label}</span>
  </span>;
}
