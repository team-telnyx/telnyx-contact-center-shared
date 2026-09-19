import { test,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool,seedAgent,seedQueue } from './helpers/acd-test-db.mjs';
import { heartbeatAgentSession } from '../lib/acd/sessions.mjs';
import { routeOne } from '../lib/acd/router.mjs';
import { actOnTextWork,completeTextWrapup,revalidateTextOffers } from '../lib/acd/text-lifecycle.mjs';
import { readTextInteractions } from '../lib/acd/text-desktop.mjs';
import { driveSaga,clearSagaDeadlineWakeups } from '../lib/acd/saga-engine.mjs';
import { applyEmailInboxEvent,routePendingEmail,syncEmailMailbox } from '../lib/email/ingest.mjs';
import { readEmailDetail,saveEmailDraft,sendAgentEmail,cancelScheduledEmail } from '../lib/email/store.mjs';
import { normalizeInbound,buildAgentEmail,parseEmailDraft,classifyEmail,reduceDelivery } from '../lib/email/policy.mjs';
import { emailProvider,fetchEmailContent } from '../lib/email/provider.mjs';
import { generateChatCopilot } from '../lib/contact-center/chat-copilot.js';
import { emailAdminAction,emailAdminOverview } from '../lib/email/admin.mjs';
import { persistWebhookEvent,runInboxWorkerOnce } from '../lib/acd/inbox.mjs';
import { createOutboundEmail,emailComposeMailboxes,transferEmailWork } from '../lib/acd/email-work.mjs';
import { syncEmailDeliveries } from '../lib/email/ingest.mjs';
import { emailHtmlText,emailRasterType } from '../lib/email/content.mjs';
import { forwardEmailWork } from '../lib/email/forward.mjs';
import { messagingTransferTargets } from '../lib/acd/text-transfer.mjs';

const pool=await prepareAcdTestPool('acd_core_test_email_channel');
await pool.query(`DROP TABLE IF EXISTS app_settings,cc_queue_wrapup_codes,cc_wrapup_codes;
  CREATE TABLE app_settings(id text PRIMARY KEY,cc_settings jsonb);
  INSERT INTO app_settings VALUES('default','{"email_copilot":{"model":"email-test","bucketIds":["email-knowledge"]}}');
  CREATE TABLE cc_wrapup_codes(id text,name text,is_active boolean);
  CREATE TABLE cc_queue_wrapup_codes(queue_id text,wrapup_code_id text);
  INSERT INTO cc_wrapup_codes VALUES('resolved','Resolved',true);`);
after(async()=>{clearSagaDeadlineWakeups();await pool.end();});

async function fixture({agentEnabled=true,routing=true}={}){
  const agentId=randomUUID(),queueId=randomUUID(),mailboxId=randomUUID();
  await seedAgent(pool,agentId,{voiceReady:false});await seedQueue(pool,queueId,[agentId]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'email',true,5,0.2)",[queueId]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'email',$2,5,0.2)",[agentId,agentEnabled]);
  await heartbeatAgentSession(pool,{agentId,sessionId:randomUUID(),emailReady:true});
  await pool.query(`INSERT INTO cc_email_mailboxes(id,provider_inbox_id,domain_id,address,name,queue_id,routing_enabled,sending_enabled)
    VALUES($1,$2,'domain',$3,'Customer Support',$4,$5,true)`,[mailboxId,randomUUID(),`support-${mailboxId}@cc.example.com`,queueId,routing]);
  const mailbox=(await pool.query('SELECT * FROM cc_email_mailboxes WHERE id=$1',[mailboxId])).rows[0];
  const message={id:randomUUID(),thread_id:randomUUID(),from:{email:'customer@example.com',name:'Jordan Lee'},to:[mailbox.address],cc:['colleague@example.com'],
    subject:'Help with my account',text_body:'Can I update my billing address?',html_body:'<p>Can I update my billing address?</p>',headers:{'Message-ID':`<${randomUUID()}@example.com>`}};
  return {agentId,queueId,mailboxId,mailbox,message};
}
async function receive(f,message=f.message){
  await applyEmailInboxEvent(pool,{event_type:'email.inbox_message',payload:{mailboxId:f.mailboxId,message}});
  await routePendingEmail(pool);
  return (await pool.query(`SELECT w.* FROM acd_work_items w JOIN cc_email_threads t ON t.conversation_id=w.conversation_id
    WHERE t.mailbox_id=$1 ORDER BY w.created_at DESC LIMIT 1`,[f.mailboxId])).rows[0];
}
async function accept(f,work){
  const offer=await routeOne(pool,work.id);assert.equal(offer.routed,true);
  const detail=await readEmailDetail(pool,{workItemId:work.id,agentId:f.agentId});
  await actOnTextWork(pool,{workItemId:work.id,agentId:f.agentId,channel:'email',action:'accept',commandId:randomUUID(),expectedVersion:detail.work.version,offerId:offer.offerId});
  return readEmailDetail(pool,{workItemId:work.id,agentId:f.agentId});
}
function sendInput(f,detail,extra={}){
  return {workItemId:detail.work.id,agentId:f.agentId,commandId:randomUUID(),expectedVersion:detail.work.version,
    content:{mode:'reply',replyMessageId:detail.messages[0].id,to:'customer@example.com',subject:'Re: Help with my account',text:'Open Billing in account settings.',html:'<p>Open Billing in account settings.</p>',...extra}};
}
const acceptedProvider=()=>emailProvider(null,async()=>({data:{id:randomUUID()}}));

test('provider reply_to arrays accept empty and multiple addresses and retain all reply recipients',()=>{
  const message={id:randomUUID(),from:{email:'sender@example.com'},to:[],cc:[],reply_to:[],reply_text:'Extracted reply'};
  assert.equal(normalizeInbound(message).replyTo,'sender@example.com');assert.equal(normalizeInbound(message).text,'Extracted reply');
  const normalized=normalizeInbound({...message,reply_to:[{email:'Reply@Example.com'},{email:'team@example.com'}]});
  assert.equal(normalized.replyTo,'reply@example.com, team@example.com');
  const {payload}=buildAgentEmail({draft:{mode:'reply',subject:'Reply',text:'Hello',to:normalized.replyTo},mailbox:{address:'support@example.com',sending_enabled:true},original:{provider_message_id:message.id,envelope:normalized}});
  assert.deepEqual(payload.to,['reply@example.com','team@example.com']);
});

test('provider-shaped inbox pages fetch full bodies, advance page[after], and route only after the final page',async()=>{
  const f=await fixture();await pool.query("UPDATE cc_email_mailboxes SET next_sync_at=now()+interval '1 hour'");await pool.query('UPDATE cc_email_mailboxes SET next_sync_at=now() WHERE id=$1',[f.mailboxId]);
  const ids=[randomUUID(),randomUUID()],paths=[];
  const request=async path=>{
    paths.push(path);const url=new URL(path,'https://provider.test');
    if(url.pathname.startsWith('/email_messages/'))return {data:{id:url.pathname.split('/').at(-1),text_body:'Full body with quoted context',html_body:'<p>Full HTML body</p>'}};
    assert.equal(url.searchParams.get('page[size]'),'50');assert.equal(url.searchParams.has('page_cursor'),false);
    const second=url.searchParams.get('page[after]')==='next+cursor';
    return {data:[{...f.message,id:ids[second?1:0],text_body:undefined,html_body:undefined,text_body_url:null,html_body_url:null,reply_text:'Short reply',reply_to:[]}].map(m=>JSON.parse(JSON.stringify(m))),meta:{page_cursor:second?null:'next+cursor'}};
  };
  await syncEmailMailbox(pool,{request});
  let rows=(await pool.query("SELECT payload FROM acd_webhook_events WHERE provider='telnyx-email' AND payload->>'mailboxId'=$1",[f.mailboxId])).rows;
  for(const row of rows)await applyEmailInboxEvent(pool,{event_type:'email.inbox_message',payload:row.payload});
  await routePendingEmail(pool);assert.equal((await pool.query('SELECT processed_at FROM cc_email_received WHERE mailbox_id=$1',[f.mailboxId])).rows[0].processed_at,null);
  await pool.query('UPDATE cc_email_mailboxes SET next_sync_at=now() WHERE id=$1',[f.mailboxId]);await syncEmailMailbox(pool,{request});
  rows=(await pool.query("SELECT payload FROM acd_webhook_events WHERE provider='telnyx-email' AND payload->>'mailboxId'=$1",[f.mailboxId])).rows;
  for(const row of rows)await applyEmailInboxEvent(pool,{event_type:'email.inbox_message',payload:row.payload});
  await routePendingEmail(pool);await routePendingEmail(pool);
  const received=(await pool.query('SELECT payload,processed_at FROM cc_email_received WHERE mailbox_id=$1',[f.mailboxId])).rows;
  assert.equal(received.length,2);assert(received.every(r=>r.processed_at&&r.payload.text==='Full body with quoted context'&&r.payload.html==='<p>Full HTML body</p>'));
  assert.equal(paths.filter(p=>p.startsWith('/email_messages/')).length,2);
  assert.equal((await pool.query('SELECT sync_cursor FROM cc_email_mailboxes WHERE id=$1',[f.mailboxId])).rows[0].sync_cursor,null);
});

test('failed message detail hydration leaves the inbox page unacknowledged for retry',async()=>{
  const f=await fixture();await pool.query("UPDATE cc_email_mailboxes SET next_sync_at=now()+interval '1 hour'");await pool.query('UPDATE cc_email_mailboxes SET next_sync_at=now(),sync_cursor=$2 WHERE id=$1',[f.mailboxId,'previous']);
  await assert.rejects(syncEmailMailbox(pool,{request:async path=>{if(path.startsWith('/email_messages/'))throw Error('Details unavailable');return {data:[{id:f.message.id,from:f.message.from,reply_to:[],reply_text:'Partial'}],meta:{page_cursor:'next'}};}}),/Details unavailable/);
  assert.equal((await pool.query('SELECT sync_cursor FROM cc_email_mailboxes WHERE id=$1',[f.mailboxId])).rows[0].sync_cursor,'previous');
  assert.equal((await pool.query("SELECT 1 FROM acd_webhook_events WHERE payload->>'mailboxId'=$1",[f.mailboxId])).rowCount,0);
});

test('manual forwarding sends the selected original and private attachments once, preserving assignment and reply draft',async()=>{
  const f=await fixture(),work=await receive(f,{...f.message,attachments:[{filename:'invoice.txt',content_type:'text/plain',storage_key:'private-key',size_bytes:7}]}),detail=await accept(f,work);
  const draft={...sendInput(f,detail).content,text:'Unsent agent draft'};
  await saveEmailDraft(pool,{workItemId:work.id,agentId:f.agentId,content:draft,expectedVersion:'0'});
  const directory=await messagingTransferTargets(pool,{workItemId:work.id,agentId:f.agentId,channel:'email'});
  assert.equal(directory.forward.message_id,detail.messages[0].id);assert.equal(directory.forward.attachment_count,1);
  const calls=[],provider=emailProvider(null,async(path,options)=>{calls.push(options.body);return {data:{id:randomUUID()}};});
  const input={workItemId:work.id,agentId:f.agentId,messageId:directory.forward.message_id,to:'external@example.com',commandId:randomUUID(),expectedVersion:directory.version};
  const dependencies={provider,readFile:async key=>{assert.equal(key,'private-key');return Buffer.from('invoice');}};
  const sent=await forwardEmailWork(pool,input,dependencies);assert.deepEqual(await forwardEmailWork(pool,input,dependencies),sent);
  assert.equal(calls.length,1);assert.equal(calls[0].from,f.mailbox.address);assert.equal(calls[0].forward_of_message_id,f.message.id);
  assert.deepEqual(calls[0].to,['external@example.com']);assert(!calls[0].cc?.length);assert(!calls[0].bcc?.length);
  assert(calls[0].text_body.includes(f.message.text_body));assert.equal(calls[0].attachments[0].content,Buffer.from('invoice').toString('base64'));
  const after=await readEmailDetail(pool,{workItemId:work.id,agentId:f.agentId});assert.equal(after.work.state,'active');assert.equal(after.draft.content.text,draft.text);assert.equal(after.messages.length,2);
  await assert.rejects(forwardEmailWork(pool,{...input,to:'changed@example.com'},dependencies),e=>e.status===409);
});

test('forward confirmation replays the journal before unavailable attachments or changed ownership',async()=>{
  for(const source of ['private','url']){
    const f=await fixture(),other=await fixture();
    const file={filename:'invoice.txt',content_type:'text/plain',size_bytes:7,...(source==='private'?{storage_key:'private-key'}:{url:'https://provider.test/expired-file'})};
    const detail=await accept(f,await receive(f,{...f.message,attachments:[file]}));
    const input={workItemId:detail.work.id,agentId:f.agentId,messageId:detail.messages[0].id,to:'external@example.com',commandId:randomUUID(),expectedVersion:detail.work.version};
    let sends=0,reads=0;
    const provider=emailProvider(null,async()=>{sends++;return {data:{id:randomUUID()}};});
    const firstRead=async()=>{reads++;return Buffer.from('invoice');};
    const sent=await forwardEmailWork(pool,input,{provider,readFile:firstRead,fetchContent:firstRead});
    assert.equal(reads,1);
    const unavailable=async()=>{reads++;throw Error('Attachment unavailable');};
    const retryDependencies={provider,readFile:unavailable,fetchContent:unavailable};
    assert.deepEqual(await forwardEmailWork(pool,input,retryDependencies),sent);
    for(const change of [{to:'changed@example.com'},{messageId:randomUUID()},{expectedVersion:'9999'}]){
      await assert.rejects(forwardEmailWork(pool,{...input,...change},retryDependencies),e=>e.status===409);
    }
    await assert.rejects(forwardEmailWork(pool,{...input,agentId:other.agentId},retryDependencies),e=>e.status===403);
    const current=await readEmailDetail(pool,{workItemId:input.workItemId,agentId:f.agentId});
    await transferEmailWork(pool,{workItemId:input.workItemId,agentId:f.agentId,queueId:f.queueId,commandId:randomUUID(),expectedVersion:current.work.version});
    assert.deepEqual(await forwardEmailWork(pool,input,retryDependencies),sent);
    assert.equal(reads,1);assert.equal(sends,1);
  }
});

test('concurrent forwards commit one result when both start before attachment reads finish',{timeout:10000},async()=>{
  const f=await fixture(),detail=await accept(f,await receive(f,{...f.message,attachments:[{filename:'invoice.txt',storage_key:'private-key',size_bytes:7}]}));
  const input={workItemId:detail.work.id,agentId:f.agentId,messageId:detail.messages[0].id,to:'external@example.com',commandId:randomUUID(),expectedVersion:detail.work.version};
  let reads=0,sends=0,release;const ready=new Promise(resolve=>{release=resolve;});
  const dependencies={provider:emailProvider(null,async()=>{sends++;return {data:{id:randomUUID()}};}),readFile:async()=>{if(++reads===2)release();await ready;return Buffer.from('invoice');}};
  const results=await Promise.all([forwardEmailWork(pool,input,dependencies),forwardEmailWork(pool,input,dependencies)]);
  assert.deepEqual(results[0],results[1]);assert.equal(sends,1);
  assert.equal((await pool.query('SELECT 1 FROM acd_text_commands WHERE work_item_id=$1 AND command_id=$2',[input.workItemId,input.commandId])).rowCount,1);
});

test('manual forwarding rejects foreign work, unrelated messages, invalid addresses and paused sending without provider I/O',async()=>{
  const f=await fixture(),other=await fixture(),detail=await accept(f,await receive(f)),foreign=await accept(other,await receive(other));
  const input={workItemId:detail.work.id,agentId:f.agentId,messageId:detail.messages[0].id,to:'external@example.com',commandId:randomUUID(),expectedVersion:detail.work.version};
  let calls=0;const deps={provider:emailProvider(null,async()=>{calls++;return {data:{id:randomUUID()}};})};
  await assert.rejects(forwardEmailWork(pool,{...input,agentId:other.agentId},deps),e=>e.status===403);
  await assert.rejects(forwardEmailWork(pool,{...input,messageId:foreign.messages[0].id},deps),e=>e.status===404);
  await assert.rejects(forwardEmailWork(pool,{...input,to:'one@example.com,two@example.com'},deps),e=>e.status===400);
  await pool.query('UPDATE cc_email_mailboxes SET sending_enabled=false WHERE id=$1',[f.mailboxId]);
  assert.equal((await messagingTransferTargets(pool,{workItemId:detail.work.id,agentId:f.agentId,channel:'email'})).forward,null);
  await assert.rejects(forwardEmailWork(pool,input,deps),e=>e.status===409);
  assert.equal(calls,0);
});

test('manual forwarding enforces aggregate attachment limits before sending',async()=>{
  const f=await fixture(),detail=await accept(f,await receive(f,{...f.message,attachments:[{filename:'large',storage_key:'private',size_bytes:5_000_001}]}));
  let reads=0,calls=0;
  await assert.rejects(forwardEmailWork(pool,{workItemId:detail.work.id,agentId:f.agentId,messageId:detail.messages[0].id,to:'external@example.com',commandId:randomUUID(),expectedVersion:detail.work.version},
    {readFile:async()=>{reads++;return Buffer.alloc(0);},provider:emailProvider(null,async()=>{calls++;})}),e=>e.status===413);
  assert.equal(reads,0);assert.equal(calls,0);
});

test('email-only agent heartbeat, offer, acceptance and Desktop projection need no voice or chat capability',async()=>{
  const f=await fixture(),work=await receive(f),detail=await accept(f,work);
  assert.equal(detail.work.state,'active');assert.equal(detail.messages[0].body,f.message.text_body);
  const list=await readTextInteractions(pool,f.agentId);assert.equal(list.interactions[0].channel,'email');assert.equal(list.interactions[0].from_name,'Jordan Lee');
  assert.equal((await pool.query('SELECT presence FROM acd_agent_state WHERE agent_id=$1',[f.agentId])).rows[0].presence,'online');
});
test('disabled agent email policy cannot be overridden by browser readiness',async()=>{
  const f=await fixture({agentEnabled:false}),work=await receive(f);
  assert.equal((await routeOne(pool,work.id)).routed,false);
});
test('formatted-only email retains readable text and only raster signatures qualify for inline CID display',()=>{
  assert.equal(emailHtmlText('<html><head><style>x</style></head><body><p>Hello &amp; welcome</p><script>secret()</script><p>Invoice &#8364;20</p></body></html>'),'Hello & welcome\n\nInvoice €20');
  assert.equal(normalizeInbound({id:'html',from:'sender@example.com',to:['support@example.com'],html_body:'<p>Help me</p>'}).text,'Help me');
  assert.equal(emailRasterType(Buffer.from('<svg onload="alert(1)"></svg>')),null);
  assert.equal(emailRasterType(Buffer.from([137,80,78,71,13,10,26,10,0])),'image/png');
});
test('multiple managed visible recipients create one human task while retaining all mailbox copies',async()=>{
  const first=await fixture(),second=await fixture();
  const message={...first.message,to:[first.mailbox.address,second.mailbox.address]};
  await receive(second,message);await receive(first,message);
  const copies=(await pool.query('SELECT classification FROM cc_email_received WHERE provider_message_id=$1',[message.id])).rows;
  assert.deepEqual(copies.map(r=>r.classification).sort(),['customer','duplicate_mailbox']);
  assert.equal((await pool.query('SELECT count(*)::int n FROM acd_messages WHERE client_id=$1',[message.id])).rows[0].n,1);
});
test('backfill waits for the final cursor and preserves provider chronology',async()=>{
  const f=await fixture();await pool.query("UPDATE cc_email_mailboxes SET sync_cursor='next-page' WHERE id=$1",[f.mailboxId]);
  assert.equal(await receive(f,{...f.message,received_at:'2026-09-13T10:00:00Z'}),undefined);
  assert.equal(await receive(f,{...f.message,id:randomUUID(),received_at:'2026-09-13T09:00:00Z',text_body:'Earlier message'}),undefined);
  await pool.query('UPDATE cc_email_mailboxes SET sync_cursor=NULL WHERE id=$1',[f.mailboxId]);
  await routePendingEmail(pool);await routePendingEmail(pool);
  const work=(await pool.query('SELECT w.* FROM acd_work_items w JOIN cc_email_threads t ON t.conversation_id=w.conversation_id WHERE t.mailbox_id=$1',[f.mailboxId])).rows[0];
  const detail=await accept(f,work);assert.deepEqual(detail.messages.map(m=>m.body),['Earlier message',f.message.text_body]);
});
test('ingestion is durable and duplicate deliveries create one message and one routing episode',async()=>{
  const f=await fixture();const results=await Promise.all([receive(f),receive(f),receive(f)]);
  assert(results.every(w=>w.id===results[0].id));
  assert.equal((await pool.query('SELECT count(*)::int n FROM acd_messages WHERE conversation_id=$1',[results[0].conversation_id])).rows[0].n,1);
});
test('routing pause captures backlog and resumes it without a second provider delivery',async()=>{
  const f=await fixture({routing:false});assert.equal(await receive(f),undefined);
  assert.equal((await pool.query('SELECT processed_at FROM cc_email_received WHERE mailbox_id=$1',[f.mailboxId])).rows[0].processed_at,null);
  await pool.query('UPDATE cc_email_mailboxes SET routing_enabled=true WHERE id=$1',[f.mailboxId]);
  assert.equal(await routePendingEmail(pool),true);
});
test('same subject does not merge separate threads; headers recover a thread without a provider thread ID',async()=>{
  const f=await fixture(),first=await receive(f);
  const second=await receive(f,{...f.message,id:randomUUID(),thread_id:randomUUID(),headers:{'Message-ID':'<different@example.com>'}});
  assert.notEqual(first.conversation_id,second.conversation_id);
  await receive(f,{...f.message,id:randomUUID(),thread_id:'',headers:{'Message-ID':'<reply@example.com>','In-Reply-To':f.message.headers['Message-ID']}});
  assert.equal((await pool.query('SELECT count(*)::int n FROM acd_messages WHERE conversation_id=$1',[first.conversation_id])).rows[0].n,2);
});
test('provider RFC fields and bare outgoing Message-IDs retain the conversation across replies',async()=>{
  const f=await fixture(),root=`${randomUUID()}@example.com`,sentId=`${randomUUID()}@example.com`;
  const incoming={...f.message,headers:{},message_id:root,reply_to:[]};
  const work=await receive(f,incoming),detail=await accept(f,work);
  assert.equal((await pool.query('SELECT rfc_message_id FROM cc_email_messages WHERE message_id=$1',[detail.messages[0].id])).rows[0].rfc_message_id,`<${root}>`);
  const sent=await sendAgentEmail(pool,sendInput(f,detail),{provider:emailProvider(null,async()=>({data:{id:randomUUID(),message_id:sentId}}))});
  assert.equal((await pool.query('SELECT rfc_message_id FROM cc_email_messages WHERE message_id=$1',[sent.messageId])).rows[0].rfc_message_id,`<${sentId}>`);
  const next=await receive(f,{...incoming,id:randomUUID(),thread_id:randomUUID(),message_id:`reply-${root}`,in_reply_to:sentId,references:[root,`<${sentId}>`]});
  assert.equal(next.conversation_id,work.conversation_id);
  await receive(f,{...incoming,id:randomUUID(),thread_id:'',message_id:`references-${root}`,references:[`<${root}>`,sentId]});
  assert.equal((await pool.query('SELECT count(*)::int n FROM cc_email_threads WHERE mailbox_id=$1',[f.mailboxId])).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM acd_messages WHERE conversation_id=$1',[work.conversation_id])).rows[0].n,4);
  const normalized=normalizeInbound({...incoming,message_id:'invalid',in_reply_to:null,references:[],headers:{'Message-ID':`<${root}>`,'In-Reply-To':`<${sentId}>`,References:`<${root}> <${root}>`}});
  assert.equal(normalized.messageId,`<${root}>`);assert.equal(normalized.inReplyTo,`<${sentId}>`);assert.deepEqual(normalized.references,[`<${root}>`]);
});
test('historical standalone scheduled sends are rejected before provider I/O',async()=>{
  const f=await fixture(),detail=await accept(f,await receive(f));let calls=0;
  const provider=emailProvider(null,async()=>{calls++;return {data:{id:randomUUID()}};});
  const sent=await sendAgentEmail(pool,sendInput(f,detail,{scheduledAt:new Date(Date.now()+120000).toISOString()}),{provider});
  await pool.query(`UPDATE acd_sagas SET data=jsonb_set(jsonb_set(data-'replyParentId','{sendAt}','null'::jsonb),'{payload}',(data->'payload')-'in_reply_to_message_id'-'forward_of_message_id') WHERE id=$1`,[sent.sagaId]);
  await driveSaga(pool,sent.sagaId,{provider});
  assert.equal(calls,0);
  assert.equal((await pool.query('SELECT status FROM cc_email_messages WHERE message_id=$1',[sent.messageId])).rows[0].status,'failed');
});
test('email admin exposes ingestion failures and retries only an owned email event with an audit',async()=>{
  const f=await fixture(),eventId=`review:${randomUUID()}`,foreign=`review:${randomUUID()}`,requestId=randomUUID();
  await persistWebhookEvent(pool,{eventId,provider:'telnyx-email',eventType:'email.inbox_message',payload:{mailboxId:f.mailboxId,message:{...f.message,reply_to:[]}}});
  await persistWebhookEvent(pool,{eventId:foreign,provider:'telnyx',eventType:'call.initiated',payload:{mailboxId:f.mailboxId}});
  await pool.query("UPDATE acd_webhook_events SET status='dead',attempt_count=8,last_error='Enter a valid email address' WHERE event_id=ANY($1::text[])",[[eventId,foreign]]);
  await emailAdminAction(pool,{action:'sync',id:f.mailboxId},f.agentId);
  const overview=await emailAdminOverview(pool),mailbox=overview.mailboxes.find(m=>m.id===f.mailboxId);
  assert.equal(mailbox.backlog,0);assert.equal(mailbox.ingest_failed,1);assert.equal(mailbox.ingest_retrying,0);assert.equal(mailbox.last_ingest_error,'Enter a valid email address');
  assert(overview.ingestionFailures.some(e=>e.event_id===eventId&&e.subject===f.message.subject));assert(!overview.ingestionFailures.some(e=>e.event_id===foreign));
  await assert.rejects(emailAdminAction(pool,{action:'retry_ingestion',eventId:foreign,requestId},f.agentId),e=>e.status===404);
  const input={action:'retry_ingestion',eventId,requestId};
  const first=await emailAdminAction(pool,input,f.agentId);assert.deepEqual((await emailAdminAction(pool,input,f.agentId)).result,first.result);
  assert.equal((await pool.query('SELECT count(*)::int n FROM acd_operator_actions WHERE request_id=$1',[requestId])).rows[0].n,1);
  await runInboxWorkerOnce(pool,{node:'email-recovery-test',handler:row=>applyEmailInboxEvent(pool,row)});await routePendingEmail(pool);
  assert.equal((await pool.query('SELECT status FROM acd_webhook_events WHERE event_id=$1',[eventId])).rows[0].status,'applied');
  assert.equal((await emailAdminOverview(pool)).mailboxes.find(m=>m.id===f.mailboxId).ingest_failed,0);
});
test('waiting releases capacity after wrap-up and an inbound reply reopens exactly one episode',async()=>{
  const f=await fixture(),work=await receive(f),detail=await accept(f,work);
  await actOnTextWork(pool,{workItemId:work.id,agentId:f.agentId,channel:'email',action:'wait',commandId:randomUUID(),expectedVersion:detail.work.version});
  await completeTextWrapup(pool,{workItemId:work.id,expectedAgentId:f.agentId,wrapupCodeId:'resolved'});
  assert.equal((await pool.query("SELECT count(*)::int n FROM acd_reservations WHERE agent_id=$1 AND state<>'released'",[f.agentId])).rows[0].n,0);
  const next={...f.message,id:randomUUID(),text_body:'Thank you, one more question.'};
  const reopened=await receive(f,next);await receive(f,next);
  assert.notEqual(reopened.id,work.id);assert.equal(reopened.conversation_id,work.conversation_id);
  assert.equal((await pool.query('SELECT count(*)::int n FROM acd_work_items WHERE conversation_id=$1 AND terminal_at IS NULL',[work.conversation_id])).rows[0].n,1);
});
test('arrival during wrap-up persists and creates a new episode after completion',async()=>{
  const f=await fixture(),work=await receive(f),detail=await accept(f,work);
  await actOnTextWork(pool,{workItemId:work.id,agentId:f.agentId,channel:'email',action:'complete',commandId:randomUUID(),expectedVersion:detail.work.version});
  await receive(f,{...f.message,id:randomUUID(),text_body:'Another question'});
  assert.equal((await pool.query('SELECT count(*)::int n FROM cc_email_received WHERE mailbox_id=$1 AND processed_at IS NULL',[f.mailboxId])).rows[0].n,1);
  await completeTextWrapup(pool,{workItemId:work.id,expectedAgentId:f.agentId,wrapupCodeId:'resolved'});
  assert.equal(await routePendingEmail(pool),true);
});
test('automation and spam classification keep non-customer messages out of routing',async()=>{
  const f=await fixture();
  for(const message of [{...f.message,id:randomUUID(),headers:{'Auto-Submitted':'auto-replied'}},{...f.message,id:randomUUID(),labels:['spam']}])await receive(f,message);
  assert.equal((await pool.query('SELECT count(*)::int n FROM cc_email_received WHERE mailbox_id=$1 AND classification<>\'customer\' AND processed_at IS NOT NULL',[f.mailboxId])).rows[0].n,2);
});
test('deleted inbox messages are not fetched or reintroduced into a queue by sync',async()=>{
  const f=await fixture();await pool.query("UPDATE cc_email_mailboxes SET next_sync_at=now()+interval '1 hour'");await pool.query('UPDATE cc_email_mailboxes SET next_sync_at=now() WHERE id=$1',[f.mailboxId]);
  const message={...f.message,labels:['deleted'],text_body:undefined,html_body:undefined};let calls=0;
  await syncEmailMailbox(pool,{request:async path=>{calls++;assert(path.startsWith('/email_inboxes/'));return {data:[message],meta:{}};},content:()=>assert.fail('Deleted message content must not be fetched')});
  assert.equal(calls,1);assert.equal((await pool.query("SELECT 1 FROM acd_webhook_events WHERE payload->>'mailboxId'=$1",[f.mailboxId])).rowCount,0);
  await receive(f,message);
  assert.equal((await pool.query('SELECT classification FROM cc_email_received WHERE mailbox_id=$1',[f.mailboxId])).rows[0].classification,'deleted');
  assert.equal((await pool.query('SELECT 1 FROM cc_email_threads WHERE mailbox_id=$1',[f.mailboxId])).rowCount,0);
});
test('authenticated polling commits cursor with its page and fetches owned body URLs',async()=>{
  const f=await fixture({routing:false});await pool.query("UPDATE cc_email_mailboxes SET next_sync_at=now()+interval '1 hour'");await pool.query('UPDATE cc_email_mailboxes SET next_sync_at=now() WHERE id=$1',[f.mailboxId]);
  let path,contentCalls=0;
  await syncEmailMailbox(pool,{request:async p=>{path=p;return {data:[{...f.message,text_body:null,text_body_url:'https://bucket.s3.amazonaws.com/owned'}],meta:{page_cursor:'next-page'}};},content:async()=>{contentCalls++;return Buffer.from('Stored body');}});
  assert(path.includes(f.mailbox.provider_inbox_id));assert.equal(contentCalls,1);
  assert.equal((await pool.query('SELECT sync_cursor FROM cc_email_mailboxes WHERE id=$1',[f.mailboxId])).rows[0].sync_cursor,'next-page');
  await pool.query('UPDATE cc_email_mailboxes SET next_sync_at=now() WHERE id=$1',[f.mailboxId]);
  await syncEmailMailbox(pool,{request:async p=>{path=p;return {data:[],meta:{}};}});
  assert.equal(new URL(path,'https://api.test').searchParams.get('page[after]'),'next-page');
  assert.equal((await pool.query('SELECT sync_cursor FROM cc_email_mailboxes WHERE id=$1',[f.mailboxId])).rows[0].sync_cursor,null);
});
test('draft versions prevent cross-tab overwrite; other agents cannot read or send',async()=>{
  const f=await fixture(),detail=await accept(f,await receive(f)),input=sendInput(f,detail);
  const saved=await saveEmailDraft(pool,{...input,content:input.content,expectedVersion:'0'});assert.equal(saved.version,'1');
  await assert.rejects(saveEmailDraft(pool,{...input,expectedVersion:'0'}),e=>e.status===409);
  await assert.rejects(readEmailDetail(pool,{workItemId:input.workItemId,agentId:'someone-else'}),e=>e.status===403);
  let calls=0;await assert.rejects(sendAgentEmail(pool,{...input,agentId:'someone-else'},{provider:emailProvider(null,async()=>{calls++;})}),e=>e.status===403);assert.equal(calls,0);
});
test('email reply journal commits before provider I/O and retries keep the same payload and idempotency key',async()=>{
  const f=await fixture(),detail=await accept(f,await receive(f)),input=sendInput(f,detail);const calls=[];
  const provider=emailProvider(null,async(_path,options)=>{
    const rows=(await pool.query("SELECT request,status FROM acd_commands WHERE operation='email_send' AND request->>'subject'=$1",[input.content.subject])).rows;
    assert(rows.some(r=>r.status==='sent'));calls.push(options);
    if(calls.length===1)throw Error('Timeout after provider acceptance');
    return {data:{id:'remote-sent-id'}};
  });
  const result=await sendAgentEmail(pool,input,{provider});
  await driveSaga(pool,result.sagaId,{provider});
  assert.equal(calls.length,2);assert.equal(calls[0].idempotencyKey,calls[1].idempotencyKey);assert.deepEqual(calls[0].body,calls[1].body);
  assert.equal(calls[0].body.from,f.mailbox.address);assert.equal(calls[0].body.in_reply_to_message_id,undefined);assert.equal(calls[0].body.headers['In-Reply-To'],f.message.headers['Message-ID']);
  await sendAgentEmail(pool,input,{provider});assert.equal(calls.length,2);
  await assert.rejects(sendAgentEmail(pool,{...input,content:{...input.content,text:'Changed'}},{provider}),e=>e.status===409);
});
test('reply-all excludes internal mailboxes and refuses arbitrary recipient injection',async()=>{
  const f=await fixture(),detail=await accept(f,await receive(f)),input=sendInput(f,detail,{mode:'reply_all',cc:'colleague@example.com'});
  await sendAgentEmail(pool,input,{provider:acceptedProvider()});
  await assert.rejects(sendAgentEmail(pool,{...sendInput(f,detail),content:{...input.content,cc:f.mailbox.address}},{provider:acceptedProvider()}),/Reply recipients/);
});
test('BCC remains private in history and recipient delivery views',async()=>{
  const f=await fixture(),detail=await accept(f,await receive(f)),input=sendInput(f,detail,{mode:'forward',to:'forward@example.com',bcc:'private@example.com'});
  await sendAgentEmail(pool,input,{provider:acceptedProvider()});
  const history=await readEmailDetail(pool,{workItemId:detail.work.id,agentId:f.agentId});assert(!JSON.stringify(history.messages).includes('private@example.com'));
});
test('scheduled sends survive the request and cancellation prevents provider I/O',async()=>{
  const f=await fixture(),detail=await accept(f,await receive(f)),input=sendInput(f,detail,{scheduledAt:new Date(Date.now()+120000).toISOString()});let calls=0;
  const provider=emailProvider(null,async()=>{calls++;return {data:{id:randomUUID()}};});
  const result=await sendAgentEmail(pool,input,{provider});assert.equal(calls,0);
  await assert.rejects(actOnTextWork(pool,{workItemId:detail.work.id,agentId:f.agentId,channel:'email',action:'wait',commandId:randomUUID(),expectedVersion:detail.work.version}),/pending email/);
  await cancelScheduledEmail(pool,{workItemId:detail.work.id,agentId:f.agentId,messageId:result.messageId});
  await driveSaga(pool,result.sagaId,{provider});assert.equal(calls,0);
});
test('recipient deliveries do not regress or overwrite other recipients',async()=>{
  const f=await fixture(),detail=await accept(f,await receive(f));
  const result=await sendAgentEmail(pool,sendInput(f,detail),{provider:emailProvider(null,async()=>({data:{id:'delivery-parent'}}))});
  const at=new Date().toISOString();
  for(const [recipient,type,code] of [['one','delivered'],['two','bounced','30005'],['one','sent']])await applyEmailInboxEvent(pool,{event_type:`email.${type}`,occurred_at:at,payload:{id:'delivery-parent',recipient_id:recipient,to:{email:`${recipient}@example.com`},error_evidence:code?{code}:undefined}});
  const deliveries=(await pool.query('SELECT recipient_id,status FROM cc_email_deliveries WHERE message_id=$1 ORDER BY recipient_id',[result.messageId])).rows;
  assert.deepEqual(deliveries,[{recipient_id:'one',status:'delivered'},{recipient_id:'two',status:'expired'}]);
});
test('email Copilot uses separate settings, checks ownership and only generates a draft suggestion',async()=>{
  const f=await fixture(),detail=await accept(f,await receive(f));let body;
  const input={workItemId:detail.work.id,agentId:f.agentId,channel:'email',question:'Draft a reply',requestId:randomUUID()};
  const request=async(_path,options)=>{body=options.body;return {choices:[{message:{content:'{"suggestions":[{"text":"I can help update your address.","confidence":0.7}]}'}}]};};
  const result=await generateChatCopilot(pool,input,{request,catalog:async()=>({models:[]})});
  assert.equal(result.suggestions.length,1);assert.equal(body.model,'email-test');assert.equal(body.tools[0].retrieval.bucket_ids[0],'email-knowledge');
  assert.equal((await readEmailDetail(pool,input)).messages.length,1);
  await assert.rejects(generateChatCopilot(pool,{...input,agentId:'outsider'},{request}),e=>e.status===403);
});
test('mailbox administration validates provider domain and queue before activating routing',async()=>{
  const f=await fixture();
  await assert.rejects(emailAdminAction(pool,{action:'save_mailbox',inboxId:'outside',queueId:f.queueId,name:'Outside'},f.agentId,{request:async()=>({data:{email:'demo@example.com'}})}),e=>e.status===403);
});
test('unsafe content URLs, oversized bodies, malformed attachment base64 and illegal scheduling are rejected',async()=>{
  await assert.rejects(fetchEmailContent('http://127.0.0.1/private'),e=>e.status===502);
  assert.throws(()=>parseEmailDraft({attachments:[{filename:'test',content:'not base64!'}]}),/attachment/);
  assert.throws(()=>parseEmailDraft({text:'x'.repeat(1_000_001)}),/limits/);
  assert.throws(()=>parseEmailDraft({attachments:[{filename:'large',content:Buffer.alloc(5_000_001).toString('base64')}]}),/5 MB/);
  assert.equal(normalizeInbound({id:'test',from:'a@example.com',subject:'one',to:[],headers:{'Message-ID':'bad'}}).messageId,null);
  assert.equal(classifyEmail({from:'postmaster@example.com'}),'automated');
  assert.equal(reduceDelivery({status:'delivered',occurred_at:new Date().toISOString()},{status:'queued',occurredAt:new Date().toISOString()}),null);
});

test('agents cannot create new email or bypass the policy through an existing interaction',async()=>{
  const f=await fixture(),detail=await accept(f,await receive(f)),before=(await pool.query('SELECT count(*)::int n FROM acd_work_items')).rows[0].n;
  assert.deepEqual(await emailComposeMailboxes(pool,f.agentId),[]);
  await assert.rejects(createOutboundEmail(pool,{agentId:f.agentId,mailboxId:f.mailboxId,to:'new@example.com',subject:'Standalone',commandId:randomUUID()}),e=>e.status===403);
  let calls=0;const input=sendInput(f,detail,{mode:'new',to:'new@example.com'});
  await assert.rejects(saveEmailDraft(pool,{...input,content:input.content,expectedVersion:'0'}),e=>e.status===403);
  await assert.rejects(sendAgentEmail(pool,input,{provider:emailProvider(null,async()=>{calls++;})}),e=>e.status===403);
  assert.equal(calls,0);assert.equal((await pool.query('SELECT count(*)::int n FROM acd_work_items')).rows[0].n,before);
  assert.equal((await readEmailDetail(pool,{workItemId:detail.work.id,agentId:f.agentId})).messages.length,1);
});
test('transfer preserves mailbox and history, removes previous send rights and rolls back an ineligible target',async()=>{
  const source=await fixture(),target=await fixture(),work=await receive(source),detail=await accept(source,work);
  const input={workItemId:work.id,agentId:source.agentId,queueId:target.queueId,targetAgentId:'ineligible',expectedVersion:detail.work.version,commandId:randomUUID()};
  await assert.rejects(transferEmailWork(pool,input),e=>e.status===409);
  assert.equal((await readEmailDetail(pool,{workItemId:work.id,agentId:source.agentId})).work.state,'active');
  await transferEmailWork(pool,{...input,targetAgentId:target.agentId,commandId:randomUUID()});
  const moved=await readEmailDetail(pool,{workItemId:work.id,agentId:target.agentId});assert.equal(moved.mailbox.address,source.mailbox.address);assert.equal(moved.messages.length,1);
  await assert.rejects(readEmailDetail(pool,{workItemId:work.id,agentId:source.agentId}),e=>e.status===403);
  assert.equal(moved.work.queue_id,target.queueId);
});

test('customer email arriving during source transfer wrap-up reaches the destination immediately',async()=>{
  const source=await fixture(),target=await fixture(),work=await receive(source),detail=await accept(source,work);
  await transferEmailWork(pool,{workItemId:work.id,agentId:source.agentId,queueId:target.queueId,
    targetAgentId:target.agentId,commandId:randomUUID(),expectedVersion:detail.work.version});
  const incoming={...source.message,id:randomUUID(),text_body:'Additional details after transfer'};
  const continued=await receive(source,incoming);
  assert.equal(continued.id,work.id);
  const received=await readEmailDetail(pool,{workItemId:work.id,agentId:target.agentId});
  assert.equal(received.messages.length,2);
  assert.equal(received.messages.at(-1).body,'Additional details after transfer');
  assert.equal((await pool.query("SELECT state FROM acd_text_assignments WHERE work_item_id=$1 AND agent_id=$2",[work.id,source.agentId])).rows[0].state,'wrapup');
  await completeTextWrapup(pool,{workItemId:work.id,expectedAgentId:source.agentId});
  assert.equal((await readEmailDetail(pool,{workItemId:work.id,agentId:target.agentId})).work.state,'offered');
});
test('mailbox attachments are copied to private storage before a sync page is acknowledged',async()=>{
  const f=await fixture();await pool.query("UPDATE cc_email_mailboxes SET next_sync_at=now()+interval '1 hour'");await pool.query('UPDATE cc_email_mailboxes SET next_sync_at=now() WHERE id=$1',[f.mailboxId]);
  let stored=false;
  await syncEmailMailbox(pool,{request:async()=>({data:[{...f.message,attachments:[{filename:'invoice.txt',content_type:'text/plain',url:'https://owned.s3.amazonaws.com/file'}]}],meta:{}}),
    content:async()=>Buffer.from('private invoice'),retain:async bytes=>{assert.equal(bytes.toString(),'private invoice');stored=true;return {storage_key:'safe-owned-key',size_bytes:bytes.length};}});
  assert.equal(stored,true);
  const event=(await pool.query("SELECT payload FROM acd_webhook_events WHERE provider='telnyx-email' AND payload->>'mailboxId'=$1",[f.mailboxId])).rows[0];
  assert.equal(event.payload.message.attachments[0].storage_key,'safe-owned-key');assert.equal(event.payload.message.attachments[0].url,undefined);
});
test('inline files share private retention and attachment limits and remain available for forwarding',async()=>{
  const f=await fixture();await pool.query("UPDATE cc_email_mailboxes SET next_sync_at=now()+interval '1 hour'");await pool.query('UPDATE cc_email_mailboxes SET next_sync_at=now() WHERE id=$1',[f.mailboxId]);
  const image={filename:'logo.png',content_type:'image/png',content_id:'<logo>',url:'https://owned.s3.amazonaws.com/logo'};
  const incoming={...f.message,html_body:'<p>See image</p><img src="cid:logo">',attachments:[],inline_files:[image]};
  assert.equal(normalizeInbound({...incoming,attachments:[image]}).attachments.length,1);
  let fetched=0,retained=0;
  await syncEmailMailbox(pool,{request:async()=>({data:[incoming],meta:{}}),content:async url=>{assert.equal(url,image.url);fetched++;return Buffer.from('image');},retain:async()=>{retained++;return {storage_key:'owned-image',size_bytes:5};}});
  const event=(await pool.query("SELECT * FROM acd_webhook_events WHERE payload->>'mailboxId'=$1",[f.mailboxId])).rows[0];
  assert.equal(fetched,1);assert.equal(retained,1);assert.equal(event.payload.message.inline_files,undefined);assert.equal(event.payload.message.attachments[0].url,undefined);
  const detail=await accept(f,await receive(f,event.payload.message));assert.equal(detail.messages[0].attachments[0].content_id,'logo');
  let payload;
  await forwardEmailWork(pool,{workItemId:detail.work.id,agentId:f.agentId,messageId:detail.messages[0].id,to:'forward@example.com',commandId:randomUUID(),expectedVersion:detail.work.version},
    {provider:emailProvider(null,async(_path,options)=>{payload=options.body;return {data:{id:randomUUID()}};}),readFile:async key=>{assert.equal(key,'owned-image');return Buffer.from('image');}});
  assert.equal(payload.attachments.length,1);assert.equal(payload.attachments[0].content,Buffer.from('image').toString('base64'));
  const large=await fixture();await pool.query("UPDATE cc_email_mailboxes SET next_sync_at=now()+interval '1 hour'");await pool.query('UPDATE cc_email_mailboxes SET next_sync_at=now() WHERE id=$1',[large.mailboxId]);
  await assert.rejects(syncEmailMailbox(pool,{request:async()=>({data:[{...large.message,attachments:[{...image,content_id:undefined}],inline_files:[{...image,filename:'other.png',url:'https://owned.s3.amazonaws.com/other'}]}],meta:{}}),
    content:async()=>Buffer.alloc(13_000_000),retain:async()=>({storage_key:'test-only'})}),e=>e.status===413);
  assert.equal((await pool.query("SELECT 1 FROM acd_webhook_events WHERE payload->>'mailboxId'=$1",[large.mailboxId])).rowCount,0);
});
test('recipient reconciliation recovers missed callbacks with a durable cursor',async()=>{
  const f=await fixture(),detail=await accept(f,await receive(f));
  const sent=await sendAgentEmail(pool,sendInput(f,detail),{provider:acceptedProvider()});
  await pool.query("UPDATE cc_email_messages SET next_delivery_sync_at=now()+interval '1 hour'");await pool.query('UPDATE cc_email_messages SET next_delivery_sync_at=now() WHERE message_id=$1',[sent.messageId]);
  const now=new Date().toISOString();
  await syncEmailDeliveries(pool,{request:async()=>({data:[
    {id:'recipient-one',status:'delivered',kind:'to',address:'customer@example.com',delivered_at:now},
    {id:'recipient-two',status:'gw_reject',kind:'bcc',address:null,failed_at:now,smtp_code:550,smtp_response:'Rejected'},
    {id:'recipient-three',status:'queued',kind:'cc',address:'another@example.com',sent_at:null,delivered_at:null,failed_at:null},
  ],meta:{page_cursor:'recipient-next'}})});
  const stored=(await pool.query('SELECT delivery_cursor FROM cc_email_messages WHERE message_id=$1',[sent.messageId])).rows[0];assert.equal(stored.delivery_cursor,'recipient-next');
  const providerId=(await pool.query('SELECT provider_message_id FROM cc_email_messages WHERE message_id=$1',[sent.messageId])).rows[0].provider_message_id;
  const events=(await pool.query("SELECT * FROM acd_webhook_events WHERE source_route='email:recipient-sync' AND payload->>'id'=$1",[providerId])).rows;
  assert.equal(events.length,3);for(const event of events)await applyEmailInboxEvent(pool,event);
  const final=await readEmailDetail(pool,{workItemId:detail.work.id,agentId:f.agentId});
  const statuses=final.messages.find(m=>m.id===sent.messageId).deliveries;
  assert.deepEqual(statuses.map(d=>d.status).sort(),['delivered','gw_reject','queued']);
  assert.equal(statuses.find(d=>d.kind==='bcc').address,null);
});
