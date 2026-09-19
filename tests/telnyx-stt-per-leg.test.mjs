import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  __telnyxSttTestUtils,
  startTelnyxSttMediaStream,
} from "../lib/telnyx-stt-handler.mjs";
import {
  normalizeTelnyxSttTracks,
  telnyxSttMediaStreamTrack,
} from "../lib/contact-center/telnyx-stt-tracks.mjs";

const {
  selectedTrackLabels,
  explicitStreamTrackMappings,
  ensureExplicitStreamSttSession,
  normalizeTelnyxSttStreamCodec,
  stopRecoveredStreamSttSession,
  telnyxSttConfigForMediaCodec,
  telnyxSttConfigForMediaFormat,
} = __telnyxSttTestUtils;

test("Telnyx STT track selection supports inbound, outbound, and both", () => {
  assert.deepEqual(selectedTrackLabels("inbound"), ["inbound"]);
  assert.deepEqual(selectedTrackLabels("outbound"), ["outbound"]);
  assert.deepEqual(selectedTrackLabels("both"), ["inbound", "outbound"]);
  assert.deepEqual(selectedTrackLabels(undefined), ["inbound", "outbound"]);
});

test("Telnyx STT keeps the call-flow media stream on the customer inbound track", () => {
  assert.equal(normalizeTelnyxSttTracks("invalid"), "both");
  assert.equal(telnyxSttMediaStreamTrack("inbound"), "inbound_track");
  assert.equal(telnyxSttMediaStreamTrack("outbound"), "inbound_track");
  assert.equal(telnyxSttMediaStreamTrack("both"), "inbound_track");
});

test("agent media codec selects the matching standalone STT input format", () => {
  assert.equal(normalizeTelnyxSttStreamCodec("PCMA"), "PCMA");
  assert.equal(normalizeTelnyxSttStreamCodec("G711A"), "PCMA");
  assert.equal(normalizeTelnyxSttStreamCodec("audio/x-alaw"), "PCMA");
  assert.equal(normalizeTelnyxSttStreamCodec("PCMU"), "PCMU");
  assert.equal(normalizeTelnyxSttStreamCodec("audio/x-mulaw"), "PCMU");

  assert.deepEqual(
    telnyxSttConfigForMediaCodec({ enabled: true, input_format: "mulaw" }, "PCMA", 8000),
    {
      enabled: true,
      stream_codec: "PCMA",
      input_format: "alaw",
      sample_rate: 8000,
    },
  );
  assert.deepEqual(
    telnyxSttConfigForMediaFormat(
      { enabled: true, stream_codec: "PCMA", input_format: "alaw", sample_rate: 8000 },
      { encoding: "audio/x-mulaw", sample_rate: 16000 },
    ),
    {
      enabled: true,
      stream_codec: "PCMU",
      input_format: "mulaw",
      sample_rate: 16000,
    },
  );
});

test("explicit agent media streams map the WebRTC microphone to the agent transcript", () => {
  assert.deepEqual(explicitStreamTrackMappings("outbound", "inbound"), [
    { mediaTrack: "inbound", outputTrack: "outbound" },
  ]);
  assert.deepEqual(explicitStreamTrackMappings("outbound"), [
    { mediaTrack: "inbound", outputTrack: "outbound" },
  ]);
  assert.deepEqual(explicitStreamTrackMappings("both"), [
    { mediaTrack: "inbound", outputTrack: "outbound" },
    { mediaTrack: "outbound", outputTrack: "inbound" },
  ]);
  assert.deepEqual(explicitStreamTrackMappings(undefined), []);
});

test("agent media WebSocket restores its local standalone STT session from client state", () => {
  const callControlId = "agent-transport-recovery-test";
  globalThis.__telnyxSttActiveSessions.delete(callControlId);
  const starts = [];

  const restored = ensureExplicitStreamSttSession(
    {
      callControlId,
      interactionId: "work-item",
      callSessionId: "call-session",
      clientState: {
        telnyx_stt_config: {
          enabled: true,
          transcription_engine: "Deepgram",
          model: "deepgram/flux",
        },
        telnyx_stt_track: "outbound",
        telnyx_stt_media_track: "inbound",
        telnyx_stt_stream_track: "both_tracks",
        agent_username: "agent@example.com",
      },
    },
    (...args) => {
      starts.push(args);
      return Promise.resolve();
    },
  );

  assert.equal(restored, true);
  assert.equal(starts.length, 1);
  assert.equal(starts[0][0], callControlId);
  assert.equal(starts[0][2], "work-item");
  assert.equal(starts[0][3], "agent@example.com");
  assert.deepEqual(starts[0][4], {
    trackMappings: [{ mediaTrack: "inbound", outputTrack: "outbound" }],
    callSessionId: "call-session",
  });
});

test("agent media command requests both Telnyx tracks but binds only the agent track", async () => {
  const callControlId = "agent-transport-both-tracks-test";
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const originalWsBaseUrl = process.env.WS_BASE_URL;
  let request = null;

  process.env.TELNYX_API_KEY = "test-api-key";
  process.env.WS_BASE_URL = "wss://contact-center.example.test";
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ data: { result: "ok" } }), { status: 200 });
  };

  try {
    await startTelnyxSttMediaStream(
      callControlId,
      { enabled: true, transcription_tracks: "outbound", language: "en" },
      "work-item",
      "agent@example.com",
      {
        streamTrack: "both_tracks",
        mediaTrack: "inbound",
        outputTrack: "outbound",
        callSessionId: "call-session",
      },
    );

    assert.equal(request.body.stream_track, "both_tracks");
    assert.equal(request.body.stream_codec, "PCMU");
    const clientState = JSON.parse(
      Buffer.from(request.body.client_state, "base64").toString("utf8"),
    );
    assert.equal(clientState.telnyx_stt_stream_track, "both_tracks");
    assert.equal(clientState.telnyx_stt_media_track, "inbound");
    assert.equal(clientState.telnyx_stt_track, "outbound");
    assert.equal(clientState.call_session_id, "call-session");
    assert.deepEqual(explicitStreamTrackMappings(
      clientState.telnyx_stt_track,
      clientState.telnyx_stt_media_track,
    ), [{ mediaTrack: "inbound", outputTrack: "outbound" }]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__telnyxSttMediaStreamCommandIds.delete(callControlId);
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
    if (originalWsBaseUrl === undefined) delete process.env.WS_BASE_URL;
    else process.env.WS_BASE_URL = originalWsBaseUrl;
  }
});

test("agent media command preserves a negotiated PCMA leg as A-law end to end", async () => {
  const callControlId = "agent-transport-pcma-test";
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const originalWsBaseUrl = process.env.WS_BASE_URL;
  let request = null;

  process.env.TELNYX_API_KEY = "test-api-key";
  process.env.WS_BASE_URL = "wss://contact-center.example.test";
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ data: { result: "ok" } }), { status: 200 });
  };

  try {
    await startTelnyxSttMediaStream(
      callControlId,
      {
        enabled: true,
        transcription_tracks: "outbound",
        language: "pl",
        input_format: "mulaw",
        sample_rate: 8000,
      },
      "work-item",
      "agent@example.com",
      {
        streamTrack: "both_tracks",
        mediaTrack: "inbound",
        outputTrack: "outbound",
        streamCodec: "PCMA",
        sampleRate: 8000,
      },
    );

    assert.equal(request.body.stream_track, "both_tracks");
    assert.equal(request.body.stream_codec, "PCMA");
    const clientState = JSON.parse(
      Buffer.from(request.body.client_state, "base64").toString("utf8"),
    );
    assert.equal(clientState.telnyx_stt_stream_codec, "PCMA");
    assert.equal(clientState.telnyx_stt_config.stream_codec, "PCMA");
    assert.equal(clientState.telnyx_stt_config.input_format, "alaw");
    assert.equal(clientState.telnyx_stt_config.sample_rate, 8000);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__telnyxSttMediaStreamCommandIds.delete(callControlId);
    if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalApiKey;
    if (originalWsBaseUrl === undefined) delete process.env.WS_BASE_URL;
    else process.env.WS_BASE_URL = originalWsBaseUrl;
  }
});

test("agent media WebSocket does not duplicate an existing local STT session", () => {
  const callControlId = "agent-transport-existing-test";
  globalThis.__telnyxSttActiveSessions.set(callControlId, { sessions: [] });
  let starts = 0;
  try {
    const restored = ensureExplicitStreamSttSession(
      {
        callControlId,
        clientState: {
          telnyx_stt_config: { enabled: true },
          telnyx_stt_track: "outbound",
        },
      },
      () => {
        starts += 1;
        return Promise.resolve();
      },
    );
    assert.equal(restored, false);
    assert.equal(starts, 0);
  } finally {
    globalThis.__telnyxSttActiveSessions.delete(callControlId);
  }
});

test("streaming worker closes the standalone STT session it recovered", () => {
  const callControlId = "agent-transport-cleanup-test";
  const streamSession = {
    callControlId,
    interactionId: "work-item",
    ownsRecoveredSttSession: true,
  };
  globalThis.__telnyxSttStreamSessions.set(callControlId, streamSession);
  const stops = [];
  try {
    assert.equal(
      stopRecoveredStreamSttSession(streamSession, (id) => {
        stops.push(id);
        return Promise.resolve();
      }),
      true,
    );
    assert.deepEqual(stops, [callControlId]);
    assert.equal(streamSession.ownsRecoveredSttSession, false);
    assert.equal(stopRecoveredStreamSttSession(streamSession), false);
  } finally {
    globalThis.__telnyxSttStreamSessions.delete(callControlId);
  }
});

test("webhook binds customer STT to the customer leg and agent STT to the transport leg", async () => {
  const source = await readFile(
    new URL("../lib/acd/media-events.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /startTelnyxSttTranscription\([\s\S]*streamCallControlId[\s\S]*mediaTrack: "inbound"[\s\S]*outputTrack: "inbound"/);
  assert.match(source, /const agentTransportCallControlId = payload\?\.call_control_id/);
  assert.match(source, /startTelnyxSttMediaStream\([\s\S]*agentTransportCallControlId[\s\S]*streamTrack: "both_tracks"[\s\S]*mediaTrack: "inbound"[\s\S]*outputTrack: "outbound"/);
  assert.match(source, /streamCodec: payload\?\.codec/);
  assert.match(source, /sampleRate: payload\?\.sampling_rate/);
  assert.doesNotMatch(source, /resolveAcdAgentMediaCallControlId/);
});

test("agent-leg Telnyx STT media fork prewarms but provider binding starts from the media WebSocket", async () => {
  const bridgeSource = await readFile(
    new URL("../lib/acd/media-events.mjs", import.meta.url),
    "utf8",
  );
  const handlerSource = await readFile(
    new URL("../lib/telnyx-stt-handler.mjs", import.meta.url),
    "utf8",
  );

  assert.match(bridgeSource, /eventType === "call\.answered"/);
  assert.match(bridgeSource, /isAcdAgentMediaEvent\(interaction, payload\)/);
  assert.match(bridgeSource, /startAgentAssist\(pool, interaction, payload\)/);
  assert.match(handlerSource, /export async function prewarmTelnyxSttAgentLeg/);
  assert.match(handlerSource, /startTelnyxSttMediaStream\([\s\S]*streamTrack: "both_tracks"[\s\S]*mediaTrack: "inbound"[\s\S]*outputTrack: "outbound"/);
  assert.match(handlerSource, /stream_track: streamTrack/);
  assert.match(handlerSource, /telnyx_stt_media_track: mediaTrack/);
  assert.match(handlerSource, /telnyx_stt_stream_track: streamTrack/);
  assert.match(handlerSource, /command_id: commandId/);
  assert.match(handlerSource, /ensureExplicitStreamSttSession\(session\)/);
  const prewarmBlock = handlerSource.slice(
    handlerSource.indexOf("export async function prewarmTelnyxSttAgentLeg"),
    handlerSource.indexOf("export function stopTelnyxSttSessions"),
  );
  assert.doesNotMatch(prewarmBlock, /startTelnyxSttTranscription\(/);
});

test("Telnyx STT prewarmed agent-leg sessions are cleaned up on hangup", async () => {
  const source = await readFile(
    new URL("../lib/acd/media-events.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /stopTelnyxSttTranscription/);
  assert.match(source, /FROM acd_legs/);
  assert.match(source, /provider_call_id/);
});

test("voice-flow engine stores Telnyx STT selected tracks outside the Telnyx API body", async () => {
  const source = await readFile(
    new URL("../lib/voice-flow-engine.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /normalizeTelnyxSttTracks\([\s\S]*body\.telnyx_stt_tracks \|\|[\s\S]*fullProviderConfig\.telnyxStt\?\.transcription_tracks/);
  assert.match(source, /body\.stream_track = telnyxSttMediaStreamTrack\(transcriptionTracks\)/);
  assert.match(source, /stream_track:\s*body\.stream_track/);
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
  // close. deadOnArrival is diagnostic only now (zero messages ever
  // received) — reconnect itself fires on ANY unintentional close, see the
  // next test.
  assert.match(source, /const wasIntentional = this\.closed;/);
  assert.match(source, /const deadOnArrival = this\.providerMessages === 0;/);
  assert.match(source, /const shouldReconnect = !wasIntentional;/);
  assert.match(source, /const willReconnect = shouldReconnect && this\.reconnectAttempts < STT_SOCKET_MAX_RECONNECTS;/);
  // Bounded retries — a persistent problem surfaces as an error, not an
  // infinite silent retry loop.
  assert.match(source, /const STT_SOCKET_MAX_RECONNECTS = \d+;/);
  assert.match(source, /provider_socket_reconnect_exhausted/);
  // Reconnect path: undo the intentional-close bookkeeping and call connect()
  // again for a fresh socket.
  assert.match(source, /provider_socket_reconnecting/);
  assert.match(source, /this\.reconnectAttempts\+\+;/);
  assert.match(source, /this\.closed = false;\s*\n\s*this\.ws = null;/);
  // this.connect() (as opposed to the external session.connect()) only
  // appears in the reconnect branch — confirms it calls back into itself to
  // open a fresh socket rather than just resetting state and stopping.
  assert.match(source, /\n\s*this\.connect\(\);\s*\n/);
});

test("provider STT diagnostics flag an open socket that receives audio but returns no frames", async () => {
  const source = await readFile(
    new URL("../lib/telnyx-stt-handler.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /const STT_PROVIDER_FIRST_RESPONSE_WARN_MS = \d+;/);
  assert.match(source, /this\.firstAudioSentAtMs = null;/);
  assert.match(source, /this\.providerMessages === 0[\s\S]*STT_PROVIDER_FIRST_RESPONSE_WARN_MS/);
  assert.match(source, /provider_socket_no_response_after_audio/);
  assert.match(source, /media_ws_stt_binding/);
  assert.match(source, /providerSessionRecovered/);
  assert.match(source, /mediaChunksByTrack/);
  assert.match(source, /mediaBytesByTrack/);
});

test("provider STT socket ALSO reconnects after a mid-call abnormal closure (code 1006), not just dead-on-arrival", async () => {
  // Reported live: the inbound (customer) track's provider socket had
  // already delivered 1,486 messages successfully, then closed with code
  // 1006 (abnormal closure) mid-call. The old logic only reconnected a
  // socket that delivered ZERO messages ever (deadSocket) — this one had
  // clearly been working, so deadSocket was false and nothing reconnected,
  // permanently silencing that caller's transcription for the rest of the
  // call. shouldReconnect must depend ONLY on wasIntentional, not on
  // whether any messages were ever received.
  const source = await readFile(
    new URL("../lib/telnyx-stt-handler.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /if \(!deadSocket\) return;/);
  assert.match(source, /if \(!shouldReconnect\) return;/);
  // deadOnArrival still logged (useful diagnostic distinction between the
  // two failure modes) but no longer gates whether reconnect happens.
  assert.match(source, /deadOnArrival,\s*\n\s*shouldReconnect,\s*\n\s*willReconnect,/);
});
