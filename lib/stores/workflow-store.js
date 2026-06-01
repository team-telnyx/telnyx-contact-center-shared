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
       * Clear session state
       */
      clearSession: () => {
        set(
          {
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
                newStatuses[item.id] = {
                  ...currentStatus,
                  status: "completed",
                  extracted_value: value,
                  confidence_score: confidence,
                  completed_by: "ai",
                  completed_at: new Date().toISOString(),
                  source_transcript: slotDetail?.source_utterance,
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
        set({ isLoading: true, error: null }, false, "startWorkflow:loading");

        try {
          const response = await fetch("/api/agent-assist/workflow/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ interactionId, workflowId }),
          });

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Failed to start workflow");
          }

          get().setSession(data.session);
          return data.session;
        } catch (error) {
          set({ error: error.message, isLoading: false }, false, "startWorkflow:error");
          throw error;
        }
      },

      /**
       * Fetch current session state
       */
      fetchSession: async (interactionId) => {
        set({ isLoading: true, error: null }, false, "fetchSession:loading");

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

          if (data.session) {
            get().setSession(data.session);
          } else {
            get().clearSession();
          }

          set({ isLoading: false }, false, "fetchSession:complete");
          return data.session;
        } catch (error) {
          set({ error: error.message, isLoading: false }, false, "fetchSession:error");
          throw error;
        }
      },

      /**
       * Analyze transcript for item completion
       */
      analyzeTranscript: async (transcript, speaker, options = {}) => {
        const state = get();
        if (!state.session) return null;

        set({ isAnalyzing: true }, false, "analyzeTranscript:analyzing");

        try {
          const response = await fetch("/api/agent-assist/workflow/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              sessionId: state.session.id,
              transcript,
              speaker,
              confidence: options.confidence,
            }),
          });

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Failed to analyze transcript");
          }

          // Update local state with any completed items
          if (data.updates) {
            for (const update of data.updates) {
              if (update.status === "completed" || (update.status === "pending" && update.extracted_value)) {
                get().updateItemStatus(update.item_id, {
                  status: update.status,
                  completed_by: update.completed_by,
                  confidence_score: update.confidence,
                  extracted_value: update.extracted_value,
                  below_threshold: update.below_threshold,
                  threshold: update.threshold,
                  transcription_confidence: update.transcription_confidence,
                });
              }
            }
          }

          // Update slots
          if (data.slotsFilled) {
            set({ slotsFilled: data.slotsFilled }, false, "analyzeTranscript:slots");
          }

          // Update completion percentage
          if (typeof data.completionPercentage === "number") {
            set(
              { completionPercentage: data.completionPercentage },
              false,
              "analyzeTranscript:completion"
            );
          }

          set({ isAnalyzing: false }, false, "analyzeTranscript:complete");
          return data;
        } catch (error) {
          set({ isAnalyzing: false }, false, "analyzeTranscript:error");
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
            verified_by_agent: true,
            agent_verified_at: new Date().toISOString(),
            below_threshold: false,
            extracted_value: value,
            confidence_score: 1.0,
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
