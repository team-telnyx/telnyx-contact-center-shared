import {test,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepareAcdTestPool} from './helpers/acd-test-db.mjs';
import {VoiceFlowDb} from '../lib/pgdb-voice-flows.js';
const pool=await prepareAcdTestPool('acd_core_test_flow_execution_persistence');
const cached=global.__pg_pool,previous=cached.pool;cached.pool=pool;
after(async()=>{cached.pool=previous;await pool.end();});
await pool.query(`DROP TABLE IF EXISTS voice_flow_executions;
 CREATE TABLE voice_flow_executions(id TEXT PRIMARY KEY,flow_id TEXT NOT NULL,call_control_id TEXT NOT NULL,current_node_id TEXT,
 variables JSONB DEFAULT '{}',execution_history JSONB DEFAULT '[]',status TEXT DEFAULT 'active',started_at TIMESTAMPTZ DEFAULT now(),completed_at TIMESTAMPTZ)`);
beforeEach(()=>pool.query('TRUNCATE voice_flow_executions'));

test('concurrent Flow webhook transitions reuse one execution and preserve variables',async()=>{
 const flow=randomUUID(),call=randomUUID();
 const entries=await Promise.all(Array.from({length:8},()=>VoiceFlowDb.createFlowExecution(flow,call,'gather',{seed:true})));
 assert.equal(new Set(entries.map(e=>e.id)).size,1);
 await VoiceFlowDb.updateFlowExecution(call,{variables:{digit:'7'},current_node_id:'success'});
 const again=await VoiceFlowDb.createFlowExecution(flow,call,'outbound',{});
 assert.equal(again.id,entries[0].id);assert.deepEqual(again.variables,{digit:'7'});assert.equal(again.current_node_id,'success');
 assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM voice_flow_executions')).rows[0].n,1);
});

test('different flows and calls retain independent execution records',async()=>{
 const flow=randomUUID(),otherFlow=randomUUID(),call=randomUUID();
 const entries=await Promise.all([VoiceFlowDb.createFlowExecution(flow,call),VoiceFlowDb.createFlowExecution(otherFlow,call),VoiceFlowDb.createFlowExecution(flow,randomUUID())]);
 assert.equal(new Set(entries.map(e=>e.id)).size,3);
});

test('hangup finalizes once and late transitions cannot reopen or overwrite execution',async()=>{
 const flow=randomUUID(),call=randomUUID(),otherFlow=randomUUID();
 const original=await VoiceFlowDb.createFlowExecution(flow,call,'success',{digit:'7'});
 await VoiceFlowDb.createFlowExecution(otherFlow,call);
 const endedAt='2026-09-12T08:07:53.532Z';
 await VoiceFlowDb.completeFlowExecution(flow,call,endedAt);
 await VoiceFlowDb.updateFlowExecution(call,{status:'active',variables:{digit:'0'}});
 const existing=await VoiceFlowDb.createFlowExecution(flow,call,'gather',{});
 assert.equal(existing.id,original.id);assert.equal(existing.status,'completed');assert.deepEqual(existing.variables,{digit:'7'});
 assert.equal(existing.completed_at.toISOString(),endedAt);
 await VoiceFlowDb.completeFlowExecution(flow,call,'2026-09-12T09:00:00.000Z');
 const rows=(await pool.query('SELECT * FROM voice_flow_executions ORDER BY flow_id')).rows;
 assert.equal(rows.find(r=>r.flow_id===flow).completed_at.toISOString(),endedAt);
 assert.equal(rows.find(r=>r.flow_id===otherFlow).status,'active','ending one flow must not close another flow');
});

test('creation retries concurrent with hangup leave the existing execution terminal',async()=>{
 const flow=randomUUID(),call=randomUUID();await VoiceFlowDb.createFlowExecution(flow,call);
 await Promise.all([...Array.from({length:6},()=>VoiceFlowDb.createFlowExecution(flow,call)),VoiceFlowDb.completeFlowExecution(flow,call)]);
 const rows=(await pool.query('SELECT * FROM voice_flow_executions')).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].status,'completed');assert.ok(rows[0].completed_at);
});

test('hangup without an execution creates no history; absent event time still closes an existing execution',async()=>{
 const flow=randomUUID(),call=randomUUID();
 assert.equal(await VoiceFlowDb.completeFlowExecution(flow,call,null),null);
 assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM voice_flow_executions')).rows[0].n,0);
 await VoiceFlowDb.createFlowExecution(flow,call);
 const ended=await VoiceFlowDb.completeFlowExecution(flow,call,null);
 assert.equal(ended.status,'completed');assert.ok(ended.completed_at instanceof Date);
});
