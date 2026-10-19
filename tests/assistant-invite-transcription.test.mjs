import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareInviteTranscription, invitationSipTarget, stopInviteTransportTranscription} from '../lib/acd/assistant-invite-transcription.mjs';
import {normalizeTranscriptionLeg} from '../lib/agent-assist/transcription-turns.mjs';
import {mergeAgentAssistTranscriptions} from '../lib/agent-assist/history-merge.mjs';
import useActiveCallStore from '../lib/stores/active-call-store.js';

const item={id:'work',attributes:{telnyx_stt_config:{enabled:true,model:'deepgram/flux',language:'en'}}};
const invite={id:'invite',agent_id:'agent',supervised_call_id:'device'};
function db(){const writes=[];return {writes,query:async(sql,params)=>{
 if(sql.includes('FROM acd_legs'))return{rows:[{role:'customer',provider_call_id:'customer'},{role:'agent_device',provider_call_id:'device'},{role:'agent_transport',provider_call_id:'mixed'}]};
 if(sql.includes('FROM users'))return{rows:[{username:'controlled'}]};writes.push({sql,params});return{rows:[]};
}};}
test('invite isolates human endpoint microphones and excludes the conference transport',async()=>{
 const pool=db(),starts=[],stops=[];
 const result=await prepareInviteTranscription(pool,item,invite,{start:async(...args)=>{starts.push(args);return true;},stop:async id=>stops.push(id)});
 assert.deepEqual(starts.map(a=>[a[0],a[4].mediaTrack,a[4].outputTrack]),[['customer','inbound','inbound'],['device','inbound','outbound']]);
 assert.deepEqual(stops,['mixed']);assert.deepEqual(JSON.parse(pool.writes[0].params[1]),{customerCallId:'customer',agentCallId:'device',ignoredCallIds:['mixed']});
 assert.equal(invitationSipTarget({id:'invite',assistant_id:'assistant-one'}),'invite@assistant-one.sip.telnyx.com');
});
test('failed separate media setup does not suppress existing human transcription',async()=>{
 const pool=db();await assert.rejects(prepareInviteTranscription(pool,item,invite,{start:async()=>false,stop:async()=>assert.fail()}),/separate participant/);assert.equal(pool.writes.length,0);
});
test('calls without transcription do not start new media streams',async()=>{
 assert.equal(await prepareInviteTranscription(db(),{id:'work',attributes:{}},invite,{start:async()=>assert.fail()}),null);
});
test('conference fork stops through Telnyx even without a local STT session',async()=>{
 const calls=[];
 await stopInviteTransportTranscription('remote/transport',{provider:{send:async command=>{calls.push(command);return{outcome:'accepted'};}},stopLocal:async id=>calls.push(id)});
 assert.equal(calls[0].endpoint,'/calls/remote%2Ftransport/actions/streaming_stop');
 assert.deepEqual(calls[0].request,{});assert.equal(calls[1],'remote/transport');
});
test('unconfirmed remote stop prevents AI join while an ended leg permits local cleanup',async()=>{
 for(const outcome of ['failed','ambiguous'])await assert.rejects(stopInviteTransportTranscription('remote',{provider:{send:async()=>({outcome,response:{}})},stopLocal:async()=>assert.fail('Remote stop must be confirmed')}),/Could not stop/);
 let stopped=false;
 await stopInviteTransportTranscription('ended',{provider:{send:async()=>({outcome:'failed',response:{errors:[{code:'90018'}]}})},stopLocal:async()=>{stopped=true;}});
 assert.equal(stopped,true);
 const pool=db();await assert.rejects(prepareInviteTranscription(pool,item,invite,{start:async()=>true,stop:async()=>{throw new Error('remote stop failed');}}),/remote stop failed/);
});
test('three speakers remain distinct during live coalescing and history persistence',()=>{
 useActiveCallStore.setState({call:{id:'test'},transcriptions:[]});
 const tracks=['inbound','assistant','outbound'];
 for(const track of tracks)useActiveCallStore.getState().addTranscription({call_control_id:track,transcription_key:track,transcription_track:track,transcript:'I can hear you.',is_final:true,speech_final:true});
 const rows=useActiveCallStore.getState().transcriptions;assert.deepEqual(rows.map(t=>t.track),tracks);
 assert.deepEqual(mergeAgentAssistTranscriptions(rows,[]).map(t=>t.track),tracks);
 assert.equal(normalizeTranscriptionLeg('assistant'),'assistant');assert.equal(normalizeTranscriptionLeg('inbound'),'inbound');assert.equal(normalizeTranscriptionLeg('outbound'),'outbound');
});

test('per-participant language and selected transcription tracks are preserved',async()=>{
 const pool=db(),starts=[];
 const base=pool.query;pool.query=(sql,args)=>sql.includes('FROM users')?Promise.resolve({rows:[{username:'controlled',language:'pl'}]}):base(sql,args);
 await prepareInviteTranscription(pool,{...item,attributes:{telnyx_stt_config:{...item.attributes.telnyx_stt_config,transcription_tracks:'outbound'}}},invite,{start:async(...args)=>{starts.push(args);return true;},stop:async()=>{}});
 assert.equal(starts.length,1);assert.equal(starts[0][0],'device');assert.equal(starts[0][1].language,'pl');
});

test('delayed assistant history is placed at spoken time and redelivery updates the same bubble',()=>{
 useActiveCallStore.setState({call:{id:'test'},transcriptions:[{id:'human',transcriptionKey:'human',track:'outbound',transcript:'A later reply',timestamp:'2026-10-18T20:00:05Z',isFinal:true}]});
 const turn={transcription_key:'ai-one',call_control_id:'ai',transcription_track:'assistant',source:'telnyx_assistant_history',timestamp:'2026-10-18T20:00:01Z',transcript:'Hello',is_final:true,speech_final:true};
 useActiveCallStore.getState().addTranscription(turn);useActiveCallStore.getState().addTranscription({...turn,transcript:'Hello everyone'});
 const rows=useActiveCallStore.getState().transcriptions;assert.deepEqual(rows.map(t=>t.track),['assistant','outbound']);assert.equal(rows[0].transcript,'Hello everyone');
});

test('native webhook mixes cannot be relabelled as an isolated human microphone',async()=>{
 const {participantTranscriptTrack}=await import('../lib/agent-assist/transcription-speaker.mjs');
 const mapping={customerCallId:'customer',agentCallId:'device',ignoredCallIds:['transport']};
 assert.equal(participantTranscriptTrack(mapping,{callControlId:'customer',track:'outbound'}),null);
 assert.equal(participantTranscriptTrack(mapping,{callControlId:'device',track:'outbound'}),null);
 assert.equal(participantTranscriptTrack(mapping,{callControlId:'transport',track:'inbound'}),null);
 assert.equal(participantTranscriptTrack(mapping,{callControlId:'customer',track:'inbound'}),'inbound');
 assert.equal(participantTranscriptTrack(mapping,{callControlId:'device',track:'inbound'}),'outbound');
 assert.equal(participantTranscriptTrack(mapping,{callControlId:'device',track:'outbound',source:'telnyx_standalone_stt_websocket'}),'outbound');
 assert.equal(participantTranscriptTrack(null,{callControlId:'ordinary',track:'outbound'}),'outbound');
});

test('late human finalization retains the first fragment time before an AI answer',async()=>{
 const {timestampTranscriptTurn}=await import('../lib/agent-assist/transcription-turns.mjs');
 const clock={};
 const start='2026-10-18T20:00:01Z',replyTime='2026-10-18T20:00:03Z',finalTime='2026-10-18T20:00:20Z';
 assert.equal(timestampTranscriptTurn(clock,{isFinal:false,speechFinal:false},start),start);
 assert.equal(timestampTranscriptTurn(clock,{isFinal:true,speechFinal:false},replyTime),start);
 const final=timestampTranscriptTurn(clock,{isFinal:true,speechFinal:true},finalTime);assert.equal(final,start);
 assert.equal(timestampTranscriptTurn(clock,{isFinal:true},finalTime),finalTime);
 useActiveCallStore.setState({call:{id:'test'},transcriptions:[]});
 const human={transcription_key:'human',call_control_id:'agent',transcription_track:'outbound',source:'telnyx_standalone_stt_websocket',timestamp:start,transcript:'A question',is_final:false,speech_final:false};
 useActiveCallStore.getState().addTranscription(human);
 useActiveCallStore.getState().addTranscription({transcription_key:'ai',call_control_id:'ai',transcription_track:'assistant',source:'telnyx_assistant_history',timestamp:replyTime,transcript:'The answer',is_final:true,speech_final:true});
 useActiveCallStore.getState().addTranscription({...human,timestamp:final,is_final:true,speech_final:true});
 assert.deepEqual(useActiveCallStore.getState().transcriptions.map(t=>[t.track,t.timestamp]),[['outbound',start],['assistant',replyTime]]);
});
