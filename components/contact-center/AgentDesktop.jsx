"use client";

import { useState, useEffect, useRef } from "react";
import { InteractionsList } from "./InteractionsList";
import { InteractionDetail } from "./InteractionDetail";
import { Card } from "@/components/ui/card";
import { Info } from "lucide-react";
import useActiveCallStore from "@/lib/stores/active-call-store";

export function AgentDesktop() {
  const [selectedInteraction, setSelectedInteraction] = useState(null);
  const [interactions, setInteractions] = useState([]);
  const [currentUsername, setCurrentUsername] = useState(null);

  // Get WebRTC call state for real-time updates (hold, mute, status)
  const webrtcCallState = useActiveCallStore();

  // Load interactions immediately on mount (always, even when navigating back)
  useEffect(() => {
    const loadInteractionsOnMount = async () => {
      try {
        console.log("[AgentDesktop] Loading interactions on mount...");
        const res = await fetch(
          "/api/contact-center/agent/interactions?limit=10&activeOnly=true"
        );
        const data = await res.json();
        if (data.ok) {
          const dbInteractions = data.interactions || [];
          console.log(
            "[AgentDesktop] Loaded interactions on mount:",
            dbInteractions.length,
            dbInteractions
          );
          setInteractions(dbInteractions);
          if (dbInteractions.length > 0) {
            setSelectedInteraction((current) => {
              if (!current) {
                return dbInteractions[0];
              }
              return current;
            });
          }
        } else {
          console.warn("[AgentDesktop] Failed to load interactions:", data);
        }
      } catch (err) {
        console.error("Failed to load interactions on mount:", err);
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
          setInteractions((prev) => {
            // Merge with existing interactions to preserve temporary ones from SSE
            const merged = [...dbInteractions];
            prev.forEach((existing) => {
              const existsInDb = dbInteractions.find(
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
              return dbInteractions.length > 0 ? dbInteractions[0] : null;
            }
            // Update selected interaction if it exists in the new list
            if (current) {
              const updated = dbInteractions.find(
                (i) =>
                  i.id === current.id ||
                  i.call_control_id === current.call_control_id
              );
              if (updated) {
                return updated; // Return updated version
              }
            }
            return current;
          });
        }
      } catch (err) {
        console.error("Failed to reload interactions:", err);
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
        console.error("Failed to load username:", err);
      }
    };
    loadUsername();
  }, []);

  // Set up SSE connection for real-time updates
  useEffect(() => {
    let contactCenterEventSource = null;
    let reconnectTimeout = null;

    const connectContactCenterStream = () => {
      try {
        console.log(
          "[AgentDesktop] Connecting to contact center SSE stream..."
        );
        contactCenterEventSource = new EventSource(
          "/api/contact-center/agent/stream"
        );

        contactCenterEventSource.onopen = () => {
          console.log("[AgentDesktop] Contact center SSE stream connected");
        };

        contactCenterEventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log("[AgentDesktop] Received SSE event:", data.type);

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
                  from_number: data.interaction.fromNumber || "",
                  to_number: data.interaction.toNumber || "",
                  from_name: data.interaction.fromName || null,
                  queue_name: data.interaction.queueName || "",
                  interaction_type: "voice",
                  is_contact_center: true,
                  created_at: new Date().toISOString(),
                };

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
                  // Auto-select new interaction if none selected
                  if (!current) {
                    return tempInteraction;
                  }
                  return current;
                });
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
            console.error("Failed to parse contact center SSE message:", err);
          }
        };

        contactCenterEventSource.onerror = (error) => {
          console.warn(
            "[AgentDesktop] Contact center stream error, will reconnect:",
            error
          );
          if (contactCenterEventSource) {
            contactCenterEventSource.close();
            contactCenterEventSource = null;
          }
          // Clear any existing reconnect timeout
          if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
          }
          // Reconnect after a delay
          reconnectTimeout = setTimeout(() => {
            console.log("[AgentDesktop] Reconnecting to SSE stream...");
            connectContactCenterStream();
          }, 3000);
        };
      } catch (err) {
        console.error(
          "[AgentDesktop] Failed to connect to contact center stream:",
          err
        );
        // Retry connection
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
