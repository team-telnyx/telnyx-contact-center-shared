import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  addTelnyxStandaloneSttEvent,
  getFlowEvents,
} from "../lib/call-monitor-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");

test("Telnyx Standalone STT WebSocket transcripts are stored as distinct monitor events", () => {
  const flowId = `flow-stt-${Date.now()}`;
  const event = addTelnyxStandaloneSttEvent({
    callControlId: "call-control-123",
    flowId,
    interactionId: "interaction-123",
    transcript: "hello from websocket stt",
    track: "outbound",
    isFinal: true,
    confidence: 0.91,
    detectedLanguage: "en-US",
    provider: "Deepgram",
    model: "nova-3",
    rawType: "Results",
  });

  assert.equal(event.event_type, "telnyx_standalone_stt.transcription");
  assert.equal(event.direction, "received");
  assert.equal(event.source, "telnyx_standalone_stt_websocket");
  assert.equal(event.call_control_id, "call-control-123");
  assert.equal(event.flow_id, flowId);
  assert.equal(event.payload.label, "Telnyx Standalone STT Event");
  assert.equal(event.payload.source, "telnyx_standalone_stt_websocket");
  assert.equal(event.payload.transcription.transcript, "hello from websocket stt");
  assert.equal(event.payload.transcription.track, "outbound");
  assert.equal(event.payload.transcription.is_final, true);
  assert.equal(event.payload.transcription.provider, "Deepgram");
  assert.equal(event.payload.transcription.model, "nova-3");

  const flowEvents = getFlowEvents(flowId);
  assert.equal(flowEvents.length, 1);
  assert.equal(flowEvents[0].id, event.id);
});

test("Telnyx STT handler records websocket transcripts in the Call Flow Monitor", () => {
  const handlerSource = readFileSync(join(repoRoot, "lib/telnyx-stt-handler.mjs"), "utf8");

  assert.match(handlerSource, /addTelnyxStandaloneSttEvent/);
  assert.match(handlerSource, /telnyx_standalone_stt_websocket/);
});

test("Monitor sheet renders Telnyx Standalone STT websocket events separately from webhooks", () => {
  const pageSource = readFileSync(
    join(repoRoot, "app/(portal)/admin/call-flows/[id]/page.jsx"),
    "utf8",
  );

  assert.match(pageSource, /Telnyx Standalone STT Event/);
  assert.match(pageSource, /WebSocket/);
  assert.match(pageSource, /telnyx_standalone_stt_websocket/);
  assert.match(pageSource, /call\.transcription/);
});
