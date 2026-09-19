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
      segmentId: null,
      transcriptions: [],

      openWrapup: (interactionId, transcriptions = [], segmentId = null) => {
        // Note: We don't check timeout here because this store is client-side
        // The timeout check happens in WrapupCodesSheet component via API calls
        // This keeps the store lightweight and avoids importing server-side modules
        set(
          (state) => {
            const nextTranscriptions = Array.isArray(transcriptions)
              ? transcriptions
              : [];
            if (state.open && state.interactionId === interactionId && (!segmentId || state.segmentId === segmentId)) {
              if (
                state.transcriptions.length === 0 &&
                nextTranscriptions.length > 0
              ) {
                return { ...state, transcriptions: nextTranscriptions };
              }
              return state;
            }
            return {
              open: true,
              interactionId,
              segmentId,
              transcriptions: nextTranscriptions,
            };
          },
          false,
          "openWrapup",
        );
      },

      closeWrapup: () => {
        set(
          {
            open: false,
            interactionId: null,
            segmentId: null,
            transcriptions: [],
          },
          false,
          "closeWrapup",
        );
      },
    }),
    {
      name: "wrapup-sheet-store",
      enabled: process.env.NODE_ENV === "development",
    },
  ),
);

export default useWrapupSheetStore;
