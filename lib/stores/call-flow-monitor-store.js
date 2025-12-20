/**
 * Call Flow Monitor Store (Zustand)
 *
 * Manages call flow monitoring events across the application.
 * Events persist across navigation and page refreshes (until cleared).
 * Syncs with server-side call-monitor-store for persistence.
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";

const useCallFlowMonitorStore = create(
  devtools(
    (set, get) => ({
      // State: Map serialized as object for Zustand compatibility
      // { [flowId]: { events: Array, currentCallControlId: string } }
      flowData: {},

      /**
       * Get events for a specific flow
       */
      getFlowEvents: (flowId) => {
        const data = get().flowData[flowId];
        return data?.events || [];
      },

      /**
       * Get current call control ID for a flow
       */
      getCurrentCallControlId: (flowId) => {
        const data = get().flowData[flowId];
        return data?.currentCallControlId || null;
      },

      /**
       * Set events for a flow (replaces existing events)
       */
      setFlowEvents: (flowId, events, currentCallControlId = null) => {
        const flowData = { ...get().flowData };
        flowData[flowId] = {
          events: events || [],
          currentCallControlId:
            currentCallControlId ||
            flowData[flowId]?.currentCallControlId ||
            null,
        };
        set({ flowData }, false, `setFlowEvents:${flowId}`);
      },

      /**
       * Add events to a flow (appends to existing events)
       */
      addFlowEvents: (flowId, newEvents, currentCallControlId = null) => {
        const flowData = { ...get().flowData };
        const existing = flowData[flowId] || {
          events: [],
          currentCallControlId: null,
        };

        // Merge events, avoiding duplicates by ID
        const existingIds = new Set(existing.events.map((e) => e.id));
        const uniqueNewEvents = newEvents.filter((e) => !existingIds.has(e.id));

        const updatedEvents = [...existing.events, ...uniqueNewEvents].sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );

        flowData[flowId] = {
          events: updatedEvents,
          currentCallControlId:
            currentCallControlId || existing.currentCallControlId,
        };
        set({ flowData }, false, `addFlowEvents:${flowId}`);
      },

      /**
       * Update current call control ID for a flow
       */
      setCurrentCallControlId: (flowId, callControlId) => {
        const flowData = { ...get().flowData };
        const existing = flowData[flowId] || {
          events: [],
          currentCallControlId: null,
        };
        flowData[flowId] = {
          ...existing,
          currentCallControlId: callControlId,
        };
        set({ flowData }, false, `setCurrentCallControlId:${flowId}`);
      },

      /**
       * Clear events for a specific flow
       */
      clearFlowEvents: (flowId) => {
        const flowData = { ...get().flowData };
        delete flowData[flowId];
        set({ flowData }, false, `clearFlowEvents:${flowId}`);
      },

      /**
       * Clear all flow events
       */
      clearAllFlowEvents: () => {
        set({ flowData: {} }, false, "clearAllFlowEvents");
      },

      /**
       * Check if flow has events
       */
      hasFlowEvents: (flowId) => {
        const data = get().flowData[flowId];
        return data && data.events && data.events.length > 0;
      },
    }),
    {
      name: "call-flow-monitor-store",
      enabled: process.env.NODE_ENV === "development",
    }
  )
);

// Selector hooks for optimized rendering
// These use stable selectors to avoid SSR issues
// We subscribe to the entire flowData object (stable reference) and extract the value
export const useFlowEvents = (flowId) => {
  // Subscribe to the entire flowData object - this selector is stable
  const flowData = useCallFlowMonitorStore((state) => state.flowData);
  // Extract the specific flow's events - this is safe because flowData reference only changes when data changes
  return flowData[flowId]?.events || [];
};

export const useFlowCurrentCallControlId = (flowId) => {
  // Subscribe to the entire flowData object - this selector is stable
  const flowData = useCallFlowMonitorStore((state) => state.flowData);
  // Extract the specific flow's call control ID
  return flowData[flowId]?.currentCallControlId || null;
};

export default useCallFlowMonitorStore;
