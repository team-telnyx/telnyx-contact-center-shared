import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const detailPage = readFileSync("app/(portal)/supervisor/call-history/[id]/page.jsx", "utf8");
const routingTimeline = readFileSync("components/contact-center/RoutingMetadataTimeline.jsx", "utf8");
const interactionTimeline = readFileSync("components/contact-center/InteractionTimeline.jsx", "utf8");
const recordingPlayer = readFileSync("components/contact-center/RecordingPlayer.jsx", "utf8");

test("interaction details timeline tab uses the redesigned cards", () => {
  assert.match(detailPage, /Call Phases/);
  assert.match(detailPage, /Event Journey/);
  assert.match(detailPage, /How the call time was split/);
  assert.match(detailPage, /Every routing event from first ring to wrap-up/);
  assert.match(detailPage, /dark:bg-zinc-950\/70/);
  // Old plain titles are gone
  assert.doesNotMatch(detailPage, /Interaction Timeline<\/CardTitle>/);
  assert.doesNotMatch(detailPage, /Detailed Event Timeline/);
});

test("routing timeline renders event cards on a gradient spine with detail chips", () => {
  // Gradient spine + tinted nodes + accent strip per event card
  assert.match(routingTimeline, /bg-gradient-to-b from-teal-500\/50 via-border to-red-500\/40/);
  assert.match(routingTimeline, /routing-timeline-event/);
  assert.match(routingTimeline, /const EVENT_TONES = \{/);
  assert.match(routingTimeline, /hover:-translate-y-0\.5/);
  // Detail chips replace the old plain-text detail rows
  assert.match(routingTimeline, /function DetailChip/);
  assert.match(routingTimeline, /<DetailChip icon=\{IconClockHour4\} label="Wait"/);
  assert.match(routingTimeline, /<DetailChip icon=\{IconPhoneCall\} label="Call Control ID"/);
  // Time since previous event shown as a badge
  assert.match(routingTimeline, /\+\{formatDuration\(timeSincePrevious\)\}/);
  // agent_timeout events stay hidden
  assert.match(routingTimeline, /event\.type !== "agent_timeout"/);
  // Routing algorithm badge preserved
  assert.match(routingTimeline, /RoutingTypeBadge/);
});

test("interaction phase bar has icons, share tooltips, and a totals legend", () => {
  assert.match(interactionTimeline, /const SEGMENT_STYLES = \{/);
  assert.match(interactionTimeline, /bg-gradient-to-b from-emerald-500 to-emerald-600/);
  assert.match(interactionTimeline, /phase-segment/);
  assert.match(interactionTimeline, /phase-legend/);
  assert.match(interactionTimeline, /% of call/);
  // Legend aggregates totals and shows overall duration
  assert.match(interactionTimeline, /legendByLabel/);
  assert.match(interactionTimeline, />Total<\/span>/);
});

test("recording player has a modern transport with speed control and waveform stage", () => {
  // Round primary play button + 10s seek buttons
  assert.match(recordingPlayer, /recording-play-button/);
  assert.match(recordingPlayer, /IconRewindBackward10/);
  assert.match(recordingPlayer, /IconRewindForward10/);
  assert.match(recordingPlayer, /seek\(-10\)/);
  assert.match(recordingPlayer, /seek\(10\)/);
  // Playback speed cycle
  assert.match(recordingPlayer, /PLAYBACK_RATES = \[0\.75, 1, 1\.25, 1\.5, 2\]/);
  assert.match(recordingPlayer, /setPlaybackRate/);
  // Live elapsed time + progress
  assert.match(recordingPlayer, /recording-current-time/);
  assert.match(recordingPlayer, /formatDuration\(currentTime\)/);
  // Waveform loading state and emerald progress color
  assert.match(recordingPlayer, /Loading waveform/);
  assert.match(recordingPlayer, /progressColor: "#10b981"/);
  // CORS-safe proxy loading is preserved
  assert.match(recordingPlayer, /\/api\/voice\/recordings\/\$\{encodeURIComponent\(recordingId\)\}\/stream/);
  assert.match(recordingPlayer, /\/api\/voice\/recordings\/proxy\?url=/);
  // Transcribe / show transcription actions preserved
  assert.match(recordingPlayer, /Transcribe Recording/);
  assert.match(recordingPlayer, /Show Transcription/);
});

test("recording empty state is a friendly card instead of bare text", () => {
  assert.match(detailPage, /IconMicrophoneOff/);
  assert.match(detailPage, /No recording available<\/div>/);
  assert.match(detailPage, /border-dashed/);
});
