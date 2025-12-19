/**
 * Active Call Store (Zustand)
 *
 * Single source of truth for active calls.
 * Manages both direct WebRTC calls and Contact Center queued calls.
 *
 * Design:
 * - WebRTC SDK is the source of truth
 * - Mini phone is the ONLY writer
 * - All other components are read-only consumers
 * - State is lost on refresh/restart (intentional)
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";

// Duration timer (outside store to prevent unnecessary re-renders)
let durationTimer = null;

const useActiveCallStore = create(
  devtools(
    (set, get) => ({
      // Core call state
      call: null, // Telnyx WebRTC call object
      callControlId: null, // For webhook correlation (WebRTC leg)
      status: "idle", // idle, ringing, active, connected, held, ended
      direction: null, // inbound, outbound

      // Original call identifiers (from custom headers - PSTN leg)
      // These are the CORRECT IDs to use for call control operations (transfer, hangup, etc.)
      originalCallSessionId: null, // X-Original-Call-Session-Id from custom headers
      originalCallControlId: null, // X-Original-Call-Control-Id from custom headers
      rtcCallId: null, // X-RTC-CALLID from WebRTC call (for outbound calls)

      // Timing
      callStartTime: null, // When call started ringing (timestamp)
      answerTime: null, // When call was answered (timestamp)
      connectedTime: null, // When WebRTC client connected (timestamp)
      disconnectedTime: null, // When WebRTC client disconnected (timestamp)

      // Hold tracking
      holdCount: 0, // Number of times call was put on hold
      totalHoldDuration: 0, // Total hold duration in seconds
      currentHoldStartTime: null, // When current hold started (timestamp)

      // State history tracking for timeline visualization
      stateHistory: [], // Array of {state, timestamp, duration} objects

      // Caller information
      fromNumber: null,
      fromName: null,
      toNumber: null,

      // Contact Center metadata (null for direct calls)
      contactCenter: {
        interactionId: null, // Database ID if from queue
        queueName: null,
        queuedAt: null,
        assignedAt: null,
        customerId: null,
        customerData: null, // Full customer object
      },

      // Agent Assist - Call transcriptions
      transcriptions: [], // Array of transcription objects from call.transcription webhooks

      // UI state
      ui: {
        isMuted: false,
        isHeld: false,
        isRinging: false, // Show answer/reject buttons
        duration: 0, // Live duration in seconds
      },

      // Actions

      /**
       * Set active call - called when call starts ringing
       */
      setActiveCall: (call, metadata = {}) => {
        const now = Date.now();
        const direction = metadata.direction || call.direction || "inbound";

        // Only show ringing UI for incoming calls, not outbound
        const isIncoming = direction === "inbound" || direction === "incoming";

        // Set initial status based on direction and call state
        const initialStatus = isIncoming
          ? "ringing" // Incoming calls start as ringing
          : call.state || "trying"; // Outbound calls use call state or 'trying'

        // Extract original call session ID and call control ID from custom headers
        // These are the PSTN leg IDs, which should be used for all call control operations
        let originalCallSessionId = null;
        let originalCallControlId = null;
        let rtcCallId = null; // X-RTC-CALLID for outbound WebRTC calls

        try {
          const customHeaders = call.options?.customHeaders;
          if (customHeaders && Array.isArray(customHeaders)) {
            const sessionHeader = customHeaders.find(
              (h) => h.name === "X-Original-Call-Session-Id"
            );
            const controlHeader = customHeaders.find(
              (h) => h.name === "X-Original-Call-Control-Id"
            );
            const rtcCallIdHeader = customHeaders.find(
              (h) => h.name === "X-RTC-CALLID"
            );

            if (sessionHeader?.value) {
              originalCallSessionId = sessionHeader.value;
              console.log(
                "[ActiveCallStore] Found X-Original-Call-Session-Id:",
                originalCallSessionId
              );
            }
            if (controlHeader?.value) {
              originalCallControlId = controlHeader.value;
              console.log(
                "[ActiveCallStore] Found X-Original-Call-Control-Id:",
                originalCallControlId
              );
            }
            if (rtcCallIdHeader?.value) {
              rtcCallId = rtcCallIdHeader.value;
              console.log("[ActiveCallStore] Found X-RTC-CALLID:", rtcCallId);
            }
          }

          // Also check inviteCustomHeaders (for outbound calls)
          // The SDK may store headers in different places
          const inviteCustomHeaders =
            call.inviteCustomHeaders ||
            call.invite?.customHeaders ||
            call.customHeaders;
          if (inviteCustomHeaders && Array.isArray(inviteCustomHeaders)) {
            const rtcCallIdHeader = inviteCustomHeaders.find(
              (h) => h.name === "X-RTC-CALLID"
            );
            if (rtcCallIdHeader?.value && !rtcCallId) {
              rtcCallId = rtcCallIdHeader.value;
              console.log(
                "[ActiveCallStore] Found X-RTC-CALLID from inviteCustomHeaders:",
                rtcCallId
              );
            }
          }

          // Also check if X-RTC-CALLID is stored directly on the call object (some SDK versions)
          if (!rtcCallId && call.rtcCallId) {
            rtcCallId = call.rtcCallId;
            console.log(
              "[ActiveCallStore] Found X-RTC-CALLID from call.rtcCallId:",
              rtcCallId
            );
          }
        } catch (err) {
          console.warn(
            "[ActiveCallStore] Error extracting custom headers:",
            err
          );
        }

        // Initialize state history with initial state
        const initialStateHistory = [
          {
            state: initialStatus,
            timestamp: now,
            event: isIncoming ? "call_ringing" : "call_initiated",
          },
        ];

        set(
          {
            call,
            callControlId:
              call.callControlId || call.call_control_id || call.id,
            status: initialStatus,
            direction,
            originalCallSessionId,
            originalCallControlId,
            rtcCallId,
            callStartTime: now,
            answerTime: null,
            connectedTime: null,
            disconnectedTime: null,
            holdCount: 0,
            totalHoldDuration: 0,
            currentHoldStartTime: null,
            stateHistory: initialStateHistory,
            fromNumber: metadata.fromNumber || call.from || call.callerId,
            fromName: metadata.fromName || null,
            toNumber: metadata.toNumber || call.to,
            contactCenter: {
              interactionId: metadata.interactionId || null,
              queueName: metadata.queueName || null,
              queuedAt: metadata.queuedAt || null,
              assignedAt: metadata.assignedAt || null,
              customerId: metadata.customerId || null,
              customerData: metadata.customerData || null,
            },
            transcriptions: [],
            ui: {
              isMuted: false,
              isHeld: false,
              isRinging: isIncoming, // Only true for incoming calls
              duration: 0,
            },
          },
          false,
          "setActiveCall"
        );
      },

      /**
       * Add state change to history (internal helper)
       */
      addStateToHistory: (event, newStatus) => {
        const state = get();
        const now = Date.now();

        // Calculate duration of previous state
        const history = [...state.stateHistory];
        if (history.length > 0) {
          const lastState = history[history.length - 1];
          lastState.duration = Math.floor((now - lastState.timestamp) / 1000);
        }

        // Add new state
        history.push({
          state: newStatus || state.status,
          timestamp: now,
          event,
          duration: null, // Will be calculated when next state is added
        });

        return history;
      },

      /**
       * Update call status - called on WebRTC events
       */
      updateStatus: (status) => {
        const state = get();

        if (!state.call) {
          console.warn(
            "[ActiveCallStore] updateStatus called without active call"
          );
          return;
        }

        const updates = { status };

        // Update UI state based on status
        // Check for hold/resume FIRST before general active state
        if (status === "held") {
          updates.ui = {
            ...state.ui,
            isHeld: true,
          };
          // Start hold tracking
          if (!state.currentHoldStartTime) {
            updates.currentHoldStartTime = Date.now();
            updates.holdCount = state.holdCount + 1;
            console.log(
              "[ActiveCallStore] Call put on hold, count:",
              updates.holdCount
            );
          }
          // Add to state history
          updates.stateHistory = get().addStateToHistory("call_hold", "held");
        } else if (status === "active" && state.ui.isHeld) {
          // Resuming from hold - check this BEFORE general active state
          updates.ui = {
            ...state.ui,
            isHeld: false,
          };
          // Calculate hold duration
          if (state.currentHoldStartTime) {
            const holdDuration = Math.floor(
              (Date.now() - state.currentHoldStartTime) / 1000
            );
            updates.totalHoldDuration = state.totalHoldDuration + holdDuration;
            updates.currentHoldStartTime = null;
            console.log(
              "[ActiveCallStore] Call resumed from hold, duration:",
              holdDuration,
              "s, total:",
              updates.totalHoldDuration,
              "s"
            );
          }
          // Add to state history
          updates.stateHistory = get().addStateToHistory(
            "call_resume",
            "active"
          );
        } else if (
          status === "active" ||
          status === "connected" ||
          status === "answered"
        ) {
          // General active state (not resuming from hold)
          updates.ui = {
            ...state.ui,
            isRinging: false,
          };

          // Track when WebRTC client actually connected AND answered
          // This is the CORRECT answered_at timestamp (NOT from webhook!)
          if (!state.connectedTime) {
            updates.connectedTime = Date.now();
            updates.answerTime = Date.now(); // Set answerTime when WebRTC client connects
            console.log(
              "[ActiveCallStore] WebRTC client answered/connected at:",
              new Date(updates.connectedTime).toISOString()
            );
            get().startDurationTimer();
            // Add to state history
            updates.stateHistory = get().addStateToHistory(
              "call_answered",
              "connected"
            );
          }
        } else if (
          ["hangup", "ended", "destroy", "idle", "terminated"].includes(status)
        ) {
          get().stopDurationTimer();
          // Track when WebRTC client disconnected
          if (!state.disconnectedTime) {
            updates.disconnectedTime = Date.now();
            console.log(
              "[ActiveCallStore] WebRTC client disconnected at:",
              new Date(updates.disconnectedTime).toISOString()
            );
          }
          // If call ended while on hold, add final hold duration
          if (state.currentHoldStartTime) {
            const holdDuration = Math.floor(
              (Date.now() - state.currentHoldStartTime) / 1000
            );
            updates.totalHoldDuration = state.totalHoldDuration + holdDuration;
            updates.currentHoldStartTime = null;
            console.log(
              "[ActiveCallStore] Call ended while on hold, final duration:",
              holdDuration,
              "s, total:",
              updates.totalHoldDuration,
              "s"
            );
          }
          // Add to state history
          updates.stateHistory = get().addStateToHistory("call_ended", "ended");
        }

        set(updates, false, "updateStatus");
      },

      /**
       * Update mute state
       */
      setMuted: (muted) => {
        const state = get();
        if (state.ui.isMuted !== muted) {
          set(
            {
              ui: {
                ...state.ui,
                isMuted: muted,
              },
            },
            false,
            "setMuted"
          );
        }
      },

      /**
       * Update hold state
       */
      setHeld: (held) => {
        const state = get();
        if (state.ui.isHeld !== held) {
          set(
            {
              ui: {
                ...state.ui,
                isHeld: held,
              },
            },
            false,
            "setHeld"
          );
        }
      },

      /**
       * Update caller name (async lookup result)
       */
      setCallerName: (name) => {
        const state = get();
        if (state.fromName !== name) {
          set({ fromName: name }, false, "setCallerName");
        }
      },

      /**
       * Update customer data (for contact center calls)
       */
      setCustomerData: (data) => {
        const state = get();
        set(
          {
            contactCenter: {
              ...state.contactCenter,
              customerData: data,
            },
          },
          false,
          "setCustomerData"
        );
      },

      /**
       * Update contact center metadata from SSE incoming_call_info event
       * This should be called when an incoming call is assigned to this agent
       */
      setContactCenterMetadata: (metadata) => {
        const state = get();
        const updates = {};

        if (metadata.interactionId !== undefined) {
          updates.contactCenter = {
            ...state.contactCenter,
            interactionId: metadata.interactionId,
          };
        }
        if (metadata.queueName !== undefined) {
          updates.contactCenter = {
            ...(updates.contactCenter || state.contactCenter),
            queueName: metadata.queueName,
          };
        }
        if (metadata.queuedAt !== undefined) {
          updates.contactCenter = {
            ...(updates.contactCenter || state.contactCenter),
            queuedAt: metadata.queuedAt,
          };
        }
        if (metadata.assignedAt !== undefined) {
          updates.contactCenter = {
            ...(updates.contactCenter || state.contactCenter),
            assignedAt: metadata.assignedAt || Date.now(),
          };
        }
        if (metadata.customerId !== undefined) {
          updates.contactCenter = {
            ...(updates.contactCenter || state.contactCenter),
            customerId: metadata.customerId,
          };
        }
        if (metadata.customerData !== undefined) {
          updates.contactCenter = {
            ...(updates.contactCenter || state.contactCenter),
            customerData: metadata.customerData,
          };
        }

        if (Object.keys(updates).length > 0) {
          set(updates, false, "setContactCenterMetadata");
          console.log(
            "[ActiveCallStore] Contact center metadata updated:",
            updates
          );
        }
      },

      /**
       * Add transcription to the active call
       */
      addTranscription: (transcriptionData) => {
        const state = get();
        if (!state.call) {
          console.warn(
            "[ActiveCallStore] addTranscription called without active call"
          );
          return;
        }

        const transcription = {
          id: `${Date.now()}-${Math.random()}`,
          timestamp: new Date().toISOString(),
          transcript: transcriptionData.transcript || "",
          isFinal: transcriptionData.is_final || false,
          track: transcriptionData.transcription_track || "inbound",
          callControlId: transcriptionData.call_control_id,
          // Agent Assist fields (will be populated by analysis)
          intent: null,
          sentiment: null,
          sentimentScore: null,
        };

        set(
          {
            transcriptions: [...state.transcriptions, transcription],
          },
          false,
          "addTranscription"
        );

        console.log(
          "[ActiveCallStore] Added transcription:",
          transcription.transcript
        );
      },

      /**
       * Update transcription with intent/sentiment analysis
       */
      updateTranscriptionAnalysis: (transcriptionId, analysis) => {
        const state = get();
        const updated = state.transcriptions.map((t) =>
          t.id === transcriptionId ? { ...t, ...analysis } : t
        );

        set(
          {
            transcriptions: updated,
          },
          false,
          "updateTranscriptionAnalysis"
        );
      },

      /**
       * Clear active call - called when call ends
       */
      clearActiveCall: () => {
        get().stopDurationTimer();

        set(
          {
            call: null,
            callControlId: null,
            status: "idle",
            direction: null,
            originalCallSessionId: null,
            originalCallControlId: null,
            rtcCallId: null,
            callStartTime: null,
            answerTime: null,
            connectedTime: null,
            disconnectedTime: null,
            holdCount: 0,
            totalHoldDuration: 0,
            currentHoldStartTime: null,
            stateHistory: [],
            fromNumber: null,
            fromName: null,
            toNumber: null,
            contactCenter: {
              interactionId: null,
              queueName: null,
              queuedAt: null,
              assignedAt: null,
              customerId: null,
              customerData: null,
            },
            transcriptions: [],
            ui: {
              isMuted: false,
              isHeld: false,
              isRinging: false,
              duration: 0,
            },
          },
          false,
          "clearActiveCall"
        );
      },

      /**
       * Start duration timer (internal)
       */
      startDurationTimer: () => {
        get().stopDurationTimer();

        durationTimer = setInterval(() => {
          const state = get();
          if (state.answerTime && state.status !== "ended") {
            const duration = Math.floor((Date.now() - state.answerTime) / 1000);
            set(
              {
                ui: {
                  ...state.ui,
                  duration,
                },
              },
              false,
              "updateDuration"
            );
          }
        }, 1000);
      },

      /**
       * Stop duration timer (internal)
       */
      stopDurationTimer: () => {
        if (durationTimer) {
          clearInterval(durationTimer);
          durationTimer = null;
        }
      },

      // Computed selectors

      /**
       * Check if call is from contact center (has interaction ID)
       */
      isContactCenterCall: () => {
        const state = get();
        return !!state.contactCenter.interactionId;
      },

      /**
       * Get call duration in seconds
       */
      getCallDuration: () => {
        const state = get();
        if (!state.answerTime) return 0;
        return Math.floor((Date.now() - state.answerTime) / 1000);
      },
    }),
    {
      name: "active-call-store",
      enabled: process.env.NODE_ENV === "development",
    }
  )
);

// Selector hooks for optimized rendering
export const useActiveCall = () => useActiveCallStore((state) => state.call);
export const useCallStatus = () => useActiveCallStore((state) => state.status);
export const useIsRinging = () =>
  useActiveCallStore((state) => state.ui.isRinging);
export const useCallerInfo = () => {
  const fromNumber = useActiveCallStore((state) => state.fromNumber);
  const fromName = useActiveCallStore((state) => state.fromName);
  const toNumber = useActiveCallStore((state) => state.toNumber);
  return { fromNumber, fromName, toNumber };
};
export const useCallUI = () => {
  const isMuted = useActiveCallStore((state) => state.ui.isMuted);
  const isHeld = useActiveCallStore((state) => state.ui.isHeld);
  const isRinging = useActiveCallStore((state) => state.ui.isRinging);
  const duration = useActiveCallStore((state) => state.ui.duration);
  return { isMuted, isHeld, isRinging, duration };
};
export const useContactCenterInfo = () => {
  const interactionId = useActiveCallStore(
    (state) => state.contactCenter.interactionId
  );
  const queueName = useActiveCallStore(
    (state) => state.contactCenter.queueName
  );
  const customerId = useActiveCallStore(
    (state) => state.contactCenter.customerId
  );
  const customerData = useActiveCallStore(
    (state) => state.contactCenter.customerData
  );
  return { interactionId, queueName, customerId, customerData };
};

export default useActiveCallStore;
