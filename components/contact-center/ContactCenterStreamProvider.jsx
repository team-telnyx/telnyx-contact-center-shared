"use client";

import { useEffect } from "react";
import useCallsStore from "@/lib/stores/calls-store";
import useActiveCallStore from "@/lib/stores/active-call-store";
import useWorkflowStore from "@/lib/stores/workflow-store";

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
                  transcription_key:
                    data.transcription.transcription_key || data.transcriptionKey,
                  transcript: data.transcription.transcript,
                  is_final: data.transcription.is_final,
                  speech_final: data.transcription.speech_final,
                  transcription_track: data.transcription.track,
                  call_control_id: data.callControlId,
                  confidence: data.transcription.confidence,
                  source: data.transcription.source,
                  provider: data.transcription.provider,
                  model: data.transcription.model,
                  language: data.transcription.language,
                  translation: data.transcription.translation || null,
                });

                const updateTranscriptionAnalysis =
                  useActiveCallStore.getState().updateTranscriptionAnalysis;
                if (updateTranscriptionAnalysis && data.transcription.intent) {
                  updateTranscriptionAnalysis(
                    data.transcription.transcription_key || data.transcriptionKey,
                    {
                      intent: data.transcription.intent,
                      sentiment: data.transcription.sentiment,
                      sentimentScore: data.transcription.sentimentScore,
                      tags: data.transcription.tags || [],
                    }
                  );
                }
              }
            } else if (data.type === "transcription_update") {
              const updateTranscriptionAnalysis =
                useActiveCallStore.getState().updateTranscriptionAnalysis;
              if (updateTranscriptionAnalysis && data.transcriptionKey) {
                updateTranscriptionAnalysis(data.transcriptionKey, data.updates || {});
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
                    metadata: data.updates.metadata || callData.metadata || {},
                  });
                }
              }
              if (data.updates?.metadata) {
                const activeState = useActiveCallStore.getState();
                const activeInteractionId = activeState.contactCenter?.interactionId;
                if (!data.interactionId || !activeInteractionId || data.interactionId === activeInteractionId) {
                  activeState.setContactCenterMetadata?.({ metadata: data.updates.metadata });
                }
              }
              // Dispatch event to trigger interaction list refresh
              window.dispatchEvent(
                new CustomEvent("contact-center:refresh-interactions"),
              );
            } else if (data.type === "ai_handoff_data") {
              window.dispatchEvent(
                new CustomEvent("contact-center:ai-handoff-data", { detail: data }),
              );
            } else if (data.type === "wrapup_required") {
              window.dispatchEvent(
                new CustomEvent("contact-center:wrapup-required", { detail: data }),
              );
            } else if (data.type === "interaction_ended") {
              if (data.callControlId) {
                useCallsStore
                  .getState()
                  .updateCallStatus(data.callControlId, "ended");
              }
              if (data.interactionId) {
                useCallsStore.getState().removeCall(data.interactionId);
                // Clear active call + workflow state only if this is the currently active interaction.
                // Guard prevents clearing a NEW call's state when an old call's ended event arrives late.
                const activeInteractionId = useActiveCallStore.getState().contactCenter?.interactionId;
                if (activeInteractionId && String(activeInteractionId) === String(data.interactionId)) {
                  useActiveCallStore.getState().clearActiveCall();
                  useWorkflowStore.getState().clearSession();
                }
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
