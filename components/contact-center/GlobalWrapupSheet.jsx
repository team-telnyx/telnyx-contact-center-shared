"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CampaignDispositionSheet from "./CampaignDispositionSheet";
import WrapupCodesSheet from "./WrapupCodesSheet";
import useWrapupSheetStore from "@/lib/stores/wrapup-sheet-store";
import useActiveCallStore from "@/lib/stores/active-call-store";
import { subscribeCoreSnapshot } from "@/lib/status-stream-client";
import { usesNativeLifecycle } from "@/lib/acd/channel-registry.mjs";

function pendingWrapupFromSnapshot(snapshot) {
  if (snapshot?.agent?.workflow_state !== "wrapup") return null;
  const workItemId = snapshot.agent.workflow_work_item_id;
  const pending = snapshot.pendingWrapup;
  if (
    pending?.work_item_id
    && String(pending.work_item_id) === String(workItemId)
    && pending.ended_at
    && !pending.wrapup_ended_at
  ) {
    return pending;
  }
  return (snapshot.interactions || []).find(
    (item) => String(item.work_item_id) === String(workItemId)
      && item.segment_ended_at
      && !item.wrapup_ended_at,
  ) || null;
}

/**
 * Global owner of the wrap-up sheet. The applied acd_sync snapshot is the only
 * open/close signal, so reload and reconnect recover the same pending segment
 * without a second status projection or a best-effort companion event.
 */
export function GlobalWrapupSheet() {
  const { open, interactionId, segmentId, transcriptions, closeWrapup } = useWrapupSheetStore();
  const callTranscriptions = useActiveCallStore((state) => state?.transcriptions || []);
  const latestTranscriptionsRef = useRef([]);
  const [campaignAssignment, setCampaignAssignment] = useState(null);
  const [contextReady, setContextReady] = useState(false);
  const [contextKey, setContextKey] = useState(null);

  useEffect(() => {
    latestTranscriptionsRef.current = callTranscriptions || [];
  }, [callTranscriptions]);

  useEffect(() => subscribeCoreSnapshot((snapshot) => {
    const pending = pendingWrapupFromSnapshot(snapshot);
    if (!pending) {
      if (useWrapupSheetStore.getState().open) closeWrapup();
      return;
    }

    const pendingInteractionId = pending.interaction_id || pending.interactionId;
    if (!pendingInteractionId) return;
    const sheet = useWrapupSheetStore.getState();
    if (!sheet.open || String(sheet.interactionId) !== String(pendingInteractionId) || sheet.segmentId !== pending.segment_id) {
      sheet.openWrapup(
        pendingInteractionId,
        usesNativeLifecycle(pending.channel) ? [] : latestTranscriptionsRef.current || [],
        pending.segment_id,
      );
    }
  }), [closeWrapup]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer = null;
    setContextReady(false);
    setCampaignAssignment(null);
    if (!open || !interactionId) return undefined;

    async function loadContext() {
      try {
        const response = await fetch(
          `/api/contact-center/agent/pending-wrapup?interactionId=${encodeURIComponent(interactionId)}`,
          { cache: "no-store" },
        );
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error("Wrap-up context unavailable");
        if (cancelled) return;
        if (data.pendingWrapup?.waitingForCallEnd) {
          retryTimer = setTimeout(loadContext, 1000);
          return;
        }
        setCampaignAssignment(data.pendingWrapup?.campaignAssignment || null);
        setContextKey(`${interactionId}:${segmentId}`);
        setContextReady(true);
      } catch {
        if (!cancelled) retryTimer = setTimeout(loadContext, 2000);
      }
    }

    loadContext();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [open, interactionId, segmentId]);

  const handleSheetOpenChange = useCallback((nextOpen) => {
    // A save for the previous chat may finish after Core has already opened
    // the next pending wrap-up. Its callback must not close the newer sheet.
    const current = useWrapupSheetStore.getState();
    if (!nextOpen && String(current.interactionId) === String(interactionId) && current.segmentId === segmentId) closeWrapup();
  }, [closeWrapup, interactionId, segmentId]);

  if (open && (!contextReady || contextKey !== `${interactionId}:${segmentId}`)) return null;
  if (campaignAssignment) {
    return (
      <CampaignDispositionSheet
        assignment={campaignAssignment}
        open={open}
        onClose={closeWrapup}
        onSubmitted={() => window.dispatchEvent(new CustomEvent("contact-center:refresh-interactions"))}
      />
    );
  }
  return (
    <WrapupCodesSheet
      key={segmentId || interactionId || "closed"}
      open={open}
      onOpenChange={handleSheetOpenChange}
      interactionId={interactionId}
      segmentId={segmentId}
      transcriptions={transcriptions}
    />
  );
}
