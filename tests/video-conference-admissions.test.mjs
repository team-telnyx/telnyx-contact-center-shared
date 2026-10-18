import {test,after} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {prepareAcdTestPool} from './helpers/acd-test-db.mjs';import {ensureVideoSchema} from '../lib/video/schema.mjs';import {issueVideoMember,bindVideoMember,controlConferenceAi} from '../lib/video/conference.mjs';
const pool=await prepareAcdTestPool('acd_core_test_video_admissions');await ensureVideoSchema(pool);after(()=>pool.end());
async function fixture(){const conversation=randomUUID(),id=randomUUID(),principalId=randomUUID();await pool.query("INSERT INTO acd_conversations(id,channel,customer_name) VALUES($1,'video','Controlled admission')",[conversation]);await pool.query('INSERT INTO acd_video_sessions(id,conversation_id) VALUES($1,$2)',[id,conversation]);return {videoSessionId:id,principalId,role:'customer'};}
test('preparing a replacement does not revoke the connected participant or its consent',async()=>{
 const f=await fixture(),first=await issueVideoMember(pool,f);await bindVideoMember(pool,{...f,...first,participantId:'first'});
 await pool.query("UPDATE cc_video_members SET consent='{\"camera\":true}' WHERE id=$1",[first.admissionId]);
 const second=await issueVideoMember(pool,f);const active=(await pool.query('SELECT revoked_at,consent FROM cc_video_members WHERE id=$1',[first.admissionId])).rows[0];assert.equal(active.revoked_at,null);assert(active.consent.camera);
 await bindVideoMember(pool,{...f,...second,participantId:'second'});const old=(await pool.query('SELECT revoked_at,consent FROM cc_video_members WHERE id=$1',[first.admissionId])).rows[0];assert(old.revoked_at);assert.deepEqual(old.consent,{});
 const next=(await pool.query('SELECT consent FROM cc_video_members WHERE id=$1',[second.admissionId])).rows[0];assert.deepEqual(next.consent,{});
 await assert.rejects(bindVideoMember(pool,{...f,...first,participantId:'first'}),e=>e.status===403);
});
test('binding rejects forged capabilities, cross-room admissions and malformed identifiers',async()=>{
 const a=await fixture(),b=await fixture(),join=await issueVideoMember(pool,a);
 for(const body of [{...a,...join,bindingToken:'forged'},{...b,...join},{...a,...join,admissionId:'invalid'}])await assert.rejects(bindVideoMember(pool,{...body,participantId:'participant'}),e=>e.status===403);
});
test('an unbound join token cannot grant Vision access',async()=>{
 const f=await fixture();await issueVideoMember(pool,f);await assert.rejects(controlConferenceAi(pool,{video:{id:f.videoSessionId,conference_config:{ai:{vision:{mode:'live',allowedSources:['customer-camera']}}}},role:f.role,principalId:f.principalId,body:{action:'consent',source:'camera',enabled:true}}),e=>e.status===409);
});
test('concurrent admission attempts leave only one active binding',async()=>{
 const f=await fixture(),a=await issueVideoMember(pool,f),b=await issueVideoMember(pool,f);
 const result=await Promise.allSettled([bindVideoMember(pool,{...f,...a,participantId:'a'}),bindVideoMember(pool,{...f,...b,participantId:'b'})]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM cc_video_members WHERE video_session_id=$1 AND revoked_at IS NULL AND participant_id IS NOT NULL',[f.videoSessionId])).rows[0].n,1);
});
