import test from 'node:test';
import assert from 'node:assert/strict';
import { pageRows, mobileSnapshot, mobileInteractions, mobileDirectory, mobileThread, mobileReport, mobileInbox } from '../lib/acd/mobile-monitor-pages.mjs';
const query = value => new URLSearchParams({mobilePageSize:'25', ...value});
const rows = Array.from({length:2503},(_,i)=>({id:`i${String(i).padStart(5,'0')}`,workItemId:`w${i}`,queueId:i%2?'sales':'support',agentUserId:`a${i%500}`,customerName:`Customer ${i}`,state:i%3?'connected':'queued',createdAt:'2026-09-23T12:00:00Z'}));
test('2503 interactions stay bounded and are reachable across all pages without duplicates',()=>{
 const seen=new Set();
 for(let page=1;page<=101;page++){
  const result=mobileInteractions({interactions:rows},query({page:String(page)}));
  assert.equal(result.pagination.total,2503);
  assert.ok(result.interactions.length<=25);
  for(const row of result.interactions){assert.ok(!seen.has(row.id));seen.add(row.id);}
 }
 assert.equal(seen.size,2503);
});
test('query limits and shrinking pages clamp, malformed parameters cannot allocate huge pages',()=>{
 for(const size of ['9999999','0','-10','NaN','Infinity','1.5']){
  const result=pageRows(rows,query({mobilePageSize:size,page:'99999999999'}));
  assert.ok(result.rows.length<=50);assert.ok(result.pagination.page<=result.pagination.total);
 }
 assert.deepEqual(pageRows([],query({page:'999'})).pagination,{page:1,pageSize:25,total:0});
});
test('search/filter happen before pagination, direct detail can find the last row',()=>{
 const source={interactions:rows};
 assert.equal(mobileInteractions(source,query({search:'Customer 2502'})).interactions[0].id,rows.at(-1).id);
 assert.equal(mobileInteractions(source,query({interactionId:rows.at(-1).id})).pagination.total,1);
 const result=mobileInteractions(source,query({queueId:'sales',waitingOnly:'true'}));
 assert.equal(result.pagination.total,rows.filter(r=>r.queueId==='sales'&&r.state==='queued').length);
 assert.ok(result.interactions.every(r=>r.queueId==='sales'&&r.state==='queued'));
});
test('only visible parent legs leave API and their own cap is disclosed',()=>{
 const legs=Array.from({length:100},(_,i)=>({id:`leg${i}`,parentInteractionId:rows.at(-1).workItemId}));
 const result=mobileInteractions({interactions:[...rows,...legs]},query({interactionId:rows.at(-1).id}));
 assert.equal(result.interactions.length,11);assert.equal(result.omittedLegs[rows.at(-1).workItemId],90);
 const first=mobileInteractions({interactions:[...rows,...legs]},query({search:'Customer 1000'}));
 assert.equal(first.interactions.length,1);
});
test('counts use the already-authorized scope, not precomputed global totals',()=>{
 const scoped={interactions:rows.slice(0,4),totals:{interactions:2503}};
 const result=mobileInteractions(scoped,query({}));assert.equal(result.totals.interactions,4);
});
test('500 agents: totals/presence remain full while pages contain 25',()=>{
 const agents=Array.from({length:500},(_,i)=>({userId:`a${i}`,firstName:`Agent ${i}`,status:i%2?'Busy':'Available',activeQueueIds:['sales']}));
 const source={overall:{agents:{total:500}},agents:{stats:agents},queues:{stats:[{queueId:'sales',queueName:'Sales'}]}};
 const result=mobileSnapshot(source,query({agentPage:'2'}));
 assert.equal(result.agents.stats.length,25);assert.equal(result.agents.pagination.total,500);
 assert.deepEqual(result.presence,{available:250,busy:250});assert.equal(result.overall.agents.total,500);
 const detail=mobileSnapshot(source,query({agentId:'a499'}));assert.equal(detail.agents.stats[0].userId,'a499');assert.equal(detail.queues.stats.length,1);
});
test('contact searches reach all source records and use independent group pages',()=>{
 const source={ok:true,users:rows.map(r=>({id:r.id,first_name:r.customerName})),customers:rows,assistants:[]};
 assert.equal(mobileDirectory(source,query({search:'Customer 2502'})).users[0].id,rows.at(-1).id);
 const result=mobileDirectory(source,query({usersPage:'2'}));assert.equal(result.users.length,25);assert.equal(result.customers.length,25);assert.notEqual(result.users[0].id,result.customers[0].id);
});
test('message pages open at latest, preserve chronology and full reply context',()=>{
 const messages=rows.map((r,i)=>({...r,sender_role:i===2500?'customer':'agent'}));
 const first=mobileThread({messages,draft:{body:'keep'}},query({}));
 assert.equal(first.messages.length,25);assert.equal(first.messages.at(-1).id,rows.at(-1).id);
 const older=mobileThread({messages,draft:{body:'keep'}},query({page:'2'}));
 assert.equal(older.latestCustomerMessageId,rows[2500].id);assert.equal(older.draft.body,'keep');
 assert.ok(older.messages.at(-1).id < first.messages[0].id);
});
test('report projections exclude unused live workload and keep totals intact',()=>{
 const source={channels:[],totals:{total:10000},trend:[],queues:rows,workload:{interactions:rows}};
 const result=mobileReport(source,query({}));assert.equal(result.queues.length,25);assert.equal(result.totals.total,10000);assert.equal(result.workload,undefined);
});
test('web requests are backward compatible and source arrays are not mutated',()=>{
 for(const project of [mobileSnapshot,mobileInteractions,mobileDirectory,mobileThread,mobileReport]){const value={};assert.equal(project(value,new URLSearchParams()),value);}
 const source={interactions:[...rows]};mobileInteractions(source,query({}));assert.deepEqual(source.interactions,rows);
});

test('agent inbox does not silently discard matches beyond the old 50-row limit',()=>{
 const result=mobileInbox(rows.map((row,i)=>({...row,from_name:`Customer ${i}`,state:i===2502?'ringing':'active'})),query({}));
 assert.equal(result.interactions.length,25);assert.equal(result.pagination.total,2503);assert.equal(result.interactions[0].id,rows.at(-1).id);
 const deep=mobileInbox(rows,query({interactionId:rows.at(-1).id}));assert.equal(deep.interactions[0].id,rows.at(-1).id);
});


test('queue workload includes Support beyond the old six-row cap and all pages remain reachable',()=>{
 const queues=Array.from({length:61},(_,i)=>({queueId:`q${i}`,queueName:`Queue ${i}`,realtime:{waitingCalls:0,activeCalls:0}}));
 queues.push({queueId:'support',queueName:'Support',realtime:{waitingCalls:0,activeCalls:1}});
 queues.push({queueId:'sales',queueName:'Sales',realtime:{waitingCalls:0,activeCalls:4}});
 const source={overall:{},agents:{stats:[]},queues:{stats:queues}};
 const first=mobileSnapshot(source,query({}));
 assert.deepEqual(first.queueWorkload.slice(0,2).map(q=>q.queueId),['sales','support']);
 assert.equal(first.queueWorkload.length,25);
 const all=[1,2,3].flatMap(page=>mobileSnapshot(source,query({queuePage:String(page)})).queueWorkload);
 assert.equal(all.length,63);assert.equal(new Set(all.map(q=>q.queueId)).size,63);
});
