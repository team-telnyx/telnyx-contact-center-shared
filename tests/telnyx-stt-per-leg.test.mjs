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

  assert.match(source, /Dropping pre-answer buffered audio/);
  assert.match(source, /options\.replayBufferedAudio === true/);
  assert.match(source, /telnyxSession\.clearBuffer\(mapping\.mediaTrack\)/);
  assert.doesNotMatch(source, /Flushing buffers/);
});
