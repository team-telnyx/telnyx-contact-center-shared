/**
 * Shared, client-safe persona + voice-expression helpers for Workflow Testing.
 *
 * This module contains ONLY pure functions and constants (no server-only
 * imports such as loggers, DB pools or env-dependent config) so it can be
 * imported from both:
 *   - server code (lib/call-generator/workflow-testing.mjs — call-flow tester), and
 *   - client code (app/(portal)/admin/workflows/[id]/test/page.jsx — browser
 *     "Test AI Agent" page).
 *
 * Keeping personas, persona→emotion mapping and the Expressive Mode logic in one
 * place guarantees the simulated caller behaves identically in both testers
 * (consistent persona vocabulary, consistent TTS expression tags).
 */

// Caller persona presets for the simulated customer. Persona ids are aligned
// 1:1 with the Telnyx Ultra SSML emotion vocabulary
// (https://developers.telnyx.com/docs/tts-stt/telnyx-ultra-voices) so that, for
// Ultra voices with Expressive Mode on, the persona maps directly to an
// <emotion value="<persona>" /> tag. `neutral` maps to no emotion tag.
export const WORKFLOW_TESTING_PERSONAS = [
  { id: "neutral", label: "Neutral / cooperative", instruction: "" },
  { id: "angry", label: "Angry", instruction: "You are angry and irritated. Speak curtly and sound frustrated, but still ultimately provide the information the agent asks for." },
  { id: "excited", label: "Excited", instruction: "You are excited and energetic. Sound upbeat and eager while providing the information the agent asks for." },
  { id: "content", label: "Content", instruction: "You are calm and content. Sound relaxed and satisfied while providing the information the agent asks for." },
  { id: "sad", label: "Sad", instruction: "You are sad and downcast. Sound subdued and low-energy, but still provide the information the agent asks for." },
  { id: "scared", label: "Scared", instruction: "You are anxious and worried. Sound nervous and uneasy, but still provide the information the agent asks for." },
  { id: "happy", label: "Happy", instruction: "You are happy and cheerful. Sound pleasant and positive while providing the information the agent asks for." },
  { id: "enthusiastic", label: "Enthusiastic", instruction: "You are very enthusiastic and keen. Sound highly motivated and positive while providing the information the agent asks for." },
  { id: "curious", label: "Curious", instruction: "You are curious and inquisitive. Ask the occasional clarifying question out of interest, but still provide the information the agent asks for." },
  { id: "calm", label: "Calm", instruction: "You are very calm and measured. Speak slowly and evenly while providing the information the agent asks for." },
  { id: "grateful", label: "Grateful", instruction: "You are grateful and appreciative. Thank the agent and sound warm while providing the information the agent asks for." },
  { id: "affectionate", label: "Affectionate", instruction: "You are warm and affectionate. Sound friendly and caring while providing the information the agent asks for." },
  { id: "sarcastic", label: "Sarcastic", instruction: "You are sarcastic and dryly witty. Add mild sarcasm to your replies, but still provide the information the agent asks for." },
  { id: "surprised", label: "Surprised", instruction: "You are surprised and a little taken aback. React with mild surprise, but still provide the information the agent asks for." },
  { id: "confident", label: "Confident", instruction: "You are confident and assertive. Sound self-assured and direct while providing the information the agent asks for." },
  { id: "hesitant", label: "Hesitant", instruction: "You are hesitant and unsure. Pause and second-guess yourself, occasionally correcting a detail, but still provide the information the agent asks for." },
  { id: "apologetic", label: "Apologetic", instruction: "You are apologetic and self-conscious. Apologize for small things while providing the information the agent asks for." },
  { id: "determined", label: "Determined", instruction: "You are determined and focused. Sound resolute and goal-oriented while providing the information the agent asks for." },
  { id: "frustrated", label: "Frustrated", instruction: "You are frustrated and exasperated. Sound annoyed at delays, but still provide the information the agent asks for." },
  { id: "disappointed", label: "Disappointed", instruction: "You are disappointed and let down. Sound deflated, but still provide the information the agent asks for." },
];

const PERSONA_BY_ID = Object.fromEntries(WORKFLOW_TESTING_PERSONAS.map((p) => [p.id, p]));

export function normalizePersona(value) {
  const id = String(value || "neutral").trim().toLowerCase();
  return PERSONA_BY_ID[id] ? id : "neutral";
}

export function personaInstruction(personaId) {
  return PERSONA_BY_ID[normalizePersona(personaId)]?.instruction || "";
}

// Clamp the configured "max slots/answers per turn" to a sane 1..6 range.
export function normalizeMaxSlotsPerTurn(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, Math.round(n)));
}

// Resolve how many distinct pieces of information the caller should reveal in a
// single turn. With randomize enabled and max>1, pick a random count in 1..max.
export function resolveSlotCountForTurn({ maxSlotsPerTurn, randomizeSlots } = {}, rng = Math.random) {
  const max = normalizeMaxSlotsPerTurn(maxSlotsPerTurn);
  if (max <= 1) return 1;
  if (randomizeSlots === true) return 1 + Math.floor(rng() * max);
  return max;
}

// --- Expressive Mode (per-voice TTS expression) -----------------------------
//
// Two voice families support expression:
//   • Telnyx Ultra (Telnyx.Ultra.*): SSML emotion tags <emotion value="..." />
//     and the nonverbal [laughter].
//   • xAI Grok (xAI.*): inline xAI speech tags ([pause], [laugh], [sigh], ...)
//     and wrapping delivery tags (<whisper>, <emphasis>, ...).
//
// Expressive Mode is a per-test toggle that is only meaningful for those two
// families. When OFF (or for any other voice) the spoken audio carries NO
// expression tags.

export function isUltraVoice(voice) {
  return /^Telnyx\.Ultra\./i.test(String(voice || "").trim());
}

export function isXaiVoice(voice) {
  return /^xAI\./i.test(String(voice || "").trim());
}

// "ultra" (SSML emotion tags), "xai" (inline/wrapping speech tags), or null.
export function voiceExpressiveKind(voice) {
  if (isUltraVoice(voice)) return "ultra";
  if (isXaiVoice(voice)) return "xai";
  return null;
}

export function voiceSupportsExpressive(voice) {
  return voiceExpressiveKind(voice) !== null;
}

// The valid Ultra emotion values. Persona ids are aligned to these names.
export const ULTRA_EMOTIONS = [
  "angry", "excited", "content", "sad", "scared", "happy", "enthusiastic",
  "curious", "calm", "grateful", "affectionate", "sarcastic", "surprised",
  "confident", "hesitant", "apologetic", "determined", "frustrated", "disappointed",
];

export function personaEmotion(personaId) {
  const id = normalizePersona(personaId);
  return id !== "neutral" && ULTRA_EMOTIONS.includes(id) ? id : null;
}

// Map a persona to a fitting xAI inline speech tag prefix. xAI has no direct
// "emotion" tag, so we approximate with vocal cues / delivery wrappers.
const PERSONA_XAI_PREFIX = {
  angry: "<loud>",
  frustrated: "<emphasis>",
  excited: "<fast>",
  enthusiastic: "<build-intensity>",
  happy: "[chuckle] ",
  sad: "<soft>",
  disappointed: "<slow>",
  scared: "<whisper>",
  hesitant: "[pause] ",
  calm: "<slow>",
  content: "<soft>",
  confident: "<emphasis>",
  determined: "<emphasis>",
  curious: "[pause] ",
  surprised: "[breath] ",
  grateful: "<soft>",
  affectionate: "<soft>",
  apologetic: "<soft>",
  sarcastic: "<slow>",
};

const XAI_WRAPPERS = ["soft", "whisper", "loud", "build-intensity", "decrease-intensity", "higher-pitch", "lower-pitch", "slow", "fast", "sing-song", "singing", "laugh-speak", "emphasis"];

// Apply voice expression to the spoken text, honouring the Expressive Mode
// toggle and the voice family. Returns the text UNCHANGED when:
//   - expressive is false/off,
//   - the voice does not support expression,
//   - the persona is neutral,
//   - or the text already begins with an expression tag (LLM produced one).
// For Ultra: prepends <emotion value="<persona>" />.
// For xAI: prepends/wraps with the persona's xAI tag.
export function applyVoiceExpression(text, { voice, persona, expressive } = {}) {
  const raw = String(text || "");
  if (expressive !== true) return raw;
  const kind = voiceExpressiveKind(voice);
  if (!kind) return raw;
  const personaId = normalizePersona(persona);
  if (personaId === "neutral") return raw;

  if (kind === "ultra") {
    if (/^\s*<emotion\b/i.test(raw)) return raw;
    const emotion = personaEmotion(personaId);
    if (!emotion) return raw;
    return `<emotion value="${emotion}" />${raw}`;
  }

  // xAI
  const prefix = PERSONA_XAI_PREFIX[personaId];
  if (!prefix) return raw;
  // If the LLM already produced an xAI tag at the start, don't double-wrap.
  if (/^\s*(\[[a-z-]+\]|<[a-z-]+>)/i.test(raw)) return raw;
  if (prefix.startsWith("<")) {
    const tag = prefix.replace(/[<>]/g, "");
    if (XAI_WRAPPERS.includes(tag)) return `<${tag}>${raw}</${tag}>`;
  }
  return `${prefix}${raw}`;
}

// Back-compat alias.
export function applyUltraExpression(text, { voice, persona, expressive = true } = {}) {
  return applyVoiceExpression(text, { voice, persona, expressive });
}
