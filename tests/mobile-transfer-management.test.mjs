import test from 'node:test';
import assert from 'node:assert/strict';
import { setAgentQueueActivation } from '../lib/acd/queue-membership.mjs';
import { readTransferQueues } from '../lib/acd/transfer-directory.mjs';
import { loadRoute } from './helpers/route-harness.mjs';
import { authzGuardStub, USERS } from './helpers/authz-harness.mjs';

test('transfer queues paginate before aggregating voice workload and preserve legacy response', async () => {
  const rows = Array.from({length: 61}, (_, i) => ({id: `q${i}`,name:`Queue ${i}`}));
  const calls = [];
  const db = { query: async (sql,args) => {
    calls.push({sql,args});
    if (sql.includes('FROM cc_queues')) return {rows};
    return {rows:[{queue_id:'q25',waiting:3,active:2,longest_wait:91,average_wait:35}]};
  }};
  const result = await readTransferQueues(db,new URLSearchParams('mobilePageSize=25&page=2'),{restricted:true,queueIds:rows.map(q=>q.id)});
  assert.equal(result.queues.length,25); assert.equal(result.pagination.total,61);
  assert.equal(result.queues[0].id,'q25');
  assert.deepEqual(result.queues[0].statistics,{waiting:3,active:2,longestWait:91,averageWait:35});
  assert.deepEqual(result.queues[1].statistics,{waiting:0,active:0,longestWait:0,averageWait:0});
  assert.match(calls[0].sql,/q.id = ANY/); assert.deepEqual(calls[0].args,[rows.map(q=>q.id)]);
  assert.deepEqual(calls[1].args,[result.queues.map(q=>q.id)]);
  assert.match(calls[1].sql,/w.channel='voice'/); assert.match(calls[1].sql,/w.terminal_at IS NULL/);
  calls.length=0;
  const legacy=await readTransferQueues(db,new URLSearchParams(),null);
  assert.deepEqual(legacy,{queues:rows}); assert.equal(calls.length,1);
  calls.length=0;
  const empty=await readTransferQueues(db,new URLSearchParams('mobilePageSize=25&search=missing'),null);
  assert.equal(empty.queues.length,0); assert.equal(calls.length,1);
});

test('queue directory uses the authenticated guard without requiring a browser cookie session', async () => {
  let reads=0;
  const deps={
    '@/lib/postgres.mjs':{getPostgresPool:()=>({})},
    '@/lib/acd/transfer-directory.mjs':{readTransferQueues:async()=>{reads++; return {queues:[]};}},
  };
  for(const [user,status] of [[null,401],[USERS.agent,200]]) {
    const route=await loadRoute('app/api/contact-center/queues/list/route.js',{
      ...deps,'@/lib/authz/guard':authzGuardStub({user}),
      'next-auth':{getServerSession:()=>{throw Error('Mobile must not require cookies');}},
    });
    assert.equal((await route.GET(new Request('https://cc.test/api/contact-center/queues/list?mobilePageSize=25'))).status,status);
  }
  assert.equal(reads,1);
});

test('mobile memberships show assigned active and inactive queues, with paging and scope', async () => {
  const queues=[{id:'active',is_assigned:true,is_activated:true},{id:'inactive',enabled:false,is_assigned:false,is_activated:false},
    {id:'hidden',is_assigned:true,is_activated:true}];
  const route=await loadRoute('app/api/contact-center/agent/queues/list/route.js',{
    '@/lib/authz/guard':{withPermission:(permission,handler)=>{assert.equal(permission,'agents:read');return request=>handler(request,{},
      {scope:{restricted:true,queueIds:['active','inactive','removed'],agentIds:['agent']}});}},
    '@/lib/postgres.mjs':{getPostgresPool:()=>({query:async()=>({rows:queues})})},
  });
  const response=await route.GET(new Request('https://cc.test/?userId=agent&mobilePageSize=25'));
  assert.deepEqual(response.body.queues.map(q=>[q.id,q.isActivated]),[['active',true],['inactive',false]]);
  assert.equal(response.body.pagination.total,2);
  assert.equal((await route.GET(new Request('https://cc.test/?userId=outside&mobilePageSize=25'))).status,404);
});

test('capacity writes remain permission protected and scoped to the selected agent', async () => {
  let writes=0;
  const deps={
    '@/lib/postgres.mjs':{getPostgresPool:()=>({})},
    '@/lib/acd/utilization.mjs':{saveUtilization:async(_,body)=>{writes++;return body;},readUtilization:async()=>({})},
  };
  for(const [user,status] of [[null,401],[USERS.agent,403],[USERS.admin,200]]) {
    const route=await loadRoute('app/api/admin/utilization/[scope]/[id]/route.js',{
      ...deps,'@/lib/authz/guard':authzGuardStub({user}),
    });
    const result=await route.PUT(new Request('https://cc.test/',{method:'PUT',body:JSON.stringify({policies:[],expectedRevision:'r1'})}),
      {params:Promise.resolve({scope:'agent',id:'a'})});
    assert.equal(result.status,status);
    if(status===200){assert.equal(result.body.actor,user.id);assert.equal(result.body.expectedRevision,'r1');}
  }
  assert.equal(writes,1);
});

for (const action of ['activate','deactivate']) test(`${action} checks queue and agent scope before changing memberships`, async () => {
  let writes=0;
  const route=await loadRoute(`app/api/contact-center/agent/queues/${action}/route.js`,{
    '@/lib/authz/guard':{withPermission:(_,handler)=>request=>handler(request,{},
      {user:{id:'supervisor'},elevated:true,scope:{restricted:true,agentIds:['agent'],queueIds:['visible']}})},
    '@/lib/postgres.mjs':{getPostgresPool:()=>({})},
    '@/lib/acd/queue-membership.mjs':{setAgentQueueActivation:async()=>{writes++; return [];}},
    '@/lib/sse':{broadcastToAllAgents:async()=>{}},
    '@/lib/contact-center/logging.mjs':{queuesLogger:{info:()=>{},error:()=>{}},contactCenterErrorPayload:()=>({})},
  });
  for(const [userId,queueId,status] of [['agent','hidden',403],['outside','visible',403],['agent','visible',200]]){
    const result=await route.POST(new Request('https://cc.test/',{method:'POST',body:JSON.stringify({userId,queueIds:[queueId]})}));
    assert.equal(result.status,status);
  }
  assert.equal(writes,1);
});

test('supervisory participation changes reject unassigned destinations atomically', async () => {
  const writes=[];
  const tx={query:async(sql,args)=>{
    writes.push(sql);
    if(sql.includes('SELECT id, name'))return {rows:[{id:'new-queue'}]};
    if(sql.includes('SELECT enabled, priority'))return {rows:[]};
    return {rows:[]};
  },release:()=>{}};
  await assert.rejects(setAgentQueueActivation({connect:async()=>tx},
    {agentId:'agent',queueIds:['new-queue'],enabled:true,requireAssigned:true}),{status:409});
  assert.ok(writes.includes('ROLLBACK'));
  assert.ok(!writes.some(sql=>sql.includes('INSERT INTO cc_queue_user_assignments')));
});

test('membership read identifies disabled existing records as assigned, not missing', async () => {
  const route=await loadRoute('app/api/contact-center/agent/queues/list/route.js',{
    '@/lib/authz/guard':authzGuardStub({user:USERS.admin}),
    '@/lib/postgres.mjs':{getPostgresPool:()=>({query:async(sql)=>{
      assert.match(sql,/qa.enabled as is_assigned/);
      return {rows:[{id:'inactive',is_assigned:false,is_activated:false}]};
    }})},
  });
  const response=await route.GET(new Request('https://cc.test/?userId=agent&mobilePageSize=25'));
  assert.equal(response.body.queues.length,1);
  assert.equal(response.body.queues[0].isActivated,false);
  assert.equal(response.body.queues[0].isAssigned,true);
  const legacy=await route.GET(new Request('https://cc.test/?userId=agent'));
  assert.equal(legacy.body.queues[0].isAssigned,false);
});
