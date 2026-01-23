"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { InteractionsList } from "./InteractionsList";
import { InteractionDetail } from "./InteractionDetail";
import WrapupCodesSheet from "./WrapupCodesSheet";
import { Card } from "@/components/ui/card";
import { Info, PhoneCall } from "lucide-react";
import useActiveCallStore from "@/lib/stores/active-call-store";
import useCallsStore from "@/lib/stores/calls-store";

export function AgentDesktop() {
  const [selectedInteraction, setSelectedInteraction] = useState(null);
  const [interactions, setInteractions] = useState([]);
  const [dbInteractions, setDbInteractions] = useState([]);
  const [currentUsername, setCurrentUsername] = useState(null);
  const lastRefreshAttemptRef = useRef(new Map()); // Track refresh attempts to avoid infinite loops
  const lastWrapupInteractionRef = useRef(null);
  const lastInteractionSnapshotRef = useRef(null);
  const lastStatusRef = useRef(null);
  const lastTranscriptionsRef = useRef([]);
  const [wrapupOpen, setWrapupOpen] = useState(false);
  const [wrapupInteractionId, setWrapupInteractionId] = useState(null);
  const [wrapupTranscriptions, setWrapupTranscriptions] = useState([]);

  // Get WebRTC call state for real-time updates (hold, mute, status)
  const webrtcCallState = useActiveCallStore();
  const callStatus = webrtcCallState.status;
  const callInteractionId =
    webrtcCallState?.contactCenter?.interactionId || null;
  const callTranscriptions = webrtcCallState?.transcriptions || [];

  // Get calls from calls store - subscribe to changes
  // Subscribe to calls object to avoid infinite loop (getActiveCalls returns new array each time)
  const calls = useCallsStore((state) => state.calls);
  const callsStore = useCallsStore();

  // Compute active calls from calls object with memoization
  const activeCalls = useMemo(() => {
    const allCalls = Object.values(calls);
    return allCalls.filter(
      (call) =>
        call.status !== "completed" &&
        call.status !== "abandoned" &&
        call.status !== "ended" &&
        call.status !== "hangup" &&
        call.status !== "idle" &&
        call.status !== "terminated" &&
        !call.disconnectedTime &&
        (call.interactionId || call.originalCallControlId || call.queueName)
    );
  }, [calls]);

  const buildInteractionsWithStore = useCallback(
    (dbInteractions = []) => {
      const storeCallMap = new Map();
      activeCalls.forEach((call) => {
        if (call.interactionId) {
          storeCallMap.set(call.interactionId, call);
        }
        if (call.callControlId) {
          storeCallMap.set(call.callControlId, call);
        }
        if (call.originalCallControlId) {
          storeCallMap.set(call.originalCallControlId, call);
        }
        if (call.callSessionId) {
          storeCallMap.set(call.callSessionId, call);
        }
        if (call.originalCallSessionId) {
          storeCallMap.set(call.originalCallSessionId, call);
        }
      });

      const enhancedInteractions = dbInteractions.map((interaction) => {
        const metadata = interaction.metadata || {};
        const storeCall =
          storeCallMap.get(interaction.id) ||
          storeCallMap.get(interaction.call_control_id) ||
          storeCallMap.get(interaction.call_session_id) ||
          storeCallMap.get(metadata.original_call_control_id) ||
          storeCallMap.get(metadata.agent_call_control_id);
        if (storeCall) {
          return {
            ...interaction,
            call_control_id:
              interaction.call_control_id || storeCall.callControlId || null,
            call_session_id:
              interaction.call_session_id ||
              storeCall.callSessionId ||
              storeCall.originalCallSessionId ||
              null,
            metadata: {
              ...(interaction.metadata || {}),
              ...(storeCall.aiCallControlId
                ? { ai_call_control_id: storeCall.aiCallControlId }
                : {}),
            },
            ai_call_control_id:
              interaction.ai_call_control_id ||
              storeCall.aiCallControlId ||
              null,
            from_name:
              interaction.from_name ||
              storeCall.callerName ||
              storeCall.fromName,
            from_number:
              interaction.from_number ||
              interaction.from ||
              storeCall.callerNumber ||
              storeCall.fromNumber,
            queue_name: storeCall.queueName || interaction.queue_name,
            state: storeCall.status || interaction.state,
          };
        }
        return interaction;
      });

      const storeOnlyInteractions = activeCalls
        .filter((call) => {
          const matchKeys = new Set([
            call.interactionId,
            call.callControlId,
            call.originalCallControlId,
            call.callSessionId,
            call.originalCallSessionId,
          ]);
          matchKeys.delete(undefined);
          matchKeys.delete(null);
          matchKeys.delete("");

          return !dbInteractions.some((interaction) => {
            const metadata = interaction.metadata || {};
            const interactionKeys = new Set([
              interaction.id,
              interaction.call_control_id,
              interaction.call_session_id,
              metadata.original_call_control_id,
              metadata.agent_call_control_id,
            ]);
            for (const key of interactionKeys) {
              if (key && matchKeys.has(key)) return true;
            }
            return false;
          });
        })
        .map((call) => ({
          id: call.interactionId || `temp-${call.callControlId}`,
          call_control_id: call.callControlId,
          call_session_id: call.callSessionId,
          direction: call.direction || "inbound",
          state: call.status || "ringing",
          original_call_control_id: call.originalCallControlId || null,
          from_number: call.callerNumber || call.fromNumber || "",
          to_number: call.toNumber || "",
          from_name: call.callerName || call.fromName || null,
          queue_name: call.queueName || "",
          interaction_type: "voice",
          is_contact_center: true,
          created_at: new Date(call.callStartTime || Date.now()).toISOString(),
          assigned_at: call.assignedAt || null,
          queued_at: call.queuedAt || null,
          metadata: call.aiCallControlId
            ? { ai_call_control_id: call.aiCallControlId }
            : {},
          ai_call_control_id: call.aiCallControlId || null,
        }));

      const merged = [...enhancedInteractions, ...storeOnlyInteractions];
      const seen = new Set();
      return merged.filter((interaction) => {
        const key = interaction.call_control_id || interaction.id;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    [activeCalls]
  );

  // Initialize calls store on mount (ensures it's visible in dev tools)
  useEffect(() => {
    // Access the store to ensure it's initialized
    callsStore.getAllCalls();
  }, [callsStore]);

  const applyInteractions = useCallback(
    (mergedInteractions) => {
      setInteractions(mergedInteractions);

      // Auto-select first active if none selected
      setSelectedInteraction((current) => {
        if (!current) {
          return mergedInteractions.length > 0 ? mergedInteractions[0] : null;
        }
        // Update selected interaction if it exists in the new list
        if (current) {
          const updated = mergedInteractions.find(
            (i) =>
              i.id === current.id ||
              i.call_control_id === current.call_control_id
          );
          if (updated) {
            return updated;
          }
          if (mergedInteractions.length === 0) {
            return null;
          }
          // If not found in active list (e.g., completed) OR if from_number is missing/empty, try to refresh it from DB
          const needsRefresh =
            !current.from_number || current.from_number.trim() === "";
          const interactionId = current.id;
          const callControlId = current.call_control_id;
          const lastAttempt = lastRefreshAttemptRef.current.get(interactionId);
          const now = Date.now();

          // Only refresh if we haven't tried in the last 5 seconds (avoid infinite loops)
          if (
            needsRefresh &&
            callControlId &&
            (!lastAttempt || now - lastAttempt > 5000)
          ) {
            lastRefreshAttemptRef.current.set(interactionId, now);

            fetch(
              `/api/contact-center/interactions/by-call-control-id?callControlId=${encodeURIComponent(
                callControlId
              )}`
            )
              .then((res) => res.json())
              .then((data) => {
                if (data.ok && data.interaction) {
                  // Only update if we got a better from_number or if it's the same interaction
                  if (
                    data.interaction.id === interactionId ||
                    data.interaction.call_control_id === callControlId
                  ) {
                    console.log(
                      "[AgentDesktop] Refreshed interaction from DB:",
                      {
                        id: data.interaction.id,
                        from_number: data.interaction.from_number,
                        had_from_number: current.from_number,
                      }
                    );
                    setSelectedInteraction(data.interaction);
                  }
                }
              })
              .catch((err) => {
                console.warn(
                  "[AgentDesktop] Failed to refresh selected interaction:",
                  err
                );
              });
          }
        }
        return null;
      });
    },
    [setInteractions, setSelectedInteraction]
  );

  // Load interactions from database on mount and periodically
  useEffect(() => {
    const loadInteractions = async () => {
      try {
        const res = await fetch(
          "/api/contact-center/agent/interactions?limit=50&activeOnly=true"
        );
        const data = await res.json();
        if (data.ok && Array.isArray(data.interactions)) {
          setDbInteractions(data.interactions);
        }
      } catch (err) {
        console.error("[AgentDesktop] Failed to load interactions:", err);
      }
    };
    loadInteractions();
    // Reload every 5 seconds to catch new interactions
    const interval = setInterval(loadInteractions, 5000);
    return () => clearInterval(interval);
  }, []);

  // Rebuild interactions from store updates without polling
  useEffect(() => {
    const mergedInteractions = buildInteractionsWithStore(dbInteractions);
    applyInteractions(mergedInteractions);
  }, [applyInteractions, buildInteractionsWithStore, dbInteractions]);

  // Load current username
  useEffect(() => {
    const loadUsername = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        if (data.isAuth && data.user?.email) {
          setCurrentUsername(data.user.email);
        }
      } catch (err) {
        // Silently handle errors
      }
    };
    loadUsername();
  }, []);

  // Auto-refresh selected interaction if from_number is missing
  useEffect(() => {
    if (!selectedInteraction) return;

    const needsRefresh =
      !selectedInteraction.from_number ||
      selectedInteraction.from_number.trim() === "";
    if (!needsRefresh) return;

    const interactionId = selectedInteraction.id;
    const callControlId = selectedInteraction.call_control_id;
    if (!callControlId) return;

    const lastAttempt = lastRefreshAttemptRef.current.get(interactionId);
    const now = Date.now();

    // Only refresh if we haven't tried in the last 5 seconds (avoid infinite loops)
    if (!lastAttempt || now - lastAttempt > 5000) {
      lastRefreshAttemptRef.current.set(interactionId, now);

      console.log(
        "[AgentDesktop] Auto-refreshing interaction with missing from_number:",
        {
          id: interactionId,
          call_control_id: callControlId,
        }
      );

      fetch(
        `/api/contact-center/interactions/by-call-control-id?callControlId=${encodeURIComponent(
          callControlId
        )}`
      )
        .then((res) => res.json())
        .then((data) => {
          if (data.ok && data.interaction) {
            if (
              data.interaction.id === interactionId ||
              data.interaction.call_control_id === callControlId
            ) {
              console.log("[AgentDesktop] Auto-refreshed interaction:", {
                id: data.interaction.id,
                from_number: data.interaction.from_number,
                had_from_number: selectedInteraction.from_number,
              });
              setSelectedInteraction(data.interaction);
            }
          }
        })
        .catch((err) => {
          console.warn(
            "[AgentDesktop] Failed to auto-refresh interaction:",
            err
          );
        });
    }
  }, [
    selectedInteraction?.id,
    selectedInteraction?.from_number,
    selectedInteraction?.call_control_id,
  ]);

  // Clear selected interaction immediately when it disappears from the list
  useEffect(() => {
    if (!selectedInteraction) return;
    const stillExists = interactions.some(
      (interaction) =>
        interaction.id === selectedInteraction.id ||
        interaction.call_control_id === selectedInteraction.call_control_id
    );
    if (!stillExists) {
      setSelectedInteraction(null);
    }
  }, [interactions, selectedInteraction]);

  useEffect(() => {
    if (callInteractionId) {
      lastInteractionSnapshotRef.current = callInteractionId;
    }
    if (Array.isArray(callTranscriptions)) {
      lastTranscriptionsRef.current = callTranscriptions;
    }
  }, [callInteractionId, callTranscriptions]);

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
    lastStatusRef.current = callStatus;

    if (!isEnded && !isCleared) return;

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
        if (!interaction) {
          try {
            const res = await fetch(
              `/api/contact-center/interactions/by-call-control-id?callControlId=${encodeURIComponent(
                callInteractionId || ""
              )}`
            );
            const data = await res.json();
            if (data.ok && data.interaction) {
              interaction = data.interaction;
            }
          } catch (apiErr) {
            console.warn(
              "[AgentDesktop] Could not fetch interaction for wrapup check:",
              apiErr
            );
          }
        }

        // If still no interaction found and we haven't retried, try once more
        if (!interaction && retryCount === 0) {
          return checkAndOpenWrapup(1);
        }

        // If still no interaction found after retry, skip wrapup
        if (!interaction) {
          console.log(
            "[AgentDesktop] Could not find interaction for wrapup check:",
            interactionId
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
        const disconnectedEvent = timeline.find(
          (e) => e.type === "disconnected"
        );
        const hangupCause =
          disconnectedEvent?.hangupCause || metadata.hangup_cause;
        const wasRejected =
          hangupCause === "CALL_REJECTED" ||
          hangupCause === "NO_ANSWER" ||
          hangupCause === "user_busy" ||
          hangupCause === "timeout";

        // Check if call was in "queued" state when it ended (abandoned)
        const wasQueuedWhenEnded = interaction.state === "queued";

        // Only open wrapup sheet if call was answered and not abandoned/rejected
        // Be lenient: if call was active and ended, assume it was answered unless we have evidence otherwise
        const shouldOpenWrapup =
          wasAnswered && !isAbandoned && !wasRejected && !wasQueuedWhenEnded;

        if (shouldOpenWrapup) {
          lastWrapupInteractionRef.current = interactionId;
          setWrapupInteractionId(interactionId);
          setWrapupTranscriptions(lastTranscriptionsRef.current || []);
          setWrapupOpen(true);
        } else {
          // If we don't have enough info yet and haven't retried, try once more
          if (
            retryCount === 0 &&
            !wasAnswered &&
            !isAbandoned &&
            !wasRejected
          ) {
            return checkAndOpenWrapup(1);
          }

          console.log(
            "[AgentDesktop] Skipping wrapup sheet - call not answered or was abandoned/rejected:",
            {
              interactionId,
              wasAnswered,
              isAbandoned,
              wasRejected,
              wasQueuedWhenEnded,
              hangupCause,
              state: interaction.state,
              hasAnsweredEvent,
            }
          );
        }
      } catch (err) {
        console.error(
          "[AgentDesktop] Error checking interaction for wrapup:",
          err
        );
      }
    };

    checkAndOpenWrapup();
  }, [callStatus, callInteractionId, interactions]);

  return (
    <div className="flex flex-col h-full">
      {/* Main Content */}
      <div className="flex gap-4 flex-1 min-h-0 overflow-hidden">
        {/* Left Panel - Interactions List */}
        <Card className="w-80 shrink-0 flex flex-col overflow-hidden">
          <InteractionsList
            interactions={
              Array.isArray(interactions) ? interactions.filter(Boolean) : []
            }
            selectedId={selectedInteraction?.id}
            onSelect={setSelectedInteraction}
            webrtcCallState={webrtcCallState}
            currentUsername={currentUsername}
          />
        </Card>

        {/* Right Panel - Interaction Details */}
        <Card className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <div className="px-4 py-3 bg-muted/50 border-b -mt-6 rounded-t-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-md bg-primary/10">
                  <Info className="h-4 w-4 text-primary" />
                </div>
                <h2 className="text-base font-semibold text-foreground">
                  Interaction Details
                </h2>
              </div>
            </div>
          </div>
          {selectedInteraction ? (
            <InteractionDetail interaction={selectedInteraction} />
          ) : (
            <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground gap-2">
              <PhoneCall className="h-10 w-10 text-green-500 animate-pulse" />
              <p>Waiting for a call...</p>
            </div>
          )}
        </Card>
      </div>

      <WrapupCodesSheet
        open={wrapupOpen}
        onOpenChange={setWrapupOpen}
        interactionId={wrapupInteractionId}
        transcriptions={wrapupTranscriptions}
        callStatus={callStatus}
      />
    </div>
  );
}
