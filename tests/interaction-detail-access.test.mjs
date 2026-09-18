import test from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute} from './helpers/route-harness.mjs';

async function fixture(user,row){
  let hydrated=0;
  const pool={query:async()=>({rows:[]})};
  const route=await loadRoute('app/api/contact-center/interactions/[id]/route.js',{
    '@/lib/auth-server':{getAuthenticatedUser:async()=>user},
    '@/lib/role-utils':{isSupervisorOrAdmin:u=>u.roles?.some(r=>['supervisor','admin','owner'].includes(r))},
    '@/lib/postgres.mjs':{getPostgresPool:()=>pool},
    '@/lib/acd/work-item-repository.mjs':{
      findInteractionViewByReference:async()=>row,
      loadAcdHistoryDto:async()=>({version:'acd-history.v1'}),
    },
    '@/lib/acd/history-projection.mjs':{
      loadAcdTimelineProjection:async()=>{hydrated++;return {timeline:[]};},
      loadAcdInteractionSegments:async()=>[],
    },
    '@/lib/runtime-logging.mjs':{contactCenterRuntimeLogger:{error:()=>{}},runtimePayload:value=>value},
  });
  return {read:()=>route.GET(new Request('https://cc.example.test/api/contact-center/interactions/own'),{params:{id:'own'}}),hydrated:()=>hydrated};
}
const row={id:'own',work_item_id:'own',agent_id:'agent-a-id',agent_username:'agent-a',metadata:{agent_assist_config:{enabled:true}}};
test('an ordinary assigned agent can load the Core metadata required by its softphone',async()=>{
  const f=await fixture({id:'agent-a-id',username:'agent-a',roles:['agent']},row),r=await f.read();
  assert.equal(r.status,200);assert.equal(r.body.interaction.metadata.agent_assist_config.enabled,true);assert.equal(r.body.interaction.id,'own');
});
test('another agent, missing identity, and an unassigned interaction cannot expose details',async()=>{
  for(const [user,record] of [[{id:'agent-b-id',username:'agent-b',roles:['agent']},row],[{roles:['agent']},row],[{id:'agent-a-id',username:'agent-a',roles:['agent']},{...row,agent_id:null,agent_username:null}]]){
    const f=await fixture(user,record);assert.equal((await f.read()).status,403);assert.equal(f.hydrated(),0);
  }
});
test('supervisor access and authentication/not-found behavior remain intact',async()=>{
  for(const role of ['supervisor','admin','owner'])assert.equal((await (await fixture({id:'other-id',username:'other',roles:[role]},row)).read()).status,200);
  assert.equal((await (await fixture(null,row)).read()).status,401);
  assert.equal((await (await fixture({id:'agent-a-id',username:'agent-a',roles:['agent']},null)).read()).status,404);
});
