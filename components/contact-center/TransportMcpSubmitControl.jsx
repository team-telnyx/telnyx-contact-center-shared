"use client";

import { useMemo, useState } from "react";
import { CheckCircle, Clock, DatabaseZap, Loader2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ToastNotify";
import { formatSlotDisplay, hasSlotValue } from "@/lib/agent-assist/slot-display.mjs";
import useWorkflowStore from "@/lib/stores/workflow-store";

function bindingFor(item) {
  const raw = item?.mcp_binding ?? item?.mcpBinding;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
}

function collectControlSlots(items) {
  const control = new Set();
  for (const item of items) {
    const binding = bindingFor(item);
    if (!binding || !item?.slot_name) continue;
    const trigger = String(binding.trigger || "on_fill");
    if (["on_result", "on_complete", "manual_submit"].includes(trigger)) {
      control.add(item.slot_name);
    }
  }
  return control;
}

function collectSlotArgumentRefs(value, refs = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{\{\s*slots\.([^}\s]+)\s*\}\}/g)) {
      const name = String(match[1] || "").split(/[.\[]/, 1)[0];
      if (name) refs.add(name);
    }
    return refs;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectSlotArgumentRefs(entry, refs);
    return refs;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectSlotArgumentRefs(entry, refs);
  }
  return refs;
}

function sourceLabel(status) {
  switch (status?.completed_by) {
    case "mcp": return "MCP";
    case "mcp_selected": return "MCP + agent";
    case "agent": return "Agent";
    case "ai": return "LLM";
    case "call_flow": return "Pre-call";
    case "inferred": return "Inferred";
    default: return null;
  }
}

/**
 * New-transport-only MCP submit control.
 *
 * New configurations use trigger=manual_submit. For compatibility with
 * workflows saved by earlier revisions of this PR, create_transport+on_complete
 * is also rendered here; the orchestrator suppresses that legacy binding during
 * normal automatic passes, so it is manual-only as well.
 */
export default function TransportMcpSubmitControl() {
  const session = useWorkflowStore((state) => state.session);
  const stages = useWorkflowStore((state) => state.stages);
  const itemStatuses = useWorkflowStore((state) => state.itemStatuses);
  const slotsFilled = useWorkflowStore((state) => state.slotsFilled);
  const fetchSession = useWorkflowStore((state) => state.fetchSession);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);

  const allItems = useMemo(
    () => (stages || []).flatMap((stage) => stage?.items || []),
    [stages],
  );

  const submitItem = useMemo(
    () => allItems.find((item) => {
      const binding = bindingFor(item);
      const trigger = String(binding?.trigger || "");
      return binding?.tool_name === "create_transport" && ["manual_submit", "on_complete"].includes(trigger);
    }) || null,
    [allItems],
  );

  const readiness = useMemo(() => {
    if (!submitItem) return { ready: false, missing: [], reviewFields: [] };

    const controlSlots = collectControlSlots(allItems);
    const submitBinding = bindingFor(submitItem) || {};
    const requiredNames = new Set();

    // Required workflow data slots must be present. Control slots only exist to
    // hang MCP work off the checklist and are not data the user has to provide.
    for (const item of allItems) {
      if (item?.type !== "slot" || !item.slot_name || item.is_required !== true) continue;
      if (!controlSlots.has(item.slot_name)) requiredNames.add(item.slot_name);
    }

    // A create_transport argument can depend on an optional workflow slot too.
    // Treat every {{slots.x}} reference as required for the submit button so the
    // confirmation cannot dispatch with a visibly missing API input.
    for (const name of collectSlotArgumentRefs(submitBinding.arguments || {})) {
      requiredNames.add(name);
    }

    const itemBySlot = new Map(
      allItems.filter((item) => item?.type === "slot" && item.slot_name).map((item) => [item.slot_name, item]),
    );
    const missing = [];
    for (const name of requiredNames) {
      const item = itemBySlot.get(name);
      const status = item ? itemStatuses?.[item.id] : null;
      if (!hasSlotValue(slotsFilled?.[name]) || status?.status === "suggested") {
        missing.push(item?.label || name);
      }
    }

    const seen = new Set();
    const reviewFields = [];
    for (const item of allItems) {
      if (item?.type !== "slot" || !item.slot_name || controlSlots.has(item.slot_name)) continue;
      if (seen.has(item.slot_name)) continue;
      seen.add(item.slot_name);
      const value = slotsFilled?.[item.slot_name];
      if (!hasSlotValue(value)) continue;
      const status = itemStatuses?.[item.id];
      reviewFields.push({
        slotName: item.slot_name,
        label: item.label || item.slot_name,
        value,
        slotType: item.slot_type,
        source: sourceLabel(status),
      });
    }

    return { ready: missing.length === 0, missing, reviewFields };
  }, [allItems, itemStatuses, slotsFilled, submitItem]);

  if (!submitItem || !session?.id) return null;

  const submitStatus = itemStatuses?.[submitItem.id];
  const alreadySubmitted = submitStatus?.status === "completed";

  async function confirmSubmit() {
    if (!readiness.ready || submitting || alreadySubmitted) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/agent-assist/workflow/mcp-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          sessionId: session.id,
          interactionId: session.interaction_id,
          itemId: submitItem.id,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Transport submission failed");

      if (session.interaction_id) await fetchSession(session.interaction_id);
      setReviewOpen(false);
      notify({
        title: "New transport submitted",
        description: "The create_transport MCP call completed successfully.",
        variant: "success",
      });
    } catch (error) {
      notify({
        title: "Transport submission failed",
        description: error?.message || "Unable to submit the new transport request.",
        variant: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  // get_active_transports' output schema was never discovered/cached (same
  // gap create_transport had before mcp-submit's own diagnostic), so there
  // is no known ETA field to map into a slot yet. This surfaces whatever
  // the tool actually returns (status + a best-effort scan for an eta/
  // arrival/estimate-named field) directly in a toast, rather than waiting
  // on another round of "what field is this" before the agent gets any
  // value from the button at all.
  async function checkStatus() {
    if (checkingStatus || !alreadySubmitted) return;
    setCheckingStatus(true);
    try {
      const response = await fetch("/api/agent-assist/workflow/transport-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          sessionId: session.id,
          interactionId: session.interaction_id,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Transport status check failed");

      if (!data.found) {
        notify({
          title: "No status yet",
          description: data.message || "This transport hasn't shown up in active transports yet.",
          variant: "warning",
        });
        return;
      }

      const etaEntries = Object.entries(data.etaCandidates || {});
      const description = etaEntries.length > 0
        ? etaEntries.map(([key, value]) => `${key}: ${value}`).join(" · ")
        : (data.status ? `Status: ${data.status}` : "No ETA field found in the response yet.");
      notify({
        title: "Transport status",
        description,
        variant: "success",
      });
    } catch (error) {
      notify({
        title: "Status check failed",
        description: error?.message || "Unable to check transport status.",
        variant: "error",
      });
    } finally {
      setCheckingStatus(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        className="h-8 gap-1.5"
        disabled={!readiness.ready || submitting || alreadySubmitted}
        onClick={() => setReviewOpen(true)}
        title={
          alreadySubmitted
            ? "This new transport request has already been submitted"
            : readiness.ready
              ? "Review the gathered fields before creating the transport"
              : `Waiting for: ${readiness.missing.join(", ")}`
        }
      >
        {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : alreadySubmitted ? <CheckCircle className="h-3.5 w-3.5" /> : <DatabaseZap className="h-3.5 w-3.5" />}
        {alreadySubmitted ? "Transport submitted" : "Submit transport"}
      </Button>

      {alreadySubmitted && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 ml-2"
          disabled={checkingStatus}
          onClick={checkStatus}
          title="Check this transport's current status and ETA"
        >
          {checkingStatus ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
          Check ETA
        </Button>
      )}

      {reviewOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="transport-submit-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !submitting) setReviewOpen(false);
          }}
        >
          <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
              <div>
                <h2 id="transport-submit-title" className="text-base font-semibold">Confirm new transport request</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Review the information gathered during this interaction. Confirming will call create_transport and create a new transport request.
                </p>
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" disabled={submitting} onClick={() => setReviewOpen(false)} aria-label="Close transport confirmation">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
              <div className="divide-y rounded-lg border">
                {readiness.reviewFields.map((field) => (
                  <div key={field.slotName} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] gap-4 px-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{field.label}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{field.slotName}</div>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="break-words text-right font-medium">{formatSlotDisplay(field.value, field.slotType)}</span>
                      {field.source ? <Badge variant="outline" className="shrink-0 text-[10px]">{field.source}</Badge> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
              <Button type="button" variant="outline" disabled={submitting} onClick={() => setReviewOpen(false)}>Cancel</Button>
              <Button type="button" disabled={!readiness.ready || submitting} onClick={confirmSubmit} className="gap-1.5">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <DatabaseZap className="h-4 w-4" />}
                Confirm & submit new transport
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
