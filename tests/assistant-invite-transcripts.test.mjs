import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantHistoryTurns,collectInvitationTranscript} from '../lib/acd/assistant-invite-transcripts.mjs';
const invite={id:'invite-one',assistant_id:'assistant-one',provider_call_id:'ai-leg',transcript_state:{enabled:true}};
const target='invite-one@assistant-one.sip.telnyx.com';
const text={role:'assistant',text:'I can help.',sent_at:'2026-10-18T20:00:01Z',created_at:'2026-10-18T20:00:06Z'};
test('conversation lookup requires an exact unique invitation and assistant match',async()=>{
 for(const data of [[{id:'wrong',metadata:{to:'other@assistant-one.sip.telnyx.com',assistant_id:'assistant-one'}}],[{id:'wrong',metadata:{to:target,assistant_id:'other'}}],[{id:'one',metadata:{to:target,assistant_id:'assistant-one'}},{id:'two',metadata:{to:target,assistant_id:'assistant-one'}}]]){
  let calls=0;assert.equal(await collectInvitationTranscript(invite,async route=>{calls++;assert.ok(route.startsWith('/ai/conversations?'));return{data};}),null);assert.equal(calls,1);
 }
});
test('all message pages are read, tools and human turns ignored, restart checkpoint prevents duplicates',async()=>{
 const request=async route=>{
  if(route.startsWith('/ai/conversations?'))return{data:[{id:'conversation',metadata:{to:target,assistant_id:'assistant-one'}}]};
  if(route.includes('number]=1'))return{data:[{role:'user',text:'Question'},text],meta:{total_pages:2}};
  return{data:[{role:'assistant',text:null,tool_calls:[{}]},{...text,sent_at:'2026-10-18T20:00:10Z'}],meta:{total_pages:2}};
 };
 const first=await collectInvitationTranscript(invite,request);assert.equal(first.turns.length,2);assert.equal(first.turns[0].timestamp,text.sent_at);assert.notEqual(first.turns[0].id,first.turns[1].id);
 const restarted=await collectInvitationTranscript({...invite,transcript_state:first.state},request);assert.equal(restarted.turns.length,0);
});
test('history content changes retain identity and conversations sharing an assistant cannot share keys',()=>{
 const first=assistantHistoryTurns(invite,[text])[0];const correction=assistantHistoryTurns(invite,[{...text,text:'I can help you.'}])[0];
 assert.equal(first.id,correction.id);assert.notEqual(first.id,assistantHistoryTurns({...invite,id:'invite-two'},[text])[0].id);
 assert.deepEqual(assistantHistoryTurns(invite,[{role:'assistant',text:'No timestamp'},{role:'tool',text:'Never render tool output'}]),[]);
});

test('newest-first insertion does not change identities of older turns',async()=>{
 let messages=[text];
 const request=async()=>({data:messages,meta:{total_pages:1}});
 const first=await collectInvitationTranscript({...invite,transcript_state:{conversationId:'conversation'}},request);
 messages=[{...text,sent_at:'2026-10-18T20:01:00Z',created_at:'2026-10-18T20:01:05Z'},...messages];
 const second=await collectInvitationTranscript({...invite,transcript_state:first.state},request);
 assert.equal(second.turns.length,1);assert.equal(second.turns[0].timestamp,'2026-10-18T20:01:00Z');
});
