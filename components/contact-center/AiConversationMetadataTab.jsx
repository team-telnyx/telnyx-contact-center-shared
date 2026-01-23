"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { IconCopy, IconCheck } from "@tabler/icons-react";

function CopyInline({ value }) {
  const [copied, setCopied] = useState(false);
  async function doCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {}
  }
  return (
    <Button
      size="icon"
      variant="ghost"
      className={copied ? "h-7 w-7 text-telnyx-green" : "h-7 w-7"}
      onClick={doCopy}
      title={copied ? "Copied" : "Copy"}
    >
      {copied ? (
        <IconCheck className="size-4 text-telnyx-green" />
      ) : (
        <IconCopy className="size-4" />
      )}
    </Button>
  );
}

export default function AiConversationMetadataTab({ conversation, loading }) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-6 w-48" />
          </div>
        ))}
      </div>
    );
  }

  const md = conversation?.metadata || {};
  const entries = Object.entries(md);
  if (!entries.length) {
    return <div className="text-sm text-muted-foreground">No metadata</div>;
  }
  function humanizeKey(k) {
    try {
      return String(k)
        .replaceAll(/[._-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (m) => m.toUpperCase());
    } catch {
      return String(k);
    }
  }
  return (
    <div className="space-y-2">
      {entries.map(([k, v]) => {
        const isObject = v && typeof v === "object";
        const isBoolean = typeof v === "boolean";
        const valueString = isObject ? JSON.stringify(v) : String(v);
        return (
          <div key={k} className="flex items-center gap-2">
            <div className="text-sm font-medium whitespace-nowrap">
              {humanizeKey(k)}:
            </div>
            <Badge
              variant="secondary"
              className="whitespace-pre-wrap break-all max-w-[70%] rounded-full bg-telnyx-green text-white"
              title={valueString}
            >
              {valueString}
            </Badge>
            {!isBoolean && <CopyInline value={valueString} />}
          </div>
        );
      })}
    </div>
  );
}

