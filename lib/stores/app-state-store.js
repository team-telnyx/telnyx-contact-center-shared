import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const useAppStateStore = create(
  persist(
    (set) => ({
      supervisorCallHistoryDateRange: null,

      setSupervisorCallHistoryDateRange: (dateRange) =>
        set({
          supervisorCallHistoryDateRange:
            dateRange && typeof dateRange === "object"
              ? {
                  from: String(dateRange.from || ""),
                  to: String(dateRange.to || ""),
                }
              : null,
        }),
    }),
    {
      name: "app-state-store",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        supervisorCallHistoryDateRange: state.supervisorCallHistoryDateRange,
      }),
    },
  ),
);

export default useAppStateStore;
