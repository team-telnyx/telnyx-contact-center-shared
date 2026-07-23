/**
 * Workflow Store (Zustand)
 *
 * Client-side state management for Agent Assist Workflow.
 * Manages workflow session state, stages, items, and slots.
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";

const useWorkflowStore = create(
  devtools(
    (set, get) => ({
      // Which interaction the store's session state belongs to right now. Set
      // by clearSession/fetchSession and checked by any async action before it
      // applies a late-arriving response, so a slow request for a call that
      // has since ended can't silently repopulate a newer call's cleared state.
      activeInteractionId: null,

      // Session state
      session: null, // {id, interaction_id, workflow_id, status, started_at, ...}
      workflowName: null,
      workflowCategory: null,

      // Stages and items
      stages: [], // Array of stages with items
      currentStageIndex: 0,

      // Item statuses (keyed by item_id)
      itemStatuses: {}, // {item_id: {status, completed_at, extracted_value, ...}}

      // Filled slots
      slotsFilled: {}, // {slot_name: value}

      // Progress tracking
      totalItems: 0,
      completedItems: 0,
      skippedItems: 0,
      completionPercentage: 0,

      // Loading states
      isLoading: false,
      isAnalyzing: false,
      // Internal in-flight counter backing isAnalyzing. analyzeTranscript calls
      // can now run in parallel (a debounced batch of utterances fires together
      // instead of sequentially) — a plain boolean would flip to false as soon
      // as the FIRST of several concurrent calls finished, hiding the "still
      // analyzing" indicator while others in the same batch are still running.
      _analyzingCount: 0,
      error: null,

      // AI Handoff state
      aiHandoff: {
        isAiAssisted: false,       // True if interaction has ai_call_control_id
        aiDataReceived: false,     // True when AI data has been received
        aiDataLoading: false,      // True while waiting for AI data
        aiSummary: null,           // Markdown summary from AI
        aiSentiment: null,         // Sentiment analysis from AI
        slotsDetails: {},          // Full slot data with confidence scores
        receivedAt: null,          // When AI data was received
      },

      // ==================
      // Actions
      // ==================

      /**
       * Set the entire session state (from API response)
       */
      setSession: (sessionData) => {
        if (!sessionData) {
          get().clearSession();
          return;
        }

        // Extract item statuses from stages
        const itemStatuses = {};
        sessionData.stages?.forEach((stage) => {
          stage.items?.forEach((item) => {
            if (item.status) {
              itemStatuses[item.id] = item.status;
            }
          });
        });

        set(
          {
            session: {
              id: sessionData.id,
              interaction_id: sessionData.interaction_id,
              workflow_id: sessionData.workflow_id,
              current_stage_id: sessionData.current_stage_id,
              status: sessionData.status,
              started_at: sessionData.started_at,
              completed_at: sessionData.completed_at,
              agent_name: sessionData.agent_name,
              data_action_buttons: Array.isArray(sessionData.data_action_buttons) ? sessionData.data_action_buttons : [],
            },
            workflowName: sessionData.workflow_name,
            workflowCategory: sessionData.workflow_category,
            stages: sessionData.stages || [],
            currentStageIndex: sessionData.currentStageIndex || 0,
            itemStatuses,
            slotsFilled: sessionData.slots_filled || {},
            totalItems: sessionData.totalItems || 0,
            completedItems: sessionData.completedItems || 0,
            skippedItems: sessionData.skippedItems || 0,
            completionPercentage: sessionData.completionPercentage || 0,
            error: null,
          },
          false,
          "setSession"
        );
      },

      /**
       * Clear session state. Pass the interaction being switched TO (if any) so
       * fetchSession/analyzeTranscript calls still in flight for the PREVIOUS
       * interaction can recognize they're stale once they resolve, instead of
       * silently repopulating this freshly-cleared state with the old call's
       * data (see activeInteractionId).
       */
      clearSession: (nextInteractionId = null) => {
        set(
          {
            activeInteractionId: nextInteractionId,
            session: null,
            workflowName: null,
            workflowCategory: null,
            stages: [],
            currentStageIndex: 0,
            itemStatuses: {},
            slotsFilled: {},
            totalItems: 0,
            completedItems: 0,
            skippedItems: 0,
            completionPercentage: 0,
            isLoading: false,
            isAnalyzing: false,
            _analyzingCount: 0,
            error: null,
            aiHandoff: {
              isAiAssisted: false,
              aiDataReceived: false,
              aiDataLoading: false,
              aiSummary: null,
              aiSentiment: null,
              slotsDetails: {},
              receivedAt: null,
            },
          },
          false,
          "clearSession"
        );
      },

      /**
       * Set AI-assisted flag (when interaction has ai_call_control_id)
       */
      setAiAssisted: (isAssisted) => {
        set(
          (state) => ({
            aiHandoff: {
              ...state.aiHandoff,
              isAiAssisted: isAssisted,
              aiDataLoading: isAssisted && !state.aiHandoff.aiDataReceived,
            },
          }),
          false,
          "setAiAssisted"
        );
      },

      /**
       * Set AI data loading state
       */
      setAiDataLoading: (loading) => {
        set(
          (state) => ({
            aiHandoff: {
              ...state.aiHandoff,
              aiDataLoading: loading,
            },
          }),
          false,
          "setAiDataLoading"
        );
      },

      /**
       * Apply AI handoff data received from SSE or polling
       */
      applyAiHandoffData: (data) => {
        const state = get();
        
        // Update AI handoff state
        set(
          {
            aiHandoff: {
              ...state.aiHandoff,
              aiDataReceived: true,
              aiDataLoading: false,
              aiSummary: data.summary || null,
              aiSentiment: data.sentiment || null,
              slotsDetails: data.slots_details || {},
              receivedAt: data.received_at || new Date().toISOString(),
            },
          },
          false,
          "applyAiHandoffData:aiHandoff"
        );

        // Merge slots_filled
        const newSlotsFilled = { ...state.slotsFilled };
        for (const [key, val] of Object.entries(data.slots_filled || {})) {
          if (!newSlotsFilled[key]) {
            newSlotsFilled[key] = val;
          }
        }
        set({ slotsFilled: newSlotsFilled }, false, "applyAiHandoffData:slots");

        // Update item statuses for AI-filled slots
        const newStatuses = { ...state.itemStatuses };
        let hasChanges = false;

        for (const stage of state.stages) {
          for (const item of stage.items || []) {
            if (item.slot_name && data.slots_details?.[item.slot_name]) {
              const slotDetail = data.slots_details[item.slot_name];
              const currentStatus = newStatuses[item.id];
              
              // Don't overwrite agent-completed items
              if (currentStatus?.completed_by === "agent") continue;
              
              const value = slotDetail?.value ?? slotDetail;
              const confidence = slotDetail?.confidence;
              
              if (value !== null && value !== undefined) {
                const confidenceThreshold = slotDetail?.confidence_threshold ?? 0.95;
                const hasTrustedSlotValue = Object.prototype.hasOwnProperty.call(data.slots_filled || {}, item.slot_name);
                const nextStatus = slotDetail?.status || (hasTrustedSlotValue || confidence === undefined || confidence >= confidenceThreshold ? "completed" : "suggested");

                newStatuses[item.id] = {
                  ...currentStatus,
                  status: nextStatus,
                  extracted_value: value,
                  confidence_score: confidence,
                  confidence_threshold: confidenceThreshold,
                  completed_by: slotDetail?.completed_by || "ai",
                  completed_at: nextStatus === "completed" ? (slotDetail?.completed_at || new Date().toISOString()) : null,
                  source_transcript: slotDetail?.source_utterance,
                  alternatives: Array.isArray(slotDetail?.alternatives) ? slotDetail.alternatives : [],
                };
                hasChanges = true;
              }
            }
          }
        }

        if (hasChanges) {
          // Recalculate completion stats
          const completed = Object.values(newStatuses).filter(
            (s) => s.status === "completed"
          ).length;
          const skipped = Object.values(newStatuses).filter(
            (s) => s.status === "skipped"
          ).length;
          const total = state.totalItems;
          const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

          set(
            {
              itemStatuses: newStatuses,
              completedItems: completed,
              skippedItems: skipped,
              completionPercentage: percentage,
            },
            false,
            "applyAiHandoffData:statuses"
          );
        }
      },

      /**
       * Update a single item status
       */
      updateItemStatus: (itemId, statusData) => {
        const state = get();
        const newStatuses = {
          ...state.itemStatuses,
          [itemId]: {
            ...state.itemStatuses[itemId],
            ...statusData,
          },
        };

        // Recalculate completion stats
        const completed = Object.values(newStatuses).filter(
          (s) => s.status === "completed"
        ).length;
        const skipped = Object.values(newStatuses).filter(
          (s) => s.status === "skipped"
        ).length;
        const total = state.totalItems;
        const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

        set(
          {
            itemStatuses: newStatuses,
            completedItems: completed,
            skippedItems: skipped,
            completionPercentage: percentage,
          },
          false,
          "updateItemStatus"
        );
      },

      /**
       * Update a slot value
       */
      updateSlot: (slotName, value) => {
        const state = get();
        set(
          {
            slotsFilled: {
              ...state.slotsFilled,
              [slotName]: value,
            },
          },
          false,
          "updateSlot"
        );
      },

      /**
       * Go to next stage
       */
      nextStage: () => {
        const state = get();
        const nextIndex = state.currentStageIndex + 1;
        if (nextIndex < state.stages.length) {
          set(
            {
              currentStageIndex: nextIndex,
            },
            false,
            "nextStage"
          );
        }
      },

      /**
       * Go to previous stage
       */
      prevStage: () => {
        const state = get();
        const prevIndex = state.currentStageIndex - 1;
        if (prevIndex >= 0) {
          set(
            {
              currentStageIndex: prevIndex,
            },
            false,
            "prevStage"
          );
        }
      },

      /**
       * Go to specific stage
       */
      goToStage: (index) => {
        const state = get();
        if (index >= 0 && index < state.stages.length) {
          set(
            {
              currentStageIndex: index,
            },
            false,
            "goToStage"
          );
        }
      },

      /**
       * Set loading state
       */
      setLoading: (loading) => {
        set({ isLoading: loading }, false, "setLoading");
      },

      /**
       * Set analyzing state
       */
      setAnalyzing: (analyzing) => {
        set({ isAnalyzing: analyzing }, false, "setAnalyzing");
      },

      /**
       * Set error
       */
      setError: (error) => {
        set({ error }, false, "setError");
      },

      // ==================
      // API Actions
      // ==================

      /**
       * Start a workflow session
       */
      startWorkflow: async (interactionId, workflowId) => {
        set({ isLoading: true, error: null, activeInteractionId: interactionId }, false, "startWorkflow:loading");

        try {
          const response = await fetch("/api/agent-assist/workflow/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ interactionId, workflowId }),
          });

          const data = await response.json();

          // A second caller (e.g. two open tabs, or any other source of a
          // duplicate start attempt) can lose a race and hit 409 "already
          // exists" — recover by fetching the session the winner just created
          // instead of surfacing an error and leaving no session loaded.
          if (response.status === 409) {
            return get().fetchSession(interactionId);
          }

          if (!response.ok) {
            throw new Error(data.error || "Failed to start workflow");
          }

          // A newer call may have started (clearSession/fetchSession updated
          // activeInteractionId) while this request was in flight — don't let
          // a late response for an ended call repopulate the current session.
          if (get().activeInteractionId !== interactionId) {
            console.warn("[WorkflowStore] Dropping stale startWorkflow response", {
              requestInteractionId: interactionId,
              activeInteractionId: get().activeInteractionId,
            });
            return null;
          }

          get().setSession(data.session);
          return data.session;
        } catch (error) {
          if (get().activeInteractionId === interactionId) {
            set({ error: error.message, isLoading: false }, false, "startWorkflow:error");
          }
          throw error;
        }
      },

      /**
       * Fetch current session state
       */
      fetchSession: async (interactionId) => {
        set({ isLoading: true, error: null, activeInteractionId: interactionId }, false, "fetchSession:loading");

        try {
          const url = new URL("/api/agent-assist/workflow/session", window.location.origin);
          url.searchParams.set("interactionId", interactionId);

          const response = await fetch(url.toString(), {
            credentials: "include",
          });

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Failed to fetch session");
          }

          // A newer call may have started (clearSession/fetchSession/startWorkflow
          // updated activeInteractionId) while this request was in flight — a
          // late response for the PREVIOUS call must not repopulate the newer
          // one's state.
          if (get().activeInteractionId !== interactionId) {
            console.warn("[WorkflowStore] Dropping stale fetchSession response", {
              requestInteractionId: interactionId,
              activeInteractionId: get().activeInteractionId,
            });
            return null;
          }

          if (data.session) {
            get().setSession(data.session);
          } else {
            get().clearSession(interactionId);
          }

          set({ isLoading: false }, false, "fetchSession:complete");
          return data.session;
        } catch (error) {
          if (get().activeInteractionId === interactionId) {
            set({ error: error.message, isLoading: false }, false, "fetchSession:error");
          }
          throw error;
        }
      },

      /**
       * Analyze transcript for item completion
       */
      analyzeTranscript: async (transcript, speaker, recentContext = []) => {
        const state = get();
        if (!state.session) return null;
        // Captured up front: this request can take several seconds (LLM round
        // trip). If the call ends and a new one starts before it resolves, its
        // results must not be applied to the new call's session.
        const requestInteractionId = state.activeInteractionId;

        set(
          (state) => ({ _analyzingCount: state._analyzingCount + 1, isAnalyzing: true }),
          false,
          "analyzeTranscript:analyzing"
        );

        try {
          const response = await fetch("/api/agent-assist/workflow/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              sessionId: state.session.id,
              transcript,
              speaker,
              // Preceding utterances (esp. the agent's question) so the analyzer
              // can interpret a bare answer like "No"/"ICU".
              recentContext,
            }),
          });

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Failed to analyze transcript");
          }

          if (get().activeInteractionId !== requestInteractionId) {
            console.warn("[WorkflowStore] Dropping stale analyzeTranscript response", {
              requestInteractionId,
              activeInteractionId: get().activeInteractionId,
            });
            return null;
          }

          // Update local state with completed or suggested items
          if (data.updates) {
            for (const update of data.updates) {
              if (update.status === "pending" || update.cleared_reason) {
                // The analyzer un-collected a slot (e.g. a first-name that
                // duplicated the last name). Reset it so the checklist un-crosses
                // it and the suggested response re-asks. The slot's value is also
                // cleared to null in the merged slotsFilled below.
                get().updateItemStatus(update.item_id, {
                  status: "pending",
                  extracted_value: null,
                  confidence_score: null,
                  low_confidence: false,
                  alternatives: [],
                  // Mirror the server reset: null the completion metadata too.
                  // updateItemStatus MERGES, so a stale completed_by: "agent"
                  // would otherwise linger and make applyAiHandoffData keep
                  // rejecting the reopened slot until a full refetch.
                  completed_by: null,
                  completed_at: null,
                  source_transcript: null,
                  is_correction: false,
                });
                continue;
              }
              if (update.status === "completed" || update.status === "suggested") {
                get().updateItemStatus(update.item_id, {
                  status: update.status,
                  confidence_score: update.confidence,
                  confidence_threshold: update.confidence_threshold,
                  low_confidence: update.low_confidence,
                  extracted_value: update.extracted_value,
                  completed_by: update.completed_by || "ai",
                  // Carry the analyzer's source utterance so the slot→transcript
                  // jump (FDE-534) works in the live path, not just after a DB
                  // refetch. The analyze route returns it as `source_text`.
                  source_transcript: update.source_text,
                  // Clear any alternatives carried over from a prior insights
                  // extraction: the live analyzer produced a fresh value/source
                  // and does not emit alternatives, so old chips would be stale
                  // under the new value (FDE-535). Mirrors the analyze route
                  // setting `alternatives = NULL`.
                  alternatives: update.alternatives ?? [],
                  // Correction candidates (read-back stage only — see
                  // analyze/route.js) are always surfaced as "suggested"
                  // regardless of confidence. capturedSlotValue in
                  // generate-suggestion/route.js needs this flag to prefer
                  // the newly-corrected value over the OLD confirmed value
                  // still sitting in slots_filled.
                  is_correction: update.is_correction === true,
                });
              }
            }
          }

          // Update slots. MERGE into existing state rather than replacing it:
          // analyze responses can arrive out of order (slow model → overlapping
          // requests), and an older response carrying a stale snapshot would
          // otherwise wipe a slot a newer response already filled — making the
          // suggested response re-target an already-filled slot (e.g. a boolean
          // `false`). The server merges atomically too; this guards the UI.
          if (data.slotsFilled && typeof data.slotsFilled === "object") {
            set(
              (state) => ({ slotsFilled: { ...state.slotsFilled, ...data.slotsFilled } }),
              false,
              "analyzeTranscript:slots"
            );
          }

          // Update completion percentage
          if (typeof data.completionPercentage === "number") {
            set(
              { completionPercentage: data.completionPercentage },
              false,
              "analyzeTranscript:completion"
            );
          }

          set(
            (state) => {
              const nextCount = Math.max(0, state._analyzingCount - 1);
              return { _analyzingCount: nextCount, isAnalyzing: nextCount > 0 };
            },
            false,
            "analyzeTranscript:complete"
          );
          return data;
        } catch (error) {
          set(
            (state) => {
              const nextCount = Math.max(0, state._analyzingCount - 1);
              return { _analyzingCount: nextCount, isAnalyzing: nextCount > 0 };
            },
            false,
            "analyzeTranscript:error"
          );
          console.error("[WorkflowStore] Analyze error:", error);
          return null;
        }
      },

      /**
       * Manually complete an item
       */
      completeItem: async (itemId, value = null) => {
        const state = get();
        if (!state.session) return;

        try {
          const response = await fetch(
            `/api/agent-assist/workflow/item/${itemId}/complete`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                sessionId: state.session.id,
                value,
              }),
            }
          );

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Failed to complete item");
          }

          // Update local state
          get().updateItemStatus(itemId, {
            status: "completed",
            completed_at: new Date().toISOString(),
            completed_by: "agent",
            extracted_value: value,
            confidence_score: 1.0,
            // updateItemStatus MERGES — clear a stale is_correction: true left
            // over from being surfaced as a correction candidate (see
            // analyze/route.js), now that it's manually confirmed/completed.
            is_correction: false,
          });

          // Update completion percentage
          if (typeof data.completionPercentage === "number") {
            set(
              { completionPercentage: data.completionPercentage },
              false,
              "completeItem:completion"
            );
          }

          return data;
        } catch (error) {
          console.error("[WorkflowStore] Complete item error:", error);
          throw error;
        }
      },

      /**
       * Skip an item
       */
      skipItem: async (itemId) => {
        const state = get();
        if (!state.session) return;

        try {
          const response = await fetch(
            `/api/agent-assist/workflow/item/${itemId}/skip`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                sessionId: state.session.id,
              }),
            }
          );

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Failed to skip item");
          }

          // Update local state
          get().updateItemStatus(itemId, {
            status: "skipped",
            completed_at: new Date().toISOString(),
            completed_by: "agent",
          });

          return data;
        } catch (error) {
          console.error("[WorkflowStore] Skip item error:", error);
          throw error;
        }
      },

      /**
       * Update a slot value
       */
      updateSlotValue: async (slotName, value) => {
        const state = get();
        if (!state.session) return;

        try {
          const response = await fetch(
            `/api/agent-assist/workflow/slot/${encodeURIComponent(slotName)}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                sessionId: state.session.id,
                value,
              }),
            }
          );

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Failed to update slot");
          }

          // Update local state
          get().updateSlot(slotName, value);

          return data;
        } catch (error) {
          console.error("[WorkflowStore] Update slot error:", error);
          throw error;
        }
      },
    }),
    {
      name: "workflow-store",
      enabled: process.env.NODE_ENV === "development",
    }
  )
);

// Selector hooks for optimized rendering
export const useWorkflowSession = () => useWorkflowStore((state) => state.session);
export const useWorkflowStages = () => useWorkflowStore((state) => state.stages);
export const useCurrentStageIndex = () => useWorkflowStore((state) => state.currentStageIndex);
export const useCurrentStage = () => {
  const stages = useWorkflowStore((state) => state.stages);
  const currentIndex = useWorkflowStore((state) => state.currentStageIndex);
  return stages[currentIndex] || null;
};
export const useSlotsFilled = () => useWorkflowStore((state) => state.slotsFilled);
export const useWorkflowProgress = () => {
  const totalItems = useWorkflowStore((state) => state.totalItems);
  const completedItems = useWorkflowStore((state) => state.completedItems);
  const completionPercentage = useWorkflowStore((state) => state.completionPercentage);
  return { totalItems, completedItems, completionPercentage };
};
export const useItemStatus = (itemId) => {
  return useWorkflowStore((state) => state.itemStatuses[itemId] || { status: "pending" });
};
export const useIsAnalyzing = () => useWorkflowStore((state) => state.isAnalyzing);

// AI Handoff selectors
export const useAiHandoff = () => useWorkflowStore((state) => state.aiHandoff);
export const useIsAiAssisted = () => useWorkflowStore((state) => state.aiHandoff.isAiAssisted);
export const useAiDataReceived = () => useWorkflowStore((state) => state.aiHandoff.aiDataReceived);
export const useAiDataLoading = () => useWorkflowStore((state) => state.aiHandoff.aiDataLoading);
export const useAiSummary = () => useWorkflowStore((state) => state.aiHandoff.aiSummary);
export const useAiSentiment = () => useWorkflowStore((state) => state.aiHandoff.aiSentiment);

export default useWorkflowStore;
