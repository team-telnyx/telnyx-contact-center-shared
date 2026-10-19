import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool } from "./helpers/acd-test-db.mjs";
import { inviteVoiceAssistant, readAssistantInvite, applyAssistantInviteEvent, removeVoiceAssistant, reconcileAssistantInvites } from "../lib/acd/assistant-invites.mjs";
import { recordHoldIntent } from "../lib/acd/hold-intents.mjs";
const pool = await prepareAcdTestPool("acd_assistant_invites_test");
after(() => pool.end());
const assistantId = `assistant-${randomUUID()}`;
const assistant = { id: assistantId, name: "Controlled assistant", tools: [{ type: "skip_turn" }] };
const options = { connectionId: "controlled", from: "+12025550100", request: async () => assert.fail("Inviting AI must not read or change its provider configuration") };
async function setup() {
  const interactionId = randomUUID(), agentId = randomUUID(), requestId = randomUUID(), callId = randomUUID();
  await pool.query("INSERT INTO acd_work_items(id,channel,direction,state,attributes) VALUES($1,'voice','inbound','active',$2)", [interactionId, { agent_assist_config: { enable_assistant_invite: true, invite_assistant_ids: [assistantId], invite_assistants: [{ id: assistantId, name: "Saved assistant" }] } }]);
  await pool.query("INSERT INTO acd_segments(id,work_item_id,seq,kind,agent_id,started_at) VALUES($1,$2,1,'agent',$3,now())", [randomUUID(), interactionId, agentId]);
  await pool.query("INSERT INTO acd_legs(id,work_item_id,role,agent_id,provider_call_id,state,bridged_at) VALUES($1,$2,'agent_device',$3,$4,'bridged',now())", [randomUUID(), interactionId, agentId, callId]);
  return { interactionId, agentId, requestId, assistantId, webhookUrl: "https://controlled.example.test/api/voice/assistant-invite/events", callId };
}
const event = (args, type, callId) => ({ data: { event_type: type, payload: { call_control_id: callId, client_state: Buffer.from(JSON.stringify({ cc_assistant_invite: args.requestId })).toString("base64") } } });
test("one AI leg, saved flow policy, owner checks and safe removal", async () => {
  const args = await setup(), calls = [];
  const provider = { send: async command => { calls.push(command); return { outcome: "accepted", response: { data: { call_control_id: "ai-" + args.requestId } } }; } };
  await assert.rejects(inviteVoiceAssistant(pool, { ...args, agentId: "other" }, { ...options, provider }), error => error.status === 403);
  await assert.rejects(inviteVoiceAssistant(pool, { ...args, assistantId: `assistant-${randomUUID()}` }, { ...options, provider }), error => error.status === 403);
  const results = await Promise.all([inviteVoiceAssistant(pool, args, { ...options, provider }), inviteVoiceAssistant(pool, args, { ...options, provider })]);
  assert.equal(results[0].name, "Saved assistant");
  assert.equal(results[0].id, results[1].id); assert.equal(calls.length, 1);
  assert.equal(calls[0].request.supervisor_role, "barge"); assert.equal(calls[0].request.supervise_call_control_id, args.callId);
  assert.equal(calls[0].request.to, `sip:${args.requestId}@${assistantId}.sip.telnyx.com`);
  await assert.rejects(inviteVoiceAssistant(pool, { ...args, requestId: randomUUID() }, { ...options, provider }), /already/);
  await applyAssistantInviteEvent(pool, event(args, "call.answered", "ai-" + args.requestId));
  assert.equal((await readAssistantInvite(pool, args)).invite.state, "active");
  await removeVoiceAssistant(pool, { ...args, inviteId: args.requestId });
  await reconcileAssistantInvites(pool, { provider, request: async () => ({ is_alive: true }) });
  assert.equal(calls.at(-1).endpoint, `/calls/ai-${args.requestId}/actions/hangup`);
  assert.equal((await pool.query("SELECT state FROM acd_work_items WHERE id=$1", [args.interactionId])).rows[0].state, "active");
  assert.equal((await pool.query("SELECT ended_at FROM acd_legs WHERE work_item_id=$1", [args.interactionId])).rows[0].ended_at, null);
  assert.equal((await readAssistantInvite(pool, args)).invite.state, "stopping");
  await applyAssistantInviteEvent(pool, event(args, "call.hangup", "ai-" + args.requestId));
  await applyAssistantInviteEvent(pool, event(args, "call.answered", "ai-" + args.requestId));
  assert.equal((await readAssistantInvite(pool, args)).invite.state, "ended");
});
test("unknown provider outcome is never redialed and late evidence after cancel is cleaned up", async () => {
  const args = await setup(); let dials = 0; const commands = [];
  const provider = { send: async command => { commands.push(command); if (command.endpoint === "/calls") { dials++; return { outcome: "ambiguous", response: {} }; } return { outcome: "accepted", response: {} }; } };
  assert.equal((await inviteVoiceAssistant(pool, args, { ...options, provider })).state, "unknown");
  await removeVoiceAssistant(pool, { ...args, inviteId: args.requestId });
  await inviteVoiceAssistant(pool, args, { ...options, provider }); assert.equal(dials, 1);
  await applyAssistantInviteEvent(pool, event(args, "call.initiated", "late-ai"));
  await reconcileAssistantInvites(pool, { provider, request: async () => ({ is_alive: false }) });
  assert.equal(commands.at(-1).endpoint, "/calls/late-ai/actions/hangup");
});
test("call termination removes AI without targeting human legs", async () => {
  const args = await setup(), commands = [];
  const provider = { send: async command => { commands.push(command); return { outcome: "accepted", response: { data: { call_control_id: "cleanup-ai" } } }; } };
  await inviteVoiceAssistant(pool, args, { ...options, provider });
  await pool.query("UPDATE acd_work_items SET state='completed',terminal_at=now() WHERE id=$1", [args.interactionId]);
  await reconcileAssistantInvites(pool, { provider, request: async () => ({ is_alive: false }) });
  assert.equal(commands.at(-1).endpoint, "/calls/cleanup-ai/actions/hangup");
});

test("an unanswered or held device cannot start a three-way invitation", async () => {
  const args = await setup();
  const provider = { send: async () => assert.fail("must not dial") };
  await pool.query("UPDATE acd_legs SET state='held' WHERE work_item_id=$1", [args.interactionId]);
  await assert.rejects(inviteVoiceAssistant(pool, args, { ...options, provider }), /not on hold/);
  await pool.query("UPDATE acd_legs SET state='answered',bridged_at=NULL WHERE work_item_id=$1", [args.interactionId]);
  await assert.rejects(inviteVoiceAssistant(pool, args, { ...options, provider }), /connected/);
  await pool.query("UPDATE acd_work_items SET state='completed',terminal_at=now() WHERE id=$1", [args.interactionId]);
});

test("transcription setup failure releases the invitation without dialing AI", async () => {
  const args = await setup();
  await assert.rejects(inviteVoiceAssistant(pool, args, {
    ...options,
    prepareTranscription: async () => { throw new Error("Participant streaming unavailable"); },
    provider: { send: async () => assert.fail("AI must not join without isolated transcript sources") },
  }), error => error.status === 503 && /streaming unavailable/.test(error.message));
  const row = (await pool.query("SELECT state,ended_at FROM acd_assistant_invites WHERE id=$1", [args.requestId])).rows[0];
  assert.equal(row.state, "failed"); assert.ok(row.ended_at);
});

test("AI invitation uses a unique SIP target for transcript correlation", async () => {
  const args = await setup(); let dial;
  await pool.query("UPDATE acd_work_items SET attributes=attributes || '{\"telnyx_stt_config\":{\"enabled\":true}}'::jsonb WHERE id=$1", [args.interactionId]);
  const listed = await readAssistantInvite(pool, args);
  assert.deepEqual(listed.assistants, [{ id: assistantId, name: "Saved assistant", unavailable: false }]);
  await inviteVoiceAssistant(pool, args, {
    ...options,
    prepareTranscription: async () => ({ config: { enabled: true, model: "deepgram/flux" }, username: "controlled", interactionId: args.interactionId }),
    provider: { send: async command => { dial = command.request; return { outcome: "accepted", response: { data: { call_control_id: "three-party-ai" } } }; } },
  });
  const state = JSON.parse(Buffer.from(dial.client_state, "base64").toString());
  assert.equal(state.cc_assistant_invite, args.requestId);
  assert.equal(dial.to, `sip:${args.requestId}@${args.assistantId}.sip.telnyx.com`);
  const saved = (await pool.query("SELECT transcript_state FROM acd_assistant_invites WHERE id=$1", [args.requestId])).rows[0];
  assert.equal(saved.transcript_state.enabled, true);
  assert.equal(dial.stream_url, undefined);
});

test("standard hold intent blocks an invitation until the agent resumes the call", async () => {
  const args = await setup(), commands = [];
  await pool.query("INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,state,bridged_at) VALUES($1,$2,'customer',$3,'bridged',now())", [randomUUID(), args.interactionId, randomUUID()]);
  const provider = { send: async command => { commands.push(command); return { outcome: "accepted", response: { data: { call_control_id: "after-hold-ai" } } }; } };
  const held = await recordHoldIntent(pool, { interactionId: args.interactionId, agentId: args.agentId, action: "hold", provider });
  assert.ok(held.sagaId);
  const leg = (await pool.query("SELECT state FROM acd_legs WHERE id=$1", [held.legId])).rows[0];
  assert.equal(leg.state, "held");
  await assert.rejects(inviteVoiceAssistant(pool, args, { ...options, provider }), /not on hold/);
  assert.equal(commands.filter(command => command.endpoint === "/calls").length, 0);
  await recordHoldIntent(pool, { interactionId: args.interactionId, agentId: args.agentId, action: "unhold", provider });
  assert.equal((await inviteVoiceAssistant(pool, args, { ...options, provider })).state, "joining");
  assert.equal(commands.filter(command => command.endpoint === "/calls").length, 1);
});

test("cleanup reaches later invitations beyond a full batch of unknown outcomes", async () => {
  const unknown = { send: async () => ({ outcome: "ambiguous", response: {} }) };
  for (let index = 0; index < 50; index++) await inviteVoiceAssistant(pool, await setup(), { ...options, provider: unknown });
  const commands = [];
  const provider = { send: async command => { commands.push(command); return { outcome: "accepted", response: { data: { call_control_id: `fair-ai-${command.commandId}` } } }; } };
  const removed = await setup(), ended = await setup();
  for (const args of [removed, ended]) await inviteVoiceAssistant(pool, args, { ...options, provider });
  await removeVoiceAssistant(pool, { ...removed, inviteId: removed.requestId });
  await pool.query("UPDATE acd_work_items SET state='completed',terminal_at=now() WHERE id=$1", [ended.interactionId]);
  for (let pass = 0; pass < 3; pass++) await reconcileAssistantInvites(pool, { provider, request: async () => ({ is_alive: false }) });
  for (const args of [removed, ended]) {
    assert.ok(commands.some(command => command.endpoint === `/calls/fair-ai-${args.requestId}/actions/hangup`));
    assert.equal((await pool.query("SELECT state FROM acd_assistant_invites WHERE id=$1", [args.requestId])).rows[0].state, "ended");
  }
});
