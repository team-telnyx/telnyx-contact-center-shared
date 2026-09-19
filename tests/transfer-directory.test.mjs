import test from 'node:test';
import assert from 'node:assert/strict';
import {transferDirectory} from '../lib/contact-center/transfer-directory.mjs';
import {loadRoute} from './helpers/route-harness.mjs';

test('ordinary agents can select other address-book users without supervisor statistics',()=>{
  const users=[{id:'a',username:'a',telephony_user_name:'sip-a',agent_status:'Busy'},
    {id:'b',username:'b',first_name:'Agent',last_name:'B',telephony_user_name:'sip-b',agent_status:'Available',password:'must-not-copy'},
    {id:'mobile',mobile:'+12025550123'}, {id:'empty',telephony_user_name:' '}];
  const result=transferDirectory(users,'a');
  assert.deepEqual(result.map(v=>v.userId),['b','mobile']);
  assert.equal(result[0].status,'Available');assert.equal(result[0].telephonyUserName,'sip-b');
  assert.equal(result[0].password,undefined);assert.equal(result[1].status,'Unknown');
  assert.deepEqual(transferDirectory(undefined,'a'),[]);
});
test('agent statistics continue to deny access to another agent and scope unfiltered reads to self',async()=>{
  const queried=[];
  const route=await loadRoute('app/api/contact-center/stats/agents/route.js',{
    'next-auth':{getServerSession:async()=>({user:{id:'a'}})},
    '@/lib/pgdb':{PgDb:{findUserById:async()=>({id:'a',roles:['agent']})}},
    '@/lib/role-utils':{isAdmin:()=>false},
    '@/lib/acd/stats-aggregator':{getAgentStatistics:async id=>{queried.push(id);return {userId:id};}},
  });
  assert.equal((await route.GET(new Request('https://cc.example.test/api/contact-center/stats/agents?userId=b'))).status,403);
  assert.deepEqual(queried,[]);
  const own=await route.GET(new Request('https://cc.example.test/api/contact-center/stats/agents'));
  assert.deepEqual(queried,['a']);assert.equal(own.body.stats[0].userId,'a');
});
test('the shared contacts route requires authentication and returns basic directory status',async()=>{
  let authenticated=false,queries=0;
  const route=await loadRoute('app/api/user/contacts/route.js',{
    '@/lib/auth-server':{getAuthenticatedUser:async()=>authenticated?{id:'a',username:'a'}:null},
    '@/lib/postgres.mjs':{getPostgresPool:()=>({query:async sql=>{
      queries++;return {rows:sql.includes('FROM users u')?[{id:'b',username:'b',telephony_user_name:'sip-b',agent_status:'Available'}]:[]};
    }})},
    '@/lib/acd/agent-state.mjs':{effectiveAgentStatusSql:()=>"'Available'"},
  });
  assert.equal((await route.GET(new Request('https://cc.example.test/api/user/contacts'))).status,401);
  assert.equal(queries,0);authenticated=true;
  const result=await route.GET(new Request('https://cc.example.test/api/user/contacts'));
  assert.equal(result.status,200);assert.equal(result.body.users[0].agent_status,'Available');
  assert.equal(transferDirectory(result.body.users,'a')[0].userId,'b');
});
