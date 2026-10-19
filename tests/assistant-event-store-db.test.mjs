import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool } from "./helpers/acd-test-db.mjs";
import { bindAssistantConversation, acceptAssistantEvents, disconnectAssistantEvents } from "../lib/acd/assistant-event-store.mjs";
import { syncAssistantInviteTranscripts } from "../lib/acd/assistant-invite-transcripts.mjs";
const pool = await prepareAcdTestPool("acd_assistant_events_test"); after(() => pool.end());
await pool.query("CREATE TABLE aa_workflow_sessions(id UUID PRIMARY KEY,work_item_id UUID,transcriptions JSONB,started_at TIMESTAMPTZ,updated_at TIMESTAMPTZ)");
const workId = randomUUID(), agentId = randomUUID(), inviteId = randomUUID();
await pool.query("INSERT INTO users(id,username) VALUES($1,'event-test-agent')", [agentId]);
await pool.query("INSERT INTO acd_work_items(id,channel,direction,state) VALUES($1,'voice','inbound','active')", [workId]);
await pool.query(`INSERT INTO acd_assistant_invites(id,work_item_id,agent_id,assistant_id,assistant_name,supervised_call_id,provider_call_id,transcript_state) VALUES($1,$2,$3,'assistant-test','Test','device','ai','{"enabled":true}')`, [inviteId, workId, agentId]);
const session = { conversation_id: "conversation", assistant_id: "assistant-test" };
const metadata = async () => ({ data: { metadata: { to: `${inviteId}@assistant-test.sip.telnyx.com`, assistant_id: "assistant-test" } } });
const at = new Date().toISOString(); const received = [];
const broadcast = async (key, event) => received.push({ key, event });
const state = async () => (await pool.query("SELECT transcript_state FROM acd_assistant_invites WHERE id=$1", [inviteId])).rows[0].transcript_state;
test("exact correlation, immediate durable partials, reconnect fencing and concurrent history merge", async () => {
  await assert.rejects(bindAssistantConversation(pool, { ...session, assistant_id: "other" }, "bad", metadata));
  await bindAssistantConversation(pool, session, "first", metadata);
  await acceptAssistantEvents(pool, inviteId, "first", [{ type: "response.text.delta", item_id: "turn1", delta: "Hello", receivedAt: at }], broadcast);
  assert.equal(received.length, 1); assert.equal(received[0].event.transcription.is_final, false);
  assert.equal((await state()).turns[`ai-invite:${inviteId}:ws:turn1`].transcript, "Hello");
  await disconnectAssistantEvents(pool, inviteId, "first");
  await bindAssistantConversation(pool, session, "second", metadata);
  await disconnectAssistantEvents(pool, inviteId, "first");
  assert.equal((await state()).ws.connected, true);
  await acceptAssistantEvents(pool, inviteId, "first", [{ type: "response.text.delta", item_id: "turn1", delta: " stale" }], broadcast);
  assert.equal(received.length, 1);
  await Promise.all([
    acceptAssistantEvents(pool, inviteId, "second", [{ type: "response.text.delta", item_id: "turn1", delta: " world." }], broadcast),
    syncAssistantInviteTranscripts(pool, { broadcast, request: async () => ({ data: [{ role: "assistant", text: "Hello world.", sent_at: at, created_at: at }] }) }),
  ]);
  const current = await state(); assert.equal(current.ws.connectionId, "second"); assert.equal(Object.keys(current.turns).length, 1);
  const artifact = (await pool.query("SELECT segments FROM acd_transcripts WHERE work_item_id=$1", [workId])).rows[0];
  assert.equal(artifact.segments.length, 1); assert.equal(artifact.segments[0].transcript, "Hello world."); assert.equal(artifact.segments[0].isFinal, true);
  await acceptAssistantEvents(pool, inviteId, "second", [{ type: "conversation.item.deleted", item_id: "turn1" }], broadcast);
  assert.equal(received.at(-1).event.transcription.deleted, true);
});
test('a slow previous handshake cannot take ownership back from a reconnected socket', async () => {
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const slow=bindAssistantConversation(pool,session,'slow-old',async()=>{await gate;return metadata();});
  await new Promise(resolve=>setTimeout(resolve,10));
  await bindAssistantConversation(pool,session,'new-owner',metadata);
  release();
  await assert.rejects(slow,/newer socket/);
  assert.equal((await state()).ws.connectionId,'new-owner');
});
