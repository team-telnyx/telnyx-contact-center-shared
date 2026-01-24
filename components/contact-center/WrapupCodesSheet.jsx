"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { notify } from "@/components/ToastNotify";
import { IconChecklist } from "@tabler/icons-react";
import {
  STATUS_ICON_MAP,
  STATUS_NAME_ICON_FALLBACK,
  DEFAULT_STATUS_ICON,
} from "@/config/status-icons";

const DEFAULT_COUNTDOWN_SECONDS = 30;
const END_STATUSES = ["hangup", "ended", "destroy", "idle", "terminated"];

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getIntentMatches(codes, intents) {
  if (!Array.isArray(codes) || codes.length === 0) return [];
  if (!Array.isArray(intents) || intents.length === 0) return [];

  const normalizedIntents = intents
    .map(normalizeText)
    .filter(Boolean)
    .map((value) => ({ value, raw: value }));

  const matched = [];
  for (const code of codes) {
    const codeName = normalizeText(code?.name);
    if (!codeName) continue;
    for (const intent of normalizedIntents) {
      if (codeName === intent.value || codeName.includes(intent.value)) {
        matched.push(code.id);
        break;
      }
      if (intent.value.includes(codeName)) {
        matched.push(code.id);
        break;
      }
    }
  }
  return matched;
}

async function updateAgentStatus(nextStatus) {
  try {
    await fetch("/api/user/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: nextStatus,
        system: true,
      }),
    });
    try {
      localStorage.setItem("user.status", nextStatus);
    } catch (_) {}
  } catch (err) {
    console.warn("[WrapupCodesSheet] Failed to update agent status:", err);
  }
}

export default function WrapupCodesSheet({
  open,
  onOpenChange,
  interactionId,
  transcriptions,
  callStatus,
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [codes, setCodes] = useState([]);
  const [selectedCodes, setSelectedCodes] = useState([]);
  const [defaultCodeId, setDefaultCodeId] = useState(null);
  const [queueName, setQueueName] = useState(null);
  const [timeLeft, setTimeLeft] = useState(DEFAULT_COUNTDOWN_SECONDS);
  const hasSubmittedRef = useRef(false);
  const timerRef = useRef(null);
  const prevOpenRef = useRef(false);
  const wrapupStartSentRef = useRef(false);
  const wrapupEndSentRef = useRef(false);
  const lastInteractionIdRef = useRef(null);
  const wrapupStartRetryRef = useRef(0);

  const intents = useMemo(() => {
    if (!Array.isArray(transcriptions)) return [];
    return Array.from(
      new Set(
        transcriptions
          .map((t) => t?.intent)
          .filter((intent) => Boolean(intent))
      )
    );
  }, [transcriptions]);

  useEffect(() => {
    if (open) {
      updateAgentStatus("Wrapup");
      try {
        localStorage.setItem("cc.wrapup.open", "true");
      } catch (_) {}
    } else if (prevOpenRef.current) {
      updateAgentStatus("Available");
      try {
        localStorage.removeItem("cc.wrapup.open");
      } catch (_) {}
    }
    prevOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (interactionId && lastInteractionIdRef.current !== interactionId) {
      lastInteractionIdRef.current = interactionId;
      wrapupStartSentRef.current = false;
      wrapupEndSentRef.current = false;
      wrapupStartRetryRef.current = 0;
    }
  }, [interactionId]);

  async function sendWrapupEvent(action) {
    if (!interactionId) return;
    try {
      const res = await fetch(
        `/api/contact-center/interactions/${encodeURIComponent(
          interactionId
        )}/wrapup`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }
      );
      if (action === "start" && !res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && data?.retry) {
          if (wrapupStartRetryRef.current < 10) {
            wrapupStartRetryRef.current += 1;
            setTimeout(() => {
              sendWrapupEvent("start");
            }, 500);
          }
          return;
        }
      }
    } catch (err) {
      console.warn(`[WrapupCodesSheet] Failed to ${action} wrapup:`, err);
    }
  }

  useEffect(() => {
    if (!interactionId) return;
    if (open && !wrapupStartSentRef.current) {
      wrapupStartSentRef.current = true;
      sendWrapupEvent("start");
      return;
    }
    if (!open && wrapupStartSentRef.current && !wrapupEndSentRef.current) {
      wrapupEndSentRef.current = true;
      sendWrapupEvent("end");
    }
  }, [open, interactionId]);

  useEffect(() => {
    if (!open || !interactionId) return;

    async function loadWrapupCodes() {
      setLoading(true);
      setTimeLeft(DEFAULT_COUNTDOWN_SECONDS);
      hasSubmittedRef.current = false;
      try {
        const res = await fetch(
          `/api/contact-center/interactions/${encodeURIComponent(
            interactionId
          )}/wrapup-codes`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || "Failed to load wrapup codes");
        }
        const list = data.codes || [];
        setCodes(list);
        setDefaultCodeId(data.defaultCodeId || null);
        setQueueName(data.queueName || null);

        const existing = Array.isArray(data.selectedCodes)
          ? data.selectedCodes
          : [];
        if (existing.length > 0) {
          setSelectedCodes(existing);
        } else {
          const matched = getIntentMatches(list, intents);
          setSelectedCodes(matched);
        }
      } catch (err) {
        notify({
          title: "Wrapup codes unavailable",
          description: String(err.message || err),
          variant: "error",
        });
      } finally {
        setLoading(false);
      }
    }

    loadWrapupCodes();
  }, [open, interactionId, intents]);

  useEffect(() => {
    if (!open) return;

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          timerRef.current = null;
          handleAutoSubmit();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (callStatus && !END_STATUSES.includes(callStatus)) {
      onOpenChange?.(false);
    }
  }, [callStatus, open, onOpenChange]);

  function toggleCode(codeId) {
    setSelectedCodes((prev) => {
      if (prev.includes(codeId)) {
        return prev.filter((id) => id !== codeId);
      }
      return [...prev, codeId];
    });
  }

  async function handleSubmit(codesToSave) {
    if (!interactionId || saving || hasSubmittedRef.current) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/contact-center/interactions/${encodeURIComponent(
          interactionId
        )}/wrapup-codes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wrapupCodes: codesToSave,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Failed to save wrapup codes");
      }
      hasSubmittedRef.current = true;
      if (!wrapupEndSentRef.current) {
        wrapupEndSentRef.current = true;
        await sendWrapupEvent("end");
      }
      onOpenChange?.(false);
    } catch (err) {
      notify({
        title: "Failed to save wrapup codes",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleAutoSubmit() {
    if (hasSubmittedRef.current) return;
    const fallback = selectedCodes.length > 0 ? selectedCodes : [];
    const finalCodes =
      fallback.length > 0
        ? fallback
        : defaultCodeId
          ? [defaultCodeId]
          : [];
    await handleSubmit(finalCodes);
  }

  const timerLabel = `${String(Math.floor(timeLeft / 60)).padStart(2, "0")}:${String(
    timeLeft % 60
  ).padStart(2, "0")}`;

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && open) {
          handleAutoSubmit();
        } else {
          onOpenChange?.(nextOpen);
        }
      }}
    >
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconChecklist className="size-5" />
            Wrapup Codes
          </SheetTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="text-xs">
              Auto-save in {timerLabel}
            </Badge>
            {queueName ? (
              <span className="text-xs text-muted-foreground">
                Queue: {queueName}
              </span>
            ) : null}
          </div>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-hidden flex flex-col px-5 py-4">
          <Card className="flex-1 flex flex-col overflow-hidden">
            <CardContent className="p-6 flex-1 flex flex-col min-h-0">
              {loading ? (
                <div className="space-y-4">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : codes.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-6">
                  No wrapup codes assigned to this queue.
                </div>
              ) : (
                <ScrollArea className="flex-1">
                  <div className="space-y-2 pr-4">
                    {codes.map((code) => {
                      const IconComponent =
                        STATUS_ICON_MAP[code.icon] ||
                        STATUS_NAME_ICON_FALLBACK[code.name] ||
                        STATUS_ICON_MAP[DEFAULT_STATUS_ICON] ||
                        STATUS_ICON_MAP["circle-off"];
                      return (
                        <label
                          key={code.id}
                          className="flex items-start gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded-md p-2 -m-2 transition-colors"
                        >
                          <Checkbox
                            checked={selectedCodes.includes(code.id)}
                            onCheckedChange={() => toggleCode(code.id)}
                            className="mt-0.5 shrink-0"
                          />
                          <span className="leading-tight flex items-start gap-2 flex-1 min-w-0">
                            {IconComponent && (
                              <IconComponent
                                className="size-4 mt-0.5 shrink-0"
                                style={
                                  code.color ? { color: code.color } : undefined
                                }
                              />
                            )}
                            <span className="flex-1 min-w-0">
                              <span className="font-medium block break-words">
                                {code.name}
                                {code.is_default ? (
                                  <Badge variant="outline" className="ml-2 text-xs">
                                    Default
                                  </Badge>
                                ) : null}
                              </span>
                              {code.description ? (
                                <span className="block text-xs text-muted-foreground mt-0.5 break-words">
                                  {code.description}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </div>

        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button onClick={() => handleAutoSubmit()} disabled={saving}>
            {saving ? "Saving..." : "Save & Close"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

