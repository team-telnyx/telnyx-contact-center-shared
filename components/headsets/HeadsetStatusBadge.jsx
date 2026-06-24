"use client";

import { useEffect, useMemo, useRef } from "react";
import { Battery, Headphones, PlugZap } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  getHeadsetControlService,
  initHeadsetControlService,
  isHeadsetIntegrationEnabled,
} from "@/lib/headsets/client-headset-service";
import useHeadsetStore from "@/lib/stores/headset-store";

function statusClasses(status) {
  if (status === "connected") return "border-emerald-500/60 text-emerald-400 bg-emerald-500/10";
  if (status === "permission-required" || status === "service-missing") return "border-amber-500/60 text-amber-400 bg-amber-500/10";
  if (status === "error") return "border-red-500/60 text-red-400 bg-red-500/10";
  return "border-border text-muted-foreground bg-background";
}

function deviceLabel(device, status) {
  if (device?.model) return device.model;
  if (device?.vendorLabel) return `${device.vendorLabel} headset`;
  if (status === "disabled") return "Headset integration disabled";
  if (status === "connecting") return "Connecting headset controls";
  if (status === "service-missing") return "Headset service missing";
  return "No headset connected";
}

export function HeadsetStatusBadge() {
  const serviceRef = useRef(null);
  const enabled = useMemo(() => isHeadsetIntegrationEnabled(), []);
  const { device, diagnostics, setEnabled, setStatus, setDevice, recordCommand, recordDiagnostic } = useHeadsetStore();
  const status = useHeadsetStore((state) => state.status);
  const batteryPercent = device?.battery?.levelPercent;

  useEffect(() => {
    setEnabled(enabled);
    if (!enabled) {
      setStatus("disabled");
      return;
    }

    let cancelled = false;
    setStatus("connecting");

    const service = getHeadsetControlService();
    if (!service) {
      setStatus("disabled");
      return;
    }
    serviceRef.current = service;

    const unsubscribeDevice = service.onDeviceChange((nextDevice) => {
      if (!cancelled) setDevice(nextDevice);
    });
    const unsubscribeCommand = service.onCommand((command) => {
      if (!cancelled) recordCommand(command);
    });

    initHeadsetControlService().then(() => {
      if (!cancelled && !service.getDevice()) setStatus("disconnected");
    }).catch((err) => {
      if (!cancelled) {
        setStatus("error");
        recordDiagnostic(err?.message || "Headset initialization failed", "error");
      }
    });

    return () => {
      cancelled = true;
      unsubscribeDevice();
      unsubscribeCommand();
      service.dispose();
      if (serviceRef.current === service) serviceRef.current = null;
    };
  }, [enabled, recordCommand, recordDiagnostic, setDevice, setEnabled, setStatus]);

  const requestJabraPermission = async () => {
    try {
      await serviceRef.current?.requestPermission("jabra");
    } catch (err) {
      recordDiagnostic(err?.message || "Unable to open Jabra WebHID pairing", "error");
    }
  };

  const testCommand = async (command) => {
    try {
      await serviceRef.current?.sendTestCommand(command);
    } catch (err) {
      recordDiagnostic(err?.message || `Headset test command failed: ${command}`, "error");
    }
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={`hidden sm:inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors hover:bg-muted/60 ${statusClasses(status)}`}
          title={deviceLabel(device, status)}
        >
          <Headphones className="h-4 w-4" />
          <span className="max-w-28 truncate">{deviceLabel(device, status)}</span>
          {typeof batteryPercent === "number" && (
            <span className="inline-flex items-center gap-0.5 text-[10px]">
              <Battery className="h-3 w-3" />
              {Math.round(batteryPercent)}%
            </span>
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Headset controls</DialogTitle>
          <DialogDescription>
            Jabra and EPOS/Sennheiser call-control integration for the WebRTC softphone.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 text-sm">
          <div className="rounded-lg border bg-muted/30 p-4">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-lg border bg-background">
                <Headphones className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <div className="font-medium">{deviceLabel(device, status)}</div>
                <div className="text-xs text-muted-foreground">
                  {device?.vendorLabel || "Jabra / EPOS / Sennheiser"} · {device?.transport || "waiting for adapter"}
                </div>
                {device?.serialNumber && (
                  <div className="text-xs text-muted-foreground">SN: {device.serialNumber}</div>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <button className="rounded-md border px-3 py-2 hover:bg-muted" type="button" onClick={requestJabraPermission}>
              <PlugZap className="mr-1 inline h-3.5 w-3.5" />
              Add Jabra headset
            </button>
            <button className="rounded-md border px-3 py-2 hover:bg-muted" type="button" onClick={() => testCommand("ring")}>Test ring</button>
            <button className="rounded-md border px-3 py-2 hover:bg-muted" type="button" onClick={() => testCommand("muteOn")}>Mute LED on</button>
            <button className="rounded-md border px-3 py-2 hover:bg-muted" type="button" onClick={() => testCommand("muteOff")}>Mute LED off</button>
            <button className="rounded-md border px-3 py-2 hover:bg-muted" type="button" onClick={() => testCommand("holdOn")}>Hold on</button>
            <button className="rounded-md border px-3 py-2 hover:bg-muted" type="button" onClick={() => testCommand("reset")}>Reset</button>
          </div>

          <div className="rounded-lg border p-3">
            <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Diagnostics</div>
            {diagnostics.length === 0 ? (
              <div className="text-xs text-muted-foreground">No headset events yet.</div>
            ) : (
              <div className="max-h-40 space-y-1 overflow-auto text-xs">
                {diagnostics.map((entry, index) => (
                  <div key={`${entry.at}-${index}`} className="rounded bg-muted/40 px-2 py-1">
                    <span className="text-muted-foreground">{entry.at}</span>{" "}
                    {entry.command ? `${entry.command.vendor || "headset"}:${entry.command.type}` : entry.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
