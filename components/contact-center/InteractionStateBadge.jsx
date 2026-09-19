"use client";
import { Badge } from "@/components/ui/badge";

const tones = {
  open: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  initiated: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  in_flow: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  queued: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  offered: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  ringing: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  dialing: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  connected: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  answered: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  bridged: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  held: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  parked: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  wrapup: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  transferred: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  abandoned: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  failed: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
};
export default function InteractionStateBadge({ state, className = "" }) {
  const key = String(state || "unknown").toLowerCase();
  return <Badge variant="outline" data-interaction-state={key} className={`whitespace-nowrap ${tones[key] || "border-border bg-muted/50 text-muted-foreground"} ${className}`}>
    {key.replaceAll("_", " ")}
  </Badge>;
}
