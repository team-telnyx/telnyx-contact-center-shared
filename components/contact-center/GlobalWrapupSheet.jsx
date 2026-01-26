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
    (state) => state?.contactCenter?.interactionId || null
  );
  const callTranscriptions = useActiveCallStore(
    (state) => state?.transcriptions || []
  );
  const disconnectedTime = useActiveCallStore((state) => state.disconnectedTime);
  const [interactions, setInteractions] = useState([]);
  const lastWrapupInteractionRef = useRef(null);
  const lastInteractionSnapshotRef = useRef(null);
  const lastStatusRef = useRef(null);
  const lastDisconnectedTimeRef = useRef(null);

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
          "/api/contact-center/agent/interactions?limit=50&activeOnly=false"
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
    window.addEventListener('contact-center:refresh-interactions', handleSSEEvent);
    
    return () => {
      window.removeEventListener('contact-center:refresh-interactions', handleSSEEvent);
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
                callInteractionId
              )}`
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

        // If still no interaction found after retry, default to opening wrapup sheet
        if (!interaction) {
          lastWrapupInteractionRef.current = interactionId;
          useWrapupSheetStore.getState().openWrapup(
            interactionId,
            callTranscriptions || []
          );
          return;
        }

        // Check metadata for hangup cause and timeline events
        const metadata = interaction.metadata || {};
        const routingMetadata = metadata.routing_metadata || {};
        const timeline = routingMetadata.timeline || [];

        // Check if call was answered - look for answered_at or answered event in timeline
        const hasAnsweredEvent = timeline.some(
          (e) =>
            e.type === "answered" ||
            e.type === "connected" ||
            e.type === "bridged"
        );
        const wasAnswered =
          Boolean(interaction.answered_at) || hasAnsweredEvent;

        // Check if call was abandoned or rejected
        const isAbandoned = interaction.state === "abandoned";
        const wasQueuedWhenEnded = interaction.state === "queued";

        // Skip wrapup only if abandoned and never answered
        const shouldSkip = wasQueuedWhenEnded || (isAbandoned && !wasAnswered);

        if (!shouldSkip) {
          lastWrapupInteractionRef.current = interactionId;
          useWrapupSheetStore.getState().openWrapup(
            interactionId,
            callTranscriptions || []
          );
        }
      } catch (err) {
        // Error checking interaction for wrapup
      }
    };

    checkAndOpenWrapup();
  }, [callStatus, callInteractionId, interactions, disconnectedTime, callTranscriptions]);

  // Also watch for interactions changing to "completed" state
  const processedCompletedInteractionsRef = useRef(new Set());
  useEffect(() => {
    const completedInteractions = interactions.filter(
      (interaction) =>
        interaction.state === "completed" &&
        interaction.id !== lastWrapupInteractionRef.current &&
        !processedCompletedInteractionsRef.current.has(interaction.id)
    );

    for (const interaction of completedInteractions) {
      processedCompletedInteractionsRef.current.add(interaction.id);

      const wasAnswered = Boolean(interaction.answered_at);
      const metadata = interaction.metadata || {};
      const routingMetadata = metadata.routing_metadata || {};
      const timeline = routingMetadata.timeline || [];
      const hasAnsweredEvent = timeline.some(
        (e) =>
          e.type === "answered" ||
          e.type === "connected" ||
          e.type === "bridged"
      );
      const wasActuallyAnswered = wasAnswered || hasAnsweredEvent;

      const isAbandoned = interaction.state === "abandoned";
      const wasQueuedWhenEnded = interaction.state === "queued";

      const shouldSkip =
        wasQueuedWhenEnded || (isAbandoned && !wasActuallyAnswered);

      if (!shouldSkip && wasActuallyAnswered) {
        lastWrapupInteractionRef.current = interaction.id;
        useWrapupSheetStore.getState().openWrapup(
          interaction.id,
          callTranscriptions || []
        );
        break;
      }
    }
  }, [interactions, callTranscriptions]);

  // Listen for manual disconnect events from softphone components
  useEffect(() => {
    const handleCallDisconnected = async (event) => {
      const { interactionId: eventInteractionId, transcriptions: eventTranscriptions } =
        event.detail || {};
      if (!eventInteractionId) return;

      // Check if we've already shown wrapup for this interaction
      if (lastWrapupInteractionRef.current === eventInteractionId) {
        return;
      }

      // Find the interaction to check if it was answered
      const interaction = interactions.find((i) => i.id === eventInteractionId);
      if (interaction) {
        const wasAnswered = Boolean(interaction.answered_at);
        const isAbandoned = interaction.state === "abandoned";
        const wasQueuedWhenEnded = interaction.state === "queued";

        // Skip wrapup only if abandoned and never answered
        const shouldSkip = wasQueuedWhenEnded || (isAbandoned && !wasAnswered);

        if (!shouldSkip) {
          lastWrapupInteractionRef.current = eventInteractionId;
          useWrapupSheetStore.getState().openWrapup(
            eventInteractionId,
            eventTranscriptions
          );
        }
      } else {
        // If interaction not found, assume it was answered and show wrapup
        lastWrapupInteractionRef.current = eventInteractionId;
        useWrapupSheetStore.getState().openWrapup(
          eventInteractionId,
          eventTranscriptions
        );
      }
    };

    window.addEventListener(
      "contact-center:call-disconnected",
      handleCallDisconnected
    );

    return () => {
      window.removeEventListener(
        "contact-center:call-disconnected",
        handleCallDisconnected
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

