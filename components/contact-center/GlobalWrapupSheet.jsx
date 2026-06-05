"use client";

import { useEffect, useState, useRef } from "react";
import WrapupCodesSheet from "./WrapupCodesSheet";
import useWrapupSheetStore from "@/lib/stores/wrapup-sheet-store";
import useActiveCallStore from "@/lib/stores/active-call-store";

/**
 * Global Wrapup Sheet Component
 *
 * This component renders the wrapup codes sheet globally across the entire application.
 * It listens for events and state changes to open the wrapup sheet when needed.
 */
export function GlobalWrapupSheet() {
  const { open, interactionId, transcriptions, closeWrapup } =
    useWrapupSheetStore();
  const callStatus = useActiveCallStore((state) => state.status);
  const callInteractionId = useActiveCallStore(
    (state) => state?.contactCenter?.interactionId || null,
  );
  const callTranscriptions = useActiveCallStore(
    (state) => state?.transcriptions || [],
  );
  const disconnectedTime = useActiveCallStore(
    (state) => state.disconnectedTime,
  );
  const [interactions, setInteractions] = useState([]);
  const lastWrapupInteractionRef = useRef(null);
  const lastInteractionSnapshotRef = useRef(null);
  const lastStatusRef = useRef(null);
  const lastDisconnectedTimeRef = useRef(null);
  const latestTranscriptionsRef = useRef([]);

  useEffect(() => {
    latestTranscriptionsRef.current = callTranscriptions || [];
  }, [callTranscriptions]);

  // Track interaction ID and transcriptions
  useEffect(() => {
    if (callInteractionId) {
      lastInteractionSnapshotRef.current = callInteractionId;
    }
    if (Array.isArray(callTranscriptions)) {
      // Store transcriptions in a ref for later use
    }
  }, [callInteractionId, callTranscriptions]);

  // Load interactions to check if call was answered
  // No polling - SSE handles all real-time updates
  useEffect(() => {
    const loadInteractions = async () => {
      try {
        const res = await fetch(
          "/api/contact-center/agent/interactions?limit=50&activeOnly=false",
        );
        const data = await res.json();
        if (data.ok && Array.isArray(data.interactions)) {
          setInteractions(data.interactions);
        }
      } catch (err) {
        // Failed to load interactions
      }
    };

    // Initial load on mount
    loadInteractions();

    // Listen to SSE events to trigger immediate refresh when interactions change
    const handleSSEEvent = () => {
      loadInteractions();
    };
    window.addEventListener(
      "contact-center:refresh-interactions",
      handleSSEEvent,
    );

    return () => {
      window.removeEventListener(
        "contact-center:refresh-interactions",
        handleSSEEvent,
      );
    };
  }, []);

  // Listen for explicit server-side wrapup requests from the authoritative
  // webhook lifecycle. This path does not depend on WebRTC local call state,
  // so it still opens wrapup when the browser store missed the hangup event.
  useEffect(() => {
    let eventSource = null;
    const handleAgentMessage = (event) => {
      try {
        const data = JSON.parse(event.data || "{}");
        if (data?.type === "wrapup_required" && data.interactionId) {
          if (lastWrapupInteractionRef.current === data.interactionId) return;
          lastWrapupInteractionRef.current = data.interactionId;
          useWrapupSheetStore
            .getState()
            .openWrapup(data.interactionId, latestTranscriptionsRef.current || []);
          return;
        }
        if (
          data?.type === "interaction_updated" ||
          data?.type === "interaction_ended"
        ) {
          window.dispatchEvent(
            new CustomEvent("contact-center:refresh-interactions"),
          );
        }
      } catch (err) {
        console.error("[GlobalWrapupSheet] Failed to parse agent SSE event:", err);
      }
    };

    try {
      eventSource = new EventSource("/api/contact-center/agent/stream");
      eventSource.onmessage = handleAgentMessage;
    } catch (err) {
      console.error("[GlobalWrapupSheet] Failed to connect agent SSE:", err);
    }

    return () => {
      if (eventSource) eventSource.close();
    };
  }, []);

  // Listen for call status changes and disconnectedTime changes
  useEffect(() => {
    const endedStatuses = [
      "hangup",
      "ended",
      "destroy",
      "terminated",
      "failed",
    ];
    const isEnded = endedStatuses.includes(callStatus);
    const wasActive = lastStatusRef.current && lastStatusRef.current !== "idle";
    const isCleared = callStatus === "idle" && wasActive;
    const wasDisconnected =
      disconnectedTime &&
      disconnectedTime > 0 &&
      disconnectedTime !== lastDisconnectedTimeRef.current;
    lastStatusRef.current = callStatus;
    if (wasDisconnected) {
      lastDisconnectedTimeRef.current = disconnectedTime;
    }

    // Trigger wrapup check if call ended, cleared, or disconnected
    if (!isEnded && !isCleared && !wasDisconnected) return;

    const interactionId =
      callInteractionId || lastInteractionSnapshotRef.current;
    if (!interactionId) return;
    if (lastWrapupInteractionRef.current === interactionId) return;

    // Check if call was answered and not abandoned before opening wrapup sheet
    const checkAndOpenWrapup = async (retryCount = 0) => {
      try {
        // CRITICAL: Check timeout status FIRST via API before doing anything else
        // This prevents wrapup sheet from opening even for a moment
        try {
          const timeoutCheckRes = await fetch(
            `/api/contact-center/interactions/${encodeURIComponent(interactionId)}/timeout-check`,
            { cache: "no-store" },
          );
          if (timeoutCheckRes.ok) {
            const timeoutData = await timeoutCheckRes.json();
            if (timeoutData.timeoutReEnqueued === true) {
              console.log(
                `[GlobalWrapupSheet] Skipping wrapup for interaction ${interactionId} - timeout re-enqueued`,
              );
              return; // Don't open wrapup sheet at all
            }
          }
        } catch (timeoutCheckErr) {
          // If timeout check fails, continue with normal check
          console.warn(
            "[GlobalWrapupSheet] Timeout check failed:",
            timeoutCheckErr,
          );
        }

        // Add a small delay on retry to allow database to update
        if (retryCount > 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        // First, try to find interaction in local state
        let interaction = interactions.find((i) => i.id === interactionId);

        // If not found locally, try to fetch from API
        if (!interaction && callInteractionId) {
          try {
            const res = await fetch(
              `/api/contact-center/interactions/by-call-control-id?callControlId=${encodeURIComponent(
                callInteractionId,
              )}`,
            );
            const data = await res.json();
            if (data.ok && data.interaction) {
              interaction = data.interaction;
            }
          } catch (apiErr) {
            // Could not fetch interaction for wrapup check
          }
        }

        // If still no interaction found and we haven't retried, try once more
        if (!interaction && retryCount === 0) {
          return checkAndOpenWrapup(1);
        }

        // If still no interaction found after retry, check timeout once more, then skip wrapup
        if (!interaction) {
          try {
            const timeoutCheckRes = await fetch(
              `/api/contact-center/interactions/${encodeURIComponent(interactionId)}/timeout-check`,
              { cache: "no-store" },
            );
            if (timeoutCheckRes.ok) {
              const timeoutData = await timeoutCheckRes.json();
              if (timeoutData.timeoutReEnqueued === true) {
                console.log(
                  `[GlobalWrapupSheet] Skipping wrapup for interaction ${interactionId} - timeout re-enqueued (no interaction found)`,
                );
                return;
              }
            }
          } catch (timeoutCheckErr) {
            // Continue if check fails
          }

          // No interaction evidence; not opening wrapup. Wrapup requires positive
          // evidence that the interaction was answered/connected.
          console.log(
            `[GlobalWrapupSheet] No interaction evidence; not opening wrapup for ${interactionId}`,
          );
          return;
        }

        // Check metadata for hangup cause and timeline events
        const metadata = interaction.metadata || {};
        const routingMetadata = metadata.routing_metadata || {};
        const timeline = routingMetadata.timeline || [];

        // Check if this was a timeout re-enqueue scenario
        const wasTimeoutReEnqueued = metadata.timeout_re_enqueued === true;

        // Double-check timeout flag from interaction
        if (wasTimeoutReEnqueued) {
          console.log(
            `[GlobalWrapupSheet] Skipping wrapup for interaction ${interactionId} - timeout re-enqueued (from interaction metadata)`,
          );
          return;
        }

        // Check if call was answered - look for answered_at or answered event in timeline
        const hasAnsweredEvent = timeline.some(
          (e) =>
            e.type === "answered" ||
            e.type === "connected" ||
            e.type === "bridged",
        );
        const wasAnswered =
          Boolean(interaction.answered_at) || hasAnsweredEvent;

        // Check if call was abandoned or rejected
        const isAbandoned = interaction.state === "abandoned";
        const wasQueuedWhenEnded = interaction.state === "queued";

        // Skip wrapup if:
        // - Timeout re-enqueued (agent didn't answer)
        // - Abandoned and never answered
        // - Still queued when ended
        if (!wasAnswered) {
          console.log(
            `[GlobalWrapupSheet] Skipping wrapup for interaction ${interactionId} - call was never answered`,
          );
          return;
        }

        const shouldSkip =
          wasTimeoutReEnqueued ||
          wasQueuedWhenEnded ||
          (isAbandoned && !wasAnswered);

        if (!shouldSkip) {
          lastWrapupInteractionRef.current = interactionId;
          useWrapupSheetStore
            .getState()
            .openWrapup(interactionId, callTranscriptions || []);
        }
      } catch (err) {
        // Error checking interaction for wrapup
        console.error("[GlobalWrapupSheet] Error in checkAndOpenWrapup:", err);
      }
    };

    checkAndOpenWrapup();
  }, [
    callStatus,
    callInteractionId,
    interactions,
    disconnectedTime,
    callTranscriptions,
  ]);

  // Also watch for interactions changing to "completed" state
  const processedCompletedInteractionsRef = useRef(new Set());
  useEffect(() => {
    const completedInteractions = interactions.filter(
      (interaction) =>
        interaction.state === "completed" &&
        interaction.id !== lastWrapupInteractionRef.current &&
        !processedCompletedInteractionsRef.current.has(interaction.id),
    );

    // Process completed interactions asynchronously
    (async () => {
      for (const interaction of completedInteractions) {
        processedCompletedInteractionsRef.current.add(interaction.id);

        // CRITICAL: Check timeout status FIRST via API before doing anything else
        try {
          const timeoutCheckRes = await fetch(
            `/api/contact-center/interactions/${encodeURIComponent(interaction.id)}/timeout-check`,
            { cache: "no-store" },
          );
          if (timeoutCheckRes.ok) {
            const timeoutData = await timeoutCheckRes.json();
            if (timeoutData.timeoutReEnqueued === true) {
              console.log(
                `[GlobalWrapupSheet] Skipping wrapup for interaction ${interaction.id} - timeout re-enqueued (completed interaction)`,
              );
              continue; // Skip this interaction, check next one
            }
          }
        } catch (timeoutCheckErr) {
          // If timeout check fails, continue with normal check
          console.warn(
            "[GlobalWrapupSheet] Timeout check failed for completed interaction:",
            timeoutCheckErr,
          );
        }

        const wasAnswered = Boolean(interaction.answered_at);
        const metadata = interaction.metadata || {};
        const wasTimeoutReEnqueued = metadata.timeout_re_enqueued === true;
        const routingMetadata = metadata.routing_metadata || {};
        const timeline = routingMetadata.timeline || [];
        const hasAnsweredEvent = timeline.some(
          (e) =>
            e.type === "answered" ||
            e.type === "connected" ||
            e.type === "bridged",
        );
        const wasActuallyAnswered = wasAnswered || hasAnsweredEvent;

        const isAbandoned = interaction.state === "abandoned";
        const wasQueuedWhenEnded = interaction.state === "queued";

        const shouldSkip =
          wasTimeoutReEnqueued ||
          wasQueuedWhenEnded ||
          (isAbandoned && !wasActuallyAnswered);

        if (!shouldSkip && wasActuallyAnswered) {
          lastWrapupInteractionRef.current = interaction.id;
          useWrapupSheetStore
            .getState()
            .openWrapup(interaction.id, callTranscriptions || []);
          break;
        }
      }
    })();
  }, [interactions, callTranscriptions]);

  // Listen for manual disconnect events from softphone components
  useEffect(() => {
    const handleCallDisconnected = async (event) => {
      const {
        interactionId: eventInteractionId,
        transcriptions: eventTranscriptions,
        rejectedBeforeAnswer,
        wasAnswered: eventWasAnswered,
      } = event.detail || {};
      if (!eventInteractionId) return;
      if (rejectedBeforeAnswer === true || eventWasAnswered === false) {
        console.log(
          `[GlobalWrapupSheet] Skipping wrapup for interaction ${eventInteractionId} - disconnected before answer`,
        );
        return;
      }

      // Check if we've already shown wrapup for this interaction
      if (lastWrapupInteractionRef.current === eventInteractionId) {
        return;
      }

      // CRITICAL: Check timeout status FIRST via API before doing anything else
      try {
        const timeoutCheckRes = await fetch(
          `/api/contact-center/interactions/${encodeURIComponent(eventInteractionId)}/timeout-check`,
          { cache: "no-store" },
        );
        if (timeoutCheckRes.ok) {
          const timeoutData = await timeoutCheckRes.json();
          if (timeoutData.timeoutReEnqueued === true) {
            console.log(
              `[GlobalWrapupSheet] Skipping wrapup for interaction ${eventInteractionId} - timeout re-enqueued (disconnect event)`,
            );
            return; // Don't open wrapup sheet at all
          }
        }
      } catch (timeoutCheckErr) {
        // If timeout check fails, continue with normal check
      }

      // Check if this is a consult call - don't show wrapup for consultant call leg
      try {
        const interactionRes = await fetch(
          `/api/contact-center/interactions/${encodeURIComponent(eventInteractionId)}`,
          { cache: "no-store" },
        );
        if (interactionRes.ok) {
          const interactionData = await interactionRes.json();
          const interaction = interactionData.interaction;
          if (interaction?.metadata?.is_consult_call) {
            console.log(
              `[GlobalWrapupSheet] Skipping wrapup for consult call interaction ${eventInteractionId}`,
            );
            return; // Don't open wrapup sheet for consult calls
          }
        }
      } catch (consultCheckErr) {
        // If consult check fails, continue with normal check
        console.warn(
          "[GlobalWrapupSheet] Timeout check failed in disconnect handler:",
          timeoutCheckErr,
        );
      }

      // Find the interaction to check if it was answered
      const interaction = interactions.find((i) => i.id === eventInteractionId);
      if (interaction) {
        const metadata = interaction.metadata || {};
        const wasTimeoutReEnqueued = metadata.timeout_re_enqueued === true;
        const isConsultCall = metadata.is_consult_call === true;
        const wasAnswered = Boolean(interaction.answered_at);
        const isAbandoned = interaction.state === "abandoned";
        const wasQueuedWhenEnded = interaction.state === "queued";

        // Skip wrapup if:
        // - Timeout re-enqueued (agent didn't answer)
        // - Abandoned and never answered
        // - Still queued when ended
        // - Consult call (consultant call leg, not the parked call)
        if (!wasAnswered) {
          console.log(
            `[GlobalWrapupSheet] Skipping wrapup for interaction ${eventInteractionId} - call was never answered`,
          );
          return;
        }

        const shouldSkip =
          wasTimeoutReEnqueued ||
          wasQueuedWhenEnded ||
          isConsultCall ||
          (isAbandoned && !wasAnswered);

        if (!shouldSkip) {
          lastWrapupInteractionRef.current = eventInteractionId;
          useWrapupSheetStore
            .getState()
            .openWrapup(eventInteractionId, eventTranscriptions);
        }
      } else {
        // No interaction evidence; not opening wrapup. Wrapup requires positive
        // evidence that the interaction was answered/connected.
        console.log(
          `[GlobalWrapupSheet] No interaction evidence; not opening wrapup for ${eventInteractionId}`,
        );
        return;
      }
    };

    window.addEventListener(
      "contact-center:call-disconnected",
      handleCallDisconnected,
    );

    return () => {
      window.removeEventListener(
        "contact-center:call-disconnected",
        handleCallDisconnected,
      );
    };
  }, [interactions]);

  return (
    <WrapupCodesSheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeWrapup();
        }
      }}
      interactionId={interactionId}
      transcriptions={transcriptions}
      callStatus={callStatus}
    />
  );
}
