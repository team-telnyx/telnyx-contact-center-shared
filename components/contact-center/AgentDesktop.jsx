"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { InteractionsList } from "./InteractionsList";
import { InteractionDetail } from "./InteractionDetail";
import { Card } from "@/components/ui/card";
import { Info } from "lucide-react";
import useActiveCallStore from "@/lib/stores/active-call-store";
import useCallsStore from "@/lib/stores/calls-store";

export function AgentDesktop() {
  const [selectedInteraction, setSelectedInteraction] = useState(null);
  const [interactions, setInteractions] = useState([]);
  const [currentUsername, setCurrentUsername] = useState(null);
  const lastRefreshAttemptRef = useRef(new Map()); // Track refresh attempts to avoid infinite loops

  // Get WebRTC call state for real-time updates (hold, mute, status)
  const webrtcCallState = useActiveCallStore();

  // Get calls from calls store
  const callsStore = useCallsStore();
  const storedCalls = callsStore.getAllCalls();

  // Initialize calls store on mount (ensures it's visible in dev tools)
  useEffect(() => {
    // Access the store to ensure it's initialized
    callsStore.getAllCalls();
  }, [callsStore]);

  // Load interactions immediately on mount (always, even when navigating back)
  useEffect(() => {
    const loadInteractionsOnMount = async () => {
      try {
        const res = await fetch(
          "/api/contact-center/agent/interactions?limit=10&activeOnly=true"
        );
        const data = await res.json();
        if (data.ok) {
          const dbInteractions = data.interactions || [];

          // Merge with calls from store (for calls that might not be in DB yet)
          const storeCallMap = new Map();
          storedCalls.forEach((call) => {
            if (call.interactionId) {
              storeCallMap.set(call.interactionId, call);
            }
          });

          // Enhance DB interactions with store data
          const enhancedInteractions = dbInteractions.map((interaction) => {
            const storeCall = storeCallMap.get(interaction.id);
            if (storeCall) {
              return {
                ...interaction,
                // Override with store data if available
                from_name: storeCall.callerName || interaction.from_name,
                from_number: storeCall.callerNumber || interaction.from_number,
                queue_name: storeCall.queueName || interaction.queue_name,
              };
            }
            return interaction;
          });

          setInteractions(enhancedInteractions);
          if (enhancedInteractions.length > 0) {
            setSelectedInteraction((current) => {
              if (!current) {
                return enhancedInteractions[0];
              }
              return current;
            });
          }
        }
      } catch (err) {
        // Silently handle errors
      }
    };

    loadInteractionsOnMount();

    // Reload interactions periodically to catch any missed updates
    const reloadInteractions = async () => {
      try {
        const res = await fetch(
          "/api/contact-center/agent/interactions?limit=10&activeOnly=true"
        );
        const data = await res.json();
        if (data.ok) {
          const dbInteractions = data.interactions || [];

          // Merge with calls from store
          const storeCallMap = new Map();
          callsStore.getAllCalls().forEach((call) => {
            if (call.interactionId) {
              storeCallMap.set(call.interactionId, call);
            }
          });

          // Enhance DB interactions with store data
          const enhancedInteractions = dbInteractions.map((interaction) => {
            const storeCall = storeCallMap.get(interaction.id);
            if (storeCall) {
              return {
                ...interaction,
                from_name: storeCall.callerName || interaction.from_name,
                from_number: storeCall.callerNumber || interaction.from_number,
                queue_name: storeCall.queueName || interaction.queue_name,
              };
            }
            return interaction;
          });

          setInteractions((prev) => {
            // Merge with existing interactions to preserve temporary ones from SSE
            const merged = [...enhancedInteractions];
            prev.forEach((existing) => {
              const existsInDb = enhancedInteractions.find(
                (db) =>
                  (db.id && db.id === existing.id) ||
                  (db.call_control_id &&
                    db.call_control_id === existing.call_control_id)
              );
              if (!existsInDb) {
                merged.push(existing);
              }
            });

            // Remove duplicates
            const seen = new Set();
            return merged.filter((i) => {
              const key = i.call_control_id || i.id;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          });

          // Auto-select first active if none selected
          setSelectedInteraction((current) => {
            if (!current) {
              return enhancedInteractions.length > 0
                ? enhancedInteractions[0]
                : null;
            }
            // Update selected interaction if it exists in the new list
            if (current) {
              const updated = enhancedInteractions.find(
                (i) =>
                  i.id === current.id ||
                  i.call_control_id === current.call_control_id
              );
              if (updated) {
                return updated;
              }
              // If not found in active list (e.g., completed) OR if from_number is missing/empty, try to refresh it from DB
              const needsRefresh =
                !current.from_number || current.from_number.trim() === "";
              const interactionId = current.id;
              const callControlId = current.call_control_id;
              const lastAttempt =
                lastRefreshAttemptRef.current.get(interactionId);
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
            return current;
          });
        }
      } catch (err) {
        // Silently handle errors
      }
    };

    // Reload more frequently to catch calls that started while away
    const interval = setInterval(reloadInteractions, 3000);
    return () => clearInterval(interval);
  }, []);

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

  // Set up SSE connection for real-time updates
  useEffect(() => {
    let contactCenterEventSource = null;
    let reconnectTimeout = null;

    const connectContactCenterStream = () => {
      try {
        contactCenterEventSource = new EventSource(
          "/api/contact-center/agent/stream"
        );

        contactCenterEventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            if (data.type === "new_interaction") {
              // New interaction from queue - immediately add to list
              if (data.interaction) {
                const tempInteraction = {
                  id:
                    data.interaction.id ||
                    `temp-${data.interaction.callControlId}`,
                  call_control_id: data.interaction.callControlId,
                  call_session_id: data.interaction.callSessionId,
                  direction: "inbound",
                  state: data.interaction.state || "ringing",
                  from_number:
                    data.interaction.fromNumber ||
                    data.interaction.callerNumber ||
                    "",
                  to_number: data.interaction.toNumber || "",
                  from_name:
                    data.interaction.fromName ||
                    data.interaction.callerName ||
                    null,
                  queue_name: data.interaction.queueName || "",
                  interaction_type: "voice",
                  is_contact_center: true,
                  created_at: new Date().toISOString(),
                };

                // Add to calls store
                if (data.interaction.callControlId) {
                  callsStore.addCall({
                    callControlId: data.interaction.callControlId,
                    callSessionId: data.interaction.callSessionId,
                    interactionId: data.interaction.id,
                    callerName:
                      data.interaction.fromName || data.interaction.callerName,
                    callerNumber:
                      data.interaction.fromNumber ||
                      data.interaction.callerNumber,
                    queueName: data.interaction.queueName,
                    queueId: data.interaction.queueId,
                    queuedAt: data.interaction.queuedAt,
                    assignedAt: data.interaction.assignedAt,
                    direction: "inbound",
                    status: "ringing",
                  });
                }

                setInteractions((prev) => {
                  const exists = prev.find(
                    (i) =>
                      i.id === tempInteraction.id ||
                      i.call_control_id === tempInteraction.call_control_id
                  );
                  if (exists) {
                    return prev.map((i) =>
                      i.id === tempInteraction.id ||
                      i.call_control_id === tempInteraction.call_control_id
                        ? { ...i, ...tempInteraction }
                        : i
                    );
                  }
                  return [tempInteraction, ...prev];
                });

                setSelectedInteraction((current) => {
                  if (!current) {
                    return tempInteraction;
                  }
                  return current;
                });
              }
            } else if (data.type === "transcription") {
              // Handle transcription events for Agent Assist (same as demo portal)
              console.log("[AgentDesktop] Received transcription:", data);

              // Add transcription to active call store
              const addTranscription =
                useActiveCallStore.getState().addTranscription;
              if (addTranscription && data.transcription) {
                addTranscription({
                  transcript: data.transcription.transcript,
                  is_final: data.transcription.is_final,
                  transcription_track: data.transcription.track,
                  call_control_id: data.callControlId,
                });

                // Update with analysis results
                const updateTranscriptionAnalysis =
                  useActiveCallStore.getState().updateTranscriptionAnalysis;
                if (updateTranscriptionAnalysis && data.transcription.intent) {
                  // Find the last transcription (the one we just added)
                  const transcriptions =
                    useActiveCallStore.getState().transcriptions;
                  const lastTranscription =
                    transcriptions[transcriptions.length - 1];

                  if (lastTranscription) {
                    updateTranscriptionAnalysis(lastTranscription.id, {
                      intent: data.transcription.intent,
                      sentiment: data.transcription.sentiment,
                      sentimentScore: data.transcription.sentimentScore,
                      tags: data.transcription.tags || [],
                    });
                  }
                }
              }
            } else if (data.type === "interaction_updated") {
              // Update interaction metadata
              setInteractions((prev) =>
                prev.map((i) => {
                  if (
                    i.id === data.interactionId ||
                    i.call_control_id === data.callControlId
                  ) {
                    return { ...i, ...data.updates };
                  }
                  return i;
                })
              );

              // Update calls store if we have callControlId
              if (data.callControlId && data.updates) {
                const callData = callsStore.getCall(data.callControlId);
                if (callData) {
                  callsStore.updateCall(data.callControlId, {
                    status: data.updates.state || callData.status,
                    callerName: data.updates.from_name || callData.callerName,
                    callerNumber:
                      data.updates.from_number || callData.callerNumber,
                    queueName: data.updates.queue_name || callData.queueName,
                  });
                }
              }

              // Update selected interaction if it's the one being updated
              setSelectedInteraction((current) => {
                if (
                  current &&
                  (current.id === data.interactionId ||
                    current.call_control_id === data.callControlId)
                ) {
                  return { ...current, ...data.updates };
                }
                return current;
              });
            } else if (data.type === "interaction_ended") {
              // Update calls store - mark call as ended
              if (data.callControlId) {
                const callData = callsStore.getCall(data.callControlId);
                if (callData) {
                  callsStore.updateCall(data.callControlId, {
                    status: "ended",
                    disconnectedTime: Date.now(),
                  });
                }
              }

              // Remove interaction from list when call ends
              setInteractions((prev) =>
                prev.filter((i) => {
                  if (
                    i.id === data.interactionId ||
                    i.call_control_id === data.callControlId
                  ) {
                    return false;
                  }
                  return true;
                })
              );

              // Clear selection if it was the selected interaction
              setSelectedInteraction((current) => {
                if (
                  current &&
                  (current.id === data.interactionId ||
                    current.call_control_id === data.callControlId)
                ) {
                  return null;
                }
                return current;
              });
            }
          } catch (err) {
            // Silently handle parse errors
          }
        };

        contactCenterEventSource.onerror = (error) => {
          if (contactCenterEventSource) {
            contactCenterEventSource.close();
            contactCenterEventSource = null;
          }
          if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
          }
          reconnectTimeout = setTimeout(() => {
            connectContactCenterStream();
          }, 3000);
        };
      } catch (err) {
        reconnectTimeout = setTimeout(() => {
          connectContactCenterStream();
        }, 3000);
      }
    };

    connectContactCenterStream();

    return () => {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (contactCenterEventSource) {
        contactCenterEventSource.close();
      }
    };
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Main Content */}
      <div className="flex gap-4 flex-1 min-h-0 overflow-hidden">
        {/* Left Panel - Interactions List */}
        <Card className="w-80 flex-shrink-0 flex flex-col overflow-hidden">
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
            <div className="flex items-center justify-center flex-1 text-muted-foreground">
              <p>Select an interaction to view details</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
