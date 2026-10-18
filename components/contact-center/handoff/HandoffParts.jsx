"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Circle, Loader2, Phone, PhoneOff } from "lucide-react";
import { HANDOFF_STEPS } from "@/lib/telephony/handoff-phase.mjs";
import { handoffStepTitles } from "@/lib/telephony/handoff-scene.mjs";
import { DEVICE_ICONS, deviceIconKey } from "./HandoffJourney";
import { cn } from "@/lib/utils";
import { useUiText } from "@/components/i18n/use-ui-text";

/** Who is on the call being moved, above the journey: name, number and the call's time. */
export function HandoffCallerHeader({ caller, showsTimer = true }) {
  const tUi = useUiText();
  const elapsed = useElapsed(showsTimer ? caller.startedAt : null);
  return (
    <div className="flex flex-col items-center gap-1 text-center" data-testid="handoff-caller">
      <p className="w-full truncate text-lg font-semibold text-foreground">{caller.name}</p>
      <div className="flex items-center gap-2">
        {caller.number && <span className="font-mono text-sm text-muted-foreground">{caller.number}</span>}
        {elapsed && (
          <span className="inline-flex items-center gap-1 rounded-full bg-telnyx-green/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-emerald-700 dark:text-telnyx-green"
            aria-label={tUi("Call time {value0}", { value0: elapsed })}>
            <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />{elapsed}
          </span>
        )}
      </div>
    </div>
  );
}

/** One device to move the call to, when there are several: chosen with a click, then moved with the main button. */
export function HandoffTargetRow({ option, chosen, disabled, onSelect }) {
  const tUi = useUiText();
  const Icon = DEVICE_ICONS[deviceIconKey(option.kind)];
  const reachable = Boolean(option.target?.reachable);
  return (
    <button type="button" onClick={onSelect} disabled={disabled || !reachable} aria-pressed={chosen}
      data-testid={`handoff-target-${option.kind}`}
      className={cn("flex w-full items-center gap-3 rounded-2xl border-[1.5px] bg-muted/30 p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green disabled:cursor-default",
        chosen ? "border-telnyx-green/90" : "border-border enabled:hover:border-telnyx-green/50", !reachable && "opacity-60")}>
      <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", chosen ? "bg-telnyx-green/15 text-emerald-700 dark:text-telnyx-green" : "bg-muted text-foreground")}>
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{option.label}</span>
        <span className="block text-xs text-muted-foreground">
          {reachable ? tUi("Ready to take the call") : tUi("Open the NovumCX app on {value0} to move the call there.", { value0: option.label })}
        </span>
      </span>
      {chosen ? <CheckCircle2 className="size-5 shrink-0 text-telnyx-green" aria-hidden="true" />
        : <Circle className="size-5 shrink-0 text-border" aria-hidden="true" />}
    </button>
  );
}

/** The three steps of a move (calling the target, the target ringing, switching the audio): done, current or next. */
export function HandoffStepper({ step, target, finished = false }) {
  const tUi = useUiText();
  const current = HANDOFF_STEPS.indexOf(step);
  const steps = handoffStepTitles(target, tUi);
  return (
    <ol className="grid grid-cols-3 rounded-2xl border bg-muted/20 px-2 py-3" data-testid="handoff-stepper">
      {steps.map(([key, title], index) => {
        const done = finished || index < current;
        const active = !finished && index === current;
        return (
          <li key={key} className="relative flex flex-col items-center gap-2 text-center"
            aria-current={active ? "step" : undefined}>
            {index < steps.length - 1 && (
              <span aria-hidden="true" className={cn("absolute left-1/2 top-[13px] h-0.5 w-full", done ? "bg-telnyx-green" : "bg-border")} />
            )}
            <span className={cn("relative grid size-[26px] place-items-center rounded-full border-[1.5px]",
              done ? "border-telnyx-green bg-telnyx-green text-black" : active ? "border-telnyx-green bg-background" : "border-border bg-background")}>
              {done ? <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
                : active ? <Loader2 className="size-3.5 text-telnyx-green motion-safe:animate-spin" aria-hidden="true" /> : null}
            </span>
            <span className={cn("px-1 text-xs leading-tight", done || active ? "text-foreground" : "text-muted-foreground", active && "font-semibold")}>
              {title}<span className="sr-only">{done ? tUi(" (done)") : active ? tUi(" (in progress)") : tUi(" (next)")}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** A command that failed (with Retry when it can be sent again) or a step the Contact Center is retrying. */
export function HandoffProblemNote({ problem, onRetry }) {
  const tUi = useUiText();
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-2xl border border-destructive/20 bg-destructive/5 p-3" data-testid="handoff-problem">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-xs text-foreground">{problem}</p>
        {onRetry && <button type="button" onClick={onRetry} className="text-xs font-semibold text-emerald-700 hover:underline dark:text-telnyx-green">{tUi("Retry")}</button>}
      </div>
    </div>
  );
}

/** The handoff's main action: a full-width capsule of Telnyx green. */
export function HandoffPrimaryButton({ icon: Icon, busy = false, children, className, ...props }) {
  return (
    <button type="button" {...props}
      className={cn("flex h-12 w-full items-center justify-center gap-2 rounded-full bg-telnyx-green px-4 text-[15px] font-semibold text-black shadow-sm transition-[filter,opacity] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50", className)}>
      {busy ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : Icon && <Icon className="size-4" strokeWidth={2.5} aria-hidden="true" />}
      {children}
    </button>
  );
}

/** A second action under the main one: plain, or the destructive colour for cancelling a move. */
export function HandoffSecondaryButton({ destructive = false, busy = false, children, className, ...props }) {
  return (
    <button type="button" {...props} disabled={busy || props.disabled}
      className={cn("flex h-11 w-full items-center justify-center gap-2 rounded-full border bg-muted/40 px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green disabled:cursor-not-allowed disabled:opacity-50",
        destructive ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-muted", className)}>
      {busy && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

/**
 * The target leg ringing in this browser: the softphone's own round buttons, Reject on the left and
 * Answer on the right, so the call is taken (or the move turned down) without leaving the dialog.
 */
export function HandoffRingControls({ answering = false, rejecting = false, canReject = true, rejectHint, onAnswer, onReject }) {
  const tUi = useUiText();
  return (
    <div className="flex items-start justify-center gap-14" data-testid="handoff-ring-controls">
      <RoundCallButton tone="reject" icon={PhoneOff} label={tUi("Reject")} hint={rejectHint} busy={rejecting}
        disabled={!canReject || rejecting || answering} onClick={onReject} data-testid="handoff-reject" />
      <RoundCallButton tone="answer" icon={Phone} label={tUi("Answer")} hint={tUi("Answer here")} busy={answering}
        disabled={answering || rejecting} onClick={onAnswer} data-testid="answer-handoff-call" />
    </div>
  );
}

function RoundCallButton({ tone, icon: Icon, label, hint, busy, ...props }) {
  return (
    <button type="button" {...props} title={hint}
      className="group flex flex-col items-center gap-2 rounded-2xl focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50">
      <span className={cn("grid size-14 place-items-center rounded-full text-white shadow-md transition-[filter] group-enabled:group-hover:brightness-110 group-focus-visible:ring-2 group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background",
        tone === "answer" ? "bg-emerald-600 group-focus-visible:ring-emerald-500" : "bg-red-600 group-focus-visible:ring-red-500")}>
        {busy ? <Loader2 className="size-6 motion-safe:animate-spin" aria-hidden="true" /> : <Icon className="size-6" aria-hidden="true" />}
      </span>
      <span className="text-xs font-semibold text-foreground">{label}</span>
    </button>
  );
}

/** "4:05" since `startedAt`, every second; null without a start. */
function useElapsed(startedAt) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return null;
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return null;
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
