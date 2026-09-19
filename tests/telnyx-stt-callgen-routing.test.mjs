import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const handlerUrl = new URL("../lib/telnyx-stt-handler.mjs", import.meta.url);

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

// Generator calls and CC legs have different ownership. A verified CC event
// delivered to the generator endpoint must use normal durable core admission.
test("call-generator webhook routes verified CC events through durable admission", async () => {
  const { receiveGeneratorWebhook } = await import('../lib/call-generator/webhook.mjs');
  for(const eventType of ['call.transcription','call.hangup']) {
    let admitted;
    const result=await receiveGeneratorWebhook(new Request('http://localhost/api/call-generator/webhook',{method:'POST',body:JSON.stringify({data:{id:'evt-'+eventType,event_type:eventType,payload:{call_control_id:'core-device',transcription_data:{transcription_track:'inbound'}}}})}),{}, {
      verify:async()=>true,owns:async()=>false,admit:async(_pool,event)=>{admitted=event;return {handled:true};},
      persist:async()=>{throw new Error('A core event cannot be relabeled as generator-owned');},
    });
    assert.equal(result.status,200);assert.equal(result.body.owner,'acd_core');
    assert.equal(admitted.payload.transcription_data.transcription_track,'inbound');
  }
});
