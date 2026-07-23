import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { __telnyxSttTestUtils } from "../lib/telnyx-stt-handler.mjs";

const { selectedTrackLabels } = __telnyxSttTestUtils;

test("Telnyx STT track selection supports inbound, outbound, and both", () => {
  assert.deepEqual(selectedTrackLabels("inbound"), ["inbound"]);
  assert.deepEqual(selectedTrackLabels("outbound"), ["outbound"]);
  assert.deepEqual(selectedTrackLabels("both"), ["inbound", "outbound"]);
  assert.deepEqual(selectedTrackLabels(undefined), ["inbound", "outbound"]);
});

test("webhook starts inbound on caller leg and outbound on agent leg", async () => {
  const source = await readFile(
    new URL("../lib/contact-center/webhook-handler.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /selectedTracks === "inbound" \|\| selectedTracks === "both"/);
  assert.match(source, /selectedTracks === "outbound" \|\| selectedTracks === "both"/);
  assert.match(source, /streamCarriesBothTracks = sttConfig\.stream_track === "both_tracks"/);
  assert.match(source, /wantsInbound && wantsOutbound && streamCarriesBothTracks && streamCcId && streamCcId === agentCcId/);
  assert.match(source, /not treating it as both_tracks/);
  assert.match(source, /trackMappings:[\s\S]*mediaTrack: "inbound", outputTrack: "inbound"[\s\S]*mediaTrack: "outbound", outputTrack: "outbound"/);
  assert.match(source, /startTelnyxSttTranscription\([\s\S]*streamCcId[\s\S]*mediaTrack: "inbound", outputTrack: "inbound"/);
  assert.match(source, /startTelnyxSttMediaStream\(agentCcId, outboundConfig, interactionId, agentUsername, "outbound"\)/);
  assert.match(source, /startTelnyxSttTranscription\([\s\S]*agentCcId[\s\S]*mediaTrack: "inbound", outputTrack: "outbound"/);
});

test("agent-leg Telnyx STT is prewarmed during WebRTC transfer ringing", async () => {
  const bridgeSource = await readFile(
    new URL("../lib/contact-center/webrtc-bridge.js", import.meta.url),
    "utf8",
  );
  const handlerSource = await readFile(
    new URL("../lib/telnyx-stt-handler.mjs", import.meta.url),
    "utf8",
  );

  assert.match(bridgeSource, /prewarmTelnyxSttAgentLeg/);
  assert.match(bridgeSource, /__telnyxSttStreamSessions\?\.get\(queuedCallControlId\)/);
  assert.match(bridgeSource, /agentCallControlId,[\s\S]*sttConfig,[\s\S]*interaction\.id,[\s\S]*agentUsername/);
  assert.match(handlerSource, /export async function prewarmTelnyxSttAgentLeg/);
  assert.match(handlerSource, /startTelnyxSttTranscription\([\s\S]*mediaTrack: "inbound", outputTrack: "outbound"/);
  assert.match(handlerSource, /startTelnyxSttMediaStream\(callControlId, outboundConfig, interactionId, agentUsername, "outbound"\)/);
  assert.match(handlerSource, /command_id: commandId/);
});

test("Telnyx STT prewarmed agent-leg sessions are cleaned up on hangup", async () => {
  const source = await readFile(
    new URL("../lib/contact-center/webhook-handler.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /stopTelnyxSttTranscription/);
  assert.match(source, /agent_call_control_id/);
  assert.match(source, /original_call_control_id/);
});

test("voice-flow engine stores Telnyx STT selected tracks outside the Telnyx API body", async () => {
  const source = await readFile(
    new URL("../lib/voice-flow-engine.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /body\.telnyx_stt_tracks \|\|[\s\S]*fullProviderConfig\.telnyxStt\?\.transcription_tracks \|\|[\s\S]*"both"/);
  assert.match(source, /stream_track:\s*body\.stream_track \|\| providerConfig\?\.stream_track \|\| null/);
  assert.match(source, /delete body\.telnyx_stt_tracks/);
});

test("Telnyx STT drops pre-answer media buffers by default", async () => {
  const source = await readFile(
    new URL("../lib/telnyx-stt-handler.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /dropping_pre_answer_buffered_audio/);
  assert.match(source, /options\.replayBufferedAudio === true/);
  assert.match(source, /telnyxSession\.clearBuffer\(mapping\.mediaTrack\)/);
  assert.doesNotMatch(source, /Flushing buffers/);
});

test("provider STT socket reconnects automatically after a dead-socket close (zero messages, not intentional)", async () => {
  // Observed twice in live testing: two near-simultaneous session starts (e.g.
  // inbound + outbound legs answering within milliseconds of each other), one
  // side's provider socket accepts audio but never delivers a single message,
  // then the provider force-closes it cleanly (~6s later) with no reason. Left
  // unhandled, that track stays silent for the rest of the call.
  const source = await readFile(
    new URL("../lib/telnyx-stt-handler.mjs", import.meta.url),
    "utf8",
  );

  // Told apart from an intentional close (our own close() sets this.closed
  // synchronously before the socket actually closes) from a surprise provider
  // close, and only reconnects when the socket never delivered anything.
  assert.match(source, /const wasIntentional = this\.closed;/);
  assert.match(source, /const deadSocket = !wasIntentional && this\.providerMessages === 0;/);
  assert.match(source, /const willReconnect = deadSocket && this\.reconnectAttempts < STT_DEAD_SOCKET_MAX_RECONNECTS;/);
  // Bounded retries — a persistent problem surfaces as an error, not an
  // infinite silent retry loop.
  assert.match(source, /const STT_DEAD_SOCKET_MAX_RECONNECTS = \d+;/);
  assert.match(source, /provider_socket_dead_reconnect_exhausted/);
  // Reconnect path: undo the intentional-close bookkeeping and call connect()
  // again for a fresh socket.
  assert.match(source, /provider_socket_dead_reconnecting/);
  assert.match(source, /this\.reconnectAttempts\+\+;/);
  assert.match(source, /this\.closed = false;\s*\n\s*this\.ws = null;/);
  // this.connect() (as opposed to the external session.connect()) only
  // appears in the reconnect branch — confirms it calls back into itself to
  // open a fresh socket rather than just resetting state and stopping.
  assert.match(source, /\n\s*this\.connect\(\);\s*\n/);
});
