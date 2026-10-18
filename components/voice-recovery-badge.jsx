"use client";
import { useUiText } from "@/components/i18n/use-ui-text";

import { useEffect, useRef, useState } from "react";
import { VoiceQualityDialog } from "@/components/contact-center/VoiceQualityPanel";
import { useTelnyx } from "@/components/telephony-provider";
import { phoneIndicator } from "@/lib/telephony/phone-indicator.mjs";
import { subscribeVoiceEndpoints } from "@/lib/telephony/endpoint-client";
import { Wifi, WifiOff, RefreshCw, Settings } from "lucide-react";
import Link from "next/link";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { VoiceEndpointSelector } from "@/components/contact-center/VoiceEndpointSelector";

export function VoiceRecoveryBadge({ promptForDevice = false }) {
  const tUi = useUiText();
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const triggerRef = useRef(null);
  const prompted = useRef(false);
  const [endpoints, setEndpoints] = useState(null);
  useEffect(() => subscribeVoiceEndpoints(setEndpoints), []);
  const { status, recovery, quality } = useTelnyx();
  const deviceSelectionRequired = Boolean(endpoints && !endpoints.endpointId);
  useEffect(() => {
    if (promptForDevice && deviceSelectionRequired && status === "connected" && !prompted.current) {
      prompted.current = true;
      setDevicesOpen(true);
    }
  }, [promptForDevice, deviceSelectionRequired, status]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(timer);
  }, []);
  const { label, tone, description, color } = phoneIndicator({status, recovery, quality, deviceSelectionRequired, now}, tUi);
  const Icon =
    tone === "warning" ? RefreshCw : tone === "ready" ? Wifi : WifiOff;
  const colors = {
    green: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
    yellow: "border-yellow-500/40 bg-yellow-500/10 text-yellow-600 dark:text-yellow-300",
    orange: "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-300",
    red: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300",
  };
  return (
    <>
      <Popover open={devicesOpen} onOpenChange={setDevicesOpen}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            data-testid="voice-recovery-badge"
            data-quality-color={color}
            data-recovery-state={recovery?.state || "idle"}
            aria-label={tUi("{value0}. Choose call device", { value0: label })}
            title={tUi("{value0}: {value1} Click to choose call device.", { value0: label, value1: description })}
            className={`relative flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors hover:ring-2 hover:ring-current/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green ${deviceSelectionRequired ? "gap-1.5 px-2" : "w-7"} ${colors[color]}`}
          >
            <Icon
              aria-hidden="true"
              className={`h-4 w-4 ${tone === "warning" ? "motion-safe:animate-pulse" : ""}`}
            />
            {deviceSelectionRequired && <span className="text-xs font-medium">{tUi("Choose a device")}</span>}
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-background bg-current"
            />
            <span
              className="sr-only"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {label}. {description}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          onCloseAutoFocus={(event) => {
            // The dialog takes focus when leaving the device picker for diagnostics.
            if (qualityOpen) event.preventDefault();
          }}
          align="end"
          sideOffset={10}
          collisionPadding={12}
          aria-label={tUi("Phone connection and call devices")}
          className="z-[1100] w-80 max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-2xl bg-popover/95 p-4 shadow-xl backdrop-blur-xl"
        >
          <div className="mb-4 flex items-center gap-2 border-b pb-3">
            <Icon
              aria-hidden="true"
              className={`h-4 w-4 shrink-0 ${tone === "warning" ? "motion-safe:animate-pulse" : ""}`}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{tUi("WebRTC phone")}</p>
              <p className="text-xs font-medium">{label}</p>
            </div>
            {/* The gear in the panel's corner: Profile › Devices, where registrations are forgotten. */}
            <Link href="/profile?tab=devices" aria-label={tUi("Manage call devices")} title={tUi("Manage call devices")}
              onClick={() => setDevicesOpen(false)} data-testid="manage-devices"
              className="shrink-0 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green">
              <Settings className="h-5 w-5" aria-hidden="true" />
            </Link>
          </div>
          <VoiceEndpointSelector
            onOpenQuality={() => {
              setDevicesOpen(false);
              setQualityOpen(true);
            }}
          />
        </PopoverContent>
      </Popover>
      <VoiceQualityDialog
        open={qualityOpen}
        onOpenChange={setQualityOpen}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      />
    </>
  );
}
