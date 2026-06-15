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

function normalizeTranscriptConfidence(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.min(1, Math.max(0, numeric));
}

function calculateTranscriptionSummary(transcriptions) {
  if (!Array.isArray(transcriptions) || transcriptions.length === 0) {
    return {
      topIntent: null,
      intentCount: 0,
      topTags: [],
      currentSentiment: "neutral",
      currentScore: 50,
      averageSentiment: "neutral",
      averageScore: 50,
    };
  }

  const latest = transcriptions[transcriptions.length - 1];
  const currentSentiment = latest.sentiment || "neutral";
  const currentScore =
    typeof latest.sentimentScore === "number" ? latest.sentimentScore : 50;

  const scores = transcriptions
    .map((t) => t.sentimentScore)
    .filter((v) => typeof v === "number");
  const averageScore =
    scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 50;
  let averageSentiment = "neutral";
  if (averageScore > 60) averageSentiment = "positive";
  if (averageScore < 40) averageSentiment = "negative";

  const intentCounts = new Map();
  const tagCounts = new Map();
  for (const item of transcriptions) {
    if (item.intent) {
      intentCounts.set(item.intent, (intentCounts.get(item.intent) || 0) + 1);
    }
    if (Array.isArray(item.tags)) {
      for (const tag of item.tags) {
        if (!tag) continue;
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
  }

  let topIntent = null;
  let intentCount = 0;
  for (const [intent, count] of intentCounts.entries()) {
    if (count > intentCount) {
      intentCount = count;
      topIntent = intent;
    }
  }

  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);

  return {
    topIntent,
    intentCount,
    topTags,
    currentSentiment,
    currentScore,
    averageSentiment,
    averageScore,
  };
}

const useActiveCallStore = create(
  devtools(
    (set, get) => ({
      // Core call state
      call: null, // Telnyx WebRTC call object
      callControlId: null, // For webhook correlation (WebRTC leg)
      status: "idle", // idle, ringing, active, connected, held, ended
      direction: null, // inbound, outbound
      
      // Consult transfer protection - prevents clearActiveCall during consult handoff
      consultInProgress: false, // Set true before consult, false after new call established

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

      // Transfer tracking
      transferCount: 0, // Number of times call was transferred
      transferHistory: [], // Array of transfer entries: {timestamp, to, type, callControlId}

      // Hold/resume event tracking for timeline
      holdEvents: [], // Array of {type: 'hold'|'resume', timestamp, duration?, holdNumber?}

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
        metadata: null,
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
            }
            if (controlHeader?.value) {
              originalCallControlId = controlHeader.value;
            }
            if (rtcCallIdHeader?.value) {
              rtcCallId = rtcCallIdHeader.value;
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
            }
          }

          // Also check if X-RTC-CALLID is stored directly on the call object (some SDK versions)
          if (!rtcCallId && call.rtcCallId) {
            rtcCallId = call.rtcCallId;
          }
        } catch (err) {
          // Error extracting custom headers
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
            transferCount: 0,
            transferHistory: [],
            stateHistory: initialStateHistory,
            fromNumber:
              call.options?.remoteCallerNumber ||
              call.remoteCallerNumber ||
              metadata.fromNumber ||
              call.from ||
              call.callerId,
            fromName:
              call.options?.remoteCallerName ||
              call.remoteCallerName ||
              metadata.fromName ||
              null,
            toNumber: metadata.toNumber || call.to,
            contactCenter: {
              interactionId: metadata.interactionId || null,
              queueName: metadata.queueName || null,
              queuedAt: metadata.queuedAt || null,
              assignedAt: metadata.assignedAt || null,
              customerId: metadata.customerId || null,
              customerData: metadata.customerData || null,
              metadata: metadata.metadata || call.metadata || null,
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
            const holdNumber = state.holdCount + 1;
            updates.currentHoldStartTime = Date.now();
            updates.holdCount = holdNumber;
            // Track hold event for timeline
            updates.holdEvents = [
              ...state.holdEvents,
              {
                type: "hold",
                timestamp: new Date().toISOString(),
                holdNumber,
              },
            ];
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
            // Track resume event for timeline
            updates.holdEvents = [
              ...state.holdEvents,
              {
                type: "resume",
                timestamp: new Date().toISOString(),
                duration: holdDuration,
              },
            ];
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
          }
          // If call ended while on hold, add final hold duration
          if (state.currentHoldStartTime) {
            const holdDuration = Math.floor(
              (Date.now() - state.currentHoldStartTime) / 1000
            );
            updates.totalHoldDuration = state.totalHoldDuration + holdDuration;
            updates.currentHoldStartTime = null;
          }
          // Add to state history
          updates.stateHistory = get().addStateToHistory("call_ended", "ended");
        }

        set(updates, false, "updateStatus");

        // Opportunistically sync hold metrics on hold/resume/end transitions
        const shouldSyncMetrics =
          status === "held" ||
          (status === "active" && state.ui.isHeld) ||
          ["hangup", "ended", "destroy", "idle", "terminated"].includes(status);

        if (shouldSyncMetrics) {
          get()
            .syncCallMetricsToDb()
            .catch((err) => {
              // Failed to sync metrics after status update
            });
        }
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
       * Update caller identity from WebRTC notification or async lookup.
       */
      setCallerInfo: ({ fromNumber, fromName, toNumber } = {}) => {
        const state = get();
        const updates = {};
        if (fromNumber !== undefined && fromNumber !== state.fromNumber) {
          updates.fromNumber = fromNumber;
        }
        if (fromName !== undefined && fromName !== state.fromName) {
          updates.fromName = fromName;
        }
        if (toNumber !== undefined && toNumber !== state.toNumber) {
          updates.toNumber = toNumber;
        }
        if (Object.keys(updates).length > 0) {
          set(updates, false, "setCallerInfo");
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
        if (metadata.metadata !== undefined) {
          updates.contactCenter = {
            ...(updates.contactCenter || state.contactCenter),
            metadata: metadata.metadata,
          };
        }

        if (Object.keys(updates).length > 0) {
          set(updates, false, "setContactCenterMetadata");
        }
      },

      /**
       * Add transcription to the active call
       * @returns {string|null} Transcription ID if added successfully
       */
      addTranscription: (transcriptionData) => {
        let state = get();
        if (!state.call) {
          return null;
        }

        const track = transcriptionData.transcription_track || "inbound";
        const callControlId = transcriptionData.call_control_id;
        const transcriptionKey =
          transcriptionData.transcription_key ||
          transcriptionData.transcriptionKey ||
          `${callControlId || state.originalCallControlId || "call"}:${track}`;
        const isFinal = transcriptionData.is_final === true;
        const isSpeechFinal = transcriptionData.speech_final === true;
        const confidence = normalizeTranscriptConfidence(transcriptionData.confidence);
        const now = new Date().toISOString();

        // Conversational leg of this transcription ("inbound" = customer, any
        // other track = agent/outbound).
        const legOf = (t) =>
          String(t || "").toLowerCase() === "inbound" ? "inbound" : "outbound";
        const incomingLeg = legOf(track);

        // Defensive turn-boundary guard (mirrors the server-side guard in
        // lib/agent-assist/transcription-turns.mjs): if recognition never sent
        // speech_final for the previous utterance on this leg, its bubble would
        // still be open. When the OTHER leg has spoken since (i.e. the most
        // recent transcription belongs to the opposite leg), the open bubble is
        // stale and must NOT absorb this new utterance — start a fresh bubble.
        let existingIndex = state.transcriptions.findIndex(
          (t) => t.transcriptionKey === transcriptionKey && !t.isFinal
        );
        if (existingIndex >= 0) {
          const lastTranscription =
            state.transcriptions[state.transcriptions.length - 1];
          const openBubbleWasInterrupted =
            lastTranscription &&
            lastTranscription.transcriptionKey !== transcriptionKey &&
            legOf(lastTranscription.track) !== incomingLeg;
          if (openBubbleWasInterrupted) {
            // Close the stale open bubble and force a brand-new one.
            const transcriptions = [...state.transcriptions];
            transcriptions[existingIndex] = {
              ...transcriptions[existingIndex],
              isFinal: true,
            };
            set({ transcriptions }, false, "closeStaleTranscriptionBubble");
            state = get();
            existingIndex = -1;
          }
        }

        if (existingIndex >= 0) {
          const existing = state.transcriptions[existingIndex];
          const incomingTranscript = transcriptionData.transcript || "";
          const updated = {
            ...existing,
            timestamp: isFinal ? now : existing.timestamp,
            transcript: incomingTranscript || existing.transcript,
            isFinal,
            track,
            callControlId,
            confidence: confidence ?? existing.confidence,
            source: transcriptionData.source || existing.source || null,
            provider: transcriptionData.provider || existing.provider || null,
            model: transcriptionData.model || existing.model || null,
            language: transcriptionData.language || existing.language || null,
            translation: transcriptionData.translation || existing.translation || null,
          };
          const transcriptions = [...state.transcriptions];
          transcriptions[existingIndex] = updated;

          set({ transcriptions }, false, "updateTranscription");
          return updated.id;
        }

        const transcription = {
          id: transcriptionKey || `${Date.now()}-${Math.random()}`,
          transcriptionKey,
          timestamp: now,
          transcript: transcriptionData.transcript || "",
          isFinal,
          track,
          callControlId,
          confidence,
          source: transcriptionData.source || null,
          provider: transcriptionData.provider || null,
          model: transcriptionData.model || null,
          language: transcriptionData.language || null,
          translation: transcriptionData.translation || null,
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


        return transcription.id;
      },

      /**
       * Update transcription with intent/sentiment analysis
       */
      updateTranscriptionAnalysis: (transcriptionId, analysis) => {
        const state = get();
        const updated = state.transcriptions.map((t) =>
          t.id === transcriptionId || t.transcriptionKey === transcriptionId
            ? { ...t, ...analysis }
            : t
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
       * Record a transfer action
       */
      recordTransfer: ({ to, type = "external", callControlId = null }) => {
        const state = get();
        if (!state.call) {
          return;
        }

        const transferEntry = {
          timestamp: new Date().toISOString(),
          to: to || null,
          type: type || "external",
          callControlId: callControlId || state.originalCallControlId || null,
        };

        set(
          {
            transferCount: state.transferCount + 1,
            transferHistory: [...state.transferHistory, transferEntry],
          },
          false,
          "recordTransfer"
        );

      },

      /**
       * Sync call metrics to database
       * Called when call ends to persist hold/transfer data
       */
      syncCallMetricsToDb: async () => {
        const state = get();
        if (!state.call) {
          return;
        }

        // Only sync if this is a contact center interaction
        let interactionId = state.contactCenter?.interactionId || null;
        if (!interactionId) {
          const callControlId =
            state.originalCallControlId ||
            state.callControlId ||
            state.call?.callControlId ||
            state.call?.call_control_id ||
            state.call?.id ||
            state.originalCallSessionId ||
            state.call?.callSessionId ||
            state.call?.call_session_id ||
            null;
          if (callControlId) {
            try {
              const res = await fetch(
                `/api/contact-center/interactions/by-call-control-id?callControlId=${encodeURIComponent(
                  callControlId
                )}`
              );
              const data = await res.json();
              if (data.ok && data.interaction?.id) {
                interactionId = data.interaction.id;
                get().setContactCenterMetadata({
                  interactionId: data.interaction.id,
                  queueName:
                    data.interaction.queue_name ||
                    data.interaction.queueName ||
                    null,
                  queuedAt:
                    data.interaction.enqueued_at ||
                    data.interaction.queuedAt ||
                    null,
                  assignedAt:
                    data.interaction.assigned_at ||
                    data.interaction.assignedAt ||
                    null,
                });
              }
            } catch (err) {
              // Failed to resolve interactionId
            }
          }
        }

        if (!interactionId) {
          return;
        }

        try {
          // If call ended while on hold, add final hold duration
          let finalHoldDuration = state.totalHoldDuration;
          if (state.currentHoldStartTime) {
            const currentHoldDuration = Math.floor(
              (Date.now() - state.currentHoldStartTime) / 1000
            );
            finalHoldDuration = state.totalHoldDuration + currentHoldDuration;
          }

          // Calculate talk time (from answered to disconnected, excluding holds)
          let talkTimeSeconds = 0;
          const endTime = state.disconnectedTime || Date.now();
          if (state.answerTime) {
            const totalDuration = Math.floor(
              (endTime - state.answerTime) / 1000
            );
            talkTimeSeconds = Math.max(0, totalDuration - finalHoldDuration);
          }

          const metrics = {
            interactionId,
            holdCount: state.holdCount,
            holdDurationSeconds: finalHoldDuration,
            transferCount: state.transferCount,
            transferHistory: state.transferHistory,
            talkTimeSeconds: talkTimeSeconds,
            answeredAt: state.answerTime
              ? new Date(state.answerTime).toISOString()
              : null,
            holdEvents: state.holdEvents || [], // Include hold/resume events for timeline
          };


          const res = await fetch(
            `/api/contact-center/interactions/${interactionId}/metrics`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(metrics),
            }
          );

          if (!res.ok) {
            const error = await res
              .json()
              .catch(() => ({ error: "Unknown error" }));
            // Failed to sync metrics
          }
        } catch (err) {
          // Error syncing call metrics
        }
      },

      /**
       * Sync agent assist transcription data to database
       * Called when call ends to persist transcripts, intents, and sentiment
       */
      syncAgentAssistToDb: async () => {
        const state = get();
        if (!state.call) {
          return;
        }

        if (!Array.isArray(state.transcriptions) || state.transcriptions.length === 0) {
          return;
        }

        // Only sync if this is a contact center interaction
        let interactionId = state.contactCenter?.interactionId || null;
        if (!interactionId) {
          const callControlId =
            state.originalCallControlId ||
            state.callControlId ||
            state.call?.callControlId ||
            state.call?.call_control_id ||
            state.call?.id ||
            state.originalCallSessionId ||
            state.call?.callSessionId ||
            state.call?.call_session_id ||
            null;
          if (callControlId) {
            try {
              const res = await fetch(
                `/api/contact-center/interactions/by-call-control-id?callControlId=${encodeURIComponent(
                  callControlId
                )}`
              );
              const data = await res.json();
              if (data.ok && data.interaction?.id) {
                interactionId = data.interaction.id;
                get().setContactCenterMetadata({
                  interactionId: data.interaction.id,
                  queueName:
                    data.interaction.queue_name ||
                    data.interaction.queueName ||
                    null,
                  queuedAt:
                    data.interaction.enqueued_at ||
                    data.interaction.queuedAt ||
                    null,
                  assignedAt:
                    data.interaction.assigned_at ||
                    data.interaction.assignedAt ||
                    null,
                });
              }
            } catch (err) {
              // Failed to resolve interactionId for transcripts
            }
          }
        }

        if (!interactionId) {
          return;
        }

        const transcriptions = state.transcriptions;
        const summary = calculateTranscriptionSummary(transcriptions);

        try {
          const res = await fetch(
            `/api/contact-center/interactions/${interactionId}/transcription`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ transcriptions, summary }),
            }
          );

          if (!res.ok) {
            const error = await res
              .json()
              .catch(() => ({ error: "Unknown error" }));
            // Failed to sync transcripts
          }
        } catch (err) {
          // Error syncing transcripts
        }
      },

      /**
       * Set consult in progress flag - prevents clearActiveCall during consult handoff
       */
      setConsultInProgress: (inProgress) => {
        console.log(`[ActiveCallStore] setConsultInProgress: ${inProgress}`);
        set({ consultInProgress: inProgress }, false, "setConsultInProgress");
      },

      /**
       * Clear active call - called when call ends
       * Note: This is async to sync metrics, but callers don't need to await it
       * IMPORTANT: Skips clearing if consultInProgress is true (prevents race condition during consult transfer)
       */
      clearActiveCall: () => {
        const state = get();
        
        // Skip clearing if consult is in progress - the original call hanging up
        // should not clear the store, as we're about to set a new consult call
        if (state.consultInProgress) {
          console.log("[ActiveCallStore] clearActiveCall SKIPPED - consultInProgress is true");
          return;
        }

        // Sync metrics to DB before clearing (fire and forget)
        get()
          .syncCallMetricsToDb()
          .catch((err) => {
            // Error syncing metrics
          });
        get()
          .syncAgentAssistToDb()
          .catch((err) => {
            // Error syncing transcription data
          });

        get().stopDurationTimer();

        set(
          {
            call: null,
            callControlId: null,
            status: "idle",
            direction: null,
            consultInProgress: false, // Always reset this flag
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
            transferCount: 0,
            transferHistory: [],
            holdEvents: [],
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
