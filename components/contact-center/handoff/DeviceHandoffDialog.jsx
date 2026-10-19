"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowRight, Loader2, RotateCw, Shrink, X } from "lucide-react";
import useActiveCallStore from "@/lib/stores/active-call-store";
import useDeviceHandoffStore from "@/lib/stores/device-handoff-store";
import { refreshVoiceEndpoints, subscribeVoiceEndpoints, voiceEndpointRegistration, voiceFetch } from "@/lib/telephony/endpoint-client";
import { decodeVoiceEndpointResponse as decode } from "@/lib/telephony/endpoint-response.mjs";
import { subscribeAgentStream } from "@/lib/telephony/agent-stream.mjs";
import { coalesceRefresh } from "@/lib/telephony/refresh-queue.mjs";
import { browserCallIsOver, browserHandoffCall, callSagaId, isHandoffOutcome, resolveHandoffPhase, runningHandoffId } from "@/lib/telephony/handoff-phase.mjs";
import { deviceName, makeHandoffScene, progressDevices, resolveHandoffDevice } from "@/lib/telephony/handoff-scene.mjs";
import { useUiText } from "@/components/i18n/use-ui-text";
import { HandoffJourney, defer } from "./HandoffJourney";
import { HandoffCallerHeader, HandoffPrimaryButton, HandoffProblemNote, HandoffRingControls, HandoffSecondaryButton, HandoffStepper, HandoffTargetRow } from "./HandoffParts";
import { interactionCaller } from "@/lib/telephony/handoff-caller.mjs";

/**
 * Moving the call between this browser and the user's phones — the iOS app's
 * handoff sheet, on the web: the two devices with the caller travelling
 * between them, what is happening in words, the steps of the move, and one
 * clear action.
 *
 * The states come from resolveHandoffPhase: choose where (several phones),
 * ready ("Move to iPhone"), take over ("Take over here" for a call on a
 * phone), the move in progress (calling, ringing, switching audio, with
 * Cancel while the Contact Center allows it), a move to this browser ringing here
 * (the softphone's round Answer and Reject, Reject keeping the call where it is),
 * success (confirmed, with Done), and failed, cancelled or unanswered with Try
 * again. The Contact Center does the move (start, take_over and cancel on
 * /device-handoff); the dialog reads it every two seconds and at once on the
 * agent stream's notices.
 *
 * The dialog closes only through its own buttons: a click beside it or Escape
 * never does, and while the call moves there is nothing to close until it lands
 * or stops.
 */
export function DeviceHandoffDialog() {
  const interactionId = useDeviceHandoffStore((s) => s.interactionId);
  const sourceCallId = useDeviceHandoffStore((s) => s.sourceCallId);
  const closeHandoff = useDeviceHandoffStore((s) => s.closeHandoff);
  return (
    <DialogPrimitive.Root open={Boolean(interactionId)} onOpenChange={(open) => { if (!open) closeHandoff(); }}>
      <DialogPrimitive.Portal>
        {/* Over the floating softphone (z-1000) and "Calls on" (z-1100). */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-[1150] bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content data-help-id="phone.devices" data-testid="device-handoff-dialog"
          onPointerDownOutside={(event) => event.preventDefault()} onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[1160] flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          style={{ backgroundColor: "var(--modal, var(--background))", color: "var(--modal-foreground, var(--foreground))", borderColor: "var(--modal-border, var(--border))" }}>
          {interactionId && <HandoffBody key={interactionId} interactionId={interactionId} sourceCallId={sourceCallId} onClose={closeHandoff} />}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function HandoffBody({ interactionId, sourceCallId, onClose }) {
  const tUi = useUiText();
  const [value, setValue] = useState(null);
  const [readError, setReadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  /** The command that failed on the wire, sent again (with the same command id) by Retry. */
  const [pending, setPending] = useState(null);
  const [lastCommand, setLastCommand] = useState(null);
  /** A move this dialog saw running or started: only its outcome is shown. */
  const [watched, setWatched] = useState(null);
  const [lastDevices, setLastDevices] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [answering, setAnswering] = useState(false);
  const [endpointState, setEndpointState] = useState(null);
  const commandRef = useRef(null), inFlight = useRef(false), readRef = useRef(null);
  const interactions = useDeviceHandoffStore((s) => s.interactions);
  const requestAnswer = useDeviceHandoffStore((s) => s.requestAnswer);
  const sdkCall = useActiveCallStore((s) => s.call);
  const callStatus = useActiveCallStore((s) => s.status);
  const callDirection = useActiveCallStore((s) => s.direction);
  const answerTime = useActiveCallStore((s) => s.answerTime);
  const recoveredCallHeaders = useActiveCallStore((s) => s.recoveredCallHeaders);
  const path = `/api/contact-center/interactions/${encodeURIComponent(interactionId)}/device-handoff`;

  useEffect(() => subscribeVoiceEndpoints(setEndpointState), []);
  useEffect(() => {
    let stopped = false;
    const read = coalesceRefresh(async () => {
      if (stopped) return;
      try {
        const next = await decode(await voiceFetch(path, { cache: "no-store" }));
        if (!stopped) { setValue(next); setReadError(""); }
      } catch (err) { if (!stopped) setReadError(err.message); }
    });
    readRef.current = read;
    read();
    const timer = setInterval(read, 2000);
    const unsubscribe = subscribeAgentStream((event) => {
      if (event.type === "connected" || event.type === "voice_endpoints_changed" ||
        (event.type === "device_handoff_changed" && (!event.interactionId || event.interactionId === interactionId))) read();
    });
    return () => { stopped = true; clearInterval(timer); unsubscribe(); };
  }, [interactionId, path]);

  const browserCall = sdkCall ? { id: sdkCall.id, status: callStatus, direction: callDirection, sagaId: callSagaId(sdkCall, recoveredCallHeaders) } : null;
  const localCall = browserHandoffCall({ call: browserCall, handoffId: value?.handoff?.id, sourceCallId });
  const phase = resolveHandoffPhase({ value, loading: !value && !readError, readError: value ? null : readError, localCall, watchedHandoffId: watched, tUi });

  const thisEndpointId = voiceEndpointRegistration()?.id || value?.currentEndpointId || null;
  const lookup = (id, label) => resolveHandoffDevice({ id, label, endpoints: endpointState?.endpoints || [], thisEndpointId });
  const owner = useMemo(() => {
    if (!value || (!value.ownerId && !value.ownerLabel)) return null;
    const device = resolveHandoffDevice({ id: value.ownerId, label: value.ownerLabel, endpoints: endpointState?.endpoints || [], thisEndpointId });
    return device.isThisDevice ? null : device;
  }, [value, endpointState, thisEndpointId]);
  const selected = phase.kind === "chooseTarget"
    ? phase.options.find((o) => o.target?.id === selectedId) || phase.options.find((o) => o.target?.reachable) || phase.options[0] : null;
  // The devices of the Contact Center's last move, for an outcome this dialog did not see start.
  const handoffDevices = value?.handoff?.id ? progressDevices({ isTarget: Boolean(value.handoff.isTarget), sourceId: value.handoff.sourceId,
    targetId: value.handoff.targetId, targetLabel: value.handoff.targetLabel }, lookup) : null;
  const scene = makeHandoffScene({ phase, selected, owner, previous: lastDevices || handoffDevices, lookup, tUi });
  const interaction = interactions?.find((i) => String(i.id) === String(interactionId));
  const caller = interactionCaller(interaction, localCall === "active" ? answerTime : null, tUi);

  const running = runningHandoffId(phase);
  const phaseKey = `${phase.kind}:${phase.progress?.step || ""}:${running || ""}`;
  useEffect(() => {
    defer(() => {
      if (running && running !== watched) setWatched(running);
      if (["moving", "incoming", "succeeded"].includes(phase.kind)) setLastDevices(progressDevices(phase.progress, lookup));
      if (phase.kind !== "incoming") setAnswering(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseKey]);

  async function command(action, targetId) {
    if (inFlight.current || !value) return;
    inFlight.current = true; setBusy(true); setProblem("");
    const key = `${interactionId}:${action}:${targetId || ""}`;
    if (commandRef.current?.key !== key) commandRef.current = { key, id: crypto.randomUUID() };
    if (action !== "cancel") setLastCommand({ action, targetId });
    try {
      const body = action === "cancel" ? { action, id: value.handoff?.id }
        : { action, targetId, commandId: commandRef.current.id, expectedOwnerId: value.ownerId, expectedVersion: value.ownerVersion };
      const next = await decode(await voiceFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      setValue(next); setPending(null); commandRef.current = null;
      if (next?.handoff?.id && action !== "cancel") setWatched(next.handoff.id);
      await refreshVoiceEndpoints().catch(() => {});
    } catch (err) {
      setProblem(err.message); setPending({ action, targetId });
      await refreshVoiceEndpoints().catch(() => {});
    } finally { inFlight.current = false; setBusy(false); }
  }

  /** Again after an outcome: the command that failed on the wire, the last one sent from here, or — for a move
   *  that was started elsewhere and watched here — taking the call over, while the Contact Center allows it. */
  const retryCommand = pending || lastCommand || (value?.canTakeOver ? { action: "take_over", targetId: undefined } : null);
  function retry() {
    if (!retryCommand) return;
    setWatched(null);
    command(retryCommand.action, retryCommand.targetId);
  }

  function answer() {
    setAnswering(true);
    requestAnswer();
  }
  // An answer that did not take (the leg still rings a few seconds later) gives the buttons back.
  useEffect(() => {
    if (!answering) return undefined;
    const timer = setTimeout(() => setAnswering(false), 5000);
    return () => clearTimeout(timer);
  }, [answering]);

  // Taking over needs this browser free: a second call here would have nowhere to go.
  const browserFree = browserCallIsOver(browserCall);
  const outcome = isHandoffOutcome(phase);
  // After the first answer, a failed read keeps the last state on screen and says so, with a way to read
  // again: what the dialog shows may be behind the Contact Center.
  const stale = Boolean(value && readError);
  const note = stale ? tUi("Connection lost. Showing the last known state.")
    : outcome ? null : problem || (phase.kind === "moving" ? phase.progress.warning : null);
  // While the call moves the dialog stays: it closes once the move lands or stops (or the Contact Center is out of reach).
  const locked = ["moving", "incoming"].includes(phase.kind) && !stale;

  return <>
    <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-4">
      <span className="size-9" aria-hidden="true" />
      <DialogPrimitive.Title className="text-[15px] font-semibold">{tUi("Move call")}</DialogPrimitive.Title>
      <DialogPrimitive.Close aria-disabled={locked || undefined} title={locked ? tUi("You can close this once the call has moved.") : tUi("Close")}
        onClick={(event) => { if (locked) event.preventDefault(); }}
        className="grid size-9 place-items-center rounded-full border bg-muted/40 text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-muted/40"
        data-testid="handoff-close">
        <X className="size-4" aria-hidden="true" /><span className="sr-only">{tUi("Close")}</span>
      </DialogPrimitive.Close>
    </div>
    <DialogPrimitive.Description className="sr-only">{tUi("Move the call between this computer and your phones.")}</DialogPrimitive.Description>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
      <div className="space-y-5 pt-2">
        <HandoffCallerHeader caller={caller} showsTimer={!outcome} />
        <HandoffJourney scene={scene} caller={caller} />
        <div className="space-y-2 text-center" aria-live="polite">
          <h2 className="text-xl font-bold tracking-tight text-foreground" data-testid="handoff-headline">{scene.headline}</h2>
          {scene.detail && <p className="text-sm text-muted-foreground">{scene.detail}</p>}
        </div>
        {phase.kind === "chooseTarget" && (
          <div className="space-y-2" role="radiogroup" aria-label={tUi("Move the call to")}>
            {phase.options.map((option) => (
              <HandoffTargetRow key={option.key} option={option} chosen={option.key === selected?.key} disabled={busy}
                onSelect={() => setSelectedId(option.target?.id)} />
            ))}
          </div>
        )}
        {["moving", "incoming"].includes(phase.kind) && phase.progress.step !== "returning" && (
          <HandoffStepper step={phase.progress.step} target={scene.target} />
        )}
        {phase.kind === "succeeded" && <HandoffStepper step="switching" target={scene.target} finished />}
        {phase.kind === "loading" && <div className="flex justify-center py-2"><Loader2 className="size-6 text-telnyx-green motion-safe:animate-spin" aria-label={tUi("Loading")} /></div>}
      </div>
    </div>
    <div className="space-y-2.5 border-t border-border/50 px-5 pb-5 pt-3">
      {note && <HandoffProblemNote problem={note} onRetry={stale ? () => readRef.current?.() : pending ? () => command(pending.action, pending.targetId) : null} />}
      <Actions phase={phase} scene={scene} selected={selected} busy={busy} answering={answering} browserFree={browserFree}
        hasValue={Boolean(value)} canRetry={Boolean(retryCommand)} onMove={(id) => command("start", id)} onTakeOver={() => command("take_over")}
        onCancel={() => command("cancel")} onAnswer={answer} onRetry={retry} onRead={() => readRef.current?.()} onClose={onClose} />
    </div>
  </>;
}

function Actions({ phase, scene, selected, busy, answering, browserFree, hasValue, canRetry, onMove, onTakeOver, onCancel, onAnswer, onRetry, onRead, onClose }) {
  const tUi = useUiText();
  switch (phase.kind) {
  case "chooseTarget":
  case "ready": {
    const option = phase.kind === "ready" ? phase.option : selected;
    if (!option) return null;
    return <HandoffPrimaryButton icon={ArrowRight} busy={busy} disabled={busy || !option.target?.reachable}
      onClick={() => onMove(option.target.id)} data-testid={`move-call-${option.kind}`}>{tUi("Move to {value0}", { value0: option.label })}</HandoffPrimaryButton>;
  }
  case "takeOver":
    return <>
      <HandoffPrimaryButton icon={Shrink} busy={busy} disabled={busy || !browserFree} onClick={onTakeOver} data-testid="take-over-call">{tUi("Take over here")}</HandoffPrimaryButton>
      {!browserFree && <p className="text-center text-xs text-muted-foreground">{tUi("Finish your other call before taking over.")}</p>}
    </>;
  case "moving":
    return phase.progress.canCancel ? <HandoffSecondaryButton destructive busy={busy} onClick={onCancel} data-testid="cancel-handoff">{tUi("Cancel move")}</HandoffSecondaryButton> : null;
  case "incoming":
    // Reject turns the move down: the Contact Center hangs up this leg and the call stays on the other device.
    return <HandoffRingControls answering={answering} rejecting={busy} canReject={phase.progress.canCancel}
      rejectHint={tUi("Keep on {value0}", { value0: deviceName(scene.source, tUi) })} onAnswer={onAnswer} onReject={onCancel} />;
  case "succeeded":
    return <HandoffSecondaryButton onClick={onClose}>{tUi("Done")}</HandoffSecondaryButton>;
  case "failed":
  case "cancelled":
  case "timedOut":
    return <>
      {canRetry && <HandoffPrimaryButton icon={RotateCw} busy={busy} disabled={busy} onClick={onRetry} data-testid="handoff-try-again">{tUi("Try again")}</HandoffPrimaryButton>}
      <HandoffSecondaryButton onClick={onClose}>{tUi("Close")}</HandoffSecondaryButton>
    </>;
  case "unavailable":
    return hasValue ? <HandoffSecondaryButton onClick={onClose}>{tUi("Close")}</HandoffSecondaryButton>
      : <HandoffSecondaryButton onClick={onRead}>{tUi("Retry")}</HandoffSecondaryButton>;
  default:
    return null;
  }
}
