"use client";

import { useEffect } from "react";
import useCallsStore from "@/lib/stores/calls-store";
import useActiveCallStore from "@/lib/stores/active-call-store";
import useWorkflowStore from "@/lib/stores/workflow-store";
import { subscribeStatusStream, applyCoreSnapshot } from "@/lib/status-stream-client";
import {
  clearAllIncomingCallData,
  storeIncomingCallData,
} from "@/lib/incoming-call-store";

export function ContactCenterStreamProvider({ children }) {
  useEffect(() => {
    let contactCenterEventSource = null;
    let reconnectTimeout = null;
    let acdCursor = "0";

    const connectContactCenterStream = () => {
      try {
        contactCenterEventSource = new EventSource(
          `/api/contact-center/agent/stream?after=${encodeURIComponent(acdCursor)}`,
        );

        contactCenterEventSource.addEventListener("acd_sync", (event) => {
          try {
            const data = JSON.parse(event.data);
            acdCursor = event.lastEventId || data.cursor || acdCursor;
            if (!data.snapshot) return;
            applyCoreSnapshot(data.snapshot);
            for (const item of data.snapshot.interactions || []) {
              if (item.channel && item.channel !== "voice") continue;
              if (item.terminal_at || !item.owns_live_assignment) {
                useCallsStore.getState().removeCall(item.interaction_id);
                if (item.call_control_id) useCallsStore.getState().removeCall(item.call_control_id);
                const current = useActiveCallStore.getState().contactCenter?.interactionId;
                if (current && String(current) === String(item.interaction_id)) {
                  useActiveCallStore.getState().clearActiveCall();
                  useWorkflowStore.getState().clearSession();
                }
              } else if (item.call_control_id && ["offered", "active"].includes(item.state)) {
                useCallsStore.getState().addCall({ callControlId: item.call_control_id, interactionId: item.interaction_id,
                  callerNumber: item.customer_address, direction: item.direction,
                  status: item.state === "active" ? "connected" : "ringing",
                  metadata: { work_item_id: item.work_item_id,
                    original_call_control_id: item.call_control_id, agent_assist_config: item.agent_assist_config || {} } });
              }
            }
            window.dispatchEvent(new CustomEvent("contact-center:refresh-interactions"));
            window.dispatchEvent(new CustomEvent("contact-center:acd-state", { detail: data.snapshot }));
          } catch { /* a reconnect replays the last committed cursor */ }
        });

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

            if (data.type === "transcription") {
              const activeInteractionId =
                useActiveCallStore.getState().contactCenter?.interactionId;
              if (
                data.interactionId &&
                activeInteractionId &&
                String(data.interactionId) !== String(activeInteractionId)
              ) {
                return;
              }
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
            } else if (data.type === "ai_handoff_data") {
              window.dispatchEvent(
                new CustomEvent("contact-center:ai-handoff-data", { detail: data }),
              );
            } else if (data.type === "acd_intent_updated") {
              window.dispatchEvent(
                new CustomEvent("contact-center:acd-intent-updated", { detail: data }),
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
    return subscribeStatusStream("incoming_call_info", (data) => {
      if (!data?.interactionId) return;

      const info = { ...data, timestamp: Date.now() };
      for (const key of [
        data.callControlId,
        data.callSessionId ? `session:${data.callSessionId}` : null,
        data.fromNumber ? `phone:${data.fromNumber}` : null,
        "__latest_incoming__",
      ]) {
        if (key) storeIncomingCallData(key, info);
      }

      const contactCenter = data.contactCenter || {};
      useActiveCallStore.getState().setContactCenterMetadata?.({
        interactionId: data.interactionId,
        queueName: contactCenter.queueName || data.queueName || null,
        queuedAt: contactCenter.queuedAt || data.queuedAt || null,
        assignedAt: contactCenter.assignedAt || data.assignedAt || Date.now(),
        customerId: contactCenter.customerId || null,
        customerData: contactCenter.customerData || null,
        metadata: data.metadata || {},
      });

      useCallsStore.getState().addCall({
        callControlId: data.callControlId || data.originalCallControlId,
        callSessionId: data.callSessionId || null,
        originalCallControlId: data.originalCallControlId || null,
        interactionId: data.interactionId,
        callerName: data.fromName || null,
        callerNumber: data.fromNumber || null,
        queueName: contactCenter.queueName || data.queueName || null,
        direction: "inbound",
        status: "ringing",
        queuedAt: contactCenter.queuedAt || data.queuedAt || null,
        assignedAt: contactCenter.assignedAt || data.assignedAt || Date.now(),
        customerId: contactCenter.customerId || null,
        customerData: contactCenter.customerData || null,
        metadata: data.metadata || {},
      });

      window.dispatchEvent(
        new CustomEvent("contact-center:refresh-interactions"),
      );
    });
  }, []);

  useEffect(() => {
    const clearCallStores = () => {
      try {
        useCallsStore.getState().clearAllCalls();
        useActiveCallStore.getState().clearActiveCall();
        clearAllIncomingCallData();
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
