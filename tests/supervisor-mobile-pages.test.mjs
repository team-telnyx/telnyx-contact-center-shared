import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool, seedAgent, seedQueue } from './helpers/acd-test-db.mjs';
import { readMobileInteractionDirectory } from '../lib/acd/mobile-interaction-directory.mjs';
import { readMobileDialerPage } from '../lib/outbound-dialer/mobile-pages.mjs';
import { readMonitorStatistics } from '../lib/acd/monitor-statistics.mjs';
import { UNRESTRICTED, mergeScopes } from '../lib/authz/scope.mjs';
const pool=await prepareAcdTestPool('acd_core_test_supervisor_mobile_pages');
after(()=>pool.end());
await seedAgent(pool,'mobile-reader');
await seedQueue(pool,'queue-a',['mobile-reader']);
await seedQueue(pool,'queue-b',[]);
await pool.query(`DROP TABLE IF EXISTS outbound_attempt_ledger,outbound_contact_records,outbound_campaigns,outbound_contact_lists CASCADE;
CREATE TABLE outbound_campaigns(id uuid PRIMARY KEY,name text,status text,channel text,mode text,metadata jsonb DEFAULT '{}',contact_list_id uuid);
CREATE TABLE outbound_contact_lists(id uuid PRIMARY KEY,record_count int,valid_phone_count int);
CREATE TABLE outbound_contact_records(id uuid PRIMARY KEY,row_data jsonb,contact_methods jsonb);
CREATE TABLE outbound_attempt_ledger(id uuid PRIMARY KEY,campaign_id uuid,contact_record_id uuid,status text,metadata jsonb DEFAULT '{}',call_control_id text,call_session_id text,lease_expires_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),failure_reason text,message_state text,sender_address text,attempt_reason text);`);
const first=randomUUID(),other=randomUUID();
await pool.query(`INSERT INTO outbound_campaigns(id,name,status,channel,mode) VALUES($1,'Alpha','running','voice','power'),($2,'Other','paused','voice','power')`,[first,other]);
for(let i=0;i<31;i++)await pool.query(`INSERT INTO acd_work_items(id,channel,direction,state,queue_id,customer_address) VALUES($1,'sms','inbound','active','queue-a',$2)`,[randomUUID(),'Customer '+i]);
await pool.query(`INSERT INTO acd_work_items(id,channel,direction,state,queue_id,customer_address,terminal_at) VALUES($1,'voice','outbound','completed','queue-b','Other customer',now())`,[randomUUID()]);
for(let i=0;i<30;i++)await pool.query(`INSERT INTO outbound_attempt_ledger(id,campaign_id,status,call_control_id,created_at) VALUES($1,$2,'answered',$3,now()-interval '2 minutes')`,[randomUUID(),i===29?other:first,'call-'+i]);

test('directory uses bounded disjoint pages and filters direction/channel/queue in SQL',async()=>{
 const a=await readMobileInteractionDirectory(pool,new URLSearchParams('period=today'),UNRESTRICTED);
 const b=await readMobileInteractionDirectory(pool,new URLSearchParams('period=today&page=2'),UNRESTRICTED);
 assert.equal(a.pagination.total,31);assert.equal(a.rows.length,25);assert.equal(b.rows.length,6);
 assert.equal(new Set([...a.rows,...b.rows].map(r=>r.id)).size,31);
 const filtered=await readMobileInteractionDirectory(pool,new URLSearchParams('channel=voice&direction=outbound&queue=queue-b'),UNRESTRICTED);
 assert.equal(filtered.rows.length,0);
 const scope={...UNRESTRICTED,restricted:true,queueIds:['queue-a'],selfId:'mobile-reader',agentIds:['mobile-reader']};
 const limited=await readMobileInteractionDirectory(pool,new URLSearchParams('direction=outbound'),scope);
 assert.equal(limited.pagination.total,0);
 await assert.rejects(()=>readMobileInteractionDirectory(pool,new URLSearchParams('direction=wrong'),UNRESTRICTED),/Invalid direction/);
});
test('dialer campaign page shares controls and summaries; denied scope returns no data',async()=>{
 const data=await readMobileDialerPage(pool,new URLSearchParams(),UNRESTRICTED);
 assert.equal(data.pagination.total,2);assert.equal(data.totals.running,1);
 const alpha=data.rows.find(r=>r.id===first);assert.equal(alpha.controls.canPause,true);assert.equal(alpha.summary.active_now,29);
 const denied=await readMobileDialerPage(pool,new URLSearchParams(),{...UNRESTRICTED,restricted:true,campaignIds:[]});
 assert.equal(denied.rows.length,0);assert.equal(denied.totals.campaigns,0);
});
test('live calls apply campaign scope before count and pagination',async()=>{
 const scope={...UNRESTRICTED,restricted:true,campaignIds:[first]};
 const a=await readMobileDialerPage(pool,new URLSearchParams('view=live'),scope);
 const b=await readMobileDialerPage(pool,new URLSearchParams('view=live&page=2'),scope);
 assert.equal(a.pagination.total,29);assert.equal(a.rows.length,25);assert.equal(b.rows.length,4);
 assert.ok([...a.rows,...b.rows].every(r=>r.campaign_id===first));
 assert.equal(new Set([...a.rows,...b.rows].map(r=>r.id)).size,29);
});
test('monitor snapshot never submits overlapping queries to its transaction client',async()=>{
 const client=await pool.connect();let busy=false;
 const strict={async query(...args){assert.equal(busy,false,'query submitted while client is busy');busy=true;try{return await client.query(...args)}finally{busy=false}}};
 try{await strict.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await readMonitorStatistics(strict);assert.ok(result.queues.length>=2);await strict.query('COMMIT');}
 finally{await client.query('ROLLBACK');client.release()}
});

test('active directory excludes terminal records but includes older active interactions',async()=>{
 const id=randomUUID();
 await pool.query(`INSERT INTO acd_work_items(id,channel,direction,state,queue_id,customer_address,created_at)
   VALUES($1,'voice','outbound','active','queue-b','Older active',now()-interval '40 days')`,[id]);
 try {
  const result=await readMobileInteractionDirectory(pool,new URLSearchParams('activeOnly=true&channel=voice&direction=outbound'),UNRESTRICTED);
  assert.equal(result.pagination.total,1);assert.equal(result.rows[0].id,id);
  assert.equal(result.rows[0].terminal_at,null);
  const scoped=await readMobileInteractionDirectory(pool,new URLSearchParams('activeOnly=true&channel=voice'),{...UNRESTRICTED,restricted:true,queueIds:['queue-a'],agentIds:[],selfId:'mobile-reader'});
  assert.equal(scoped.pagination.total,0);
 } finally {await pool.query('DELETE FROM acd_work_items WHERE id=$1',[id]);}
});
test('dashboard totals cover all scoped campaigns without returning a campaign list',async()=>{
 const ids=Array.from({length:28},()=>randomUUID());
 await pool.query(`INSERT INTO outbound_campaigns(id,name,status,channel,mode,metadata)
   SELECT id,'Extra','ready','voice','power','{"total_records":10}'::jsonb FROM unnest($1::uuid[]) id`,[ids]);
 try {
  const result=await readMobileDialerPage(pool,new URLSearchParams('view=dashboard'),UNRESTRICTED);
  assert.equal(result.rows.length,0);assert.equal(result.totals.campaigns,30);
  assert.equal(Number(result.totals.contacts),280);assert.equal(Number(result.totals.active_calls),30);
  assert.equal(Number(result.totals.attempts_last_15m),30);
  const limited=await readMobileDialerPage(pool,new URLSearchParams('view=dashboard'),{...UNRESTRICTED,restricted:true,campaignIds:[first]});
  assert.equal(limited.totals.campaigns,1);assert.equal(Number(limited.totals.active_calls),29);
  const denied=await readMobileDialerPage(pool,new URLSearchParams('view=dashboard'),{...UNRESTRICTED,restricted:true,campaignIds:[]});
  assert.equal(denied.totals.campaigns,0);assert.equal(Number(denied.totals.active_calls),0);
 } finally {await pool.query('DELETE FROM outbound_campaigns WHERE id=ANY($1::uuid[])',[ids]);}
});

test('dialer enforces channel scope before rows, counts and dashboard aggregation',async()=>{
 const sms=randomUUID();
 await pool.query(`INSERT INTO outbound_campaigns(id,name,status,channel,mode,metadata)
   VALUES($1,'SMS campaign','running','sms','power','{"total_records":17}')`,[sms]);
 try {
  const scope={...UNRESTRICTED,restricted:true,channels:['sms']};
  const campaigns=await readMobileDialerPage(pool,new URLSearchParams(),scope);
  assert.equal(campaigns.pagination.total,1);assert.deepEqual(campaigns.rows.map(r=>r.id),[sms]);
  const dashboard=await readMobileDialerPage(pool,new URLSearchParams('view=dashboard'),scope);
  assert.equal(dashboard.totals.campaigns,1);assert.equal(Number(dashboard.totals.contacts),17);
  assert.equal(Number(dashboard.totals.active_calls),0);assert.equal(Number(dashboard.totals.attempts_last_15m),0);
  const live=await readMobileDialerPage(pool,new URLSearchParams('view=live'),scope);
  assert.equal(live.pagination.total,0);assert.equal(live.rows.length,0);
  for(const view of ['campaigns','dashboard','live']) {
   const denied=await readMobileDialerPage(pool,new URLSearchParams({view}),{...scope,channels:[]});
   assert.equal(denied.rows.length,0);assert.equal(denied.pagination.total,0);
   if(view==='dashboard')assert.equal(denied.totals.campaigns,0);
  }
 } finally {await pool.query('DELETE FROM outbound_campaigns WHERE id=$1',[sms]);}
});

test('dialer preserves campaign/channel pairings across role grants in every view', async () => {
 const voice = {...UNRESTRICTED, restricted:true, campaignIds:[first], channels:['voice']};
 // Other is a voice campaign; granting only SMS on it must not reveal it.
 const sms = {...UNRESTRICTED, restricted:true, campaignIds:[other], channels:['sms']};
 const scope = mergeScopes(voice, sms);
 const campaigns = await readMobileDialerPage(pool, new URLSearchParams(), scope);
 assert.equal(campaigns.pagination.total, 1);
 assert.deepEqual(campaigns.rows.map(r => r.id), [first]);
 const dashboard = await readMobileDialerPage(pool, new URLSearchParams('view=dashboard'), scope);
 assert.equal(dashboard.totals.campaigns, 1);
 assert.equal(Number(dashboard.totals.active_calls), 29);
 const live = await readMobileDialerPage(pool, new URLSearchParams('view=live'), scope);
 assert.equal(live.pagination.total, 29);
 assert.ok(live.rows.every(r => r.campaign_id === first));
 const denied = mergeScopes({...voice, channels:['sms']}, {...sms, campaignIds:[]});
 for (const view of ['campaigns', 'dashboard', 'live']) {
   const result = await readMobileDialerPage(pool, new URLSearchParams({view}), denied);
   assert.equal(result.pagination.total, 0);
   assert.equal(result.rows.length, 0);
 }
});
