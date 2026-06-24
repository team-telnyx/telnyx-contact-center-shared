"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  Battery,
  Bluetooth,
  CheckCircle2,
  CircleAlert,
  Headphones,
  PlugZap,
  RadioTower,
  Settings2,
  Wifi,
  Zap,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  getHeadsetControlService,
  initHeadsetControlService,
  isHeadsetIntegrationEnabled,
} from "@/lib/headsets/client-headset-service";
import {
  findHeadsetCatalogEntry,
  getDeviceCatalogForVendor,
} from "@/lib/headsets/headset-device-catalog";
import useHeadsetStore from "@/lib/stores/headset-store";

function statusClasses(status) {
  if (status === "connected") return "border-emerald-500/60 text-emerald-300 bg-emerald-500/15";
  if (status === "service-connected") return "border-sky-500/60 text-sky-300 bg-sky-500/15";
  if (status === "permission-required" || status === "service-missing" || status === "disconnected") {
    return "border-amber-500/60 text-amber-300 bg-amber-500/15";
  }
  if (status === "error") return "border-red-500/60 text-red-300 bg-red-500/15";
  return "border-border text-muted-foreground bg-zinc-700/70";
}

function connectionCopy(status) {
  if (status === "connected") return "Headset connected";
  if (status === "service-connected") return "EPOS Connect ready — waiting for headset event";
  if (status === "connecting") return "Connecting to headset services";
  if (status === "service-missing") return "EPOS Connect service is not reachable";
  if (status === "permission-required") return "Browser permission required";
  if (status === "disabled") return "Headset integration disabled";
  if (status === "error") return "Headset integration error";
  return "No headset connected";
}

function deviceLabel(device, status) {
  if (device?.model) return device.model;
  if (device?.vendorLabel && status === "service-connected") return `${device.vendorLabel} service ready`;
  if (device?.vendorLabel) return `${device.vendorLabel} headset`;
  return connectionCopy(status);
}

function DeviceArtworkCard({ entry, active }) {
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border p-4 transition-all ${
        active ? "border-emerald-400/70 bg-emerald-500/10 shadow-[0_0_35px_rgba(16,185,129,0.12)]" : "border-border bg-background/70"
      }`}
    >
      <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/10 to-transparent" />
      <div className="relative grid h-40 place-items-center rounded-xl border bg-white p-4">
        <img src={entry.image} alt={entry.name} className="max-h-32 max-w-full object-contain" />
      </div>
      <div className="mt-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">{entry.name}</div>
          <div className="mt-1 text-xs text-muted-foreground">{entry.status}</div>
        </div>
        {active ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {entry.capabilities.map((capability) => (
          <span key={capability} className="rounded-full border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
            {capability}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HeadsetStatusBadge() {
  const serviceRef = useRef(null);
  const enabled = useMemo(() => isHeadsetIntegrationEnabled(), []);
  const { device, diagnostics, setEnabled, setStatus, setDevice, recordCommand, recordDiagnostic } = useHeadsetStore();
  const status = useHeadsetStore((state) => state.status);
  const batteryPercent = device?.battery?.levelPercent;
  const activeCatalogEntry = findHeadsetCatalogEntry(device);
  const eposCatalog = getDeviceCatalogForVendor("epos");

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
      if (!cancelled) {
        setDevice(nextDevice);
        const state = nextDevice?.connectionState || "disconnected";
        const label = nextDevice?.model || nextDevice?.productName || nextDevice?.vendorLabel || "headset";
        recordDiagnostic(`${label}: ${state}`, state === "service-missing" || state === "disconnected" ? "warn" : "info");
      }
    });
    const unsubscribeCommand = service.onCommand((command) => {
      if (!cancelled) recordCommand(command);
    });
    const unsubscribeDiagnostic = service.onDiagnostic?.((diagnostic) => {
      if (!cancelled) recordDiagnostic(diagnostic.message || String(diagnostic), diagnostic.level || "info");
    }) || (() => {});

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
      unsubscribeDiagnostic();
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
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className={`relative h-7 w-7 rounded-full border grid place-items-center transition-colors hover:bg-muted/70 ${statusClasses(status)}`}
          title={deviceLabel(device, status)}
          aria-label="Headset controls"
        >
          <Headphones className="h-4 w-4" />
          {status === "connected" || status === "service-connected" ? (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-background bg-emerald-400" />
          ) : status === "error" || status === "service-missing" || status === "disconnected" ? (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-background bg-amber-400" />
          ) : null}
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-hidden p-0 sm:max-w-3xl bg-background">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b bg-gradient-to-br from-zinc-950 via-zinc-900 to-emerald-950/50 p-6 text-white">
            <div className="flex items-center gap-3">
              <div className={`grid h-11 w-11 place-items-center rounded-2xl border ${statusClasses(status)}`}>
                <Headphones className="h-5 w-5" />
              </div>
              <div>
                <SheetTitle className="text-white">Headset control center</SheetTitle>
                <SheetDescription className="text-zinc-300">
                  EPOS/Sennheiser and Jabra call-control bridge for the WebRTC softphone.
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className="rounded-3xl border bg-gradient-to-br from-background via-background to-emerald-950/20 p-5 shadow-sm">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
                <div className="grid h-32 w-full place-items-center rounded-2xl border bg-white p-4 lg:w-44">
                  {activeCatalogEntry ? (
                    <img src={activeCatalogEntry.image} alt={activeCatalogEntry.name} className="max-h-24 max-w-full object-contain" />
                  ) : (
                    <Headphones className="h-16 w-16 text-zinc-300" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold uppercase tracking-wide text-emerald-400">Current device</div>
                  <div className="mt-1 text-2xl font-semibold text-foreground">{deviceLabel(device, status)}</div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2.5 py-1">
                      <RadioTower className="h-3.5 w-3.5" /> {connectionCopy(status)}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2.5 py-1">
                      <Bluetooth className="h-3.5 w-3.5" /> {device?.transport || "EPOS Connect / WebHID"}
                    </span>
                    {typeof batteryPercent === "number" && (
                      <span className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2.5 py-1">
                        <Battery className="h-3.5 w-3.5" /> {Math.round(batteryPercent)}% battery
                      </span>
                    )}
                  </div>
                  {status === "disabled" ? (
                    <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
                      Integration is disabled by configuration. It should be enabled for headset testing unless NEXT_PUBLIC_HEADSET_INTEGRATION_ENABLED=false is set.
                    </div>
                  ) : status === "disconnected" || status === "service-missing" ? (
                    <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
                      EPOS Connect should be running and the browser must be able to reach wss://127.0.0.1:41088. If the service is reachable, this panel changes to service-ready and then connected when EPOS sends HeadsetConnected / ActiveDeviceChanged.
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              {eposCatalog.map((entry) => (
                <DeviceArtworkCard key={entry.id} entry={entry} active={activeCatalogEntry?.id === entry.id || (!activeCatalogEntry && status === "service-connected" && entry.role === "dongle")} />
              ))}
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1.2fr]">
              <div className="rounded-2xl border bg-card p-4">
                <div className="mb-3 flex items-center gap-2 font-semibold">
                  <Settings2 className="h-4 w-4 text-emerald-400" /> Test controls
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <button className="rounded-md border px-3 py-2 hover:bg-muted" type="button" onClick={requestJabraPermission}>
                    <PlugZap className="mr-1 inline h-3.5 w-3.5" /> Add Jabra
                  </button>
                  <button className="rounded-md border px-3 py-2 hover:bg-muted" type="button" onClick={() => testCommand("ring")}>Test ring</button>
                  <button className="rounded-md border px-3 py-2 hover:bg-muted" type="button" onClick={() => testCommand("muteOn")}>Mute LED on</button>
                  <button className="rounded-md border px-3 py-2 hover:bg-muted" type="button" onClick={() => testCommand("muteOff")}>Mute LED off</button>
                  <button className="rounded-md border px-3 py-2 hover:bg-muted" type="button" onClick={() => testCommand("holdOn")}>Hold on</button>
                  <button className="rounded-md border px-3 py-2 hover:bg-muted" type="button" onClick={() => testCommand("reset")}>Reset</button>
                </div>
              </div>

              <div className="rounded-2xl border bg-card p-4">
                <div className="mb-3 flex items-center gap-2 font-semibold">
                  <Zap className="h-4 w-4 text-emerald-400" /> Diagnostics
                </div>
                {diagnostics.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground">
                    <Wifi className="h-4 w-4" /> Waiting for headset service events.
                  </div>
                ) : (
                  <div className="max-h-56 space-y-1 overflow-auto text-xs">
                    {diagnostics.map((entry, index) => (
                      <div key={`${entry.at}-${index}`} className="rounded-lg bg-muted/40 px-2 py-1.5">
                        <span className="text-muted-foreground">{entry.at}</span>{" "}
                        {entry.command ? `${entry.command.vendor || "headset"}:${entry.command.type}` : entry.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6 rounded-2xl border bg-card p-4 text-xs text-muted-foreground">
              <div className="mb-2 flex items-center gap-2 font-semibold text-foreground">
                <CircleAlert className="h-4 w-4 text-amber-400" /> Expected EPOS behavior
              </div>
              After EPOS Connect is running, the app opens the local EPOS websocket, registers Telnyx Contact Center as a softphone, asks for the active device, and should show the BTD 800 / MB Pro 2 as connected. During calls it should sync ring, answer, hangup, mute and hold states both ways.
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
