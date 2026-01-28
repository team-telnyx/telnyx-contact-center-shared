"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { InteractionsList } from "./InteractionsList";
import { InteractionDetail } from "./InteractionDetail";
import { Card } from "@/components/ui/card";
import { Info, PhoneCall } from "lucide-react";
import useActiveCallStore from "@/lib/stores/active-call-store";
import useCallsStore from "@/lib/stores/calls-store";

export function AgentDesktop() {
  const [selectedInteraction, setSelectedInteraction] = useState(null);
  const [interactions, setInteractions] = useState([]);
  const [dbInteractions, setDbInteractions] = useState([]);
  const [currentUsername, setCurrentUsername] = useState(null);
  const [agentStatus, setAgentStatus] = useState(null); // Track agent's current status
  const lastRefreshAttemptRef = useRef(new Map()); // Track refresh attempts to avoid infinite loops
  const lastWrapupInteractionRef = useRef(null);
  const lastInteractionSnapshotRef = useRef(null);
  const lastStatusRef = useRef(null);
  const lastTranscriptionsRef = useRef([]);
  const lastDisconnectedTimeRef = useRef(null);

  // Get WebRTC call state for real-time updates (hold, mute, status)
  // Use selectors to ensure re-renders when these specific values change
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
        (call.interactionId || call.originalCallControlId || call.queueName),
    );
  }, [calls]);

  const buildInteractionsWithStore = useCallback(
    (dbInteractions = [], currentAgentStatus = null) => {
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

      // Filter out timeout re-enqueued interactions from database interactions
      const filteredDbInteractions = dbInteractions.filter((interaction) => {
        const metadata = interaction.metadata || {};
        const wasTimeoutReEnqueued = metadata.timeout_re_enqueued === true;
        const isReEnqueued =
          interaction.state === "queued" &&
          !interaction.agent_username &&
          !interaction.agentUsername;

        // CRITICAL: If agent status is "Agent Not Answering", filter out any ringing interactions
        // This handles the case where the database hasn't updated yet but the agent status has changed
        if (
          currentAgentStatus === "Agent Not Answering" &&
          interaction.state === "ringing"
        ) {
          console.log(
            `[AgentDesktop] Filtering out ringing interaction ${interaction.id} in buildInteractionsWithStore - agent status is "Agent Not Answering"`,
          );
          return false;
        }

        return !wasTimeoutReEnqueued && !isReEnqueued;
      });

      const enhancedInteractions = filteredDbInteractions.map((interaction) => {
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
            // Always prioritize database value for from_number - it's the source of truth
            from_number:
              interaction.from_number ||
              interaction.from ||
              (storeCall.callerNumber && storeCall.callerNumber.trim() !== "")
                ? storeCall.callerNumber
                : storeCall.fromNumber && storeCall.fromNumber.trim() !== ""
                  ? storeCall.fromNumber
                  : null,
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

          return !filteredDbInteractions.some((interaction) => {
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
    [activeCalls],
  );

  // Initialize calls store on mount (ensures it's visible in dev tools)
  useEffect(() => {
    // Access the store to ensure it's initialized
    callsStore.getAllCalls();
  }, [callsStore]);

  const applyInteractions = useCallback(
    (mergedInteractions) => {
      // Filter out timeout re-enqueued interactions - these should not be shown to the agent
      const filteredInteractions = mergedInteractions.filter((interaction) => {
        const metadata = interaction.metadata || {};
        const wasTimeoutReEnqueued = metadata.timeout_re_enqueued === true;

        // Also filter out interactions that are in "queued" state and have no agent_username
        // (they were re-enqueued after timeout)
        const isReEnqueued =
          interaction.state === "queued" &&
          !interaction.agent_username &&
          !interaction.agentUsername;

        if (wasTimeoutReEnqueued || isReEnqueued) {
          console.log(
            `[AgentDesktop] Filtering out timeout re-enqueued interaction ${interaction.id}`,
          );
          return false;
        }

        return true;
      });

      setInteractions(filteredInteractions);

      // Auto-select first active if none selected
      setSelectedInteraction((current) => {
        if (!current) {
          return filteredInteractions.length > 0
            ? filteredInteractions[0]
            : null;
        }
        // Update selected interaction if it exists in the new list
        // Also deselect if current interaction was timeout re-enqueued
        if (current) {
          const currentMetadata = current.metadata || {};
          const wasCurrentTimeoutReEnqueued =
            currentMetadata.timeout_re_enqueued === true;
          const isCurrentReEnqueued =
            current.state === "queued" &&
            !current.agent_username &&
            !current.agentUsername;

          if (wasCurrentTimeoutReEnqueued || isCurrentReEnqueued) {
            // Deselect if current interaction was timeout re-enqueued
            return filteredInteractions.length > 0
              ? filteredInteractions[0]
              : null;
          }

          const updated = filteredInteractions.find(
            (i) =>
              i.id === current.id ||
              i.call_control_id === current.call_control_id,
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
                callControlId,
              )}`,
            )
              .then((res) => res.json())
              .then((data) => {
                if (data.ok && data.interaction) {
                  // Only update if we got a better from_number or if it's the same interaction
                  if (
                    data.interaction.id === interactionId ||
                    data.interaction.call_control_id === callControlId
                  ) {
                    setSelectedInteraction(data.interaction);
                  }
                }
              })
              .catch((err) => {
                // Failed to refresh selected interaction
              });
          }
        }
        return null;
      });
    },
    [setInteractions, setSelectedInteraction],
  );

  // Load interactions from database on mount and via SSE-triggered refreshes
  // No polling - SSE handles all real-time updates
  useEffect(() => {
    const loadInteractions = async () => {
      try {
        const res = await fetch(
          "/api/contact-center/agent/interactions?limit=50&activeOnly=true",
          { cache: "no-store" },
        );
        const data = await res.json();
        if (data.ok && Array.isArray(data.interactions)) {
          // Filter out timeout re-enqueued interactions on the client side as well
          const filtered = data.interactions.filter((interaction) => {
            const metadata = interaction.metadata || {};
            const wasTimeoutReEnqueued = metadata.timeout_re_enqueued === true;
            const isReEnqueued =
              interaction.state === "queued" &&
              !interaction.agent_username &&
              !interaction.agentUsername;

            // CRITICAL: If agent status is "Agent Not Answering", filter out any ringing interactions
            // This handles the case where the database hasn't updated yet but the agent status has changed
            if (
              agentStatus === "Agent Not Answering" &&
              interaction.state === "ringing"
            ) {
              console.log(
                `[AgentDesktop] Filtering out ringing interaction ${interaction.id} - agent status is "Agent Not Answering"`,
              );
              return false;
            }

            return !wasTimeoutReEnqueued && !isReEnqueued;
          });
          setDbInteractions(filtered);
        }
      } catch (err) {
        // Failed to load interactions
        console.error("[AgentDesktop] Failed to load interactions:", err);
      }
    };

    // Initial load on mount
    loadInteractions();

    // Listen to SSE events to trigger immediate refresh when interactions change
    const handleSSEEvent = () => {
      loadInteractions();
    };

    // Listen for custom events from ContactCenterStreamProvider
    window.addEventListener(
      "contact-center:refresh-interactions",
      handleSSEEvent,
    );

    // Also listen for call disconnect events to IMMEDIATELY remove the interaction
    const handleCallDisconnected = (event) => {
      const { interactionId, callControlId } = event.detail || {};

      // IMMEDIATELY remove the interaction from local state
      // This ensures the UI clears instantly, even before database refresh
      if (interactionId || callControlId) {
        setDbInteractions((current) => {
          const filtered = current.filter((interaction) => {
            const matchesId = interaction.id === interactionId;
            const matchesCallControlId =
              interaction.call_control_id === callControlId;
            if (matchesId || matchesCallControlId) {
              console.log(
                `[AgentDesktop] Immediately removing disconnected interaction: ${interactionId || callControlId}`,
              );
              return false;
            }
            return true;
          });
          return filtered;
        });

        // Also remove from calls store immediately
        if (callControlId) {
          useCallsStore.getState().removeCall(callControlId);
        }
        if (interactionId) {
          useCallsStore.getState().removeCall(interactionId);
        }

        // Clear selected interaction if it's the one that disconnected
        setSelectedInteraction((current) => {
          if (
            current &&
            (current.id === interactionId ||
              current.call_control_id === callControlId)
          ) {
            return null;
          }
          return current;
        });
      }

      // Then refresh from database after a short delay to ensure consistency
      setTimeout(() => {
        loadInteractions();
      }, 300);
    };

    window.addEventListener(
      "contact-center:call-disconnected",
      handleCallDisconnected,
    );

    return () => {
      window.removeEventListener(
        "contact-center:refresh-interactions",
        handleSSEEvent,
      );
      window.removeEventListener(
        "contact-center:call-disconnected",
        handleCallDisconnected,
      );
    };
  }, []);

  // Rebuild interactions from store updates without polling
  useEffect(() => {
    const mergedInteractions = buildInteractionsWithStore(
      dbInteractions,
      agentStatus,
    );
    applyInteractions(mergedInteractions);
  }, [
    applyInteractions,
    buildInteractionsWithStore,
    dbInteractions,
    agentStatus,
  ]);

  // Load current username and agent status
  useEffect(() => {
    const loadUserInfo = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        if (data.isAuth && data.user?.email) {
          setCurrentUsername(data.user.email);
        }
        // Get agent status from user profile API
        try {
          const profileRes = await fetch("/api/user/profile");
          const profileData = await profileRes.json();
          if (profileData.ok && profileData.data?.status) {
            setAgentStatus(profileData.data.status);
          }
        } catch (profileErr) {
          // Failed to load status from profile
        }
      } catch (err) {
        // Silently handle errors
      }
    };
    loadUserInfo();

    // Listen for status changes via SSE (same endpoint as site-header uses)
    let statusEventSource = null;
    try {
      statusEventSource = new EventSource("/api/user/status-stream");
      statusEventSource.addEventListener("status_changed", (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log("[AgentDesktop] Received status_changed event:", data);
          if (data.status) {
            console.log(
              `[AgentDesktop] Updating agent status to "${data.status}"`,
            );
            setAgentStatus(data.status);
          }
        } catch (err) {
          console.error(
            "[AgentDesktop] Failed to parse status SSE message:",
            err,
          );
        }
      });
    } catch (err) {
      console.error("[AgentDesktop] Failed to set up status SSE:", err);
    }

    return () => {
      if (statusEventSource) {
        statusEventSource.close();
      }
    };
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

      fetch(
        `/api/contact-center/interactions/by-call-control-id?callControlId=${encodeURIComponent(
          callControlId,
        )}`,
      )
        .then((res) => res.json())
        .then((data) => {
          if (data.ok && data.interaction) {
            if (
              data.interaction.id === interactionId ||
              data.interaction.call_control_id === callControlId
            ) {
              setSelectedInteraction(data.interaction);
            }
          }
        })
        .catch((err) => {
          // Failed to auto-refresh interaction
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
        interaction.call_control_id === selectedInteraction.call_control_id,
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
    const wasDisconnected =
      disconnectedTime &&
      disconnectedTime > 0 &&
      disconnectedTime !== lastDisconnectedTimeRef.current;
    lastStatusRef.current = callStatus;
    if (wasDisconnected) {
      lastDisconnectedTimeRef.current = disconnectedTime;

      // When call disconnects, refresh interactions list to remove it
      // This ensures timeout re-enqueued calls are immediately removed
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("contact-center:refresh-interactions"),
        );
      }, 300);
    }

    // Trigger wrapup check if call ended, cleared, or disconnected
    if (!isEnded && !isCleared && !wasDisconnected) {
      return;
    }

    const interactionId =
      callInteractionId || lastInteractionSnapshotRef.current;
    if (!interactionId) {
      return;
    }
    if (lastWrapupInteractionRef.current === interactionId) {
      return;
    }

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
                `[AgentDesktop] Skipping wrapup for interaction ${interactionId} - timeout re-enqueued`,
              );
              return; // Don't open wrapup sheet at all
            }
          }
        } catch (timeoutCheckErr) {
          // If timeout check fails, continue with normal check
          console.warn("[AgentDesktop] Timeout check failed:", timeoutCheckErr);
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

        // If still no interaction found after retry, check timeout again before defaulting
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
                  `[AgentDesktop] Skipping wrapup for interaction ${interactionId} - timeout re-enqueued (no interaction found)`,
                );
                return;
              }
            }
          } catch (timeoutCheckErr) {
            // Continue if check fails
          }

          // Default to opening wrapup sheet only if not timeout
          lastWrapupInteractionRef.current = interactionId;
          // Use global wrapup sheet store
          import("@/lib/stores/wrapup-sheet-store").then((module) => {
            module.default
              .getState()
              .openWrapup(interactionId, lastTranscriptionsRef.current || []);
          });
          return;
        }

        // Check metadata for hangup cause and timeline events
        const metadata = interaction.metadata || {};
        const wasTimeoutReEnqueued = metadata.timeout_re_enqueued === true;
        const routingMetadata = metadata.routing_metadata || {};
        const timeline = routingMetadata.timeline || [];

        // Double-check timeout flag from interaction
        if (wasTimeoutReEnqueued) {
          console.log(
            `[AgentDesktop] Skipping wrapup for interaction ${interactionId} - timeout re-enqueued (from interaction metadata)`,
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
        const disconnectedEvent = timeline.find(
          (e) => e.type === "disconnected",
        );
        const hangupCause =
          disconnectedEvent?.hangupCause || metadata.hangup_cause;
        const wasRejected =
          hangupCause === "CALL_REJECTED" ||
          hangupCause === "NO_ANSWER" ||
          hangupCause === "user_busy" ||
          hangupCause === "timeout";

        // Check if call was in "queued" state when it ended (abandoned before answer)
        const wasQueuedWhenEnded = interaction.state === "queued";

        // Skip wrapup if:
        // 1. Timeout re-enqueued (agent didn't answer - status already set to "Agent Not Answering")
        // 2. Call was still in queued state when it ended (abandoned before answer), OR
        // 3. Call was explicitly marked as abandoned AND was never answered
        // This ensures agent disconnects (which are answered calls) always show wrapup
        // but timeout scenarios don't show wrapup (status is already "Agent Not Answering")
        //
        // Note: If call was answered (has answered_at or answered event), always show wrapup
        // even if state is "abandoned" (might be a timing issue or incorrect state update)
        const shouldSkip =
          wasTimeoutReEnqueued ||
          wasQueuedWhenEnded ||
          (isAbandoned && !wasAnswered);

        if (!shouldSkip) {
          // Open wrapup sheet - call was connected and ended (including agent disconnects)
          lastWrapupInteractionRef.current = interactionId;
          // Use global wrapup sheet store
          import("@/lib/stores/wrapup-sheet-store").then((module) => {
            module.default
              .getState()
              .openWrapup(interactionId, lastTranscriptionsRef.current || []);
          });
        }
      } catch (err) {
        // Error checking interaction for wrapup
        console.error("[AgentDesktop] Error in checkAndOpenWrapup:", err);
      }
    };

    checkAndOpenWrapup();
  }, [callStatus, callInteractionId, interactions, disconnectedTime]);

  // Also watch for interactions changing to "completed" state
  // This catches cases where callStatus doesn't update but interaction state does
  // Track which completed interactions we've already processed
  const processedCompletedInteractionsRef = useRef(new Set());

  useEffect(() => {
    // Find interactions that just became completed and haven't been processed
    const completedInteractions = interactions.filter(
      (interaction) =>
        interaction.state === "completed" &&
        interaction.id !== lastWrapupInteractionRef.current &&
        !processedCompletedInteractionsRef.current.has(interaction.id),
    );

    // Process completed interactions asynchronously
    (async () => {
      for (const interaction of completedInteractions) {
        // Mark as processed immediately to avoid duplicate processing
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
                `[AgentDesktop] Skipping wrapup for interaction ${interaction.id} - timeout re-enqueued (completed interaction)`,
              );
              continue; // Skip this interaction, check next one
            }
          }
        } catch (timeoutCheckErr) {
          // If timeout check fails, continue with normal check
          console.warn(
            "[AgentDesktop] Timeout check failed for completed interaction:",
            timeoutCheckErr,
          );
        }

        // Check if this interaction was answered
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

        // Skip wrapup if:
        // - Timeout re-enqueued (agent didn't answer - status already set to "Agent Not Answering")
        // - Abandoned and never answered
        // - Still queued when ended
        const shouldSkip =
          wasTimeoutReEnqueued ||
          wasQueuedWhenEnded ||
          (isAbandoned && !wasActuallyAnswered);

        if (!shouldSkip && wasActuallyAnswered) {
          lastWrapupInteractionRef.current = interaction.id;
          // Use global wrapup sheet store
          import("@/lib/stores/wrapup-sheet-store").then((module) => {
            module.default
              .getState()
              .openWrapup(interaction.id, lastTranscriptionsRef.current || []);
          });
          break; // Only open for the first completed interaction
        }
      }
    })();
  }, [interactions]);

  // Listen for manual disconnect events and open global wrapup sheet
  useEffect(() => {
    const handleCallDisconnected = async (event) => {
      const { interactionId, transcriptions } = event.detail || {};
      if (!interactionId) return;

      // Check if we've already shown wrapup for this interaction
      if (lastWrapupInteractionRef.current === interactionId) {
        return;
      }

      // Find the interaction to check if it was answered
      const interaction = interactions.find((i) => i.id === interactionId);
      if (interaction) {
        const metadata = interaction.metadata || {};
        const wasTimeoutReEnqueued = metadata.timeout_re_enqueued === true;
        const wasAnswered = Boolean(interaction.answered_at);
        const isAbandoned = interaction.state === "abandoned";
        const wasQueuedWhenEnded = interaction.state === "queued";

        // Skip wrapup if:
        // - Timeout re-enqueued (agent didn't answer)
        // - Abandoned and never answered
        // - Still queued when ended
        const shouldSkip =
          wasTimeoutReEnqueued ||
          wasQueuedWhenEnded ||
          (isAbandoned && !wasAnswered);

        if (!shouldSkip) {
          lastWrapupInteractionRef.current = interactionId;
          // Use global wrapup sheet store
          const { default: useWrapupSheetStore } =
            await import("@/lib/stores/wrapup-sheet-store");
          useWrapupSheetStore
            .getState()
            .openWrapup(interactionId, transcriptions || []);
        }
      } else {
        // If interaction not found, assume it was answered and show wrapup
        lastWrapupInteractionRef.current = interactionId;
        // Use global wrapup sheet store
        const { default: useWrapupSheetStore } =
          await import("@/lib/stores/wrapup-sheet-store");
        useWrapupSheetStore
          .getState()
          .openWrapup(interactionId, transcriptions || []);
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
            webrtcCallState={useActiveCallStore()}
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
    </div>
  );
}
