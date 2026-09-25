import test from 'node:test';
import assert from 'node:assert/strict';
import {wrapupClock,wrapupSeconds} from '../lib/acd/wrapup-clock.mjs';
import {loadRoute} from './helpers/route-harness.mjs';

test('Core countdown retains the server deadline through reload and never falls back to 30 seconds',()=>{
  const now=Date.parse('2026-09-06T10:00:00Z');
  const data={acdOwned:true,wrapupPending:true,wrapupDeadlineAt:'2026-09-06T10:02:00Z'};
  assert.equal(wrapupSeconds(wrapupClock(data,now),now),120);
  assert.equal(wrapupSeconds(wrapupClock(data,now+45000),now+45000),75);
  assert.equal(wrapupSeconds(wrapupClock(data),now+130000),0);
  assert.equal(wrapupSeconds(wrapupClock({acdOwned:true})),null);
  assert.equal(wrapupClock({...data,wrapupPending:false}).pending,false);
  assert.equal(wrapupSeconds(wrapupClock({},now),now),30);
});

test('wrap-up API exposes the pending Core segment and rejects a completed context',async()=>{
  let pending={id:'segment',queue_id:'q',queue_name:'Q',wrapup_deadline_at:'2026-09-06T10:02:00Z'};
  let requested;
  const pool={query:async()=>({rows:[]})};
  const route=await loadRoute('app/api/contact-center/interactions/[id]/wrapup-codes/route.js',{
    '@/lib/auth-server':{getAuthenticatedUser:async()=>({id:'agent',username:'agent'})},
    '@/lib/postgres.mjs':{getPostgresPool:()=>pool},
    '@/lib/acd/media-device-control.mjs':{mediaDevicePresentation:async(db,user,request,options)=>{
      assert.equal(db,pool);assert.equal(user.id,'agent');
      assert.deepEqual(options,{workItemId:'work',segmentId:'segment',wrapup:true});
      return {canControl:false,canTakeOver:true,label:'iPhone',version:'2'};
    }},
    '@/lib/acd/work-item-repository.mjs':{findInteractionViewByReference:async()=>({id:'work'})},
    '@/lib/acd/wrapup-context.mjs':{findPendingAcdWrapupSegment:async(_pool,input)=>{requested=input;return pending;}},
    '@/lib/runtime-logging.mjs':{contactCenterRuntimeLogger:{error:()=>{}},runtimePayload:value=>value},
  });
  const request={url:'https://test.local/api/contact-center/interactions/i/wrapup-codes?segmentId=segment'};
  const first=await route.GET(request, {params:{id:'i'}});
  assert.equal(first.status,200);
  assert.equal(first.body.wrapupPending,true);
  assert.equal(first.body.wrapupDeadlineAt,pending.wrapup_deadline_at);
  assert.equal(first.body.segmentId,'segment');
  assert.deepEqual(first.body.deviceControl,{canControl:false,canTakeOver:true,label:'iPhone',version:'2'});
  assert.deepEqual(requested,{workItemId:'work',agentId:'agent',segmentId:'segment'});
  pending=null;
  const done=await route.GET(request, {params:{id:'i'}});
  assert.equal(done.status,403);
  assert.equal(done.body.error,'No pending wrap-up belongs to this agent');
});
