"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { notify } from "@/components/ToastNotify";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function useAssistantEventDestinationConfirmation() {
  const tUi = useUiText();
  const [pending, setPending] = useState(null);
  const resolver = useRef(null);
  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);
  const confirm = useCallback(info => {
    if (resolver.current) return Promise.resolve(false);
    notify({ title: "Conversation WebSocket conflict", description: info.message, variant: "error" });
    return new Promise(resolve => { resolver.current = resolve; setPending(info); });
  }, []);
  const settle = useCallback(accepted => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(null);
    resolve?.(accepted);
  }, []);
  const dialog = (
    <AlertDialog open={Boolean(pending)} onOpenChange={open => { if (!open) settle(false); }}>
      <AlertDialogContent className="sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{tUi("Replace Conversation WebSocket destinations?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {tUi("These assistants already send conversation events to another destination. Overwriting redirects future events to this Contact Center instance and may interrupt live transcription or delegation in the other environment. This setting is shared by all call flows using each assistant.")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-[45vh] space-y-3 overflow-y-auto" aria-label={tUi("Conflicting assistants")}>
          {pending?.conflicts.map(item => (
            <li key={item.assistantId} className="rounded-md border bg-muted/30 p-3 space-y-2">
              <p className="font-medium">{item.assistantName}</p>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-muted-foreground">{tUi("Current destination")}</dt><dd className="break-all font-mono text-xs">{item.currentUrl}</dd></div>
                <div><dt className="text-muted-foreground">{tUi("New destination")}</dt><dd className="break-all font-mono text-xs">{item.targetUrl}</dd></div>
              </dl>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{tUi("Call flows on this instance can share an assistant without changing its destination. Use separate assistants if Dev and Prod need live events at the same time.")}</p>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>{tUi("Cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => settle(true)}>{tUi("Overwrite and save")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { confirm, dialog };
}
