import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const callingTab = readFileSync(
  new URL("../components/assistants/AssistantCallingSettings.jsx", import.meta.url),
  "utf8"
);
const assistantEditor = readFileSync(
  new URL("../components/assistants/AssistantEditor.jsx", import.meta.url),
  "utf8"
);

test("Calling tab exposes the conversation message events toggle", () => {
  assert.match(callingTab, /Send conversation message events/);
  assert.match(
    callingTab,
    /telephony\.send_conversation_message_events\s*===\s*true/
  );
  assert.match(callingTab, /send_conversation_message_events:\s*checked/);
});

test("assistant editor preserves the existing conversation-event extension without materializing defaults", async () => {
  const {assistantForEditor,payloadForSave}=await import('../lib/ai/assistant-draft.mjs');
  const draft=assistantForEditor({name:'test',telephony_settings:{send_conversation_message_events:true}});
  draft.name='renamed';
  assert.deepEqual(payloadForSave(draft,{patch:true}),{name:'renamed'});
  draft.telephony.send_conversation_message_events=false;
  assert.equal(payloadForSave(draft,{patch:true}).telephony_settings.send_conversation_message_events,false);
  assert.equal(payloadForSave(assistantForEditor({name:'new'})).telephony_settings,undefined);
});
