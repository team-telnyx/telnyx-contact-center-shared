import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const handlerUrl = new URL("../lib/telnyx-stt-handler.mjs", import.meta.url);
const generatorWebhookUrl = new URL(
  "../app/api/call-generator/webhook/route.js",
  import.meta.url,
);

// B: Telnyx Standalone STT WebSocket transcripts must carry call_session_id so
// routeAgentAssistTranscription can fall back beyond call_control_id when the
// stream leg differs from the interaction-bound leg (e.g. call-generator calls).
test("STT WebSocket path threads call_session_id end-to-end", async () => {
  const source = await readFile(handlerUrl, "utf8");

  // start frame captures call_session_id
  assert.match(source, /const startCallSessionId =\s*\n?\s*startData\.call_session_id/);
  // stream session stores it
  assert.match(source, /this\.callSessionId =\s*\n?\s*callSessionId \|\|/);
  assert.match(source, /new TelnyxSttStreamSession\(callControlId, clientState, startCallSessionId\)/);
  // realtime session accepts and stores it
  assert.match(source, /callSessionId = null \}\) \{[\s\S]*this\.callSessionId = callSessionId/);
  // transcript payload includes it
  assert.match(source, /callSessionId: this\.callSessionId,/);
  // startTelnyxSttTranscription resolves it from the stream session
  assert.match(source, /const callSessionId =\s*\n?\s*options\.callSessionId \|\|\s*\n?\s*telnyxSession\?\.callSessionId/);
  assert.match(source, /baseOpts = \{ callControlId, interactionId, agentUsername, config, flowId, callSessionId \}/);
  // media-stream client_state embeds call_session_id
  assert.match(source, /call_session_id: callSessionId \|\| null,/);
});

// routeTranscriptionThroughAgentAssist already forwards callSessionId; assert it.
test("STT route passes call_session_id to the agent-assist router", async () => {
  const source = await readFile(handlerUrl, "utf8");
  assert.match(source, /call_session_id: payload\.callSessionId \|\| null,/);
});

// A: the call-generator webhook (used as a per-leg webhook_url override) must
// forward contact-center + transcription events so Agent Assist live
// transcription and interaction state are not silently lost.
test("call-generator webhook forwards CC and transcription events", async () => {
  const source = await readFile(generatorWebhookUrl, "utf8");

  assert.match(source, /eventType === "call\.transcription"/);
  assert.match(source, /handleTranscriptionEvent \} = await import\("@\/lib\/contact-center\/webhook-handler\.js"\)/);
  assert.match(source, /parseGeneratorClientState\(payload\?\.client_state\)/);
  assert.match(source, /findGeneratorStateByLedger\(pool, payload\)/);
  assert.match(source, /buildGeneratorClientState\(\{ runId: generatorState\.runId, ledgerId: generatorState\.ledgerId \}\)/);
  assert.match(source, /generatorState && eventType === "call\.transcription"/);
  assert.match(source, /handleContactCenterEvent \} = await import\("@\/lib\/contact-center\/webhook-handler\.js"\)/);
  assert.match(source, /generatorState &&[\s\S]*eventType === "call\.hangup"/);
  assert.match(source, /const webhookEventId = body\?\.data\?\.id \|\| body\?\.id \|\| null/);
  assert.match(source, /handleContactCenterEvent\(eventType, generatorPayload, \{ eventId: webhookEventId \}\)/);
  // still runs the generator ledger handler afterwards
  assert.match(source, /handleGeneratorWebhookEvent\(pool, eventType, generatorPayload\)/);
  // forwarding failures must not break ledger handling
  assert.match(source, /call_generator_webhook_cc_forward_failed/);
});
