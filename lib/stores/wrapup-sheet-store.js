/**
 * Wrapup Sheet Store (Zustand)
 *
 * Global state for the wrapup codes sheet that works across the entire application
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";

const useWrapupSheetStore = create(
  devtools(
    (set) => ({
      open: false,
      interactionId: null,
      transcriptions: [],

      openWrapup: (interactionId, transcriptions = []) => {
        set(
          {
            open: true,
            interactionId,
            transcriptions: Array.isArray(transcriptions) ? transcriptions : [],
          },
          false,
          "openWrapup"
        );
      },

      closeWrapup: () => {
        set(
          {
            open: false,
            interactionId: null,
            transcriptions: [],
          },
          false,
          "closeWrapup"
        );
      },
    }),
    {
      name: "wrapup-sheet-store",
      enabled: process.env.NODE_ENV === "development",
    }
  )
);

export default useWrapupSheetStore;

