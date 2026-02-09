"use client";

import { useEffect } from "react";
import useCallsStore from "@/lib/stores/calls-store";
import useActiveCallStore from "@/lib/stores/active-call-store";

export function ContactCenterStreamProvider({ children }) {
  useEffect(() => {
    let contactCenterEventSource = null;
    let reconnectTimeout = null;

    const connectContactCenterStream = () => {
      try {
        contactCenterEventSource = new EventSource(
          "/api/contact-center/agent/stream",
        );

        // Listen for connection event to refresh interactions list
        contactCenterEventSource.addEventListener("connected", () => {
          // Refresh interactions list when SSE connects/reconnects to ensure latest state
          window.dispatchEvent(
            new CustomEvent("contact-center:refresh-interactions"),
          );
        });

        contactCenterEventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            if (data.type === "new_interaction") {
              if (data.interaction?.callControlId) {
                // First, add to calls store with SSE data
                useCallsStore.getState().addCall({
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
                  aiCallControlId:
                    data.interaction.aiCallControlId ||
                    data.interaction.metadata?.ai_call_control_id ||
                    null,
                  queuedAt: data.interaction.queuedAt,
                  assignedAt: data.interaction.assignedAt,
                  direction: "inbound",
                  status: data.interaction.state || "ringing",
                  // Include full metadata for agent assist config
                  metadata: data.interaction.metadata || {},
                });

                // Then, fetch full interaction from DB by call_session_id to get complete metadata
                // This ensures we have agent_assist_config even if SSE data was incomplete
                if (data.interaction.callSessionId) {
                  fetch(`/api/contact-center/interactions/by-call-session-id?callSessionId=${encodeURIComponent(data.interaction.callSessionId)}`)
                    .then(res => res.json())
                    .then(result => {
                      if (result.ok && result.interaction?.metadata) {
                        // Update calls store with full metadata from DB
                        useCallsStore.getState().updateCall(data.interaction.callControlId, {
                          metadata: result.interaction.metadata,
                        });
                        // Trigger refresh to update UI
                        window.dispatchEvent(
                          new CustomEvent("contact-center:refresh-interactions"),
                        );
                      }
                    })
                    .catch(err => {
                      console.error("[ContactCenterStreamProvider] Failed to fetch full interaction:", err);
                    });
                }
              }
              // Dispatch event to trigger interaction list refresh
              window.dispatchEvent(
                new CustomEvent("contact-center:refresh-interactions"),
              );
            } else if (data.type === "transcription") {
              const addTranscription =
                useActiveCallStore.getState().addTranscription;
              if (addTranscription && data.transcription) {
                addTranscription({
                  transcript: data.transcription.transcript,
                  is_final: data.transcription.is_final,
                  transcription_track: data.transcription.track,
                  call_control_id: data.callControlId,
                });

                const updateTranscriptionAnalysis =
                  useActiveCallStore.getState().updateTranscriptionAnalysis;
                if (updateTranscriptionAnalysis && data.transcription.intent) {
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
              if (data.callControlId && data.updates) {
                const callData = useCallsStore
                  .getState()
                  .getCall(data.callControlId);
                if (callData) {
                  useCallsStore.getState().updateCall(data.callControlId, {
                    status: data.updates.state || callData.status,
                    callerName: data.updates.from_name || callData.callerName,
                    callerNumber:
                      data.updates.from_number || callData.callerNumber,
                    queueName: data.updates.queue_name || callData.queueName,
                    aiCallControlId:
                      data.updates.metadata?.ai_call_control_id ||
                      callData.aiCallControlId ||
                      null,
                  });
                }
              }
              // Dispatch event to trigger interaction list refresh
              window.dispatchEvent(
                new CustomEvent("contact-center:refresh-interactions"),
              );
            } else if (data.type === "interaction_ended") {
              if (data.callControlId) {
                useCallsStore
                  .getState()
                  .updateCallStatus(data.callControlId, "ended");
              }
              if (data.interactionId) {
                useCallsStore.getState().removeCall(data.interactionId);
              }
              // Dispatch event to trigger interaction list refresh
              window.dispatchEvent(
                new CustomEvent("contact-center:refresh-interactions"),
              );
            }
          } catch (_) {
            // Silently handle parse errors
          }
        };

        contactCenterEventSource.onerror = () => {
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
      } catch (_) {
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

  useEffect(() => {
    const clearCallStores = () => {
      try {
        useCallsStore.getState().clearAllCalls();
        useActiveCallStore.getState().clearActiveCall();
        localStorage.removeItem("calls-store");
        localStorage.removeItem("active-call-store");
      } catch (_) {}
    };

    const handlePageHide = () => {
      clearCallStores();
    };

    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handlePageHide);
    };
  }, []);

  return children;
}
