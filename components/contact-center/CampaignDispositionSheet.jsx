"use client";
import { voiceFetch } from "@/lib/telephony/endpoint-client";

import { useEffect, useState } from "react";
import { IconChecklist } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_STATUS_ICON,
  STATUS_ICON_MAP,
  STATUS_NAME_ICON_FALLBACK,
} from "@/config/status-icons";

export default function CampaignDispositionSheet({ assignment, open, onClose, onSubmitted }) {
  const [codes, setCodes] = useState([]);
  const [selectedCode, setSelectedCode] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !assignment?.campaign_id) return undefined;

    let cancelled = false;
    setCodes([]);
    setSelectedCode("");
    setCallbackAt("");
    setNotes("");
    setLoading(true);

    fetch(`/api/contact-center/agent/campaigns/disposition?campaignId=${encodeURIComponent(assignment.campaign_id)}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || "Failed to load disposition codes");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        const nextCodes = data.dispositionCodes || [];
        setCodes(nextCodes);
        setSelectedCode(nextCodes[0]?.wrapup_code_id || "");
      })
      .catch((err) => {
        if (cancelled) return;
        setCodes([]);
        notify({
          title: "Disposition codes unavailable",
          description: err.message || "Failed to load disposition codes",
          variant: "error",
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, assignment?.id, assignment?.campaign_id]);

  if (!open || !assignment) return null;

  const selected = codes.find((code) => code.wrapup_code_id === selectedCode);
  const requiresCallback = selected?.requires_callback === true;

  const submit = async () => {
    if (!selectedCode) {
      notify({ title: "Disposition required", description: "Select a disposition code", variant: "warning" });
      return;
    }
    if (requiresCallback && !callbackAt) {
      notify({ title: "Callback required", description: "Callback date/time is required", variant: "warning" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await voiceFetch("/api/contact-center/agent/campaigns/disposition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attemptId: assignment.id,
          ownerVersion: assignment.ownerVersion,
          dispositionCodeId: selectedCode,
          callback_at: callbackAt ? new Date(callbackAt).toISOString() : null,
          notes,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to save campaign disposition");
      onSubmitted?.(data);
      onClose?.();
    } catch (err) {
      notify({ title: "Disposition save failed", description: err.message || "Failed to save campaign disposition", variant: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose?.(); }}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0">
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconChecklist className="size-5" />
            Disposition Codes
          </SheetTitle>
          <p className="text-sm text-muted-foreground">
            Select the campaign outcome for {assignment.to_number}. This updates retry, completion, or suppression state.
          </p>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-hidden flex flex-col gap-4 px-5 py-4">
          <div className="space-y-2 shrink-0">
            <Label htmlFor="campaign-disposition-notes">Comment</Label>
            <Textarea
              id="campaign-disposition-notes"
              data-testid="campaign-disposition-notes"
              className="min-h-24 resize-none"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Add an optional comment for supervisor and reporting"
            />
          </div>

          {requiresCallback ? (
            <div className="space-y-2 shrink-0">
              <Label htmlFor="campaign-disposition-callback">Callback date/time</Label>
              <input
                id="campaign-disposition-callback"
                type="datetime-local"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={callbackAt}
                onChange={(event) => setCallbackAt(event.target.value)}
              />
            </div>
          ) : null}

          <div className="flex-1 min-h-0 flex flex-col gap-2">
            <Label>Disposition code</Label>
            <Card className="flex-1 flex flex-col overflow-hidden">
              <CardContent className="p-6 flex-1 flex flex-col min-h-0">
                {loading ? (
                  <div className="space-y-4">
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                  </div>
                ) : codes.length === 0 ? (
                  <div className="text-sm text-muted-foreground text-center py-6">
                    No disposition codes assigned to this campaign.
                  </div>
                ) : (
                  <ScrollArea className="flex-1">
                    <div className="space-y-2 pr-4">
                      {codes.map((code) => {
                        const codeName = code.wrapup_code_name || code.wrapup_code_id;
                        const IconComponent =
                          STATUS_ICON_MAP[code.wrapup_code_icon]
                          || STATUS_NAME_ICON_FALLBACK[codeName]
                          || STATUS_ICON_MAP[DEFAULT_STATUS_ICON]
                          || STATUS_ICON_MAP["circle-off"];
                        const metadata = [
                          code.classification?.replace(/_/g, " "),
                          code.business_category && code.business_category !== "none" ? code.business_category : null,
                        ].filter(Boolean).join(" · ");

                        return (
                          <label
                            key={code.wrapup_code_id}
                            className="flex items-start gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded-md p-2 -m-2 transition-colors"
                          >
                            <Checkbox
                              data-testid="campaign-disposition-code"
                              data-code-id={code.wrapup_code_id}
                              checked={selectedCode === code.wrapup_code_id}
                              onCheckedChange={() => setSelectedCode(code.wrapup_code_id)}
                              className="mt-0.5 shrink-0"
                              aria-label={`Select ${codeName}`}
                            />
                            <span className="leading-tight flex items-start gap-2 flex-1 min-w-0">
                              {IconComponent ? (
                                <IconComponent
                                  className="size-4 mt-0.5 shrink-0"
                                  style={code.wrapup_code_color ? { color: code.wrapup_code_color } : undefined}
                                />
                              ) : null}
                              <span className="flex-1 min-w-0">
                                <span className="font-medium block break-words">{codeName}</span>
                                {code.wrapup_code_description ? (
                                  <span className="block text-xs text-muted-foreground mt-0.5 break-words">
                                    {code.wrapup_code_description}
                                  </span>
                                ) : null}
                                {metadata ? (
                                  <span className="block text-xs text-muted-foreground mt-0.5 capitalize">
                                    {metadata}
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
        </div>

        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            type="button"
            data-testid="campaign-disposition-submit"
            onClick={submit}
            disabled={submitting || loading || codes.length === 0}
          >
            {submitting ? "Saving..." : "Submit disposition"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
