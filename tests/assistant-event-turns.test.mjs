import test from "node:test";
import assert from "node:assert/strict";
import { reduceAssistantEvents, reconcileAssistantHistory } from "../lib/acd/assistant-event-turns.mjs";
import { authorizeAssistantEvents, configureAssistantEvents, assistantEventConfig } from "../lib/ai/assistant-event-config.mjs";
import { mergeAgentAssistTranscriptions } from "../lib/agent-assist/history-merge.mjs";
const invite = { id: "invitation", provider_call_id: "ai-leg" };
const at = "2026-10-19T10:00:00.000Z";
const delta = (id, text, more = {}) => ({ type: "response.text.delta", item_id: id, delta: text, receivedAt: at, ...more });
const history = (text, time = at) => ({ role: "assistant", text, sent_at: time, created_at: time });
test("deltas survive empty incomplete items; human and tool messages are ignored", () => {
  const state = {};
  reduceAssistantEvents(invite, state, [delta("one", "Hello "), { type: "conversation.item.created", item: { id: "one", role: "assistant", type: "message", status: "incomplete", content: [] } }, delta("one", "there."), { type: "conversation.item.created", item: { id: "human", role: "user", type: "message", content: "Mixed humans must not enter STT" } }]);
  assert.equal(Object.values(state.turns).length, 1);
  assert.equal(Object.values(state.turns)[0].transcript, "Hello there.");
  assert.equal(Object.values(state.turns)[0].isFinal, false);
  const updates = reconcileAssistantHistory(invite, state, [history("Hello there.")]);
  assert.equal(updates.length, 1); assert.equal(updates[0].isFinal, true);
  assert.equal(Object.values(state.turns).length, 1);
  assert.deepEqual(reconcileAssistantHistory(invite, state, [history("Hello there.")]), []);
});
test("interrupted responses shrink in place and repeated equal replies stay separate", () => {
  const state = {};
  reduceAssistantEvents(invite, state, [delta("one", "One. Two. Three. Four."), delta("two", "One. Two.", { receivedAt: "2026-10-19T10:00:08Z" })]);
  const turns = reconcileAssistantHistory(invite, state, [history("One. Two.", "2026-10-19T10:00:07Z"), history("One. Two.")]);
  assert.equal(turns.length, 2); assert.notEqual(turns[0].id, turns[1].id);
  assert.ok(turns[0].id.endsWith(":one")); assert.ok(turns[1].id.endsWith(":two"));
  assert.equal(turns[0].transcript, "One. Two.");
});
test("disconnection gaps are backfilled and reconnect continues another item", () => {
  const state = {};
  reduceAssistantEvents(invite, state, [delta("one", "Before the gap.")]);
  reconcileAssistantHistory(invite, state, [history("Before the gap."), history("During the outage.", "2026-10-19T10:00:10Z")]);
  reduceAssistantEvents(invite, state, [delta("three", "Back online.", { receivedAt: "2026-10-19T10:00:20Z" })]);
  reconcileAssistantHistory(invite, state, [history("Back online.", "2026-10-19T10:00:19Z"), history("During the outage.", "2026-10-19T10:00:10Z"), history("Before the gap.")]);
  assert.equal(Object.values(state.turns).length, 3);
  assert.ok(Object.values(state.turns).every(t => t.isFinal));
});
test("deletion cannot be undone by delayed history, deltas or stale browser saves", () => {
  const state = {};
  const [prior] = reduceAssistantEvents(invite, state, [delta("one", "Discard this sentence.")]).map(t => structuredClone(t));
  const [deleted] = reduceAssistantEvents(invite, state, [{ type: "conversation.item.deleted", item_id: "one" }]);
  reduceAssistantEvents(invite, state, [delta("one", "late")]);
  reconcileAssistantHistory(invite, state, [history("Discard this sentence.")]);
  assert.equal(Object.values(state.turns).length, 1); assert.equal(deleted.transcript, "");
  const [merged] = mergeAgentAssistTranscriptions([deleted], [prior]); assert.equal(merged.deleted, true);
});
test("event IDs deduplicate re-delivery, multipart content preserves ordering", () => {
  const state = {}; const one = delta("one", "A", { event_id: "event1" });
  reduceAssistantEvents(invite, state, [one, one, delta("one", "C", { content_index: 1 }), delta("one", "B")]);
  assert.equal(Object.values(state.turns)[0].transcript, "ABC");
});
test("observer setup preserves external destinations and writes only verified observer fields", async () => {
  const config = assistantEventConfig({ WS_BASE_URL: "wss://events.example.test", NEXTAUTH_SECRET: "a".repeat(32) });
  assert.equal(authorizeAssistantEvents(`Bearer ${config.token}`, config), true);
  assert.equal(authorizeAssistantEvents(undefined, config), false);
  assert.equal(authorizeAssistantEvents("Bearer wrong", config), false);
  await assert.rejects(configureAssistantEvents({ id: "assistant", websocket_settings: { enabled: true, url: "wss://external.example" } }, { config, canUpdateAssistant: true, request: () => assert.fail() }), /different Conversation WebSocket/);
  const calls = []; let saved;
  await configureAssistantEvents({ id: "assistant" }, { config, canUpdateAssistant: true, request: async (path, options) => {
    calls.push({ path, options });
    if (path.startsWith("/integration_secrets")) return { data: [{ identifier: config.identifier, type: "bearer" }] };
    if (options) { saved = options.body; return { data: {} }; }
    return { data: { id: "assistant", ...saved } };
  } });
  assert.deepEqual(Object.keys(saved), ["websocket_settings"]);
  assert.equal(calls.length, 4);
});
test('history arriving first retires the duplicate socket bubble and later deletion targets the same turn', () => {
  const state = {};
  const [first] = reconcileAssistantHistory(invite, state, [history('Late live event.')]);
  reduceAssistantEvents(invite, state, [delta('late', 'Late live event.')]);
  reconcileAssistantHistory(invite, state, [history('Late live event.')]);
  assert.equal(Object.values(state.turns).filter(t => !t.deleted).length, 1);
  reduceAssistantEvents(invite, state, [{type:'conversation.item.deleted',item_id:'late'}]);
  assert.equal(state.turns[first.id].deleted, true);
});
test('a missing middle span after reconnect is replaced by the full history reply', () => {
  const state = {};
  reduceAssistantEvents(invite, state, [delta('gap', 'Here is the '), delta('gap', 'sentence.')]);
  reconcileAssistantHistory(invite, state, [history('Here is the complete recovered sentence.')]);
  assert.equal(Object.values(state.turns).length, 1);
  assert.equal(Object.values(state.turns)[0].transcript, 'Here is the complete recovered sentence.');
});
test('an identical new response after reconnect cannot consume a missing response from the gap', () => {
 const state={gaps:[{start:'2026-10-19T10:00:00Z',end:'2026-10-19T10:00:03Z'}]};
 reduceAssistantEvents(invite,state,[{type:'response.output_item.added',receivedAt:'2026-10-19T10:00:04Z',item:{id:'after',role:'assistant',type:'message',content:[]}},delta('after','Orchid')]);
 reconcileAssistantHistory(invite,state,[history('Orchid','2026-10-19T10:00:02Z'),history('Orchid','2026-10-19T10:00:04Z')]);
 const turns=Object.values(state.turns).filter(t=>!t.deleted);assert.equal(turns.length,2);assert.equal(turns.find(t=>t.id.endsWith(':after')).timestamp,'2026-10-19T10:00:04Z');
});
