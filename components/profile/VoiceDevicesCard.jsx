"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Monitor, Smartphone, Tablet, Trash2 } from "lucide-react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { notify } from "@/components/ToastNotify";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { refreshVoiceEndpoints, subscribeVoiceEndpoints } from "@/lib/telephony/endpoint-client";
import { cn } from "@/lib/utils";

const path = "/api/contact-center/agent/voice-endpoints/devices";

/**
 * The agent's call devices. The computer comes first and is always there: every browser and
 * tab signed in for calls is that one computer, so it has no "Forget". Each phone or tablet is
 * one entry however often its app signed in, with "Forget" for a handset no longer in use: it
 * stops ringing and receiving notifications, and its app is signed out.
 */
export default function VoiceDevicesCard() {
  const tUi = useUiText();
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [forgetting, setForgetting] = useState(null);
  const [busy, setBusy] = useState(false);
  // Follows what the phone panel sees, so a tab connecting or a device changing state shows here too.
  const [revision, setRevision] = useState("");
  useEffect(() => subscribeVoiceEndpoints(value => setRevision(value
    ? `${value.endpointId}|${value.endpoints.map(device => `${device.id}:${device.availability}`).join(",")}` : "")), []);

  const load = useCallback(() => fetch(path, { cache: "no-store" }).then(async response => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || tUi("Could not load your devices."));
    return body;
  }), [tUi]);
  useEffect(() => {
    let active = true;
    void load().then(body => { if (active) { setState(body); setError(""); } }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [load, revision]);

  async function forget(device) {
    setBusy(true);
    try {
      const response = await fetch(path, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: device.deviceId }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || tUi("Could not forget this device."));
      setState(body);
      await refreshVoiceEndpoints().catch(() => {});
      notify({ title: tUi("Device forgotten"), description: tUi("{value0} no longer rings or receives notifications. Sign in on it again to use it.", { value0: device.label }) });
    } catch (err) {
      notify({ title: tUi("Could not forget this device."), description: err.message, variant: "error" });
    } finally { setBusy(false); setForgetting(null); }
  }

  function status(device) {
    if (device.kind === "web") return device.reachable ? tUi("Connected") : tUi("Not connected");
    if (device.pushOnly) return tUi("Notifications only");
    if (device.stale) return tUi("Not seen for a day or more");
    return device.availability === "connected" ? tUi("Connected") : device.availability === "standby" ? tUi("Standby via push") : tUi("Unavailable");
  }

  const devices = state?.devices || [];
  return <Card data-help-id="profile.devices" className="w-full" data-testid="voice-devices-card" id="devices">
    <CardHeader>
      <CardTitle className="flex items-center gap-2"><Smartphone className="size-6 text-brand-primary" aria-hidden="true" />{tUi(" Call devices")}</CardTitle>
      <p className="text-sm text-muted-foreground">{tUi("Your computer takes calls in the browser and is always listed. Phones and tablets you sign in on appear here too; forget one you no longer use so it stops ringing and receiving notifications.")}</p>
    </CardHeader>
    <CardContent className="space-y-2">
      {!state && !error ? <div className="space-y-2" aria-label={tUi("Loading devices")}><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-16 rounded-xl" /></div>
        : error ? <p role="alert" className="text-sm text-destructive">{error}</p>
        : <ul className="divide-y rounded-xl border">
          {devices.map(device => {
            const Icon = device.kind === "web" ? Monitor : device.formFactor === "tablet" ? Tablet : Smartphone;
            const tone = device.reachable ? "text-emerald-700 dark:text-telnyx-green" : "text-muted-foreground";
            const computer = device.kind === "web";
            return <li key={device.deviceId || device.id} className="flex items-center gap-3 p-3" data-device-kind={device.kind} data-device-id={device.deviceId || device.id}>
              <Icon className={cn("size-7 shrink-0", tone)} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold">{computer ? tUi("Computer") : device.label}</span>
                  {device.selected && <Badge variant="outline">{tUi("Takes calls")}</Badge>}
                </div>
                <p className={cn("text-xs", tone)}>{status(device)}{device.lastSeenAt ? ` · ${tUi("Last seen {value0}", { value0: new Date(device.lastSeenAt).toLocaleString() })}` : ""}</p>
                {computer && <p className="text-xs text-muted-foreground">{tUi("Every browser and tab you sign in on for calls. It is your primary call device and cannot be forgotten.")}</p>}
              </div>
              {device.removable && <Button type="button" variant="ghost" size="sm" className="shrink-0" disabled={busy}
                aria-label={tUi("Forget {value0}", { value0: device.label })} onClick={() => setForgetting(device)}>
                <Trash2 className="size-4" aria-hidden="true" />{tUi(" Forget")}
              </Button>}
            </li>;
          })}
        </ul>}
    </CardContent>
    <AlertDialog open={Boolean(forgetting)} onOpenChange={open => { if (!open && !busy) setForgetting(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tUi("Forget {value0}?", { value0: forgetting?.label || "" })}</AlertDialogTitle>
          <AlertDialogDescription>
            {forgetting?.selected
              ? tUi("This device takes your calls now. Once forgotten it stops ringing and receiving notifications and its app is signed out; choose another device in the phone panel.")
              : tUi("It stops ringing and receiving notifications, and its app is signed out. To use it again, sign in on it.")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{tUi("Keep")}</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); if (forgetting) void forget(forgetting); }}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}{tUi("Forget")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>;
}
