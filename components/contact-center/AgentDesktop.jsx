"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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
  const lastRefreshAttemptRef = useRef(new Map()); // Track refresh attempts to avoid infinite loops

  // Get WebRTC call state for real-time updates (hold, mute, status)
  const webrtcCallState = useActiveCallStore();

  // Get calls from calls store
  const callsStore = useCallsStore();

  const buildInteractionsWithStore = useCallback(
    (dbInteractions) => {
      const activeCalls = callsStore
        .getActiveCalls()
        .filter(
          (call) =>
            call.interactionId || call.originalCallControlId || call.queueName
        );

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
            from_name: storeCall.callerName || interaction.from_name,
            from_number: storeCall.callerNumber || interaction.from_number,
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
    [callsStore]
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

  // No polling or initial fetch; rely on store updates for interactions

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
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-md bg-primary/10">
                <Info className="h-4 w-4 text-primary" />
              </div>
              <h2 className="text-base font-semibold text-foreground">
                Interaction Details
              </h2>
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
