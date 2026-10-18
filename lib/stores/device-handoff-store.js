/**
 * Device Handoff Store (Zustand)
 *
 * The one "Move call" dialog and what opens it: the softphone card, the mini
 * phone, "Calls on", and the host when a call starts moving to this browser.
 * Also this user's voice calls in progress anywhere (polled by
 * DeviceHandoffHost), which those entry points read instead of polling again.
 */

import { create } from "zustand";

const useDeviceHandoffStore = create((set) => ({
  /** The interaction (work item) the dialog is open for, or null. */
  interactionId: null,
  /** The id of this browser's call the dialog was opened for: its end confirms a move away. */
  sourceCallId: null,
  /** This user's voice interactions in progress, on any device; null before the first read. */
  interactions: null,
  /** What the Contact Center last said of each of those calls this browser could take over: { [id]: { canTakeOver, ownerLabel } }. */
  takeOvers: {},
  /** Bumped to ask the mini phone (the call's audio owner) to answer the ringing call. */
  answerRequest: 0,

  openHandoff: (interactionId, { sourceCallId = null } = {}) => set({ interactionId, sourceCallId }),
  closeHandoff: () => set({ interactionId: null, sourceCallId: null }),
  setInteractions: (interactions) => set((state) => ({ interactions,
    // Forget the calls that ended.
    takeOvers: Object.fromEntries(Object.entries(state.takeOvers).filter(([id]) => interactions?.some((i) => String(i.id) === id))) })),
  setTakeOver: (interactionId, takeOver) => set((state) => ({ takeOvers: { ...state.takeOvers, [String(interactionId)]: takeOver } })),
  requestAnswer: () => set((state) => ({ answerRequest: state.answerRequest + 1 })),
}));

export default useDeviceHandoffStore;
