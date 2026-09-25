import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { loadRoute } from './helpers/route-harness.mjs';
import { authzGuardStub, USERS } from './helpers/authz-harness.mjs';

async function passwordRoute(user = USERS.agent) {
  const writes = [];
  const lookups = [];
  const route = await loadRoute('app/api/auth/update-password/route.js', {
    '@/lib/authz/guard': authzGuardStub({user}),
    '@/lib/pgdb': {PgDb:{findUserById:async id=>{lookups.push(id);return {id,hash:'existing',salt:'existing'};},
      updateUserById:async (id,values)=>writes.push({id,values})}},
    '@/lib/auth': {verifyUserPassword:(_user,password)=>password==='current-test-password'},
    '@/lib/auth-logging.mjs': {logAuthEvent(){},authUserPayload:()=>({}),authErrorPayload:()=>({})},
    crypto,
  });
  return {route,writes,lookups};
}
const request = fields => new Request('https://cc.test/api/auth/update-password', {
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fields),
});
test('mobile password change stays scoped to authenticated user and verifies current password',async()=>{
  const {route,writes,lookups}=await passwordRoute();
  const denied=await route.POST(request({currentPassword:'incorrect',newPassword:'Valid-New-Password!',userId:'another-user'}));
  assert.equal(denied.status,400);assert.equal(writes.length,0);
  const accepted=await route.POST(request({currentPassword:'current-test-password',newPassword:'Valid-New-Password!',userId:'another-user'}));
  assert.equal(accepted.status,200);assert.equal(writes[0].id,USERS.agent.id);
  assert.ok(lookups.every(id=>id===USERS.agent.id));
  assert.notEqual(writes[0].values.hash,'Valid-New-Password!');
});
test('password update rejects unauthenticated, malformed and weak requests',async()=>{
  const unauth=await passwordRoute(null);
  assert.equal((await unauth.route.POST(request({newPassword:'Valid-New-Password!'}))).status,401);
  assert.equal(unauth.lookups.length,0);
  const {route,writes}=await passwordRoute();
  for(const newPassword of [null,{},'weak']) {
    assert.equal((await route.POST(request({currentPassword:'current-test-password',newPassword}))).status,400);
  }
  assert.equal(writes.length,0);
});
test('profile skills resolve only the current agents assignments without admin access',async()=>{
  const queries=[];
  const route=await loadRoute('app/api/user/skills/route.js',{
    '@/lib/authz/guard':authzGuardStub({user:USERS.agent}),
    '@/lib/postgres.mjs':{getPostgresPool:()=>({query:async(sql,args)=>{
      queries.push(args);
      return {rows:sql.includes('FROM users')?[{skills:{'skill-1':4}}]:[{id:'skill-1',name:'Support',category:'Service'}]};
    }})},
    '@/lib/runtime-logging.mjs':{platformApiLogger:{error(){}},runtimePayload:()=>({})},
  });
  const response=await route.GET(new Request('https://cc.test/api/user/skills?userId=someone-else'));
  assert.equal(response.status,200);assert.equal(response.body.items[0].level,4);
  assert.deepEqual(queries,[[USERS.agent.id],[['skill-1']]]);
});
