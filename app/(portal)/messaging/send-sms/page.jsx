"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { CheckIcon } from "lucide-react";
import CodeBlock from "@/components/ui/code-block";
import { useSearchParams } from "next/navigation";
import { IconSend } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

function computeEncodingStats(text) {
  // Simple encoding detection
  const isGsm7 = /^[\x00-\x7F\u00A0-\u00FF]*$/.test(text || "");
  const length = [...(text || "")].length;
  const perPart = isGsm7 ? 160 : 70;
  const concatPerPart = isGsm7 ? 153 : 67;
  const parts = length <= perPart ? 1 : Math.ceil(length / concatPerPart);
  const currentPartLimit = parts === 1 ? perPart : concatPerPart;
  const remaining = length <= perPart 
    ? perPart - length 
    : concatPerPart - (length % concatPerPart || concatPerPart);
  
  return {
    encoding: isGsm7 ? "GSM-7" : "UCS-2",
    parts,
    perPart: currentPartLimit,
    remaining: Math.max(0, remaining),
  };
}

function MessagingSendSmsViewInner() {
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [lastTelnyxId, setLastTelnyxId] = useState("");
  const [statusData, setStatusData] = useState({ status: null, webhooks: [] });
  const [openPayload, setOpenPayload] = useState(null);
  const [lastSendResponse, setLastSendResponse] = useState(null);
  const stats = computeEncodingStats(body);
  const textareaRef = useRef(null);
  const searchParams = useSearchParams();

  useEffect(() => {
    // Prefill from URL param if provided
    try {
      const toQuery = searchParams?.get("to");
      if (toQuery && !to) setTo(toQuery);
    } catch (_) {}
  }, [searchParams]);

  // Listen for prefill from history reply action
  useEffect(() => {
    function onPrefill(e) {
      const toNum = e?.detail?.to || "";
      if (toNum) setTo(toNum);
    }
    window.addEventListener("messaging:prefillSendTo", onPrefill);
    return () =>
      window.removeEventListener("messaging:prefillSendTo", onPrefill);
  }, []);

  async function onSend() {
    const toE164 = to.trim();
    if (!/^\+?[1-9]\d{6,15}$/.test(toE164)) {
      toast.error("Invalid destination number");
      return;
    }
    if (!body.trim()) {
      toast.error("Message body is empty");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/messaging/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: toE164, body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to send");
      toast.success("Message sent", {
        description: `ID: ${data.data?.id || data.telnyxMessageId || "n/a"}`,
      });
      setBody("");
      if (data.data?.id) {
        setLastTelnyxId(data.data.id);
      }
      setLastSendResponse(data);
    } catch (err) {
      toast.error("Send failed", {
        description: String(err.message || err),
      });
    } finally {
      setSending(false);
    }
  }

  const statusSteps = [
    { key: "QUEUED", label: "QUEUED" },
    { key: "message.sent", label: "SENT" },
    { key: "message.finalized", label: "FINALIZED" },
  ];

  const queuedDone = !!lastTelnyxId;
  const isStepDone = (idx) => {
    if (idx === 0) return queuedDone;
    return false; // Webhooks not implemented in this simplified version
  };
  const doneKeys = statusSteps
    .filter((_, idx) => isStepDone(idx))
    .map((s) => s.key);

  const remainingVariant = stats.remaining <= 10 ? "destructive" : "secondary";
  const encodingVariant =
    stats.encoding === "UCS-2" ? "destructive" : "secondary";

  return (
    <div className="px-4 lg:px-6">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconSend className="size-6 text-primary" /> Send SMS
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">To (E.164)</label>
            <Input
              placeholder="+14155550123"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Message</label>
            <Textarea
              ref={textareaRef}
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Type your message…"
            />
            <div className="text-xs text-muted-foreground flex flex-wrap gap-2 items-center">
              <span>Encoding:</span>
              <Badge variant={encodingVariant}>{stats.encoding}</Badge>
              <span>· Parts:</span>
              <Badge variant="secondary">{stats.parts}</Badge>
              <span>· Max:</span>
              <Badge variant="secondary">{stats.perPart}</Badge>
              <span>· Remains:</span>
              <Badge variant={remainingVariant}>{stats.remaining}</Badge>
            </div>
          </div>

          <div className="w-full">
            <div className="text-sm font-medium mb-2">Status</div>
            <div className="flex w-full rounded-md border">
              {statusSteps.map((step, idx) => (
                <button
                  key={step.key}
                  className={cn(
                    "flex-1 px-4 py-2 text-sm font-medium transition-colors",
                    "hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring",
                    "flex items-center justify-center gap-2",
                    idx > 0 && "border-l",
                    isStepDone(idx) && "bg-muted"
                  )}
                  onClick={() => {
                    if (step.key === "QUEUED" && lastSendResponse) {
                      setOpenPayload({
                        title: step.label,
                        data: lastSendResponse,
                      });
                    }
                  }}
                >
                  {step.label}
                  {isStepDone(idx) && (
                    <CheckIcon className="size-4 text-primary" />
                  )}
                </button>
              ))}
            </div>
          </div>
          
          <div className="flex justify-end gap-3">
            <Button disabled={sending} onClick={onSend}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
        </CardContent>

        <Sheet
          open={!!openPayload}
          onOpenChange={(o) => !o && setOpenPayload(null)}
        >
          <SheetContent side="right" className="sm:max-w-xl">
            <SheetHeader>
              <SheetTitle>
                Response - {openPayload?.title}
              </SheetTitle>
            </SheetHeader>
            <div className="p-4">
              <CodeBlock
                wrap={true}
                language="json"
                data={openPayload?.data}
                height="80vh"
              />
            </div>
          </SheetContent>
        </Sheet>
      </Card>
    </div>
  );
}

export default function MessagingSendSmsView() {
  return (
    <Suspense fallback={<div className="px-4 lg:px-6">Loading…</div>}>
      <MessagingSendSmsViewInner />
    </Suspense>
  );
}
