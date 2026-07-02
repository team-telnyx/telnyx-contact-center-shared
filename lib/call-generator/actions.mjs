// Call Generator — action sequence helpers (T6)
//
// Step shapes stored in cg_actions.steps (JSONB array, ordered):
//   { type: 'play_media', media_name }
//   { type: 'speak', text, voice }          — voice like "AWS.Polly.Joanna"
//   { type: 'send_dtmf', digits }           — digits 0-9 A-D # * w (w = 0.5s pause)
//   { type: 'delay', delay_ms }             — pause between surrounding steps (ms)
//   { type: 'workflow_testing', voice, sample_text, persona, max_slots_per_turn, randomize_slots, reply_delay_ms } — protected dynamic LLM caller action

const DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT = "This is a neutral voice preview for workflow testing.";
// Persona ids aligned with the Telnyx Ultra emotion vocabulary (+ neutral).
const WORKFLOW_TESTING_PERSONA_IDS = [
  "neutral", "angry", "excited", "content", "sad", "scared", "happy",
  "enthusiastic", "curious", "calm", "grateful", "affectionate", "sarcastic",
  "surprised", "confident", "hesitant", "apologetic", "determined",
  "frustrated", "disappointed",
];
// Expressive Mode is only meaningful for voice families that render expression
// tags: Telnyx Ultra (Telnyx.Ultra.*) and xAI Grok (xAI.*).
function voiceSupportsExpressive(voice) {
  const v = String(voice || "").trim();
  return /^Telnyx\.Ultra\./i.test(v) || /^xAI\./i.test(v);
}

// Bounds for the inter-step Delay action (milliseconds).
const DELAY_MIN_MS = 100;
const DELAY_MAX_MS = 30000;
const DEFAULT_DELAY_MS = 1000;
// Bounds for the Workflow Testing reply delay (ms) — how long the generator
// waits after the agent finishes speaking before it starts the caller reply.
const REPLY_DELAY_MIN_MS = 0;
const REPLY_DELAY_MAX_MS = 10000;
const DEFAULT_REPLY_DELAY_MS = 0;

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeSteps(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((step) => {
      const type = String(step?.type || "").toLowerCase();
      if (type === "play_media") {
        const mediaName = String(step.media_name || "").trim();
        return mediaName ? { type, media_name: mediaName } : null;
      }
      if (type === "speak") {
        const text = String(step.text || "").trim();
        if (!text) return null;
        return { type, text: text.slice(0, 3000), voice: String(step.voice || "AWS.Polly.Joanna").trim() };
      }
      if (type === "send_dtmf") {
        const digits = String(step.digits || "").replace(/[^0-9A-Da-d#*wW]/g, "");
        return digits ? { type, digits: digits.slice(0, 32) } : null;
      }
      if (type === "delay") {
        return { type, delay_ms: clampInt(step.delay_ms, DELAY_MIN_MS, DELAY_MAX_MS, DEFAULT_DELAY_MS) };
      }
      if (type === "workflow_testing") {
        const sampleText = String(step.sample_text || DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT).trim() || DEFAULT_WORKFLOW_TESTING_SAMPLE_TEXT;
        const persona = WORKFLOW_TESTING_PERSONA_IDS.includes(String(step.persona || "").toLowerCase())
          ? String(step.persona).toLowerCase()
          : "neutral";
        const maxSlots = Math.min(6, Math.max(1, Math.round(Number(step.max_slots_per_turn)) || 1));
        const voice = String(step.voice || "AWS.Polly.Joanna").trim();
        return {
          type,
          voice,
          sample_text: sampleText.slice(0, 1000),
          persona,
          max_slots_per_turn: maxSlots,
          randomize_slots: maxSlots > 1 ? step.randomize_slots === true : false,
          // Delay (ms) before the generator starts speaking the caller reply
          // after the agent's utterance finalizes. Lets the simulated caller
          // feel less rushed; 0 = reply immediately (previous behaviour).
          reply_delay_ms: clampInt(step.reply_delay_ms, REPLY_DELAY_MIN_MS, REPLY_DELAY_MAX_MS, DEFAULT_REPLY_DELAY_MS),
          // Expressive Mode only persists as true for voices that support it
          // (Telnyx Ultra / xAI). Any other voice forces it off so the speak
          // command never carries expression tags it cannot render.
          expressive: voiceSupportsExpressive(voice) ? step.expressive === true : false,
        };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 25);
}

export function describeStep(step) {
  if (!step) return "";
  if (step.type === "play_media") return `Play media ${step.media_name}`;
  if (step.type === "speak") return `Speak "${String(step.text || "").slice(0, 40)}${String(step.text || "").length > 40 ? "…" : ""}"`;
  if (step.type === "send_dtmf") return `Send DTMF "${step.digits}"`;
  if (step.type === "delay") return `Delay ${(Number(step.delay_ms) || 0) / 1000}s`;
  if (step.type === "workflow_testing") return "Workflow Testing — dynamic caller replies";
  return step.type;
}
