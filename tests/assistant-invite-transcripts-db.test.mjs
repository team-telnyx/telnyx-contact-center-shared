import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepareAcdTestPool} from './helpers/acd-test-db.mjs';
import {syncAssistantInviteTranscripts} from '../lib/acd/assistant-invite-transcripts.mjs';
const pool=await prepareAcdTestPool('acd_invite_transcript_test');after(()=>pool.end());
await pool.query('CREATE TABLE aa_workflow_sessions(id UUID PRIMARY KEY,work_item_id UUID,transcriptions JSONB,started_at TIMESTAMPTZ,updated_at TIMESTAMPTZ)');
const workId=randomUUID(),agentId=randomUUID(),inviteId=randomUUID();
await pool.query("INSERT INTO users(id,username) VALUES($1,'test-agent')",[agentId]);
await pool.query("INSERT INTO acd_work_items(id,channel,direction,state) VALUES($1,'voice','inbound','active')",[workId]);
await pool.query("INSERT INTO acd_assistant_invites(id,work_item_id,agent_id,assistant_id,assistant_name,supervised_call_id,provider_call_id,state,transcript_state) VALUES($1,$2,$3,'assistant-test','Test','device','ai','active','{\"enabled\":true}')",[inviteId,workId,agentId]);
const messages=[{role:'assistant',text:'Hello',sent_at:'2026-10-18T20:00:01Z',created_at:'2026-10-18T20:00:06Z'}];
const request=async route=>route.includes('/messages')?{data:messages,meta:{total_pages:1}}:{data:[{id:'conversation',metadata:{to:`${inviteId}@assistant-test.sip.telnyx.com`,assistant_id:'assistant-test'}}]};
const wake=()=>pool.query('UPDATE acd_assistant_invites SET transcript_next_poll_at=NULL WHERE id=$1',[inviteId]);
test('durable checkpoint, transcript and restart deduplication',async()=>{
 const events=[];const broadcast=async(key,event)=>events.push({key,event});
 await syncAssistantInviteTranscripts(pool,{request,broadcast});assert.equal(events.length,1);assert.equal(events[0].event.transcription.track,'assistant');assert.equal(events[0].event.interactionId,workId);
 await wake();await syncAssistantInviteTranscripts(pool,{request,broadcast});assert.equal(events.length,1);
 const row=(await pool.query('SELECT segments FROM acd_transcripts WHERE work_item_id=$1',[workId])).rows[0];assert.equal(row.segments.length,1);assert.equal(row.segments[0].timestamp,messages[0].sent_at);
});
test('provider failure does not advance checkpoint, late final turn is collected after hangup',async()=>{
 const before=(await pool.query('SELECT transcript_state FROM acd_assistant_invites WHERE id=$1',[inviteId])).rows[0].transcript_state;
 await wake();await syncAssistantInviteTranscripts(pool,{request:async()=>{throw Error('temporary outage');},broadcast:async()=>assert.fail()});
 const after=(await pool.query('SELECT transcript_state FROM acd_assistant_invites WHERE id=$1',[inviteId])).rows[0].transcript_state;assert.deepEqual(after,before);
 messages.push({...messages[0],sent_at:'2026-10-18T20:00:02Z',created_at:'2026-10-18T20:00:07Z'});
 await pool.query("UPDATE acd_assistant_invites SET ended_at=now(),state='ended',transcript_next_poll_at=NULL WHERE id=$1",[inviteId]);
 const events=[];await syncAssistantInviteTranscripts(pool,{request,broadcast:async(key,event)=>events.push(event)});assert.equal(events.length,1);
 const row=(await pool.query('SELECT segments FROM acd_transcripts WHERE work_item_id=$1',[workId])).rows[0];assert.equal(row.segments.length,2,'intentional repeated AI turn must survive');
});
