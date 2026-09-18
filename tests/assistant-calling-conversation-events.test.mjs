import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const callingTab = readFileSync(
  new URL("../components/assistants/CallingTab.jsx", import.meta.url),
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
    /values\?\.telephony\?\.send_conversation_message_events === true/
  );
  assert.match(callingTab, /send_conversation_message_events: checked/);
});

test("assistant editor initializes, normalizes, and persists conversation events", () => {
  assert.match(assistantEditor, /send_conversation_message_events: false/);
  assert.match(
    assistantEditor,
    /telephony\?\.send_conversation_message_events === true/
  );
  assert.match(assistantEditor, /telephony_settings: telephony/);
});
