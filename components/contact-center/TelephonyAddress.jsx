"use client";

import { useEffect, useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { isWebRtcAddress } from "@/lib/contact-center/telephony-address";

export function TelephonyAddress({
  value,
  displayName,
  fallback = "-",
  className,
}) {
  const [copied, setCopied] = useState(false);
  const address = String(value || "").trim();
  const label = String(displayName || "").trim();

  useEffect(() => {
    if (!copied) return undefined;
    const timeout = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timeout);
  }, [copied]);

  if (!address) {
    return <span className={className}>{fallback}</span>;
  }

  if (!isWebRtcAddress(address)) {
    return (
      <span className={cn("truncate", className)}>{label || address}</span>
    );
  }

  const copyAddress = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <HoverCard openDelay={150} closeDelay={150}>
      <HoverCardTrigger asChild>
        <span
          className={cn(
            "inline-flex max-w-full cursor-help items-center rounded bg-muted px-1.5 py-0.5 font-medium text-foreground",
            className,
          )}
        >
          {label || "WebRTC"}
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="w-80 space-y-2 p-3"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          SIP URI
        </div>
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all text-xs leading-relaxed">
            {address}
          </code>
          <button
            type="button"
            aria-label="Copy SIP URI"
            title={copied ? "Copied" : "Copy SIP URI"}
            onClick={copyAddress}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {copied ? (
              <IconCheck className="h-4 w-4 text-emerald-500" />
            ) : (
              <IconCopy className="h-4 w-4" />
            )}
          </button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
