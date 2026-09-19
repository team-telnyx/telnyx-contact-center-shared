import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const useAppStateStore = create(
  persist(
    (set) => ({
      supervisorCallHistoryDateRange: null,
      workspaceLastMenu: {},

      setSupervisorCallHistoryDateRange: (dateRange) =>
        set({
          supervisorCallHistoryDateRange:
            dateRange && typeof dateRange === "object"
              ? {
                  range: dateRange.range,
                  from: String(dateRange.from || ""),
                  to: String(dateRange.to || ""),
                }
              : null,
        }),

      setWorkspaceLastMenu: (workspace, url) =>
        set((state) => ({
          workspaceLastMenu: {
            ...state.workspaceLastMenu,
            [String(workspace)]: String(url),
          },
        })),
    }),
    {
      name: "app-state-store",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        supervisorCallHistoryDateRange: state.supervisorCallHistoryDateRange,
        workspaceLastMenu: state.workspaceLastMenu,
      }),
    },
  ),
);

export default useAppStateStore;
