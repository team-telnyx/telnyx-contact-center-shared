/**
 * Calls Store (Zustand)
 *
 * Manages multiple calls for an agent simultaneously.
 * Each call is stored with detailed information including caller name, number, queue, etc.
 * State persists across page navigation.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { devtools } from "zustand/middleware";

const useCallsStore = create(
  devtools(
    persist(
      (set, get) => ({
        // Calls table: Map of callControlId -> call data
        calls: {},

        /**
         * Add or update a call in the store
         * Called when a call is offered to the agent
         */
        addCall: (callData) => {
          const {
            callControlId,
            callSessionId,
            originalCallControlId,
            originalCallSessionId,
            rtcCallId,
            interactionId,
            callerName,
            callerNumber,
            queueName,
            queueId,
            direction = "inbound",
            status = "ringing",
            callStartTime = Date.now(),
            answerTime = null,
            connectedTime = null,
            disconnectedTime = null,
            holdCount = 0,
            totalHoldDuration = 0,
            currentHoldStartTime = null,
            transferCount = 0,
            transferHistory = [],
            transcriptions = [],
            isMuted = false,
            isHeld = false,
            isRinging = true,
            duration = 0,
            fromName = null,
            fromNumber = null,
            toNumber = null,
            queuedAt = null,
            assignedAt = null,
            customerId = null,
            customerData = null,
          } = callData;

          // Use callControlId as the key, or generate one if not provided
          const key = callControlId || `temp-${Date.now()}-${Math.random()}`;

          set(
            (state) => ({
              calls: {
                ...state.calls,
                [key]: {
                  callControlId: key,
                  callSessionId,
                  originalCallControlId,
                  originalCallSessionId,
                  rtcCallId,
                  interactionId,
                  callerName: callerName || fromName,
                  callerNumber: callerNumber || fromNumber,
                  queueName,
                  queueId,
                  direction,
                  status,
                  callStartTime,
                  answerTime,
                  connectedTime,
                  disconnectedTime,
                  holdCount,
                  totalHoldDuration,
                  currentHoldDuration: 0,
                  currentHoldStartTime,
                  transferCount,
                  transferHistory,
                  transcriptions,
                  isMuted,
                  isHeld,
                  isRinging,
                  duration,
                  fromName: callerName || fromName,
                  fromNumber: callerNumber || fromNumber,
                  toNumber,
                  queuedAt,
                  assignedAt,
                  customerId,
                  customerData,
                  updatedAt: Date.now(),
                },
              },
            }),
            false,
            "addCall"
          );
        },

        /**
         * Update an existing call
         */
        updateCall: (callControlId, updates) => {
          set(
            (state) => {
              const call = state.calls[callControlId];
              if (!call) {
                console.warn(
                  `[CallsStore] Call ${callControlId} not found for update`
                );
                return state;
              }

              return {
                calls: {
                  ...state.calls,
                  [callControlId]: {
                    ...call,
                    ...updates,
                    updatedAt: Date.now(),
                  },
                },
              };
            },
            false,
            "updateCall"
          );
        },

        /**
         * Remove a call from the store
         */
        removeCall: (callControlId) => {
          set(
            (state) => {
              const { [callControlId]: removed, ...remaining } = state.calls;
              return { calls: remaining };
            },
            false,
            "removeCall"
          );
        },

        /**
         * Get a call by callControlId
         */
        getCall: (callControlId) => {
          return get().calls[callControlId] || null;
        },

        /**
         * Get all calls as an array
         */
        getAllCalls: () => {
          return Object.values(get().calls);
        },

        /**
         * Get active calls (not completed/ended)
         */
        getActiveCalls: () => {
          const allCalls = get().getAllCalls();
          return allCalls.filter(
            (call) =>
              call.status !== "completed" &&
              call.status !== "abandoned" &&
              call.status !== "ended" &&
              call.status !== "hangup" &&
              call.status !== "idle" &&
              call.status !== "terminated" &&
              !call.disconnectedTime
          );
        },

        /**
         * Update call status
         */
        updateCallStatus: (callControlId, status) => {
          const updates = { status };

          // Update timing based on status
          if (
            status === "active" ||
            status === "connected" ||
            status === "answered"
          ) {
            const call = get().calls[callControlId];
            if (call && !call.answerTime) {
              updates.answerTime = Date.now();
              updates.connectedTime = Date.now();
              updates.isRinging = false;
            }
          } else if (
            ["hangup", "ended", "destroy", "idle", "terminated"].includes(
              status
            )
          ) {
            const call = get().calls[callControlId];
            if (call && !call.disconnectedTime) {
              updates.disconnectedTime = Date.now();
            }
          }

          get().updateCall(callControlId, updates);
        },

        /**
         * Update hold state
         */
        setCallHeld: (callControlId, isHeld) => {
          const call = get().calls[callControlId];
          if (!call) return;

          const updates = { isHeld };

          if (isHeld && !call.currentHoldStartTime) {
            // Starting hold
            updates.currentHoldStartTime = Date.now();
            updates.holdCount = call.holdCount + 1;
          } else if (!isHeld && call.currentHoldStartTime) {
            // Ending hold
            const holdDuration = Math.floor(
              (Date.now() - call.currentHoldStartTime) / 1000
            );
            updates.totalHoldDuration = call.totalHoldDuration + holdDuration;
            updates.currentHoldStartTime = null;
          }

          get().updateCall(callControlId, updates);
        },

        /**
         * Update mute state
         */
        setCallMuted: (callControlId, isMuted) => {
          get().updateCall(callControlId, { isMuted });
        },

        /**
         * Update call duration (called periodically for active calls)
         */
        updateCallDuration: (callControlId, duration) => {
          get().updateCall(callControlId, { duration });
        },

        /**
         * Add transcription to a call
         */
        addTranscription: (callControlId, transcriptionData) => {
          const call = get().calls[callControlId];
          if (!call) return;

          const transcription = {
            id: `${Date.now()}-${Math.random()}`,
            timestamp: new Date().toISOString(),
            transcript: transcriptionData.transcript || "",
            isFinal: transcriptionData.is_final || false,
            track: transcriptionData.transcription_track || "inbound",
            callControlId: transcriptionData.call_control_id || callControlId,
            intent: null,
            sentiment: null,
            sentimentScore: null,
          };

          get().updateCall(callControlId, {
            transcriptions: [...call.transcriptions, transcription],
          });
        },

        /**
         * Record a transfer
         */
        recordTransfer: (callControlId, transferData) => {
          const call = get().calls[callControlId];
          if (!call) return;

          const transferEntry = {
            timestamp: new Date().toISOString(),
            to: transferData.to || null,
            type: transferData.type || "external",
            callControlId:
              transferData.callControlId || call.originalCallControlId || null,
          };

          get().updateCall(callControlId, {
            transferCount: call.transferCount + 1,
            transferHistory: [...call.transferHistory, transferEntry],
          });
        },

        /**
         * Clear all calls (useful for cleanup)
         */
        clearAllCalls: () => {
          set({ calls: {} }, false, "clearAllCalls");
        },

        /**
         * Clean up completed calls older than specified time (in ms)
         */
        cleanupOldCalls: (maxAge = 24 * 60 * 60 * 1000) => {
          const now = Date.now();
          set((state) => {
            const cleaned = {};
            Object.entries(state.calls).forEach(([key, call]) => {
              // Keep active calls and recently completed calls
              const isActive = !call.disconnectedTime;
              const isRecent =
                call.disconnectedTime && now - call.disconnectedTime < maxAge;

              if (isActive || isRecent) {
                cleaned[key] = call;
              }
            });
            return { calls: cleaned };
          });
        },
      }),
      {
        name: "calls-store",
        // Only persist active calls, not all historical calls
        partialize: (state) => ({
          calls: Object.fromEntries(
            Object.entries(state.calls).filter(([_, call]) => {
              // Only persist active calls
              return (
                call.status !== "completed" &&
                call.status !== "abandoned" &&
                call.status !== "ended" &&
                call.status !== "hangup" &&
                call.status !== "idle" &&
                call.status !== "terminated" &&
                !call.disconnectedTime
              );
            })
          ),
        }),
      }
    ),
    {
      name: "calls-store",
      enabled: process.env.NODE_ENV === "development",
    }
  )
);

export default useCallsStore;

