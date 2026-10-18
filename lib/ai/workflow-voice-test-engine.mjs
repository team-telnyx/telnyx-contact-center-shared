// Turn engine for the workflow "Test AI Agent" voice channel.
//
// Consumes the documented Telnyx conversation WebSocket events (as relayed by
// TelnyxAvatarClient's "assistant.event") and returns UI/loop actions. Turn
// boundaries come from the events themselves: an assistant turn is final on
// response.done, the caller's turn opens only after a completed response, a
// cancelled response means the caller barged in, and a failed or incomplete
// response ends the test (the caller never answers a cut-off line). No timers,
// no loudness heuristics, no "welcome gate".

// "thank you for calling" is deliberately absent: assistants use it as a greeting.
export const DEFAULT_ENDING_PHRASES = [
  "goodbye", "good bye", "have a great day", "have a nice day",
  "take care", "end the call", "ending the call",
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A closing phrase counts only as whole words in the response's last sentence:
// "I'll take care of that. What is your postcode?" is not a goodbye.
export function detectsEnding(text, phrases = DEFAULT_ENDING_PHRASES) {
  const sentences = String(text || "").toLowerCase().split(/(?<=[.!?])\s+/).filter((sentence) => /[a-z]/.test(sentence));
  const last = sentences.at(-1);
  if (!last) return false;
  return phrases.some((phrase) => new RegExp(`(^|[^a-z])${escapeRegExp(phrase).replace(/\s+/g, "\\s+")}([^a-z]|$)`).test(last));
}

export function createVoiceTestEngine({ endingPhrases = DEFAULT_ENDING_PHRASES } = {}) {
  const state = {
    phase: "connecting", // connecting → greeting → assistant ⇄ caller → ending | ended
    conversationId: null,
    outputRate: null,
    responseId: null,
    items: new Map(),
    order: [],
    turns: 0,
    ended: false,
  };

  function resetResponse() { state.responseId = null; state.items = new Map(); state.order = []; }

  function handle(frame) {
    const actions = [];
    switch (frame?.type) {
      case "session.created":
        state.phase = "greeting";
        state.conversationId = frame.session?.conversation_id || null;
        state.outputRate = frame.session?.audio?.output?.format?.rate ?? null;
        actions.push({ type: "session", conversationId: state.conversationId, outputRate: state.outputRate });
        break;
      case "response.created":
        resetResponse();
        state.responseId = frame.response?.id || null;
        state.phase = "assistant";
        actions.push({ type: "assistant_started", responseId: state.responseId });
        break;
      case "response.output_audio_transcript.delta": {
        const itemId = frame.item_id || frame.response_id || state.responseId || "assistant";
        if (!state.items.has(itemId)) { state.items.set(itemId, ""); state.order.push(itemId); }
        state.items.set(itemId, state.items.get(itemId) + (frame.delta || ""));
        actions.push({ type: "assistant_delta", itemId, text: state.items.get(itemId) });
        break;
      }
      case "response.done": {
        const status = frame.response?.status || "completed", interrupted = status === "cancelled";
        const failed = !interrupted && status !== "completed";
        const responseId = frame.response?.id || state.responseId;
        const text = state.order.map((id) => state.items.get(id)).join("").replace(/\s+/g, " ").trim();
        resetResponse();
        if (text) actions.push({ type: "assistant_final", responseId, text, interrupted, ...(failed ? { failed: true } : {}) });
        if (state.ended) break;
        if (interrupted) { state.phase = "caller"; break; } // the caller is already talking
        // failed / incomplete: the assistant did not finish its turn. Answering a
        // cut-off line would distort the test, so the test stops and says why.
        if (failed) { state.ended = true; state.phase = "ending"; actions.push({ type: "response_failed", responseId, status }); break; }
        if (!text) { state.phase = "caller"; actions.push({ type: "silent_response", responseId }); break; }
        if (detectsEnding(text, endingPhrases)) { state.ended = true; state.phase = "ending"; actions.push({ type: "ending", text }); break; }
        state.phase = "caller"; state.turns += 1;
        actions.push({ type: "caller_turn", turn: state.turns, text });
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        actions.push({ type: "user_final", itemId: frame.item_id || null, text: String(frame.transcript || "").trim() });
        break;
      case "input_audio_buffer.speech_started": actions.push({ type: "user_speaking" }); break;
      case "input_audio_buffer.speech_stopped": actions.push({ type: "user_stopped" }); break;
      case "response.tool_call.started": actions.push({ type: "tool", name: frame.tool_call?.name || null, status: "started" }); break;
      case "response.tool_call.completed": actions.push({ type: "tool", name: frame.tool_call?.name || null, status: frame.status || "completed" }); break;
      case "error": actions.push({ type: "error", code: frame.error?.code || null, message: frame.error?.message || "Telnyx reported an error" }); break;
      case "session.ended":
        state.ended = true; state.phase = "ended";
        actions.push({ type: "ended" });
        break;
      default: break;
    }
    return actions;
  }

  return {
    handle,
    get phase() { return state.phase; },
    get conversationId() { return state.conversationId; },
    get outputRate() { return state.outputRate; },
    get turns() { return state.turns; },
    get ended() { return state.ended; },
    // The assistant was told to stop (the operator stopped the test); further
    // completed responses no longer open caller turns.
    stop() { state.ended = true; if (state.phase !== "ended") state.phase = "ending"; },
  };
}
