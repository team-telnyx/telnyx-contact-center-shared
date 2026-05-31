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

test("voice-flow engine stores Telnyx STT selected tracks outside the Telnyx API body", async () => {
  const source = await readFile(
    new URL("../lib/voice-flow-engine.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /body\.telnyx_stt_tracks \|\|[\s\S]*fullProviderConfig\.telnyxStt\?\.transcription_tracks \|\|[\s\S]*"both"/);
  assert.match(source, /stream_track:\s*body\.stream_track \|\| providerConfig\?\.stream_track \|\| null/);
  assert.match(source, /delete body\.telnyx_stt_tracks/);
});
