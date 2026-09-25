import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool, seedAgent, seedQueue } from './helpers/acd-test-db.mjs';
import { applyEmailInboxEvent, routePendingEmail } from '../lib/email/ingest.mjs';
import { heartbeatAgentSession } from '../lib/acd/sessions.mjs';
import { routeOne } from '../lib/acd/router.mjs';
import { actOnTextWork } from '../lib/acd/text-lifecycle.mjs';
import { readEmailDetail, saveEmailDraft, sendAgentEmail } from '../lib/email/store.mjs';
import { readConversationSnapshot } from '../lib/acd/conversation-preview.mjs';
import { publishCommittedOutbox } from '../lib/acd/stream.mjs';
import { emailProvider } from '../lib/email/provider.mjs';
import { authorizeInteractionRead } from '../lib/acd/conversation-preview.mjs';
import { readSupervisorDraftAttachment } from '../lib/email/draft-attachments.mjs';
import { emailAttachmentResponse } from '../lib/email/attachment-response.mjs';
import { clearSagaDeadlineWakeups } from '../lib/acd/saga-engine.mjs';

const pool=await prepareAcdTestPool('acd_core_test_email_draft_preview');
await pool.query(`DROP TABLE IF EXISTS app_settings,cc_queue_wrapup_codes,cc_wrapup_codes;
  CREATE TABLE app_settings(id text PRIMARY KEY,cc_settings jsonb);
  CREATE TABLE cc_wrapup_codes(id text PRIMARY KEY,name text,is_active boolean DEFAULT true);
  CREATE TABLE cc_queue_wrapup_codes(queue_id text,wrapup_code_id text);
  INSERT INTO app_settings VALUES('default','{}');`);
after(async()=>{clearSagaDeadlineWakeups();await pool.end();});

async function fixture() {
  const agentId=randomUUID(),queueId=randomUUID(),mailboxId=randomUUID();
  await seedAgent(pool,agentId,{voiceReady:false,firstName:'Alex'});
  await pool.query("UPDATE users SET last_name='Taylor' WHERE id=$1",[agentId]);
  await seedQueue(pool,queueId,[agentId]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'email',true,3,0.2)",[queueId]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'email',true,3,0.2)",[agentId]);
  await heartbeatAgentSession(pool,{agentId,sessionId:randomUUID(),emailReady:true});
  const address=`support-${mailboxId}@mail.example`;
  await pool.query(`INSERT INTO cc_email_mailboxes(id,provider_inbox_id,domain_id,address,name,queue_id,routing_enabled,sending_enabled)
    VALUES($1,$2,'domain',$3,'Support',$4,true,true)`,[mailboxId,randomUUID(),address,queueId]);
  await applyEmailInboxEvent(pool,{event_type:'email.inbox_message',payload:{mailboxId,message:{id:randomUUID(),
    from:'customer@example.com',to:[address],subject:'Need help',text_body:'How can I contact support?'}}});
  await routePendingEmail(pool);
  const work=(await pool.query('SELECT * FROM acd_work_items WHERE queue_id=$1',[queueId])).rows[0];
  const offer=await routeOne(pool,work.id);assert.equal(offer.routed,true);
  let detail=await readEmailDetail(pool,{workItemId:work.id,agentId});
  await actOnTextWork(pool,{workItemId:work.id,agentId,channel:'email',action:'accept',commandId:randomUUID(),expectedVersion:detail.work.version,offerId:offer.offerId});
  detail=await readEmailDetail(pool,{workItemId:work.id,agentId});
  const identity={workItemId:work.id,agentId};
  const scope={workItemId:work.id,user:{id:'supervisor',roles:['supervisor']}};
  const content={mode:'reply',replyMessageId:detail.messages[0].id,to:'customer@example.com',subject:'Re: Need help',text:'Draft response',html:'<p>Draft response</p>'};
  return {agentId,work,identity,scope,content};
}
async function snapshot(f,after) {
  await publishCommittedOutbox(pool);
  return readConversationSnapshot(pool,{...f.scope,after});
}

test('saved edits and pasted Copilot replies reach the live supervisor stream without becoming sent messages',async()=>{
  const f=await fixture(),initial=await snapshot(f);
  assert.deepEqual(initial.snapshot.drafts,[]);
  const content={...f.content,bcc:'hidden@example.com',attachments:[{filename:'notes.txt',content:Buffer.from('private attachment bytes').toString('base64'),content_type:'text/plain'}]};
  const saved=await saveEmailDraft(pool,{...f.identity,content,expectedVersion:'0'});
  const next=await snapshot(f,initial.cursor);
  assert.ok(BigInt(next.cursor)>BigInt(initial.cursor));
  assert.equal(next.snapshot.messages.length,1);
  const [draft]=next.snapshot.drafts;
  assert.equal(draft.status,'draft');assert.equal(draft.body,content.text);
  assert.equal(draft.first_name,'Alex');assert.equal(draft.last_name,'Taylor');
  assert.equal(draft.version,saved.version);assert.ok(draft.updated_at);
  assert.deepEqual(draft.attachments,[{name:'notes.txt',content_type:'text/plain',byte_size:24,
    url:`/api/contact-center/interactions/${f.work.id}/conversation/email-drafts/${f.agentId}/attachments/0?version=1`}]);
  assert(!JSON.stringify(next.snapshot).includes('hidden@example.com'));
  assert(!JSON.stringify(next.snapshot).includes(content.attachments[0].content));
  assert(!('can_preview_drafts' in next.snapshot.work));
  const events=(await pool.query("SELECT payload FROM acd_events WHERE work_item_id=$1 AND type='email_draft_updated'",[f.work.id])).rows;
  assert.deepEqual(events,[{payload:{draft_version:'1'}}]);
  const updated={...content,text:'Reply pasted from AI Copilot',html:'<p>Reply pasted from <strong>AI Copilot</strong></p>'};
  await saveEmailDraft(pool,{...f.identity,content:updated,expectedVersion:saved.version});
  const latest=await snapshot(f,next.cursor);
  assert.equal(latest.snapshot.drafts.length,1);
  assert.equal(latest.snapshot.drafts[0].id,draft.id);
  assert.equal(latest.snapshot.drafts[0].body,updated.text);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM acd_messages WHERE work_item_id=$1',[f.work.id])).rows[0].count,1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM acd_sla_measurements WHERE work_item_id=$1 AND served_at IS NOT NULL',[f.work.id])).rows[0].count,0);
});

test('supervisor can preview saved draft bytes, fenced by assignee, version and active work',async()=>{
  const f=await fixture(),other=await fixture();
  const bytes=Buffer.from('Private attachment preview');
  const content={...f.content,attachments:[{filename:'notes.txt',content:bytes.toString('base64'),content_type:'text/plain'}]};
  await saveEmailDraft(pool,{...f.identity,content,expectedVersion:'0'});
  const work=await authorizeInteractionRead(pool,f.work.id,f.scope.user);
  const input={agentId:f.agentId,index:'0',version:'1'};
  const file=await readSupervisorDraftAttachment(pool,work,input);
  assert.deepEqual(file.bytes,bytes);
  const response=await emailAttachmentResponse(new Request('https://cc.test/file?version=1&preview=1'),file);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(await response.json(),{kind:'text',text:bytes.toString(),truncated:false});
  await assert.rejects(readSupervisorDraftAttachment(pool,{...work,can_preview_drafts:false},input),{status:404});
  await assert.rejects(readSupervisorDraftAttachment(pool,work,{...input,agentId:other.agentId}),{status:404});
  await assert.rejects(readSupervisorDraftAttachment(pool,work,{...input,index:'-1'}),{status:404});
  await saveEmailDraft(pool,{...f.identity,content:{...content,text:'Changed'},expectedVersion:'1'});
  await assert.rejects(readSupervisorDraftAttachment(pool,work,input),{status:409});
  await pool.query("UPDATE acd_text_assignments SET state='completed' WHERE work_item_id=$1",[work.id]);
  await assert.rejects(readSupervisorDraftAttachment(pool,work,{...input,version:'2'}),{status:404});
});

test('sending atomically replaces a saved draft with one accepted outbound message, including idempotent retries',async()=>{
  const f=await fixture();
  const saved=await saveEmailDraft(pool,{...f.identity,content:f.content,expectedVersion:'0'});
  const before=await snapshot(f);
  const detail=await readEmailDetail(pool,f.identity);
  const input={...f.identity,content:f.content,draftVersion:saved.version,expectedVersion:detail.work.version,commandId:randomUUID()};
  let calls=0;
  const provider=emailProvider(null,async()=>{
    calls++;
    const during=await readConversationSnapshot(pool,f.scope);
    assert.deepEqual(during.snapshot.drafts,[]);
    assert.equal(during.snapshot.messages.filter(m=>m.sender_role==='agent').length,1);
    return {data:{id:randomUUID()}};
  });
  await sendAgentEmail(pool,input,{provider});
  const after=await snapshot(f,before.cursor);
  assert.deepEqual(after.snapshot.drafts,[]);
  assert.equal(after.snapshot.messages.length,2);
  const message=after.snapshot.messages.find(m=>m.sender_role==='agent');
  assert.equal(message.status,'accepted');assert.equal(message.body,f.content.text);
  await sendAgentEmail(pool,input,{provider});assert.equal(calls,1);
  assert.deepEqual((await snapshot(f)).snapshot.drafts,[]);
});

test('scheduled and rejected sends leave draft status without falsely claiming delivery',async()=>{
  for(const scheduled of [false,true]) {
    const f=await fixture();
    const content={...f.content,...(scheduled?{scheduledAt:new Date(Date.now()+120000).toISOString()}:{})};
    const saved=await saveEmailDraft(pool,{...f.identity,content,expectedVersion:'0'});
    const detail=await readEmailDetail(pool,f.identity);
    const provider=emailProvider(null,async()=>{assert.equal(scheduled,false);throw Object.assign(Error('Rejected'),{status:422});});
    await sendAgentEmail(pool,{...f.identity,content,draftVersion:saved.version,expectedVersion:detail.work.version,commandId:randomUUID()},{provider});
    const current=(await snapshot(f)).snapshot;
    assert.deepEqual(current.drafts,[]);
    assert.equal(current.messages.find(m=>m.sender_role==='agent').status,scheduled?'scheduled':'failed');
  }
});

test('empty edits disappear and stale draft saves cannot publish a false update',async()=>{
  const f=await fixture();
  await saveEmailDraft(pool,{...f.identity,content:f.content,expectedVersion:'0'});
  const before=await snapshot(f);
  await assert.rejects(saveEmailDraft(pool,{...f.identity,content:{...f.content,text:'Conflicting draft'},expectedVersion:'0'}),{status:409});
  assert.equal((await snapshot(f,before.cursor)).snapshot,null);
  await saveEmailDraft(pool,{...f.identity,content:{...f.content,text:'',html:'<p><br></p>'},expectedVersion:'1'});
  assert.deepEqual((await snapshot(f,before.cursor)).snapshot.drafts,[]);
});

test('drafts are scoped to the current assignee and hidden from agent history and completed interactions',async()=>{
  const f=await fixture(),other=await fixture();
  await saveEmailDraft(pool,{...f.identity,content:f.content,expectedVersion:'0'});
  await saveEmailDraft(pool,{...other.identity,content:{...other.content,text:'Another interaction'},expectedVersion:'0'});
  const oldAgent=randomUUID();await seedAgent(pool,oldAgent);
  await pool.query("INSERT INTO cc_email_drafts(work_item_id,agent_id,content) VALUES($1,$2,$3::jsonb)",[f.work.id,oldAgent,JSON.stringify({...f.content,text:'Old assignee draft'})]);
  const current=(await snapshot(f)).snapshot;
  assert.equal(current.drafts.length,1);assert.equal(current.drafts[0].agent_id,f.agentId);
  await assert.rejects(readConversationSnapshot(pool,{...f.scope,user:{id:other.agentId,roles:['agent']}}),{status:404});
  await pool.query("UPDATE acd_text_assignments SET state='completed' WHERE work_item_id=$1",[f.work.id]);
  assert.deepEqual((await snapshot(f)).snapshot.drafts,[]);
  await pool.query("UPDATE acd_work_items SET state='completed',terminal_at=now() WHERE id=$1",[f.work.id]);
  assert.deepEqual((await snapshot(f)).snapshot.drafts,[]);
  const history=await readConversationSnapshot(pool,{...f.scope,user:{id:f.agentId,roles:['agent']}});
  assert.deepEqual(history.snapshot.drafts,[]);
});

test('independent composer drafts persist and supervisor IDs and attachments identify the right tab',async()=>{
  const f=await fixture(),first=randomUUID(),second=randomUUID();
  const one={...f.content,attachments:[{filename:'one.txt',content:Buffer.from('one').toString('base64')}]};
  const two={...f.content,mode:'forward',to:'other@example.com',text:'Second draft',attachments:[{filename:'two.txt',content:Buffer.from('two').toString('base64')}]};
  await Promise.all([saveEmailDraft(pool,{...f.identity,draftId:first,content:one,expectedVersion:'0'}),saveEmailDraft(pool,{...f.identity,draftId:second,content:two,expectedVersion:'0'})]);
  let detail=await readEmailDetail(pool,f.identity);assert.equal(detail.drafts.length,2);
  await saveEmailDraft(pool,{...f.identity,draftId:first,content:{...one,text:'Only first changes'},expectedVersion:'1'});
  detail=await readEmailDetail(pool,f.identity);assert.equal(detail.drafts.find(d=>d.id===second).content.text,'Second draft');
  await assert.rejects(saveEmailDraft(pool,{...f.identity,draftId:first,content:one,expectedVersion:'1'}),{status:409});
  const preview=(await snapshot(f)).snapshot;assert.equal(preview.drafts.length,2);assert.equal(new Set(preview.drafts.map(d=>d.id)).size,2);
  const work=await authorizeInteractionRead(pool,f.work.id,f.scope.user);
  const attachment=await readSupervisorDraftAttachment(pool,work,{agentId:f.agentId,draftId:second,index:0,version:'1'});
  assert.equal(attachment.bytes.toString(),'two');
  assert(preview.drafts.find(d=>d.draft_id===second).attachments[0].url.includes(`draftId=${second}`));
  await saveEmailDraft(pool,{...f.identity,draftId:first,discard:true,expectedVersion:'2'});
  assert.deepEqual((await readEmailDetail(pool,f.identity)).drafts.map(d=>d.id),[second]);
  await assert.rejects(saveEmailDraft(pool,{...f.identity,draftId:first,content:one,expectedVersion:'2'}),{status:409});
});

test('accepted named send closes only its draft and retries do not send twice',async()=>{
  const f=await fixture(),first=randomUUID(),second=randomUUID();
  for(const draftId of [first,second])await saveEmailDraft(pool,{...f.identity,draftId,content:f.content,expectedVersion:'0'});
  const detail=await readEmailDetail(pool,f.identity),input={...f.identity,draftId:first,content:f.content,draftVersion:'1',expectedVersion:detail.work.version,commandId:randomUUID()};let calls=0;
  const provider=emailProvider(null,async()=>{calls++;assert.equal((await readEmailDetail(pool,f.identity)).drafts.length,2);return {data:{id:randomUUID()}};});
  await sendAgentEmail(pool,input,{provider});
  assert.deepEqual((await readEmailDetail(pool,f.identity)).drafts.map(d=>d.id),[second]);
  await sendAgentEmail(pool,input,{provider});assert.equal(calls,1);
});

test('failed named send retains its body and files and must save a new version before retry',async()=>{
  const f=await fixture(),draftId=randomUUID(),content={...f.content,attachments:[{filename:'keep.txt',content:'SGk='}]};
  await saveEmailDraft(pool,{...f.identity,draftId,content,expectedVersion:'0'});
  const detail=await readEmailDetail(pool,f.identity),input={...f.identity,draftId,content,draftVersion:'1',expectedVersion:detail.work.version,commandId:randomUUID()};
  await sendAgentEmail(pool,input,{provider:emailProvider(null,async()=>{throw Object.assign(Error('Rejected'),{status:422});})});
  const row=(await readEmailDetail(pool,f.identity)).drafts[0];assert.equal(row.content.text,content.text);assert.equal(row.content.attachments[0].content,'SGk=');assert.equal(row.sendStatus,'failed');
  await assert.rejects(sendAgentEmail(pool,{...input,draftVersion:row.version,commandId:randomUUID()}),{status:409});
  const saved=await saveEmailDraft(pool,{...f.identity,draftId,content,expectedVersion:row.version});
  await sendAgentEmail(pool,{...input,draftVersion:saved.version,commandId:randomUUID()},{provider:emailProvider(null,async()=>({data:{id:randomUUID()}}))});
  assert.equal((await readEmailDetail(pool,f.identity)).drafts.length,0);
});

test('an uncertain named send cannot be overwritten, discarded or sent with a new command',async()=>{
  const f=await fixture(),draftId=randomUUID();await saveEmailDraft(pool,{...f.identity,draftId,content:f.content,expectedVersion:'0'});
  const detail=await readEmailDetail(pool,f.identity),input={...f.identity,draftId,content:f.content,draftVersion:'1',expectedVersion:detail.work.version,commandId:randomUUID()};
  await sendAgentEmail(pool,input,{provider:emailProvider(null,async()=>{throw Error('Network timeout');})});
  const row=(await readEmailDetail(pool,f.identity)).drafts[0];assert.ok(row.submittedMessageId);
  await assert.rejects(saveEmailDraft(pool,{...f.identity,draftId,content:f.content,expectedVersion:row.version}),{status:409});
  await assert.rejects(saveEmailDraft(pool,{...f.identity,draftId,discard:true,expectedVersion:row.version}),{status:409});
  await assert.rejects(sendAgentEmail(pool,{...input,draftVersion:row.version,commandId:randomUUID()}),{status:409});
});

test('scheduled named draft closes while other drafts survive',async()=>{
  const f=await fixture(),draftId=randomUUID(),content={...f.content,scheduledAt:new Date(Date.now()+120000).toISOString()};
  await saveEmailDraft(pool,{...f.identity,draftId,content,expectedVersion:'0'});
  const detail=await readEmailDetail(pool,f.identity);
  const result=await sendAgentEmail(pool,{...f.identity,draftId,content,draftVersion:'1',expectedVersion:detail.work.version,commandId:randomUUID()},{provider:emailProvider(null,async()=>assert.fail('Scheduled mail must not send early'))});
  assert.equal(result.status,'scheduled');assert.equal((await readEmailDetail(pool,f.identity)).drafts.length,0);
});

test('forward composer seed retains HTML and inline files without sending or changing the reply draft',async()=>{
  const {prepareForwardDraft}=await import('../lib/email/forward.mjs');
  const f=await fixture();await saveEmailDraft(pool,{...f.identity,content:f.content,expectedVersion:'0'});
  await pool.query(`UPDATE cc_email_messages SET html_body=$2,envelope=envelope||$3::jsonb WHERE message_id=$1`,[f.content.replyMessageId,'<table><tr><td>Original <b>HTML</b><img src="cid:logo"></td></tr></table>',JSON.stringify({attachments:[{filename:'logo.png',content_type:'image/png',storage_key:'original-file',content_id:'logo'}]})]);
  const seed=await prepareForwardDraft(pool,{...f.identity,messageId:f.content.replyMessageId},{readFile:async key=>{assert.equal(key,'original-file');return Buffer.from('image bytes');}});
  assert(seed.content.html.includes('<table>'));assert(seed.content.html.includes('cid:logo'));
  assert.equal(seed.content.attachments[0].content_id,'logo');assert.equal(seed.content.to,'');
  assert.equal((await readEmailDetail(pool,f.identity)).drafts[0].content.text,f.content.text);
  await assert.rejects(prepareForwardDraft(pool,{...f.identity,messageId:randomUUID()}),{status:404});
  await assert.rejects(prepareForwardDraft(pool,{...f.identity,messageId:f.content.replyMessageId},{readFile:async()=>Buffer.alloc(5_000_001)}),{status:413});
});

test('email address book includes email-only contacts, both addresses and no sensitive profile fields',async()=>{
  const {searchEmailRecipients}=await import('../lib/email/recipient-search.mjs');
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS display_name text,ADD COLUMN IF NOT EXISTS company_name text,
    ADD COLUMN IF NOT EXISTS email_address_1 text,ADD COLUMN IF NOT EXISTS email_address_2 text,ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`);
  const id=randomUUID();
  await pool.query(`INSERT INTO contacts(id,first_name,last_name,display_name,company_name,email_address_1,email_address_2)
    VALUES($1,'Alex','Taylor','Alex Taylor','Example_Company','Alex@example.com','second@example.com'),($2,'Removed','','Removed','','deleted@example.com',NULL),($3,'Invalid','','Invalid','','invalid',NULL)`,[id,randomUUID(),randomUUID()]);
  await pool.query("UPDATE contacts SET deleted_at=now() WHERE email_address_1='deleted@example.com'");
  const first=await searchEmailRecipients(pool,{query:'Example_Company',pageSize:1});
  assert.equal(first.total,2);assert.equal(first.data[0].email,'alex@example.com');assert.deepEqual(Object.keys(first.data[0]).sort(),['company','contact_id','email','name','position']);
  const second=await searchEmailRecipients(pool,{query:'Example_Company',pageSize:1,page:2});assert.equal(second.data[0].email,'second@example.com');
  assert.equal((await searchEmailRecipients(pool,{query:'second@'})).total,2);
  assert.equal((await searchEmailRecipients(pool,{query:'Example%Company'})).total,0);
  assert.equal((await searchEmailRecipients(pool,{query:'deleted@'})).total,0);
  assert.equal((await searchEmailRecipients(pool,{query:'Invalid'})).total,0);
});

test('unchanged draft polling omits attachment bytes but returns changed drafts',async()=>{
  const f=await fixture(),draftId=randomUUID(),content={...f.content,attachments:[{filename:'private.txt',content:'SGk='}]};
  await saveEmailDraft(pool,{...f.identity,draftId,content,expectedVersion:'0'});
  const cached=await readEmailDetail(pool,{...f.identity,knownDraftVersions:{[draftId]:'1'}});
  assert.equal(cached.drafts.length,1);assert.equal(cached.drafts[0].content,undefined);assert(!JSON.stringify(cached).includes('SGk='));
  await saveEmailDraft(pool,{...f.identity,draftId,content:{...content,text:'Updated'},expectedVersion:'1'});
  const changed=await readEmailDetail(pool,{...f.identity,knownDraftVersions:{[draftId]:'1'}});
  assert.equal(changed.drafts[0].content.text,'Updated');assert.equal(changed.drafts[0].content.attachments[0].content,'SGk=');
});

test('schema upgrade preserves an existing legacy draft and its optimistic version',async()=>{
  const {ensureEmailSchema}=await import('../lib/email/schema.mjs'),f=await fixture();
  const schema='email_migration_'+randomUUID().replaceAll('-',''),db=await pool.connect();
  try{
    await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},public`);
    await db.query(`CREATE TABLE cc_email_drafts(work_item_id uuid NOT NULL,agent_id text NOT NULL,content jsonb NOT NULL,
      version bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(work_item_id,agent_id))`);
    await db.query('INSERT INTO cc_email_drafts(work_item_id,agent_id,content,version) VALUES($1,$2,$3,7)',[f.work.id,f.agentId,f.content]);
    await ensureEmailSchema(db);await ensureEmailSchema(db);
    const row=(await db.query('SELECT * FROM cc_email_drafts')).rows[0];assert.equal(row.draft_id,'legacy');assert.equal(row.version,'7');assert.deepEqual(row.content,f.content);
    await db.query('INSERT INTO cc_email_drafts(work_item_id,agent_id,draft_id,content) VALUES($1,$2,$3,$4)',[f.work.id,f.agentId,randomUUID(),f.content]);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM cc_email_drafts')).rows[0].count,2);
  }finally{await db.query(`SET search_path TO public; DROP SCHEMA ${schema} CASCADE`);db.release();}
});

test('provider size rejection is visible as safe actionable evidence and keeps the named draft',async()=>{
  const f=await fixture(),id=randomUUID();
  const saved=await saveEmailDraft(pool,{...f.identity,draftId:id,content:f.content,expectedVersion:'0'});
  const before=await readEmailDetail(pool,f.identity);
  const provider=emailProvider(null,async()=>{throw Object.assign(Error('Kafka payload exceeds size limit (maximum 1048576 bytes)'),{status:422,code:'10015'});});
  const sent=await sendAgentEmail(pool,{...f.identity,commandId:randomUUID(),expectedVersion:before.work.version,content:f.content,draftVersion:saved.version,draftId:id},{provider});
  const after=await readEmailDetail(pool,f.identity),message=after.messages.find(m=>m.id===sent.messageId);
  assert.equal(message.status,'failed');assert.equal(message.sendError.code,'10015');assert.equal(message.sendError.httpStatus,422);
  assert.match(message.sendError.message,/internal size limit/);assert(!message.sendError.message.includes('Kafka'));
  assert.equal(message.provider_error,undefined);assert.equal(after.drafts.find(d=>d.id===id).content.text,f.content.text);
});

test('supervisor draft rows and attachment URLs distinguish the same draft ID on two devices',async()=>{
 const f=await fixture();
 for(const draftScope of ['web','mobile'])await saveEmailDraft(pool,{...f.identity,draftScope,expectedVersion:'0',content:{...f.content,text:draftScope,
   attachments:[{filename:'notes.txt',content:Buffer.from(draftScope).toString('base64'),content_type:'text/plain'}]}});
 const view=await snapshot(f);assert.equal(new Set(view.snapshot.drafts.map(d=>d.id)).size,2);
 const work=await authorizeInteractionRead(pool,f.work.id,f.scope.user,{supervisor:true});
 for(const draft of view.snapshot.drafts){
   const url=new URL(draft.attachments[0].url,'https://example.invalid');
   const attachment=await readSupervisorDraftAttachment(pool,work,{agentId:f.agentId,index:0,version:url.searchParams.get('version'),draftScope:url.searchParams.get('draftScope')});
   assert.equal(attachment.bytes.toString(),draft.body);
 }
});
