import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const detailPage = readFileSync("app/(portal)/supervisor/call-history/[id]/page.jsx", "utf8");
const studioCard = readFileSync("components/contact-center/TranscriptionStudioCard.jsx", "utf8");
const transcriptionSheet = readFileSync("components/contact-center/TranscriptionSheet.jsx", "utf8");
const diarizedTranscript = readFileSync("components/contact-center/DiarizedTranscript.jsx", "utf8");
const transcribeRoute = readFileSync("app/api/voice/recordings/[id]/transcribe/route.js", "utf8");
const modelsConfig = readFileSync("config/transcription-models.js", "utf8");
const utils = readFileSync("lib/voice-transcription-utils.mjs", "utf8");
const recordingPlayer = readFileSync("components/contact-center/RecordingPlayer.jsx", "utf8");

test("transcription models config exposes nova-3 with diarization and languages", () => {
  assert.match(modelsConfig, /"deepgram\/nova-3"/);
  assert.match(modelsConfig, /supportsDiarization: true/);
  assert.match(modelsConfig, /"multi"/);
  assert.match(modelsConfig, /"pl"/);
  assert.match(modelsConfig, /DEFAULT_TRANSCRIPTION_MODEL = "deepgram\/nova-3"/);
  // Nova-3 model_config builder honors diarize/smart_format/punctuate/numerals
  assert.match(modelsConfig, /buildTranscriptionModelConfig/);
  for (const key of ["smart_format", "punctuate", "diarize", "numerals"]) {
    assert.match(modelsConfig, new RegExp(`"${key}"`));
  }
});

test("transcribe API accepts model/language/options and stores speaker turns", () => {
  // Request body fields
  assert.match(transcribeRoute, /model: requestedModel/);
  assert.match(transcribeRoute, /language: requestedLanguage/);
  assert.match(transcribeRoute, /options: requestedOptions/);
  // Model allowlist validation with nova-3 default
  assert.match(transcribeRoute, /TRANSCRIPTION_MODELS\.some\(\(m\) => m\.value === requestedModel\)/);
  assert.match(transcribeRoute, /DEFAULT_TRANSCRIPTION_MODEL/);
  // model_config forwarded for nova-3
  assert.match(transcribeRoute, /buildTranscriptionModelConfig\(model, options, language\)/);
  assert.match(transcribeRoute, /formData\.append\("model_config", JSON\.stringify\(modelConfig\)\)/);
  // verbose_json + diarized speaker turns extracted and persisted
  assert.match(transcribeRoute, /verbose_json/);
  assert.match(transcribeRoute, /extractSpeakerTurns\(transcriptionData\)/);
  assert.match(transcribeRoute, /extractTranscriptionConfidence\(transcriptionData\)/);
  assert.match(transcribeRoute, /transcription_speaker_turns: speakerTurns/);
  assert.match(transcribeRoute, /transcription_details/);
  // Hardcoded legacy model is gone
  assert.doesNotMatch(transcribeRoute, /formData\.append\("model", "distil-whisper\/distil-large-v2"\)/);
});

test("speaker turn extraction utils are present", () => {
  assert.match(utils, /export function extractSpeakerTurns/);
  assert.match(utils, /export function extractTranscriptionConfidence/);
});

test("transcription studio card offers model, language, and nova-3 toggles", () => {
  assert.match(studioCard, /transcription-studio-card/);
  assert.match(studioCard, /Transcription Studio/);
  // Model select + language combobox
  assert.match(studioCard, /TRANSCRIPTION_MODELS\.map/);
  assert.match(studioCard, /buildLanguageOptions/);
  assert.match(studioCard, /<Combobox/);
  // Nova-3 switches
  assert.match(studioCard, /Diarize speakers/);
  assert.match(studioCard, /Smart format/);
  assert.match(studioCard, /Punctuate/);
  assert.match(studioCard, /Numerals/);
  // Actions and result stats
  assert.match(studioCard, /transcribe-button/);
  assert.match(studioCard, /view-conversation-button/);
  assert.match(studioCard, /Re-transcribe/);
  assert.match(studioCard, /transcription-stats/);
  // Sends settings to the API
  assert.match(studioCard, /body: JSON\.stringify\(\{\s*interactionId,\s*model,\s*language: effectiveLanguage/);
});

test("transcription sheet renders diarized chat bubbles via the shared synced component", () => {
  // Sheet delegates diarized rendering to the shared DiarizedTranscript (playback-synced)
  assert.match(transcriptionSheet, /import DiarizedTranscript from "\.\/DiarizedTranscript"/);
  assert.match(transcriptionSheet, /<DiarizedTranscript/);
  assert.match(transcriptionSheet, /onSeek=\{onSeekRecording\}/);
  // Keeps the channel-based fallback for legacy transcripts
  assert.match(transcriptionSheet, /parseTranscription/);
  assert.match(transcriptionSheet, /Speaker Timeline/);
  // Header badges with model and confidence
  assert.match(transcriptionSheet, /speakers · /);
  assert.match(transcriptionSheet, /Confidence \{confidenceLabel\}/);
});

test("shared DiarizedTranscript syncs bubbles to recording playback", () => {
  assert.match(diarizedTranscript, /data-testid="diarized-transcript"/);
  assert.match(diarizedTranscript, /SPEAKER_TONES/);
  assert.match(diarizedTranscript, /Speaker \{Number\(turn\.speaker\) \+ 1\}/);
  // Highlights the active turn, scrolls to it, and seeks on click
  assert.match(diarizedTranscript, /ring-2 ring-orange-500/);
  assert.match(diarizedTranscript, /scrollIntoView/);
  assert.match(diarizedTranscript, /onSeek\(Math\.max\(0, Number\(turn\.start\) - 0\.3\)\)/);
});

test("recording tab embeds the studio card below the player", () => {
  assert.match(detailPage, /<RecordingPlayer[\s\S]*?\/>\s*<TranscriptionStudioCard/);
  assert.match(detailPage, /transcriptionSpeakerTurns=\{transcriptionSpeakerTurns\}/);
  assert.match(detailPage, /transcriptionDetails=\{transcriptionDetails\}/);
  // Player no longer owns transcription logic
  assert.doesNotMatch(recordingPlayer, /Transcribe Recording/);
  assert.doesNotMatch(recordingPlayer, /TranscriptionSheet/);
});

test("interaction details top tiles use the redesigned layout", () => {
  assert.match(detailPage, /participants-tile/);
  assert.match(detailPage, /call-details-tile/);
  assert.match(detailPage, /call-ids-tile/);
  // Gradient accent bars and icon chips
  assert.match(detailPage, /bg-gradient-to-r from-sky-500 to-cyan-400/);
  assert.match(detailPage, /bg-gradient-to-r from-emerald-500 to-teal-400/);
  assert.match(detailPage, /bg-gradient-to-r from-violet-500 to-fuchsia-400/);
  // Participants render as avatar rows with role badges
  assert.match(detailPage, /Unknown caller/);
  assert.match(detailPage, />\s*Caller\s*<\/Badge>/);
  assert.match(detailPage, />\s*Agent\s*<\/Badge>/);
  // Call details as mini stat boxes with status badge
  assert.match(detailPage, /Wrap-up codes/);
  assert.match(detailPage, /No codes recorded/);
  // Call IDs with copy buttons rendered from one map
  assert.match(detailPage, /\["Interaction ID", interaction\.id\]/);
  assert.match(detailPage, /\["Call Control ID", interaction\.call_control_id\]/);
  assert.match(detailPage, /\["Call Session ID", interaction\.call_session_id\]/);
  // Old plain key:value rows are gone
  assert.doesNotMatch(detailPage, /border-l-4 border-l-blue-500/);
  assert.doesNotMatch(detailPage, /grid-cols-\[120px_1fr\]/);
});
