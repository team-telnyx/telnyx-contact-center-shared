/**
 * Dial Store (Zustand)
 *
 * Manages dial state for outbound calls
 * Separate from active call store to keep concerns separated
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

const useDialStore = create(
  persist(
    (set) => ({
      toNumber: "",
      fromNumber: "",

      setToNumber: (number) => set({ toNumber: String(number || "") }),
      setFromNumber: (number) => set({ fromNumber: String(number || "") }),

      clear: () => set({ toNumber: "", fromNumber: "" }),
    }),
    {
      name: "dial-store",
      // Persist toNumber for quick redial
      partialize: (state) => ({ toNumber: state.toNumber }),
    }
  )
);

export default useDialStore;
