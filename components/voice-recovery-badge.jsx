"use client";
import { useTelnyx } from "@/components/telephony-provider";
import { recoveryBadge } from "@/lib/telephony/call-recovery.mjs";
import { Wifi, WifiOff, RefreshCw } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { VoiceEndpointSelector } from "@/components/contact-center/VoiceEndpointSelector";

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
  return <Popover>
    <PopoverTrigger asChild>
      <button type="button" data-testid="voice-recovery-badge" data-recovery-state={recovery?.state || "idle"}
        aria-label={`${label}. Choose call device`} title={`${label}: ${description} Click to choose call device.`}
        className={`relative grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-full border transition-colors hover:ring-2 hover:ring-current/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green ${colors[tone]}`}>
        <Icon aria-hidden="true" className={`h-4 w-4 ${tone === "warning" ? "motion-safe:animate-pulse" : ""}`} />
        <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-background bg-current" />
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{label}. {description}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" sideOffset={10} collisionPadding={12} aria-label="Phone connection and call devices"
      className="z-[1100] w-80 max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-2xl bg-popover/95 p-4 shadow-xl backdrop-blur-xl">
      <div className="mb-4 flex items-center gap-2 border-b pb-3">
        <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${tone === "warning" ? "motion-safe:animate-pulse" : ""}`} />
        <div><p className="text-sm font-semibold">{label}</p><p className="text-xs text-muted-foreground">{description}</p></div>
      </div>
      <VoiceEndpointSelector />
    </PopoverContent>
  </Popover>;
}
