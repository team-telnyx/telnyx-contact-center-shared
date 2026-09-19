import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool, seedQueue } from './helpers/acd-test-db.mjs';
import { syncEmailMailbox, applyEmailInboxEvent, routePendingEmail } from '../lib/email/ingest.mjs';

const pool = await prepareAcdTestPool('acd_core_test_email_deletion');
after(() => pool.end());
async function fixture() {
  const mailboxId=randomUUID(),queueId=randomUUID();
  await seedQueue(pool,queueId,[]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'email',true,5,0.2)",[queueId]);
  await pool.query(`UPDATE cc_email_mailboxes SET next_sync_at=now()+interval '1 hour',routing_enabled=false`);
  await pool.query(`INSERT INTO cc_email_mailboxes(id,provider_inbox_id,domain_id,address,name,queue_id,routing_enabled)
    VALUES($1,$2,'domain',$3,'Deletion test',$4,false)`,[mailboxId,randomUUID(),`${mailboxId}@example.com`,queueId]);
  const message={id:randomUUID(),from:'sender@example.com',to:[`${mailboxId}@example.com`],subject:'Deletion regression',text_body:'Customer message',html_body:'<p>Customer message</p>'};
  const event={event_type:'email.inbox_message',payload:{mailboxId,message}};
  const sync=async (deleted,beforePage=async()=>{})=>{
    await pool.query('UPDATE cc_email_mailboxes SET next_sync_at=now() WHERE id=$1',[mailboxId]);
    return syncEmailMailbox(pool,{request:async()=>{await beforePage();return {data:[{...message,labels:deleted?['deleted']:[]}]};},content:()=>{throw Error('No deleted content should be fetched');}});
  };
  const row=async()=>(await pool.query('SELECT * FROM cc_email_received WHERE mailbox_id=$1 AND provider_message_id=$2',[mailboxId,message.id])).rows[0];
  const enable=()=>pool.query('UPDATE cc_email_mailboxes SET routing_enabled=true WHERE id=$1',[mailboxId]);
  return {mailboxId,message,event,sync,row,enable};
}

test('deletion cancels pending admission when routing resumes',async()=>{
  const f=await fixture();await f.sync(false);await applyEmailInboxEvent(pool,f.event);
  assert.equal((await f.row()).processed_at,null);
  await f.sync(true);await f.enable();assert.equal(await routePendingEmail(pool),false);
  const row=await f.row();assert.equal(row.classification,'deleted');assert(row.processed_at);assert.equal(row.message_id,null);
});
test('deletion before captured event application fences retry and stale full scans',async()=>{
  const f=await fixture();await f.sync(false);await f.sync(true);
  await applyEmailInboxEvent(pool,f.event);await applyEmailInboxEvent(pool,f.event);await f.sync(false);
  await f.enable();assert.equal(await routePendingEmail(pool),false);assert.equal((await f.row()).classification,'deleted');
});
test('concurrent captured event application and deletion cannot resurrect a pending email',async()=>{
  const f=await fixture();await Promise.all([applyEmailInboxEvent(pool,f.event),f.sync(true)]);
  await f.enable();assert.equal(await routePendingEmail(pool),false);assert.equal((await f.row()).classification,'deleted');
});
test('deletion preserves already admitted interaction history',async()=>{
  const f=await fixture();await applyEmailInboxEvent(pool,f.event);await f.enable();assert.equal(await routePendingEmail(pool),true);
  const before=await f.row();assert(before.message_id);
  await f.sync(true);await applyEmailInboxEvent(pool,f.event);
  const after=await f.row();assert.equal(after.message_id,before.message_id);assert.equal(after.classification,before.classification);
  assert.equal((await pool.query('SELECT 1 FROM acd_messages WHERE id=$1',[before.message_id])).rowCount,1);
  assert.equal(await routePendingEmail(pool),false);
});
test('an ordinary inbound email still routes once',async()=>{
  const f=await fixture();await f.sync(false);await applyEmailInboxEvent(pool,f.event);await f.enable();assert.equal(await routePendingEmail(pool),true);
  await applyEmailInboxEvent(pool,f.event);assert.equal(await routePendingEmail(pool),false);assert((await f.row()).message_id);
});


test('routing cannot pass a mailbox sync that has observed a provider deletion',async()=>{
  const f=await fixture();await applyEmailInboxEvent(pool,f.event);await f.enable();
  let observed,release;
  const pageObserved=new Promise(resolve=>{observed=resolve;});
  const pageRelease=new Promise(resolve=>{release=resolve;});
  const syncing=f.sync(true,async()=>{observed();await pageRelease;});
  await pageObserved;
  try {
    assert.equal(await routePendingEmail(pool),false,'routing must skip the mailbox while authenticated sync owns its lease');
  } finally {release();await syncing;}
  assert.equal((await f.row()).classification,'deleted');
  assert.equal((await f.row()).message_id,null);
  assert.equal(await routePendingEmail(pool),false);
});
