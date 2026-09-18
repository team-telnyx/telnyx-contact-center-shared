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
            callControlIds = [],
            interactionId,
            callerName,
            callerNumber,
            queueName,
            queueId,
            aiCallControlId,
            direction,
            status,
            callStartTime,
            answerTime,
            connectedTime,
            disconnectedTime,
            holdCount,
            totalHoldDuration,
            currentHoldStartTime,
            transferCount,
            transferHistory,
            transcriptions,
            isMuted,
            isHeld,
            isRinging,
            duration,
            fromName,
            fromNumber,
            toNumber,
            queuedAt,
            assignedAt,
            customerId,
            customerData,
            metadata,
          } = callData;

          const isUuid =
            typeof callControlId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              callControlId
            );
          const derivedRtcCallId = rtcCallId || (isUuid ? callControlId : null);

          const aliases = Array.from(
            new Set(
              [
                callControlId,
                originalCallControlId,
                callSessionId,
                originalCallSessionId,
                rtcCallId,
                interactionId,
                ...callControlIds,
              ].filter(Boolean),
            ),
          );
          const preferredKey = originalCallControlId || callControlId || null;
          const existingKey = aliases
            .map((alias) => get().resolveCallKey(alias))
            .find(Boolean);
          const key =
            existingKey ||
            preferredKey ||
            `temp-${Date.now()}-${Math.random()}`;

          set(
            (state) => {
              // Coalesce entries that represent the same call but arrived via
              // different customer/transport/device/session aliases.
              const matchingKeys = Object.entries(state.calls)
                .filter(([entryKey, call]) => {
                  const existingAliases = [
                    entryKey,
                    call?.callControlId,
                    call?.originalCallControlId,
                    call?.callSessionId,
                    call?.originalCallSessionId,
                    call?.rtcCallId,
                    call?.interactionId,
                    ...(call?.callControlIds || []),
                  ].filter(Boolean);
                  return existingAliases.some((alias) => aliases.includes(alias));
                })
                .map(([entryKey]) => entryKey);
              const existingCall = matchingKeys.reduce(
                (merged, entryKey) => ({ ...merged, ...state.calls[entryKey] }),
                state.calls[key] || {},
              );
              const remainingCalls = { ...state.calls };
              matchingKeys.forEach((entryKey) => delete remainingCalls[entryKey]);
              const accumulatedCallControlIds = Array.from(
                new Set([
                  ...(existingCall.callControlIds || []),
                  existingCall.callControlId,
                  existingCall.originalCallControlId,
                  existingCall.rtcCallId,
                  callControlId,
                  originalCallControlId,
                  rtcCallId,
                  ...callControlIds,
                ].filter(Boolean)),
              );
              return {
                calls: {
                  ...remainingCalls,
                  [key]: {
                    ...existingCall,
                    callControlId: key,
                    callControlIds: accumulatedCallControlIds,
                    callSessionId:
                      callSessionId ?? existingCall.callSessionId ?? null,
                    originalCallControlId:
                      originalCallControlId ??
                      existingCall.originalCallControlId ??
                      null,
                    originalCallSessionId:
                      originalCallSessionId ??
                      existingCall.originalCallSessionId ??
                      null,
                    rtcCallId:
                      derivedRtcCallId ?? existingCall.rtcCallId ?? null,
                    interactionId:
                      interactionId ?? existingCall.interactionId ?? null,
                    callerName:
                      callerName ??
                      fromName ??
                      existingCall.callerName ??
                      existingCall.fromName ??
                      null,
                    callerNumber:
                      callerNumber ??
                      fromNumber ??
                      existingCall.callerNumber ??
                      existingCall.fromNumber ??
                      null,
                    queueName: queueName ?? existingCall.queueName ?? null,
                    queueId: queueId ?? existingCall.queueId ?? null,
                    direction:
                      direction ?? existingCall.direction ?? "inbound",
                    status: status ?? existingCall.status ?? "ringing",
                    callStartTime:
                      callStartTime ?? existingCall.callStartTime ?? Date.now(),
                    answerTime: answerTime ?? existingCall.answerTime ?? null,
                    connectedTime:
                      connectedTime ?? existingCall.connectedTime ?? null,
                    disconnectedTime:
                      disconnectedTime ?? existingCall.disconnectedTime ?? null,
                    holdCount: holdCount ?? existingCall.holdCount ?? 0,
                    totalHoldDuration:
                      totalHoldDuration ?? existingCall.totalHoldDuration ?? 0,
                    currentHoldDuration: 0,
                    currentHoldStartTime:
                      currentHoldStartTime ??
                      existingCall.currentHoldStartTime ??
                      null,
                    transferCount:
                      transferCount ?? existingCall.transferCount ?? 0,
                    transferHistory:
                      transferHistory ?? existingCall.transferHistory ?? [],
                    transcriptions:
                      transcriptions ?? existingCall.transcriptions ?? [],
                    isMuted: isMuted ?? existingCall.isMuted ?? false,
                    isHeld: isHeld ?? existingCall.isHeld ?? false,
                    isRinging: isRinging ?? existingCall.isRinging ?? true,
                    duration: duration ?? existingCall.duration ?? 0,
                    fromName:
                      fromName ??
                      callerName ??
                      existingCall.fromName ??
                      existingCall.callerName ??
                      null,
                    fromNumber:
                      fromNumber ??
                      callerNumber ??
                      existingCall.fromNumber ??
                      existingCall.callerNumber ??
                      null,
                    toNumber: toNumber ?? existingCall.toNumber ?? null,
                    aiCallControlId:
                      aiCallControlId ?? existingCall.aiCallControlId ?? null,
                    queuedAt: queuedAt ?? existingCall.queuedAt ?? null,
                    assignedAt: assignedAt ?? existingCall.assignedAt ?? null,
                    customerId: customerId ?? existingCall.customerId ?? null,
                    customerData:
                      customerData ?? existingCall.customerData ?? null,
                    metadata: {
                      ...(existingCall?.metadata || {}),
                      ...(metadata || {}),
                    },
                    updatedAt: Date.now(),
                  },
                },
              };
            },
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
              const resolvedKey =
                get().resolveCallKey(callControlId) || callControlId;
              const call = state.calls[resolvedKey];
              if (!call) {
                console.warn(
                  `[CallsStore] Call ${callControlId} not found for update`
                );
                return state;
              }

              return {
                calls: {
                  ...state.calls,
                  [resolvedKey]: {
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
              const remaining = Object.fromEntries(
                Object.entries(state.calls).filter(([key, call]) => {
                  const aliases = [
                    key,
                    call?.callControlId,
                    call?.originalCallControlId,
                    call?.callSessionId,
                    call?.originalCallSessionId,
                    call?.rtcCallId,
                    call?.interactionId,
                    ...(call?.callControlIds || []),
                  ];
                  return !aliases.some(
                    (alias) =>
                      alias && String(alias) === String(callControlId),
                  );
                }),
              );
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
          const resolvedKey = get().resolveCallKey(callControlId);
          return get().calls[resolvedKey] || null;
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
          const shouldRemove = [
            "hangup",
            "ended",
            "destroy",
            "idle",
            "terminated",
          ].includes(status);

          // Update timing based on status
          if (
            status === "active" ||
            status === "connected" ||
            status === "answered"
          ) {
            const resolvedKey = get().resolveCallKey(callControlId);
            const call = resolvedKey ? get().calls[resolvedKey] : null;
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
            const resolvedKey = get().resolveCallKey(callControlId);
            const call = resolvedKey ? get().calls[resolvedKey] : null;
            if (call && !call.disconnectedTime) {
              updates.disconnectedTime = Date.now();
            }
          }

          get().updateCall(callControlId, updates);

          if (shouldRemove) {
            get().removeCall(callControlId);
          }
        },

        /**
         * Update hold state
         */
        setCallHeld: (callControlId, isHeld) => {
          const resolvedKey = get().resolveCallKey(callControlId);
          const call = resolvedKey ? get().calls[resolvedKey] : null;
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
          const resolvedKey = get().resolveCallKey(callControlId);
          const call = resolvedKey ? get().calls[resolvedKey] : null;
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
          const resolvedKey = get().resolveCallKey(callControlId);
          const call = resolvedKey ? get().calls[resolvedKey] : null;
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

        /**
         * Resolve any call id to the canonical store key
         */
        resolveCallKey: (callId) => {
          if (!callId) return null;
          const state = get();
          if (state.calls[callId]) return callId;
          const entries = Object.entries(state.calls);
          for (const [key, call] of entries) {
            if (
              call?.callControlId === callId ||
              call?.originalCallControlId === callId ||
              call?.callSessionId === callId ||
              call?.originalCallSessionId === callId ||
              call?.rtcCallId === callId ||
              call?.interactionId === callId ||
              call?.callControlIds?.includes(callId)
            ) {
              return key;
            }
          }
          return null;
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
