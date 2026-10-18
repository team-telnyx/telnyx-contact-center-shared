"use client";

import { ArrowLeftRight, Monitor, Shrink, Smartphone } from "lucide-react";
import useActiveCallStore from "@/lib/stores/active-call-store";
import useDeviceHandoffStore from "@/lib/stores/device-handoff-store";
import { handoffEntry } from "@/lib/telephony/handoff-caller.mjs";
import { cn } from "@/lib/utils";
import { useUiText } from "@/components/i18n/use-ui-text";

/**
 * What the softphone offers for moving calls (handoffEntry), and the action
 * that opens the "Move call" dialog for it: from this browser's call, with
 * that call as the move's source; for a call elsewhere, to take it over.
 */
export function useHandoffEntry(callInteractionId = null) {
  const tUi = useUiText();
  const interactions = useDeviceHandoffStore((s) => s.interactions);
  const takeOvers = useDeviceHandoffStore((s) => s.takeOvers);
  const openHandoff = useDeviceHandoffStore((s) => s.openHandoff);
  const call = useActiveCallStore((s) => s.call);
  const status = useActiveCallStore((s) => s.status);
  const entry = handoffEntry({ interactions, takeOvers, callStatus: call ? status : null, callInteractionId, tUi });
  const open = () => {
    if (!entry) return;
    openHandoff(entry.interactionId, { sourceCallId: entry.kind === "move" ? call?.id ?? null : null });
  };
  return { entry, open };
}

/** The route of a move in miniature: this computer, a dotted path, a phone. */
function Route({ className }) {
  return (
    <span aria-hidden="true" className={cn("flex items-center gap-1", className)}>
      <Monitor className="size-3.5" />
      <span className="w-5 border-t-2 border-dotted border-current opacity-60" />
      <Smartphone className="size-3.5" />
    </span>
  );
}

/**
 * The softphone card's entry, under its call controls: "Move call" during a
 * call here; "Call with … on iPhone · Take over" for a call on a phone.
 */
export function HandoffEntryBar({ callInteractionId }) {
  const tUi = useUiText();
  const { entry, open } = useHandoffEntry(callInteractionId);
  if (!entry) return null;
  if (entry.kind === "move") {
    return (
      <button type="button" onClick={open} data-testid="softphone-move-call"
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-telnyx-green/40 bg-telnyx-green/10 px-3 py-2 text-[11px] font-semibold text-telnyx-green transition-colors hover:bg-telnyx-green/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green">
        <span className="flex items-center gap-1.5"><ArrowLeftRight className="size-3.5" aria-hidden="true" />{tUi("Move call")}</span>
        <Route />
      </button>
    );
  }
  return (
    <div className="flex w-full items-center gap-2 rounded-xl border border-telnyx-green/40 bg-telnyx-green/10 px-3 py-2" data-testid="softphone-call-elsewhere">
      <Smartphone className="size-4 shrink-0 text-telnyx-green" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-[11px] leading-tight text-zinc-200">
        <span className="block truncate font-semibold text-white">{entry.caller.name}</span>
        <span className="block truncate">{tUi("on {value0}", { value0: entry.ownerLabel })}</span>
      </span>
      <button type="button" onClick={open} data-testid="softphone-take-over"
        className="flex shrink-0 items-center gap-1 rounded-full bg-telnyx-green px-2.5 py-1 text-[11px] font-semibold text-black hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-900">
        <Shrink className="size-3" strokeWidth={2.5} aria-hidden="true" />{tUi("Take over")}
      </button>
    </div>
  );
}

/** The mini phone's entry during a call here: a round button beside Transfer. */
export function HandoffMoveButton({ callInteractionId, className }) {
  const tUi = useUiText();
  const { entry, open } = useHandoffEntry(callInteractionId);
  if (entry?.kind !== "move") return null;
  return (
    <button type="button" onClick={open} title={tUi("Move call to another device")} aria-label={tUi("Move call to another device")}
      data-testid="mini-move-call"
      className={cn("h-7 w-7 rounded-full grid place-items-center bg-zinc-700/70 text-white hover:bg-zinc-700", className)}>
      <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

/** "Calls on"'s entry: the call to move, or the call to take over, in a card that opens the dialog. */
export function HandoffEntryCard({ callInteractionId, onOpen }) {
  const tUi = useUiText();
  const { entry, open } = useHandoffEntry(callInteractionId);
  if (!entry) return null;
  const moving = entry.kind === "move";
  return (
    <div className="space-y-2 rounded-2xl border bg-muted/20 p-3" data-testid="device-handoff">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold"><ArrowLeftRight className="size-4" aria-hidden="true" />
          {moving ? tUi("Move current call") : tUi("Call on another device")}</span>
        <Route className="text-muted-foreground" />
      </div>
      <p className="text-xs text-muted-foreground">
        {moving ? tUi("Send the call to your phone without hanging up.") : tUi("{value0} is on {value1}.", { value0: entry.caller.name, value1: entry.ownerLabel })}
      </p>
      <button type="button" onClick={() => { onOpen?.(); open(); }}
        className="flex h-9 w-full items-center justify-center gap-1.5 rounded-full bg-telnyx-green text-xs font-semibold text-black hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green focus-visible:ring-offset-2 focus-visible:ring-offset-background">
        {moving ? <><ArrowLeftRight className="size-3.5" aria-hidden="true" />{tUi("Move call…")}</> : <><Shrink className="size-3.5" aria-hidden="true" />{tUi("Take over here…")}</>}
      </button>
    </div>
  );
}
