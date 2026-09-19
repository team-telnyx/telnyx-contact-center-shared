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
import {
  SAME_LEG_FINAL_COALESCE_MS,
  compactTranscriptText,
  mergeCoalesceTranscript,
  transcriptionTimestampMs,
} from "../agent-assist/history-merge.mjs";

// Duration timer (outside store to prevent unnecessary re-renders)
let durationTimer = null;

function normalizeTranscriptConfidence(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.min(1, Math.max(0, numeric));
}

// Deepgram Flux often emits several speech_final+is_final segments for one
// spoken turn ("Hi." then "Thanks for calling." ~2s later). Merge consecutive
// same-leg finals within this window into one bubble so the UI does not look
// like duplicate / fragmented transcriptions.
// an earlier fix: how far back the duplicate scan looks. Every dedupe check in
// addTranscription used to compare against ONLY the last array element — but
// in live two-party audio the duplicate copies are almost never adjacent: the
// other speaker's bubble lands in between (verified frame-by-frame on the
// Aug 11 the reference workflow session: every duplicated line was separated from its twin by at
// least one opposing-leg bubble). The scan is bounded by count and age so a
// genuinely repeated phrase later in the call still renders.
const RECENT_DUPLICATE_WINDOW_MS = 10000;
const RECENT_DUPLICATE_SCAN_ENTRIES = 12;

// Non-adjacent EXACT duplicates get a much tighter window than fragment
// continuation. A second copy of the same final from a redundant source
// (router vs webhook, stale SSE writer) arrives within a couple of seconds of
// the first; a human deliberately REPEATING a sentence ("Could you repeat the
// number?" asked again after an unclear answer) needs the listener's turn
// plus the re-ask itself, which in practice puts the second final well past
// this bound — so the deliberate repeat renders while the machine duplicate
// is dropped. Fragment-continuation replacement keeps the wider window: a
// genuine repeat is equal text, not an extension, so it cannot be swallowed
// by that path.
const NONADJACENT_EXACT_DUPLICATE_WINDOW_MS = 4000;

// Tighter still for an ADJACENT equal with no substance ("No.", "Yes.").
// Short bare answers are the one place where two different turns can carry
// byte-identical text back-to-back — a customer answering consecutive
// questions — so only a near-simultaneous copy counts as machine redelivery.
const ADJACENT_INSUBSTANTIAL_DUPLICATE_WINDOW_MS = 2000;

// One utterance's text "continues" another when the shorter is a leading
// prefix of the longer after normalization (case/whitespace/trailing
// punctuation-insensitive). Growing STT hypotheses of a single utterance
// ("You wanna" -> "You wanna repeat" -> "You wanna repeat that number?")
// relate this way; two different utterances almost never do.
function normalizeDuplicateText(value) {
  return compactTranscriptText(value).toLowerCase().replace(/[.,!?;:]+$/, "").trim();
}

function textContinues(longer, shorter) {
  const long = normalizeDuplicateText(longer);
  const short = normalizeDuplicateText(shorter);
  return short.length > 0 && long.length > short.length && long.startsWith(short);
}

// Non-adjacent suppression only applies to text with some substance. A human
// genuinely repeats short backchannels ("Yeah." ... "Yeah.", "Okay.") within
// seconds, and those must keep rendering; a multi-word or longer line
// repeated verbatim inside the window is an STT duplicate, not a person
// ("You wanna repeat that number?" twice with identical confidence).
function isSubstantialDuplicateText(core) {
  return core.includes(" ") || core.length >= 6;
}

function transcriptIdentity(item = {}) {
  return String(
    item.transcriptionKey ||
      item.transcription_key ||
      item.originalTranscriptionKey ||
      item.id ||
      [item.track || "", item.timestamp || "", compactTranscriptText(item.transcript)].join("|"),
  );
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
      recoveredCallHeaders: [],
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
            recoveredCallHeaders: [],
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
       * Adopt an explicitly reattached SDK call without restarting the conversation.
       */
      adoptRecoveredCall: (call) => {
        const current = get();
        if (!current.call?.id || !call || current.call === call ||
            call.recoveredCallId !== current.call.id ||
            ["done", "hangup", "ended", "destroy", "purge", "terminated", "failed"].includes(String(call.state).toLowerCase())) return false;
        // A recovered SDK object belongs to the same conversation. Preserve
        // timing, CC identity, transcripts and wrap-up context; do not ring again.
        const headers = [current.call.options?.customHeaders, current.call.inviteCustomHeaders,
          current.call.customHeaders, current.recoveredCallHeaders].filter(Array.isArray).flat();
        set({ call, recoveredCallHeaders: headers }, false, "call/recovered");
        return true;
      },

      /** Update call status from WebRTC events. */
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
       * Restore prior agent segments for the same durable interaction. This is
       * used after a queue transfer, when setActiveCall correctly created a
       * fresh device-leg state but the conversation/workflow history belongs
       * to the whole interaction.
       */
      hydrateTranscriptions: (history = []) => {
        const state = get();
        if (!state.call || !Array.isArray(history) || history.length === 0) {
          return;
        }

        const merged = [];
        const indexes = new Map();
        for (const item of [
          ...history.map((entry) => ({ ...entry, historyHydrated: true })),
          ...state.transcriptions,
        ]) {
          if (!item || typeof item !== "object") continue;
          const key = transcriptIdentity(item);
          const index = indexes.get(key);
          if (index === undefined) {
            indexes.set(key, merged.length);
            merged.push(item);
          } else {
            merged[index] = { ...merged[index], ...item };
          }
        }
        set({ transcriptions: merged }, false, "hydrateTranscriptions");
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
        let activeTranscriptionKey = transcriptionKey;
        let originalTranscriptionKey = null;
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
          (t) =>
            (t.transcriptionKey === transcriptionKey ||
              t.originalTranscriptionKey === transcriptionKey) &&
            !t.isFinal
        );
        if (existingIndex >= 0) {
          const lastTranscription =
            state.transcriptions[state.transcriptions.length - 1];
          const openBubble = state.transcriptions[existingIndex];
          // an earlier fix: an interruption by the other leg does NOT mean this
          // leg's open bubble is stale when the incoming text is visibly the
          // SAME utterance still growing (or a re-hypothesis shrinking it) —
          // cross-talk backchannels ("Yeah.", "Okay.") land between every
          // interim of a long utterance, and splitting on each one turned a
          // single utterance into a cascade of partial bubbles. Only split
          // for genuinely NEW text under the same key.
          const incomingContinuesOpenBubble =
            normalizeDuplicateText(transcriptionData.transcript) ===
              normalizeDuplicateText(openBubble.transcript) ||
            textContinues(transcriptionData.transcript, openBubble.transcript) ||
            textContinues(openBubble.transcript, transcriptionData.transcript);
          const openBubbleWasInterrupted =
            lastTranscription &&
            lastTranscription.transcriptionKey !== transcriptionKey &&
            legOf(lastTranscription.track) !== incomingLeg &&
            !incomingContinuesOpenBubble;
          if (openBubbleWasInterrupted) {
            // Close the stale open bubble and force a brand-new one.
            const transcriptions = [...state.transcriptions];
            transcriptions[existingIndex] = {
              ...transcriptions[existingIndex],
              isFinal: true,
            };
            set({ transcriptions }, false, "closeStaleTranscriptionBubble");
            state = get();
            activeTranscriptionKey = `${transcriptionKey}:split:${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}`;
            originalTranscriptionKey = transcriptionKey;
            existingIndex = -1;
          }
        }

        // When a FINAL lands, try to merge into the previous same-leg final
        // within the coalesce window. Flux often opens a new interim key between
        // fragments ("Can you provide the" → interim "Corporate" → final
        // "Corporate number."); without this, the open-bubble update path above
        // would leave two agent bubbles for one spoken turn.
        const tryCoalesceIntoPriorFinal = (candidate) => {
          if (!candidate?.isFinal) return null;
          const list = get().transcriptions;
          const candidateIndex = list.findIndex((t) => t.id === candidate.id);
          if (candidateIndex <= 0) return null;
          const prior = list[candidateIndex - 1];
          if (!prior?.isFinal || legOf(prior.track) !== incomingLeg) return null;
          const gapMs =
            transcriptionTimestampMs(candidate.timestamp) -
            transcriptionTimestampMs(prior.timestamp);
          if (gapMs < 0 || gapMs > SAME_LEG_FINAL_COALESCE_MS) return null;
          const norm = (s) => compactTranscriptText(s).toLowerCase();
          if (norm(prior.transcript) === norm(candidate.transcript)) {
            // Same rule as the append-path dedupe: an insubstantial equal
            // ("No." after "No.") past the machine-redelivery window is a
            // REPEATED ANSWER to a new question, not a duplicate — deleting
            // it here lost the second answer when it arrived interim-first
            // and finalized inside the coalesce window (Codex P1 on #1367).
            const insubstantialRepeat =
              !isSubstantialDuplicateText(normalizeDuplicateText(candidate.transcript)) &&
              gapMs > ADJACENT_INSUBSTANTIAL_DUPLICATE_WINDOW_MS;
            if (!insubstantialRepeat) {
              const transcriptions = list.filter((_, i) => i !== candidateIndex);
              set({ transcriptions }, false, "coalesceTranscriptionDuplicate");
              return prior.id;
            }
            return null;
          }
          const merged = {
            ...prior,
            timestamp: candidate.timestamp || now,
            transcript: mergeCoalesceTranscript(prior.transcript, candidate.transcript),
            confidence: candidate.confidence ?? prior.confidence,
            source: candidate.source || prior.source || null,
            provider: candidate.provider || prior.provider || null,
            model: candidate.model || prior.model || null,
            language: candidate.language || prior.language || null,
            translation: candidate.translation || prior.translation || null,
          };
          const transcriptions = list
            .map((t, i) => (i === candidateIndex - 1 ? merged : t))
            .filter((_, i) => i !== candidateIndex);
          set({ transcriptions }, false, "coalesceTranscription");
          return merged.id;
        };

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
          if (isFinal) {
            const coalescedId = tryCoalesceIntoPriorFinal(updated);
            if (coalescedId) return coalescedId;
          }
          return updated.id;
        }

        // Dedup / coalesce FINAL bubbles on the same leg when appending a new row.
        // 1) Identical text re-delivery (is_final + speech_final, or WS replay).
        // 2) Flux over-segmentation: different text within a short gap is one turn.
        //
        // an earlier fix: the identical/continuation checks scan a bounded RECENT
        // WINDOW of same-leg entries, not just the last element. Live cross-
        // talk interleaves the other speaker's bubble between the two copies
        // of a duplicated line, so a last-element-only comparison missed
        // every real duplicate. A second copy anywhere in the window is
        // dropped; a final that CONTINUES an earlier fragment (a growing STT
        // hypothesis whose bubble key rotated away — the growing-prefix
        // cascade) replaces that fragment in place, and any other fragments
        // of the same utterance in the window are swept out.
        if (isFinal) {
          const incomingNorm = normalizeDuplicateText(transcriptionData.transcript);
          if (incomingNorm) {
            const list = state.transcriptions;
            const nowMs = Date.now();
            let replaceIndex = -1;
            const sweepIndexes = [];
            for (let i = list.length - 1, scanned = 0; i >= 0 && scanned < RECENT_DUPLICATE_SCAN_ENTRIES; i--) {
              const candidate = list[i];
              if (legOf(candidate.track) !== incomingLeg) continue;
              scanned++;
              const ageMs = nowMs - transcriptionTimestampMs(candidate.timestamp);
              if (Number.isFinite(ageMs) && ageMs > RECENT_DUPLICATE_WINDOW_MS) break;
              const candidateNorm = normalizeDuplicateText(candidate.transcript);
              if (!candidateNorm) continue;
              // The literal last array element keeps a near-unconditional
              // dedupe for substantial text; anything further back must have
              // substance (so a genuinely repeated short backchannel renders)
              // AND sit inside the tight exact-duplicate window (so an
              // intentional re-ask of the same sentence a few seconds later
              // renders too — only near-simultaneous copies are machine
              // duplicates).
              //
              // An INSUBSTANTIAL adjacent equal ("No.", "Yes.", "Okay.") gets
              // the tight machine window even when adjacent: a customer
              // answering two consecutive questions "No." ... "No." lands
              // adjacent whenever the agent's question bubble is late, and an
              // unconditional drop swallowed the second ANSWER — on the the reference workflow
              // intake that ate the final "other aircraft responding?" boolean
              // and stalled the whole confirmation stage. A true redundant-
              // source re-delivery arrives within ~2s; a second answer sits
              // behind a whole spoken question and lands well past it.
              const isAdjacent = i === list.length - 1;
              const exactDroppable = isAdjacent
                ? (isSubstantialDuplicateText(incomingNorm) ||
                    (Number.isFinite(ageMs) && ageMs <= ADJACENT_INSUBSTANTIAL_DUPLICATE_WINDOW_MS))
                : (isSubstantialDuplicateText(incomingNorm) &&
                    Number.isFinite(ageMs) &&
                    ageMs <= NONADJACENT_EXACT_DUPLICATE_WINDOW_MS);
              if (candidate.isFinal && exactDroppable && candidateNorm === incomingNorm) {
                // Same utterance delivered again under another key.
                return candidate.id;
              }
              if (candidate.isFinal && exactDroppable && textContinues(candidateNorm, incomingNorm)) {
                // Incoming is a late, shorter replay of an utterance already
                // rendered in full.
                return candidate.id;
              }
              // Gated on exactDroppable too (verified this session): textContinues
              // is a plain string-prefix check with NO word-boundary awareness, so
              // an UNRELATED later utterance that happens to start with the same
              // letters as an earlier SHORT one ("No." finalized, then seconds
              // later "Not sure about that" or "North wing, room 204" — both
              // literally start with "no") would otherwise be silently absorbed
              // into it, erasing the real earlier answer. Requiring adjacency OR
              // (substance + the tight window) — the same bar the sibling exact-
              // duplicate/tail-repeat checks above already clear — still allows the
              // reported cascade bug's fix: a growing STT hypothesis's fragments
              // are each other's IMMEDIATE predecessor (isAdjacent=true) as they
              // arrive in rapid succession, so the common step-by-step collapse is
              // unaffected; only a non-adjacent, cross-turn "continuation" needs
              // the extra bar.
              if (exactDroppable && textContinues(incomingNorm, candidateNorm)) {
                // Candidate is an earlier fragment of THIS utterance. Replace
                // the newest fragment in place; remember older ones to sweep.
                if (replaceIndex === -1) replaceIndex = i;
                else sweepIndexes.push(i);
              }
            }
            if (replaceIndex !== -1) {
              const target = list[replaceIndex];
              const updated = {
                ...target,
                timestamp: now,
                transcript: transcriptionData.transcript || target.transcript,
                isFinal: true,
                track,
                callControlId: callControlId || target.callControlId,
                confidence: confidence ?? target.confidence,
                source: transcriptionData.source || target.source || null,
                provider: transcriptionData.provider || target.provider || null,
                model: transcriptionData.model || target.model || null,
                language: transcriptionData.language || target.language || null,
                translation: transcriptionData.translation || target.translation || null,
              };
              const sweep = new Set(sweepIndexes);
              const transcriptions = list
                .map((t, i) => (i === replaceIndex ? updated : t))
                .filter((_, i) => !sweep.has(i));
              set({ transcriptions }, false, "replaceTranscriptionFragment");
              return updated.id;
            }
          }
          const last = state.transcriptions[state.transcriptions.length - 1];
          const norm = (s) => compactTranscriptText(s).toLowerCase();
          const incomingText = norm(transcriptionData.transcript);
          // Equal-text adjacents past the machine window are a REPEATED bare
          // answer to a new question ("No." ... "No."), not one over-segmented
          // turn — coalescing them merges to identical text on the same row
          // id, so the analysis effect (keyed on id+text) never re-fires and
          // the second answer is lost. Append a fresh row instead.
          const isRepeatedBareAnswer =
            last && incomingText && norm(last.transcript) === incomingText;
          if (last && last.isFinal && legOf(last.track) === incomingLeg && incomingText && !isRepeatedBareAnswer) {
            const gapMs = Date.now() - transcriptionTimestampMs(last.timestamp);
            if (gapMs >= 0 && gapMs <= SAME_LEG_FINAL_COALESCE_MS) {
              const mergedTranscript = mergeCoalesceTranscript(
                last.transcript,
                transcriptionData.transcript
              );
              const updated = {
                ...last,
                timestamp: now,
                transcript: mergedTranscript,
                isFinal: true,
                track,
                callControlId: callControlId || last.callControlId,
                confidence: confidence ?? last.confidence,
                source: transcriptionData.source || last.source || null,
                provider: transcriptionData.provider || last.provider || null,
                model: transcriptionData.model || last.model || null,
                language: transcriptionData.language || last.language || null,
                translation: transcriptionData.translation || last.translation || null,
              };
              const transcriptions = [...state.transcriptions];
              transcriptions[transcriptions.length - 1] = updated;
              set({ transcriptions }, false, "coalesceTranscription");
              return updated.id;
            }
          }
        }

        // Phantom interim re-fire guard: Deepgram's utterance_end_ms can send a
        // brand-new interim (fresh transcription_key, is_final=false) that
        // re-announces the utterance that was *just* finalized on the same leg
        // — either the full text again, or just a TRAILING portion of it (e.g.
        // final "Thanks for calling. How can I help you today?" followed by a
        // phantom interim "How can I help you today"). The exact-duplicate
        // check above only runs `if (isFinal)`, so this interim re-announcement
        // sails straight through to a brand-new bubble that then finalizes
        // independently, producing a full duplicate. Suppress it here instead
        // of creating a bubble for this key at all: if the re-fire later
        // diverges into genuinely new text, it will no longer match `last` and
        // will correctly fall through to a fresh bubble at that point.
        if (!isFinal) {
          const incomingCore = normalizeDuplicateText(transcriptionData.transcript);
          if (incomingCore) {
            // an earlier fix: scan the recent same-leg window, not just the last
            // element — the phantom re-announcement lands after the other
            // speaker's bubble as often as not. A leading-prefix repeat
            // ("Okay" re-announced after "Okay. Alright. Cool." finalized)
            // is suppressed the same way as the tail repeat.
            const list = state.transcriptions;
            const nowMs = Date.now();
            for (let i = list.length - 1, scanned = 0; i >= 0 && scanned < RECENT_DUPLICATE_SCAN_ENTRIES; i--) {
              const candidate = list[i];
              if (legOf(candidate.track) !== incomingLeg) continue;
              scanned++;
              const ageMs = nowMs - transcriptionTimestampMs(candidate.timestamp);
              if (Number.isFinite(ageMs) && ageMs > RECENT_DUPLICATE_WINDOW_MS) break;
              if (!candidate.isFinal) continue;
              const candidateCore = normalizeDuplicateText(candidate.transcript);
              if (!candidateCore) continue;
              // Only suppress interims with some substance (see
              // isSubstantialDuplicateText) or inside the tight machine
              // window — a phantom re-announcement fires immediately after
              // the real final, while the opening interim of a repeated bare
              // answer ("No." to the next question) comes seconds later and
              // must open its own bubble. The adjacent case gets the tight
              // window too: the second "No."'s interim lands adjacent
              // whenever the agent's question bubble is late.
              if (
                i === list.length - 1 &&
                !isSubstantialDuplicateText(incomingCore) &&
                (!Number.isFinite(ageMs) || ageMs > ADJACENT_INSUBSTANTIAL_DUPLICATE_WINDOW_MS)
              ) continue;
              if (
                i !== list.length - 1 &&
                (!isSubstantialDuplicateText(incomingCore) ||
                  !Number.isFinite(ageMs) ||
                  ageMs > NONADJACENT_EXACT_DUPLICATE_WINDOW_MS)
              ) continue;
              const isExactRepeat = candidateCore === incomingCore;
              const isTailRepeat =
                candidateCore.endsWith(` ${incomingCore}`) || candidateCore.endsWith(incomingCore);
              const isLeadRepeat = textContinues(candidateCore, incomingCore);
              if (isExactRepeat || isTailRepeat || isLeadRepeat) {
                return candidate.id;
              }
            }
          }
        }

        const transcription = {
          id: activeTranscriptionKey || `${Date.now()}-${Math.random()}`,
          transcriptionKey: activeTranscriptionKey,
          originalTranscriptionKey,
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

      removeTranscription: (transcriptionKey) => {
        const state = get();
        const transcriptions = state.transcriptions.filter(
          (t) => t.transcriptionKey !== transcriptionKey && t.originalTranscriptionKey !== transcriptionKey
        );
        if (transcriptions.length !== state.transcriptions.length) {
          set({ transcriptions }, false, "removeTranscription");
        }
      },

      /**
       * Update transcription with intent/sentiment analysis
       */
      updateTranscriptionAnalysis: (transcriptionId, analysis) => {
        const state = get();
        let targetIndex = -1;

        if (targetIndex < 0) {
          let fallbackIndex = -1;

          for (let i = state.transcriptions.length - 1; i >= 0; i -= 1) {
            const transcription = state.transcriptions[i];

            if (
              transcription.id === transcriptionId ||
              transcription.transcriptionKey === transcriptionId
            ) {
              targetIndex = fallbackIndex >= 0 ? fallbackIndex : i;
              break;
            }

            if (
              fallbackIndex < 0 &&
              transcription.originalTranscriptionKey === transcriptionId
            ) {
              fallbackIndex = i;
            }
          }

          if (targetIndex < 0) {
            targetIndex = fallbackIndex;
          }
        }

        if (targetIndex < 0) {
          return;
        }

        const updated = [...state.transcriptions];
        updated[targetIndex] = { ...updated[targetIndex], ...analysis };

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
       * Agent Assist persistence is fire-and-forget; call metrics come from Core events.
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

        get()
          .syncAgentAssistToDb()
          .catch((err) => {
            // Error syncing transcription data
          });

        get().stopDurationTimer();

        set(
          {
            call: null,
            recoveredCallHeaders: [],
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
