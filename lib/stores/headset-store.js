"use client";

import { create } from "zustand";

const useHeadsetStore = create((set) => ({
  enabled: false,
  status: "disabled",
  device: null,
  lastCommand: null,
  diagnostics: [],
  setEnabled: (enabled) => set({ enabled }),
  setStatus: (status) => set({ status }),
  setDevice: (device) => set({ device, status: device?.connectionState || (device ? "connected" : "disconnected") }),
  recordCommand: (command) => set((state) => ({
    lastCommand: command,
    diagnostics: [
      { type: "command", command, at: new Date().toISOString() },
      ...state.diagnostics,
    ].slice(0, 20),
  })),
  recordDiagnostic: (message, level = "info") => set((state) => ({
    diagnostics: [
      { type: "diagnostic", level, message, at: new Date().toISOString() },
      ...state.diagnostics,
    ].slice(0, 20),
  })),
}));

export default useHeadsetStore;
