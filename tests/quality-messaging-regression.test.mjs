import test from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute} from './helpers/route-harness.mjs';
import {channelDefinition} from '../lib/acd/channel-registry.mjs';
import {readMessageTranscript} from '../lib/acd/message-transcript.mjs';
import {resolveEvaluationModel} from '../lib/quality/models.mjs';
for(const channel of ['chat','email','sms','whatsapp']) {
 test(`Quality ${channel} uses episode text only, even if a recording and invalid transcription model are supplied`,async()=>{
  let outcome, job;
  const work='controlled-work';
  const db={query:async(sql,params)=>{
   if(sql.includes('SELECT e.*'))return{rows:[{id:'evaluation',work_item_id:work,status:'draft',form_schema:{sections:[]}}]};
   if(sql.includes('SELECT id FROM quality_ai_jobs'))return{rows:[]};
   if(sql.includes('FROM acd_messages')){assert.match(sql,/m.work_item_id=\$1/);assert.match(sql,/ORDER BY m.seq/);assert.deepEqual(params,[work]);return{rows:[{sender_role:'customer',body:'Can you help?',created_at:'2026-09-26T10:00:00Z'},{sender_role:'agent',body:'Yes, resolved.',created_at:'2026-09-26T10:01:00Z'}]};}
   if(sql.includes('INSERT INTO quality_ai_jobs')){job=params;return{rows:[{id:'job'}]};}
   if(sql.includes('SET answers = $2')){outcome=JSON.parse(params[2]);return{rows:[{id:'evaluation',status:'ai_draft',ai_result:outcome}]};}
   return{rows:[]};
  }};
  const route=await loadRoute('app/api/contact-center/quality/evaluations/[id]/ai/route.js',{
   '@/lib/acd/channel-registry.mjs':{channelDefinition},'@/lib/acd/message-transcript.mjs':{readMessageTranscript},
   '@/lib/postgres.mjs':{getPostgresPool:()=>db},'@/lib/diagnostic-logger.mjs':{createDiagnosticLogger:()=>({error(){}})},
   '@/lib/quality/models.mjs':{resolveEvaluationModel},
   '@/lib/quality/transcription.mjs':{getExistingTranscript(){throw Error('Do not use audio transcript for messages');},resolveRecordingId(){throw Error('Do not resolve audio for messages');},transcribeInteractionRecording(){throw Error('Do not transcribe messages');}},
   '@/config/transcription-models':{DEFAULT_TRANSCRIPTION_MODEL:'speech-default'},
   '@/lib/acd/work-item-repository.mjs':{findWorkItemWithArtifacts:async()=>({id:work,work_item_id:work,channel,metadata:{recording:{recording_id:'irrelevant'}}})},
   '@/lib/quality/ai-evaluator.mjs':{evaluateTranscriptWithAi:async input=>{assert.match(input.transcriptText,/customer: Can you help/);assert.match(input.transcriptText,/agent: Yes, resolved/);assert.equal(input.context.channel,channel);return{model:input.model,answers:{},score:{scoreTotal:1,scoreMax:1,scorePercent:100}};}},
   '@/lib/auth-server':{getAuthenticatedUser:async()=>({id:'reviewer',roles:['admin']})}
  });
  const response=await route.POST(new Request('http://local/api/evaluation/ai',{method:'POST',body:JSON.stringify({transcription_model:'invalid'})}),{params:Promise.resolve({id:'evaluation'})});
  assert.equal(response.status,200);assert.equal(outcome.evidence_source,'messaging');assert.equal(outcome.message_count,2);assert.equal(outcome.transcription_model,null);assert.equal(job[2],null);assert.equal(job[3],null);
 });
}
test('Empty message history returns an actionable 422 rather than trying audio',async()=>{
 await assert.rejects(readMessageTranscript({query:async()=>({rows:[]})},'work'),e=>e.status===422&&/No conversation evidence/.test(e.message));
});
