import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const detailPage = readFileSync("app/(portal)/supervisor/call-history/[id]/page.jsx", "utf8");
const routingTimeline = readFileSync("components/contact-center/RoutingMetadataTimeline.jsx", "utf8");
const interactionTimeline = readFileSync("components/contact-center/InteractionTimeline.jsx", "utf8");
const recordingPlayer = readFileSync("components/contact-center/RecordingPlayer.jsx", "utf8");
const transferModal = readFileSync("components/contact-center/TransferModal.jsx", "utf8");

test("interaction details timeline tab uses the redesigned cards", () => {
  assert.match(detailPage, /Interaction Phases/);
  assert.match(detailPage, /Event Journey/);
  assert.match(detailPage, /Time across intake, queue, agent handling and wrap-up/);
  assert.match(detailPage, /Routing events from arrival to wrap-up/);
  assert.match(detailPage, /bg-card/);
  // Old plain titles are gone
  assert.doesNotMatch(detailPage, /Interaction Timeline<\/CardTitle>/);
  assert.doesNotMatch(detailPage, /Detailed Event Timeline/);
});

test("routing timeline renders event cards with segmented connectors and detail chips", () => {
  // Connectors run only between node borders, never underneath the avatars.
  assert.match(routingTimeline, /data-testid="routing-timeline-connector"/);
  assert.match(routingTimeline, /index < sorted\.length - 1/);
  assert.match(routingTimeline, /top-12 -bottom-\[18px\]/);
  assert.doesNotMatch(routingTimeline, /top-3 bottom-3 w-px/);
  assert.match(routingTimeline, /formatAgentIdentity/);
  assert.match(routingTimeline, /`\$\{displayName\} \(\$\{login\}\)`/);
  // Tinted nodes + accent strip per event card
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
  assert.match(routingTimeline, /Agent not answering/);
  assert.match(routingTimeline, /reason: \$\{event\.reason\}/);

  // "disconnected" contains the substring "connected", so terminal checks
  // must be evaluated first or the UI renders a second Call connected card.
  const titleFunction = routingTimeline.slice(
    routingTimeline.indexOf("function getEventTitle"),
    routingTimeline.indexOf("function getEventDetail"),
  );
  assert.ok(
    titleFunction.indexOf('type.includes("disconnected")') <
      titleFunction.indexOf('type.includes("connected")'),
  );
  const detailFunction = routingTimeline.slice(
    routingTimeline.indexOf("function getEventDetail"),
    routingTimeline.indexOf("function titleCase"),
  );
  assert.match(
    detailFunction,
    /if \(type\.includes\("disconnected"\)\) return "";/,
  );
});

test("interaction phase bar has icons, share tooltips, and a totals legend", () => {
  assert.match(interactionTimeline, /const SEGMENT_STYLES = \{/);
  assert.match(interactionTimeline, /bg-gradient-to-b from-emerald-500 to-emerald-600/);
  assert.match(interactionTimeline, /phase-segment/);
  assert.match(interactionTimeline, /phase-legend/);
  assert.match(interactionTimeline, /% of interaction/);
  // Legend aggregates totals and shows overall duration
  assert.match(interactionTimeline, /legendByLabel/);
  assert.match(interactionTimeline, />Total<\/span>/);
  assert.ok(
    interactionTimeline.indexOf('key.includes("disconnect")') <
      interactionTimeline.indexOf('key.includes("connected")'),
  );
  assert.match(interactionTimeline, /label: "Consult"/);
  assert.match(interactionTimeline, /key === "consult_customer_active"/);
  assert.match(interactionTimeline, /key === "consult_customer_restored"/);
  assert.match(interactionTimeline, /data-testid="phase-timeline-scroll"/);
  assert.match(interactionTimeline, /overflow-x-auto/);
  assert.match(interactionTimeline, /const MIN_SEGMENT_WIDTH_PX = 104/);
  assert.match(interactionTimeline, /flexBasis: `\$\{segment\._widthPx\}px`/);
  assert.match(interactionTimeline, /flexGrow: Math\.max\(1, segment\._durationSeconds/);
  assert.match(interactionTimeline, /flexShrink: 0/);
  assert.match(interactionTimeline, /style=\{segmentLayoutStyle\(segment\)\}/);
  assert.doesNotMatch(interactionTimeline, /style=\{\{ width: `\$\{segment\._width\}%` \}\}/);
  assert.match(interactionTimeline, /<TooltipContent/);
  assert.match(interactionTimeline, /coalesceAdjacentCallPhases/);
  assert.match(interactionTimeline, /phase === "Consult" \|\| phase === "Interact"/);
});

test("consult switches and recovery have explicit Event Journey labels", () => {
  assert.match(routingTimeline, /Consultation started/);
  assert.match(routingTimeline, /Consultant ringing/);
  assert.match(routingTimeline, /Consultant connected/);
  assert.match(routingTimeline, /Switched back to customer/);
  assert.match(routingTimeline, /Switched to consultant/);
  assert.match(routingTimeline, /Customer conversation restored/);
  assert.match(routingTimeline, /Consultation failed/);
  assert.match(routingTimeline, /Consultation completed/);
  assert.match(routingTimeline, /Consult target disconnected/);
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
  // Waveform loading state + emerald gradient render (B: dense bars default, C: continuous wave)
  assert.match(recordingPlayer, /Loading waveform/);
  assert.match(recordingPlayer, /buildWaveGradient/);
  assert.match(recordingPlayer, /buildProgressGradient/);
  assert.match(recordingPlayer, /createLinearGradient/);
  // B = dense bars default, C = continuous wave; user-toggleable
  assert.match(recordingPlayer, /barWidth: 2, barGap: 1, barRadius: 3/);
  assert.match(recordingPlayer, /WAVE_STYLE_OPTIONS/);
  assert.match(recordingPlayer, /recording-wave-style-toggle/);
  assert.match(recordingPlayer, /useState\("bars"\)/);
  // Toggling style repaints in place via setOptions (no destroy/re-decode → no blink);
  // waveStyle must NOT be in the create-effect deps
  assert.match(recordingPlayer, /setOptions\(barOptionsFor\(waveStyle\)\)/);
  assert.match(recordingPlayer, /\}, \[src, recordingId\]\);/);
  // Dead WaveSurfer v7 backend option removed
  assert.doesNotMatch(recordingPlayer, /backend: "WebAudio"/);
  // CORS-safe proxy loading is preserved
  assert.match(recordingPlayer, /\/api\/voice\/recordings\/\$\{encodeURIComponent\(recordingId\)\}\/stream/);
  assert.match(recordingPlayer, /\/api\/voice\/recordings\/proxy\?url=/);
  // Transcription actions moved to the TranscriptionStudioCard below the player
  assert.doesNotMatch(recordingPlayer, /Transcribe Recording/);
  assert.doesNotMatch(recordingPlayer, /Show Transcription/);
});

test("recording empty state is a friendly card instead of bare text", () => {
  assert.match(detailPage, /IconMicrophoneOff/);
  assert.match(detailPage, /No recording available<\/div>/);
  assert.match(detailPage, /border-dashed/);
});

test("consult transfer renders a three-party topology with explicit active leg", () => {
  assert.match(transferModal, /function ConsultTopology/);
  assert.match(transferModal, /The solid line shows which party is currently connected to the agent/);
  assert.match(transferModal, /<UserCircle className="h-5 w-5"/);
  assert.match(transferModal, /partyCard\("parked", customer, customerActive/);
  assert.match(transferModal, /partyCard\("consultant", consultant, consultantActive/);
  assert.match(transferModal, /targetLabel: targetLabel \|\| target\.trim\(\)/);
  assert.match(transferModal, /consultStartPendingRef/);
  assert.match(transferModal, /currentConsultSagaIdRef/);
});

test("consult transfer can always be cancelled and closed safely", () => {
  assert.match(transferModal, /const \[closeRequested, setCloseRequested\] = useState\(false\)/);
  assert.match(transferModal, /Cancel consult and close/);
  assert.match(transferModal, /closeCancelInFlightRef/);
  assert.match(transferModal, /Promise\.resolve\(cancelConsult\(\)\)/);
  assert.doesNotMatch(transferModal, /Cannot close modal while consult call is in progress/);
  assert.doesNotMatch(
    transferModal,
    /loading \|\| consultState\.isActive \|\| consultState\.initiating/,
  );
});
