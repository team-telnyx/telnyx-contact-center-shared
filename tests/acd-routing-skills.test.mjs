import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeSkills, requiredSkillsFor, skillRequirements } from '../lib/acd/skills.mjs';
import { skillsPolicy, fifoPolicy, priorityPolicy } from '../lib/acd/policies/index.mjs';
import { prepareAcdTestPool, seedAgent, seedQueue, makeTxRunner, makeFakeProvider } from './helpers/acd-test-db.mjs';
import { createWorkItem, applyTransition } from '../lib/acd/lifecycle.mjs';
import { routeOne } from '../lib/acd/router.mjs';
import { routeAcdVoiceEvent } from '../lib/acd/live-intake.mjs';
import { drainQueuedOnce } from '../lib/acd/worker.mjs';

const catalog = [{ id: 'language-id', name: 'E2E Language', is_active: true }, { id: 'product-id', name: 'E2E Product', is_active: true }];
const t0 = Date.parse('2026-09-05T10:00:00Z');
const queue = { skill_relaxation_enabled: true, skill_relaxation_strategy: 'progressive', skill_relaxation_after_seconds: 10 };
const work = { required_skills: { 'language-id': 4, 'product-id': 2 }, enqueued_at: new Date(t0).toISOString() };
for (const [elapsed, levels] of [[9999,[4,2]],[10000,[4,2]],[39999,[4,2]],[40000,[3,1]],[70000,[2,1]],[100000,[1,1]],[1000000,[1,1]]]) {
  test(`R-01/R-02 progressive boundary ${elapsed}ms, no cumulative mutation`, () => {
    const before = structuredClone(work);
    for (let i=0;i<3;i++) assert.deepEqual(Object.values(skillRequirements(work,{queue,catalog,now:t0+elapsed}).effective),levels);
    assert.deepEqual(work,before);
  });
}
test('R-03 fallback preserves levels 1–3 and clamps only higher requirements', () => {
  const q={...queue,skill_relaxation_strategy:'fallback'};
  for(let level=1;level<=5;level++) {
    const w={...work,required_skills:{'language-id':level}};
    assert.equal(skillRequirements(w,{queue:q,catalog,now:t0+9999}).effective['language-id'],level);
    assert.equal(skillRequirements(w,{queue:q,catalog,now:t0+10000}).effective['language-id'],Math.min(3,level));
  }
});
test('S-03 and R-04 disabled relaxation, per-work clocks and missing enqueue time', () => {
  assert.deepEqual(skillRequirements(work,{queue:{...queue,skill_relaxation_enabled:false},catalog,now:t0+1e6}).effective,work.required_skills);
  assert.equal(skillRequirements({...work,enqueued_at:new Date(t0+30000)},{queue,catalog,now:t0+40000}).effective['language-id'],4);
  assert.equal(skillRequirements({...work,enqueued_at:null},{queue,catalog,now:t0+1e6}).effective['language-id'],4);
});
test('S-04 names and IDs normalize identically; aliases cannot weaken requirements', () => {
  assert.deepEqual(normalizeSkills({'E2E Language':4,'language-id':2},catalog,{requirements:true}).skills,{'language-id':4});
  assert.deepEqual(normalizeSkills({'E2E Language':4,'language-id':2},catalog).skills,{'language-id':2});
  assert.equal(requiredSkillsFor({}, {'language-id':4}).source,'queue');
  assert.equal(requiredSkillsFor({'language-id':3}, {'language-id':4}).source,'flow');
  assert.equal(requiredSkillsFor({},{}).source,'none');
});
test('S-03/S-04 malformed, unknown, inactive or missing skills never turn into a full match', () => {
  const candidates=[{agent_id:'a',skills:{'language-id':5,'product-id':5},live_weight:0}];
  for(const required of [{'unknown':1},{'language-id':0},{'language-id':true},{'language-id':['4']},['language-id'],'broken']) {
    assert.equal(skillsPolicy.rank(candidates,{...work,required_skills:required},{queue,catalog,now:t0+1e6}).length,0);
  }
  assert.equal(skillsPolicy.rank(candidates,work,{catalog:catalog.map(s=>({...s,is_active:false}))}).length,0);
  assert.equal(skillsPolicy.rank(candidates,work,{catalog:catalog.map(s=>({...s,is_active:null}))}).length,0);
  assert.equal(skillsPolicy.rank([{...candidates[0],skills:{'language-id':5}}],work,{queue,catalog,now:t0+1e6}).length,0);
});
test('S-01/S-02 full match, score, LAA; P-01 agent priority is separate from work priority', () => {
  const a={agent_id:'a',skills:{'language-id':5,'product-id':4},last_released_at:'2026-01-01',live_weight:0,queue_priority:1};
  const b={agent_id:'b',skills:{'language-id':3,'product-id':5},last_released_at:'2025-01-01',live_weight:0,queue_priority:5};
  assert.deepEqual(skillsPolicy.rank([b,a],{required_skills:{'language-id':4,'product-id':4}},{catalog}).map(c=>c.agent_id),['a']);
  assert.deepEqual(skillsPolicy.rank([b,a],{required_skills:{'language-id':3}},{catalog}).map(c=>c.agent_id),['a','b']);
  assert.equal(skillsPolicy.rank([a,{...b,skills:a.skills}],work,{catalog})[0].agent_id,'b');
  assert.equal(fifoPolicy.rank([a,b])[0].agent_id,'b');
  assert.equal(priorityPolicy.rank([a,b])[0].agent_id,'b');
  assert.equal(priorityPolicy.rank([a,{...b,queue_priority:1}])[0].agent_id,'b');
  assert.equal(fifoPolicy.rank([{...a,last_released_at:null},{...b,last_released_at:null}])[0].agent_id,'a');
});

const pool=await prepareAcdTestPool('acd_core_test_routing_skills');
after(()=>pool?.end());
const skip=!pool,tx=makeTxRunner(pool);
if(pool)for(const s of catalog)await pool.query('INSERT INTO skills(id,name,is_active) VALUES($1,$2,true)',[s.id,s.name]);
async function setup({skillsA={'language-id':3},skillsB={},relax=false,strategy='progressive',age=0,requirements={'language-id':4},agentState={}}={}) {
  const q=randomUUID(),a=randomUUID(),b=randomUUID();
  await seedAgent(pool,a,{skills:skillsA,...agentState});await seedAgent(pool,b,{skills:skillsB});
  await seedQueue(pool,q,[a,b],{strategy:'Skill-based',engineOwner:'acd_core'});
  await pool.query('UPDATE cc_queues SET skill_relaxation_enabled=$2,skill_relaxation_after_seconds=10,skill_relaxation_strategy=$3 WHERE id=$1',[q,relax,strategy]);
  const w=await tx(async db=>{
    const w=await createWorkItem(db,{channel:'voice',direction:'inbound',queueId:q,requiredSkills:requirements,actor:'test'});
    await applyTransition(db,{workItemId:w.id,to:'queued',eventType:'work_item_queued',actor:'test',patch:{enqueuedAt:new Date(Date.now()-age)}});
    return w;
  });
  return {q,a,b,w};
}
test('S-03 PostgreSQL repeated evaluation makes no offer/reservation and deduplicates evidence', {skip}, async()=>{
  const {w}=await setup();
  for(let i=0;i<3;i++)assert.equal((await routeOne(pool,w.id)).reason,'no_skill_match');
  assert.equal((await pool.query('SELECT * FROM acd_offers WHERE work_item_id=$1',[w.id])).rowCount,0);
  assert.equal((await pool.query('SELECT * FROM acd_reservations WHERE work_item_id=$1',[w.id])).rowCount,0);
  const events=(await pool.query("SELECT payload FROM acd_events WHERE work_item_id=$1 AND type='routing_evaluated'",[w.id])).rows;
  assert.equal(events.length,1);assert.equal(events[0].payload.requirements.effective['language-id'],4);
  assert.ok(events[0].payload.skills.every(a=>a.reason==='skills_below_requirement'));
});
for(const [strategy,age,expected] of [['progressive',11000,false],['progressive',41000,true],['fallback',11000,true]]) {
  test(`R-01/R-03 PostgreSQL ${strategy} at ${age}ms routes=${expected}`,{skip},async()=>{
    const {w,a}=await setup({relax:true,strategy,age});
    const results=await Promise.all(Array.from({length:4},()=>routeOne(pool,w.id)));
    assert.equal(results.filter(r=>r.routed).length,expected?1:0);
    if(expected)assert.equal(results.find(r=>r.routed).agentId,a);
    assert.deepEqual((await pool.query('SELECT required_skills FROM acd_work_items WHERE id=$1',[w.id])).rows[0].required_skills,{'language-id':4});
  });
}
for(const agentState of [{presence:'offline'},{routability:'not_routable'},{workflowState:'handling'},{workflowState:'wrapup'},{workflowState:'offered'}]) {
  test(`R-05 relaxation respects ${JSON.stringify(agentState)}`,{skip},async()=>{
    const {w}=await setup({relax:true,age:41000,agentState});
    assert.equal((await routeOne(pool,w.id)).routed,false);
    assert.equal((await pool.query('SELECT * FROM acd_reservations WHERE work_item_id=$1',[w.id])).rowCount,0);
  });
}
test('R-05 abandoned work cannot acquire an offer after its threshold', {skip},async()=>{
  const {w}=await setup({relax:true,age:41000});
  await tx(db=>applyTransition(db,{workItemId:w.id,to:'abandoned',eventType:'work_item_abandoned',actor:'test'}));
  assert.equal((await routeOne(pool,w.id)).reason,'not_claimable');
});
test('S-04 real intake snapshots queue fallback, canonical IDs and original clock on redelivery', {skip},async()=>{
  const {q}=await setup({skillsA:{},skillsB:{}});
  await pool.query('UPDATE cc_queues SET skill_requirements=$2 WHERE id=$1',[q,JSON.stringify({'E2E Language':4})]);
  const ccid=`v3:${randomUUID()}`,session=randomUUID(),provider=makeFakeProvider();
  const event={eventType:'call.enqueued',eventId:randomUUID(),occurredAt:new Date().toISOString(),payload:{queue:q,call_control_id:ccid,call_session_id:session,from:'+15550001111',to:'+15550002222',client_state:Buffer.from(JSON.stringify({required_skills:{},call_priority:5})).toString('base64')}};
  await routeAcdVoiceEvent(pool,provider,event);
  const read=async()=>(await pool.query("SELECT * FROM acd_work_items WHERE attributes->>'call_session_id'=$1",[session])).rows[0];
  const first=await read();assert.ok(first);assert.deepEqual(first.required_skills,{'language-id':4});assert.equal(first.attributes.routing_requirements.source,'queue');assert.equal(first.priority,5);
  await pool.query("UPDATE cc_queues SET skill_requirements='{}' WHERE id=$1",[q]);
  await routeAcdVoiceEvent(pool,provider,{...event,eventId:randomUUID()});
  const second=await read();assert.deepEqual(second.enqueued_at,first.enqueued_at);assert.deepEqual(second.required_skills,first.required_skills);
  assert.equal(provider.calls.filter(c=>c.operation==='transfer_to_agent').length,0);
});
test('R-06 another Node process recomputes from PostgreSQL without resetting clock or requirements', {skip},async()=>{
  const {w,a}=await setup({relax:true,age:41000});
  const before=(await pool.query('SELECT enqueued_at,required_skills FROM acd_work_items WHERE id=$1',[w.id])).rows[0];
  const child=await promisify(execFile)(process.execPath,['tests/helpers/acd-routing-process.mjs',w.id],{env:{...process.env,POSTGRES_DB:'acd_core_test_routing_skills'}});
  assert.equal(JSON.parse(child.stdout).agentId,a);
  assert.equal((await routeOne(pool,w.id)).reason,'not_claimable');
  assert.deepEqual((await pool.query('SELECT enqueued_at,required_skills FROM acd_work_items WHERE id=$1',[w.id])).rows[0],before);
  assert.equal((await pool.query('SELECT * FROM acd_offers WHERE work_item_id=$1',[w.id])).rowCount,1);
});
for(const [name,priorities,expected] of [['F-01',[3,3,3],0],['P-03',[1,5,5],1]]) {
  test(`${name} real queued worker chooses priority then persisted FIFO enqueue time`,{skip},async()=>{
    const q=randomUUID(),a=randomUUID();await seedAgent(pool,a);await seedQueue(pool,q,[a],{engineOwner:'acd_core'});
    const ids=[];
    for(let i=0;i<3;i++)ids.push(await tx(async db=>{
      const w=await createWorkItem(db,{channel:'voice',direction:'inbound',queueId:q,priority:priorities[i],engineOwner:'acd_core',actor:'test'});
      await applyTransition(db,{workItemId:w.id,to:'queued',eventType:'work_item_queued',actor:'test',patch:{enqueuedAt:new Date(Date.now()-30000+i*1000)}});
      await db.query("INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,state,answered_at) VALUES($1,$2,'customer',$3,'answered',now())",[randomUUID(),w.id,`test-only:${randomUUID()}`]);
      return w.id;
    }));
    await drainQueuedOnce(pool,makeFakeProvider(),{limit:100});
    const offers=(await pool.query('SELECT work_item_id,agent_id FROM acd_offers WHERE work_item_id=ANY($1::uuid[])',[ids])).rows;
    assert.deepEqual(offers,[{work_item_id:ids[expected],agent_id:a}]);
    assert.equal((await pool.query("SELECT id FROM acd_work_items WHERE id=ANY($1::uuid[]) AND state='queued'",[ids])).rowCount,2);
  });
}
