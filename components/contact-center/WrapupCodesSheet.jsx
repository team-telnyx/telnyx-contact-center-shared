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
    const response = await fetch("/api/user/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: nextStatus,
        system: true,
      }),
    });

    if (response.ok && nextStatus === "Available") {
      // After status update to Available, ensure routing is triggered
      // The /api/user/profile endpoint already calls offerQueuedCallForAgent,
      // but we add a small delay to ensure state is fully updated
      setTimeout(async () => {
        try {
          // Get current user ID to trigger routing
          const userRes = await fetch("/api/user/profile");
          if (userRes.ok) {
            const userData = await userRes.json();
            if (userData?.data?.id) {
              // Explicitly trigger routing check
              await fetch("/api/contact-center/routing/agent-status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: userData.data.id }),
              }).catch(() => {
                // Ignore errors, routing already triggered by status update
              });
            }
          }
        } catch (err) {
          // Ignore errors, status update will trigger routing
          console.warn("[WrapupCodesSheet] Failed to trigger routing:", err);
        }
      }, 200);
    }

    return response.ok;
  } catch (err) {
    console.warn("[WrapupCodesSheet] Failed to update agent status:", err);
    return false;
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
  const [interactionMetadata, setInteractionMetadata] = useState(null);

  const intents = useMemo(() => {
    if (!Array.isArray(transcriptions)) return [];
    return Array.from(
      new Set(
        transcriptions
          .map((t) => t?.intent)
          .filter((intent) => Boolean(intent)),
      ),
    );
  }, [transcriptions]);

  // Check interaction metadata IMMEDIATELY when sheet opens to see if this is a timeout scenario
  // This runs BEFORE the status update effect to prevent status from being changed
  // This is critical - must check before any status updates happen
  useEffect(() => {
    if (open && interactionId) {
      let cancelled = false;

      const checkInteractionMetadata = async () => {
        try {
          // First check: Try to get interaction from wrapup-codes endpoint (faster, includes metadata)
          const wrapupRes = await fetch(
            `/api/contact-center/interactions/${encodeURIComponent(interactionId)}/wrapup-codes`,
            { cache: "no-store" },
          );

          if (cancelled) return;

          if (wrapupRes.ok) {
            const wrapupData = await wrapupRes.json();
            const wasTimeoutReEnqueued =
              wrapupData.timeoutReEnqueued === true ||
              wrapupData.metadata?.timeout_re_enqueued === true;

            if (wasTimeoutReEnqueued) {
              console.log(
                `[WrapupCodesSheet] Interaction ${interactionId} was timeout re-enqueued, closing wrapup sheet immediately`,
              );
              // Close immediately - don't wait
              const { default: useWrapupSheetStore } =
                await import("@/lib/stores/wrapup-sheet-store");
              useWrapupSheetStore.getState().closeWrapup();
              onOpenChange?.(false);
              return;
            }

            // Store metadata for status check
            if (wrapupData.metadata) {
              setInteractionMetadata(wrapupData.metadata);
            }
            return;
          }

          // Fallback: Try direct interaction endpoint
          const res = await fetch(
            `/api/contact-center/interactions/${encodeURIComponent(interactionId)}`,
            { cache: "no-store" },
          );

          if (cancelled) return;

          if (res.ok) {
            const data = await res.json();
            const interaction = data.interaction || data;
            const metadata = interaction.metadata || {};
            setInteractionMetadata(metadata);

            // If this is a timeout re-enqueue scenario, close the wrapup sheet immediately
            if (metadata.timeout_re_enqueued === true) {
              console.log(
                `[WrapupCodesSheet] Interaction ${interactionId} was timeout re-enqueued, closing wrapup sheet`,
              );
              // Close immediately - don't wait
              const { default: useWrapupSheetStore } =
                await import("@/lib/stores/wrapup-sheet-store");
              useWrapupSheetStore.getState().closeWrapup();
              onOpenChange?.(false);
              return;
            }
          }
        } catch (err) {
          console.error(
            "[WrapupCodesSheet] Failed to check interaction metadata:",
            err,
          );
        }
      };

      // Run check immediately
      checkInteractionMetadata();

      return () => {
        cancelled = true;
      };
    }
  }, [open, interactionId, onOpenChange]);

  useEffect(() => {
    // Don't update status if this is a timeout scenario or if sheet is not actually open
    if (!open || interactionMetadata?.timeout_re_enqueued === true) {
      if (interactionMetadata?.timeout_re_enqueued === true) {
        console.log(
          `[WrapupCodesSheet] Skipping status update - interaction ${interactionId} was timeout re-enqueued`,
        );
      }
      return;
    }

    // Check if agent is in "Agent Not Answering" status - don't override it
    // This prevents wrapup sheet from changing status when agent didn't answer
    const checkCurrentStatus = async () => {
      try {
        const res = await fetch("/api/user/profile");
        const data = await res.json();
        const currentStatus = data?.user?.agent_status;

        // Only set to Wrapup if not already "Agent Not Answering"
        if (currentStatus !== "Agent Not Answering") {
          updateAgentStatus("Wrapup");
        } else {
          console.log(
            `[WrapupCodesSheet] Skipping Wrapup status - agent is already in "Agent Not Answering" status`,
          );
        }
      } catch (err) {
        // If check fails, don't set to Wrapup to avoid overriding "Agent Not Answering"
        console.warn(
          "[WrapupCodesSheet] Failed to check status, skipping Wrapup update:",
          err,
        );
      }
    };

    checkCurrentStatus();
    try {
      localStorage.setItem("cc.wrapup.open", "true");
    } catch (_) {}

    prevOpenRef.current = open;
  }, [open, interactionMetadata, interactionId]);

  // Handle closing the sheet
  useEffect(() => {
    if (!open && prevOpenRef.current) {
      // When wrapup modal closes, check current status before updating
      // If status is "Agent Not Answering", don't change it to Available
      const checkAndUpdateStatus = async () => {
        try {
          const res = await fetch("/api/user/profile");
          const data = await res.json();
          const currentStatus = data?.user?.agent_status;

          // Only set to Available if not "Agent Not Answering"
          if (currentStatus !== "Agent Not Answering") {
            updateAgentStatus("Available");
          }
        } catch (err) {
          // If check fails, don't change status to avoid overriding "Agent Not Answering"
          console.warn(
            "[WrapupCodesSheet] Failed to check status on close, skipping Available update:",
            err,
          );
        }
      };

      checkAndUpdateStatus();
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
          interactionId,
        )}/wrapup`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      if (action === "start" && !res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && data?.retry) {
          if (wrapupStartRetryRef.current < 15) {
            wrapupStartRetryRef.current += 1;
            // Exponential backoff: 500ms, 1000ms, 2000ms, etc., max 5000ms
            const delay = Math.min(500 * Math.pow(2, wrapupStartRetryRef.current - 1), 5000);
            setTimeout(() => {
              sendWrapupEvent("start");
            }, delay);
          } else {
            console.warn(
              `[WrapupCodesSheet] Max retries reached for wrapup start on interaction ${interactionId}`,
            );
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

  // Store intents in a ref to prevent unnecessary effect re-runs
  const intentsRef = useRef(intents);
  useEffect(() => {
    intentsRef.current = intents;
  }, [intents]);

  const loadedInteractionIdRef = useRef(null);

  // Reset loaded interaction ref when interactionId changes or sheet closes
  useEffect(() => {
    if (!open || interactionId !== loadedInteractionIdRef.current) {
      loadedInteractionIdRef.current = null;
    }
  }, [open, interactionId]);

  useEffect(() => {
    if (!open || !interactionId) return;

    // Prevent reloading if we already loaded codes for this interaction
    if (loadedInteractionIdRef.current === interactionId) {
      return;
    }

    async function loadWrapupCodes() {
      setLoading(true);
      setTimeLeft(DEFAULT_COUNTDOWN_SECONDS);
      hasSubmittedRef.current = false;
      try {
        const res = await fetch(
          `/api/contact-center/interactions/${encodeURIComponent(
            interactionId,
          )}/wrapup-codes`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || "Failed to load wrapup codes");
        }

        // Check if this is a timeout re-enqueue scenario
        const wasTimeoutReEnqueued =
          data.timeoutReEnqueued === true ||
          data.metadata?.timeout_re_enqueued === true;

        if (wasTimeoutReEnqueued) {
          // This is a timeout scenario - close the wrapup sheet immediately
          console.log(
            `[WrapupCodesSheet] Interaction ${interactionId} was timeout re-enqueued, closing wrapup sheet`,
          );
          onOpenChange?.(false);
          setLoading(false);
          return;
        }

        // Store metadata for status check
        if (data.metadata) {
          setInteractionMetadata(data.metadata);
        }

        const list = data.codes || [];
        const existing = Array.isArray(data.selectedCodes)
          ? data.selectedCodes
          : [];

        // Batch all state updates together to prevent multiple re-renders
        // Use the current intents from ref to avoid stale closure
        const matched =
          existing.length > 0
            ? existing
            : getIntentMatches(list, intentsRef.current);

        // Update all states in a single batch using React's automatic batching
        setCodes(list);
        setDefaultCodeId(data.defaultCodeId || null);
        setQueueName(data.queueName || null);
        setSelectedCodes(matched);
        loadedInteractionIdRef.current = interactionId;
        setLoading(false);
      } catch (err) {
        notify({
          title: "Wrapup codes unavailable",
          description: String(err.message || err),
          variant: "error",
        });
        setLoading(false);
      }
    }

    loadWrapupCodes();
  }, [open, interactionId, onOpenChange]);

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
          interactionId,
        )}/wrapup-codes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wrapupCodes: codesToSave,
          }),
        },
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

  async function handleManualSubmit() {
    if (selectedCodes.length === 0) {
      notify({
        title: "Please select a wrapup code",
        description: "You must select at least one wrapup code before saving.",
        variant: "warning",
      });
      return;
    }
    await handleSubmit(selectedCodes);
  }

  async function handleAutoSubmit() {
    if (hasSubmittedRef.current) return;
    const fallback = selectedCodes.length > 0 ? selectedCodes : [];
    const finalCodes =
      fallback.length > 0 ? fallback : defaultCodeId ? [defaultCodeId] : [];
    await handleSubmit(finalCodes);
  }

  const timerLabel = `${String(Math.floor(timeLeft / 60)).padStart(
    2,
    "0",
  )}:${String(timeLeft % 60).padStart(2, "0")}`;

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        // Prevent closing by clicking outside or pressing escape
        // Only allow closing via the save button
        if (!nextOpen && open) {
          handleAutoSubmit();
        }
        // Don't call onOpenChange to prevent external close triggers
      }}
      modal={true}
    >
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
        showCloseButton={false}
        onInteractOutside={(e) => {
          // Prevent closing when clicking outside
          e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          // Prevent closing when pressing escape
          e.preventDefault();
        }}
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconChecklist className="size-5" />
            Wrapup Codes
          </SheetTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="text-base font-semibold">
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
                                  <Badge
                                    variant="outline"
                                    className="ml-2 text-xs"
                                  >
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
          <Button onClick={() => handleManualSubmit()} disabled={saving}>
            {saving ? "Saving..." : "Save & Close"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
